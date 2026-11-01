# OpenCode Peer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode a third bridge peer that both sends work to Claude and Codex and receives file-changing work from them, with live events, bridge-owned permission levels, and optional per-job git worktrees.

**Architecture:** A new `OpenCodeJobs` adapter mirrors `ClaudeSdkJobs`'s shape but drives the shared OpenCode service over HTTP (`@opencode/client`), draining `event.subscribe()` into the existing bounded event pages and answering `permission.asked` with `permission.reply`. The provider enum becomes a three-member set across tools, coordinator, store, launcher and diagnostics. A new worktree table outside the prune window owns worktree lifecycle, and `store.recover()` gains an abort step so an orphaned OpenCode session never leaves a lock to a queued job.

**Tech Stack:** Node >=22.13, plain ESM, `node --test`, `node:sqlite`, `@opencode/client` 2.2.x, existing Claude Agent SDK 0.3.316 and `codex exec`.

**Spec:** ../specs/2026-10-31-opencode-peer-design.md

## Global Constraints

- Node >= 22.13. Plain ESM JavaScript, no build step, `node --test`.
- Linux/WSL service only; state on the Linux filesystem, never `/mnt/`.
- Codex stays read-only and its adapter is unchanged. Claude's adapter is unchanged.
- Four active jobs globally, 100 queued, one active per project and per session/provider.
- 60-minute execution deadline, separate from queue wait.
- 1000 terminal jobs or 30 days; 256 events per job; 4 MB per message; pages of at most 100.
- No reasoning text and no tool arguments are stored.
- Secrets never appear in errors: `safeError` redaction stays on every path out of the service.
- Version 0.4.0 in `package.json`, MCP `serverInfo`, `coordinator.diagnostics()`, `plugin/plugin.json`, `.claude-plugin/marketplace.json`.
- Provider names are exactly `claude`, `codex`, `opencode`.
- Levels are exactly `read-only`, `edit`, `build`; the default when omitted is `read-only`.
- `permission.reply` decisions are only ever `reject`. Never `always`.
- Worktrees are never merged and never auto-removed when they contain changes.

## Review Focus

These are exercised by tests placed in the owning task:

1. A `permission.asked` event arriving after the job has settled, or on a resubscribed stream, must still be answered — an unanswered request hangs the delegate forever (Task 4).
2. `Service.ensure()` returning an endpoint that dies mid-job: the event stream ends with no result, which must fail the job rather than hang it (Task 4).
3. A worktree path that is itself inside another worktree, or a `cwd` that is already a worktree the bridge owns, must not produce two jobs sharing one lock identity (Task 6).
4. `opencode_cleanup` racing a still-running job that owns that worktree must refuse, not delete the tree under a live delegate (Task 6).
5. An OpenCode config containing JSONC comments must survive registration, or registration must refuse rather than silently strip them (Task 8).

---

### Task 1: Provider set and three-way tools

**Files:**
- Modify: `src/persistent-tools.js`
- Modify: `src/coordinator.js:5-19` (`validateStart`)
- Modify: `src/store.js:34-37` (`insert`, `backend` label)
- Test: `test/opencode-tools.test.js`

**Interfaces:**
- Produces: `PROVIDERS = ['claude','codex','opencode']` exported from `src/persistent-tools.js`; `toolsFor('opencode')` returning `opencode_start|status|cancel|list_jobs|diagnostics|events|cleanup`; `validateStart('opencode', input)` accepting `level`, `worktree`, and the shared fields.

- [ ] **Step 1: Write the failing test** in `test/opencode-tools.test.js`

