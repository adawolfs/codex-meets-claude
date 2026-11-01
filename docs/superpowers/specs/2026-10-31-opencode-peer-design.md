# OpenCode as a third bridge peer

Status: design, pending approval.
Repository: codex-meets-claude (0.3.0).

## Intent and why

The bridge today has exactly two peers. Codex calls `claude_*` tools that run
the Claude Agent SDK; Claude calls `codex_*` tools that run `codex exec` in
read-only mode. Everything durable — queueing, locking, dedupe, history,
events — lives in one Linux/WSL service behind a Unix socket.

The user wants OpenCode in that picture as a full peer: it both **sends** work
to Claude and Codex, and **receives** work from them. Unlike Codex, OpenCode is
allowed to change files. The user wants to watch an OpenCode job while it runs,
not only read its result.

The why: OpenCode is the user's daily driver (v2.2.5, shared background
service). Delegation today is one-directional and read-only on the Codex side,
so the heavy, file-changing work can only be done by whichever agent the user
happens to be sitting in front of. Making OpenCode a peer means any of the
three can hand real implementation work to another and keep its own context
clean.

## Goals

- `opencode_*` tools, exposed to Claude and Codex, that queue durable jobs
  which may create, edit and delete files.
- Live progress from OpenCode jobs through the existing bounded event pages,
  the same mechanism `claude_events` already uses.
- OpenCode as a caller: its config gains the bridge so it can use `claude_*`
  and `codex_*`.
- A configured permission boundary that applies by default, plus an optional
  per-job level that selects among sanctioned levels.
- A per-job option to run in a dedicated git worktree so two delegated jobs can
  work the same repository in parallel.
- Everything the existing providers already guarantee: durability across
  service restarts, requestId dedupe, cancellation, per-project locking,
  bounded memory and storage.

## Non-goals

- Changing the Claude or Codex adapters' behaviour. Codex stays read-only.
- Interactive permission approval. A job that needs a human decision fails or
  records a denial; it never waits for one.
- Automatic merging of worktree results into a branch the user cares about.
- Supporting OpenCode v1. The target is v2 (2.2.x) only.
- A containerised deployment. Still out of scope, as in 0.3.0.

## Anti-goals

Things that would make this a failure even if it technically worked:

- **Losing a delegate's work.** An auto-removed worktree containing twenty
  minutes of edits is unrecoverable. Every other failure in this system is
  recoverable; this one is not.
- **A job that hangs.** OpenCode's permission model defaults to `ask` when no
  rule matches, and `ask` with no interactive client never resolves. A
  bridged job that silently waits forever is worse than one that fails.
- **Delegation loops.** An OpenCode job that can call `claude_*`, which calls
  `opencode_*`, consumes quota and locks without bound.
- **A permission escape.** The bridge must never be a way to exceed the
  boundary the user configured in OpenCode.

## Constraints

Discovered, not chosen:

- **OpenCode v2 only.** The two existing community MCP servers
  (`AlaeddineMessadi/opencode-mcp`, `alejandro-technology/opencode-mcp`) both
  target OpenCode 1.x; the v2 server API is an intentional breaking change.
  Neither is reusable. They did confirm the overall shape: HTTP API, sessions,
  programmatic permission answers, async start plus poll.
- **`deny` always wins.** Configured deny rules and policies override anything
  the bridge passes. A per-job level can narrow, never widen.
- **No `ask` may survive.** Every rule a bridged job hits must resolve to
  `allow` or `deny` before it runs.
- **Version coupling.** `@opencode/client` is published per OpenCode version
  (2.2.5 at time of writing). The bridge's pinned client should track the
  user's OpenCode.
- **Linux/WSL service.** State lives on the Linux filesystem; the service
  refuses `/mnt/` state directories. Unchanged.
- **Node >= 22.13, no build step.** The repo is plain ESM JavaScript with
  `node --test`. The new adapter follows suit.
- **Provider is currently a two-value enum** in `persistent-tools.js`,
  `coordinator.validateStart`, `jobs.js`, `launch.js`, the diagnostics branch
  of `service.js`, and `store.insert`'s backend label.

## Approaches

Three ways to build the receiving side were considered.

**A. Shell out to `opencode run --format json`.** Mirrors the existing Codex
adapter exactly; no new dependency. Rejected: stdout carries a final JSON
document, not an incremental stream, so it cannot deliver the live visibility
the user asked for.

**B. Drive the shared background service over HTTP (chosen).** Use
`@opencode/client` with `@opencode/client/service`. `Service.ensure()` finds or
starts the same service the TUI uses; `session.create` plus `session.prompt`
run the job; `event.subscribe()` is a live async iterable the adapter drains
into the existing bounded event pages. Permission requests arrive as events the
bridge answers programmatically. Delegated sessions are real sessions on the
user's service, so the user can open one in their own TUI and watch it there
too. Trades off isolation: bridge jobs share a process with the user's
interactive work, and the pinned client tracks the user's OpenCode version.

