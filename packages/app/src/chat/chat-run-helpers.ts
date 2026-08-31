import type {
  AspExtensionUse,
  AspModel,
  AspProviderCapabilities,
  AspReasoningEffort,
  AspRunSpeed,
  AspTokenUsage,
} from "@/asp/desktop-api";
import type { Attachment, ContextUsage, McpAppSessionState, Session, TokenUsage } from "./types";

export function tokenUsageFromAsp(usage: AspTokenUsage | undefined): TokenUsage | undefined {
  return usage ? { input: usage.inputTokens, output: usage.outputTokens } : undefined;
}

export function failedRunMessage(
  providerName: string,
  result: { exitCode: number | null; output?: string },
): string {
  const output = result.output?.trim();
  if (output) return output;
  const suffix = result.exitCode === null ? "" : ` (exit code ${result.exitCode})`;
  return `${providerName} did not complete successfully${suffix} and did not return an error message.`;
}

export function buildPrompt(
  text: string,
  attachments: Attachment[] | undefined,
  mcpAppState?: Record<string, McpAppSessionState>,
): string {
  const inlineAttachmentContext = (attachments ?? [])
    .filter((attachment) => attachment.content?.trim())
    .map((attachment) =>
      [`## ${attachment.name}`, attachment.content?.trim()].filter(Boolean).join("\n\n"),
    )
    .join("\n\n");
  const references = (attachments ?? [])
    .filter((attachment) => attachment.path)
    .map((attachment) => `@${attachment.path}`)
    .join("\n");
  return [text, inlineAttachmentContext, references, formatMcpAppModelContext(mcpAppState)]
    .filter(Boolean)
    .join("\n\n");
}

