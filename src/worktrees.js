import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, relative, isAbsolute } from 'node:path';
import { stateDirectory } from './client.js';
const exec = promisify(execFile);
const limits = { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 };
// Status and removal are synchronous on purpose: the caller's ownership check and the removal cannot interleave with
// anything else in this process. Only creation, the slow checkout, yields.
const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { ...limits, stdio: ['ignore', 'pipe', 'pipe'] });
const reason = error => String(error.stderr || error.message).trim().slice(0, 1000);
export const defaultRoot = () => join(stateDirectory(), 'worktrees');
export const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
const branchOf = path => 'bridge/' + basename(path);
const hasBranch = (cwd, branch) => { try { git(cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]); return true; } catch { return false; } };
// -z puts a rename's original path in the entry after it; both sides are reported.
function porcelain(cwd, { ignored = false } = {}) {
  const out = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(ignored ? ['--ignored'] : [])]).split('\0'), files = [], skipped = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i]; if (!e) continue;
    (e.startsWith('!!') ? skipped : files).push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2)) && out[i + 1]) files.push(out[++i]);
  }
  return ignored ? { files, ignored: skipped } : files;
}
// Ignored files present right after checkout (hook output, say) are the tree's baseline; any other ignored file is the
// delegate's work. The list lives in the worktree's private git dir, so it goes when the worktree does. A missing
// baseline counts every ignored file as a change.
const baselineOf = path => git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'bridge-ignored']).trim();
const readBaseline = path => { try { return new Set(readFileSync(baselineOf(path), 'utf8').split('\0').filter(Boolean)); } catch { return new Set(); } };
// Commits reachable from revs and from no other branch, tag or remote: exactly what deleting the bridge branch would lose.
function unique(cwd, revs, branch) {
  const out = git(cwd, ['log', '--format=%x00%H', '--name-only', ...revs, '--not', '--exclude=' + branch, '--branches', '--tags', '--remotes']);
  const chunks = out.split('\0').filter(c => c.trim());
  return { count: chunks.length, files: chunks.flatMap(c => c.split('\n').slice(1).filter(Boolean)) };
}
export function sourceChanges(project) {
  try { return porcelain(project); }
  catch (error) { if (error.status === 128) throw Error('A worktree job needs a git repository: ' + project); throw Error('Cannot read git status of ' + project + ': ' + reason(error)); }
}
export function planWorktree({ project, jobId, root = defaultRoot() }) {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/.test(jobId)) throw Error('Invalid worktree name');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const base = realpathSync(root);
  if (inside(project, base)) throw Error(`The worktree directory ${base} is inside the repository ${project}; move the bridge state directory out of it`);
  return { path: join(base, jobId), branch: 'bridge/' + jobId };
}
export async function createWorktree({ project, jobId, root = defaultRoot() }) {
  const { path, branch } = planWorktree({ project, jobId, root });
  try { await exec('git', ['-C', project, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD'], { ...limits, timeout: 300000 }); }
  catch (error) { throw Error('Could not create worktree: ' + reason(error)); }
  writeFileSync(baselineOf(path), porcelain(path, { ignored: true }).ignored.join('\0'), { mode: 0o600 });
  return { path, branch };
}
export function worktreeStatus(path, { branch = branchOf(path) } = {}) {
  const status = porcelain(path, { ignored: true }), base = readBaseline(path);
  const files = new Set([...status.files, ...status.ignored.filter(f => !base.has(f))]), commits = unique(path, ['HEAD', ...(hasBranch(path, branch) ? ['refs/heads/' + branch] : [])], branch);
  for (const f of commits.files) files.add(f);
  return { dirty: files.size > 0 || commits.count > 0, changedFiles: [...files].sort() };
}
// repo locates the branch when the tree itself is already gone (a crash, or a hand-deleted directory).
export function removeWorktree(path, { discard = false, branch = branchOf(path), repo } = {}) {
  if (!branch.startsWith('bridge/')) throw Error('Refusing to delete a branch the bridge did not create: ' + branch);
  const present = existsSync(path);
  if (present) {
    let top;
    try { top = realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim()); } catch {}
    if (top !== realpathSync(path)) throw Error(`${path} is no longer a git worktree; inspect it and delete it by hand`);
    repo = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (!discard) { const s = worktreeStatus(path, { branch }); if (s.dirty) throw Error(`Worktree ${path} has changes (${s.changedFiles.slice(0, 20).join(', ') || 'commits'}); pass discard:true to delete them`); }
    try { git(repo, ['worktree', 'remove', ...(discard ? ['--force'] : []), path]); } catch (error) { throw Error('Could not remove worktree: ' + reason(error)); }
  } else if (!repo || !existsSync(repo)) return;
  git(repo, ['worktree', 'prune']);
  if (!hasBranch(repo, branch)) return;
  if (!discard && !present && unique(repo, ['refs/heads/' + branch], branch).count) throw Error(`Branch ${branch} has commits found nowhere else; pass discard:true to delete them`);
  git(repo, ['branch', '-D', '-q', branch]);
}
