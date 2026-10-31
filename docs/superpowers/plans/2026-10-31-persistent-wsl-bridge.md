# Persistent WSL Bridge Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.
**Goal:** One supervised WSL coordinator, durable jobs and reconnectable MCP clients.
**Architecture:** SQLite Store + Coordinator with injected provider runner; private Unix HTTP API; thin MCP facade; systemd launcher/install/rollback.
**Tech Stack:** Node >=22.13, node:sqlite, existing Claude Agent SDK/Codex exec.
**Spec:** ../specs/2026-10-31-persistent-wsl-bridge-design.md

## Global Constraints
WSL first, container later. Preserve provider permissions, tool names and standalone entry for rollback. No replay of interrupted execution. Four active globally, 100 queued, one per project/session. 1000 terminal jobs or 30 days, 256 events/job. Runtime 60 minutes. No network port/secrets in diagnostics. Windows launch uses wsl.exe.

## Review Focus
Lost start response/idempotency across restart; cleanup after cancellation retaining locks; simultaneous clients and project aliases; service crash with live children; bounded memory/disk and malformed input.

## Tasks
### 1: Store and path mapping
Files: src/store.js, src/paths.js; test/store.test.js, test/paths.test.js.
Interfaces: Store({directory,maxHistory,maxAgeMs,maxEvents}); insert(provider,args,project), get(provider,id), update(id,patch), appendEvents(id,events), list(provider,{after,limit}), queued(), recover(), prune(), close(). resolveProject(cwd,{distro}) -> {cwd,project}.
- [x] RED: durable insert/reopen, scoped IDs, duplicate requestId same/different payload, interruption recovery, retention/pages, Windows/UNC paths and Git subdirs.
- [x] Implement transactional versioned SQLite, private directory and bounded events.
- [x] GREEN targeted tests and suite.

### 2: Queue and provider lifecycle
Files: src/coordinator.js, src/runner.js, src/claude-sdk-jobs.js, src/jobs.js; test/coordinator.test.js, test/runner.test.js.
Interfaces: Coordinator({store,runner,resolveProject,maxActive,maxQueued}); start(provider,args), status, list, events, cancel, shutdown. runner(provider,args,onUpdate,signal) -> final view.
- [x] RED: FIFO eligible/global limits/project/session locks, queued cancellation, cleanup lock, shutdown/recovery, explicit resume linkage, simulated load, input validation.
- [x] Implement durable queue and provider runner; persist final before exposing.
- [x] RED/GREEN per-message SDK bounds, bounded Codex JSONL parsing and process termination.
- [x] Run suite.

### 3: Service and reconnection
Files: src/service.js, src/client.js, src/mcp-client.js, src/persistent-tools.js; test/service.test.js.
- [x] RED: shared jobs across clients, facade disconnect, restart history, idempotent retries, malformed/oversized requests.
- [x] Implement bounded Unix HTTP API, private socket, async MCP facade, diagnostics.
- [x] GREEN integration and suite.

### 4: Supervision and installation
Files: src/launch.js, scripts/install-service.js, scripts/configure-clients.js, scripts/rollback-clients.js; test/install.test.js.
- [x] RED tests of systemd escaping and surgical config backup/restore.
- [x] Implement systemd user unit with process group cleanup/restart, bounded readiness, explicit executable paths.
- [x] Install service/update four bridge registrations with backups. Preserve old clients.
- [x] Verify reconnect/restart, Windows paths, real Claude disconnection/resume and Codex call.

### 5: Documentation and verification
Files: README.md, plugin/ manifests/skill, package metadata, test/soak.test.js.
- [x] Controlled load/soak, deterministic WSL suite and supported Windows tests, bounded real smoke.
- [x] Document recovery, limits, rollback, future container mounts; update installed plugins to 0.3.0.
- [x] Independent whole-change review, regression fixes, final verification.

## Ledger
User approved design and instructed proceed. Native execution continues without another checkpoint.
Ruling: Existing repository is unborn on codex/claude-agent-sdk with all previous work untracked. Continue in place and keep ledger here; no wholesale baseline commit or new worktree that would exclude existing work.
Baseline: npm test in WSL: 16 passed, 1 live skipped, zero failures.

Task 1 complete: durable store/path tests pass. Task 2 complete: queue/runner tests pass. Task 3 complete: official MCP facade reconnect and lost-response retry tests pass.
Task 4: service installed and ready; real WSL Claude disconnection/continuation and Codex call passed (16 seconds). Configuration migration pending final review.
Ruling: Use a separate SQLite exclusive transaction as service ownership lock; it releases on process death and prevents concurrent recovery/stale socket deletion.
Systemd WorkingDirectory quoting failed on real installation; reproduced with actual systemd-analyze parser regression, corrected, test now passes.
Controlled load: 1500 jobs, 1000 terminal retained, ~5.4 MB heap growth. Real temporary systemd service crash test confirms descendants killed, job interrupted and not replayed.
Final review identified five important findings. All reproduced RED then corrected GREEN: SDK actual child lifecycle tracking via spawnClaudeCodeProcess; Codex descendant cleanup before settling; prune on queued cancellation; original-request dedupe before parent/path lookup; indented TOML migration. No deferred minor findings.
Ruling: a process group that cannot be confirmed terminated causes service failure/recovery instead of releasing its project lock. This interrupts other active work but prevents overlap after unsafe cleanup.
Reviewer did not judge multi-hour real-provider reliability/authentication/billing, previous live test claims, actual global migration or future containers. These remain bounded by executed tests; future containers and multi-hour reliability are not claimed.
Windows initial config test failed with sandbox EPERM on a temporary .codex file; the same test passed with normal permissions. No product change for this sandbox restriction.
Final WSL deterministic suite after fixes: 39 passed, 3 opt-in skipped, zero failures.
Task 4 complete: four global MCP registrations migrated and parsed by the actual CLIs; Claude MCP health Connected in Windows and WSL. Stopped idle service and connected via real Windows Claude registration; service restarted automatically and is active.
Backups: /home/adawolfs/.agent-bridge-backups/1793486648772-133006c4-9244-4611-b420-4b84e426a087.json and C:/Users/adawolfs/.agent-bridge-backups/1793486651167-aac66be6-b6cc-466c-bd17-71e6962c7211.json. Use scripts/configure-clients.js rollback BACKUP with the respective platform's Node.
Task 5 complete: final deterministic suites WSL 39 passed/3 skipped; Windows 34 passed/8 platform or opt-in skips; no failures. Post-fix real WSL service Claude disconnect/resume and Codex call passed. Windows-to-WSL live smoke passed before cleanup fix; actual registered Windows MCP reconnection verified after fix. Controlled 60-second load: 10049 jobs, 1000 retained, ~4.6 MB heap growth. This is simulated workload, not multi-hour real-model endurance.
Plugins and standalone skills 0.3.0 installed in both platforms; all six installed skill copies match source SHA-256. No code review minors deferred. Container deployment and interactive approvals remain future scope.
