---
title: ASP extensions
description: Capability negotiation, standard extension namespaces, vendor passthrough, and graceful fallback.
---

ASP keeps its core small and stable. Optional or agent-specific capabilities are published as discoverable extensions, negotiated for a run, and transported through a common envelope.

An extension never becomes an implicit second protocol. It must declare its version, schemas, safety requirements, and fallback behavior, while the host continues to enforce workspace and approval policy.

## Discover and select extensions

The server publishes extension descriptors in its initialized capabilities. A descriptor identifies the extension and describes the methods and events it supports:

```ts
type AspExtensionDescriptor = {
  id: string;
  version: string;
  stability: "stable" | "experimental" | "vendor";
  requiresCore?: string[];
  methods?: AspExtensionMethodDescriptor[];
  events?: AspExtensionEventDescriptor[];
  schemas?: Record<string, unknown>;
  fallback: "core" | "raw" | "none";
};
```

The client selects extensions for an individual run:

```json
{
  "runId": "run-1",
  "extensions": [
    { "id": "asp.ext.run-control", "version": "1.0.0" },
    { "id": "asp.ext.tools", "version": "1.0.0" }
  ]
}
```

An implementation rejects methods that were not declared or negotiated. Extensions requiring extra authority, such as raw vendor passthrough or background work, are not enabled silently.

## Invoke an extension

All extension commands use `extension.invoke`, so new capabilities do not require new transport framing:

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "extension.invoke",
  "params": {
    "extension": "asp.ext.run-control",
    "method": "steer",
    "runId": "run-1",
    "providerSessionId": "session-1",
    "payload": {
      "message": "Analyze the failure before editing files."
    }
  }
}
```

If a descriptor provides `inputSchema` or `outputSchema`, both sender and receiver validate the payload with JSON Schema 2020-12.

## Receive extension events

Events use the `extension.event` method and carry a core fallback:

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "method": "extension.event",
  "params": {
    "extension": "asp.ext.agents",
    "event": "agent.started",
    "runId": "run-1",
    "payload": {
      "agentId": "reviewer",
      "parentAgentId": "primary",
      "role": "subagent"
    },
    "fallback": {
      "type": "message_part",
      "part": {
        "id": "reviewer-started",
        "type": "status",
        "title": "Reviewer",
        "content": "Subagent started"
      }
    }
  }
}
```

A client that understands the extension renders its structured payload. An older client applies the fallback. Pure diagnostics or lossless native events can use `fallback: "none"` when ignoring the event is safe.

## Standard extensions

| Namespace               | Capability                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `asp.ext.agents`        | Agent profiles, selection, subagent invocation, isolation, and lifecycle.                          |
| `asp.ext.run-control`   | Steering, follow-up queues, compaction, model or effort changes, and step abort.                   |
| `asp.ext.permissions`   | Reusable allow, ask, and deny rules for tools, commands, files, network, agents, and MCP.          |
| `asp.ext.tools`         | Typed semantics for shell, file, patch, search, LSP, MCP, web, and agent tools.                    |
| `asp.ext.mcp-apps`      | MCP App discovery, invocation, UI resources, state, and host interaction.                          |
| `asp.ext.ui`            | Forms, editors, selections, progress, toasts, custom views, and TUI controls.                      |
| `asp.ext.hooks`         | Controlled session, run, tool, file, agent, and approval lifecycle hooks.                          |
| `asp.ext.session-state` | Queue, context, parent session, checkpoint, compaction, and message state.                         |
| `asp.ext.multimodal`    | Text, file, directory, image, URI, and explicitly identified raw input parts.                      |
| `asp.ext.runtime`       | Runtime metadata such as MCP servers, auth, workspace policy, background tasks, goals, and skills. |

These namespaces model capabilities that occur across multiple agents. They do not mirror one vendor's wire format.

## Vendor extensions

Provider-specific features live under names such as `vendor.codex.app-server`, `vendor.claude.cli`, `vendor.opencode.server`, and `vendor.pi.rpc`. They preserve information that cannot be represented by a standard extension, but remain constrained:

1. The capability declares a schema or native protocol version.
2. Write-capable passthrough is disabled by default.
3. File writes, commands, network access, and subagent calls still use ASP approval controls.
4. User-visible state also supplies a core fallback.

Native events requested with `preserveNativeEvents` supplement normalized core events; they do not replace them.

## Graceful degradation

Fallback is part of the protocol contract:

- Without `asp.ext.agents`, subagent activity becomes status and nested tool events.
- Without `asp.ext.run-control`, the client hides steering and compaction controls but can still start or cancel a run.
- Without `asp.ext.permissions`, the client keeps one-off core approvals and hides rule editing.
- Without `asp.ext.tools`, results render as ordinary `tool_event` payloads.
- Without `asp.ext.ui`, complex interaction becomes a core question or status event.
- Without a vendor extension, the adapter omits native passthrough and portable conversation behavior remains intact.

Extension versions follow semantic versioning independently from the core. A new major version is negotiated explicitly; optional fields within one major version remain backward-compatible.

For the shared message and lifecycle rules, return to the [ASP v1 core protocol](/asp/core-protocol/).
