import type {
  AspMessagePart,
  AspMessageRecord,
  AspProvider,
  AspProviderSession,
  AspTokenUsage,
  AspToolEvent,
} from "@agui/asp/types";

type ToolStatus = "running" | "success" | "error";

type ContextUsage = {
  used: number;
  usedKnown?: boolean;
  size: number;
  source?: string;
  cost?: { amount: number; currency: string } | null;
};

type TokenUsage = {
  input: number;
  output: number;
};

type ContextUsedTokenOptions = {
  includePlainTokenFields?: boolean;
};

type ContextUsagePayloadOptions = ContextUsedTokenOptions;

type Attachment = {
  id: string;
  kind: "image" | "file";
  mime?: string;
  name: string;
  path?: string;
  size?: number;
  url?: string;
};

type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: Array<{ type: "add" | "del" | "ctx"; text: string }>;
};

type InteractiveAppEmbed = {
  renderer: "mcp-app";
  title?: string;
  html?: string;
  src?: string;
  uri?: string;
  resourceUri?: string;
  server?: string;
  height?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  widgetState?: unknown;
  metadata?: Record<string, unknown>;
};

type ChatBlock = (
  | { id: string; kind: "user"; text: string; attachments?: Attachment[]; at?: number }
  | { id: string; kind: "reasoning"; text: string; streaming: boolean }
  | { id: string; kind: "assistant"; text: string; streaming: boolean; at?: number }
  | { id: string; kind: "plan"; todos: Todo[] }
  | {
      id: string;
      kind: "tool";
      title: string;
      toolKind?: string;
      output: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: Array<{ path: string; line?: number | null }>;
      status: ToolStatus;
    }
  | {
      id: string;
      kind: "diff";
      path: string;
      hunks: DiffHunk[];
      status: ToolStatus;
      review: "accepted";
    }
  | {
      id: string;
      kind: "resource" | "artifact";
      artifactId?: string;
      title?: string;
      name?: string;
      uri?: string;
      path?: string;
      mimeType?: string;
      content?: string;
      app?: InteractiveAppEmbed;
      metadata?: Record<string, unknown>;
    }
  | { id: string; kind: "raw"; label?: string; value: unknown; metadata?: Record<string, unknown> }
) & { order?: number };

type TranscriptProviderSession = AspProviderSession & {
  context?: {
    usedTokens?: number;
    windowTokens?: number;
    autoCompaction?: boolean;
  };
  usage?: AspTokenUsage;
};

type TranscriptMessageRecord = AspMessageRecord & {
  usage?: AspTokenUsage;
};

export type TranscriptSessionProjection = {
  blocks: ChatBlock[];
  contextUsage?: ContextUsage;
  providerSessionId?: string;
  sessionState?: Record<string, unknown>;
  title?: string;
  usage?: TokenUsage;
};

