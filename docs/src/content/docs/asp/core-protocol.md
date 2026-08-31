---
title: ASP v1 core protocol
description: The ASP message envelope, capability negotiation, sessions, runs, events, client services, and errors.
---

ASP core v1 defines the smallest portable contract that a client and an agent server need for a complete coding-agent session. This page is an implementation-oriented guide; the [core specification](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/docs/core-protocol.md) and [JSON Schema](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/schema/v1/schema.json) are the normative sources.

## Common envelope

Every newly emitted v1 message includes `asp`, `version`, and `jsonrpc`:

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0"
}
```

A request adds a unique string or numeric `id`, a `method`, and method parameters. A response echoes the same `id` and contains exactly one of `result` or `error`. A notification has no `id`.

Receivers may accept a missing `jsonrpc` field from early v1 drafts, but new senders must include it. Invalid or ambiguous messages are rejected rather than repaired silently.

## Initialize the connection

Before any other work, the client sends `initialize` with its supported protocol versions, identity, and capabilities:

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "initialize",
  "supportedProtocolVersions": ["1"],
  "clientInfo": { "name": "example-client", "version": "1.0.0" },
  "clientCapabilities": {}
}
```

The server selects one common version and returns its capabilities:

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "id": "init-1",
  "result": {
    "protocolVersion": "1",
    "agentInfo": { "name": "example-agent", "version": "1.0.0" },
    "capabilities": { "protocolVersions": ["1"] }
  }
}
```

The connection cannot continue when there is no common version. Capabilities belong to this connection only and must be negotiated again after reconnecting. Neither side may call a capability that the other side did not declare.

## Session model

`providerSessionId` is the stable conversation identifier in the agent server's namespace. It is distinct from the client's `threadId` and from the `runId` of one execution.

| Method             | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `new_session`      | Create an explicit provider session.                      |
| `list_sessions`    | List sessions visible in a workspace.                     |
| `resume_session`   | Load a resumable session and its messages.                |
| `session_messages` | Read session history.                                     |
| `session_usage`    | Read accumulated usage.                                   |
| `close_session`    | Stop active resources while preserving resumable history. |
| `delete_session`   | Permanently delete session history.                       |

Closing and deleting are not equivalent. `close_session` is idempotent; session state is `active`, `closed`, or `unknown`.

## Run lifecycle

A `run` request includes a unique `runId`, the client `threadId`, working directory, structured input, approval mode, selected extensions, and optionally a `providerSessionId`.

For every accepted run, the server:

1. emits `run_started` first;
2. emits zero or more content, tool, usage, or state events;
3. emits exactly one terminal `run_finished` event.

Core events include:

| Event               | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `message_delta`     | Incremental text or reasoning output.                                              |
| `message_part`      | A structured message part such as text, reasoning, a diff, an artifact, or status. |
| `tool_event`        | Tool start, progress, result, or failure.                                          |
| `session_state`     | Updated provider session state.                                                    |
| `usage`             | Token, context, or cost accounting.                                                |
| `stdout` / `stderr` | Raw process output that is intentionally surfaced.                                 |
| `error`             | A non-terminal or terminal run error.                                              |
| `extension_event`   | A negotiated extension event plus its fallback.                                    |
| `run_finished`      | The single terminal event for the run.                                             |

Updates for one item, message part, or tool are applied in send order. A terminal event reports `success` and a `stopReason`: `end_turn`, `canceled`, `error`, `timeout`, `max_tokens`, `max_turns`, or `refusal`.

The client cancels an active run with the `run.cancel` notification. Cancellation races with completion; a run that already finished must not be rewritten as canceled.

## Bidirectional client services

An agent server can call only services marked `true` in `clientCapabilities.clientServices`. Each call is tied to an active `runId` and may include its `providerSessionId`.

| Service family | Methods                                                                |
| -------------- | ---------------------------------------------------------------------- |
| Files          | `client.fs.read_text_file`, `client.fs.write_text_file`                |
| Terminal       | `client.terminal.create`, `output`, `wait_for_exit`, `kill`, `release` |
| Permission     | `client.permission.request`                                            |
| User input     | `client.elicitation.create`                                            |

The client constrains file paths to authorized workspaces, prevents symbolic-link escapes, limits payload sizes, and applies its approval policy to side effects. A permission response is one of `allow`, `allow-session`, `allow-always`, `deny`, or `cancel`. An elicitation response distinguishes an answer from cancellation or no answer.

## Errors

Errors use `{ code, message, data? }`. ASP keeps the JSON-RPC codes and adds protocol-specific failures:

|     Code | Meaning                                                     |
| -------: | ----------------------------------------------------------- |
| `-32700` | Parse error                                                 |
| `-32600` | Invalid request, state, envelope, or correlation identifier |
| `-32601` | Method not found                                            |
| `-32602` | Invalid parameters or JSON Schema failure                   |
| `-32603` | Internal error                                              |
| `-32800` | Request or run canceled                                     |
| `-32001` | Approval denied                                             |
| `-32002` | Resource not found                                          |
| `-32003` | Capability not negotiated                                   |
| `-32004` | Protocol version mismatch                                   |

`error.data` can provide retry and correlation details, but must not contain credentials or unredacted environment variables.

## Validation and compatibility

- Treat input, history, native events, and extension payloads as untrusted data.
- Validate envelopes, schemas, response IDs, `runId`, and `providerSessionId` at the receiving boundary.
- Limit message size, arrays, buffered output, file content, and execution time.
- Use a new core `version` for breaking changes. New optional fields and capability flags remain backward-compatible within v1.
- Preserve unknown fields when proxying or logging messages so another implementation can forward them losslessly.

Continue with [ASP extensions](/asp/extensions/) to add optional capabilities without destabilizing the core.
