---
name: agent-bridge
description: Delegate a task or request an independent review between Codex and Claude Code using the configured local MCP bridge.
---

# Codex–Claude bridge

Use the other agent for requested cross-agent collaboration, independent review or a task assigned to it. Ordinary tasks do not require delegation.

From Codex use claude-bridge: claude_start, claude_status, claude_events, claude_cancel, claude_list_jobs and claude_diagnostics. From Claude use codex-bridge: the corresponding codex tools except events. Codex is read-only; Claude uses Agent SDK.

Start with a concrete prompt, absolute cwd and a unique requestId. Save the returned job ID. Reuse the same requestId and arguments after an uncertain delivery; do not generate a new ID just because a response was lost. A deliberately new task gets a new key. Deduplication ends when the retained job expires.

queued and running are active states. Poll status at reasonable intervals; do not start another task to replace queued work. list_jobs returns paginated summaries (jobs, nextCursor, hasMore); status contains the full result. Claude events use jobId/after/limit; advance after with nextCursor. truncated means older events were evicted, not task failure.

The service runs in WSL for both Windows and Linux clients. Acceptable cwd values are Linux paths, local Windows drive paths and UNC paths for the configured distro. The service canonicalizes paths and serializes work per Git checkout and provider session. It does not coordinate independent terminals or agents outside the bridge.

Disconnecting a client does not stop service jobs. Service/WSL shutdown interrupts active work; after restart it appears interrupted. Inspect workspace changes before explicitly continuing with a new prompt and parentJobId (same cwd), or a known sessionId. Never blindly replay a task that might have edited files. If there is no session ID, explain that a new task cannot restore the prior conversation. Cancel requests do not release locks until cleanup; finishedAt confirms it ended.

Claude defaults to plan. acceptEdits permits SDK-authorized edits; additional permission prompts are denied and appear in permissionDenials. No interactive approval broker exists yet. maxTurns defaults to 50; optional maxBudgetUsd is estimated, not a billing guarantee. User/project hooks and rules still apply.

Defaults: four active jobs globally, 100 queued, 60-minute execution timeout; 1000 terminal jobs or 30 days of history. diagnostics reports service/queue/executable availability without inference; authentication is not probed. Queue-full is retryable with the same requestId after capacity becomes available; provider failures are not automatically retried.

Verify delegated findings and report evidence. Avoid sending secrets or requesting recursive delegation. Account quota is consumed. If only the older four-tool server is available, the client has not reloaded the persistent configuration; do not claim that its jobs survive disconnect.
