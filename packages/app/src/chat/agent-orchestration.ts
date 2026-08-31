import type {
  AgentParticipant,
  AgentParticipantStatus,
  AgentSessionState,
  AgentWorkItem,
  ChatBlock,
  QueuedPrompt,
  Session,
} from "./types";
import type { PendingPrompt } from "./chat-store-types";

export function providerParticipantId(providerId: string): string {
  return `provider:${encodeURIComponent(providerId)}`;
}

export function ensureProviderParticipant(
  session: Session,
  providerId: string,
  at = Date.now(),
): Session {
  const participantId = providerParticipantId(providerId);
  const current = session.agentParticipants?.[participantId];
  const route = session.agentSessions?.[providerId];
  const backendSessionId =
    route?.providerSessionId ??
    (session.providerId === providerId ? session.providerSessionId : undefined);
  const participant: AgentParticipant = {
    id: participantId,
    providerId,
    role: "primary",
    kind: "provider",
    status: participantStatus(route?.status),
    createdAt: current?.createdAt ?? at,
    updatedAt: at,
    ...current,
    ...(backendSessionId ? { backendSessionId } : {}),
  };
  if (
    current &&
    current.backendSessionId === participant.backendSessionId &&
    current.status === participant.status
  ) {
    return session;
  }
  return {
    ...session,
    agentParticipants: {
      ...(session.agentParticipants ?? {}),
      [participantId]: participant,
    },
  };
}

export function normalizeAgentOrchestration(session: Session): Session {
  const sequenced = assignConversationSequences(session.blocks, session.conversationRevision);
  const providerIds = new Set([session.providerId, ...Object.keys(session.agentSessions ?? {})]);
  let next: Session = {
    ...session,
    blocks: sequenced.blocks,
    conversationRevision: sequenced.revision,
    agentParticipants: { ...(session.agentParticipants ?? {}) },
    workItems: { ...(session.workItems ?? {}) },
    agentRuns: { ...(session.agentRuns ?? {}) },
    handoffs: [...(session.handoffs ?? [])],
  };
  for (const providerId of providerIds)
    next = ensureProviderParticipant(next, providerId, session.createdAt);

  const agentSessions = Object.fromEntries(
    Object.entries(next.agentSessions ?? {}).map(([providerId, route]) => [
      providerId,
      migrateAgentCursor(route, next.blocks),
    ]),
  );
  return {
    ...next,
    agentSessions,
    activeParticipantId: next.activeParticipantId ?? providerParticipantId(next.providerId),
  };
}

export function assignConversationSequences(
  blocks: ChatBlock[],
  currentRevision = 0,
): { blocks: ChatBlock[]; revision: number } {
  let revision = Math.max(currentRevision, ...blocks.map((block) => block.conversationSeq ?? 0));
  let changed = false;
  const next = blocks.map((block) => {
    if (block.conversationSeq) return block;
    changed = true;
    revision += 1;
    return { ...block, conversationSeq: revision };
  });
  return { blocks: changed ? next : blocks, revision };
}

export function targetPromptForSession(
  session: Session,
  prompt: Pick<QueuedPrompt, "attachments" | "text"> & Partial<QueuedPrompt>,
  ids: { promptId: string; workItemId: string },
): PendingPrompt {
  const targetProviderId = prompt.targetProviderId || session.providerId;
  return {
    id: prompt.id || ids.promptId,
    text: prompt.text,
    attachments: prompt.attachments?.length
      ? prompt.attachments.map((attachment) => ({ ...attachment }))
      : undefined,
    targetProviderId,
    targetParticipantId: prompt.targetParticipantId || providerParticipantId(targetProviderId),
    workItemId: prompt.workItemId || ids.workItemId,
    sourceSeq: prompt.sourceSeq ?? session.conversationRevision ?? 0,
  };
}