```js
test('opencode tools expose start, events and cleanup with level and worktree', () => {
  const names = toolsFor('opencode').map(t => t.name);
  assert.deepEqual(names.sort(), ['opencode_cancel','opencode_cleanup','opencode_diagnostics','opencode_events','opencode_list_jobs','opencode_start','opencode_status'].sort());
  const start = toolsFor('opencode').find(t => t.name === 'opencode_start');
  assert.deepEqual(start.inputSchema.properties.level.enum, ['read-only','edit','build']);
  assert.equal(start.inputSchema.properties.worktree.type, 'boolean');
  assert.equal(toolsFor('codex').some(t => t.name === 'codex_events'), false);
  assert.equal(toolsFor('claude').some(t => t.name === 'claude_cleanup'), false);
});

test('opencode start input is validated and defaults to the safe level', () => {
  const ok = validateStart('opencode', { prompt: 'x', cwd: '/tmp' });
  assert.equal(ok.level, 'read-only');
  assert.equal(ok.worktree, false);
  assert.equal(validateStart('opencode', { prompt: 'x', cwd: '/tmp', level: 'build' }).level, 'build');
  for (const bad of [{ level: 'root' }, { level: 1 }, { worktree: 'yes' }, { permissionMode: 'plan' }, { maxBudgetUsd: 1 }])
    assert.throws(() => validateStart('opencode', { prompt: 'x', cwd: '/tmp', ...bad }));
  assert.throws(() => validateStart('claude', { prompt: 'x', cwd: '/tmp', level: 'build' }));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/opencode-tools.test.js`
Expected: FAIL — `toolsFor` throws `Invalid provider`.

- [ ] **Step 3: Implement the provider set**

Replace the two literal membership checks in `src/persistent-tools.js` with an exported `PROVIDERS` array. Add `level` (string enum) and `worktree` (boolean) to the start schema for `opencode` only, and give `opencode` both the `events` definition and a new `cleanup` definition (its schema is filled in by Task 6; for now `schema({}, [])`). Extend `validateCall`'s type switch with `boolean`.

In `coordinator.validateStart`, extend the allowed-key list per provider and validate `level` against the enum and `worktree` as a boolean, defaulting to `'read-only'` and `false`.

In `store.insert`, derive `backend` from a provider-to-label map: `claude → agent-sdk`, `codex → codex-exec`, `opencode → opencode-http`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/opencode-tools.test.js && npm test`
Expected: PASS, with no regression in the existing suite.

- [ ] **Step 5: Commit**

```bash
git add src/persistent-tools.js src/coordinator.js src/store.js test/opencode-tools.test.js
git commit -m "feat: add opencode to the provider set"
```

---

### Task 2: Verify session permission precedence against a real service

This task produces a written finding, not shipped code. Task 3 depends on its answer. It is first because building the level model on a wrong assumption wastes Tasks 3 and 4.

**Files:**
- Create: `test/opencode-precedence.test.js` (opt-in, skipped unless `BRIDGE_LIVE_OPENCODE=1`)

- [ ] **Step 1: Write the opt-in probe**

Against a real service from `Service.ensure()`, in a temporary directory with an `opencode.json` containing `{"permissions":[{"action":"edit","resource":"*","effect":"deny"}]}`, create a session with `permissions: [{action:'edit',resource:'*',effect:'allow'}]` and prompt it to write one file. Assert the file does **not** exist and the attempt was denied.

- [ ] **Step 2: Run it**

Run: `BRIDGE_LIVE_OPENCODE=1 node --test test/opencode-precedence.test.js`
Expected: PASS means global `deny` wins and Task 3 passes its level rules as-is. FAIL means session rules win.

- [ ] **Step 3: Record the finding in the plan's Ledger, naming which branch Task 3 takes**

If session rules win, Task 3's `levelRules` gains a second argument — the effective configuration from `config.get` — and never emits an `allow` for an action/resource the configuration denies.

- [ ] **Step 4: Commit**

```bash
git add test/opencode-precedence.test.js
git commit -m "test: pin opencode session permission precedence"
```

---

### Task 3: Permission levels

**Files:**
- Create: `src/opencode-levels.js`
- Test: `test/opencode-levels.test.js`

**Interfaces:**
- Consumes: the Task 2 finding.
- Produces: `LEVELS = ['read-only','edit','build']`; `levelRules(level, options?)` returning an array of `{action, resource, effect}`. `options.bridgeServerName` defaults to `'agent-bridge'`, so callers that do not rename the server pass nothing.

- [ ] **Step 1: Write the failing test**

```js
test('every level denies the bridge tools and answers every action', () => {
  for (const level of LEVELS) {
    const rules = levelRules(level, { bridgeServerName: 'agent-bridge' });
    assert.ok(rules.some(r => r.action.startsWith('agent_bridge') && r.effect === 'deny'));
    assert.ok(rules.some(r => r.action === '*' && r.resource === '*'));
  }
});

