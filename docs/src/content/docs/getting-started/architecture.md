---
title: Architecture
description: How AGUI normalizes agent protocols and renders the desktop experience.
---

AGUI has a narrow renderer contract and a richer runtime behind it. The runtime owns provider processes, transports, persistence, approvals, questions, workspace access, and protocol adaptation. The renderer receives normalized ASP events and focuses on interface state.

## Core path

```text
AGUI Renderer
  -> secure IPC or WebSocket JSON-RPC
  -> @the-next-ai/runtime
  -> @the-next-ai/asp AspManager
  -> provider adapter or generic ASP transport
  -> normalized ASP events
  -> chat, plan, tool, diff, artifact, resource, approval, question, usage
```

## Packages

| Package               | Responsibility                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `packages/app`        | Renderer React UI, shell state, chat rendering, extension UI runtime, product configuration. |
| `packages/asp`        | ASP protocol types, transports, provider store, session manager, native provider adapters.   |
| `packages/runtime`    | Shared runtime services for Electron and Node server mode.                                   |
| `packages/server`     | Thin Node entrypoint for pure web mode.                                                      |
| `packages/extensions` | Extension manifest, IPC contracts, and declarative UI schema types.                          |
| `packages/electron`   | Electron lifecycle, preload bridge, IPC, native dialogs, embedded browser views.             |

## Runtime boundary

The renderer never speaks provider-specific APIs. It sends high-level session requests to the runtime, which translates provider output into ASP events. This keeps the UI predictable:

- `reasoning`, `plan`, `tool`, `diff`, `resource`, `artifact`, `usage`, and status events share one display model.
- Approval and question loops use the same flow no matter which provider requested them.
- Provider-specific data stays behind adapter boundaries unless explicitly exposed as metadata.

## Session continuity

Each provider track stores its own `providerSessionId`, capabilities, context usage, run settings, and synchronization position. Switching agents changes only the next executor — it never overwrites the shared timeline or passes one provider's session ID to another provider. The multi-agent guide covers the handoff rules in detail.

## Web mode

`@the-next-ai/server` runs the shared runtime in Node and exposes JSON-RPC over WebSocket. Desktop-only features degrade when unavailable: native folder dialogs, `WebContentsView` browser embedding, browser automation, extension installation UX, and OS secure storage.

## Continue

- [Providers](/guides/providers/)
- [Multi-agent Sessions](/guides/multi-agent/)
- [Extensions](/guides/extensions/)
