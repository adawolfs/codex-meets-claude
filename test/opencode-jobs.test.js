import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeJobs } from '../src/opencode-jobs.js';
import { JobManager } from '../src/jobs.js';
import { createRunner } from '../src/runner.js';
import { levelRules } from '../src/opencode-levels.js';
import { fakeOpenCode } from './fake-opencode.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const ev = (type, data = {}) => ({ type, data: { sessionID: 's1', ...data } });
const delta = (text, assistantMessageID = 'm1') => ev('session.text.delta', { assistantMessageID, ordinal: 0, delta: text });
const ended = (text, assistantMessageID = 'm1') => ev('session.text.ended', { assistantMessageID, ordinal: 0, text });
const succeeded = ev('session.execution.succeeded');
const asked = (id, action, resources = [], sessionID = 's1') => ({ type: 'permission.asked', data: { id, sessionID, action, resources } });
const cwd = process.cwd();
function gate() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }

test('adapter streams progress, records the session and completes', async () => {
  const { client, service, emit, open } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'review', cwd, level: 'edit' });
  await tick();
  assert.deepEqual(jobs.status(job.id).openCode, { sessionId: 's1', endpoint: 'http://127.0.0.1:4096', interrupt: null });
  emit(delta('work'));
  emit(delta('ing'));
  emit(ev('session.tool.input.started', { id: 't1', name: 'read' }));
  await tick();
  assert.equal(jobs.status(job.id).status, 'running');
  assert.equal(jobs.status(job.id).sessionId, 's1');
  assert.equal(jobs.status(job.id).progress.text, 'working');
  assert.deepEqual(client.session.create.calls[0].permissions, levelRules('edit'));
  assert.deepEqual(client.session.create.calls[0].location, { directory: cwd });
  assert.deepEqual(client.session.create.calls[0].metadata, { agentbridge: { level: 'edit' } });
  assert.deepEqual(client.event.subscribe.calls[0], { signal: true, requestSignal: true });
  assert.deepEqual(client.session.prompt.calls[0], { sessionID: 's1', text: 'review' });
  emit(ended('working'));
  emit(succeeded);
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'working');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.backend, 'opencode-http');
  assert.ok(!JSON.stringify(result).includes('secret'));
  const types = jobs.events(job.id).events.map(e => e.type);
  for (const type of ['session', 'text', 'tool', 'finished']) assert.ok(types.includes(type), type);
  assert.ok(jobs.events(job.id).events.some(e => e.type === 'tool' && e.name === 'read'));
  assert.equal(client.session.interrupt.calls.length, 0);
  await jobs.shutdown();
  assert.equal(open(), 0);
});

test('the session is recorded before the prompt is sent', async () => {
  let seen;
  const jobs = new OpenCodeJobs(fakeOpenCode({ script: { 'session.prompt': () => { seen = jobs.list()[0].openCode; return {}; } } }));
  jobs.start({ prompt: 'x', cwd });
  await tick();
  assert.deepEqual(seen, { sessionId: 's1', endpoint: 'http://127.0.0.1:4096', interrupt: null });
  await jobs.shutdown();
});

test('permission requests are rejected and recorded, never left unanswered', async () => {
  const { client, service, emit, open } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  emit(asked('r1', 'shell', ['rm -rf /']));
  await tick();
  assert.deepEqual(client.permission.reply.calls[0], { sessionID: 's1', requestID: 'r1', decision: 'reject' });
  assert.equal(jobs.status(job.id).permissionDenials[0].toolName, 'shell');
  assert.ok(!JSON.stringify(jobs.status(job.id)).includes('rm -rf'));
  assert.ok(!JSON.stringify(jobs.events(job.id)).includes('rm -rf'));
  // A redelivered request is not answered twice; another user's session is not ours to answer.
  emit(asked('r1', 'shell', ['rm -rf /']));
  emit(asked('u1', 'edit', ['a.js'], 'user-session'));
  await tick();
  assert.equal(client.permission.reply.calls.length, 1);
  // A child session of ours (a subagent) is answered too.
  emit({ type: 'session.created', data: { sessionID: 'c1', parentID: 's1' } });
  emit(asked('r3', 'edit', ['b.js'], 'c1'));
  await tick();
  assert.deepEqual(client.permission.reply.calls[1], { sessionID: 'c1', requestID: 'r3', decision: 'reject' });
  // Arrives after the job settles; still answered, and the settled view does not change.
  emit(succeeded);
  const settled = await jobs.wait(job.id);
  emit(asked('r2', 'edit', ['a.js']));
  await tick();
  assert.equal(client.permission.reply.calls.length, 3);
  assert.deepEqual(jobs.status(job.id), settled);
  await jobs.shutdown();
  assert.equal(open(), 0);
});

