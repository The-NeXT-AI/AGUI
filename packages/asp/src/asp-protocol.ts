import { randomUUID } from "node:crypto";
import {
  assertAspEnvelope,
  assertAspExtensionDescriptor,
  assertAspExtensionEvent,
} from "./asp-schema.js";
import { assertCanonicalAspEvent, validatedClientMessage } from "./asp-protocol-validation.js";
import {
  ASP_NAME,
  ASP_ERROR_CODES,
  ASP_VERSION,
  type AspApprovalDecision,
  type AspCheckpoint,
  type AspExtensionDescriptor,
  type AspExtensionEvent,
  type AspExtensionFallback,
  type AspInteractiveApp,
  type AspMessagePart,
  type AspMessagePartType,
  type AspModel,
  type AspProviderCapabilities,
  type AspProviderSession,
  type AspRpcErrorData,
  type AspQuestion,
  type AspSessionState,
  type AspTokenUsage,
  type AspToolSemantic,
  type AspToolEvent,
  type RunInput,
} from "./types.js";

export const ASP_JSON_RPC_VERSION = "2.0" as const;
export const ASP_CLIENT_INFO = {
  name: "agui",
  title: "AGUI",
  version: "0.1.0",
} as const;

export { assertCanonicalAspEvent, validatedClientMessage } from "./asp-protocol-validation.js";

const rawStandardExtensionDescriptors: AspExtensionDescriptor[] = [
  {
    id: "asp.ext.agents",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [
      { name: "list_agents", safety: "read" },
      { name: "select_agent", requiresRun: true, safety: "write" },
      { name: "invoke_agent", requiresRun: true, safety: "approval_required" },
      { name: "cancel_agent", requiresRun: true, safety: "write" },
    ],
    events: [
      { name: "agent.selected" },
      { name: "agent.started" },
      { name: "agent.message" },
      { name: "agent.tool" },
      { name: "agent.completed" },
      { name: "agent.failed" },
    ],
  },
  {
    id: "asp.ext.run-control",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [
      { name: "steer", requiresRun: true, safety: "write" },
      { name: "follow_up", requiresRun: true, safety: "write" },
      { name: "set_queue_mode", requiresRun: true, safety: "write" },
      { name: "compact", requiresRun: true, safety: "write" },
      { name: "set_model", requiresRun: true, safety: "write" },
      { name: "cycle_model", requiresRun: true, safety: "write" },
      { name: "set_effort", requiresRun: true, safety: "write" },
      { name: "cycle_effort", requiresRun: true, safety: "write" },
      { name: "set_session_title", requiresRun: true, safety: "write" },
      { name: "abort_current_step", requiresRun: true, safety: "write" },
    ],
    events: [
      { name: "queue.updated" },
      { name: "compaction.started" },
      { name: "compaction.completed" },
      { name: "model.changed" },
      { name: "effort.changed" },
      { name: "step.aborted" },
    ],
  },
  {
    id: "asp.ext.permissions",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [
      { name: "get_policy", safety: "read" },
      { name: "set_policy", safety: "approval_required" },
    ],
    events: [{ name: "policy.updated" }, { name: "permission.requested" }],
  },
  {
    id: "asp.ext.tools",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    events: [{ name: "tool.semantic" }],
  },
  {
    id: "asp.ext.mcp-apps",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [
      { name: "resources/read", safety: "read" },
      { name: "tools/call", requiresRun: true, safety: "write" },
    ],
  },
  {
    id: "asp.ext.ui",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [{ name: "respond", requiresRun: true, safety: "write" }],
    events: [
      { name: "ui.requested" },
      { name: "ui.updated" },
      { name: "ui.completed" },
      { name: "toast" },
    ],
  },
  {
    id: "asp.ext.hooks",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [
      { name: "list_hooks", safety: "read" },
      { name: "set_hooks", safety: "approval_required" },
    ],
    events: [{ name: "hook.started" }, { name: "hook.completed" }, { name: "hook.failed" }],
  },
  {
    id: "asp.ext.session-state",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [
      { name: "get_state", safety: "read" },
      { name: "get_messages", safety: "read" },
    ],
    events: [{ name: "state.updated" }],
  },
  {
    id: "asp.ext.multimodal",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
  },
  {
    id: "asp.ext.runtime",
    version: "0.1.0",
    stability: "experimental",
    fallback: "core",
    methods: [{ name: "get_runtime", safety: "read" }],
    events: [{ name: "runtime.updated" }],
  },
];

export const standardExtensionDescriptors: AspExtensionDescriptor[] =
  rawStandardExtensionDescriptors.map((extension) => ({
    ...extension,
    methods: extension.methods?.map((method) => ({
      inputSchema: { type: "object" },
      outputSchema: {},
      ...method,
    })),
    events: extension.events?.map((event) => ({
      payloadSchema: { type: "object" },
      ...event,
    })),
  }));

export const clientCapabilities: AspProviderCapabilities = {
  approvalModes: ["request", "auto", "full"],
  approvalScopes: ["command", "tool", "filesystem", "network", "sandbox"],
  artifacts: true,
  concurrentRuns: false,
  createSession: true,
  contentParts: [
    "text",
    "tool",
    "reasoning",
    "plan",
    "status",
    "resource",
    "artifact",
    "diff",
    "citation",
    "raw",
  ],
  contextWindow: true,
  deleteSession: true,
  diffs: true,
  extensions: standardExtensionDescriptors,
  humanInput: true,
  clientServices: {
    filesystem: { readTextFile: true, writeTextFile: true },
    terminal: {
      create: true,
      output: true,
      waitForExit: true,
      kill: true,
      release: true,
    },
    permissions: true,
    elicitation: true,
  },
  models: true,
  protocolVersions: [ASP_VERSION],
  resumeSession: true,
  closeSession: true,
  sessionHistory: true,
  sessions: true,
  speeds: ["default", "fast"],
  toolEvents: true,
  transports: ["stdio", "persistent-stdio", "websocket", "ssh"],
  workspace: true,
};