test('levels narrow monotonically', () => {
  const effect = (level, action) => resolve(levelRules(level), action, 'x');
  assert.equal(effect('read-only', 'edit'), 'deny');
  assert.equal(effect('read-only', 'read'), 'allow');
  assert.equal(effect('edit', 'edit'), 'allow');
  assert.equal(effect('edit', 'shell'), 'deny');
  assert.equal(effect('build', 'shell'), 'allow');
});

test('unknown levels are rejected', () => {
  assert.throws(() => levelRules('root'));
});
```

`resolve(rules, action, resource)` is a last-match-wins helper in the test file, mirroring OpenCode's documented matching.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/opencode-levels.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `levelRules(level, options) -> Array<{action,resource,effect}>` in `src/opencode-levels.js`**

Ordered, last match wins. Every level starts from a base that leaves no action unmatched, then denies the bridge's own MCP action, then narrows per level. `read-only` denies `edit` and `shell`; `edit` allows `edit` and denies `shell`; `build` allows both. `.env` reads are denied in every level rather than asked, since an `ask` only becomes a recorded denial.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/opencode-levels.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-levels.js test/opencode-levels.test.js
git commit -m "feat: add opencode permission levels"
```

---

### Task 4: The OpenCode adapter

The largest task. It mirrors `ClaudeSdkJobs`'s public surface exactly so `runner.js` can drive it unchanged.

**Files:**
- Create: `src/opencode-jobs.js`
- Create: `test/fake-opencode.js`
- Modify: `src/jobs.js:10-12` (provider routing)
- Modify: `src/runner.js:13-19` (event draining, today gated on `provider==='claude'`)
- Modify: `package.json` (add `@opencode/client` ^2.2.5)
- Test: `test/opencode-jobs.test.js`

**Interfaces:**
- Consumes: `levelRules` from Task 3.
- Produces: `class OpenCodeJobs` with the same methods `ClaudeSdkJobs` exposes — `start(request)`, `get(id)`, `status(id)`, `list()`, `wait(id)`, `events(id,{after,limit})`, `cancel(id)`, `shutdown()` — plus `view.openCode = { sessionId, endpoint }` on every snapshot. Constructor takes `{ client, service, timeoutMs, maxOutputBytes, maxEvents, maxConcurrent, maxJobs }`, where `client` and `service` are injectable for tests.
- `test/fake-opencode.js` exports `fakeOpenCode({ script })` returning `{ client, service, emit }` — `emit(event)` pushes onto the subscribed stream, letting tests drive timing the way the Claude tests drive their async generator.

- [ ] **Step 1: Write the failing tests**