test('a permission reply that fails fails the job and interrupts the session', async () => {
  const { client, service, emit } = fakeOpenCode({ script: { 'permission.reply': () => { throw Error('connection reset'); } } });
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  emit(asked('r1', 'shell'));
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /permission request/);
  assert.deepEqual(client.session.interrupt.calls[0], { sessionID: 's1' });
  await jobs.shutdown();
});

test('a stream that ends without a result fails the job', async () => {
  for (const end of [null, new Error('socket hang up')]) {
    const { client, service, emit, open } = fakeOpenCode();
    const jobs = new OpenCodeJobs({ client, service });
    const job = jobs.start({ prompt: 'x', cwd });
    await tick();
    emit(end);
    const result = await jobs.wait(job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, end ? /socket hang up/ : /ended without a result/);
    assert.deepEqual(client.session.interrupt.calls[0], { sessionID: 's1' });
    assert.equal(open(), 0);
  }
});

test('execution failures and interruptions are never success', async () => {
  for (const [event, pattern] of [[ev('session.execution.failed', { error: { type: 'api', message: 'rate limited' } }), /rate limited/], [ev('session.execution.interrupted', { reason: 'user' }), /interrupted/]]) {
    const { client, service, emit } = fakeOpenCode();
    const jobs = new OpenCodeJobs({ client, service });
    const job = jobs.start({ prompt: 'x', cwd });
    await tick();
    emit(event);
    const result = await jobs.wait(job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, pattern);
    assert.equal(client.session.interrupt.calls.length, 0);
    await jobs.shutdown();
  }
  const { client, service } = fakeOpenCode({ script: { 'session.prompt': () => { throw Error('cannot prompt'); } } });
  const jobs = new OpenCodeJobs({ client, service });
  assert.match((await jobs.wait(jobs.start({ prompt: 'x', cwd }).id)).error, /cannot prompt/);
  assert.deepEqual(client.session.interrupt.calls[0], { sessionID: 's1' });
});

test('cancel interrupts the session and cannot be overwritten by a late result', async () => {
  const interrupted = gate();
  const { client, service, emit, open } = fakeOpenCode({ script: { 'session.interrupt': () => interrupted.promise } });
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  emit(delta('partial'));
  await tick();
  assert.equal(jobs.cancel(job.id).status, 'cancelled');
  await tick();
  assert.deepEqual(client.session.interrupt.calls, [{ sessionID: 's1' }]);
  // Late events arrive while the interrupt is still in flight.
  emit(delta('late'));
  emit(ended('late'));
  emit(succeeded);
  await tick();
  assert.equal(jobs.status(job.id).progress.text, 'partial');
  interrupted.resolve({});
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.result, null);
  assert.equal(result.progress.text, 'partial');
  assert.ok(result.finishedAt);
  assert.equal(result.openCode.interrupt, 'confirmed');
  assert.deepEqual(client.session.interrupt.calls, [{ sessionID: 's1' }]);
  await jobs.shutdown();
  assert.equal(open(), 0);
  // Cancelled before launch: nothing is contacted.
  const fresh = fakeOpenCode();
  const other = new OpenCodeJobs(fresh);
  const early = other.start({ prompt: 'x', cwd });
  other.cancel(early.id);
  assert.equal((await other.wait(early.id)).status, 'cancelled');
  assert.equal(fresh.service.ensure.calls.length, 0);
});

test('timeout interrupts and reports timed_out', async () => {
  const { client, service } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service, timeoutMs: 20 });
  const result = await jobs.wait(jobs.start({ prompt: 'x', cwd }).id);
  assert.equal(result.status, 'timed_out');
  assert.deepEqual(client.session.interrupt.calls[0], { sessionID: 's1' });
  await jobs.shutdown();
  // A subscription that never connects fails without prompting.
  const quiet = fakeOpenCode({ script: { connected: false } });
  const deaf = new OpenCodeJobs({ ...quiet, connectMs: 20 });
  assert.match((await deaf.wait(deaf.start({ prompt: 'x', cwd }).id)).error, /did not connect/);
  assert.equal(quiet.client.session.prompt.calls.length, 0);
  await deaf.shutdown();
  assert.equal(quiet.open(), 0);
  // A service that never answers still times out.
  const stuck = new OpenCodeJobs({ ...fakeOpenCode({ script: { 'service.ensure': () => new Promise(() => {}) } }), timeoutMs: 20 });
  assert.equal((await stuck.wait(stuck.start({ prompt: 'x', cwd }).id)).status, 'timed_out');
});