export function runMessage(
  input: RunInput,
  runId: string,
  advertisedCapabilities: AspProviderCapabilities = clientCapabilities,
): Record<string, unknown> {
  const attachments = input.attachments ?? [];
  const inputParts = input.inputParts?.length
    ? input.inputParts
    : [{ text: input.prompt, type: "text" }];
  const message = {
    additionalDeveloperInstructions: input.additionalDeveloperInstructions,
    approvalMode: mapApprovalMode(input.approvalMode),
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    attachments,
    clientCapabilities: advertisedCapabilities,
    cwd: input.cwd,
    conversationContext: input.conversationContext,
    effort: input.effort,
    extensions: input.extensions ?? [],
    input: {
      attachments,
      parts: inputParts,
      messages: [
        ...(input.conversationContext?.messages ?? []).map((message) => ({
          content: [{ content: message.content, id: message.id, type: "text" }],
          metadata: {
            conversationSeq: message.seq,
            participantId: message.participantId,
            handoffId: input.conversationContext?.handoffId,
            untrustedContext: true,
          },
          role: message.role,
        })),
        {
          content: [{ content: input.prompt, id: "user-message", type: "text" }],
          role: "user",
        },
      ],
    },
    method: "run",
    mcpServers: input.mcpServers,
    skills: input.skills,
    enabledAppExtensions: input.enabledAppExtensions,
    model: input.model,
    prompt: input.prompt,
    providerId: input.providerId,
    providerSessionId: input.providerSessionId,
    runId,
    speed: input.speed,
    preserveNativeEvents: input.preserveNativeEvents,
    threadId: input.uiSessionId,
    type: "run",
    version: ASP_VERSION,
  };
  const {
    asp: _asp,
    jsonrpc: _jsonrpc,
    method: _method,
    type: _type,
    version: _version,
    ...params
  } = message;
  return validatedClientMessage({ ...message, params });
}

export function extensionInvokeMessage(
  input: {
    extension: string;
    method: string;
    runId?: string;
    providerSessionId?: string;
    payload?: unknown;
  },
  id: string | number = randomUUID(),
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    clientCapabilities,
    id,
    method: "extension.invoke",
    params: {
      extension: input.extension,
      method: input.method,
      payload: input.payload,
      providerSessionId: input.providerSessionId,
      runId: input.runId,
    },
    type: "extension_invoke",
    version: ASP_VERSION,
  });
}

export function abortMessage(
  runId: string,
  reason = "Canceled by the client.",
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    method: "run.cancel",
    params: { runId, reason },
    reason,
    runId,
    type: "abort",
    version: ASP_VERSION,
  });
}

export function requestMessage(
  providerId: string,
  method:
    | "capabilities"
    | "initialize"
    | "new_session"
    | "close_session"
    | "delete_session"
    | "list_models"
    | "list_sessions"
    | "resume_session"
    | "session_messages"
    | "session_usage",
  params: Record<string, unknown> = {},
  id: string | number = randomUUID(),
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    clientCapabilities,
    id,
    method,
    providerId,
    params,
    type: method,
    version: ASP_VERSION,
    ...params,
  });
}

export function initializeMessage(
  providerId: string,
  id: string | number = randomUUID(),
  advertisedCapabilities: AspProviderCapabilities = clientCapabilities,
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    clientCapabilities: advertisedCapabilities,
    clientInfo: ASP_CLIENT_INFO,
    id,
    jsonrpc: ASP_JSON_RPC_VERSION,
    method: "initialize",
    params: {
      clientCapabilities: advertisedCapabilities,
      clientInfo: ASP_CLIENT_INFO,
      supportedProtocolVersions: [ASP_VERSION],
    },
    providerId,
    supportedProtocolVersions: [ASP_VERSION],
    type: "initialize",
    version: ASP_VERSION,
  });
}

export function rpcResultMessage(id: string | number, result: unknown): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    id,
    jsonrpc: ASP_JSON_RPC_VERSION,
    result,
    version: ASP_VERSION,
  });
}

export function rpcErrorMessage(
  id: string | number,
  error: {
    code?: number;
    message: string;
    data?: AspRpcErrorData;
  },
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    error: {
      code: error.code ?? ASP_ERROR_CODES.internalError,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    },
    id,
    jsonrpc: ASP_JSON_RPC_VERSION,
    version: ASP_VERSION,
  });
}

export function rpcApprovalResult(
  id: string | number,
  decision: AspApprovalDecision,
  message?: string,
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    id,
    result: {
      approved: decision === "allow" || decision === "allow-session" || decision === "allow-always",
      decision,
      ...(message ? { message } : {}),
    },
    version: ASP_VERSION,
  });
}

export function approvalResult(
  approvalId: string | undefined,
  method: string,
  decision: AspApprovalDecision,
  message?: string,
): Record<string, unknown> {
  return validatedClientMessage({
    approvalId,
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    decision,
    method,
    ...(message ? { message } : {}),
    type: "approval_result",
    version: ASP_VERSION,
  });
}

export function rpcQuestionResult(id: string | number, result: unknown): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    id,
    jsonrpc: ASP_JSON_RPC_VERSION,
    result,
    version: ASP_VERSION,
  });
}

export function questionResult(
  questionId: string | undefined,
  method: string | undefined,
  result: unknown,
): Record<string, unknown> {
  return validatedClientMessage({
    asp: ASP_NAME,
    jsonrpc: ASP_JSON_RPC_VERSION,
    method,
    questionId,
    result,
    type: "question_result",
    version: ASP_VERSION,
  });
}

