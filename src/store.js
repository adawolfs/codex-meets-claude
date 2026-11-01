import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const BACKENDS = { claude: 'agent-sdk', codex: 'codex-exec', opencode: 'opencode-http' };
export const terminal = status => !['queued', 'running'].includes(status);
export function pageArgs({ after = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error('Invalid cursor or limit (1-100)');
  return { after, limit };
}
const V1 = 'CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, args TEXT NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, view TEXT NOT NULL, finished TEXT, UNIQUE(provider,request_id)); CREATE TABLE IF NOT EXISTS events (job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job,seq)); CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,seq);';
// v2: virtual columns expose the delegate's session identity (derived, so they cannot drift from the view), and worktrees
// get a table of their own. It has no foreign key to jobs and prune() never touches it: worktrees outlive their jobs.
const V2 = `ALTER TABLE jobs ADD COLUMN oc_session TEXT GENERATED ALWAYS AS (json_extract(view,'$.openCode.sessionId')) VIRTUAL;
  ALTER TABLE jobs ADD COLUMN oc_endpoint TEXT GENERATED ALWAYS AS (json_extract(view,'$.openCode.endpoint')) VIRTUAL;
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, job TEXT NOT NULL, project TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL, created TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
  CREATE INDEX worktrees_job ON worktrees(job); CREATE INDEX worktrees_project ON worktrees(project);
  PRAGMA user_version=2;`;
const INTERRUPTED = 'Service stopped during execution; inspect workspace before explicit resume.';
const UNCONFIRMED = "COALESCE(json_extract(view,'$.openCode.interrupt'),'')='unconfirmed'";
const stable = value => JSON.stringify(value, Object.keys(value).sort());
export class Store {
  constructor({ directory, maxHistory = 1000, maxAgeMs = 30 * 86400000, maxEvents = 256 }) {
    for (const n of [maxHistory, maxAgeMs, maxEvents]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid storage limit');
    this.maxHistory = maxHistory; this.maxAgeMs = maxAgeMs; this.maxEvents = maxEvents; this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'jobs.sqlite'));
    chmodSync(join(directory, 'jobs.sqlite'), 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); throw Error('Database version is newer than this service'); }
    try { this.db.exec(`BEGIN; ${V1} ${version < 2 ? V2 : ''} COMMIT;`); }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} this.db.close(); throw error; }
  }
  findRequest(provider, args) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE provider=? AND request_id=?').get(provider, args.requestId);
    if (!row) return null;
    if (row.fingerprint !== this.fingerprint(args)) throw Error('requestId already used with different arguments');
    return JSON.parse(row.view);
  }
  fingerprint(args) { return createHash('sha256').update(stable(args)).digest('hex'); }
  insert(provider, args, project, original = args, { id = randomUUID(), worktree } = {}) {
    const prior = this.findRequest(provider, original);
    if (prior) return prior;
    const view = { id, provider, backend: BACKENDS[provider],
      status: 'queued', queuedAt: new Date().toISOString(), startedAt: null, cwd: args.cwd,
      sessionId: args.sessionId ?? null, parentJobId: args.parentJobId ?? null,
      requestId: args.requestId, result: null, error: null, progress: { phase: 'queued', text: '' }, ...(worktree ? { worktree } : {}) };
    this.db.prepare('INSERT INTO jobs(id,provider,request_id,fingerprint,args,project,status,view) VALUES(?,?,?,?,?,?,?,?)')
      .run(view.id, provider, args.requestId, this.fingerprint(original), JSON.stringify(args), project, view.status, JSON.stringify(view));
    return view;
  }
  record(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw Error('job not found');
    return { ...row, args: JSON.parse(row.args), view: JSON.parse(row.view) };
  }
  get(provider, id) {
    const row = this.db.prepare('SELECT view FROM jobs WHERE provider=? AND id=?').get(provider, id);
    if (!row) throw Error('job not found');
    return JSON.parse(row.view);
  }
  update(id, patch) {
    const row = this.record(id);
    // Never replace public identity or original directory with backend-local IDs.
    const allowed = ['status','startedAt','finishedAt','sessionId','result','error','progress','permissionDenials','usage','costUsd','cancelRequested','openCode','worktree'];
    const next = { ...row.view };
    for (const key of allowed) if (Object.hasOwn(patch, key)) next[key] = patch[key];
    const body = JSON.stringify(next);
    if (Buffer.byteLength(body) > 4_500_000) throw Error('Job result exceeds storage limit');
    this.db.prepare('UPDATE jobs SET status=?,view=?,finished=? WHERE id=?').run(next.status, body, next.finishedAt ?? null, id);
    return next;
  }
  queued() {
    return this.db.prepare("SELECT id,provider,project,args FROM jobs WHERE status='queued' ORDER BY seq").all()
      .map(r => ({ ...r, args: JSON.parse(r.args) }));
  }
  counts() {
    return Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS n FROM jobs GROUP BY status').all().map(r => [r.status,r.n]));
  }
  list(provider, options) {
    const { after, limit } = pageArgs(options);
    const rows = this.db.prepare('SELECT seq,view FROM jobs WHERE provider=? AND seq>? ORDER BY seq LIMIT ?').all(provider, after, limit + 1);
    const jobs = rows.slice(0, limit).map(r => {
      const { result, progress, permissionDenials, ...summary } = JSON.parse(r.view);
      return { ...summary, progress: progress ? { phase: progress.phase, updatedAt: progress.updatedAt } : undefined,
        error: summary.error?.slice(0, 1000) ?? null };
    });
    return { jobs, nextCursor: rows[Math.min(rows.length, limit) - 1]?.seq ?? after, hasMore: rows.length > limit };
  }
  appendEvents(id, events) {
    if (!events.length) return;
    this.db.exec('BEGIN');
    try {
      const put = this.db.prepare('INSERT OR IGNORE INTO events(job,seq,body) VALUES(?,?,?)');
      for (const event of events) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw Error('Invalid event sequence');
        const body = JSON.stringify(event);
        if (Buffer.byteLength(body) > 20000) throw Error('Event exceeds storage limit');
        put.run(id, event.sequence, body);
      }
      this.db.prepare('DELETE FROM events WHERE job=? AND seq NOT IN (SELECT seq FROM events WHERE job=? ORDER BY seq DESC LIMIT ?)').run(id,id,this.maxEvents);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(provider, id, options) {
    this.get(provider,id);
    const { after, limit } = pageArgs(options);
    const first = this.db.prepare('SELECT MIN(seq) AS n FROM events WHERE job=?').get(id).n;
    const rows = this.db.prepare('SELECT seq,body FROM events WHERE job=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit+1);
    const events = rows.slice(0,limit).map(r=>JSON.parse(r.body));
    return { events, nextCursor: events.at(-1)?.sequence ?? after, truncated: first !== null && after < first-1, hasMore: rows.length > limit };
  }
  // Rows still holding a project and session: running rows no live job owns (orphans recover() could not abort), and
  // opencode rows of any status whose delegate the adapter could not prove stopped.
  unrecovered(live = new Set()) {
    return this.db.prepare(`SELECT id,provider,project,oc_session AS sessionId FROM jobs WHERE status='running' OR (provider='opencode' AND ${UNCONFIRMED})`).all().filter(r => !live.has(r.id));
  }
  // A confirmed abort releases a hold: a running row becomes interrupted, a finished one just stops being unconfirmed.
  // 'forced' is an operator's release without proof; it is recorded apart from 'confirmed' so it is never read as one.
  confirm(id, how = 'confirmed') {
    const { view } = this.record(id), openCode = { ...view.openCode, interrupt: how };
    return view.status === 'running' ? this.update(id,{status:'interrupted',finishedAt:new Date().toISOString(),error:INTERRUPTED,progress:{phase:'interrupted',text:''},openCode}) : this.update(id,{openCode});
  }
  // The shared OpenCode service outlives this process, so its rows are released only once the abort is confirmed.
  async recover({ abortSession = async () => false } = {}) {
    const interrupt = id => this.update(id,{status:'interrupted',finishedAt:new Date().toISOString(),error:INTERRUPTED,progress:{phase:'interrupted',text:''}});
    const rows = this.db.prepare("SELECT id,provider,oc_session AS sessionId,oc_endpoint AS endpoint FROM jobs WHERE status='running'").all();
    const orphans = rows.filter(r => r.provider === 'opencode' && r.sessionId && r.endpoint);
    const confirmed = await Promise.all(orphans.map(async r => { try { return (await abortSession({provider:r.provider,sessionId:r.sessionId,endpoint:r.endpoint})) === true; } catch { return false; } }));
    const free = new Set([...rows.filter(r => !orphans.includes(r)).map(r => r.id), ...orphans.filter((_, i) => confirmed[i]).map(r => r.id)]);
    this.db.exec('BEGIN');
    try { for (const id of free) interrupt(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  putWorktree(r) { this.db.prepare('INSERT INTO worktrees(id,job,project,branch,path,created) VALUES(?,?,?,?,?,?)').run(r.id, r.job, r.project, r.branch, r.path, r.created); return r; }
  listWorktrees() { return this.db.prepare('SELECT * FROM worktrees ORDER BY created,id').all().map(r => ({ ...r })); }
  getWorktree(id) { const r = this.db.prepare('SELECT * FROM worktrees WHERE id=?').get(id); return r ? { ...r } : null; }
  deleteWorktree(id) { this.db.prepare('DELETE FROM worktrees WHERE id=?').run(id); }
  // Jobs that may still use a worktree: queued or running, or an opencode job whose delegate was never proven stopped.
  worktreeOwners(id) {
    return this.db.prepare(`SELECT id,status FROM jobs WHERE json_extract(view,'$.worktree.id')=? AND (status IN ('queued','running') OR (provider='opencode' AND ${UNCONFIRMED}))`).all(id).map(r => ({ ...r }));
  }
  prune() {
    const cutoff = new Date(Date.now()-this.maxAgeMs).toISOString();
    this.db.prepare(`DELETE FROM jobs WHERE status NOT IN ('queued','running') AND NOT (provider='opencode' AND ${UNCONFIRMED}) AND (finished<? OR id NOT IN (SELECT id FROM jobs WHERE status NOT IN ('queued','running') ORDER BY seq DESC LIMIT ?))`).run(cutoff,this.maxHistory);
    this.db.exec('PRAGMA incremental_vacuum(128);');
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}
