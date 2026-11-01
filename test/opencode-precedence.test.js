import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

// Pins how a delegated session's inline `permissions` combine with the user's
// opencode.json (global `edit` deny). Three small prompts to the default model,
// so it only runs on request. Measured on OpenCode 2.2.5 — see the task report.
const enabled = process.env.BRIDGE_LIVE_OPENCODE === '1';
const PROMPT = 'Use the write tool (not the shell, not any other tool) to create a file named precedence-probe.txt in the current directory containing exactly the text PROBE. Do nothing else.';
const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms).unref()),
]);

async function probe(client, dir, permissions, cleanups) {
  const session = await client.session.create({ location: { directory: dir }, ...(permissions ? { permissions } : {}) });
  const sessionID = session.id;
  // The client's abort signal does not close the event stream; only return() on the iterator does.
  const events = client.event.subscribe({})[Symbol.asyncIterator]();
  cleanups.push(async () => {
    await within(events.return(), 3000, 'closing the event stream').catch(() => {});
    await client.session.interrupt({ sessionID }).catch(() => {});
    await client.session.remove({ sessionID }).catch(() => {});
  });

  const names = new Map();
  const tools = [];
  const asked = [];
  const trace = [];
  const live = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const pump = (async () => {
    try {
      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        if (event.type === 'server.connected') live.resolve();
        const d = event.data;
        if (d?.sessionID !== sessionID) continue;
        if (!/delta|usage|instructions/.test(event.type)) trace.push(event.type === 'session.text.ended' ? `${event.type}: ${d.text}` : event.type);
        if (event.type === 'session.tool.input.started') names.set(d.id, d.name);
        if (event.type === 'session.tool.called') trace.push(JSON.stringify(d.input));
        if (event.type === 'session.tool.success') tools.push({ tool: names.get(d.id), ok: true });
        if (event.type === 'session.tool.failed') tools.push({ tool: names.get(d.id), ok: false, error: d.error?.message });
        if (event.type === 'permission.asked') {
          asked.push({ action: d.action, resources: d.resources });
          // Never 'always': that would persist an approval. An unanswered ask would hang the session.
          await client.permission.reply({ sessionID, requestID: d.id, decision: 'reject' }).catch(() => {});
        }
        if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) finished.resolve(event.type);
      }
    } catch (error) {
      live.reject(error);
      finished.reject(error);
    }
  })();
  pump.catch(() => {});

  // server.connected means the subscription is live, so no later event can be missed.
  await within(live.promise, 10000, 'event subscription to connect');
  await client.session.prompt({ sessionID, text: PROMPT });
  const outcome = await within(finished.promise, 45000, 'session to finish').catch(error => {
    throw new Error(`${error.message}: ${JSON.stringify({ permissions, tools, asked, trace })}`);
  });
  return { permissions: session.permissions, outcome, tools, asked, trace };
}

test('live OpenCode: session permissions override a global edit deny, and merge with it', { skip: !enabled, timeout: 420000 }, async t => {
  const endpoint = await Service.ensure();
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const cleanups = [];
  const dirs = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  await mkdir('/tmp/opencode', { recursive: true });
  async function project() {
    const dir = await mkdtemp('/tmp/opencode/precedence-');
    dirs.push(dir);
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] }));
    const config = await client.config.get({ location: { directory: dir } });
    assert.ok(config.some(e => e.path === join(dir, 'opencode.json')), 'the temporary opencode.json was not loaded as configuration');
    return dir;
  }
  const wrote = arm => arm.tools.filter(e => e.tool === 'write');
  // The default model is small and sometimes answers without calling the tool, or stalls. That is
  // inconclusive, never a pass: retry in a fresh project, and fail if no attempt is ever observed.
  async function arm(name, permissions) {
    const failures = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dir = await project();
      const result = await probe(client, dir, permissions, cleanups).catch(error => ({ error: error.message }));
      if (result.error || wrote(result).length === 0) {
        failures.push(result.error ?? `no write attempt: ${JSON.stringify(result)}`);
        continue;
      }
      return { ...result, dir };
    }
    assert.fail(`${name} arm inconclusive after 3 attempts: ${failures.join(' | ')}`);
  }

  // Control: the deny alone must take effect, and we must have seen the write attempt rejected.
  const control = await arm('control');
  assert.ok(wrote(control).every(e => !e.ok), `control: the global deny did not stop the write tool: ${JSON.stringify(control)}`);

  // Allow arm: a session-level edit allow overrides the global deny.
  const allowed = await arm('allow', [{ action: 'edit', resource: '*', effect: 'allow' }]);
  assert.ok(wrote(allowed).some(e => e.ok), `session allow did not override the global deny: ${JSON.stringify(allowed)}`);
  // The model may pick another file name or add a newline; what matters is that a file really landed.
  const created = (await readdir(allowed.dir)).filter(name => name !== 'opencode.json');
  assert.ok(created.length > 0, `write reported success but nothing was created: ${JSON.stringify(allowed)}`);
  assert.match(await readFile(join(allowed.dir, created[0]), 'utf8'), /PROBE/);

  // Unrelated arm: a session whose only rule is about `read` must neither widen nor drop the global edit deny,
  // i.e. session rules merge with the configuration rather than replacing it.
  const unrelated = await arm('unrelated', [{ action: 'read', resource: '*', effect: 'allow' }]);
  assert.ok(wrote(unrelated).every(e => !e.ok), `session permissions replaced the config ruleset instead of merging with it: ${JSON.stringify(unrelated)}`);
});