export function projectAgentLifecycle(
  session: Session,
  input: {
    at: number;
    event: string;
    payload?: unknown;
    providerId?: string;
    runId?: string;
  },
): Session {
  const providerId = input.providerId || session.activeRunProviderId || session.providerId;
  const payload = record(input.payload);
  const part = record(payload.part);
  const agentId = stringValue(payload.agentId) || stringValue(payload.agent_id) || "subagent";
  const instanceKey =
    stringValue(payload.agentInstanceId) ||
    stringValue(payload.agent_instance_id) ||
    stringValue(payload.toolUseId) ||
    stringValue(payload.tool_use_id) ||
    stringValue(payload.sessionId) ||
    stringValue(payload.session_id) ||
    stringValue(payload.id) ||
    stringValue(part.id) ||
    agentId;
  const participantId = `runtime:${encodeURIComponent(providerId)}:${encodeURIComponent(instanceKey)}`;
  const current = session.agentParticipants?.[participantId];
  const status = lifecycleStatus(input.event, payload);
  const parentAgentId = stringValue(payload.parentAgentId);
  const parentParticipantId =
    stringValue(payload.parentParticipantId) ||
    (parentAgentId && parentAgentId !== "primary"
      ? `runtime:${encodeURIComponent(providerId)}:${encodeURIComponent(parentAgentId)}`
      : providerParticipantId(providerId));
  const parentRunId =
    stringValue(payload.parentRunId) || input.runId || session.activeRunId || undefined;
  const participant: AgentParticipant = {
    id: participantId,
    providerId,
    profileId: agentId,
    name: stringValue(payload.name) || agentId,
    role: "subagent",
    kind: "runtime-subagent",
    parentParticipantId,
    parentRunId,
    backendSessionId:
      stringValue(payload.sessionId) ||
      stringValue(payload.session_id) ||
      current?.backendSessionId,
    status,
    createdAt: current?.createdAt ?? input.at,
    updatedAt: input.at,
  };
  const workItemId = currentRuntimeWorkItemId(participantId);
  const objective = stringValue(payload.prompt) || stringValue(payload.message) || `Run ${agentId}`;
  const workItem: AgentWorkItem = {
    id: workItemId,
    objective,
    ownerParticipantId: participantId,
    parentWorkItemId: session.activeWorkItemId,
    status: workItemStatus(status),
    createdAt: session.workItems?.[workItemId]?.createdAt ?? input.at,
    updatedAt: input.at,
  };
  const runKey = `runtime-run:${participantId}`;
  const currentRun = session.agentRuns?.[runKey];
  return {
    ...session,
    agentParticipants: {
      ...(session.agentParticipants ?? {}),
      [participantId]: participant,
    },
    workItems: {
      ...(session.workItems ?? {}),
      [workItemId]: workItem,
    },
    agentRuns: {
      ...(session.agentRuns ?? {}),
      [runKey]: {
        id: runKey,
        providerRunId: input.runId || currentRun?.providerRunId,
        providerId,
        participantId,
        workItemId,
        parentRunId,
        status: runStatus(status),
        startedAt: currentRun?.startedAt ?? input.at,
        ...(status === "running" ? {} : { finishedAt: input.at }),
      },
    },
  };
}

function migrateAgentCursor(route: AgentSessionState, blocks: ChatBlock[]): AgentSessionState {
  if (route.seenThroughSeq !== undefined || !route.lastSyncedBlockId) return route;
  const block = blocks.find((candidate) => candidate.id === route.lastSyncedBlockId);
  return block?.conversationSeq === undefined
    ? route
    : { ...route, seenThroughSeq: block.conversationSeq };
}

function participantStatus(status: AgentSessionState["status"]): AgentParticipantStatus {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "idle";
}

function lifecycleStatus(event: string, payload: Record<string, unknown>): AgentParticipantStatus {
  const explicit = stringValue(payload.status).toLowerCase();
  if (event.endsWith(".failed") || explicit === "failed") return "failed";
  if (explicit === "cancelled" || explicit === "canceled") return "cancelled";
  if (event.endsWith(".completed") || explicit === "completed") return "completed";
  if (event.endsWith(".started")) return "running";
  return "idle";
}

function workItemStatus(status: AgentParticipantStatus): AgentWorkItem["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return status === "running" ? "running" : "queued";
}

function runStatus(status: AgentParticipantStatus) {
  if (status === "completed") return "completed" as const;
  if (status === "failed") return "failed" as const;
  if (status === "cancelled") return "cancelled" as const;
  return status === "running" ? ("running" as const) : ("queued" as const);
}

function currentRuntimeWorkItemId(participantId: string): string {
  return `runtime-work:${participantId}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