export function getAspEvent(value: unknown): Record<string, unknown> | null {
  const message = record(value);
  assertAspEnvelope(message);
  const explicitType = string(message.type);
  if (explicitType && explicitType !== "run" && explicitType !== "abort") {
    assertCanonicalAspEvent(message);
    return message;
  }
  const method = string(message.method);
  if (!method) return null;
  if (method === "extension.event" || method === "extension_event") {
    const event = { ...record(message.params), type: "extension_event" };
    assertAspExtensionEvent(event);
    return event;
  }
  if (method === "event") {
    const event = record(message.params);
    assertCanonicalAspEvent(event);
    return event;
  }
  const type = methodToEventType(method);
  if (!type) return null;
  const event = { ...record(message.params), type };
  assertCanonicalAspEvent(event);
  return event;
}

export function normalizeExtensionEvent(value: unknown): AspExtensionEvent | null {
  const source = record(value);
  const extension = string(source.extension) || string(source.id);
  const event = string(source.event) || string(source.name) || string(source.type);
  if (!extension || !event) return null;
  return {
    extension,
    event: event === "extension_event" ? "event" : event,
    runId: string(source.runId) || string(source.run_id) || undefined,
    providerSessionId:
      string(source.providerSessionId) ||
      string(source.provider_session_id) ||
      string(source.sessionId) ||
      undefined,
    payload: source.payload ?? source.data ?? source.params,
    fallback: normalizeExtensionFallback(source.fallback) ?? "none",
    metadata: objectOrUndefined(source.metadata),
  };
}

export function normalizeSessionState(value: unknown): AspSessionState | null {
  const source = record(value);
  const candidates = sessionStateCandidates(source);
  const providerSessionId = firstString(candidates, [
    "providerSessionId",
    "provider_session_id",
    "sessionId",
    "sessionID",
    "session_id",
    "threadId",
    "threadID",
    "thread_id",
    "conversationId",
    "conversationID",
    "conversation_id",
    "id",
  ]);
  const title = firstString(candidates, [
    "title",
    "name",
    "sessionTitle",
    "session_title",
    "sessionName",
    "session_name",
    "threadTitle",
    "thread_title",
    "conversationTitle",
    "conversation_title",
  ]);
  const cwd = firstString(candidates, [
    "cwd",
    "directory",
    "projectPath",
    "project_path",
    "workspace",
    "worktree",
    "sessionDir",
    "session_dir",
  ]);
  const model = firstString(candidates, ["model", "modelId", "modelID", "model_id"]);
  const effort = firstString(candidates, [
    "effort",
    "reasoningEffort",
    "reasoning_effort",
    "thinkingLevel",
    "thinking_level",
  ]);
  const parentSessionId = firstString(candidates, [
    "parentSessionId",
    "parent_session_id",
    "parentId",
    "parent_id",
  ]);
  const queueSource = firstRecord(candidates, ["queue"]);
  const contextSource = firstRecord(candidates, ["context", "tokens", "tokenUsage", "token_usage"]);
  const usedTokens = firstNumber(
    [contextSource, ...candidates],
    [
      "usedTokens",
      "used_tokens",
      "contextTokens",
      "context_tokens",
      "totalTokens",
      "total_tokens",
      "inputTokens",
      "input_tokens",
    ],
  );
  const windowTokens = firstNumber(
    [contextSource, ...candidates],
    [
      "windowTokens",
      "window_tokens",
      "contextWindowTokens",
      "context_window_tokens",
      "contextWindow",
      "context_window",
    ],
  );
  const streaming = firstBoolean(candidates, ["streaming", "isStreaming", "is_streaming"]);
  const autoCompaction = firstBoolean(
    [contextSource, ...candidates],
    ["autoCompaction", "auto_compaction"],
  );
  const pending = firstNumber(
    [queueSource, ...candidates],
    ["pending", "pendingMessageCount", "pending_message_count"],
  );
  const queueMode = firstString([queueSource, ...candidates], ["mode", "queueMode", "queue_mode"]);
  const metadata = firstRecord(candidates, ["metadata", "meta"]);
  const checkpoints = normalizeCheckpoints(candidates);

  if (
    !providerSessionId &&
    !title &&
    !cwd &&
    !model &&
    !effort &&
    streaming === undefined &&
    usedTokens === undefined &&
    windowTokens === undefined &&
    !checkpoints.length
  ) {
    return null;
  }

  return {
    providerSessionId,
    title: title || undefined,
    cwd: cwd || undefined,
    model: model || undefined,
    effort: effort || undefined,
    streaming,
    queue:
      pending === undefined && !queueMode
        ? undefined
        : {
            pending: pending ?? 0,
            mode: queueMode || undefined,
          },
    context:
      usedTokens === undefined && windowTokens === undefined && autoCompaction === undefined
        ? undefined
        : {
            usedTokens,
            windowTokens,
            autoCompaction,
          },
    parentSessionId: parentSessionId || undefined,
    checkpoints: checkpoints.length ? checkpoints : undefined,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

function normalizeCheckpoints(candidates: Record<string, unknown>[]): AspCheckpoint[] {
  const raw = candidates.find((candidate) => Array.isArray(candidate.checkpoints))?.checkpoints;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): AspCheckpoint[] => {
    const source = record(value);
    const id = string(source.id) || string(source.checkpointId) || string(source.checkpoint_id);
    if (!id) return [];
    const metadata = objectOrUndefined(source.metadata);
    return [
      {
        id,
        title: string(source.title) || string(source.name) || undefined,
        createdAt: optionalNumber(source.createdAt ?? source.created_at),
        metadata,
      },
    ];
  });
}

export function normalizeExtensionFallback(
  value: unknown,
): AspExtensionFallback | "none" | undefined {
  if (value === "none") return "none";
  const source = record(value);
  const type = string(source.type);
  if (type === "message_delta") {
    const data = rawString(source.data) ?? rawString(source.delta) ?? rawString(source.text);
    return data === undefined ? undefined : { type, data };
  }
  if (type === "message_part") {
    const part = normalizeMessagePart(source.part ?? source.messagePart ?? source);
    return part ? { type, part } : undefined;
  }
  if (type === "tool_event") {
    return { type, toolEvent: normalizeToolEvent(source.toolEvent ?? source) };
  }
  if (type === "usage") {
    const usage = normalizeUsage(source.usage ?? source);
    return usage ? { type, usage, model: string(source.model) || undefined } : undefined;
  }
  if (type === "stdout" || type === "stderr") {
    const data = rawString(source.data) ?? rawString(source.text) ?? rawString(source.content);
    return data === undefined ? undefined : { type, data };
  }
  if (type === "error") {
    const message = string(source.message) || string(source.error);
    return message ? { type, message } : undefined;
  }
  return undefined;
}

