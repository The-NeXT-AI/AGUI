import { uid } from "@/ui/id";
import { bindSessionRun, sessionRunProviderId, useChatStore } from "@/chat/chat-store";
import { t } from "@/lib/i18n";
import {
  claudeCodePayloadHasCliContext,
  claudeCodePayloadLabels,
  contextUsageFromSessionPayload,
  contextUsedTokensFromSessionPayload,
  contextWindowTokensForSessionPayload,
  isClaudeCodeProvider,
  mergeContextUsage,
} from "@/chat/context-usage";
import type {
  ChatBlock,
  DiffHunk,
  InteractiveAppEmbed,
  Session,
  SessionEvent,
  ToolStatus,
} from "@/chat/types";
import { useRegistryStore } from "@/runtime/registry-store";
import type { AspRunProjectorContext } from "@/runtime/types";
import { useAspStore } from "./asp-store";
import {
  desktopApi,
  type AspExtensionEvent,
  type AspMessagePart,
  type AspRunEvent,
  type AspSessionState,
  type AspTokenUsage,
  type AspToolEvent,
  type DesktopSessionEvent,
} from "./desktop-api";
import { notifyAspRunProjected } from "./asp-run-projection";

type Projection = {
  assistantId?: string;
  assistantSourceKeys: Map<string, string>;
  blockOrders: Map<string, number>;
  latestUsage?: { input: number; output: number };
  messageOrders: Map<string, number>;
  reasoningId?: string;
  partTexts: Map<string, string>;
  nextOrder: number;
  providerId?: string;
  runId?: string;
};

type StreamingDeltaEvent = Extract<
  SessionEvent,
  { type: "assistant_delta" | "reasoning_delta" | "tool_delta" }
>;
type ChatStoreState = ReturnType<typeof useChatStore.getState>;
type ChatRuntimePatch = Parameters<ChatStoreState["patchRuntime"]>[1];

const projections = new Map<string, Projection>();
const pendingStreamingDeltas = new Map<string, { sessionId: string; event: StreamingDeltaEvent }>();
const PROJECTOR_PROTECTED_RUN_EVENTS = new Set(["run_started", "run_finished"]);
let streamingDeltaFlushHandle: number | ReturnType<typeof setTimeout> | undefined;
let streamingDeltaFlushMode: "raf" | "timeout" | undefined;

export function installAspBridge(): () => void {
  const api = desktopApi();
  if (!api) return () => undefined;
  const removeEvent = api.onSessionEvent(handleDesktopEvent);
  const removeApproval = api.onApprovalRequest((request) =>
    useAspStore.getState().enqueueApproval(request),
  );
  const removeQuestion = api.onQuestionRequest((request) =>
    useAspStore.getState().enqueueQuestion(request),
  );
  if (typeof api.interactions.pending === "function") {
    void api.interactions
      .pending()
      .then((pending) => {
        for (const request of pending.approvals) useAspStore.getState().enqueueApproval(request);
        for (const request of pending.questions) useAspStore.getState().enqueueQuestion(request);
      })
      .catch(() => {
        // Pending interactions are best-effort replay for renderer restarts.
      });
  }
  return () => {
    removeEvent();
    removeApproval();
    removeQuestion();
  };
}

function handleDesktopEvent(event: DesktopSessionEvent): void {
  if (event.type === "connection_state") {
    const state = useChatStore.getState();
    const session = state.sessions.find((item) => item.id === event.uiSessionId);
    if (event.clientRequestId && event.clientRequestId !== session?.activeRunRequestId) return;
    if (
      event.runId &&
      (session?.activeRunId ? event.runId !== session.activeRunId : !session?.activeRunRequestId)
    ) {
      return;
    }
    state.patchRuntime(
      event.uiSessionId,
      {
        connectionState: event.state,
        connectionMessage: event.message,
      },
      event.providerId,
    );
    return;
  }
  projectRunEvent(event.uiSessionId, event.event, event.clientRequestId);
}

