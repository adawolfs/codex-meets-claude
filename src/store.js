import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const terminal = status => !['queued', 'running'].includes(status);
export function pageArgs({ after = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error('Invalid cursor or limit (1-100)');
  return { after, limit };
}
const stable = value => JSON.stringify(value, Object.keys(value).sort());
export class Store {
  constructor({ directory, maxHistory = 1000, maxAgeMs = 30 * 86400000, maxEvents = 256 }) {
    for (const n of [maxHistory, maxAgeMs, maxEvents]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid storage limit');
    this.maxHistory = maxHistory; this.maxAgeMs = maxAgeMs; this.maxEvents = maxEvents;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'jobs.sqlite'));
    chmodSync(join(directory, 'jobs.sqlite'), 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw Error('Database version is newer than this service'); }
    this.db.exec("BEGIN; CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, args TEXT NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, view TEXT NOT NULL, finished TEXT, UNIQUE(provider,request_id)); CREATE TABLE IF NOT EXISTS events (job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job,seq)); CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,seq); PRAGMA user_version=1; COMMIT;");
  }
  findRequest(provider, args) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE provider=? AND request_id=?').get(provider, args.requestId);
    if (!row) return null;
    if (row.fingerprint !== this.fingerprint(args)) throw Error('requestId already used with different arguments');
    return JSON.parse(row.view);
  }
  fingerprint(args) { return createHash('sha256').update(stable(args)).digest('hex'); }
  insert(provider, args, project, original = args) {
    const prior = this.findRequest(provider, original);
    if (prior) return prior;
    const view = { id: randomUUID(), provider, backend: provider === 'claude' ? 'agent-sdk' : 'codex-exec',
      status: 'queued', queuedAt: new Date().toISOString(), startedAt: null, cwd: args.cwd,
      sessionId: args.sessionId ?? null, parentJobId: args.parentJobId ?? null,
      requestId: args.requestId, result: null, error: null, progress: { phase: 'queued', text: '' } };
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
    const allowed = ['status','startedAt','finishedAt','sessionId','result','error','progress','permissionDenials','usage','costUsd','cancelRequested'];
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
  recover() {
    this.db.exec('BEGIN');
    try {
      for (const r of this.db.prepare("SELECT id FROM jobs WHERE status='running'").all())
        this.update(r.id,{status:'interrupted',finishedAt:new Date().toISOString(),error:'Service stopped during execution; inspect workspace before explicit resume.',progress:{phase:'interrupted',text:''}});
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune() {
    const cutoff = new Date(Date.now()-this.maxAgeMs).toISOString();
    this.db.prepare("DELETE FROM jobs WHERE status NOT IN ('queued','running') AND (finished<? OR id NOT IN (SELECT id FROM jobs WHERE status NOT IN ('queued','running') ORDER BY seq DESC LIMIT ?))").run(cutoff,this.maxHistory);
    this.db.exec('PRAGMA incremental_vacuum(128);');
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}
