import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenCode, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { startService } from '../src/service.js';
import { ServiceClient } from '../src/client.js';

// Drives the real bridge service against the shared local `opencode serve`, with the user's default model. It
// consumes quota, so it only runs on request: BRIDGE_LIVE_OPENCODE=1 node --test test/opencode-live.test.js
const enabled = process.env.BRIDGE_LIVE_OPENCODE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
const QUOTA = /free usage limit|free-limit|rate.?limit|quota|\b429\b/i;
class Quota extends Error {}

const scratch = async (t, prefix, { remove = true } = {}) => {
  await mkdir('/tmp/opencode', { recursive: true });
  const dir = await realpath(await mkdtemp(join('/tmp/opencode', prefix)));
  if (remove) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('live OpenCode service: session metadata survives get, and an unknown session answers a typed 404', { skip: !enabled, timeout: 60000 }, async t => {
  const dir = await scratch(t, 'live-meta-');
  const endpoint = await Service.ensure();
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const info = await client.server.info();
  assert.match(info.version, /^2\.\d+\.\d+/);
  t.diagnostic(`opencode service ${info.version}`);

  // The resume guard refuses a session without this marker, so it must come back from get() unchanged.
  const metadata = { agentbridge: { level: 'edit' } };
  const session = await client.session.create({ location: { directory: dir }, metadata, permissions: [{ action: '*', resource: '*', effect: 'deny' }] });
  t.after(() => client.session.remove({ sessionID: session.id }).catch(() => {}));
  assert.deepEqual((await client.session.get({ sessionID: session.id })).metadata, metadata);

  // Recovery treats exactly this error, for exactly this id, as proof that no delegate is running there.
  const unknown = 'ses_' + 'z'.repeat(26);
  const error = await client.session.interrupt({ sessionID: unknown }).then(() => null, e => e);
  assert.ok(error, 'interrupting an unknown session unexpectedly succeeded');
  assert.ok(isSessionNotFoundError(error), `not a SessionNotFoundError: ${error?.name}: ${error?.message}`);
  assert.equal(error.sessionID, unknown);
});

test('live OpenCode peer: read-only, edit in a worktree, cancellation and resume', { skip: !enabled, timeout: 780000 }, async t => {
  // Removed by the hook below, after the service has stopped: hooks run in registration order.
  const state = await scratch(t, 'live-state-', { remove: false });
  const repo = await scratch(t, 'live-repo-', { remove: false });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'notes.txt'), 'BRIDGE_MARKER_7431 is the secret word.\nSecond line.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');

  const service = await startService({ directory: state });
  const bridge = new ServiceClient({ directory: state });
  const call = (action, args = {}) => bridge.call('opencode', action, args);
  const sessions = new Set();
  const jobs = new Set();
  t.after(async () => {
    // Never leave a delegate running behind; the temporary state and repository are removed after this hook.
    for (const id of jobs) await call('cancel', { jobId: id }).catch(() => {});
    await service.close();
    const endpoint = await Service.discover().catch(() => null);
    if (!endpoint) return;
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    for (const sessionID of sessions) { await client.session.interrupt({ sessionID }).catch(() => {}); await client.session.remove({ sessionID }).catch(() => {}); }
  });
  t.after(async () => { await rm(state, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); });

  const start = async args => {
    const job = await call('start', { cwd: repo, ...args });
    jobs.add(job.id);
    return job;
  };
  const until = async (id, predicate, what, ms = 120000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const job = await call('status', { jobId: id });
      if (job.sessionId) sessions.add(job.sessionId);
      if (predicate(job)) return job;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ status: job.status, progress: job.progress, error: job.error })}`);
      await sleep(250);
    }
  };
  const finished = async (id, what) => {
    const job = await until(id, j => !['queued', 'running'].includes(j.status) && j.finishedAt, what);
    // A quota or rate limit says nothing about the bridge: report it as inconclusive, never as a pass.
    if (job.status === 'failed' && QUOTA.test(job.error ?? '')) throw new Quota(`${what}: ${job.error}`);
    return job;
  };

  try {
    // 1. read-only: reports what it read and writes nothing.
    const reader = await start({ prompt: 'Read the file notes.txt in the current directory and reply with its first line, verbatim. Do not modify anything.', level: 'read-only' });
    const read = await finished(reader.id, 'the read-only job');
    assert.equal(read.status, 'completed', read.error);
    assert.equal(read.level, 'read-only');
    assert.match(read.result, /BRIDGE_MARKER_7431/);
    assert.equal(git(repo, 'status', '--porcelain'), '', 'a read-only job changed the checkout');
    assert.equal(read.worktree ?? null, null);
    t.diagnostic(`read-only job ${read.id} session ${read.sessionId}`);

    // 2. edit in a worktree: changes a file there, reports branch and files, leaves the tree behind, never touches the source.
    let edited;
    for (let attempt = 1; attempt <= 2 && !edited; attempt++) {
      // A small default model sometimes answers without calling the tool; that is inconclusive, so retry once.
      const writer = await start({ prompt: 'Use the edit or write tool to create a file named hello.txt in the current directory containing exactly HELLO_WORKTREE. Then reply DONE.', level: 'edit', worktree: true });
      const job = await finished(writer.id, 'the edit job');
      assert.equal(job.status, 'completed', job.error);
      assert.ok(job.worktree, 'a worktree job reported no worktree');
      if (job.worktree.changedFiles?.includes('hello.txt')) edited = job;
      else if (!job.worktree.removed) await call('cleanup', { worktreeId: job.worktree.id, discard: true });
    }
    assert.ok(edited, 'the edit job never created hello.txt in two attempts');
    const { worktree } = edited;
    assert.equal(edited.level, 'edit');
    assert.match(worktree.branch, /^bridge\/[0-9a-f-]{36}$/);
    assert.deepEqual(worktree.changedFiles, ['hello.txt']);
    assert.equal(worktree.removed, false, 'a worktree containing work was removed automatically');
    assert.match(readFileSync(join(worktree.path, 'hello.txt'), 'utf8'), /HELLO_WORKTREE/);
    assert.equal(existsSync(join(repo, 'hello.txt')), false, 'the edit reached the source checkout');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.match(git(repo, 'branch', '--list', worktree.branch), /bridge\//);
    assert.ok(edited.sessionId);
    t.diagnostic(`edit job ${edited.id} worktree ${worktree.path} branch ${worktree.branch}`);

    // The session was created by the bridge: get() must carry the marker the resume guard reads.
    const endpoint = await Service.discover();
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    assert.deepEqual((await client.session.get({ sessionID: edited.sessionId })).metadata, { agentbridge: { level: 'edit' } });

    // 3. resume into the same session and the same worktree; the level belongs to the session and must be repeated.
    const resumed = await start({ prompt: 'Which file did you create earlier, and what exactly does it contain? Answer in one line.', level: 'edit', parentJobId: edited.id });
    const again = await finished(resumed.id, 'the resumed job');
    assert.equal(again.status, 'completed', again.error);
    assert.equal(again.sessionId, edited.sessionId, 'the resume started a new session');
    assert.match(again.result, /hello\.txt/i);
    assert.equal(again.worktree.id, worktree.id);
    assert.equal(again.worktree.removed, false);

    // 4. cancellation mid-run: the abort is confirmed, the job ends cancelled and nothing stays held.
    const slow = await start({ prompt: 'Count from 1 to 400, one number per line, then write DONE. Do not use any tools.', level: 'read-only' });
    await until(slow.id, j => j.sessionId && j.progress?.text, 'the slow job to start generating', 60000);
    await call('cancel', { jobId: slow.id });
    const cancelled = await finished(slow.id, 'the cancelled job');
    assert.equal(cancelled.status, 'cancelled', `finished as ${cancelled.status} before the cancel took effect: ${cancelled.error}`);
    assert.ok(cancelled.finishedAt);
    assert.equal(cancelled.openCode.interrupt, 'confirmed');
    assert.equal((await call('diagnostics')).unrecovered, 0);

    // The worktree holds work, so it is removed only by the explicit discard.
    await assert.rejects(() => call('cleanup', { worktreeId: worktree.id }), /changes/);
    assert.equal((await call('cleanup', { worktreeId: worktree.id, discard: true })).removed, true);
    assert.equal(existsSync(worktree.path), false);
    assert.equal(git(repo, 'branch', '--list', worktree.branch), '');
  } catch (error) {
    if (!(error instanceof Quota)) throw error;
    // A skip is not a pass: the run was inconclusive. Say so where it cannot be missed.
    console.error(`BRIDGE_LIVE_OPENCODE: INCONCLUSIVE, the model quota is exhausted. ${error.message.slice(0, 300)}`);
    t.skip('model quota exhausted: ' + error.message.slice(0, 200));
  }
});