**C. Spawn a private `opencode serve` per job.** Full isolation and clean
kills, reusing `process-tree.js`. Rejected: the user's TUI cannot see those
sessions, per-job server startup is paid on every job, and port and lifetime
management must be hand-rolled — which is exactly what `Service.ensure()`
already solves.

**Chosen: B**, with the per-job worktree option (below) recovering most of the
isolation that C would have provided.

## Decisions

### Provider becomes a set

`'claude' | 'codex'` becomes a three-member set. Tool definitions, start-input
validation, backend routing, the launcher's mode argument, the diagnostics
executable block and the stored `backend` label all derive from it.

The events tool, today Claude-only, extends to OpenCode. Codex keeps no events
tool — its backend produces none.

### Each client sees the other two

Claude gets `codex_*` + `opencode_*`; Codex gets `claude_*` + `opencode_*`;
OpenCode gets `claude_*` + `codex_*`. No client sees its own tools.

`launch.js` today takes one provider name and `mcp-client.js` serves exactly
one tool set. Builder's call: either a launcher mode that serves several
providers from one MCP registration, or one registration per delegate per
client. The first keeps the registration count at one per client; the second
keeps `mcp-client.js` unchanged. Either is acceptable; prefer the one that
leaves the tool-name prefix check intact and honest.

### Permission levels

The boundary lives in the user's OpenCode configuration, not in this
repository. It consists of top-level rules that apply to everything, plus three
named agents that are the levels:

| Level | Meaning |
|-------|---------|
| read-only | may read, search and report; no edits |
| edit | may change files; no shell |
| build | full working agent, within the user's top-level rules |

`opencode_start` takes an optional level. The bridge maps it to that agent and
runs with every rule resolved up front, so nothing reaches `ask`. Omitting the
level uses the configured default. Naming a level that does not exist fails the
job immediately rather than running with more or less rope than intended.

Permission denials are recorded on the job view and surfaced as events, exactly
as the Claude adapter already does with `permissionDenials`.

**Who writes the agents.** The user's OpenCode config today has no permission
rules and no agents, so the levels do not exist yet. The installer writes a
starter set — the three agents, their rules, and the loop-guard denial — into
`~/.config/opencode/opencode.json`, which the user is then free to retune. This
means `configure-clients.js` owns part of the user's security boundary, so the
same discipline applies to the `agent` and `permission` keys as to
`mcp.servers`: write only the bridge's own entries, back up exactly those
entries, and refuse to overwrite later user changes to them. The bridge also
validates at job start — a level naming an agent that is absent fails
immediately rather than falling back to a default with different rope.

The starter rules are a documented default, not a security claim. The user's
own top-level rules and policies remain the ceiling.

Note for the builder: the Claude adapter answers approval requests through the
SDK's `canUseTool` callback. The OpenCode equivalent arrives over the event
stream and is answered through the API. The policy is the same — deny, record,
continue — but the plumbing is not shared.

### Loop guard

A delegated OpenCode job must not be able to call the bridge. The existing
peers already do this: the Claude adapter sets
`disallowedTools: ['mcp__*']`, and Codex launches with
`mcp_servers.claude-bridge.enabled=false`. For OpenCode the equivalent is
denying the bridge's MCP tool actions in each bridge agent. The user keeps
those tools when driving OpenCode themselves; only the delegate loses them.

### Worktrees

`opencode_start` takes an optional per-job flag to run in a dedicated git
worktree on a fresh branch named for the job, rather than in place.

Lifecycle:

- **Create** on start, branching from the source checkout's `HEAD`. Default
  remains in-place; worktrees are opt-in per job.
- **Refuse a dirty source checkout.** If the user asked for a worktree and the
  source has uncommitted changes, the job fails before starting, naming the
  dirty files. Branching from `HEAD` would hand the delegate stale code and
  return a diff against something the user is not looking at; carrying the
  changes across would mean touching the user's index, which is the thing
  worktrees exist to avoid. Failing fast is the only option that neither lies
  nor reaches into the user's working tree.
- **Report** on finish: the result carries the branch, the worktree path, and
  the list of changed files, so the caller can say where the work is without
  reading the repository.
- **Auto-remove only a provably clean tree** — the job failed, was cancelled,
  or changed nothing. There is nothing to lose, and this is what prevents
  accumulation.
- **Never auto-remove anything with changes.** Removal is an explicit
  `opencode_cleanup` call that refuses a dirty worktree without an explicit
  discard flag.
- **Never merge.** Not by the bridge, not by the delegate. The user merges, or
  hands the merge to a later job as its own prompt.

This interacts with locking in a useful way: the coordinator locks per git
toplevel and `resolveProject` resolves a worktree to its own toplevel, so two
worktree jobs on the same repository take different locks and run in parallel,
while in-place jobs still serialise.