function projectRunEvent(sessionId: string, event: AspRunEvent, clientRequestId?: string): void {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  if (clientRequestId && clientRequestId !== session?.activeRunRequestId) return;
  const projection = projectionFor(sessionId);
  if (
    !clientRequestId &&
    event.type !== "run_started" &&
    projection.runId &&
    projection.runId !== event.runId
  ) {
    return;
  }
  const providerId =
    projection.runId === event.runId ? projection.providerId : sessionRunProviderId(sessionId);
  if (event.providerSessionId) {
    useChatStore
      .getState()
      .patchRuntime(sessionId, { providerSessionId: event.providerSessionId }, providerId);
  }
  const consumedByProjector = projectRegisteredRunEvent(sessionId, event, providerId);
  if (consumedByProjector && !PROJECTOR_PROTECTED_RUN_EVENTS.has(event.type)) return;
  switch (event.type) {
    case "run_started":
      finishOpenBlocks(sessionId, projection);
      if (providerId) bindSessionRun(sessionId, event.runId, providerId, clientRequestId);
      projections.set(sessionId, createProjection(sessionId, event.runId, providerId));
      return;
    case "message_delta":
      appendAssistant(sessionId, projection, event.data, messageDeltaItemId(event));
      return;
    case "message_part":
      projectPart(sessionId, projection, event.part);
      return;
    case "tool_event":
      projectTool(sessionId, projection, event.toolEvent);
      return;
    case "session_state":
      projectSessionState(sessionId, event.state, event.providerSessionId, undefined, providerId);
      return;
    case "extension_event": {
      const consumed = projectExtensionEvent(
        sessionId,
        event.extensionEvent,
        providerId,
        event.runId,
      );
      if (consumed || event.extensionEvent.fallback) return;
      dispatch(sessionId, {
        id: uid("e"),
        type: "raw",
        blockId: uid("asp-ext"),
        label: `${event.extensionEvent.extension}:${event.extensionEvent.event}`,
        value: event.extensionEvent.payload,
        metadata: event.extensionEvent.metadata,
        at: Date.now(),
      });
      return;
    }
    case "usage":
      projection.latestUsage = tokenUsageFromAsp(event.usage);
      patchUsage(sessionId, event.usage, event.model, providerId);
      return;
    case "stdout":
    case "stderr":
      return;
    case "error":
      dispatch(sessionId, {
        id: uid("e"),
        type: "error",
        message: event.message,
        at: Date.now(),
      });
      return;
    case "run_finished": {
      finishOpenBlocks(sessionId, projection);
      if (event.usage) patchUsage(sessionId, event.usage, undefined, providerId);
      const usage = event.usage ? tokenUsageFromAsp(event.usage) : projection.latestUsage;
      dispatch(sessionId, {
        id: uid("e"),
        type: "turn_complete",
        usage,
        at: Date.now(),
      });
      notifyAspRunProjected(sessionId, event.runId);
      return;
    }
  }
}

function projectRegisteredRunEvent(
  sessionId: string,
  event: AspRunEvent,
  providerId?: string,
): boolean {
  const projectors = useRegistryStore.getState().aspRunProjectors;
  if (!projectors.length) return false;

  const eventType = stringPayload((event as Record<string, unknown>).type);
  if (!eventType) return false;

  const context: AspRunProjectorContext = {
    sessionId,
    eventType,
    event,
    getSession: () => useChatStore.getState().sessions.find((item) => item.id === sessionId),
    dispatch: (nextEvent) => dispatch(sessionId, nextEvent as SessionEvent),
    patchRuntime: (patch) =>
      useChatStore.getState().patchRuntime(sessionId, patch as ChatRuntimePatch, providerId),
  };

  for (const projector of projectors) {
    try {
      if (projector.canProject && !projector.canProject(context)) continue;
      if (projector.project(context)) return true;
    } catch (error) {
      console.warn(`ASP projector failed: ${projector.id}`, error);
    }
  }

  return false;
}

function projectSessionState(
  sessionId: string,
  sessionState: AspSessionState | Record<string, unknown>,
  fallbackProviderSessionId?: string,
  extensionState?: NonNullable<Session["extensionState"]>,
  runProviderId?: string,
): void {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const providerId = runProviderId ?? sessionRunProviderId(sessionId);
  const provider = useAspStore.getState().providers.find((item) => item.id === providerId);
  const payload = recordPayload(sessionState);
  const providerSessionId = stringPayload(payload.providerSessionId) || fallbackProviderSessionId;
  const title = titleFromSessionPayload(payload);
  const isClaudeCode = isClaudeCodeProvider(
    provider,
    providerId,
    session?.capabilities?.runtimeAdapter,
    session?.capabilities?.wireProtocol,
    session?.agentSessions?.[providerId ?? ""]?.capabilities?.runtimeAdapter,
    session?.agentSessions?.[providerId ?? ""]?.capabilities?.wireProtocol,
    ...claudeCodePayloadLabels(payload),
  );
  const hasExplicitContextUsed =
    contextUsedTokensFromSessionPayload(payload, { includePlainTokenFields: false }) !== undefined;
  const hasCliContext = !isClaudeCode || claudeCodePayloadHasCliContext(payload);
  const parsedContextUsage = hasCliContext
    ? contextUsageFromSessionPayload(
        payload,
        isClaudeCode && !hasExplicitContextUsed ? undefined : session?.contextUsage,
        isClaudeCode
          ? undefined
          : contextWindowTokensForSessionPayload(
              payload,
              providerId,
              useAspStore.getState().providers,
            ),
        undefined,
        { includePlainTokenFields: !isClaudeCode },
      )
    : undefined;
  const contextUsage =
    isClaudeCode && !parsedContextUsage
      ? null
      : isClaudeCode && parsedContextUsage
        ? { ...parsedContextUsage, source: "claude-code-cli" }
        : parsedContextUsage;
  const extensionSession = mergeProviderSessionPayload(
    recordPayload(session?.extensionState?.session),
    payload,
    isClaudeCode,
    hasCliContext,
  );
  state.patchRuntime(
    sessionId,
    {
      ...(title ? { title } : {}),
      providerSessionId: providerSessionId || session?.providerSessionId,
      contextUsage,
      extensionState: {
        ...(session?.extensionState ?? {}),
        ...(extensionState ?? {}),
        session: extensionSession,
      },
    },
    providerId,
  );
}

