import type { AspProvider } from "@/asp/desktop-api";
import type { ContextUsage, Session } from "./types";

type SessionContextSource = Pick<
  Session,
  "agentSessions" | "capabilities" | "contextUsage" | "extensionState" | "providerId" | "usage"
>;

type ContextUsedTokenOptions = {
  includePlainTokenFields?: boolean;
};

type ContextUsagePayloadOptions = ContextUsedTokenOptions;

export function contextUsageForSession(
  session: SessionContextSource,
  providers: AspProvider[] = [],
): ContextUsage | undefined {
  const payload = recordPayload(session.extensionState?.session);
  const provider = providers.find((item) => item.id === session.providerId);
  const isClaudeCode = isClaudeCodeProvider(
    provider,
    session.providerId,
    session.capabilities?.runtimeAdapter,
    session.capabilities?.wireProtocol,
    session.agentSessions?.[session.providerId]?.capabilities?.runtimeAdapter,
    session.agentSessions?.[session.providerId]?.capabilities?.wireProtocol,
    ...claudeCodePayloadLabels(payload),
  );
  if (isClaudeCode && !claudeCodePayloadHasCliContext(payload)) {
    return session.contextUsage?.source === "claude-code-cli" ? session.contextUsage : undefined;
  }
  const hasExplicitUsed =
    contextUsedTokensFromSessionPayload(payload, { includePlainTokenFields: false }) !== undefined;
  const useTokenUsageFallback = !isClaudeCode;
  const tokenUsageFallback =
    useTokenUsageFallback && session.usage ? session.usage.input + session.usage.output : undefined;
  const selectedModel =
    !isClaudeCode && session.providerId && !sessionModel(payload)
      ? session.agentSessions?.[session.providerId]?.runSettings?.model
      : undefined;
  const fallbackSize = isClaudeCode
    ? undefined
    : contextWindowTokensForSessionPayload(payload, session.providerId, providers, selectedModel);
  const usage = contextUsageFromSessionPayload(
    payload,
    isClaudeCode && !hasExplicitUsed ? undefined : session.contextUsage,
    fallbackSize,
    tokenUsageFallback,
    { includePlainTokenFields: !isClaudeCode },
  );
  if (!hasExplicitUsed && tokenUsageFallback !== undefined && usage?.used === tokenUsageFallback) {
    return undefined;
  }
  if (!hasExplicitUsed && usage && usage.size <= 0) return undefined;
  return isClaudeCode && usage ? { ...usage, source: "claude-code-cli" } : usage;
}

export function contextUsageFromSessionPayload(
  payload: Record<string, unknown>,
  previous: ContextUsage | undefined,
  fallbackSize?: number,
  fallbackUsed?: number,
  options: ContextUsagePayloadOptions = {},
): ContextUsage | undefined {
  const context = recordPayload(payload.context);
  const tokenUsage = recordPayload(payload.tokenUsage ?? payload.token_usage ?? payload.usage);
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
    tokenUsage.contextWindowTokens,
    tokenUsage.context_window_tokens,
    tokenUsage.limitTokens,
    tokenUsage.limit_tokens,
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

export function contextUsedTokensFromSessionPayload(
  payload: Record<string, unknown>,
  options: ContextUsedTokenOptions = {},
): number | undefined {
  const context = recordPayload(payload.context);
  const tokenUsage = recordPayload(payload.tokenUsage ?? payload.token_usage ?? payload.usage);
  const tokens = recordPayload(payload.tokens);
  const contextUsed = firstNonNegativeNumber(
    context.usedTokens,
    context.used_tokens,
    context.used,
    context.contextTokens,
    context.context_tokens,
    context.totalTokens,
    context.total_tokens,
    tokenUsage.contextTokens,
    tokenUsage.context_tokens,
    tokenUsage.usedTokens,
    tokenUsage.used_tokens,
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

export function mergeContextUsage(
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

export function contextWindowTokensForSessionPayload(
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

export function isClaudeCodeProvider(
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

export function claudeCodePayloadLabels(payload: Record<string, unknown>): string[] {
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

export function claudeCodePayloadHasCliContext(payload: Record<string, unknown>): boolean {
  const metadata = recordPayload(payload.metadata);
  return stringPayload(metadata.contextUsageSource) === "claude-code-cli";
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

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
