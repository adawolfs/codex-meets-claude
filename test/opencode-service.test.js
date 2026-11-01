import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startService, openCodeProbe } from '../src/service.js';
import { ServiceClient } from '../src/client.js';
import { PROVIDERS, surface, validateCall, staleRegistration } from '../src/persistent-tools.js';
import { validateStart } from '../src/coordinator.js';
import { OpenCodeJobs } from '../src/opencode-jobs.js';
import { fakeOpenCode } from './fake-opencode.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const linux = { skip: process.platform === 'win32' };
const tick = () => new Promise(r => setImmediate(r));
const env = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !['BRIDGE_PROVIDER', 'BRIDGE_CLIENT'].includes(k) && typeof v === 'string')), ...extra });
async function connect(clientName, directory) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp-client.js')], env: env({ BRIDGE_CLIENT: clientName, ...(directory ? { BRIDGE_STATE_DIR: directory } : {}) }), stderr: 'pipe' }));
  return client;
}
const listTools = async clientName => { const c = await connect(clientName); try { return (await c.listTools()).tools.map(t => t.name); } finally { await c.close(); } };
const asJson = r => { assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };

test('each client is offered the other two providers and never itself', async () => {
  for (const me of PROVIDERS) {
    const names = await listTools(me);
    assert.ok(names.length > 0 && names.every(n => !n.startsWith(me + '_')), me);
    for (const other of PROVIDERS.filter(p => p !== me)) assert.ok(names.some(n => n.startsWith(other + '_')), `${me} sees ${other}`);
  }
});

test('the launcher validates the client before touching the service', () => {
  for (const bad of [undefined, 'gemini', 'Claude', 'claude,codex', '']) {
    const r = spawnSync(process.execPath, [resolve('src/launch.js'), ...(bad === undefined ? [] : [bad])], { env: env({ BRIDGE_STATE_DIR: '/nonexistent' }), encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1, String(bad));
    assert.match(r.stderr, /claude, codex, opencode or status/);
  }
});

test('the MCP client refuses to start without a valid BRIDGE_CLIENT', () => {
  for (const e of [{}, { BRIDGE_CLIENT: 'gemini' }, { BRIDGE_PROVIDER: 'claude' }]) {
    const r = spawnSync(process.execPath, [resolve('src/mcp-client.js')], { env: env(e), encoding: 'utf8', timeout: 10000, input: '' });
    assert.equal(r.status, 1, JSON.stringify(e));
    assert.match(r.stderr, /BRIDGE_CLIENT/);
  }
});

test('tool names resolve exactly: only the two served providers, never a prefix match or own tool', () => {
  const s = surface('codex');
  assert.deepEqual(s.resolve('opencode_cancel'), { provider: 'opencode', action: 'cancel' });
  assert.deepEqual(s.resolve('claude_cancel'), { provider: 'claude', action: 'cancel' });
  assert.equal(s.resolve('codex_cancel'), undefined);
  assert.equal(s.resolve('codex_start'), undefined);
  for (const bad of ['opencode_', 'opencode', 'opencode_nope', 'opencodex_start', 'opencode_start ', 'OPENCODE_start', 'claude_cleanup', '__proto__', 'constructor', 'toString', '', 'claude_start\n', undefined, null, 7, {}, ['claude_start']])
    assert.equal(s.resolve(bad), undefined, String(bad));
  assert.deepEqual(surface('opencode').resolve('codex_cancel'), { provider: 'codex', action: 'cancel' });
  assert.equal(surface('opencode').resolve('opencode_cancel'), undefined);
  assert.equal(surface('claude').resolve('opencode_cleanup').action, 'cleanup');
  assert.throws(() => surface('gemini'), /Invalid client/);
});

test('a tool call is dispatched to the provider named by its prefix, and own tools are refused', linux, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-prefix-'));
  const seen = [];
  const service = await startService({ directory, runner: async provider => { seen.push(provider); return { status: 'completed', result: provider }; }, resolveProject: async cwd => ({ cwd, project: cwd + '/' + seen.length }) });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const claude = await connect('claude', directory), opencode = await connect('opencode', directory);
  t.after(() => Promise.all([claude.close(), opencode.close()]));
  const call = (c, name, args) => c.callTool({ name, arguments: args });
  const one = asJson(await call(claude, 'opencode_start', { prompt: 'a', cwd: '/tmp' }));
  const two = asJson(await call(claude, 'codex_start', { prompt: 'b', cwd: '/tmp' }));
  const three = asJson(await call(opencode, 'claude_start', { prompt: 'c', cwd: '/tmp' }));
  await tick(); await tick();
  assert.deepEqual([one.provider, two.provider, three.provider], ['opencode', 'codex', 'claude']);
  assert.deepEqual([one.backend, two.backend, three.backend], ['opencode-http', 'codex-exec', 'agent-sdk']);
  assert.deepEqual(seen.sort(), ['claude', 'codex', 'opencode']);
  assert.equal(asJson(await call(claude, 'opencode_status', { jobId: one.id })).provider, 'opencode');
  assert.equal(asJson(await call(opencode, 'codex_list_jobs', {})).jobs[0].provider, 'codex');
  for (const [c, name] of [[claude, 'claude_start'], [claude, 'claude_status'], [opencode, 'opencode_status'], [claude, 'opencode_'], [claude, 'opencodex_start'], [claude, '__proto__']]) {
    const r = await call(c, name, { prompt: 'x', cwd: '/tmp', jobId: one.id });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /Unknown tool/);
  }
  assert.equal(seen.length, 3);
});