export function normalizeMessageParts(value: unknown): AspMessagePart[] {
  if (Array.isArray(value)) {
    return value.map(normalizeMessagePart).filter((part): part is AspMessagePart => Boolean(part));
  }
  const source = record(value);
  for (const candidate of [
    source.parts,
    source.messageParts,
    source.message_parts,
    source.contentParts,
    source.content_parts,
    source.content,
  ]) {
    if (Array.isArray(candidate)) return normalizeMessageParts(candidate);
  }
  const part = normalizeMessagePart(value);
  return part ? [part] : [];
}

export function normalizeMessagePart(value: unknown): AspMessagePart | null {
  if (typeof value === "string") {
    return { content: value, id: randomUUID(), type: "text" };
  }

  const source = record(value);
  const type = normalizePartType(string(source.type) || string(source.kind));
  const id = string(source.id) || string(source.partId) || randomUUID();
  const metadata = objectOrUndefined(source.metadata);
  const title = string(source.title) || string(source.label) || undefined;
  const content = partContent(source);

  if (type === "tool") {
    const toolEvent = normalizeToolEvent(source.toolEvent ?? source.tool_event ?? source);
    return { id, toolEvent, type };
  }
  if (type === "reasoning" || type === "status" || type === "citation") {
    return {
      content: content || undefined,
      id,
      metadata,
      title,
      type,
      ...(type === "status" ? { status: string(source.status) || undefined } : {}),
      ...(type === "citation"
        ? { uri: string(source.uri) || string(source.url) || undefined }
        : {}),
    };
  }
  if (type === "plan") {
    return {
      content: content || undefined,
      id,
      items: stringArray(source.items),
      metadata,
      title,
      type,
    };
  }
  if (type === "resource" || type === "artifact") {
    const app = normalizeInteractiveApp(source, metadata);
    return {
      artifactId:
        type === "artifact"
          ? string(source.artifactId) || string(source.artifact_id) || undefined
          : undefined,
      app,
      content: content || undefined,
      id,
      metadata,
      mimeType: string(source.mimeType) || string(source.mime_type) || undefined,
      name: string(source.name) || undefined,
      path: string(source.path) || undefined,
      title,
      type,
      uri: string(source.uri) || string(source.url) || undefined,
    };
  }
  if (type === "diff") {
    if (!content) return null;
    return {
      content,
      id,
      language: string(source.language) || undefined,
      metadata,
      oldPath: string(source.oldPath) || string(source.old_path) || undefined,
      path: string(source.path) || undefined,
      title,
      type,
    };
  }
  if (type === "raw") {
    return { id, label: title, metadata, type, value: source.value ?? value };
  }
  if (!content) return null;
  return {
    content,
    format:
      source.format === "plain" ? "plain" : source.format === "markdown" ? "markdown" : undefined,
    id,
    metadata,
    title,
    type: "text",
  };
}

export function normalizeToolEvent(value: unknown): AspToolEvent {
  const source = record(value);
  return {
    children: Array.isArray(source.children) ? source.children.map(normalizeToolEvent) : undefined,
    error: string(source.error) || undefined,
    id: string(source.id) || string(source.toolCallId) || randomUUID(),
    input: source.input ?? source.arguments ?? source.params,
    kind: string(source.kind) || "tool",
    metadata: objectOrUndefined(source.metadata),
    name: string(source.name) || string(source.tool) || string(source.title) || "Tool call",
    output:
      rawString(source.output) ?? rawString(source.content) ?? rawString(source.delta) ?? undefined,
    parentId: string(source.parentId) || string(source.parent_id) || undefined,
    phase: normalizeToolPhase(string(source.phase)),
    semantic: normalizeToolSemantic(source.semantic ?? record(source.metadata).semantic),
    status: string(source.status) || undefined,
  };
}

function normalizeToolSemantic(value: unknown): AspToolSemantic | undefined {
  const source = record(value);
  const toolType = string(source.toolType) || string(source.tool_type);
  if (!toolType) return undefined;
  const diff = normalizeMessagePart(source.diff);
  const artifacts = normalizeMessageParts(source.artifacts);
  const resultKind = string(source.resultKind) || string(source.result_kind);
  return {
    toolType,
    operation: string(source.operation) || undefined,
    schemaRef: string(source.schemaRef) || string(source.schema_ref) || undefined,
    resultKind: ["text", "json", "diff", "diagnostics", "locations", "artifact"].includes(
      resultKind,
    )
      ? (resultKind as AspToolSemantic["resultKind"])
      : undefined,
    diff: diff ?? undefined,
    artifacts: artifacts.length ? artifacts : undefined,
  };
}