test('events are bounded, paged, and carry no reasoning or tool arguments', async () => {
  const { client, service, emit } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service, maxEvents: 5 });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  emit(ev('session.reasoning.delta', { assistantMessageID: 'm1', ordinal: 0, delta: 'private-thought' }));
  emit(ev('session.reasoning.ended', { assistantMessageID: 'm1', ordinal: 0, text: 'private-thought' }));
  emit(ev('session.tool.input.started', { id: 't1', name: 'shell' }));
  emit(ev('session.tool.input.delta', { id: 't1', delta: '{"command":"secret-arg"}' }));
  emit(ev('session.tool.called', { id: 't1', tool: 'shell', input: { command: 'secret-arg' } }));
  emit(ev('session.tool.success', { id: 't1', content: [{ type: 'text', text: 'secret-arg output' }] }));
  for (let i = 0; i < 20; i++) emit(delta('text'));
  emit(succeeded);
  await jobs.wait(job.id);
  const page = jobs.events(job.id, { after: 0, limit: 2 });
  assert.equal(page.events.length, 2);
  assert.equal(page.truncated, true);
  assert.equal(page.hasMore, true);
  const next = jobs.events(job.id, { after: page.nextCursor, limit: 100 });
  assert.ok(next.events.every(e => e.sequence > page.nextCursor));
  assert.equal(next.hasMore, false);
  const all = JSON.stringify([jobs.status(job.id), jobs.events(job.id, { limit: 100 })]);
  for (const secret of ['private-thought', 'secret-arg']) assert.ok(!all.includes(secret), secret);
  assert.throws(() => jobs.events(job.id, { after: -1 }));
  assert.throws(() => jobs.events(job.id, { limit: 101 }));
  await jobs.shutdown();
});

test('oversized messages and excess concurrency are bounded', async () => {
  const { client, service, emit } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service, maxOutputBytes: 100 });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  emit(asked('big', 'shell', ['x'.repeat(1000)]));
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /byte limit/);
  // An oversized request is still answered.
  assert.equal(client.permission.reply.calls[0].requestID, 'big');
  assert.deepEqual(client.session.interrupt.calls[0], { sessionID: 's1' });
  await jobs.shutdown();
  const fake = fakeOpenCode();
  const n = new OpenCodeJobs({ ...fake, maxConcurrent: 1 });
  const first = n.start({ prompt: 'x', cwd });
  assert.throws(() => n.start({ prompt: 'x', cwd }), /concurrent/);
  await tick();
  fake.emit(succeeded);
  assert.equal((await n.wait(first.id)).status, 'completed');
  await n.shutdown();
});

test('resume prompts the recorded session instead of creating one', async () => {
  const marked = level => ({ 'session.get': ({ sessionID }) => ({ id: sessionID, metadata: { agentbridge: { level } } }) });
  const { client, service, emit } = fakeOpenCode({ script: marked('build') });
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'again', cwd, sessionId: 's1', level: 'build', model: 'anthropic/claude-sonnet-4.5' });
  assert.equal(job.openCode.sessionId, 's1');
  assert.throws(() => jobs.start({ prompt: 'x', cwd, sessionId: 's1' }), /active turn/);
  await tick();
  assert.equal(client.session.create.calls.length, 0);
  assert.equal(client.config.get.calls.length, 0);
  assert.deepEqual(client.session.get.calls[0], { sessionID: 's1' });
  assert.deepEqual(client.session.switchModel.calls[0], { sessionID: 's1', model: { providerID: 'anthropic', id: 'claude-sonnet-4.5' } });
  assert.equal(client.session.prompt.calls[0].sessionID, 's1');
  emit(succeeded);
  assert.equal((await jobs.wait(job.id)).status, 'completed');
  await jobs.shutdown();
  // The client exposes no permission rewrite to the adapter at all.
  assert.equal(client.session.update, undefined);
});

