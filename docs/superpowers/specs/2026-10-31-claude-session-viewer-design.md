# Claude Code terminal session viewer
Status: proposed for approval. User selected Claude Code terminal CLI.
Date: 2026-10-31

## Purpose and approach
Extend the existing agent-bridge Claude Code plugin with a native pane opened by /bridge-sessions, showing Claude sessions launched through codex-meets-claude. Service stays in WSL; clients may run in Windows or WSL.
The selected surface is terminal CLI. Proposed implementation is a Claude Code mod: installed version 2.1.316 supports this (minimum 2.1.287). A text-only skill cannot provide the same refreshable interface without model turns. A separate browser dashboard adds another interface and server without serving the requested terminal experience. No browser dashboard or separate IDE extension in this delivery.

## User experience
- /bridge-sessions opens the pane; Escape closes it.
- List recent bridge Claude sessions, active first, with project, latest status, last activity and a short title from the first retained prompt.
- All-projects scope by default, current-project filter, active/history filter, manual refresh and refresh every three seconds while open. No overlapping requests or polling after close/session teardown.
- Select a session to inspect retained turns chronologically: prompts, results, latest live progress, errors and job/session IDs.
- Queued jobs without session IDs appear as pending tasks; multiple jobs with one Claude session ID group into one session once initialized.
- Paginate and bound long text; indicate omitted/truncated history. Show loading, empty, stale and unavailable states.
- Read-only: viewing never starts inference, submits prompts, resumes, cancels or changes permissions.

The pane covers retained bridge history (1000 terminal jobs or 30 days), not unrelated native Claude sessions. No internal reasoning or tool arguments. Full native transcripts and interactive takeover are future scope. This is inspection, not attaching a second agent to an active session.

## Data and API
The service database is the source of truth. The plugin does not scan arbitrary Claude directories or open SQLite directly.
Add explicit read-only MCP tools bridge_list_sessions and bridge_session_details to Claude Code's existing codex-bridge connection. They deliberately inspect provider=claude bridge records. Existing provider-scoped status/start/cancel behavior remains unchanged.
Use the documented mods MCP API, avoiding hardcoded local paths and a new TCP listener.
List entries: opaque session key (session ID or pending job ID), nullable sessionId, title, cwd/project, latest status/activity, active flag and retained turn count. Bounded pages include retention information.
Details return bounded chronological turn pages, with prompt/result/progress/error and dates. Reject unknown keys and invalid cursors; no credentials/environment/arbitrary file access.
Any queued/running turn makes its session active; otherwise show the latest retained turn's status. Cancel-requested remains active until cleanup.
Project filtering uses the existing canonical project resolver, including Windows/WSL conversion.

## Plugin
Add hooks/hooks.json and a hooks module to the existing plugin. Register /bridge-sessions as an immediate command. Draw only this pane and leave other commands and render sites untouched.
Use native Text/Box/Button/Input elements with stable keys, keyboard controls and a usable narrow layout.
Treat prompts/output as untrusted display text; never execute or submit them to a model.
If codex-bridge is absent or too old, show an actionable connection/version message. Do not silently reconfigure unrelated servers.
Keep Claude-specific mod code separate from the generic Codex skill.

## Delivery and verification
Proposed version 0.4.0 for service/plugin. Update documentation and installed Claude plugins on both systems. Preserve skills/config. Restart the service only with no active/queued jobs; otherwise stage the update and report the pending reload.
Backend tests: grouping, retention, pagination, project filtering, pending transitions, input/response limits, explicit read-only access and delegation regressions.
Use claude plugin validate and claude plugin test for real command registration/rendering/selection/refresh/close cleanup and unavailable service. Stub only external reads in mod tests.
Smoke-test against the installed service without paid inference. Separately report any native terminal rendering behavior not directly observed.
No automatic push or main update is included in this feature request.

## Choices left to implementer
Element arrangement, module boundaries, cursor encoding and helper names. Follow existing service conventions. If mods cannot run in the target configuration, report the concrete limitation before substituting another interface.

## Sources
https://code.claude.com/docs/en/plugins/mods/overview
https://code.claude.com/docs/en/plugins/mods/interface
https://code.claude.com/docs/en/plugins/mods/api
https://code.claude.com/docs/en/plugins/mods/test