export function normalizeUsage(value: unknown): AspTokenUsage | undefined {
  const source = record(value);
  const info = record(source.info);
  const nested = record(
    source.usage ??
      source.tokenUsage ??
      source.token_usage ??
      info.lastTokenUsage ??
      info.last_token_usage ??
      info.usage ??
      info.tokenUsage ??
      info.token_usage ??
      info.totalTokenUsage ??
      info.total_token_usage,
  );
  const values = Object.keys(nested).length ? nested : source;
  const inputTokens = number(
    values.inputTokens ?? values.input_tokens ?? values.promptTokens ?? values.prompt_tokens,
  );
  const outputTokens = number(
    values.outputTokens ??
      values.output_tokens ??
      values.completionTokens ??
      values.completion_tokens,
  );
  const inputCachedTokens = number(
    values.inputCachedTokens ??
      values.input_cached_tokens ??
      values.cachedInputTokens ??
      values.cached_input_tokens ??
      values.cacheReadInputTokens ??
      values.cache_read_input_tokens,
  );
  const outputCachedTokens = number(
    values.outputCachedTokens ??
      values.output_cached_tokens ??
      values.cachedOutputTokens ??
      values.cached_output_tokens,
  );
  const totalTokens = number(values.totalTokens ?? values.total_tokens);
  const contextTokens = optionalNumber(
    values.contextTokens ?? values.context_tokens ?? values.usedTokens ?? values.used_tokens,
  );
  const contextWindowTokens = optionalNumber(
    values.contextWindowTokens ??
      values.context_window_tokens ??
      values.limitTokens ??
      values.limit_tokens ??
      source.modelContextWindow ??
      source.model_context_window ??
      info.modelContextWindow ??
      info.model_context_window,
  );
  const hasExplicitUsage = [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "inputCachedTokens",
    "input_cached_tokens",
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "outputCachedTokens",
    "output_cached_tokens",
    "cachedOutputTokens",
    "cached_output_tokens",
    "totalTokens",
    "total_tokens",
  ].some((key) => key in values);
  if (
    !hasExplicitUsage &&
    !inputTokens &&
    !outputTokens &&
    !inputCachedTokens &&
    !outputCachedTokens &&
    !totalTokens &&
    contextTokens === undefined &&
    contextWindowTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    inputCachedTokens,
    inputTokens,
    outputCachedTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
  };
}

