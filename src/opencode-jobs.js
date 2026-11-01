import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { LEVELS, levelRules } from './opencode-levels.js';
import { OPENCODE_MODEL as MODEL } from './persistent-tools.js';

const now = () => new Date().toISOString();
const bounded = (value, limit = 4000) => String(value ?? '').slice(0, limit);
const settledWithin = (promise, ms) => {
  let timer;
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};
// The endpoint is persisted and shown to callers, so its credentials are stripped.
const publicUrl = url => { const u = new URL(url); u.username = u.password = u.search = u.hash = ''; return u.href.replace(/\/$/, ''); };
// Whether an attempt settled successfully within ms; a timeout counts as failure.
const confirmed = (fn, ms) => {
  let timer;
  return Promise.race([(async () => fn())().then(() => true, () => false), new Promise(resolve => { timer = setTimeout(resolve, ms, false); })]).finally(() => clearTimeout(timer));
};
const TERMINAL = /^session\.execution\.(succeeded|failed|interrupted)$/;
// Metadata key marking sessions this bridge created; only those may be resumed.
const MARK = 'agentbridge';

/** One OpenCode session turn per job, driven over the shared local service's HTTP API. */
export class OpenCodeJobs {
  constructor({
    client, service = Service,
    timeoutMs = 3_600_000, maxOutputBytes = 4_000_000,
    maxEvents = 256, maxConcurrent = 4, maxJobs = 100, connectMs = 10_000, closeMs = 3000, lingerMs = 5000, drainMs = 30_000,
  } = {}) {
    for (const value of [timeoutMs, maxOutputBytes, maxEvents, maxConcurrent, maxJobs, connectMs, closeMs, lingerMs, drainMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Limits must be positive integers');
    }
    Object.assign(this, { client, service, timeoutMs, maxOutputBytes, maxEvents, maxConcurrent, maxJobs, connectMs, closeMs, lingerMs, drainMs });
    this.jobs = new Map();
    // Requests already answered, across jobs, so a redelivered request is not replied to twice.
    this.answered = new Set();
    this.closing = false;
  }

  start({ prompt, cwd, sessionId, model, level = 'read-only', worktree } = {}) {
    if (this.closing) throw new Error('Server is shutting down');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000)
      throw new Error('prompt must be a nonempty string of at most 100000 characters');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !statSync(cwd).isDirectory())
      throw new Error('cwd must be an existing absolute directory');
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)))
      throw new Error('Invalid sessionId');
    if (model !== undefined && (typeof model !== 'string' || !MODEL.test(model)))
      throw new Error('model must be providerID/modelID or providerID/modelID#variant');
    if (!LEVELS.includes(level)) throw new Error('Invalid level');
    // Worktrees are created by the coordinator, which hands this adapter the worktree's cwd.
    if (worktree !== undefined && worktree !== false) throw new Error('worktree jobs are not supported by the adapter directly');
    const active = [...this.jobs.values()].filter(record => !record.settled);
    if (active.length >= this.maxConcurrent) throw new Error('Maximum concurrent jobs reached');
    if (sessionId && active.some(record => record.view.sessionId === sessionId))
      throw new Error('Session already has an active turn');
    while (this.jobs.size >= this.maxJobs) {
      const oldest = [...this.jobs.values()].find(record => record.settled);
      if (!oldest) throw new Error('Maximum retained jobs reached');
      this.close(oldest);
      this.jobs.delete(oldest.view.id);
    }
    const view = {
      id: randomUUID(), provider: 'opencode', backend: 'opencode-http', status: 'running',
      startedAt: now(), cwd, level, sessionId: sessionId ?? null, result: null, error: null,
      progress: { phase: 'starting', text: '', textTruncated: false, updatedAt: now() },
      permissionDenials: [], usage: null, costUsd: null,
      openCode: { sessionId: sessionId ?? null, endpoint: null, interrupt: null },
    };
    const record = {
      view, controller: new AbortController(), events: [], sequence: 0, settled: false,
      prompted: false, ended: false, replies: new Set(), streamed: new Set(), message: null, parts: new Map(),
      live: Promise.withResolvers(), finish: Promise.withResolvers(), drain: Promise.withResolvers(),
      subscription: new AbortController(),
    };
    record.live.promise.catch(() => {});
    record.finish.promise.catch(() => {});
    this.jobs.set(view.id, record);
    const [, providerID, id, variant] = model?.match(MODEL) ?? [];
    // Defer launch so immediate cancellation is observed before contacting OpenCode.
    record.done = Promise.resolve().then(() => this.run(record, { prompt, sessionId, level, model: model && { providerID, id, ...(variant ? { variant } : {}) } }));
    return this.snapshot(record);
  }

  async run(record, request) {
    const { view, controller: { signal } } = record;
    const timer = setTimeout(() => this.stop(record, 'timed_out', 'Job exceeded its time limit'), this.timeoutMs);
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    aborted.catch(() => {});
    const step = promise => Promise.race([promise, aborted]);
    try {
      if (signal.aborted) return;
      const endpoint = await step(this.service.ensure());
      const client = record.client = this.client ?? OpenCode.make({ baseUrl: endpoint.url, headers: this.service.headers(endpoint) });
      view.openCode.endpoint = publicUrl(endpoint.url);
      let sessionID = request.sessionId;
      if (sessionID) {
        // A resumed session keeps the rules it was created with; its permissions are never rewritten.
        const mark = (await step(client.session.get({ sessionID })))?.metadata?.[MARK];
        if (!mark || typeof mark !== 'object') throw new Error('Session was not created by the bridge, so it cannot be resumed by it');
        if (mark.level !== request.level)
          throw new Error(`Session was created at level "${bounded(mark.level, 32)}"; resume it at that level or start a new job`);
        if (request.model) await step(client.session.switchModel({ sessionID, model: request.model }));
      } else {
        const entries = await step(client.config.get({ location: { directory: view.cwd } }));
        if (!Array.isArray(entries)) throw new Error('OpenCode returned an invalid configuration');
        const permissions = levelRules(request.level, { config: entries.flatMap(entry => entry?.info?.permissions ?? []) });
        const session = await step(client.session.create({
          location: { directory: view.cwd }, ...(request.model ? { model: request.model } : {}),
          permissions, metadata: { [MARK]: { level: request.level } },
        }));
        sessionID = session?.id;
        if (typeof sessionID !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(sessionID)) throw new Error('OpenCode returned an invalid session');
      }
      view.sessionId = view.openCode.sessionId = sessionID;
      view.progress.phase = 'running';
      this.event(record, 'session', { sessionId: sessionID });
      record.owned = new Set([sessionID]);
      // Subscribe before prompting; server.connected marks the subscription live. The abort signal is what
      // closes the stream. OpenCode.make's shared stream reads it from the first argument; the raw generated
      // client reads it from the second, and there return() waits for the pending next().
      const { signal: closer } = record.subscription;
      record.stream = client.event.subscribe({ signal: closer }, { signal: closer })[Symbol.asyncIterator]();
      this.pump(record, client, record.stream);
      let connect;
      const connected = new Promise((_, reject) => { connect = setTimeout(() => reject(new Error('OpenCode event stream did not connect')), this.connectMs); });
      await step(Promise.race([record.live.promise, connected])).finally(() => clearTimeout(connect));
      record.prompted = true;
      record.promptCall = (async () => client.session.prompt({ sessionID, text: request.prompt }))();
      await step(record.promptCall);
      record.outcome = await step(record.finish.promise);
    } catch (error) {
      if (!signal.aborted) record.outcome = { status: 'failed', error: bounded(error?.message || error) };
    } finally {
      clearTimeout(timer);
      // Interrupting also ends any permission request we failed to answer. A prompt still in flight
      // could start its turn after the interrupt, so it is allowed to land first.
      if (record.prompted && !record.ended) await settledWithin(record.promptCall, this.closeMs);
      if (record.prompted && !record.ended) {
        const ok = await confirmed(() => record.client.session.interrupt({ sessionID: view.sessionId }), this.closeMs);
        view.openCode.interrupt = ok ? 'confirmed' : 'unconfirmed';
        if (!ok) this.event(record, 'interrupt_unconfirmed', { sessionId: view.sessionId });
      }
      if (!signal.aborted && record.outcome) Object.assign(view, record.outcome);
      view.finishedAt = now();
      view.progress.phase = view.status;
      view.progress.updatedAt = now();
      record.settled = true;
      this.event(record, 'finished', { status: view.status });
      // After an unclean exit the turn may still run: keep answering its requests until it ends or drainMs passes.
      if (!record.prompted || record.ended) record.drain.resolve();
      else {
        const bound = setTimeout(record.drain.resolve, this.drainMs);
        record.drain.promise.then(() => clearTimeout(bound));
      }
      // Then keep answering late requests briefly; shutdown() closes once drained.
      if (record.stream) record.drain.promise.then(() => { record.linger = setTimeout(() => this.close(record), this.lingerMs); record.linger.unref?.(); });
    }
  }

  async pump(record, client, stream) {
    const { view, controller: { signal } } = record;
    try {
      for (let item; !(item = await stream.next()).done;) {
        const event = item.value, data = event?.data;
        if (event?.type === 'server.connected') { record.live.resolve(); continue; }
        if (!data || typeof data !== 'object') continue;
        if (event.type === 'session.created' && record.owned.has(data.parentID) && typeof data.sessionID === 'string') { record.owned.add(data.sessionID); continue; }
        if (!record.owned.has(data.sessionID)) continue;
        // Answered before any other check: an unanswered request hangs the delegate.
        if (event.type === 'permission.asked') this.answer(record, client, data);
        if (record.prompted && data.sessionID === view.sessionId && TERMINAL.test(event.type)) { record.ended = true; record.drain.resolve(); }
        if (record.settled || signal.aborted || !record.prompted || data.sessionID !== view.sessionId) continue;
        if (Buffer.byteLength(JSON.stringify(event), 'utf8') > this.maxOutputBytes) {
          this.stop(record, 'failed', 'OpenCode output exceeded the configured byte limit');
          continue;
        }
        this.consume(record, event);
      }
      throw new Error('OpenCode event stream ended without a result');
    } catch (error) {
      record.live.reject(error);
      record.finish.reject(error);
    } finally {
      record.drain.resolve();
    }
  }

  answer(record, client, data) {
    if (typeof data.id !== 'string') return;
    const key = data.sessionID + '\n' + data.id;
    if (this.answered.has(key)) return;
    this.answered.add(key);
    if (this.answered.size > 1000) this.answered.delete(this.answered.values().next().value);
    if (!record.settled) this.denial(record, data.action, data.id);
    // Never 'always': that would persist an approval in the user's project.
    const reply = (async () => client.permission.reply({ sessionID: data.sessionID, requestID: data.id, decision: 'reject' }))()
      .catch(() => {
        this.answered.delete(key);
        if (!record.settled) return this.stop(record, 'failed', 'Could not answer an OpenCode permission request');
        return settledWithin((async () => client.session.interrupt({ sessionID: data.sessionID }))(), this.closeMs);
      })
      .finally(() => record.replies.delete(reply));
    record.replies.add(reply);
  }

  consume(record, { type, data }) {
    const { view } = record;
    view.progress.updatedAt = now();
    const key = data.assistantMessageID + '\n' + data.ordinal;
    if (type === 'session.text.delta') {
      record.streamed.add(key);
      this.text(record, data.delta);
    } else if (type === 'session.text.ended') {
      if (!record.streamed.delete(key)) this.text(record, data.text);
      if (record.message !== data.assistantMessageID) { record.message = data.assistantMessageID; record.parts.clear(); }
      record.parts.set(data.ordinal, String(data.text ?? ''));
      record.result = [...record.parts.values()].join('\n\n').slice(0, this.maxOutputBytes);
    } else if (type === 'session.tool.input.started') {
      this.event(record, 'tool', { name: bounded(data.name, 128) });
    } else if (type === 'session.usage.updated') {
      const { input, output, reasoning, cache } = data.tokens ?? {};
      view.usage = { input, output, reasoning, cache: { read: cache?.read, write: cache?.write } };
      view.costUsd = typeof data.cost === 'number' ? data.cost : null;
    } else if (TERMINAL.test(type)) {
      view.progress.phase = 'finishing';
      record.finish.resolve(type.endsWith('succeeded') ? { status: 'completed', result: record.result ?? '' }
        : type.endsWith('failed') ? { status: 'failed', error: bounded(data.error?.message || 'OpenCode execution failed') }
        : { status: 'failed', error: 'OpenCode execution was interrupted (' + bounded(data.reason, 32) + ')' });
    }
  }

  text(record, value) {
    const { view } = record, text = String(value ?? '');
    const combined = view.progress.text + text;
    view.progress.text = combined.slice(-16000);
    view.progress.textTruncated ||= combined.length > 16000;
    this.event(record, 'text', { text: bounded(text), truncated: text.length > 4000 });
  }

  denial(record, toolName, toolUseId) {
    const item = { toolName: bounded(toolName, 128), toolUseId: bounded(toolUseId, 128) };
    record.view.permissionDenials.push(item);
    if (record.view.permissionDenials.length > 50) record.view.permissionDenials.shift();
    this.event(record, 'permission_denied', item);
  }

  event(record, type, data) {
    record.events.push({ sequence: ++record.sequence, at: now(), type, ...data });
    if (record.events.length > this.maxEvents) record.events.shift();
  }

  /** Closes the event stream once pending replies land: aborting the request ends the generator; return() is a fallback. */
  close(record) {
    return record.closing ??= (async () => {
      clearTimeout(record.linger);
      await settledWithin(Promise.allSettled([...record.replies]), this.closeMs);
      record.subscription.abort();
      if (record.stream) await settledWithin((async () => record.stream.return?.())(), this.closeMs);
    })();
  }

  get(id) {
    const record = this.jobs.get(id);
    if (!record) throw new Error('job not found');
    return record;
  }

  snapshot(record) { return structuredClone(record.view); }
  status(id) { return this.snapshot(this.get(id)); }
  list() { return [...this.jobs.values()].map(record => this.snapshot(record)); }
  async wait(id) { const record = this.get(id); await record.done; return this.snapshot(record); }

  events(id, { after = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
    const record = this.get(id);
    const events = record.events.filter(event => event.sequence > after).slice(0, limit);
    return structuredClone({
      events, nextCursor: events.at(-1)?.sequence ?? after,
      truncated: record.events.length > 0 && after < record.events[0].sequence - 1,
      hasMore: events.length > 0 && events.at(-1).sequence < record.sequence,
    });
  }

  stop(record, status, error = null) {
    if (record.view.status !== 'running') return;
    record.view.status = status;
    record.view.error = error;
    record.controller.abort();
  }

  cancel(id) {
    const record = this.get(id);
    this.stop(record, 'cancelled');
    return this.snapshot(record);
  }

  async shutdown() {
    this.closing = true;
    for (const record of this.jobs.values()) this.stop(record, 'cancelled');
    await Promise.all([...this.jobs.values()].map(record => record.done));
    await Promise.all([...this.jobs.values()].map(record => record.drain.promise));
    await Promise.all([...this.jobs.values()].map(record => this.close(record)));
  }
}