function projectExtensionEvent(
  sessionId: string,
  extensionEvent: AspExtensionEvent,
  providerId?: string,
  runId?: string,
): boolean {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const current = session?.extensionState ?? {};
  const nextEvents = [
    ...(current.events ?? []),
    {
      extension: extensionEvent.extension,
      event: extensionEvent.event,
      payload: extensionEvent.payload,
      at: Date.now(),
    },
  ].slice(-50);
  const patch: NonNullable<Session["extensionState"]> = {
    ...current,
    events: nextEvents,
  };

  if (extensionEvent.extension === "asp.ext.session-state") {
    patch.session = recordPayload(extensionEvent.payload);
    projectSessionState(
      sessionId,
      patch.session,
      extensionEvent.providerSessionId,
      patch,
      providerId,
    );
    return true;
  }

  if (extensionEvent.extension === "asp.ext.agents") {
    if (
      extensionEvent.event === "agent.started" ||
      extensionEvent.event === "agent.completed" ||
      extensionEvent.event === "agent.failed"
    ) {
      state.projectAgentLifecycle(sessionId, {
        at: Date.now(),
        event: extensionEvent.event,
        payload: extensionEvent.payload,
        providerId,
        runId,
      });
    }
    patch.agents = {
      ...recordPayload(current.agents),
      [extensionEvent.event]: extensionEvent.payload,
    };
  } else if (extensionEvent.extension === "asp.ext.hooks") {
    patch.hooks = {
      ...recordPayload(current.hooks),
      [extensionEvent.event]: extensionEvent.payload,
    };
  } else if (extensionEvent.extension === "asp.ext.permissions") {
    patch.permissions = {
      ...recordPayload(current.permissions),
      [extensionEvent.event]: extensionEvent.payload,
    };
  } else if (extensionEvent.extension === "asp.ext.runtime") {
    patch.runtime = {
      ...recordPayload(current.runtime),
      [extensionEvent.event]: extensionEvent.payload,
    };
  } else {
    state.patchRuntime(sessionId, { extensionState: patch }, providerId);
    return false;
  }

  state.patchRuntime(sessionId, { extensionState: patch }, providerId);
  return true;
}

function projectPart(sessionId: string, projection: Projection, part: AspMessagePart): void {
  const orderInfo = sourceOrderInfo(projection, "metadata" in part ? part.metadata : undefined);
  switch (part.type) {
    case "text":
      appendAssistant(
        sessionId,
        projection,
        partDelta(projection, part.id, part.content ?? ""),
        part.id,
        {
          forceStart: isPlaceholderPart(part),
          order: orderInfo.order,
          sourceKey: orderInfo.sourceKey,
        },
      );
      return;
    case "reasoning":
      appendReasoning(
        sessionId,
        projection,
        partDelta(projection, part.id, part.content ?? ""),
        part.id,
        {
          forceStart: isPlaceholderPart(part) || part.status === "inProgress",
          order: orderInfo.order,
        },
      );
      return;
    case "plan": {
      const items = part.items?.length
        ? part.items
        : (part.content ?? "")
            .split(/\r?\n/)
            .map((item) => item.replace(/^[-*]\s*/, "").trim())
            .filter(Boolean);
      dispatch(sessionId, {
        id: uid("e"),
        type: "plan_update",
        blockId: part.id,
        todos: items.map((content) => ({ content, status: "pending" })),
        order: orderFor(projection, part.id, orderInfo.order),
        at: Date.now(),
      });
      return;
    }
    case "tool":
      if (part.toolEvent) projectTool(sessionId, projection, part.toolEvent);
      return;
    case "diff":
      dispatch(sessionId, {
        id: uid("e"),
        type: "tool_start_diff",
        toolId: part.id,
        path: part.path || part.oldPath || part.title || t("diff.changes"),
        hunks: parseUnifiedDiff(part.content ?? ""),
        review: "accepted",
        order: orderFor(projection, part.id, orderInfo.order),
        at: Date.now(),
      });
      dispatch(sessionId, {
        id: uid("e"),
        type: "tool_end",
        toolId: part.id,
        status: "success",
        at: Date.now(),
      });
      return;
    case "status":
      if (part.content) {
        appendAssistant(
          sessionId,
          projection,
          partDelta(projection, part.id, part.content),
          part.id,
          {
            order: orderInfo.order,
            sourceKey: orderInfo.sourceKey,
          },
        );
      }
      return;
    case "citation":
      if (part.content || part.uri) {
        const content = part.uri
          ? `[${part.content || part.uri}](${part.uri})`
          : (part.content ?? "");
        appendAssistant(sessionId, projection, partDelta(projection, part.id, content), part.id, {
          order: orderInfo.order,
          sourceKey: orderInfo.sourceKey,
        });
      }
      return;
    case "resource": {
      const app = interactiveAppFromPart(part);
      dispatch(sessionId, {
        id: uid("e"),
        type: "resource",
        blockId: part.id,
        title: part.title,
        name: part.name,
        uri: part.uri,
        path: part.path,
        mimeType: part.mimeType,
        content: part.content,
        app,
        metadata: part.metadata,
        order: orderFor(projection, part.id, orderInfo.order),
        at: Date.now(),
      });
      return;
    }
    case "artifact": {
      const app = interactiveAppFromPart(part);
      dispatch(sessionId, {
        id: uid("e"),
        type: "artifact",
        blockId: part.id,
        artifactId: part.artifactId,
        title: part.title,
        name: part.name,
        uri: part.uri,
        path: part.path,
        mimeType: part.mimeType,
        content: part.content,
        app,
        metadata: part.metadata,
        order: orderFor(projection, part.id, orderInfo.order),
        at: Date.now(),
      });
      return;
    }
    case "raw":
      dispatch(sessionId, {
        id: uid("e"),
        type: "raw",
        blockId: part.id,
        label: part.label,
        value: part.value,
        metadata: part.metadata,
        order: orderFor(projection, part.id, orderInfo.order),
        at: Date.now(),
      });
      return;
  }
}