export function formatMcpAppModelContext(
  mcpAppState: Record<string, McpAppSessionState> | undefined,
): string {
  const entries = Object.values(mcpAppState ?? {})
    .filter((state) => state.modelContext)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  if (!entries.length) return "";
  const sections = entries.map((state) => {
    const context = state.modelContext;
    const blocks = Array.isArray(context?.content)
      ? context.content.map(formatMcpContentBlock).filter(Boolean).join("\n")
      : "";
    const structured =
      context?.structuredContent && Object.keys(context.structuredContent).length
        ? `structuredContent:\n${safePrettyJson(context.structuredContent)}`
        : "";
    return [
      `### ${state.title || state.resourceUri || state.server || "MCP App"}`,
      state.server ? `server: ${state.server}` : "",
      state.resourceUri ? `resourceUri: ${state.resourceUri}` : "",
      state.documentId ? `documentId: ${state.documentId}` : "",
      blocks,
      structured,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "## MCP App Context",
    "The embedded MCP Apps published the following current UI context for this turn.",
    ...sections,
  ].join("\n\n");
}

export function formatMcpContentBlock(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return safePrettyJson(value);
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  return safePrettyJson(record);
}

export function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function contextUsageEqual(
  left: ContextUsage | undefined,
  right: ContextUsage | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.used === right.used &&
    (left.usedKnown !== false) === (right.usedKnown !== false) &&
    left.size === right.size &&
    left.source === right.source &&
    left.cost?.amount === right.cost?.amount &&
    left.cost?.currency === right.cost?.currency
  );
}

export function buildAttachments(attachments: Attachment[] | undefined) {
  return (attachments ?? [])
    .filter((attachment): attachment is Attachment & { path: string } => Boolean(attachment.path))
    .map((attachment) => ({
      kind: "file" as const,
      name: attachment.name,
      path: attachment.path,
      ...(attachment.handoffFileId ? { handoffFileId: attachment.handoffFileId } : {}),
    }));
}

export function selectedModel(
  models: AspModel[] | undefined,
  preferred: string,
): string | undefined {
  const visible = models?.filter((model) => !model.hidden) ?? [];
  if (models && !visible.length) return undefined;
  return (
    visible.find((model) => model.model === preferred)?.model ??
    visible.find((model) => model.isDefault)?.model ??
    visible[0]?.model ??
    (preferred || undefined)
  );
}

export function selectedEffort(
  models: AspModel[] | undefined,
  capabilities: AspProviderCapabilities | undefined,
  modelId: string | undefined,
  preferred: string,
): AspReasoningEffort | undefined {
  const normalized = normalizeEffort(preferred);
  const model = runModel(models, modelId);
  const supported = supportedReasoningEffortsForModel(models, capabilities, modelId);
  if (!supported.length) return undefined;
  if (normalized && supported.includes(normalized)) return normalized;
  return model?.defaultReasoningEffort ?? supported[0];
}

export function supportedReasoningEffortsForModel(
  models: AspModel[] | undefined,
  capabilities: AspProviderCapabilities | undefined,
  modelId: string | undefined,
): AspReasoningEffort[] {
  const model = runModel(models, modelId);
  if (model) return model.supportedReasoningEfforts ?? [];
  return capabilities?.reasoningEfforts ?? [];
}

export function normalizeEffort(value: string) {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? (value as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : undefined;
}

export function selectedSpeed(
  models: AspModel[] | undefined,
  capabilities: AspProviderCapabilities | undefined,
  modelId: string | undefined,
  preferred: string,
): AspRunSpeed {
  const normalized = normalizeSpeed(preferred);
  const supported = supportedSpeedsForModel(models, capabilities, modelId);
  return supported.includes(normalized) ? normalized : (supported[0] ?? "default");
}

export function supportedSpeedsForModel(
  models: AspModel[] | undefined,
  capabilities: AspProviderCapabilities | undefined,
  modelId: string | undefined,
): AspRunSpeed[] {
  const model = runModel(models, modelId);
  if (model) return model.supportedSpeeds ?? ["default"];
  return capabilities?.speeds ?? ["default"];
}

export function normalizeSpeed(value: string): AspRunSpeed {
  return value === "fast" ? "fast" : "default";
}

function runModel(
  models: AspModel[] | undefined,
  modelId: string | undefined,
): AspModel | undefined {
  return models?.find((item) => !item.hidden && item.model === modelId);
}

export function negotiatedRunExtensions(
  capabilities: AspProviderCapabilities | undefined,
): AspExtensionUse[] {
  return (capabilities?.extensions ?? []).flatMap((extension): AspExtensionUse[] => {
    if (!extension.id || extension.id.startsWith("vendor.")) return [];
    const methods = extension.methods ?? [];
    if (!methods.length) return [{ id: extension.id, version: extension.version }];
    const safeMethods = methods
      .filter((method) => method.safety !== "approval_required")
      .map((method) => method.name)
      .filter(Boolean);
    return safeMethods.length
      ? [{ id: extension.id, version: extension.version, options: { methods: safeMethods } }]
      : [];
  });
}

const AGUI_INTERACTION_POLICY = [
  "## AGUI interaction policy",
  "",
  "This runtime supports structured human-input/control requests through ASP question_request events and MCP Gateway code_tool.request_user_input. When you need missing user input, confirmation, or a selection before continuing, use one of those AGUI paths instead of asking the user to reply in plain text.",
  "This capability is mode-agnostic. Use it in any run or collaboration mode when the provider exposes the bridge; do not reserve it for planning-only flows.",
  "When MCP Gateway tools are available, call code_tool.request_user_input exactly to open the native input card and optional MCP App, then continue from the returned structured response.",
  "Do not call a bare top-level Codex tool named request_user_input; that is a host-provided tool outside AGUI and may be unavailable in Default mode.",
  "Use questions[] for fields. Use options with label/value/description/imageUri when choices are known.",
  "For visual or stateful workflows such as product ordering, address selection, maps, document review, or any flow where images/comparison/cart state matter, include an MCP App embed in that interaction request using app.html, app.resourceUri, app.height, and app.widgetState.",
  "Do not render markdown tables or numbered lists that require the user to type a sequence number when a structured interaction can represent the same choice.",
  "Do not claim that structured choices are unsupported unless the control request was actually rejected by the runtime.",
].join("\n");

export function buildAdditionalDeveloperInstructions(
  prompts: Array<{ autoInclude: boolean; content: string; title: string }>,
  sessionContext = "",
): string {
  const promptInstructions = prompts.map((prompt) => `## ${prompt.title}\n\n${prompt.content}`);
  return [AGUI_INTERACTION_POLICY, sessionContext, ...promptInstructions]
    .filter(Boolean)
    .join("\n\n");
}

export function sessionTreeDeveloperInstructions(session: Session | undefined): string {
  const context = session?.extensionState?.sessionTree;
  if (!context) return "";
  const metadata =
    context.metadata && Object.keys(context.metadata).length
      ? `\n\nMetadata:\n${safePrettyJson(context.metadata)}`
      : "";
  const instructions = context.developerInstructions?.trim()
    ? `\n\n${context.developerInstructions.trim()}`
    : "";
  return [
    "## Active virtual session",
    `This conversation is attached to the session tree item "${context.title || context.nodeId}".`,
    `Source extension: ${context.extensionId}`,
    `Tree node: ${context.nodeId}`,
    context.rootId ? `Tree root: ${context.rootId}` : "",
    "Use this context when interpreting the user's requests, and keep actions scoped to this item unless the user asks otherwise.",
    metadata,
    instructions,
  ]
    .filter(Boolean)
    .join("\n");
}

export function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || "New session";
}

export function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function numberPayload(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
