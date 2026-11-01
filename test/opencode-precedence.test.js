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
const within = (promise, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

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
  // Either may reject before anything awaits it; the awaiting code below still sees the rejection.
  live.promise.catch(() => {});
  finished.promise.catch(() => {});
  const pump = (async () => {
    try {
      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        if (event.type === 'server.connected') live.resolve();
        const d = event.data;
        if (d?.sessionID !== sessionID) continue;
        if (!/delta|usage|instructions/.test(event.type)) trace.push(event.type === 'session.text.ended' ? `${event.type}: ${d.text}` : event.type === 'session.step.failed' ? `${event.type}: ${JSON.stringify(d.error)}` : event.type);
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

test('live OpenCode: session permissions override a global edit deny, and merge with it', { skip: !enabled, timeout: 560000 }, async t => {
  const endpoint = await Service.ensure();
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const cleanups = [];
  const dirs = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  await mkdir('/tmp/opencode', { recursive: true });
  async function project({ deny = true } = {}) {
    const dir = await mkdtemp('/tmp/opencode/precedence-');
    dirs.push(dir);
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ permissions: deny ? [{ action: 'edit', resource: '*', effect: 'deny' }] : [] }));
    const config = await client.config.get({ location: { directory: dir } });
    assert.ok(config.some(e => e.path === join(dir, 'opencode.json')), 'the temporary opencode.json was not loaded as configuration');
    return dir;
  }
  const wrote = arm => arm.tools.filter(e => e.tool === 'write');
  // The default model is small and sometimes answers without calling the tool, or stalls. That is
  // inconclusive, never a pass: retry in a fresh project, and fail if no attempt is ever observed.
  async function arm(name, permissions, projectOptions) {
    const failures = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dir = await project(projectOptions);
      const result = await probe(client, dir, permissions, cleanups).catch(error => ({ error: error.message }));
      if (result.error || wrote(result).length === 0) {
        failures.push(result.error ?? `no write attempt: ${JSON.stringify(result)}`);
        continue;
      }
      return { ...result, dir };
    }
    assert.fail(`${name} arm inconclusive after 3 attempts: ${failures.join(' | ')}`);
  }

  // A denied write must be the deny's doing: the tool is withheld ("No tool named"), with no permission prompt.
  const deniedByConfig = (name, result) => {
    assert.ok(wrote(result).every(e => !e.ok && /No tool named "write"/.test(e.error ?? '')), `${name}: write was not withheld by the global deny: ${JSON.stringify(result)}`);
    assert.deepEqual(result.asked, [], `${name}: a permission prompt fired, so the rejection was not the global deny: ${JSON.stringify(result)}`);
  };

  // Control: the deny alone must take effect, and we must have seen the write attempt rejected.
  const control = await arm('control');
  deniedByConfig('control', control);

  // Allow arm: a session-level edit allow overrides the global deny.
  const allowed = await arm('allow', [{ action: 'edit', resource: '*', effect: 'allow' }]);
  assert.ok(wrote(allowed).some(e => e.ok), `session allow did not override the global deny: ${JSON.stringify(allowed)}`);
  // The model may pick another file name or add a newline; what matters is that a file really landed.
  const created = (await readdir(allowed.dir)).filter(name => name !== 'opencode.json');
  assert.ok(created.length > 0, `write reported success but nothing was created: ${JSON.stringify(allowed)}`);
  assert.match(await readFile(join(allowed.dir, created[0]), 'utf8'), /PROBE/);

  // Unrelated arm: a session whose only rule is about `read` leaves the global edit deny fully in force
  // (same signature as the control: tool withheld, no prompt), i.e. session rules merge with the configuration.
  const readOnly = [{ action: 'read', resource: '*', effect: 'allow' }];
  const unrelated = await arm('unrelated', readOnly);
  deniedByConfig('unrelated', unrelated);

  // Positive control for the unrelated arm: the same read-only session without a config deny can write. So if the
  // session rules had replaced the configuration, the write above would have gone through (or asked), not been withheld.
  const ungated = await arm('ungated', readOnly, { deny: false });
  assert.ok(wrote(ungated).some(e => e.ok), `read-only session without a config deny could not write: ${JSON.stringify(ungated)}`);
});