export function normalizeCapabilities(value: unknown): AspProviderCapabilities {
  const top = record(value);
  const source = record(top.capabilities ?? top.result ?? value);
  return {
    ...source,
    approvalModes: enumArray(source.approvalModes ?? source.approval_modes, [
      "request",
      "auto",
      "full",
    ]),
    approvalScopes: stringArray(source.approvalScopes ?? source.approval_scopes),
    contentParts: enumArray(source.contentParts ?? source.content_parts, [
      "text",
      "tool",
      "reasoning",
      "plan",
      "status",
      "resource",
      "artifact",
      "diff",
      "citation",
      "raw",
    ]),
    extensions: normalizeExtensions(source.extensions ?? source.extension_descriptors),
    protocolVersions: stringArray(source.protocolVersions ?? source.protocol_versions) ?? [
      ASP_VERSION,
    ],
    reasoningEfforts: enumArray(source.reasoningEfforts ?? source.reasoning_efforts, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    slashCommands: normalizeSlashCommands(source.slashCommands ?? source.slash_commands),
    speeds: enumArray(source.speeds, ["default", "fast"]),
    transports: enumArray(source.transports, ["stdio", "persistent-stdio", "websocket", "ssh"]),
  } as AspProviderCapabilities;
}

export function normalizeModels(value: unknown): AspModel[] {
  const source = record(value);
  const result = record(source.result);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(source.data)
      ? source.data
      : Array.isArray(source.models)
        ? source.models
        : Array.isArray(result.data)
          ? result.data
          : Array.isArray(result.models)
            ? result.models
            : [];
  const models = items
    .map((item): AspModel | null => {
      if (typeof item === "string") return { id: item, model: item, displayName: item };
      const model = record(item);
      const name = string(model.model) || string(model.id) || string(model.value);
      if (!name) return null;
      return {
        id: string(model.id) || name,
        model: name,
        displayName: string(model.displayName) || string(model.label) || string(model.name) || name,
        isDefault: model.isDefault === true || model.default === true,
        hidden: model.hidden === true,
        contextWindowTokens: optionalNumber(
          model.contextWindowTokens ?? model.context_window_tokens ?? model.contextWindow,
        ),
        defaultReasoningEffort:
          normalizeEffort(
            model.defaultReasoningEffort ??
              model.default_reasoning_effort ??
              model.defaultReasoningLevel ??
              model.default_reasoning_level ??
              model.defaultEffort ??
              model.default_effort,
          ) ?? null,
        supportedReasoningEfforts: normalizeReasoningEfforts(
          model.supportedReasoningEfforts ??
            model.supported_reasoning_efforts ??
            model.reasoningEfforts ??
            model.reasoning_efforts ??
            model.supportEfforts ??
            model.support_efforts ??
            model.thinkingLevels ??
            model.thinking_levels,
        ),
        supportedSpeeds: enumArray(model.supportedSpeeds ?? model.supported_speeds, [
          "default",
          "fast",
        ]),
      };
    })
    .filter((model): model is AspModel => Boolean(model));
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function normalizeReasoningEfforts(value: unknown): AspModel["supportedReasoningEfforts"] {
  if (!Array.isArray(value)) return undefined;
  const efforts = value
    .map((item) => {
      if (typeof item === "string") return item;
      const source = record(item);
      return string(
        source.reasoningEffort ??
          source.reasoning_effort ??
          source.effort ??
          source.level ??
          source.value ??
          source.id,
      );
    })
    .map(normalizeEffort)
    .filter((effort): effort is NonNullable<AspModel["defaultReasoningEffort"]> => Boolean(effort));
  return efforts.length ? [...new Set(efforts)] : undefined;
}

export function normalizeSessions(value: unknown): AspProviderSession[] {
  const source = record(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(source.sessions)
      ? source.sessions
      : Array.isArray(record(source.result).sessions)
        ? (record(source.result).sessions as unknown[])
        : [];
  return items
    .map((item): AspProviderSession | null => {
      const session = record(item);
      const id =
        string(session.id) ||
        string(session.providerSessionId) ||
        string(session.sessionId) ||
        string(session.threadId) ||
        string(session.conversationId) ||
        string(session.conversation_id);
      if (!id) return null;
      const usage = normalizeUsage(
        session.usage ??
          session.tokenUsage ??
          session.token_usage ??
          record(session.info).usage ??
          record(session.metadata).usage,
      );
      const context = normalizeSessionContext(session, usage);
      return {
        id,
        title:
          string(session.title) ||
          string(session.sessionTitle) ||
          string(session.session_title) ||
          string(session.threadTitle) ||
          string(session.thread_title) ||
          string(session.threadName) ||
          string(session.thread_name) ||
          string(session.conversationTitle) ||
          string(session.conversation_title) ||
          string(session.name) ||
          id,
        context,
        createdAt: optionalNumber(session.createdAt ?? session.created_at),
        updatedAt: optionalNumber(session.updatedAt ?? session.updated_at),
        cwd: string(session.cwd) || undefined,
        projectPath: string(session.projectPath) || string(session.project_path) || undefined,
        projectName: string(session.projectName) || string(session.project_name) || undefined,
        model: string(session.model) || undefined,
        providerId: string(session.providerId) || undefined,
        usage,
        metadata: objectOrUndefined(session.metadata),
      };
    })
    .filter((session): session is AspProviderSession => Boolean(session));
}

function normalizeSessionContext(
  session: Record<string, unknown>,
  usage: AspTokenUsage | undefined,
): AspProviderSession["context"] | undefined {
  const source = firstRecord([session, record(session.metadata)], ["context", "tokens"]);
  const usedTokens =
    firstNumber(
      [source, session],
      [
        "usedTokens",
        "used_tokens",
        "contextTokens",
        "context_tokens",
        "totalTokens",
        "total_tokens",
        "inputTokens",
        "input_tokens",
      ],
    ) ?? usage?.contextTokens;
  const windowTokens =
    firstNumber(
      [source, session],
      [
        "windowTokens",
        "window_tokens",
        "contextWindowTokens",
        "context_window_tokens",
        "modelContextWindow",
        "model_context_window",
        "contextWindow",
        "context_window",
        "limitTokens",
        "limit_tokens",
      ],
    ) ?? usage?.contextWindowTokens;
  const autoCompaction = firstBoolean([source, session], ["autoCompaction", "auto_compaction"]);
  if (usedTokens === undefined && windowTokens === undefined && autoCompaction === undefined) {
    return undefined;
  }
  return { usedTokens, windowTokens, autoCompaction };
}

export function normalizeQuestions(value: unknown): AspQuestion[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [{ question: value }]
      : [];
  return values
    .map((item, index): AspQuestion | null => {
      const source = record(item);
      const question = string(source.question) || string(source.message) || string(source.text);
      if (!question) return null;
      const control = normalizeQuestionControl(
        source.control ?? source.inputType ?? source.input_type ?? source.type ?? source.kind,
      );
      const options = Array.isArray(source.options)
        ? source.options
            .map((option) => {
              const entry = record(option);
              const label = string(entry.label) || string(entry.value);
              return label
                ? {
                    label,
                    value: string(entry.value) || undefined,
                    description: string(entry.description) || undefined,
                    disabled: entry.disabled === true || undefined,
                    imageUri:
                      string(entry.imageUri) ||
                      string(entry.image_uri) ||
                      string(entry.image) ||
                      string(entry.thumbnailUri) ||
                      string(entry.thumbnail_uri) ||
                      undefined,
                    preview: string(entry.preview) || undefined,
                    metadata: objectOrUndefined(entry.metadata),
                  }
                : null;
            })
            .filter((option): option is NonNullable<typeof option> => Boolean(option))
        : [];
      return {
        id: string(source.id) || `question-${index}`,
        question,
        header: string(source.header) || string(source.title) || undefined,
        control,
        multiSelect:
          control === "multi_select" || source.multiSelect === true || source.multi_select === true,
        allowCustomAnswer: source.allowCustomAnswer === true || source.allow_custom_answer === true,
        defaultValue: normalizeQuestionDefault(
          source.defaultValue ?? source.default_value ?? source.value,
          control === "multi_select" || source.multiSelect === true || source.multi_select === true,
        ),
        description: string(source.description) || string(source.help) || undefined,
        required: source.required === true || undefined,
        options: options.length ? options : undefined,
        placeholder: string(source.placeholder) || undefined,
        preview: string(source.preview) || undefined,
        metadata: objectOrUndefined(source.metadata),
      };
    })
    .filter((question): question is AspQuestion => Boolean(question));
}

export function visiblePartText(part: AspMessagePart): string {
  if (
    part.type === "text" ||
    part.type === "reasoning" ||
    part.type === "status" ||
    part.type === "citation"
  ) {
    return part.content ?? "";
  }
  if (part.type === "plan") {
    return part.content || part.items?.map((item) => `- ${item}`).join("\n") || "";
  }
  if (part.type === "diff") return part.content;
  return "";
}

export function rawMessageId(value: unknown): string | number | undefined {
  const id = record(value).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

export function stringProperty(value: unknown, key: string): string {
  return string(record(value)[key]);
}

export function rawStringProperty(value: unknown, key: string): string | undefined {
  return rawString(record(value)[key]);
}

export function eventRecord(value: unknown): Record<string, unknown> {
  return record(value);
}

function sessionStateCandidates(source: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const push = (value: unknown) => {
    const item = record(value);
    if (Object.keys(item).length && !candidates.includes(item)) candidates.push(item);
  };
  push(source.state);
  push(source.session);
  push(source.thread);
  push(source.conversation);
  push(source.payload);
  push(source.data);
  push(source.result);
  push(source.message);
  for (const item of [...candidates]) {
    push(item.state);
    push(item.session);
    push(item.thread);
    push(item.conversation);
    push(item.payload);
    push(item.data);
    push(item.result);
    push(item.message);
  }
  push(source);
  return candidates;
}

function firstString(candidates: Record<string, unknown>[], keys: string[]): string {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = string(candidate[key]);
      if (value) return value;
    }
  }
  return "";
}

function firstNumber(candidates: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = optionalNumber(candidate[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstBoolean(candidates: Record<string, unknown>[], keys: string[]): boolean | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
}

function firstRecord(
  candidates: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown> {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = objectOrUndefined(candidate[key]);
      if (value) return value;
    }
  }
  return {};
}

function methodToEventType(method: string): string {
  const normalized = method.replace(/^event[/:.]/, "").replace(/^agent[/:.]/, "");
  const lower = normalized.toLowerCase();
  if (["message_delta", "message.delta", "delta", "assistant_message"].includes(normalized)) {
    return "message_delta";
  }
  if (
    ["message_part", "message.part", "content_part", "content.part", "part"].includes(normalized)
  ) {
    return "message_part";
  }
  if (["tool_event", "tool.event", "tool"].includes(normalized)) return "tool_event";
  if (["approval_request", "approval.request", "request_approval"].includes(normalized)) {
    return "approval_request";
  }
  if (
    [
      "question_request",
      "question.request",
      "request_question",
      "request_user_input",
      "human_input",
      "human.input",
      "ask_user",
      "ask.user",
    ].includes(normalized) ||
    lower === "askuserquestion"
  ) {
    return "question_request";
  }
  if (["run_finished", "run.finished", "finished", "result"].includes(normalized)) {
    return "run_finished";
  }
  if (["stdout", "stderr", "error", "status", "artifact", "diff", "usage"].includes(normalized)) {
    return normalized;
  }
  if (["extension_event", "extension.event"].includes(normalized)) return "extension_event";
  if (
    [
      "session_state",
      "session.state",
      "session/state",
      "session.updated",
      "session/updated",
      "session_update",
      "session.title",
      "session/title",
      "session.title.updated",
      "session/title/updated",
      "session_title",
      "session_title_updated",
      "state.updated",
      "state/updated",
      "thread.updated",
      "thread/updated",
      "thread_update",
      "thread.title",
      "thread/title",
      "thread.title.updated",
      "thread/title/updated",
      "thread_title",
      "thread_title_updated",
      "conversation.updated",
      "conversation/updated",
      "conversation_update",
      "conversation.title",
      "conversation/title",
      "conversation.title.updated",
      "conversation/title/updated",
      "conversation_title",
      "conversation_title_updated",
      "title",
      "title_updated",
    ].includes(normalized)
  ) {
    return "session_state";
  }
  if (
    [
      "token_usage",
      "token.usage",
      "turn/usage",
      "turn.usage",
      "turn/usageUpdated",
      "turn.usageUpdated",
      "thread/tokenUsage/updated",
      "thread.tokenUsage.updated",
    ].includes(normalized)
  ) {
    return "usage";
  }
  if (["models", "model_list", "list_models_result"].includes(normalized)) return "models";
  if (["capabilities", "capability_list"].includes(normalized)) return "capabilities";
  if (["sessions", "session_list", "list_sessions_result"].includes(normalized)) {
    return "sessions";
  }
  if (["session_messages", "session.messages", "session_history", "history"].includes(normalized)) {
    return "session_messages";
  }
  if (["resume_session", "session_resumed", "restore_session"].includes(normalized)) {
    return "resume_session";
  }
  return "";
}

export function normalizeInteractiveApp(
  source: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): AspInteractiveApp | undefined {
  const meta = metadata ?? {};
  const openaiMeta = record(meta._meta);
  const uiMeta = record(meta.ui);
  const metaUiMeta = record(openaiMeta.ui);
  const app = [
    source.app,
    source.mcpApp,
    source.mcp_app,
    source.ui,
    source.widget,
    meta.app,
    meta.mcpApp,
    meta.mcp_app,
    meta.widget,
    uiMeta.app,
    openaiMeta.app,
    openaiMeta.mcpApp,
    openaiMeta.widget,
  ].reduce<Record<string, unknown>>((acc, value) => {
    const item = record(value);
    return Object.keys(item).length ? { ...acc, ...item } : acc;
  }, {});
  const outputTemplate =
    string(meta["openai/outputTemplate"]) ||
    string(openaiMeta["openai/outputTemplate"]) ||
    string(meta["ui.resourceUri"]) ||
    string(metaUiMeta.resourceUri) ||
    string(uiMeta.resourceUri);
  const resourceUri =
    string(app.resourceUri) ||
    string(app.resource_uri) ||
    outputTemplate ||
    (string(source.uri).startsWith("ui://") ? string(source.uri) : "");
  const title = string(app.title) || string(source.title) || string(source.name);
  const html = string(app.html) || string(app.srcDoc) || string(app.srcdoc);
  const src =
    string(app.src) ||
    string(app.url) ||
    string(app.uri) ||
    string(app.resourceUri) ||
    outputTemplate;
  const height =
    optionalNumber(app.height) ??
    optionalNumber(app.defaultHeight) ??
    optionalNumber(app.maxHeight);
  const hasApp = Object.keys(app).length > 0 || Boolean(outputTemplate) || Boolean(resourceUri);
  if (!hasApp && !html && !src && !resourceUri && height === undefined) return undefined;
  return {
    ...app,
    ...(title ? { title } : {}),
    ...(html ? { html } : {}),
    ...(src ? { src } : {}),
    ...(resourceUri ? { uri: resourceUri, resourceUri } : {}),
    ...(string(app.server) || string(app.serverName) || string(meta.server) || string(source.server)
      ? {
          server:
            string(app.server) ||
            string(app.serverName) ||
            string(meta.server) ||
            string(source.server),
        }
      : {}),
    ...(height !== undefined ? { height } : {}),
    ...(app.toolInput !== undefined || app.tool_input !== undefined
      ? { toolInput: app.toolInput ?? app.tool_input }
      : {}),
    ...(app.toolOutput !== undefined || app.structuredContent !== undefined
      ? { toolOutput: app.toolOutput ?? app.structuredContent }
      : {}),
    ...(app.toolResponseMetadata !== undefined || app.tool_response_metadata !== undefined
      ? { toolResponseMetadata: app.toolResponseMetadata ?? app.tool_response_metadata }
      : {}),
    ...(app.widgetState !== undefined || app.widget_state !== undefined
      ? { widgetState: app.widgetState ?? app.widget_state }
      : {}),
  };
}

function normalizeQuestionDefault(value: unknown, multi: boolean): string | string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.map(string).filter(Boolean);
    return values.length ? values : undefined;
  }
  const text = string(value);
  if (!text) return undefined;
  return multi ? [text] : text;
}

function normalizePartType(value: string): AspMessagePartType {
  if (
    [
      "artifact",
      "citation",
      "diff",
      "plan",
      "raw",
      "reasoning",
      "resource",
      "status",
      "text",
      "tool",
    ].includes(value)
  ) {
    return value as AspMessagePartType;
  }
  if (value === "thinking" || value === "thought") return "reasoning";
  if (["file", "image", "audio", "link"].includes(value)) return "resource";
  if (["app", "mcp_app", "mcp-app", "mcpapp", "ui", "widget"].includes(value)) {
    return "artifact";
  }
  if (value === "patch") return "diff";
  return "text";
}

function normalizeToolPhase(value: string): AspToolEvent["phase"] {
  return ["started", "updated", "delta", "completed"].includes(value)
    ? (value as AspToolEvent["phase"])
    : "updated";
}

function normalizeQuestionControl(value: unknown): AspQuestion["control"] {
  const control = string(value)
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (["text", "input", "textarea"].includes(control)) return "text";
  if (["single_select", "single", "radio", "choice"].includes(control)) {
    return "single_select";
  }
  if (["multi_select", "multi", "checkbox", "checkboxes"].includes(control)) {
    return "multi_select";
  }
  if (["dropdown", "select"].includes(control)) return "dropdown";
  return undefined;
}

function normalizeSlashCommands(value: unknown): AspProviderCapabilities["slashCommands"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = record(item);
      const name = string(source.name) || string(source.command) || string(source.id);
      return name
        ? {
            name: name.replace(/^\//, ""),
            title: string(source.title) || undefined,
            description: string(source.description) || undefined,
            insertText: string(source.insertText) || string(source.insert_text) || undefined,
            category: string(source.category) || undefined,
          }
        : null;
    })
    .filter((command): command is NonNullable<typeof command> => Boolean(command));
}