function projectTool(sessionId: string, projection: Projection, tool: AspToolEvent): void {
  if (isInternalUserMessageTool(tool)) return;
  const status = toolStatus(tool);
  const order = orderFor(projection, tool.id, sourceOrderInfo(projection, tool.metadata).order);
  dispatch(sessionId, {
    id: uid("e"),
    type: "tool_start",
    toolId: tool.id,
    title: tool.name,
    toolKind: tool.kind,
    status,
    output: tool.phase === "delta" ? undefined : tool.output,
    rawInput: tool.input,
    locations: toolLocations(tool),
    order,
    at: Date.now(),
  });
  if (tool.phase === "delta" && tool.output) {
    dispatch(sessionId, {
      id: uid("e"),
      type: "tool_delta",
      toolId: tool.id,
      chunk: tool.output,
      order,
      at: Date.now(),
    });
  } else {
    dispatch(sessionId, {
      id: uid("e"),
      type: "tool_update",
      toolId: tool.id,
      title: tool.name,
      status,
      output: tool.output,
      rawOutput: tool.error,
      locations: toolLocations(tool),
      order,
      at: Date.now(),
    });
  }
  if (tool.phase === "completed" || status !== "running") {
    dispatch(sessionId, {
      id: uid("e"),
      type: "tool_end",
      toolId: tool.id,
      status,
      order,
      at: Date.now(),
    });
  }
  for (const child of tool.children ?? []) projectTool(sessionId, projection, child);
}

function isInternalUserMessageTool(tool: AspToolEvent): boolean {
  return tool.kind === "userMessage" || tool.name.trim().toLowerCase() === "user message";
}

function appendAssistant(
  sessionId: string,
  projection: Projection,
  text: string,
  blockId?: string,
  options: { forceStart?: boolean; order?: number; sourceKey?: string } = {},
): void {
  if (!text && !options.forceStart) return;
  const requestedId = blockId || projection.assistantId || `assistant-${uid("message")}`;
  const requestedOrder = orderFor(projection, requestedId, options.order);
  const id = coalescedAssistantId(
    sessionId,
    projection,
    requestedId,
    requestedOrder,
    options.sourceKey,
  );
  const order = orderFor(projection, id, id === requestedId ? requestedOrder : undefined);
  if (projection.reasoningId) {
    dispatch(sessionId, {
      id: uid("e"),
      type: "reasoning_end",
      blockId: projection.reasoningId,
      order: orderFor(projection, projection.reasoningId),
      at: Date.now(),
    });
    projection.reasoningId = undefined;
  }
  if (projection.assistantId && projection.assistantId !== id) {
    dispatch(sessionId, {
      id: uid("e"),
      type: "assistant_end",
      blockId: projection.assistantId,
      order: orderFor(projection, projection.assistantId),
      at: Date.now(),
    });
  }
  if (projection.assistantId !== id) {
    projection.assistantId = id;
    if (options.sourceKey) projection.assistantSourceKeys.set(id, options.sourceKey);
    dispatch(sessionId, {
      id: uid("e"),
      type: "assistant_start",
      blockId: id,
      order,
      at: Date.now(),
    });
  }
  if (!text) return;
  dispatch(sessionId, {
    id: uid("e"),
    type: "assistant_delta",
    blockId: id,
    text,
    order,
    at: Date.now(),
  });
}

