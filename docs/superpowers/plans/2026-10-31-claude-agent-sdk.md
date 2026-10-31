# Claude Agent SDK implementation plan
Execution: executing-plans, test-driven-development, final independent review.
Spec: ../specs/2026-10-31-claude-agent-sdk-design.md
Architecture: ClaudeSdkJobs handles SDK lifecycle; JobManager routes Claude to it and retains Codex; server exposes bounded event pages.
Tech: Node >=20, pinned @anthropic-ai/claude-agent-sdk 0.3.316, node:test.

## Review focus
Cancellation races; incomplete or error results; bounded memory; malformed MCP input; Windows/WSL and Codex regressions.

## Tasks
- [x] SDK lifecycle tests RED/GREEN: progress, resume, denial, abort, timeout, bounds.
- [x] MCP event paging/input tests and implementation, full suite.
- [x] Real SDK smoke test in Windows/WSL, update documentation and installed skills/plugins.
- [x] Independent review, regression fixes, full verification.

## Ledger
No prior commits exist; existing files are untracked. Created codex/claude-agent-sdk without discarding existing work.
Installed SDK without optional native binaries: reuse local executables for the shared Windows/WSL checkout.

Independent review found a completion race: a result became visible before asynchronous iterator cleanup finished, rejecting immediate session continuation. Added a failing regression test, then deferred publication until cleanup completes. Regression now passes.

Final deterministic suite: 17 tests discovered, 16 passed, 1 opt-in live test skipped, 0 failed on native Windows and WSL. Includes Codex adapter regressions and MCP shutdown/input validation.
Real SDK smoke via the official MCP client passed separately on native Windows and WSL: initialization, streamed text events, successful result, same-session continuation and cancellation of an initialized query.

Updated package and both plugin manifests to 0.2.0. Updated standalone Codex skills and installed Codex/Claude plugins in Windows and WSL; SHA-256 matches the repository skill in all six installed copies. Existing MCP registrations retain valid executable paths. Clients need restart to load the updated backend and plugin.

Scope remains an SDK backend migration. Session persistence belongs to Claude; active jobs are process-bound, additional permission prompts are denied, and no standalone daemon or interactive approval broker was added.
