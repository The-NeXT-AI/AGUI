export const ASP_NAME = "agent-server-protocol";
export const ASP_VERSION = "1";

export const ASP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  canceled: -32800,
  approvalDenied: -32001,
  resourceNotFound: -32002,
  capabilityNotNegotiated: -32003,
  protocolVersionMismatch: -32004,
} as const;

export type AspErrorCode = (typeof ASP_ERROR_CODES)[keyof typeof ASP_ERROR_CODES] | number;
export type AspStopReason =
  "end_turn" | "canceled" | "error" | "timeout" | "max_tokens" | "max_turns" | "refusal";

export type AspRpcErrorData = {
  retryable?: boolean;
  details?: unknown;
  method?: string;
  runId?: string;
  providerSessionId?: string;
};

export type AspRpcError = {
  code: AspErrorCode;
  message: string;
  data?: AspRpcErrorData;
};

export type AspImplementation = {
  name: string;
  version: string;
  title?: string;
  url?: string;
};

export type AspClientServiceCapabilities = {
  filesystem?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: {
    create?: boolean;
    output?: boolean;
    waitForExit?: boolean;
    kill?: boolean;
    release?: boolean;
  };
  permissions?: boolean;
  elicitation?: boolean;
};

export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";
export type AspApprovalDecision = "allow" | "allow-session" | "allow-always" | "deny" | "cancel";
export type AspProviderTransport = "stdio" | "persistent-stdio" | "websocket" | "ssh";
export type AspReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AspRunSpeed = "default" | "fast";

export type AspExtensionStability = "stable" | "experimental" | "vendor";
export type AspExtensionFallbackMode = "core" | "raw" | "none";

export type AspExtensionMethodDescriptor = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiresRun?: boolean;
  safety?: "read" | "write" | "approval_required";
};

export type AspExtensionEventDescriptor = {
  name: string;
  description?: string;
  payloadSchema?: Record<string, unknown>;
};

export type AspExtensionDescriptor = {
  id: string;
  version: string;
  stability: AspExtensionStability;
  requiresCore?: string[];
  methods?: AspExtensionMethodDescriptor[];
  events?: AspExtensionEventDescriptor[];
  schemas?: Record<string, unknown>;
  fallback?: AspExtensionFallbackMode;
  metadata?: Record<string, unknown>;
};

export type AspExtensionUse = {
  id: string;
  version?: string;
  options?: Record<string, unknown>;
};

export type AspMcpServerRef = {
  id: string;
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  type?: "http" | "sse" | "stdio" | "streamablehttp";
  url?: string;
  metadata?: Record<string, unknown>;
};

export type AspSkillRef = {
  id: string;
  name: string;
  description?: string;
  path: string;
  manifestPath?: string;
  sourceExtensionId?: string;
  metadata?: Record<string, unknown>;
};

export type AspInputPart =
  | { type: "text"; text: string }
  | { type: "file_ref"; path: string; mimeType?: string }
  | { type: "directory_ref"; path: string }
  | { type: "image_ref"; path: string; mimeType?: string }
  | { type: "image_base64"; data: string; mimeType: string }
  | { type: "uri"; uri: string; mimeType?: string }
  | { type: "raw"; protocol: string; value: unknown };

export type AspConversationContextMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  participantId?: string;
  agentName?: string;
  attachments?: Array<{
    kind: "image" | "file";
    name: string;
    mimeType?: string;
    path?: string;
    size?: number;
  }>;
  truncated?: boolean;
};

export type AspConversationArtifact = {
  id: string;
  seq: number;
  kind: "plan" | "tool" | "terminal" | "diff" | "resource" | "artifact";
  title: string;
  summary?: string;
  path?: string;
  uri?: string;
  participantId?: string;
  truncated?: boolean;
};

export type AspConversationFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  sourceBlockId?: string;
  /** Renderer-to-runtime source only. The runtime replaces this with a read-only snapshot. */
  sourcePath?: string;
  /** Local read-only snapshot path prepared by the runtime for native adapters. */
  snapshotPath?: string;
  uri: string;
  availability?: "pending" | "ready" | "missing" | "too_large";
};

/**
 * Structured, untrusted conversation context supplied by an orchestrating UI.
 * Adapters must keep this data at user/message level; it is never developer policy.
 */
export type AspConversationContext = {
  schemaVersion: "1";
  handoffId: string;
  workItemId: string;
  fromParticipantId?: string;
  toParticipantId: string;
  sourceSeq: number;
  highWatermarkSeq: number;
  objective: string;
  requestedAction: "continue" | "review" | "investigate" | "take_over";
  digest: string;
  messages: AspConversationContextMessage[];
  artifacts?: AspConversationArtifact[];
  files?: AspConversationFile[];
  omitted?: {
    itemCount: number;
    summary: string;
  };
};