```js
test('adapter streams progress, records the session and completes', async () => {
  const { client, service, emit } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'review', cwd: process.cwd(), level: 'edit' });
  emit({ type: 'session.created', sessionID: 's1' });
  emit({ type: 'message.part.updated', part: { type: 'text', text: 'working' } });
  await tick();
  assert.equal(jobs.status(job.id).status, 'running');
  assert.equal(jobs.status(job.id).openCode.sessionId, 's1');
  assert.equal(jobs.status(job.id).progress.text, 'working');
  assert.deepEqual(client.session.create.calls[0].permissions, levelRules('edit'));
  emit({ type: 'session.idle', sessionID: 's1' });
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'working');
});

test('permission requests are rejected and recorded, never left unanswered', async () => {
  const { client, service, emit } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'x', cwd: process.cwd() });
  emit({ type: 'session.created', sessionID: 's1' });
  emit({ type: 'permission.asked', sessionID: 's1', requestID: 'r1', action: 'shell', resource: 'rm -rf /' });
  await tick();
  assert.deepEqual(client.permission.reply.calls[0], { sessionID: 's1', requestID: 'r1', decision: 'reject' });
  assert.equal(jobs.status(job.id).permissionDenials[0].toolName, 'shell');
  // Arrives after the job settles; still answered.
  emit({ type: 'session.idle', sessionID: 's1' });
  await jobs.wait(job.id);
  emit({ type: 'permission.asked', sessionID: 's1', requestID: 'r2', action: 'edit', resource: 'a.js' });
  await tick();
  assert.equal(client.permission.reply.calls.length, 2);
});

test('a stream that ends without an idle result fails the job', async () => {
  const { client, service, emit } = fakeOpenCode();
  const jobs = new OpenCodeJobs({ client, service });
  const job = jobs.start({ prompt: 'x', cwd: process.cwd() });
  emit({ type: 'session.created', sessionID: 's1' });
  emit(null); // stream ends
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /ended without a result/);
});

test('cancel interrupts the session and cannot be overwritten by a late result', async () => { /* mirrors the Claude cancellation test; asserts client.session.interrupt called with s1 and final status cancelled */ });

test('timeout interrupts and reports timed_out', async () => { /* timeoutMs: 20 */ });

test('events are bounded, paged, and carry no reasoning or tool arguments', async () => {
  /* maxEvents: 5; emit a reasoning part and a tool part with arguments;
     assert truncated paging and that neither the reasoning text nor the
     arguments appear in JSON.stringify(status) or in any event */
});

test('oversized messages and excess concurrency are bounded', async () => { /* maxOutputBytes, maxConcurrent, mirroring the Claude test */ });

test('resume prompts the recorded session instead of creating one', async () => {
  /* start with sessionId: 's1'; assert session.create not called and
     session.prompt called with sessionID 's1' */
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/opencode-jobs.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `OpenCodeJobs` in `src/opencode-jobs.js`**

Follow `src/claude-sdk-jobs.js` closely: same validation-before-launch, same deferred launch so immediate cancellation is observed, same `record`/`view`/`events` split, same `bounded()` clamping, same settle-once discipline.

Per job: resolve the endpoint through the injected `service.ensure()`, subscribe to events **before** prompting so nothing is missed, `session.create({location:{directory: cwd}, agent, model, permissions: levelRules(level)})` or reuse `sessionId`, then `session.prompt({sessionID, text: prompt})`. Completion is the session going idle; cancellation and timeout call `session.interrupt`.

Map events onto the existing taxonomy — `session` (session id), `text` (assistant text deltas), `tool` (tool name only, never arguments), `permission_denied`, `finished`. Drop reasoning parts entirely. Filter the subscription to the job's own `sessionID`; a shared service carries the user's own sessions too.

Answer every `permission.asked` for an owned session with `reject`, including after settling, and keep a short-lived answered-request set so a resubscribed stream redelivering a request does not double-reply.

- [ ] **Step 4: Route the provider and drain its events**

In `src/jobs.js`, return `new OpenCodeJobs(...)` for `provider === 'opencode'`. In `src/runner.js`, change the `provider==='claude'` event-draining condition to a check for a manager that exposes `events`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/opencode-jobs.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/opencode-jobs.js src/jobs.js src/runner.js package.json package-lock.json test/opencode-jobs.test.js test/fake-opencode.js
git commit -m "feat: add the OpenCode HTTP adapter"
```

---

### Task 5: Orphaned-session recovery

**Files:**
- Modify: `src/store.js` (schema to `user_version=2`, session identity columns, `recover()`)
- Modify: `src/coordinator.js` (recovery hook)
- Test: `test/opencode-recovery.test.js`

**Interfaces:**
- Produces: `store.recover({ abortSession })` where `abortSession({provider, sessionId, endpoint}) -> Promise<boolean>`; rows that cannot be confirmed aborted stay `running` and keep their project.
- Consumes: the adapter's `view.openCode` from Task 4, persisted via a new allowed key in `store.update`.

- [ ] **Step 1: Write the failing test**

