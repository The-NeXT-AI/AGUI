---
title: Providers
description: Configure built-in and custom coding agent providers.
---

Providers bridge a concrete agent implementation and the ASP event stream AGUI renders. Pick a built-in provider to start, or register your own ASP-compatible agent.

## Built-in providers

| Provider    | Runtime strategy                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Codex       | Starts the app server and maps JSONL notifications, approvals, and results into ASP.                           |
| Claude Code | Starts stream-json SDK mode and maps content blocks, tools, and control requests into ASP.                     |
| OpenCode    | Starts or connects to `opencode serve`, then consumes session history, HTTP APIs, SSE events, and permissions. |
| Pi          | Starts `pi --mode rpc` and maps RPC JSONL commands, model settings, reasoning level, messages, and tools.      |
| Grok        | Starts a headless CLI run with streaming JSON messages and reads local session history.                        |
| Kimi        | Starts a headless CLI run with stream-json output and reads local session history.                             |
| Kilo        | Uses the generic ASP stdio provider entrypoint.                                                                |

## Custom providers

Custom definitions live in `asp-providers.json` under the AGUI user data directory, resolved in this order:

1. `AG_UI_USER_DATA_DIR`
2. `AGUI_USER_DATA_DIR`
3. `AG_UI_HOME`
4. `AGUI_HOME`
5. `~/.agui`

Settings lets you add, edit, delete, and test custom agents from that file.

## The ASP request surface

A custom agent should answer the ASP v1 request methods:

- `capabilities`
- `list_models`
- `run`
- `list_sessions`
- `session_messages`
- `resume_session`
- `session_usage`
- `delete_session`

`run` starts one turn; `abort` is not a request method but a separate notification message carrying `type: "abort"`. Approvals and questions close through `approval_result` / `question_result` responses, and agents that negotiated the extension protocol also receive `extension.invoke` calls. Implement `delete_session` and `session_usage` to back AGUI's remote cleanup and usage display as needed.

Choose among stdio, persistent stdio, WebSocket, or SSH transports. Prefer persistent transports when your provider benefits from process reuse or warm state.

Fail early and clearly: if the agent cannot negotiate capabilities, list models, or start a run, it should say so instead of stalling.

## Run safety

Provider execution is scoped by workspace path, approval mode, and the selected transport. Route adapter output through normal ASP events — never let provider-specific configuration bypass AGUI approval and question handling.

## Continue

- [Multi-agent Sessions](/guides/multi-agent/)
- [Configuration Reference](/reference/configuration/)