export type AspPermissionRule = {
  effect: "allow" | "ask" | "deny";
  target:
    | { kind: "tool"; tool: string; operation?: string }
    | { kind: "command"; command?: string; pattern?: string }
    | { kind: "filesystem"; path?: string; operation?: "read" | "write" | "delete" }
    | { kind: "network"; host?: string; method?: string }
    | { kind: "agent"; agentId?: string; operation?: "select" | "invoke" }
    | { kind: "mcp"; server?: string; tool?: string };
  lifetime?: "once" | "session" | "workspace" | "always";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type AspPermissionPolicy = {
  defaultEffect?: "allow" | "ask" | "deny";
  rules: AspPermissionRule[];
};

export type AspAgentProfile = {
  id: string;
  name: string;
  role: "primary" | "subagent" | "mode" | "task";
  description?: string;
  defaultModel?: string;
  tools?: string[];
  permissions?: AspPermissionPolicy;
  mcpServers?: AspMcpServerRef[];
  isolation?: "shared" | "worktree" | "process" | "container";
  memory?: "shared" | "isolated" | "ephemeral";
  background?: boolean;
  metadata?: Record<string, unknown>;
};

export type AspToolSemantic = {
  toolType: string;
  operation?: string;
  schemaRef?: string;
  resultKind?: "text" | "json" | "diff" | "diagnostics" | "locations" | "artifact";
  diff?: AspMessagePart;
  artifacts?: AspMessagePart[];
};

export type AspCheckpoint = {
  id: string;
  title?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
};

export type AspSessionState = {
  providerSessionId?: string;
  title?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  streaming?: boolean;
  queue?: {
    pending: number;
    mode?: string;
  };
  context?: {
    usedTokens?: number;
    windowTokens?: number;
    autoCompaction?: boolean;
  };
  parentSessionId?: string;
  checkpoints?: AspCheckpoint[];
  metadata?: Record<string, unknown>;
};

export type AspSlashCommand = {
  name: string;
  title?: string;
  description?: string;
  insertText?: string;
  category?: string;
};

export type AspProviderCapabilities = {
  approvalModes?: Array<"request" | "auto" | "full">;
  approvalScopes?: string[];
  artifacts?: boolean;
  concurrentRuns?: boolean;
  createSession?: boolean;
  contentParts?: AspMessagePartType[];
  contextWindow?: boolean;
  deleteSession?: boolean;
  diffs?: boolean;
  extensions?: AspExtensionDescriptor[];
  humanInput?: boolean;
  clientServices?: AspClientServiceCapabilities;
  models?: boolean;
  protocolVersions?: string[];
  reasoningEfforts?: AspReasoningEffort[];
  resumeSession?: boolean;
  closeSession?: boolean;
  runtimeAdapter?: string;
  sessionHistory?: boolean;
  sessions?: boolean;
  slashCommands?: AspSlashCommand[];
  speeds?: AspRunSpeed[];
  toolEvents?: boolean;
  transports?: AspProviderTransport[];
  wireProtocol?: string;
  workspace?: boolean;
};

export type AspModel = {
  id: string;
  model: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
  contextWindowTokens?: number;
  defaultReasoningEffort?: AspReasoningEffort | null;
  supportedReasoningEfforts?: AspReasoningEffort[];
  supportedSpeeds?: AspRunSpeed[];
};

export type AspProvider = {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  transport: AspProviderTransport;
  url?: string;
  installCommand?: string;
  timeoutMs?: number;
  capabilities?: AspProviderCapabilities;
  models?: AspModel[];
};

export type AspAttachment = {
  kind: "directory" | "file" | "other";
  name: string;
  path: string;
  /** Identifies a prior-turn file that the runtime must replace with its handoff snapshot. */
  handoffFileId?: string;
};

export type AspTokenUsage = {
  contextTokens?: number;
  contextWindowTokens?: number;
  inputCachedTokens: number;
  inputTokens: number;
  outputCachedTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AspToolEventPhase = "started" | "updated" | "delta" | "completed";

export type AspToolEvent = {
  children?: AspToolEvent[];
  error?: string;
  id: string;
  input?: unknown;
  kind: string;
  metadata?: Record<string, unknown>;
  name: string;
  output?: string;
  parentId?: string;
  phase: AspToolEventPhase;
  semantic?: AspToolSemantic;
  status?: string;
};

export type AspMessagePartType =
  | "artifact"
  | "citation"
  | "diff"
  | "plan"
  | "raw"
  | "reasoning"
  | "resource"
  | "status"
  | "text"
  | "tool";

export type AspInteractiveApp = {
  title?: string;
  html?: string;
  src?: string;
  uri?: string;
  resourceUri?: string;
  height?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  widgetState?: unknown;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AspMessagePart =
  | {
      content: string;
      format?: "markdown" | "plain";
      id: string;
      metadata?: Record<string, unknown>;
      title?: string;
      type: "text";
    }
  | {
      content?: string;
      id: string;
      metadata?: Record<string, unknown>;
      title?: string;
      type: "reasoning" | "status" | "citation";
      status?: string;
      uri?: string;
    }
  | {
      content?: string;
      id: string;
      items?: string[];
      metadata?: Record<string, unknown>;
      title?: string;
      type: "plan";
    }
  | {
      artifactId?: string;
      content?: string;
      id: string;
      app?: AspInteractiveApp;
      metadata?: Record<string, unknown>;
      mimeType?: string;
      name?: string;
      path?: string;
      title?: string;
      type: "resource" | "artifact";
      uri?: string;
    }
  | {
      content: string;
      id: string;
      language?: string;
      metadata?: Record<string, unknown>;
      oldPath?: string;
      path?: string;
      title?: string;
      type: "diff";
    }
  | {
      id: string;
      label?: string;
      metadata?: Record<string, unknown>;
      type: "raw";
      value: unknown;
    }
  | {
      id: string;
      toolEvent: AspToolEvent;
      type: "tool";
    };

export type AspProviderSession = {
  id: string;
  title: string;
  context?: {
    usedTokens?: number;
    windowTokens?: number;
    autoCompaction?: boolean;
  };
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  projectPath?: string;
  projectName?: string;
  model?: string;
  providerId?: string;
  usage?: AspTokenUsage;
  metadata?: Record<string, unknown>;
  status?: "active" | "closed" | "unknown";
};

export type AspMessageRecord = {
  id: string;
  role: "assistant" | "user";
  content: string;
  createdAt: number;
  parts?: AspMessagePart[];
  toolEvents?: AspToolEvent[];
  usage?: AspTokenUsage;
  metadata?: Record<string, unknown>;
};

export type AspQuestionOption = {
  label: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  imageUri?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
};

export type AspQuestion = {
  id?: string;
  question: string;
  header?: string;
  control?: "dropdown" | "multi_select" | "single_select" | "text";
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  defaultValue?: string | string[];
  description?: string;
  required?: boolean;
  options?: AspQuestionOption[];
  placeholder?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
};

export type AspQuestionAnswer = {
  questionId?: string;
  question: string;
  header?: string;
  answer: string | string[];
  customAnswer?: string;
  selectedOptions?: AspQuestionOption[];
};

export type AspQuestionResponse = {
  answers?: AspQuestionAnswer[];
  app?: {
    title?: string;
    server?: string;
    resourceUri?: string;
    documentId?: string;
    widgetState?: unknown;
    modelContext?: unknown;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  canceled?: boolean;
  unanswered?: boolean;
  metadata?: Record<string, unknown>;
  result?: unknown;
};

export type RunInput = {
  uiSessionId: string;
  /** Client-generated request identity used to reject events from an older run. */
  clientRequestId?: string;
  providerId: string;
  providerSessionId?: string;
  cwd: string;
  prompt: string;
  conversationContext?: AspConversationContext;
  attachments?: AspAttachment[];
  inputParts?: AspInputPart[];
  approvalMode: ApprovalMode;
  model?: string;
  effort?: AspReasoningEffort;
  speed?: AspRunSpeed;
  additionalDeveloperInstructions?: string;
  extensions?: AspExtensionUse[];
  mcpServers?: Record<string, unknown> | AspMcpServerRef[];
  skills?: AspSkillRef[];
  enabledAppExtensions?: string[];
  /** Emit vendor native.event extension events with the original native payload. */
  preserveNativeEvents?: boolean;
};

export type RunResult = {
  success: boolean;
  canceled?: boolean;
  runId: string;
  providerSessionId?: string;
  output: string;
  durationMs: number;
  exitCode: number | null;
  usage?: AspTokenUsage;
  model?: string;
  stopReason?: AspStopReason;
};

export type AspRunEvent =
  | { type: "run_started"; runId: string; providerSessionId?: string }
  | {
      type: "message_delta";
      runId: string;
      data: string;
      itemId?: string;
      providerSessionId?: string;
    }
  | { type: "message_part"; runId: string; part: AspMessagePart; providerSessionId?: string }
  | { type: "tool_event"; runId: string; toolEvent: AspToolEvent; providerSessionId?: string }
  | {
      type: "session_state";
      runId: string;
      state: AspSessionState;
      providerSessionId?: string;
    }
  | {
      type: "extension_event";
      runId: string;
      extensionEvent: AspExtensionEvent;
      providerSessionId?: string;
    }
  | {
      type: "usage";
      runId: string;
      usage: AspTokenUsage;
      model?: string;
      providerSessionId?: string;
    }
  | { type: "stdout" | "stderr"; runId: string; data: string; providerSessionId?: string }
  | { type: "error"; runId: string; message: string; providerSessionId?: string }
  | {
      type: "run_finished";
      runId: string;
      providerSessionId?: string;
      durationMs: number;
      exitCode: number | null;
      success: boolean;
      stopReason?: AspStopReason;
      usage?: AspTokenUsage;
    };

export type AspExtensionFallback =
  | { type: "message_delta"; data: string }
  | { type: "message_part"; part: AspMessagePart }
  | { type: "tool_event"; toolEvent: AspToolEvent }
  | { type: "usage"; usage: AspTokenUsage; model?: string }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "error"; message: string };

export type AspExtensionEvent = {
  extension: string;
  event: string;
  runId?: string;
  providerSessionId?: string;
  payload?: unknown;
  fallback: AspExtensionFallback | "none";
  metadata?: Record<string, unknown>;
};

export type AspExtensionInvokeInput = {
  uiSessionId: string;
  extension: string;
  method: string;
  runId?: string;
  providerSessionId?: string;
  payload?: unknown;
  timeoutMs?: number;
};

export type AspExtensionInvokeResult = {
  extension: string;
  method: string;
  result?: unknown;
};

export type DesktopSessionEvent =
  | {
      type: "run_event";
      uiSessionId: string;
      clientRequestId?: string;
      event: AspRunEvent;
    }
  | {
      type: "connection_state";
      uiSessionId: string;
      clientRequestId?: string;
      runId?: string;
      providerId?: string;
      state: "connecting" | "ready" | "running" | "idle" | "closed" | "error";
      message?: string;
    };

export type ApprovalRequestPayload = {
  requestId: string;
  uiSessionId: string;
  runId: string;
  approvalId?: string;
  title: string;
  method: string;
  scope?: string;
  params?: unknown;
  options: AspApprovalDecision[];
};

export type QuestionRequestPayload = {
  requestId: string;
  uiSessionId: string;
  runId: string;
  providerSessionId?: string;
  questionId?: string;
  title?: string;
  question?: string;
  instructions?: string;
  interactionType?: "form" | "mcp_app" | "custom";
  method?: string;
  app?: AspInteractiveApp;
  metadata?: Record<string, unknown>;
  submitLabel?: string;
  cancelLabel?: string;
  questions: AspQuestion[];
};

export type ProviderTestResult =
  | {
      ok: true;
      protocolVersion: string;
      capabilities: AspProviderCapabilities;
      models: AspModel[];
      agentInfo?: AspImplementation;
    }
  | { ok: false; error: string };

export type AspClientServiceContext = {
  cwd: string;
  providerId: string;
  providerSessionId?: string;
  runId: string;
  uiSessionId: string;
};

export type AspClientServices = {
  readTextFile?(
    input: { path: string; line?: number; limit?: number },
    context: AspClientServiceContext,
  ):
    | Promise<{ content: string; path: string; truncated?: boolean }>
    | { content: string; path: string; truncated?: boolean };
  writeTextFile?(
    input: { path: string; content: string },
    context: AspClientServiceContext,
  ): Promise<{ path: string; bytes: number }> | { path: string; bytes: number };
  terminalCreate?(
    input: {
      id: string;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    },
    context: AspClientServiceContext,
  ): Promise<{ id: string }> | { id: string };
  terminalOutput?(
    input: { id: string; maxChars?: number },
    context: AspClientServiceContext,
  ):
    | Promise<{ id: string; output: string; truncated?: boolean }>
    | {
        id: string;
        output: string;
        truncated?: boolean;
      };
  terminalWaitForExit?(
    input: { id: string; timeoutMs?: number },
    context: AspClientServiceContext,
  ): Promise<{ id: string; exitCode?: number | null; signal?: string | null }>;
  terminalKill?(
    input: { id: string },
    context: AspClientServiceContext,
  ): Promise<boolean> | boolean;
  terminalRelease?(
    input: { id: string },
    context: AspClientServiceContext,
  ): Promise<boolean> | boolean;
};