**Worktrees outlive their jobs.** `store.prune()` drops terminal jobs at 1000
records or 30 days, after which `store.get` throws `job not found`. If worktree
state lived only in the job view, an uncleaned worktree would become invisible
and unremovable through the tool — orphaned on disk, which is the neglect form
of the losing-work anti-goal. So worktree state gets its own table, outside the
prune window, with a `user_version` bump and a migration (`store.js` currently
hard-refuses any version above 1). `opencode_cleanup` takes the worktree
identity, not a jobId, and a companion listing surfaces every worktree the
bridge still owns so abandoned ones are discoverable. Diagnostics reports the
count.

**Resume honours the parent's worktree.** `coordinator.start` enforces
`parent.cwd === cwd` on resume, and `store.update`'s allowlist deliberately
refuses to rewrite `cwd`. A worktree job's stored `cwd` therefore stays the
original path. Resume re-enters the parent's worktree, read from the worktree
table rather than from `cwd`, and is rejected outright if that worktree no
longer exists. The alternative — silently resuming a writing job in the wrong
directory — is unacceptable.

### Recovery: the delegate outlives the bridge

This is the one invariant approach B breaks. Claude and Codex jobs are children
in the bridge's own process tree — `process-tree.js`, `cleanupProcessGroup`,
the detached process-group kill — so killing the bridge kills the work. An
OpenCode session runs inside a shared daemon the bridge did not start and
cannot kill by killing itself.

Today `store.recover()` marks `running` jobs `interrupted` at startup, which
releases their project lock. For OpenCode that would release a lock while a
live delegate is still editing the checkout, and the next queued job for that
project would start immediately — two agents, one working tree.

So the adapter persists the OpenCode session ID and the service endpoint at
start, and recovery aborts those sessions before releasing their locks. If the
service is unreachable, the job stays interrupted and its lock is not handed
on until the abort can be confirmed; the failure is reported rather than
assumed away.

### Version compatibility

`@opencode/client` publishes in lockstep with OpenCode. The bridge pins a 2.x
client and accepts any 2.x service, using `Service.ensure()`'s version
predicate rather than demanding an exact match — patch releases are frequent
and an exact pin would break the bridge on every OpenCode upgrade.
`opencode_diagnostics` reports both the pinned client version and the running
service version, so a mismatch presents as a readable diagnostic instead of
mysterious RPC failures.

### What a writing delegate changes elsewhere

- The per-project lock stops being only about session safety and becomes the
  thing that keeps two agents from editing one checkout at once.
- `interrupted` recovery gets teeth. A job killed mid-run may have left
  half-finished edits. The existing rule — never auto-resume, inspect first —
  already covers this and must stay prominent in the skill and README.

### Registration

`configure-clients.js` grows a third target: OpenCode's `mcp.servers` in
`~/.config/opencode/opencode.json`. It keeps the current discipline — write
only the bridge's own entries, atomic temp-file rename, concurrent-change
detection, a backup of exactly the affected entries under
`~/.agent-bridge-backups`, and a rollback that refuses to overwrite later
changes to those entries.

Two notes for the builder. OpenCode's config is JSON/JSONC and may legitimately
contain comments; the writer must not destroy them or must refuse to proceed
when it would. And OpenCode watches its config and reloads without a restart,
unlike the other two clients.

### Version

This is a feature release: 0.4.0 across `package.json`, the MCP `serverInfo`,
`coordinator.diagnostics()`, the plugin manifests and the marketplace catalog.

## Left to the builder

- Whether one MCP registration per client serves several providers, or one
  registration per delegate (see above).
- Event taxonomy for OpenCode: which v2 event types map onto the existing
  `text` / `tool` / `session` / `permission_denied` shapes, and what gets
  dropped. Keep the existing bounds — 256 events per job, 4 MB per message,
  pages of at most 100 — and keep reasoning and tool arguments out of storage.
- How `Service.ensure()` failure is reported in `opencode_diagnostics`
  alongside the existing executable probes, which deliberately do not test
  authentication.
- Worktree creation mechanics: OpenCode's v2 worktree endpoints versus plain
  `git worktree`. Plain git is likely simpler and keeps the bridge's locking
  story self-contained, but either is acceptable.
- The exact starter permission rules for the three agents, within the stated
  meanings.
- The worktree table's columns and the shape of `opencode_cleanup`'s input,
  given that it is keyed on worktree identity rather than jobId.
- Whether the OpenCode adapter's per-job timeout differs from the shared
  60-minute execution deadline.
- Test shape, following the existing suite: deterministic tests with a fake
  OpenCode server for lifecycle, cancellation, permission denial, event
  bounds, worktree create/cleanup and the three-way registration writer; the
  live, quota-consuming test stays opt-in behind an environment flag.

## Open questions for the user

None outstanding. Settled in conversation: direction (both send and receive),
write capability, the level model and its three levels, live visibility,
worktree lifecycle, who writes the permission agents, and dirty-checkout
behaviour.

Settled by the author after an independent builder review, and worth the
user's attention: orphaned-session recovery, the worktree table outside the
prune window, resume re-entering the parent's worktree, and 2.x version
compatibility rather than an exact pin.