test('resume refuses sessions the bridge did not create, and a different level', async () => {
  for (const [script, level, pattern] of [
    [{ 'session.get': ({ sessionID }) => ({ id: sessionID }) }, 'read-only', /not created by the bridge/],
    [{ 'session.get': ({ sessionID }) => ({ id: sessionID, metadata: { other: true } }) }, 'read-only', /not created by the bridge/],
    [{ 'session.get': ({ sessionID }) => ({ id: sessionID, metadata: { agentbridge: { level: 'read-only' } } }) }, 'build', /created at level "read-only"/],
  ]) {
    const fake = fakeOpenCode({ script });
    const jobs = new OpenCodeJobs(fake);
    const result = await jobs.wait(jobs.start({ prompt: 'x', cwd, sessionId: 'user-session', level }).id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, pattern);
    assert.equal(fake.client.session.prompt.calls.length, 0);
    assert.equal(fake.stats.opened, 0);
  }
});

test('a cancel during the prompt lets the prompt land before interrupting', async () => {
  const order = [], prompted = gate();
  const { client, service } = fakeOpenCode({ script: {
    'session.prompt': async () => { await prompted.promise; order.push('prompt'); return {}; },
    'session.interrupt': () => { order.push('interrupt'); return {}; },
  } });
  const jobs = new OpenCodeJobs({ client, service, drainMs: 20 });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  assert.equal(client.session.prompt.calls.length, 1);
  jobs.cancel(job.id);
  await tick();
  assert.deepEqual(order, []);
  prompted.resolve();
  assert.equal((await jobs.wait(job.id)).status, 'cancelled');
  assert.deepEqual(order, ['prompt', 'interrupt']);
  await jobs.shutdown();
  // A prompt that never answers is waited for only closeMs.
  const stuck = fakeOpenCode({ script: { 'session.prompt': () => new Promise(() => {}) } });
  const other = new OpenCodeJobs({ ...stuck, closeMs: 20 });
  const late = other.start({ prompt: 'x', cwd });
  await tick();
  other.cancel(late.id);
  await other.wait(late.id);
  assert.deepEqual(stuck.client.session.interrupt.calls, [{ sessionID: 's1' }]);
  await other.shutdown();
});

test('an unconfirmed interrupt is recorded and the stream keeps answering until the turn ends', async () => {
  const { client, service, emit, open } = fakeOpenCode({ script: { 'session.interrupt': () => { throw Error('connection refused'); } } });
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'x', cwd });
  await tick();
  jobs.cancel(job.id);
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.openCode.interrupt, 'unconfirmed');
  assert.ok(jobs.events(job.id).events.some(e => e.type === 'interrupt_unconfirmed' && e.sessionId === 's1'));
  // shutdown() waits for the still-running turn, answering its requests meanwhile.
  let shut = false;
  const closing = jobs.shutdown().then(() => { shut = true; });
  await tick();
  assert.equal(shut, false);
  assert.equal(open(), 1);
  emit(asked('r9', 'shell'));
  await tick();
  assert.deepEqual(client.permission.reply.calls[0], { sessionID: 's1', requestID: 'r9', decision: 'reject' });
  emit(ev('session.execution.succeeded'));
  await closing;
  assert.equal(open(), 0);
  // Without a terminal event the wait is bounded by drainMs.
  const quiet = fakeOpenCode({ script: { 'session.interrupt': () => { throw Error('down'); } } });
  const other = new OpenCodeJobs({ ...quiet, drainMs: 20 });
  const stuck = other.start({ prompt: 'x', cwd });
  await tick();
  other.cancel(stuck.id);
  await other.wait(stuck.id);
  await other.shutdown();
  assert.equal(quiet.open(), 0);
});

test('the fake models the real stream: late subscribers miss events, return() waits, abort closes', async () => {
  const { client, emit, open } = fakeOpenCode();
  emit(delta('before anyone listens'));
  const plain = client.event.subscribe({})[Symbol.asyncIterator]();
  assert.equal((await plain.next()).value.type, 'server.connected');
  const pending = plain.next();
  let returned = false;
  const closing = plain.return().then(() => { returned = true; });
  await tick();
  assert.equal(returned, false);
  assert.equal(open(), 1);
  emit(delta('after'));
  assert.equal((await pending).value.data.delta, 'after');
  await closing;
  assert.equal(open(), 0);
  // A signal in the second argument is ignored, as by OpenCode.make's client.
  const ignored = new AbortController();
  const deaf = client.event.subscribe({}, { signal: ignored.signal })[Symbol.asyncIterator]();
  await deaf.next();
  const stillWaiting = deaf.next();
  ignored.abort();
  await tick();
  assert.equal(open(), 1);
  emit(null);
  assert.equal((await stillWaiting).done, true);
  const controller = new AbortController();
  const aborted = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
  await aborted.next();
  const waiting = aborted.next();
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(open(), 0);
});

