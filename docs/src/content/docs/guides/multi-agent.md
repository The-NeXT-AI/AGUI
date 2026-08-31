---
title: Multi-agent Sessions
description: Switch between providers inside one shared AGUI conversation.
---

A session can switch between Codex, Claude Code, OpenCode, or any other provider inside one shared timeline. Changing who works next requires no copying and no new session.

## Switch agents mid-session

1. Open run settings from the composer.
2. Choose the next agent from the **Agent** submenu.
3. Send a message. AGUI restores that agent's avatar, model, effort, speed, and approval settings, and the selected agent receives the shared conversation delta since it last participated.
4. Read the output — it appears under the avatar and name of the agent that produced it.

Switching to a different agent is disabled while a run is active so events never route to the wrong agent; re-selecting the current agent stays available. AGUI also checks the target provider before committing the selection, so an unavailable agent does not replace the current one.

## Per-provider state

Each AGUI session holds:

| State           | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| Shared timeline | The visible ordered list of user messages and agent outputs.                                  |
| Agent tracks    | Per-provider `providerSessionId`, capabilities, settings, status, usage, and sync position.   |
| Retired tracks  | Old provider threads kept after edits or regeneration, then cleaned up with the AGUI session. |

## Context handoff

When an agent has not seen recent conversation blocks, AGUI sends structured, bounded handoff context:

- User messages, non-empty assistant answers, and compact plan, tool, terminal, diff, resource, and artifact summaries can be synchronized. Reasoning and raw noisy events are excluded. The user's new prompt is still sent as-is and does not enter the handoff.
- The handoff is capped at 16 context items and about 12,000 characters. If the latest work unit alone exceeds the budget, AGUI keeps its opening user request and final assistant answer, then fills the remaining budget with the newest useful artifacts.
- Other agents' answers are treated as untrusted quoted output.
- The handoff cursor advances only after a successful, uncancelled run. Failed or cancelled runs keep the pending context queued for retry.
- Every run carries a client request ID. Events from an older run are rejected before they can update the new agent's projection.

### Original files

File access is independent from the text budget. AGUI collects a file manifest from prior attachments and file-backed artifacts even when their surrounding messages or tool output are omitted.

The runtime validates each source path and creates a content-addressed, read-only snapshot of up to 100 MB. The source path is removed before the context reaches the provider, and the first prepared snapshot for a file ID remains stable if the workspace file changes later. Native adapters receive the snapshot path directly; agents can also discover and read the same bytes through the run-scoped `handoff_file_list` and `handoff_file_read` MCP tools. Missing or oversized files are marked unavailable instead of exposing a mutable source path. Removing the local AGUI session also removes its snapshots.

## History branching

Editing an earlier user message or regenerating a response creates a branch. AGUI retires active provider tracks and starts the next run from the visible timeline, so hidden provider context cannot leak across branches.

## Deletion behavior

Deleting a multi-agent session enumerates every active and retired provider thread and attempts remote cleanup; the delete dialog shows the actual thread count. If a provider cannot delete remotely, AGUI lists it and offers a remove-from-local-list-only choice. When some threads delete and others fail, AGUI keeps the session and drops only the successfully deleted threads so you can retry safely without re-deleting completed ones.

## Continue

- [Providers](/guides/providers/)
- [Architecture](/getting-started/architecture/)