```js
test('recovery aborts an orphaned opencode session before releasing its lock', async () => {
  // Insert a running opencode job with openCode:{sessionId:'s1',endpoint:'http://x'}; reopen the store.
  const aborted = [];
  await store.recover({ abortSession: async s => { aborted.push(s); return true; } });
  assert.deepEqual(aborted, [{ provider: 'opencode', sessionId: 's1', endpoint: 'http://x' }]);
  assert.equal(store.get('opencode', id).status, 'interrupted');
});

test('an unconfirmed abort keeps the job running and its project locked', async () => {
  await store.recover({ abortSession: async () => false });
  assert.equal(store.get('opencode', id).status, 'running');
  assert.equal(store.queued().length, 0);
  // The coordinator must not start a queued job for that project.
});

test('claude and codex jobs recover without any abort call', async () => {
  const calls = [];
  await store.recover({ abortSession: async s => (calls.push(s), true) });
  assert.equal(calls.length, 0);
  assert.equal(store.get('claude', id).status, 'interrupted');
});

test('a store written by this version reopens at user_version 2', () => { /* migration from a v1 database preserves existing jobs and events */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/opencode-recovery.test.js`
Expected: FAIL — `recover()` takes no argument and ignores session identity.

- [ ] **Step 3: Implement**

Bump `user_version` to 2 with a migration that preserves v1 rows (`store.js` currently refuses anything above 1 — it must now accept 1 and upgrade it). Add `openCode` to `store.update`'s allowed keys so the adapter's session identity is persisted at start, not at finish.

`recover()` becomes async and takes `{ abortSession }`. For each `running` row with an `openCode` identity it awaits the abort; only a `true` return flips the row to `interrupted`. Rows left `running` keep their project out of the eligible set in `Coordinator.pump`, and `diagnostics()` reports their count so the state is visible.

The coordinator passes an `abortSession` that calls `session.interrupt` through a short-lived client at the recorded endpoint, treating an unreachable service as `false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/opencode-recovery.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/coordinator.js test/opencode-recovery.test.js
git commit -m "feat: abort orphaned opencode sessions before releasing locks"
```

---

### Task 6: Worktrees