// Model-free (no prompt reaches a model), so it costs no quota: the real service resolves the configuration and the
// agent, and the adapter creates a real session from them; its prompt is stubbed to fail before any inference.
test('live OpenCode, no model: configuration order, the effective agent and the session location the adapter relies on', { skip: !enabled, timeout: 60000 }, async t => {
  const { execFileSync } = await import('node:child_process');
  const { OpenCodeJobs } = await import('../src/opencode-jobs.js');
  const { levelRules } = await import('../src/opencode-levels.js');
  const live = await Service.discover();
  assert.ok(live, 'no OpenCode service is running; start one first');
  const real = OpenCode.make({ baseUrl: live.url, headers: Service.headers(live) });
  const sessions = [];
  const client = { ...real, session: { ...real.session, prompt: async () => { throw new Error('stubbed: no model in this probe'); } } };
  await mkdir('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/order-'), repo = join(root, 'repo'), pkg = join(repo, 'pkg');
  t.after(async () => {
    for (const sessionID of sessions) await real.session.remove({ sessionID }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(repo, '.opencode'), { recursive: true });
  await mkdir(pkg);
  execFileSync('git', ['init', '-q', repo]);
  const rule = (action, effect) => ({ action, resource: '*', effect });
  const files = {
    [join(root, 'opencode.json')]: { permissions: [rule('websearch', 'deny')], default_agent: 'plan', agents: { plan: { permissions: [rule('webfetch', 'deny')] } } },
    [join(repo, 'opencode.json')]: { permissions: [rule('websearch', 'allow')] },
    [join(pkg, 'opencode.json')]: { permissions: [rule('glob', 'deny')] },
    [join(repo, '.opencode', 'opencode.json')]: { permissions: [rule('grep', 'deny')] },
  };
  for (const [path, body] of Object.entries(files)) await writeFile(path, JSON.stringify(body));

  // Entries come lowest precedence first: the outer ancestor (above the git root, too), inner ones, then .opencode.
  const entries = await real.config.get({ location: { directory: pkg } });
  const order = entries.map(e => e.path).filter(p => p in files);
  assert.deepEqual(order, [join(root, 'opencode.json'), join(repo, 'opencode.json'), join(pkg, 'opencode.json'), join(repo, '.opencode', 'opencode.json')], JSON.stringify(entries.map(e => e.path)));
  // The agent's resolved rules carry those, in that order, then agents.<id>.permissions.
  const plan = (await real.agent.list({ location: { directory: pkg } })).data.find(a => a.id === 'plan');
  const mine = plan.permissions.filter(r => ['websearch', 'glob', 'grep', 'webfetch'].includes(r.action) && r.resource === '*');
  assert.deepEqual(mine, [rule('websearch', 'deny'), rule('websearch', 'allow'), rule('glob', 'deny'), rule('grep', 'deny'), rule('webfetch', 'deny')]);

  // The adapter runs the session as default_agent, bounded by that agent's rules, where it was asked to.
  const jobs = new OpenCodeJobs({ client, closeMs: 3000, drainMs: 100 });
  const view = await jobs.wait(jobs.start({ prompt: 'x', cwd: pkg, level: 'edit' }).id);
  assert.match(view.error ?? '', /stubbed/, JSON.stringify(view));
  sessions.push(view.sessionId);
  const session = await real.session.get({ sessionID: view.sessionId });
  assert.equal(session.agent, 'plan');
  assert.equal(session.location.directory, pkg);
  assert.deepEqual(session.permissions, levelRules('edit', { config: plan.permissions }));
  // A resume from another directory is refused before any prompt.
  const moved = await jobs.wait(jobs.start({ prompt: 'x', cwd: repo, sessionId: view.sessionId, level: 'edit' }).id);
  assert.match(moved.error, /Session works in/);
  await jobs.shutdown();
});
