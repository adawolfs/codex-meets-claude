# Claude Agent SDK backend
The user selected the SDK backend after comparing CLI streaming with the SDK.
Replace direct Claude subprocess/JSON parsing with the official query API. Keep existing MCP tool names and the Codex backend.
Windows and WSL reuse their configured CLAUDE_COMMAND through pathToClaudeCodeExecutable.
Incremental SDK messages provide bounded progress and event pages. Capture session IDs on init/result and resume via options.resume.
Cancel/timeout through AbortController; close the Query. Incomplete or is_error results must never succeed.
Keep plan and acceptEdits. Deny extra approval requests and expose denials; no bypass or credential copying.
SDK owns session persistence. This is a backend migration, not a detached daemon: active jobs remain tied to the MCP process and shutdown cancels them.