test('diagnostics reports the opencode service and client versions and unrecovered jobs', linux, async t => {
  const state = mkdtempSync(join(tmpdir(), 'bridge-xdg-')), directory = mkdtempSync(join(tmpdir(), 'bridge-diag-'));
  const xdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  const service = await startService({ directory, runner: async () => ({ status: 'completed' }) });
  t.after(async () => { if (xdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = xdg; await service.close(); rmSync(directory, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });
  const d = await new ServiceClient({ directory }).call('opencode', 'diagnostics');
  assert.equal(d.version, '0.4.0');
  assert.match(d.opencode.clientVersion, /^\d+\.\d+\.\d+/);
  assert.ok(['ready', 'unreachable', 'incompatible'].includes(d.opencode.status));
  assert.equal(d.opencode.status, 'unreachable');
  assert.equal(d.opencode.serviceVersion, null);
  assert.equal(typeof d.counts, 'object');
  assert.equal(typeof d.unrecovered, 'number');
  assert.ok(Array.isArray(d.worktrees.items));
  assert.equal(d.executables.claude.authentication, 'not_probed');
});

test('diagnostics asks the injected probe and reports its answer', linux, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-probe-'));
  const service = await startService({ directory, runner: async () => ({}), probeOpenCode: async () => ({ status: 'incompatible', serviceVersion: '3.0.0', clientVersion: '2.2.5' }) });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const d = await new ServiceClient({ directory }).call('claude', 'diagnostics');
  assert.deepEqual(d.opencode, { status: 'incompatible', serviceVersion: '3.0.0', clientVersion: '2.2.5' });
});

const never = name => new Proxy({}, { get: (_, key) => { throw new Error(`${name} must not be used: ${String(key)}`); } });
function probe({ discover = { url: 'http://x' }, info, ...rest } = {}) {
  const calls = [], signals = [];
  const service = { discover: async () => { calls.push('discover'); return discover; }, headers: () => undefined, get ensure() { throw new Error('diagnostics must never start a service'); } };
  const connect = () => { calls.push('connect'); return { server: { info: async options => { calls.push('info'); signals.push(options?.signal); return info(); } }, session: never('session'), config: never('config'), event: never('event') }; };
  return { calls, signals, run: openCodeProbe({ service, connect, ...rest }) };
}

test('the opencode probe reports ready for any 2.x service and never starts one', async () => {
  for (const version of ['2.0.0', '2.2.5', '2.99.1']) {
    const p = probe({ info: () => ({ version }) });
    const r = await p.run();
    assert.equal(r.status, 'ready', version);
    assert.equal(r.serviceVersion, version);
    assert.match(r.clientVersion, /^2\./);
    assert.deepEqual(p.calls, ['discover', 'connect', 'info']);
  }
});

test('the opencode probe reports anything but 2.x as incompatible, with the version it saw', async () => {
  for (const version of ['1.9.9', '3.0.0', '20.1.0', '0.0.1', 'dev', '', '2', '2.x', '2.', undefined, 2]) {
    const r = await probe({ info: () => ({ version }) }).run();
    assert.equal(r.status, 'incompatible', String(version));
    assert.equal(r.serviceVersion, typeof version === 'string' && version ? version : null);
  }
});

test('the opencode probe is unreachable without a service, on a failed or hung request, and never throws', async () => {
  const none = probe({ discover: null });
  const r = await none.run();
  assert.equal(r.status, 'unreachable');
  assert.equal(r.serviceVersion, null);
  assert.equal(typeof r.clientVersion, 'string');
  assert.deepEqual(none.calls, ['discover']);
  assert.equal((await probe({ info: () => { throw new Error('refused'); } }).run()).status, 'unreachable');
  const broken = openCodeProbe({ service: { discover: async () => { throw new Error('bad registration'); }, headers: () => undefined } });
  assert.equal((await broken()).status, 'unreachable');
  const started = Date.now();
  assert.equal((await probe({ info: () => new Promise(() => {}), timeoutMs: 50 }).run()).status, 'unreachable');
  assert.equal((await probe({ discover: new Promise(() => {}), timeoutMs: 50 }).run()).status, 'unreachable');
  assert.ok(Date.now() - started < 2000);
});

test('the opencode model accepts provider/model with an optional #variant for opencode only', () => {
  for (const model of ['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5#high', 'openrouter/meta/llama-3:free#max', 'a/b'])
    assert.equal(validateStart('opencode', { prompt: 'x', cwd: '/tmp', model }).model, model);
  for (const model of ['noprovider', '/b', 'a/', 'a/b#', 'a/#v', 'a/b#c#d', 'a/b#c/d', 'a b/c', 'a/b c', 'a/b\n', 'a/b;rm', 'a/b#' + 'v'.repeat(65), 'p'.repeat(65) + '/m', 7])
    assert.throws(() => validateStart('opencode', { prompt: 'x', cwd: '/tmp', model }), /Invalid model/, String(model));
});

test('claude and codex keep the strict model pattern', () => {
  for (const provider of ['claude', 'codex']) {
    for (const model of ['a/b', 'anthropic/claude-sonnet-4.5', 'a/b#high', 'claude-sonnet-4.5#x', 'a#b'])
      assert.throws(() => validateStart(provider, { prompt: 'x', cwd: '/tmp', model }), /Invalid model/, `${provider} ${model}`);
    assert.equal(validateStart(provider, { prompt: 'x', cwd: '/tmp', model: 'claude-sonnet-4.5' }).model, 'claude-sonnet-4.5');
  }
});

test('a provider/model#variant start reaches the opencode session as a model with a variant', async () => {
  const done = { type: 'session.execution.succeeded', data: { sessionID: 's1' } };
  for (const [model, expected] of [['anthropic/claude-sonnet-4.5#high', { providerID: 'anthropic', id: 'claude-sonnet-4.5', variant: 'high' }], ['anthropic/claude-sonnet-4.5', { providerID: 'anthropic', id: 'claude-sonnet-4.5' }]]) {
    const fake = fakeOpenCode(), jobs = new OpenCodeJobs(fake);
    const job = jobs.start({ prompt: 'x', cwd: process.cwd(), model });
    await tick();
    assert.deepEqual(fake.client.session.create.calls[0].model, expected);
    fake.emit(done);
    await jobs.wait(job.id); await jobs.shutdown();
  }
});

test('validateCall checks boolean arguments and rejects the ones a provider does not have', () => {
  for (const bad of [{ force: 'yes' }, { force: 1 }, { force: null }, { force: 'true' }, { force: [] }])
    assert.throws(() => validateCall('opencode', 'cancel', { jobId: 'j', ...bad }), /Invalid force/, JSON.stringify(bad));
  for (const bad of [{ discard: 'yes' }, { discard: 0 }]) assert.throws(() => validateCall('opencode', 'cleanup', { worktreeId: 'w', ...bad }), /Invalid discard/);
  assert.throws(() => validateCall('opencode', 'start', { prompt: 'x', cwd: '/tmp', worktree: 'yes' }), /Invalid worktree/);
  assert.doesNotThrow(() => validateCall('opencode', 'cancel', { jobId: 'j', force: true }));
  assert.doesNotThrow(() => validateCall('opencode', 'cancel', { jobId: 'j', force: false }));
  assert.throws(() => validateCall('claude', 'cancel', { jobId: 'j', force: true }), /Unknown argument: force/);
  assert.throws(() => validateCall('codex', 'cancel', { jobId: 'j', force: true }), /Unknown argument: force/);
});

// launch.js asks diagnostics with a 1000 ms client timeout; the probe must stay clearly inside it.
const READY_MS = 1000;
async function withRegistered(t, handler) {
  const state = mkdtempSync(join(tmpdir(), 'bridge-wedge-')), xdg = process.env.XDG_STATE_HOME;
  const server = handler.http ? httpServer(handler.http) : tcpServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  mkdirSync(join(state, 'opencode'));
  writeFileSync(join(state, 'opencode', 'service.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, version: '2.2.5' }));
  process.env.XDG_STATE_HOME = state;
  t.after(() => { if (xdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = xdg; server.closeAllConnections?.(); server.close(); rmSync(state, { recursive: true, force: true }); });
}

test('the default probe budget is clearly below the launcher readiness timeout', async () => {
  const p = probe({ info: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal((await p.run()).status, 'unreachable');
  assert.ok(Date.now() - started < READY_MS * 0.8, `took ${Date.now() - started} ms`);
  assert.equal(p.signals[0]?.aborted, true, 'the timed-out request is aborted, not left running');
});

test('a registered service that accepts connections but never answers does not slow diagnostics past the launcher timeout', linux, async t => {
  await withRegistered(t, {});
  const directory = mkdtempSync(join(tmpdir(), 'bridge-wedge-state-'));
  const service = await startService({ directory, runner: async () => ({}) });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const started = Date.now();
  const d = await new ServiceClient({ directory, timeoutMs: READY_MS }).call('claude', 'diagnostics');
  assert.equal(d.opencode.status, 'unreachable');
  assert.ok(Date.now() - started < READY_MS * 0.8, `took ${Date.now() - started} ms`);
});

test('a wedged opencode service does not stop any client from launching', linux, async t => {
  await withRegistered(t, {});
  const directory = mkdtempSync(join(tmpdir(), 'bridge-wedge-launch-'));
  const service = await startService({ directory, runner: async () => ({}) });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const me of ['claude', 'codex']) {
    const started = Date.now();
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/launch.js'), me], env: env({ BRIDGE_STATE_DIR: directory }), stderr: 'pipe' }));
    const names = (await client.listTools()).tools.map(x => x.name);
    await client.close();
    assert.ok(names.length > 0 && names.every(n => !n.startsWith(me + '_')), me);
    assert.ok(Date.now() - started < 5000, `${me} launch took ${Date.now() - started} ms`);
  }
});

test('a hung info request is aborted: the service sees its connection close', linux, async t => {
  let requests = 0; const closed = Promise.withResolvers();
  await withRegistered(t, { http: (req, res) => {
    if (++requests === 1) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '2.2.5', pid: process.pid, urls: [], paths: { tmp: '/tmp' } })); return; }
    req.on('close', () => closed.resolve(true));
  } });
  const started = Date.now();
  const r = await openCodeProbe()();
  assert.equal(r.status, 'unreachable');
  assert.ok(Date.now() - started < READY_MS * 0.8, `took ${Date.now() - started} ms`);
  assert.equal(requests, 2, 'discover answered and info was the hung request');
  assert.equal(await Promise.race([closed.promise, new Promise(res => setTimeout(res, 1500, false))]), true);
});

test('a registration run by the other client is reported as stale, only on a confident match', () => {
  assert.match(staleRegistration('claude', 'codex-mcp-client'), /registered as "claude".*Codex.*re-run/is);
  assert.match(staleRegistration('codex', 'claude-code'), /registered as "codex".*Claude Code.*re-run/is);
  assert.match(staleRegistration('opencode', 'claude-code'), /registered as "opencode"/);
  assert.equal(staleRegistration('codex', 'codex-mcp-client'), null);
  assert.equal(staleRegistration('claude', 'claude-code'), null);
  for (const name of ['opencode', 'Codex', 'codex', 'claude-code-extra', 'my-codex-mcp-client', 'inspector', '', '__proto__', 'constructor', undefined, null, 7, {}])
    assert.equal(staleRegistration('claude', name), null, String(name));
});

test('initialize warns once on stderr about a stale registration and never fails or changes its answer', async () => {
  const run = async (clientName, ...rest) => {
    const client = new Client({ name: clientName, version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp-client.js')], env: env({ BRIDGE_CLIENT: 'claude' }), stderr: 'pipe' });
    let text = ''; transport.stderr.on('data', d => { text += d; });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.length;
    await client.ping(); await client.close();
    return { text, tools };
  };
  const stale = await run('codex-mcp-client');
  assert.equal(stale.text.match(/stale/g)?.length, 1, stale.text);
  assert.match(stale.text, /re-run/i);
  assert.ok(stale.tools > 0);
  for (const same of ['claude-code', 'something-else', 'opencode']) assert.equal((await run(same)).text, '', same);
});
