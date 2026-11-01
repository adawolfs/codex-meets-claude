import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

// Pins what happens when the user's opencode.json denies `edit` and a delegated
// session carries its own `edit` allow. It sends two small prompts to the
// default model, so it only runs on request.
//
// Measured on OpenCode 2.2.5: the session allow WINS. A global deny removes the
// `write` tool from the model's tool list; the same configuration plus a
// session-level allow restores it and the write succeeds. If this test starts
// failing, OpenCode changed precedence and the permission level model needs a
// second look.
const enabled = process.env.BRIDGE_LIVE_OPENCODE === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROMPT = 'Use the write tool (not the shell, not any other tool) to create a file named precedence-probe.txt in the current directory containing exactly the text PROBE. Do nothing else.';

async function probe(client, dir, permissions, cleanups) {
  const session = await client.session.create({ location: { directory: dir }, ...(permissions ? { permissions } : {}) });
  const sessionID = session.id;
  // The client's abort signal does not close the event stream; only return() on the iterator does.
  const events = client.event.subscribe({})[Symbol.asyncIterator]();
  cleanups.push(async () => {
    await events.return();
    await client.session.interrupt({ sessionID }).catch(() => {});
    await client.session.remove({ sessionID }).catch(() => {});
  });

  const names = new Map();
  const tools = [];
  const asked = [];
  void (async () => {
    try {
      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        if (event.data?.sessionID !== sessionID) continue;
        const d = event.data;
        if (event.type === 'session.tool.input.started') names.set(d.id, d.name);
        if (event.type === 'session.tool.success') tools.push({ tool: names.get(d.id), ok: true });
        if (event.type === 'session.tool.failed') tools.push({ tool: names.get(d.id), ok: false, error: d.error?.message });
        if (event.type === 'permission.asked') {
          asked.push({ action: d.action, resources: d.resources });
          // Never 'always': that would persist an approval. An unanswered ask would hang the session.
          await client.permission.reply({ sessionID, requestID: d.id, decision: 'reject' }).catch(() => {});
        }
      }
    } catch {}
  })();
  await sleep(500);

  await client.session.prompt({ sessionID, text: PROMPT });
  const deadline = Date.now() + 60000;
  let outcome;
  while (Date.now() < deadline) {
    outcome = (await client.session.get({ sessionID })).outcome;
    if (outcome) break;
    await sleep(500);
  }
  await sleep(500);
  return { session, outcome, tools, asked };
}

test('live OpenCode: a session-level edit allow overrides a global edit deny', { skip: !enabled, timeout: 170000 }, async t => {
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

  // Control: the deny alone must actually take effect, otherwise the probe below proves nothing.
  const controlDir = await project();
  const control = await probe(client, controlDir, undefined, cleanups);
  assert.ok(control.outcome, 'control session did not finish');
  assert.ok(!control.tools.some(e => e.tool === 'write' && e.ok), `control: the global deny did not stop the write tool: ${JSON.stringify(control)}`);

  const allowDir = await project();
  const rules = [{ action: 'edit', resource: '*', effect: 'allow' }];
  const allowed = await probe(client, allowDir, rules, cleanups);
  assert.deepEqual(allowed.session.permissions, rules);
  assert.ok(allowed.outcome, 'probe session did not finish');
  assert.ok(allowed.tools.some(e => e.tool === 'write'), `inconclusive: the model never attempted the write tool: ${JSON.stringify(allowed)}`);
  assert.ok(allowed.tools.some(e => e.tool === 'write' && e.ok), `session allow did not override the global deny: ${JSON.stringify(allowed)}`);
  assert.equal(await readFile(join(allowDir, 'precedence-probe.txt'), 'utf8'), 'PROBE');
});