function normalizeExtensions(value: unknown): AspExtensionDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const extensions = value
    .map((item): AspExtensionDescriptor | null => {
      const source = record(item);
      const id = string(source.id) || string(source.extension);
      const version = string(source.version) || "0.1.0";
      if (!id) return null;
      const stability = string(source.stability);
      const fallback = string(source.fallback);
      return {
        id,
        version,
        stability: ["stable", "experimental", "vendor"].includes(stability)
          ? (stability as AspExtensionDescriptor["stability"])
          : id.startsWith("vendor.")
            ? "vendor"
            : "experimental",
        requiresCore: stringArray(source.requiresCore ?? source.requires_core),
        methods: normalizeExtensionMethods(source.methods),
        events: normalizeExtensionEvents(source.events),
        schemas: objectOrUndefined(source.schemas),
        fallback: ["core", "raw", "none"].includes(fallback)
          ? (fallback as AspExtensionDescriptor["fallback"])
          : undefined,
        metadata: objectOrUndefined(source.metadata),
      };
    })
    .filter((item): item is AspExtensionDescriptor => Boolean(item));
  for (const extension of extensions) assertAspExtensionDescriptor(extension);
  return extensions.length ? extensions : undefined;
}

function normalizeExtensionMethods(value: unknown): AspExtensionDescriptor["methods"] {
  if (!Array.isArray(value)) return undefined;
  const methods: NonNullable<AspExtensionDescriptor["methods"]> = [];
  for (const item of value) {
    const source = record(item);
    const name = typeof item === "string" ? item : string(source.name) || string(source.method);
    if (!name) continue;
    const safety = string(source.safety);
    methods.push({
      name,
      description: string(source.description) || undefined,
      inputSchema: objectOrUndefined(source.inputSchema ?? source.input_schema),
      outputSchema: objectOrUndefined(source.outputSchema ?? source.output_schema),
      requiresRun: source.requiresRun === true || source.requires_run === true,
      safety: ["read", "write", "approval_required"].includes(safety)
        ? (safety as "read" | "write" | "approval_required")
        : undefined,
    });
  }
  return methods.length ? methods : undefined;
}