export function projectTranscriptSession(input: {
  messages: TranscriptMessageRecord[];
  previousContextUsage?: ContextUsage;
  providerId: string;
  providers: AspProvider[];
  session?: TranscriptProviderSession;
}): TranscriptSessionProjection {
  const blocks: ChatBlock[] = [];
  const projectedToolIds = new Set<string>();
  let nextOrder = 1;
  let latestUsage = input.session?.usage;

  const pushBlock = (block: ChatBlock, at?: number) => {
    const order = Math.max(nextOrder, finiteNumber(at) ?? 0);
    nextOrder = order + 1;
    blocks.push({ ...block, order });
  };

  for (const message of input.messages) {
    if (message.usage) latestUsage = message.usage;
    const at = finiteNumber(message.createdAt) ?? Date.now();
    if (message.role === "user") {
      pushBlock(
        {
          id: message.id,
          kind: "user",
          text: message.content || partsText(message.parts),
          attachments: transcriptAttachments(message.metadata),
          at,
        },
        at,
      );
      continue;
    }

    const before = blocks.length;
    for (const part of message.parts ?? []) projectPart(part, pushBlock, projectedToolIds, at);
    for (const tool of message.toolEvents ?? []) {
      if (projectedToolIds.has(tool.id)) continue;
      projectTool(tool, pushBlock, at);
      projectedToolIds.add(tool.id);
    }
    if (blocks.length === before && message.content.trim()) {
      pushBlock(
        {
          id: message.id,
          kind: "assistant",
          text: message.content,
          streaming: false,
          at,
        },
        at,
      );
    }
  }

  const sessionState = transcriptSessionState(input.session, latestUsage);
  const provider = input.providers.find((item) => item.id === input.providerId);
  const explicitContextUsed = contextUsedTokensFromSessionPayload(sessionState, {
    includePlainTokenFields: false,
  });
  const hasExplicitContextUsed =
    explicitContextUsed !== undefined || latestUsage?.contextTokens !== undefined;
  const isClaudeCode = isClaudeCodeProvider(
    provider,
    input.providerId,
    ...claudeCodePayloadLabels(sessionState),
  );
  const hasCliContext = !isClaudeCode || claudeCodePayloadHasCliContext(sessionState);
  const fallbackWindow = contextWindowTokensForSessionPayload(
    sessionState,
    input.providerId,
    input.providers,
    input.session?.model,
  );
  const projectedContextUsage = hasCliContext
    ? contextUsageFromSessionPayload(
        sessionState,
        isClaudeCode && !hasExplicitContextUsed ? undefined : input.previousContextUsage,
        isClaudeCode ? undefined : fallbackWindow,
        latestUsage?.contextTokens ?? (isClaudeCode ? undefined : latestUsage?.totalTokens),
        { includePlainTokenFields: !isClaudeCode },
      )
    : undefined;
  const contextUsage =
    isClaudeCode && projectedContextUsage
      ? { ...projectedContextUsage, source: "claude-code-cli" }
      : projectedContextUsage;

  return {
    blocks: blocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    contextUsage,
    providerSessionId: input.session?.id,
    sessionState,
    title: input.session?.title,
    usage: tokenUsage(latestUsage),
  };
}

function projectPart(
  part: AspMessagePart,
  pushBlock: (block: ChatBlock, at?: number) => void,
  projectedToolIds: Set<string>,
  at: number,
): void {
  switch (part.type) {
    case "text":
      if (!part.content.trim()) return;
      pushBlock({ id: part.id, kind: "assistant", text: part.content, streaming: false, at }, at);
      return;
    case "reasoning":
      if (!part.content?.trim()) return;
      pushBlock({ id: part.id, kind: "reasoning", text: part.content, streaming: false }, at);
      return;
    case "plan":
      pushBlock({ id: part.id, kind: "plan", todos: planTodos(part) }, at);
      return;
    case "tool":
      projectTool(part.toolEvent, pushBlock, at);
      projectedToolIds.add(part.toolEvent.id);
      return;
    case "diff":
      pushBlock(
        {
          id: part.id,
          kind: "diff",
          path: part.path || part.oldPath || part.title || "Changes",
          hunks: parseUnifiedDiff(part.content),
          status: "success",
          review: "accepted",
        },
        at,
      );
      return;
    case "status":
    case "citation": {
      const text =
        part.type === "citation" && part.uri
          ? `[${part.content || part.uri}](${part.uri})`
          : part.content;
      if (!text?.trim()) return;
      pushBlock({ id: part.id, kind: "assistant", text, streaming: false, at }, at);
      return;
    }
    case "resource":
    case "artifact":
      pushBlock(
        {
          id: part.id,
          kind: part.type,
          artifactId: part.type === "artifact" ? part.artifactId : undefined,
          title: part.title,
          name: part.name,
          uri: part.uri,
          path: part.path,
          mimeType: part.mimeType,
          content: part.content,
          app: interactiveAppFromPart(part),
          metadata: part.metadata,
        },
        at,
      );
      return;
    case "raw":
      pushBlock(
        { id: part.id, kind: "raw", label: part.label, value: part.value, metadata: part.metadata },
        at,
      );
      return;
  }
}

function projectTool(
  tool: AspToolEvent,
  pushBlock: (block: ChatBlock, at?: number) => void,
  at: number,
): void {
  pushBlock(
    {
      id: tool.id,
      kind: "tool",
      title: tool.name,
      toolKind: tool.kind,
      output: tool.output ?? "",
      rawInput: tool.input,
      rawOutput: tool.error,
      locations: toolLocations(tool),
      status: toolStatus(tool),
    },
    at,
  );
  const diff = tool.semantic?.diff;
  if (diff?.type === "diff") {
    pushBlock(
      {
        id: `${tool.id}-diff`,
        kind: "diff",
        path: diff.path || diff.oldPath || diff.title || tool.name,
        hunks: parseUnifiedDiff(diff.content),
        status: toolStatus(tool) === "error" ? "error" : "success",
        review: "accepted",
      },
      at,
    );
  }
  for (const artifact of tool.semantic?.artifacts ?? []) {
    if (artifact.type === "resource" || artifact.type === "artifact") {
      projectPart(artifact, pushBlock, new Set(), at);
    }
  }
  for (const child of tool.children ?? []) projectTool(child, pushBlock, at);
}