test('the real client stream closes on shutdown against a silent server', { timeout: 15000 }, async () => {
  const { createServer } = await import('node:http');
  const { OpenCode } = await import('@opencode/client');
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = createServer((req, res) => {
    assert.equal(req.url.split('?')[0], '/api/event');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"server.connected","data":{}}\n\n');
    res.write(': heartbeat\n\n');
    req.on('close', closed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const real = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const fake = fakeOpenCode();
    fake.client.event = real.event;
    // The fake interrupt's event cannot reach the real stream, so drainMs bounds the wait for it.
    const jobs = new OpenCodeJobs({ ...fake, closeMs: 60_000, drainMs: 20 });
    const job = jobs.start({ prompt: 'x', cwd });
    while (!fake.client.session.prompt.calls.length) await tick();
    jobs.cancel(job.id);
    await jobs.wait(job.id);
    const started = Date.now();
    await jobs.shutdown();
    assert.ok(Date.now() - started < 5000, 'close waited for a timeout instead of aborting the request');
    await disconnected;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('the user configuration bounds the level, and an impossible one fails the job cleanly', async () => {
  const deny = [{ action: 'edit', resource: '*', effect: 'deny' }];
  const config = [{ type: 'document', path: '/a/opencode.json', info: { permissions: deny } }, { type: 'document', path: '/b/opencode.json', info: {} }];
  const fake = fakeOpenCode({ script: { config } });
  const jobs = new OpenCodeJobs(fake);
  const job = jobs.start({ prompt: 'x', cwd, level: 'edit', model: 'anthropic/claude-sonnet-4.5' });
  await tick();
  assert.deepEqual(fake.client.config.get.calls[0], { location: { directory: cwd } });
  assert.deepEqual(fake.client.session.create.calls[0].permissions, levelRules('edit', { config: deny }));
  assert.deepEqual(fake.client.session.create.calls[0].model, { providerID: 'anthropic', id: 'claude-sonnet-4.5' });
  fake.emit(succeeded);
  await jobs.wait(job.id);
  await jobs.shutdown();
  const locked = fakeOpenCode({ script: { config: [{ type: 'document', info: { permissions: [{ action: '*', resource: '*', effect: 'deny' }] } }] } });
  const other = new OpenCodeJobs(locked);
  const result = await other.wait(other.start({ prompt: 'x', cwd, level: 'edit' }).id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /denies every action/);
  assert.equal(locked.client.session.create.calls.length, 0);
  assert.equal(locked.stats.opened, 0);
});

test('invalid requests are rejected before contacting OpenCode', () => {
  const fake = fakeOpenCode();
  const jobs = new OpenCodeJobs(fake);
  for (const args of [{ prompt: '' }, { cwd: 'relative' }, { level: 'admin' }, { worktree: true }, { worktree: 'yes' }, { model: 'no-provider' }, { model: '/b' }, { model: 'a/' }, { sessionId: '../bad' }])
    assert.throws(() => jobs.start({ prompt: 'x', cwd, ...args }));
  assert.equal(fake.service.ensure.calls.length, 0);
  assert.throws(() => new OpenCodeJobs({ ...fake, maxEvents: 0 }));
});

test('the runner drains OpenCode events through the job manager', async () => {
  const fake = fakeOpenCode();
  const pages = [];
  const runner = createRunner({ pollMs: 1, managerFactory: provider => new JobManager({ provider, ...fake, timeoutMs: 5000 }) });
  const running = runner('opencode', { prompt: 'x', cwd, level: 'read-only', worktree: false }, (view, events) => pages.push(...events), new AbortController().signal);
  await tick();
  fake.emit(ended('done'));
  fake.emit(succeeded);
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'done');
  assert.ok(pages.some(e => e.type === 'session') && pages.some(e => e.type === 'finished'));
  assert.equal(fake.open(), 0);
});