function normalizeExtensionEvents(value: unknown): AspExtensionDescriptor["events"] {
  if (!Array.isArray(value)) return undefined;
  const events: NonNullable<AspExtensionDescriptor["events"]> = [];
  for (const item of value) {
    const source = record(item);
    const name = typeof item === "string" ? item : string(source.name) || string(source.event);
    if (!name) continue;
    events.push({
      name,
      description: string(source.description) || undefined,
      payloadSchema: objectOrUndefined(source.payloadSchema ?? source.payload_schema),
    });
  }
  return events.length ? events : undefined;
}

function normalizeEffort(value: unknown) {
  const effort = string(value);
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
    ? (effort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : undefined;
}

function mapApprovalMode(value: RunInput["approvalMode"]): "request" | "auto" | "full" {
  if (value === "full-auto") return "full";
  if (value === "auto-edit") return "auto";
  return "request";
}

function partContent(value: Record<string, unknown>): string {
  return (
    rawString(value.content) ??
    rawString(value.text) ??
    rawString(value.markdown) ??
    rawString(value.data) ??
    rawString(value.delta) ??
    ""
  );
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const items = (stringArray(value) ?? []).filter((item): item is T => allowed.includes(item as T));
  return items.length ? items : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(string).filter(Boolean);
  return items.length ? items : undefined;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const result = record(value);
  return Object.keys(result).length ? result : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: unknown): number {
  return optionalNumber(value) ?? 0;
}