function transcriptSessionState(
  session: TranscriptProviderSession | undefined,
  usage: AspTokenUsage | undefined,
): Record<string, unknown> {
  if (!session) return usage ? { usage } : {};
  return {
    providerSessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    model: session.model,
    context: session.context,
    usage,
    metadata: session.metadata,
  };
}

function tokenUsage(usage: AspTokenUsage | undefined): TokenUsage | undefined {
  return usage ? { input: usage.inputTokens, output: usage.outputTokens } : undefined;
}

function planTodos(part: Extract<AspMessagePart, { type: "plan" }>): Todo[] {
  const items = part.items?.length
    ? part.items
    : (part.content ?? "")
        .split(/\r?\n/)
        .map((item) => item.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
  return items.map((item) => {
    const match = /^\[(pending|in_progress|completed|done|todo|doing)\]\s*(.*)$/i.exec(item);
    const rawStatus = match?.[1]?.toLowerCase();
    return {
      content: (match?.[2] || item).trim(),
      status:
        rawStatus === "completed" || rawStatus === "done"
          ? "completed"
          : rawStatus === "in_progress" || rawStatus === "doing"
            ? "in_progress"
            : "pending",
    };
  });
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
        ? [{ path: source.path, line: typeof source.line === "number" ? source.line : undefined }]
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
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
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

function interactiveAppFromPart(
  part: Extract<AspMessagePart, { type: "resource" | "artifact" }>,
): InteractiveAppEmbed | undefined {
  const app = part.app ?? metadataInteractiveApp(part.metadata);
  if (!app) return undefined;
  const html = stringPayload(app.html) || htmlContentForApp(part.content, part.mimeType);
  return {
    ...app,
    ...(html ? { html } : {}),
    renderer: "mcp-app",
  };
}

function metadataInteractiveApp(
  metadata: Record<string, unknown> | undefined,
): Partial<InteractiveAppEmbed> | undefined {
  const app = metadata?.app;
  return app && typeof app === "object" && !Array.isArray(app)
    ? (app as Partial<InteractiveAppEmbed>)
    : undefined;
}

function htmlContentForApp(
  content: string | undefined,
  mimeType: string | undefined,
): string | undefined {
  const html = stringPayload(content);
  if (!html) return undefined;
  if (stringPayload(mimeType).toLowerCase().includes("html")) return html;
  return /^\s*<!doctype\s+html\b|^\s*<html[\s>]/i.test(html) ? html : undefined;
}

function partsText(parts: AspMessagePart[] | undefined): string {
  return (parts ?? [])
    .map((part) => ("content" in part ? (part.content ?? "") : ""))
    .filter(Boolean)
    .join("");
}

function transcriptAttachments(
  metadata: Record<string, unknown> | undefined,
): Attachment[] | undefined {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) return undefined;
  const attachments = raw.flatMap((item): Attachment[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const path = stringPayload(source.path);
    const url = stringPayload(source.url);
    if (!path && !url) return [];
    const name =
      stringPayload(source.name) || (path ? path.split(/[\\/]/).pop() || "Image" : "Image");
    return [
      {
        id: stringPayload(source.id) || `${path || url}`,
        kind: source.kind === "file" ? "file" : "image",
        name,
        ...(path ? { path } : {}),
        ...(url ? { url } : {}),
        ...(stringPayload(source.mime) ? { mime: stringPayload(source.mime) } : {}),
        ...(typeof source.size === "number" ? { size: source.size } : {}),
      },
    ];
  });
  return attachments.length ? attachments : undefined;
}

function contextUsageFromSessionPayload(
  payload: Record<string, unknown>,
  previous: ContextUsage | undefined,
  fallbackSize?: number,
  fallbackUsed?: number,
  options: ContextUsagePayloadOptions = {},
): ContextUsage | undefined {
  const context = recordPayload(payload.context);
  const tokenUsagePayload = recordPayload(
    payload.tokenUsage ?? payload.token_usage ?? payload.usage,
  );
  const tokens = recordPayload(payload.tokens);
  const used = firstNonNegativeNumber(
    contextUsedTokensFromSessionPayload(payload, options),
    fallbackUsed,
  );
  const size = firstPositiveNumber(
    context.windowTokens,
    context.window_tokens,
    context.size,
    context.total,
    context.contextWindowTokens,
    context.context_window_tokens,
    context.contextWindow,
    context.context_window,
    context.limitTokens,
    context.limit_tokens,
    context.maxTokens,
    context.max_tokens,
    tokenUsagePayload.contextWindowTokens,
    tokenUsagePayload.context_window_tokens,
    tokenUsagePayload.limitTokens,
    tokenUsagePayload.limit_tokens,
    tokens.contextWindowTokens,
    tokens.context_window_tokens,
    tokens.windowTokens,
    tokens.window_tokens,
    payload.contextWindowTokens,
    payload.context_window_tokens,
    payload.windowTokens,
    payload.window_tokens,
    payload.limitTokens,
    payload.limit_tokens,
    fallbackSize,
  );
  return mergeContextUsage(previous, used, size);
}

function contextUsedTokensFromSessionPayload(
  payload: Record<string, unknown>,
  options: ContextUsedTokenOptions = {},
): number | undefined {
  const context = recordPayload(payload.context);
  const tokenUsagePayload = recordPayload(
    payload.tokenUsage ?? payload.token_usage ?? payload.usage,
  );
  const tokens = recordPayload(payload.tokens);
  const contextUsed = firstNonNegativeNumber(
    context.usedTokens,
    context.used_tokens,
    context.used,
    context.contextTokens,
    context.context_tokens,
    context.totalTokens,
    context.total_tokens,
    tokenUsagePayload.contextTokens,
    tokenUsagePayload.context_tokens,
    tokenUsagePayload.usedTokens,
    tokenUsagePayload.used_tokens,
    tokens.contextTokens,
    tokens.context_tokens,
    tokens.usedTokens,
    tokens.used_tokens,
    payload.contextTokens,
    payload.context_tokens,
    payload.usedTokens,
    payload.used_tokens,
  );
  if (contextUsed !== undefined || options.includePlainTokenFields === false) return contextUsed;
  return firstNonNegativeNumber(
    payload.totalTokens,
    payload.total_tokens,
    payload.inputTokens,
    payload.input_tokens,
  );
}

function contextWindowTokensForSessionPayload(
  payload: Record<string, unknown>,
  providerId: string | undefined,
  providers: AspProvider[],
  modelOverride?: string,
): number | undefined {
  const provider = providers.find((item) => item.id === providerId);
  const models = (provider?.models ?? []).filter((model) => !model.hidden);
  const modelName = modelOverride || sessionModel(payload);
  if (!models.length) return inferredContextWindowTokens(provider, modelName);
  const exact = modelName
    ? models.find((model) =>
        [model.model, model.id, model.displayName].some((value) =>
          modelNameMatches(value, modelName),
        ),
      )
    : undefined;
  const candidate = exact ?? (!modelName && models.length === 1 ? models[0] : undefined);
  return (
    positiveNumber(candidate?.contextWindowTokens) ??
    siblingContextWindowTokens(candidate, models) ??
    inferredContextWindowTokens(
      provider,
      modelName,
      candidate?.model,
      candidate?.id,
      candidate?.displayName,
    )
  );
}

function siblingContextWindowTokens(
  candidate: NonNullable<AspProvider["models"]>[number] | undefined,
  models: NonNullable<AspProvider["models"]>,
): number | undefined {
  if (!candidate) return undefined;
  const candidateKeys = modelIdentityValues(candidate).map(modelContextBaseName).filter(Boolean);
  if (!candidateKeys.length) return undefined;
  for (const model of models) {
    const contextWindowTokens = positiveNumber(model.contextWindowTokens);
    if (!contextWindowTokens) continue;
    if (
      modelIdentityValues(model).some((value) =>
        candidateKeys.includes(modelContextBaseName(value)),
      )
    ) {
      return contextWindowTokens;
    }
  }
  return undefined;
}

function inferredContextWindowTokens(
  provider: AspProvider | undefined,
  ...labels: Array<string | undefined>
): number | undefined {
  void provider;
  return labels
    .map((label) => contextWindowTokensFromLabel(label ?? ""))
    .find((value) => value !== undefined);
}

function contextWindowTokensFromLabel(label: string): number | undefined {
  const normalized = label.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
  const patterns = [
    /\bcontext(?:\s+window|\s+limit)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*([kKmMbB])\b/,
    /\b(\d+(?:\.\d+)?)\s*([kKmMbB])\s*(?:tokens?|context)\b/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const parsed = match ? scaledTokenCount(match[1] ?? "", match[2] ?? "") : undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function scaledTokenCount(value: string, unit: string): number | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const normalizedUnit = unit.toLowerCase();
  const multiplier =
    normalizedUnit === "b" ? 1_000_000_000 : normalizedUnit === "m" ? 1_000_000 : 1_000;
  return Math.round(amount * multiplier);
}

function isClaudeCodeProvider(
  provider: AspProvider | undefined,
  fallbackProviderId?: string,
  ...labels: Array<unknown>
): boolean {
  const capabilities = provider?.capabilities;
  return [
    fallbackProviderId,
    provider?.id,
    provider?.name,
    provider?.command,
    capabilities?.runtimeAdapter,
    capabilities?.wireProtocol,
    ...labels,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .some(
      (value) =>
        value === "claude" ||
        value === "claude-code-stream-json" ||
        value === "claude-code" ||
        value.endsWith("/claude") ||
        value.includes("claude-code") ||
        value.includes("claude code"),
    );
}

function claudeCodePayloadLabels(payload: Record<string, unknown>): string[] {
  const metadata = recordPayload(payload.metadata);
  return [
    payload.adapter,
    payload.runtimeAdapter,
    payload.runtime_adapter,
    payload.wireProtocol,
    payload.wire_protocol,
    metadata.adapter,
    metadata.runtimeAdapter,
    metadata.runtime_adapter,
    metadata.source,
    metadata.wireProtocol,
    metadata.wire_protocol,
  ]
    .map(stringPayload)
    .filter(Boolean);
}

function claudeCodePayloadHasCliContext(payload: Record<string, unknown>): boolean {
  const metadata = recordPayload(payload.metadata);
  return stringPayload(metadata.contextUsageSource) === "claude-code-cli";
}

function mergeContextUsage(
  previous: ContextUsage | undefined,
  used: number | undefined,
  size: number | undefined,
): ContextUsage | undefined {
  if (used === undefined && size === undefined) return previous;
  const previousUsedKnown = previous ? previous.usedKnown !== false : false;
  return {
    ...previous,
    used: normalizeTokenCount(used ?? previous?.used ?? 0),
    usedKnown: used !== undefined ? true : previousUsedKnown,
    size: normalizeTokenCount(size ?? previous?.size ?? 0),
  };
}

function sessionModel(payload: Record<string, unknown>): string {
  const metadata = recordPayload(payload.metadata);
  return (
    stringPayload(payload.model) ||
    stringPayload(payload.modelId) ||
    stringPayload(payload.modelID) ||
    stringPayload(payload.model_id) ||
    stringPayload(metadata.model) ||
    stringPayload(metadata.modelId) ||
    stringPayload(metadata.model_id)
  );
}

function modelNameMatches(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  if (value === expected) return true;
  const normalizedValue = value.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  const comparableValue = modelComparableName(value);
  const comparableExpected = modelComparableName(expected);
  return (
    normalizedValue === normalizedExpected ||
    normalizedValue.endsWith(`/${normalizedExpected}`) ||
    normalizedExpected.endsWith(`/${normalizedValue}`) ||
    comparableValue === comparableExpected ||
    comparableValue.endsWith(` ${comparableExpected}`) ||
    comparableExpected.endsWith(` ${comparableValue}`)
  );
}

function modelIdentityValues(model: NonNullable<AspProvider["models"]>[number]): string[] {
  return [model.id, model.model, model.displayName].filter((value): value is string =>
    Boolean(value),
  );
}

function modelContextBaseName(value: string): string {
  return modelComparableName(value)
    .replace(/\bcontext\b/g, "")
    .replace(/\b\d+(?:\.\d+)?\s*[kmb]\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function modelComparableName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\bcontext\b[^)]*\)/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numericPayload(value);
    if (parsed !== undefined && parsed >= 0) return parsed;
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positiveNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = numericPayload(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function numericPayload(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeTokenCount(value: number): number {
  return Math.max(0, Math.floor(value));
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