function appendReasoning(
  sessionId: string,
  projection: Projection,
  text: string,
  blockId?: string,
  options: { forceStart?: boolean; order?: number } = {},
): void {
  if (!text && !options.forceStart) return;
  const id = blockId || projection.reasoningId || `reasoning-${uid("message")}`;
  const order = orderFor(projection, id, options.order);
  if (projection.reasoningId && projection.reasoningId !== id) {
    dispatch(sessionId, {
      id: uid("e"),
      type: "reasoning_end",
      blockId: projection.reasoningId,
      order: orderFor(projection, projection.reasoningId),
      at: Date.now(),
    });
  }
  if (projection.reasoningId !== id) {
    projection.reasoningId = id;
    dispatch(sessionId, {
      id: uid("e"),
      type: "reasoning_start",
      blockId: id,
      order,
      at: Date.now(),
    });
  }
  if (!text) return;
  dispatch(sessionId, {
    id: uid("e"),
    type: "reasoning_delta",
    blockId: id,
    text,
    order,
    at: Date.now(),
  });
}

function finishOpenBlocks(sessionId: string, projection: Projection): void {
  if (projection.reasoningId) {
    dispatch(sessionId, {
      id: uid("e"),
      type: "reasoning_end",
      blockId: projection.reasoningId,
      order: orderFor(projection, projection.reasoningId),
      at: Date.now(),
    });
  }
  if (projection.assistantId) {
    dispatch(sessionId, {
      id: uid("e"),
      type: "assistant_end",
      blockId: projection.assistantId,
      order: orderFor(projection, projection.assistantId),
      at: Date.now(),
    });
  }
  projection.reasoningId = undefined;
  projection.assistantId = undefined;
}

function patchUsage(
  sessionId: string,
  usage: AspTokenUsage,
  model?: string,
  runProviderId?: string,
): void {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const providerId = runProviderId ?? sessionRunProviderId(sessionId);
  const provider = useAspStore.getState().providers.find((item) => item.id === providerId);
  const payload = recordPayload(session?.extensionState?.session);
  const isClaudeCode = isClaudeCodeProvider(
    provider,
    providerId,
    session?.capabilities?.runtimeAdapter,
    session?.capabilities?.wireProtocol,
    session?.agentSessions?.[providerId ?? ""]?.capabilities?.runtimeAdapter,
    session?.agentSessions?.[providerId ?? ""]?.capabilities?.wireProtocol,
    ...claudeCodePayloadLabels(payload),
  );
  const usedTokens = usage.contextTokens ?? (isClaudeCode ? undefined : usage.totalTokens);
  const contextUsageSize =
    usage.contextWindowTokens ??
    (isClaudeCode
      ? undefined
      : contextWindowTokensForSessionPayload(
          payload,
          providerId,
          useAspStore.getState().providers,
          model,
        ));
  const mergedContextUsage = mergeContextUsage(
    isClaudeCode && usedTokens === undefined ? undefined : session?.contextUsage,
    usedTokens,
    contextUsageSize,
  );
  const hasCliUsageContext =
    isClaudeCode && (usage.contextTokens !== undefined || usage.contextWindowTokens !== undefined);
  const contextUsage =
    isClaudeCode && usedTokens === undefined && !mergedContextUsage
      ? null
      : hasCliUsageContext && mergedContextUsage
        ? { ...mergedContextUsage, source: "claude-code-cli" }
        : mergedContextUsage;
  const tokenUsage = { input: usage.inputTokens, output: usage.outputTokens };
  state.patchRuntime(sessionId, { contextUsage, usage: tokenUsage }, providerId);
}

function tokenUsageFromAsp(usage: AspTokenUsage): { input: number; output: number } {
  return { input: usage.inputTokens, output: usage.outputTokens };
}

function toolStatus(tool: AspToolEvent): ToolStatus {
  const status = (tool.status ?? "").toLowerCase();
  if (tool.error || ["error", "failed", "failure", "denied"].includes(status)) return "error";
  if (tool.phase === "completed" || ["success", "completed", "done", "finished"].includes(status)) {
    return "success";
  }
  return "running";
}

function toolLocations(
  tool: AspToolEvent,
): Array<{ path: string; line?: number | null }> | undefined {
  const metadata = tool.metadata ?? {};
  const raw = metadata.locations;
  if (Array.isArray(raw)) {
    const locations = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as Record<string, unknown>;
      return typeof source.path === "string"
        ? [
            {
              path: source.path,
              line: typeof source.line === "number" ? source.line : undefined,
            },
          ]
        : [];
    });
    if (locations.length) return locations;
  }
  const path = metadata.path;
  return typeof path === "string" ? [{ path }] : undefined;
}

