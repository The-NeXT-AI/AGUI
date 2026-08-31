---
title: Agent Server Protocol (ASP)
description: An open protocol for connecting coding-agent clients to agent servers.
---

Agent Server Protocol (ASP) is an open, bidirectional protocol for connecting a coding-agent client to an agent server. It gives clients one stable contract for sessions, streamed output, tools, approvals, questions, usage, and advanced agent capabilities.

ASP was incubated by the AGUI project, but it is not an AGUI-private process API. Any client or agent server can implement the protocol independently.

## Why ASP exists

Coding agents expose different process models, event formats, session identifiers, and approval flows. Without a common boundary, every client must implement every provider protocol directly.

```text
Without ASP                         With ASP

Client A ─┬─ Codex                 Client A ─┐
          ├─ Claude                          ├─ ASP ─┬─ Codex adapter
          └─ OpenCode              Client B ─┘       ├─ Claude adapter
Client B ─┬─ Codex                                    ├─ OpenCode adapter
          └─ Claude                                   └─ Native ASP agent
```

ASP separates the portable interaction model from provider-specific details. A renderer can consume the same events whether a run is backed by a native ASP server or by an adapter for Codex, Claude Code, OpenCode, Pi, Grok, Kimi, or another agent.

## Protocol model

ASP has three layers:

| Layer               | Purpose                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core v1             | Initialization, capabilities, sessions, runs, streaming events, cancellation, errors, and controlled client services.                                                                       |
| Standard extensions | Negotiated capabilities shared by multiple agents, such as subagents, run steering, permission rules, typed tools, custom UI, hooks, session state, multimodal input, and runtime metadata. |
| Vendor extensions   | Lossless access to provider-specific data that cannot be represented portably.                                                                                                              |

Every v1 message uses a JSON-RPC 2.0 envelope and identifies the protocol explicitly:

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0"
}
```

## Roles and lifecycle

- The **client** initializes the connection, starts or resumes sessions, submits runs, and exposes only the workspace services it is prepared to provide.
- The **agent server** declares its capabilities, processes runs, emits normalized events, and can call negotiated client services.
- A **provider session** preserves agent-side conversation state. A **run** is one execution within that session. A UI thread is a client concept and is not interchangeable with either identifier.

A typical connection follows this sequence:

```text
Client                                      Agent Server
  │── initialize + supported versions ───────────►│
  │◄─ selected version + capabilities ────────────│
  │── new_session / resume_session ──────────────►│
  │── run(runId, input, extensions) ─────────────►│
  │◄─ run_started ────────────────────────────────│
  │◄─ message / tool / usage / state events ──────│
  │── client permission or elicitation result ───►│
  │◄─ run_finished ───────────────────────────────│
```

## Transports

The protocol semantics do not depend on one deployment model. ASP v1 supports:

- **stdio** for one process per run;
- **persistent stdio** for multiplexed long-lived providers;
- **WebSocket** for local or remote servers;
- **SSH**, which establishes an equivalent stdio or WebSocket channel.

Messages on a connection stay ordered. Events from different runs may interleave, so implementations route them by `runId` instead of relying on a global “current run.”

## Safety boundary

The host remains the security boundary. An agent can read or write files, start commands, request permissions, or ask the user a question only through client services that were advertised during capability negotiation. The client still enforces workspace containment, approval policy, size limits, timeouts, and identifier correlation.

Extensions cannot bypass these rules. A write-capable extension must be negotiated and approved, and user-visible extension events include a core fallback when possible.

## Read next

- [Core protocol](/asp/core-protocol/) explains initialization, sessions, runs, events, client services, and errors.
- [Extensions](/asp/extensions/) explains capability discovery, invocation, fallback behavior, and standard extension namespaces.
- The repository contains the [normative core specification](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/docs/core-protocol.md) and [machine-readable v1 JSON Schema](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/schema/v1/schema.json).
