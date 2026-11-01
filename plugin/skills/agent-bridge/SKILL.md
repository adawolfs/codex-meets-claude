---
name: agent-bridge
description: Delegate a task or request an independent review between Claude Code, Codex and OpenCode using the configured local MCP bridge.
---

# Claude–Codex–OpenCode bridge

Use another agent for requested cross-agent collaboration, independent review or a task assigned to it. Ordinary tasks do not require delegation.

Each client is offered the other two providers' tools: Claude gets codex_* and opencode_*, Codex gets claude_* and opencode_*, OpenCode gets claude_* and codex_*. Per provider: start, status, cancel, list_jobs, diagnostics, and events (claude and opencode only; codex has none). opencode also has cleanup. Codex is read-only; Claude uses Agent SDK; OpenCode uses its local HTTP service.

Start with a concrete prompt, absolute cwd and a unique requestId. Save the returned job ID. Reuse the same requestId and arguments after an uncertain delivery; do not generate a new ID just because a response was lost. A deliberately new task gets a new key. Deduplication ends when the retained job expires.

queued and running are active states. Poll status at reasonable intervals; do not start another task to replace queued work. list_jobs returns paginated summaries (jobs, nextCursor, hasMore); status contains the full result. Claude events use jobId/after/limit; advance after with nextCursor. truncated means older events were evicted, not task failure.

The service runs in WSL for both Windows and Linux clients. Acceptable cwd values are Linux paths, local Windows drive paths and UNC paths for the configured distro. The service canonicalizes paths and serializes work per Git checkout and provider session. It does not coordinate independent terminals or agents outside the bridge.

Disconnecting a client does not stop service jobs. Service/WSL shutdown interrupts active work; after restart it appears interrupted. Inspect workspace changes before explicitly continuing with a new prompt and parentJobId (same cwd), or a known sessionId. Never blindly replay a task that might have edited files. If there is no session ID, explain that a new task cannot restore the prior conversation. Cancel requests do not release locks until cleanup; finishedAt confirms it ended.

Claude defaults to plan. acceptEdits permits SDK-authorized edits; additional permission prompts are denied and appear in permissionDenials. No interactive approval broker exists yet. maxTurns defaults to 50; optional maxBudgetUsd is estimated, not a billing guarantee. User/project hooks and rules still apply.

Defaults: four active jobs globally, 100 queued, 60-minute execution timeout; 1000 terminal jobs or 30 days of history. diagnostics reports service/queue/executable availability without inference; authentication is not probed. Queue-full is retryable with the same requestId after capacity becomes available; provider failures are not automatically retried.

OpenCode: start takes level (read-only default, edit, build), worktree and model (providerID/modelID[#variant]; default is the user's model). read-only allows read, glob, grep and skill and denies everything else; edit adds edit; build allows all, shell and network included, except subagents. read-only and edit deny shell because a redirect writes files without the edit tool. Every level denies subagent, agentbridge_*, question, external_directory and .env reads (except .env.example); unanswered permission requests are rejected and listed in permissionDenials. The user's OpenCode config narrows a level: a level never widens past a config deny, and a config ask counts as allow in the replay, never granting more than the level does. Resume (parentJobId or sessionId) only bridge-created sessions, at the same level they were created with: repeat level, since the default is read-only. A session works where it was created, so resume it from the same cwd; a bare sessionId follows the job that last ran it, worktree included. The bridge never starts OpenCode: if no OpenCode service is running, the job fails asking the user to start it.

worktree:true runs the job in its own git worktree from HEAD (branch bridge/<jobId>); refused on a dirty source checkout or a non-repository. The result reports worktree {id, branch, path, changedFiles (at most 200; an ignored directory is one entry), changedCount, truncated, removed}; list_jobs omits changedFiles. It is removed on completion only when provably clean; a worktree with work is never removed or merged automatically, so review the branch and merge it yourself. opencode_cleanup {worktreeId, discard} removes it explicitly: refused while a job uses it, and with changes or commits unless discard:true. Resuming via parentJobId or that job's sessionId reuses the worktree.

An OpenCode job whose abort could not be confirmed stays held: it keeps its project and session, diagnostics.unrecovered counts it, and nothing new runs there. opencode_cancel retries the abort and releases it on confirmation (or when the service reports no such session). force:true releases it without proof and records interrupt:'forced'; the delegate may still be editing, so use it only when sure. diagnostics.opencode reports status, serviceVersion and clientVersion: the client is a pinned 2.x and any 2.x service is accepted.

Verify delegated findings and report evidence. Avoid sending secrets or requesting recursive delegation. Account quota is consumed. If only the older four-tool server is available, the client has not reloaded the persistent configuration; do not claim that its jobs survive disconnect. After upgrading to 0.4.0 the clients must be registered again with scripts/configure-clients.js: the launcher argument now names the client, so a stale registration offers a client its own tools (a stderr warning appears on initialize for Claude Code and Codex). OpenCode applies config changes without a restart: it watches its config files and reloads after a save (/reload forces it).