function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) current.lines.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ type: "del", text: line.slice(1) });
    else current.lines.push({ type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return hunks.length
    ? hunks
    : [
        {
          oldStart: 1,
          newStart: 1,
          lines: diff.split(/\r?\n/).map((text) => ({ type: "ctx", text })),
        },
      ];
}

function projectionFor(sessionId: string): Projection {
  let projection = projections.get(sessionId);
  if (!projection) {
    projection = createProjection(sessionId);
    projections.set(sessionId, projection);
  }
  return projection;
}

function createProjection(sessionId?: string, runId?: string, providerId?: string): Projection {
  return {
    assistantSourceKeys: new Map(),
    blockOrders: new Map(),
    messageOrders: new Map(),
    nextOrder: initialProjectionOrder(sessionId),
    partTexts: new Map(),
    providerId,
    runId,
  };
}

function initialProjectionOrder(sessionId?: string): number {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  const maxExisting =
    session?.blocks.reduce((max, block) => {
      const order = blockOrder(block);
      return order === undefined ? max : Math.max(max, order);
    }, 0) ?? 0;
  return Math.max(Date.now(), maxExisting + 1);
}

function orderFor(projection: Projection, blockId: string, preferredOrder?: number): number {
  const existing = projection.blockOrders.get(blockId);
  if (existing !== undefined) return existing;
  const order = preferredOrder ?? projection.nextOrder;
  if (preferredOrder === undefined) projection.nextOrder += 1;
  projection.blockOrders.set(blockId, order);
  return order;
}

type SourceOrderInfo = {
  order?: number;
  sourceKey?: string;
};

function sourceOrderInfo(projection: Projection, metadata: unknown): SourceOrderInfo {
  const payload = recordPayload(metadata);
  const sourceKey =
    stringPayload(payload.messageKey) ||
    stringPayload(payload.message_key) ||
    stringPayload(payload.messageId) ||
    stringPayload(payload.message_id);
  const index = finiteNumber(
    payload.contentBlockIndex ?? payload.content_block_index ?? payload.index,
  );
  if (!sourceKey || index === undefined) return { sourceKey: sourceKey || undefined };
  let base = projection.messageOrders.get(sourceKey);
  if (base === undefined) {
    base = projection.nextOrder;
    projection.nextOrder += 1;
    projection.messageOrders.set(sourceKey, base);
  }
  return {
    order: base + Math.max(index, 0) / 1_000_000,
    sourceKey,
  };
}

function coalescedAssistantId(
  sessionId: string,
  projection: Projection,
  requestedId: string,
  requestedOrder: number,
  sourceKey?: string,
): string {
  const currentId = projection.assistantId;
  if (!currentId || currentId === requestedId || !sourceKey) return requestedId;
  if (projection.assistantSourceKeys.get(currentId) !== sourceKey) return requestedId;
  const currentOrder = orderFor(projection, currentId);
  if (requestedOrder <= currentOrder) return requestedId;
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  const hasInterveningBlock =
    session?.blocks.some((block) => {
      if (block.id === currentId) return false;
      const order = blockOrder(block);
      return order !== undefined && order > currentOrder && order < requestedOrder;
    }) ?? false;
  return hasInterveningBlock ? requestedId : currentId;
}

function blockOrder(block: ChatBlock): number | undefined {
  if (typeof block.order === "number" && Number.isFinite(block.order)) return block.order;
  return "at" in block && typeof block.at === "number" && Number.isFinite(block.at)
    ? block.at
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function partDelta(projection: Projection, partId: string, content: string): string {
  const previous = projection.partTexts.get(partId) ?? "";
  projection.partTexts.set(partId, content);
  if (!content || content === previous) return "";
  return content.startsWith(previous) ? content.slice(previous.length) : content;
}

function isPlaceholderPart(part: AspMessagePart): boolean {
  return recordPayload("metadata" in part ? part.metadata : undefined).placeholder === true;
}

function messageDeltaItemId(event: AspRunEvent): string | undefined {
  const itemId = (event as { itemId?: unknown }).itemId;
  return typeof itemId === "string" && itemId.trim() ? itemId.trim() : undefined;
}

function interactiveAppFromPart(part: AspMessagePart): InteractiveAppEmbed | undefined {
  if (part.type !== "resource" && part.type !== "artifact") return undefined;
  const source = part as unknown as Record<string, unknown>;
  const metadata = recordPayload(part.metadata);
  const openaiMeta = recordPayload(metadata._meta);
  const uiMeta = recordPayload(metadata.ui);
  const metaUiMeta = recordPayload(openaiMeta.ui);
  const explicitApp = firstRecord(
    source.app,
    source.mcpApp,
    source.mcp_app,
    source.ui,
    source.widget,
    metadata.app,
    metadata.mcpApp,
    metadata.mcp_app,
    metadata.widget,
    uiMeta.app,
    openaiMeta.app,
    openaiMeta.mcpApp,
    openaiMeta.widget,
  );
  const mimeType = (part.mimeType ?? "").toLowerCase();
  const contentJson = parseJsonObject(part.content);
  const contentApp = isMcpAppMime(mimeType)
    ? firstRecord(
        contentJson.app,
        contentJson.mcpApp,
        contentJson.mcp_app,
        contentJson.ui,
        contentJson.widget,
        contentJson,
      )
    : {};
  const hasExplicitApp = Object.keys(explicitApp).length > 0;
  const isEmbeddable =
    hasExplicitApp ||
    Object.keys(contentApp).length > 0 ||
    isMcpAppMime(mimeType) ||
    isHtmlMime(mimeType) ||
    looksLikeHtml(part.content);
  if (!isEmbeddable) return undefined;

  const outputTemplate =
    stringPayload(metadata["openai/outputTemplate"]) ||
    stringPayload(openaiMeta["openai/outputTemplate"]) ||
    stringPayload(metadata["ui.resourceUri"]) ||
    stringPayload(metaUiMeta.resourceUri) ||
    stringPayload(uiMeta.resourceUri);
  const resourceUri = firstString(
    explicitApp.resourceUri,
    explicitApp.resource_uri,
    contentApp.resourceUri,
    contentApp.resource_uri,
    outputTemplate,
    part.uri?.startsWith("ui://") ? part.uri : undefined,
  );
  const html =
    firstString(
      explicitApp.html,
      explicitApp.srcDoc,
      explicitApp.srcdoc,
      explicitApp.content,
      contentApp.html,
      contentApp.srcDoc,
      contentApp.srcdoc,
      contentApp.content,
    ) || (isHtmlMime(mimeType) || looksLikeHtml(part.content) ? part.content : undefined);
  const src = safeEmbedSrc(
    firstString(
      explicitApp.src,
      explicitApp.url,
      explicitApp.uri,
      explicitApp.resourceUri,
      contentApp.src,
      contentApp.url,
      contentApp.uri,
      contentApp.resourceUri,
      outputTemplate,
      isMcpAppMime(mimeType) || hasExplicitApp ? part.uri : undefined,
    ),
  );
  if (!html && !src && !resourceUri) return undefined;

  return {
    renderer: "mcp-app",
    title: firstString(explicitApp.title, contentApp.title, part.title, part.name),
    html,
    src,
    uri: resourceUri,
    resourceUri,
    server: firstString(
      explicitApp.server,
      explicitApp.serverName,
      contentApp.server,
      contentApp.serverName,
      metadata.server,
      metadata.serverName,
      source.server,
      source.serverName,
      recordPayload(metadata.appContext).server,
      recordPayload(metadata.app_context).server,
    ),
    height: firstNumber(
      explicitApp.height,
      explicitApp.defaultHeight,
      explicitApp.maxHeight,
      contentApp.height,
      contentApp.defaultHeight,
      contentApp.maxHeight,
      metadata.height,
    ),
    toolInput: firstDefined(
      explicitApp.toolInput,
      explicitApp.tool_input,
      contentApp.toolInput,
      contentApp.tool_input,
      metadata.toolInput,
      metadata.tool_input,
      source.toolInput,
      source.tool_input,
    ),
    toolOutput: firstDefined(
      explicitApp.toolOutput,
      explicitApp.structuredContent,
      explicitApp.structured_content,
      contentApp.toolOutput,
      contentApp.structuredContent,
      contentApp.structured_content,
      metadata.toolOutput,
      metadata.structuredContent,
      metadata.structured_content,
      source.toolOutput,
      source.structuredContent,
      source.structured_content,
    ),
    toolResponseMetadata: firstDefined(
      explicitApp.toolResponseMetadata,
      explicitApp.tool_response_metadata,
      contentApp.toolResponseMetadata,
      contentApp.tool_response_metadata,
      metadata.toolResponseMetadata,
      metadata.tool_response_metadata,
      metadata._meta,
    ),
    widgetState: firstDefined(
      explicitApp.widgetState,
      explicitApp.widget_state,
      contentApp.widgetState,
      contentApp.widget_state,
      metadata.widgetState,
      metadata.widget_state,
    ),
    metadata: {
      ...metadata,
      app: {
        ...explicitApp,
        ...contentApp,
      },
    },
  };
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeProviderSessionPayload(
  previous: Record<string, unknown>,
  payload: Record<string, unknown>,
  isClaudeCode: boolean,
  hasCliContext: boolean,
): Record<string, unknown> {
  const next = { ...previous, ...payload };
  if (!isClaudeCode || hasCliContext) return next;
  for (const key of [
    "context",
    "contextTokens",
    "context_tokens",
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "context_window",
    "usedTokens",
    "used_tokens",
    "windowTokens",
    "window_tokens",
  ]) {
    delete next[key];
  }
  const metadata = { ...recordPayload(next.metadata) };
  delete metadata.contextUsageSource;
  next.metadata = metadata;
  return next;
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = recordPayload(value);
    if (Object.keys(record).length) return record;
  }
  return {};
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringPayload(value);
    if (text) return text;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const text = stringPayload(value);
  if (!text || !/^[{[]/.test(text)) return {};
  try {
    return recordPayload(JSON.parse(text));
  } catch {
    return {};
  }
}

function isMcpAppMime(value: string): boolean {
  return /(?:mcp|openai|widget|skybridge|app)/i.test(value);
}

function isHtmlMime(value: string): boolean {
  return (
    value.includes("text/html") || value.includes("application/xhtml") || value.includes("+html")
  );
}

function looksLikeHtml(value: unknown): value is string {
  const text = stringPayload(value);
  return (
    /^<!doctype\s+html/i.test(text) ||
    /<(html|head|body|script|iframe|div|section|main|button|canvas|svg)(\s|>)/i.test(text)
  );
}

function safeEmbedSrc(value: string | undefined): string | undefined {
  if (!value || value.startsWith("ui://")) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && isLoopbackEmbedHostname(url.hostname)) return url.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

function isLoopbackEmbedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function titleFromSessionPayload(payload: Record<string, unknown>): string {
  return (
    stringPayload(payload.title) ||
    stringPayload(payload.name) ||
    stringPayload(payload.sessionTitle) ||
    stringPayload(payload.session_title) ||
    stringPayload(payload.sessionName) ||
    stringPayload(payload.session_name) ||
    stringPayload(payload.threadTitle) ||
    stringPayload(payload.thread_title) ||
    stringPayload(payload.conversationTitle) ||
    stringPayload(payload.conversation_title)
  );
}

function dispatch(sessionId: string, event: SessionEvent): void {
  const projection = projections.get(sessionId);
  const routedEvent: SessionEvent = {
    ...event,
    agentProviderId: event.agentProviderId ?? projection?.providerId,
    runId: event.runId ?? projection?.runId,
  };
  if (isStreamingDeltaEvent(routedEvent)) {
    queueStreamingDelta(sessionId, routedEvent);
    return;
  }
  flushStreamingDeltas(sessionId);
  useChatStore.getState().dispatchTo(sessionId, routedEvent);
}

function isStreamingDeltaEvent(event: SessionEvent): event is StreamingDeltaEvent {
  return (
    event.type === "assistant_delta" ||
    event.type === "reasoning_delta" ||
    event.type === "tool_delta"
  );
}

function queueStreamingDelta(sessionId: string, event: StreamingDeltaEvent): void {
  const key = streamingDeltaKey(sessionId, event);
  const pending = pendingStreamingDeltas.get(key);
  pendingStreamingDeltas.set(key, {
    sessionId,
    event: pending ? mergeStreamingDelta(pending.event, event) : event,
  });
  scheduleStreamingDeltaFlush();
}

function scheduleStreamingDeltaFlush(): void {
  if (streamingDeltaFlushHandle !== undefined) return;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    streamingDeltaFlushMode = "raf";
    streamingDeltaFlushHandle = window.requestAnimationFrame(() => {
      streamingDeltaFlushHandle = undefined;
      streamingDeltaFlushMode = undefined;
      flushStreamingDeltas();
    });
    return;
  }
  streamingDeltaFlushMode = "timeout";
  streamingDeltaFlushHandle = setTimeout(() => {
    streamingDeltaFlushHandle = undefined;
    streamingDeltaFlushMode = undefined;
    flushStreamingDeltas();
  }, 0);
}

function flushStreamingDeltas(sessionId?: string): void {
  if (pendingStreamingDeltas.size === 0) return;
  const ready: Array<{ key: string; sessionId: string; event: StreamingDeltaEvent }> = [];
  for (const [key, pending] of pendingStreamingDeltas) {
    if (sessionId && pending.sessionId !== sessionId) continue;
    ready.push({ key, ...pending });
  }
  for (const item of ready) pendingStreamingDeltas.delete(item.key);
  if (pendingStreamingDeltas.size === 0 && streamingDeltaFlushHandle !== undefined) {
    if (
      streamingDeltaFlushMode === "raf" &&
      typeof window !== "undefined" &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(streamingDeltaFlushHandle as number);
    } else {
      clearTimeout(streamingDeltaFlushHandle as ReturnType<typeof setTimeout>);
    }
    streamingDeltaFlushHandle = undefined;
    streamingDeltaFlushMode = undefined;
  }
  const eventsBySession = new Map<string, StreamingDeltaEvent[]>();
  for (const item of ready) {
    const events = eventsBySession.get(item.sessionId);
    if (events) events.push(item.event);
    else eventsBySession.set(item.sessionId, [item.event]);
  }
  const chat = useChatStore.getState();
  for (const [readySessionId, events] of eventsBySession) {
    chat.dispatchManyTo(readySessionId, events);
  }
}

function streamingDeltaKey(sessionId: string, event: StreamingDeltaEvent): string {
  return event.type === "tool_delta"
    ? `${sessionId}:${event.type}:${event.toolId}`
    : `${sessionId}:${event.type}:${event.blockId}`;
}

function mergeStreamingDelta(
  previous: StreamingDeltaEvent,
  next: StreamingDeltaEvent,
): StreamingDeltaEvent {
  if (previous.type !== next.type) return next;
  if (previous.type === "tool_delta" && next.type === "tool_delta") {
    return {
      ...next,
      id: previous.id,
      chunk: previous.chunk + next.chunk,
      order: previous.order ?? next.order,
    };
  }
  if (previous.type === "assistant_delta" && next.type === "assistant_delta") {
    return {
      ...next,
      id: previous.id,
      text: previous.text + next.text,
      order: previous.order ?? next.order,
    };
  }
  if (previous.type === "reasoning_delta" && next.type === "reasoning_delta") {
    return {
      ...next,
      id: previous.id,
      text: previous.text + next.text,
      order: previous.order ?? next.order,
    };
  }
  return next;
}