**Files:**
- Create: `src/worktrees.js`
- Modify: `src/store.js` (worktree table, outside the prune window)
- Modify: `src/coordinator.js` (create on start, report and conditionally remove on finish, resume into the parent's worktree, `cleanup` action)
- Modify: `src/persistent-tools.js` (fill in `opencode_cleanup`'s schema)
- Modify: `src/service.js` (route the `cleanup` action)
- Test: `test/opencode-worktree.test.js`

**Interfaces:**
- Produces: `createWorktree({project, jobId}) -> {path, branch}`; `worktreeStatus(path) -> {dirty, changedFiles}`; `removeWorktree(path, {discard})`. Store: `putWorktree(row)`, `listWorktrees()`, `getWorktree(id)`, `deleteWorktree(id)` — never touched by `prune()`.
- `opencode_cleanup` input: `{worktreeId: string, discard?: boolean}`, reaching `Coordinator.cleanup(provider, {worktreeId, discard}) -> {worktreeId, removed}`.

- [ ] **Step 1: Write the failing tests**

```js
test('a worktree job refuses a dirty source checkout', async () => {
  // repo with an uncommitted change
  await assert.rejects(() => coordinator.start('opencode', { prompt: 'x', cwd: repo, worktree: true }), /uncommitted/);
});

test('a worktree job runs on its own branch and reports what changed', async () => {
  const view = await run({ worktree: true, write: 'a.js' });
  assert.match(view.worktree.branch, /bridge\//);
  assert.deepEqual(view.worktree.changedFiles, ['a.js']);
  assert.ok(existsSync(view.worktree.path));
});

test('a clean worktree is removed automatically; a dirty one is kept', async () => {
  const clean = await run({ worktree: true, write: null });
  assert.equal(existsSync(clean.worktree.path), false);
  assert.equal(store.listWorktrees().length, 0);
  const dirty = await run({ worktree: true, write: 'a.js' });
  assert.equal(existsSync(dirty.worktree.path), true);
  assert.equal(store.listWorktrees().length, 1);
});

test('cleanup refuses a dirty worktree without discard, and refuses a live one always', async () => {
  await assert.rejects(() => coordinator.cleanup('opencode', { worktreeId }), /discard/);
  // with a running job owning it:
  await assert.rejects(() => coordinator.cleanup('opencode', { worktreeId, discard: true }), /still running/);
  await coordinator.cleanup('opencode', { worktreeId, discard: true }); // after it finishes
  assert.equal(existsSync(path), false);
});

test('worktree records survive pruning of their job', () => {
  store.prune();            // with maxHistory 0
  assert.throws(() => store.get('opencode', jobId));
  assert.equal(store.listWorktrees().length, 1);
});

test('two worktree jobs on one repository run concurrently; in-place jobs still serialise', async () => { /* asserts both are active at once, and that two in-place jobs are not */ });

test('resume re-enters the parent worktree, and is rejected once it is gone', async () => {
  const child = await coordinator.start('opencode', { prompt: 'more', cwd: repo, parentJobId: parent.id });
  assert.equal(child.worktree.path, parent.worktree.path);
  removeWorktree(parent.worktree.path, { discard: true });
  await assert.rejects(() => coordinator.start('opencode', { prompt: 'more', cwd: repo, parentJobId: parent.id }), /worktree/);
});

test('a cwd that is already a bridge worktree does not alias its parent repository', async () => { /* the two jobs take different locks, and neither nests a worktree inside a worktree */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/opencode-worktree.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/worktrees.js` over plain `git worktree`**

Branch name `bridge/<jobId>`, created from the source `HEAD`, in a directory under the bridge's state directory rather than beside the user's repo. `worktreeStatus` uses `git status --porcelain`. `removeWorktree` refuses when the tree is dirty and `discard` is not set, and always deletes the branch alongside the tree so nothing dangles.

- [ ] **Step 4: Wire it into the coordinator**

Create before the job starts and after `resolveProject`, so the worktree's own toplevel becomes the lock identity. Store the row immediately, so a crash between creation and completion still leaves the worktree discoverable. On finish, read its status, write `worktree` onto the view, and remove it only when clean. `cleanup` refuses while any non-terminal job owns that worktree. Resume reads the parent's worktree from the table and rejects when it is absent.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/opencode-worktree.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worktrees.js src/store.js src/coordinator.js src/persistent-tools.js src/service.js test/opencode-worktree.test.js
git commit -m "feat: add per-job opencode worktrees"
```

---

### Task 7: Service surface, diagnostics and the launcher

**Files:**
- Modify: `src/service.js` (diagnostics, `cleanup` routing, version)
- Modify: `src/launch.js` (modes)
- Modify: `src/mcp-client.js` (serve several providers, `serverInfo` version)
- Test: `test/opencode-service.test.js`

**Interfaces:**
- Produces: `launch.js <client>` where `<client>` is `claude|codex|opencode|status`, serving the tool sets of the *other two* providers from one registration. `BRIDGE_CLIENT` replaces `BRIDGE_PROVIDER`; `mcp-client.js` derives its providers from it and dispatches by tool-name prefix.

- [ ] **Step 1: Write the failing test**

```js
test('each client is offered the other two providers and never itself', async () => {
  const names = await listTools('claude');
  assert.ok(names.every(n => !n.startsWith('claude_')));
  assert.ok(names.some(n => n.startsWith('codex_')) && names.some(n => n.startsWith('opencode_')));
});

test('a tool call is dispatched to the provider named by its prefix', async () => { /* opencode_status reaches the service as provider 'opencode' */ });

test('diagnostics reports the opencode service and client versions and unrecovered jobs', async () => {
  const d = await call('opencode', 'diagnostics');
  assert.equal(d.version, '0.4.0');
  assert.equal(typeof d.opencode.clientVersion, 'string');
  assert.ok(['ready','unreachable','incompatible'].includes(d.opencode.status));
  assert.equal(typeof d.counts.unrecovered, 'number');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/opencode-service.test.js`
Expected: FAIL — the launcher accepts one provider and serves only its own tools.

- [ ] **Step 3: Implement**

`launch.js` validates the client name and passes it on. `mcp-client.js` builds its tool list from the other two providers, and resolves each call's provider from the tool-name prefix, rejecting a prefix that is not one of its two.

Diagnostics gains an `opencode` block: the pinned client version, the running service version from `server.info()` when reachable, and a status of `ready`, `unreachable` or `incompatible` — a 2.x service is compatible, anything else is not. It still performs no inference and probes no authentication.

Bump the version string in `serverInfo`, `coordinator.diagnostics()` and `package.json` to 0.4.0.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/opencode-service.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service.js src/launch.js src/mcp-client.js package.json test/opencode-service.test.js
git commit -m "feat: serve two delegate tool sets per client"
```

---

### Task 8: Three-way registration

**Files:**
- Modify: `scripts/configure-clients.js`
- Modify: `scripts/install-service.js` (add `OPENCODE_COMMAND` to the unit environment)
- Test: `test/install.test.js` (extend)

**Interfaces:**
- Produces: `configureClients({home, platform, node, repo, distro})` additionally writing `mcp.servers['agent-bridge']` into `~/.config/opencode/opencode.json`, included in the same backup and rollback.

- [ ] **Step 1: Write the failing tests**

```js
test('registration adds the bridge to opencode and preserves unrelated config', () => {
  // existing opencode.json with $schema, plugins and an unrelated mcp server
  configureClients({ home, platform: 'linux', node: '/node', repo: '/repo' });
  const config = JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json')));
  assert.deepEqual(config.plugins, ['superpowers@git+https://github.com/obra/superpowers.git']);
  assert.equal(config.mcp.servers.other.command[0], 'keep');
  assert.ok(config.mcp.servers['agent-bridge']);
});

test('rollback removes only the bridge entry from all three clients', () => { /* unrelated later edits survive */ });

test('a JSONC config with comments is not silently stripped', () => {
  // opencode.jsonc containing comments
  assert.throws(() => configureClients({ home, ... }), /comment/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/install.test.js`
Expected: FAIL — no OpenCode target exists.

- [ ] **Step 3: Implement**

A third target alongside the TOML and JSON writers, using the same `atomic()` helper, the same concurrent-change detection, and one backup file covering all three entries. Detect comments before parsing and refuse rather than reformat — losing a user's comments is not recoverable by rollback. Note in the README that OpenCode reloads its config without a restart, unlike the other two.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/install.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/configure-clients.js scripts/install-service.js test/install.test.js
git commit -m "feat: register the bridge with opencode"
```

---

### Task 9: Live verification and documentation

**Files:**
- Create: `test/opencode-live.test.js` (opt-in behind `BRIDGE_LIVE_OPENCODE=1`)
- Modify: `README.md`
- Modify: `plugin/skills/agent-bridge/SKILL.md`
- Modify: `plugin/plugin.json`, `.claude-plugin/marketplace.json`

- [ ] **Step 1: Write the opt-in live test**

Against the real service: a `read-only` job that reports without writing; an `edit` job in a worktree that changes a file, reports its branch and changed files, and leaves the worktree behind; a cancellation mid-run; and a resume into the same session.

- [ ] **Step 2: Run the full deterministic suite and the live test**

Run: `npm test`
Expected: PASS, no failures, live tests skipped.

Run: `BRIDGE_LIVE_OPENCODE=1 node --test test/opencode-live.test.js`
Expected: PASS.

- [ ] **Step 3: Document**

README: the three levels and what each permits, the worktree option and its lifecycle, `opencode_cleanup`, the fact that a worktree with changes is never removed or merged automatically, the unrecovered-job state and how to clear it, and the OpenCode version coupling. The skill gains the same, in its own compressed register.

- [ ] **Step 4: Bump the manifests to 0.4.0 and verify the installed copies match**

- [ ] **Step 5: Commit**

```bash
git add README.md plugin .claude-plugin test/opencode-live.test.js
git commit -m "docs: document the opencode peer"
```

---

## Ledger

Design approved after amendment for session-level permissions. Task 2's finding is recorded here before Task 3 begins.
