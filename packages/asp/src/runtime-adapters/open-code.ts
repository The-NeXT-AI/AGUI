import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeUsage } from "../asp-protocol.js";
import {
  type AspApprovalDecision,
  type AspAgentProfile,
  type AspExtensionFallback,
  type AspMessageRecord,
  type AspMessagePart,
  type AspModel,
  type AspProviderCapabilities,
  type AspProviderSession,
  type AspQuestionAnswer,
  type AspReasoningEffort,
  type AspSessionState,
  type AspToolEvent,
} from "../types.js";
import {
  AGUI_MCP_GATEWAY_SERVER_ID,
  AGUI_MCP_GATEWAY_TOOL_NAMES,
  nativeAdapterCapabilities,
  standardExtension,
  compactExtensions,
  mergeExtensions,
  onJsonLines,
  toolSemanticFromName,
  parseFrontmatter,
  splitList,
  claudeApprovalScope,
  isQuestionMethod,
  runtimeMessageRecord,
  upsertRuntimePart,
  upsertRuntimeTool,
  contentText,
  parseJson,
  normalizeDecision,
  humanize,
  nullableText,
  developerInstructionsWithSkills,
  promptWithDeveloperInstructions,
  promptWithConversationContext,
  normalizeMcpServerMap,
  normalizeMcpTransport,
  mergeRuntimeSkills,
  array,
  stringArray,
  positiveInteger,
  booleanValue,
  timeMs,
  hasOption,
  portArgument,
  imageMimeType,
  simpleUnifiedDiff,
  delay,
  nestedText,
  runtimeSessionTitle,
  runtimeSessionId,
  runtimeSessionCandidates,
  firstRuntimeText,
  runtimeAutomaticApproval,
  runtimeApprovalScope,
  isRuntimeSessionStateMethod,
  isPiSessionStateEvent,
  record,
  text,
  rawText,
  number,
  rpcId,
  asError,
  closeChild,
  runtimeEnvironment,
} from "./shared.js";

export function openCodeCapabilities(
  capabilities: AspProviderCapabilities | undefined,
): AspProviderCapabilities {
  return {
    ...(capabilities ?? {}),
    approvalModes: capabilities?.approvalModes ?? ["request", "auto", "full"],
    approvalScopes: capabilities?.approvalScopes ?? ["command", "filesystem", "network", "tool"],
    contentParts: capabilities?.contentParts ?? [
      "text",
      "tool",
      "reasoning",
      "plan",
      "status",
      "resource",
      "artifact",
      "diff",
      "raw",
    ],
    diffs: true,
    extensions: mergeExtensions(
      capabilities?.extensions,
      compactExtensions([
        standardExtension("asp.ext.agents", [
          "list_agents",
          "select_agent",
          "invoke_agent",
          "cancel_agent",
        ]),
        standardExtension("asp.ext.run-control", [
          "follow_up",
          "compact",
          "set_session_title",
          "abort_current_step",
        ]),
        standardExtension("asp.ext.permissions", []),
        standardExtension("asp.ext.tools"),
        standardExtension("asp.ext.ui", []),
        standardExtension("asp.ext.session-state", ["get_state", "get_messages"]),
        standardExtension("asp.ext.runtime", ["get_runtime"]),
        {
          id: "vendor.opencode.server",
          version: "0.1.0",
          stability: "vendor",
          fallback: "raw",
          methods: [
            {
              name: "raw_request",
              safety: "approval_required",
              inputSchema: { type: "object" },
              outputSchema: {},
            },
          ],
          events: [{ name: "native.event", payloadSchema: { type: "object" } }],
        },
      ]),
    ),
    humanInput: true,
    models: true,
    createSession: true,
    closeSession: true,
    deleteSession: true,
    resumeSession: true,
    sessionHistory: true,
    sessions: true,
    toolEvents: true,
  };
}

export function normalizeOpenCodeServerArgs(
  args: string[],
  fallbackPort: number,
): { args: string[]; port: number } {
  const normalized = args[0] === "serve" ? [...args] : ["serve", ...args];
  const port = portArgument(normalized) ?? fallbackPort;
  if (!hasOption(normalized, "--hostname")) normalized.push("--hostname", "127.0.0.1");
  if (!hasOption(normalized, "--port")) normalized.push("--port", String(port));
  return { args: normalized, port };
}

export function openCodeSessionTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : "ASP session";
}

export function openCodeAgent(
  capabilities: AspProviderCapabilities | undefined,
): string | undefined {
  return text(record(capabilities).agent) || text(record(capabilities).defaultAgent) || undefined;
}

export function openCodeModelSelection(model: string): Record<string, string> | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash > 0 && slash < model.length - 1) {
    return { modelID: model.slice(slash + 1), providerID: model.slice(0, slash) };
  }
  return { modelID: model, providerID: "" };
}

export async function openCodePromptParts(
  run: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [
    { text: promptWithConversationContext(run), type: "text" },
  ];
  for (const attachment of array(run.attachments)) {
    const item = record(attachment);
    const filePath = text(item.path);
    if (!filePath) continue;
    if (/\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(filePath)) {
      parts.push({ mime: imageMimeType(filePath), path: filePath, type: "file" });
    } else {
      parts.push({ path: filePath, type: "file" });
    }
  }
  return parts;
}

export function openCodeModels(value: unknown): AspModel[] {
  const providers = Array.isArray(value)
    ? value
    : Array.isArray(record(value).providers)
      ? (record(value).providers as unknown[])
      : Object.entries(record(value)).map(([id, provider]) => ({ id, ...record(provider) }));
  const models: AspModel[] = [];
  for (const providerValue of providers) {
    const provider = record(providerValue);
    const providerId = text(provider.id) || text(provider.providerID) || text(provider.name);
    const providerName = text(provider.name) || providerId;
    const sourceModels = record(provider.models);
    const modelEntries = Array.isArray(provider.models)
      ? (provider.models as unknown[]).map((item) => [undefined, item] as const)
      : Object.entries(sourceModels);
    for (const [key, modelValue] of modelEntries) {
      const model = record(modelValue);
      const modelId = text(model.id) || text(model.modelID) || text(model.model) || text(key);
      if (!modelId) continue;
      const id = providerId ? `${providerId}/${modelId}` : modelId;
      models.push({
        id,
        model: id,
        displayName: `${providerName ? `${providerName} ` : ""}${text(model.name) || modelId}`,
        contextWindowTokens: positiveInteger(
          record(model.limit).context ??
            model.context ??
            model.contextWindow ??
            model.context_window_tokens,
        ),
        defaultReasoningEffort: modelDefaultReasoningEffort(model),
        supportedReasoningEfforts: modelReasoningEfforts(model),
      });
    }
  }
  return models;
}

const MODEL_REASONING_EFFORTS = new Set<AspReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function modelReasoningEfforts(source: Record<string, unknown>): AspReasoningEffort[] | undefined {
  const raw =
    source.supportedReasoningEfforts ??
    source.supported_reasoning_efforts ??
    source.reasoningEfforts ??
    source.reasoning_efforts ??
    source.supportEfforts ??
    source.support_efforts ??
    source.thinkingLevels ??
    source.thinking_levels;
  const efforts = array(raw)
    .map((item) => {
      const value =
        typeof item === "string"
          ? item
          : text(
              record(item).reasoningEffort ??
                record(item).reasoning_effort ??
                record(item).effort ??
                record(item).level ??
                record(item).value ??
                record(item).id,
            );
      return normalizeModelReasoningEffort(value);
    })
    .filter((item): item is AspReasoningEffort => Boolean(item));
  if (efforts.length) return [...new Set(efforts)];
  const support =
    booleanValue(source.supportsReasoning ?? source.supports_reasoning) ??
    booleanValue(source.reasoning) ??
    booleanValue(source.thinking);
  return support === false ? ["none"] : undefined;
}

function modelDefaultReasoningEffort(
  source: Record<string, unknown>,
): AspReasoningEffort | null | undefined {
  const explicit = normalizeModelReasoningEffort(
    text(
      source.defaultReasoningEffort ??
        source.default_reasoning_effort ??
        source.defaultEffort ??
        source.default_effort ??
        source.reasoningEffort ??
        source.reasoning_effort ??
        source.thinkingLevel ??
        source.thinking_level,
    ),
  );
  if (explicit) return explicit;
  const defaultItem = array(
    source.supportedReasoningEfforts ??
      source.supported_reasoning_efforts ??
      source.reasoningEfforts ??
      source.reasoning_efforts ??
      source.supportEfforts ??
      source.support_efforts ??
      source.thinkingLevels ??
      source.thinking_levels,
  ).find((item) => record(item).default === true || record(item).isDefault === true);
  if (!defaultItem) return undefined;
  return (
    normalizeModelReasoningEffort(
      text(
        record(defaultItem).reasoningEffort ??
          record(defaultItem).reasoning_effort ??
          record(defaultItem).effort ??
          record(defaultItem).level ??
          record(defaultItem).value ??
          record(defaultItem).id,
      ),
    ) ?? undefined
  );
}

function normalizeModelReasoningEffort(value: string): AspReasoningEffort | undefined {
  const normalized = value === "off" ? "none" : value;
  return MODEL_REASONING_EFFORTS.has(normalized as AspReasoningEffort)
    ? (normalized as AspReasoningEffort)
    : undefined;
}

export function openCodeSessions(
  value: unknown,
  providerId: string,
): Array<{
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  projectPath?: string;
  providerId?: string;
}> {
  const sessions = Array.isArray(value) ? value : array(record(value).sessions);
  return sessions
    .map((item) => openCodeSession(record(item), providerId))
    .filter((item) => item.id);
}

export function openCodeAgents(value: unknown): AspAgentProfile[] {
  const source = record(value);
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(source.agents)
      ? source.agents
      : Object.entries(source).map(([id, agent]) => ({ id, ...record(agent) }));
  return entries
    .map((item): AspAgentProfile | null => {
      const agent = record(item);
      const id = text(agent.id) || text(agent.name) || text(agent.agentID) || text(agent.agentId);
      if (!id) return null;
      const roleValue = text(agent.role) || text(agent.mode) || text(agent.type);
      const role: AspAgentProfile["role"] =
        roleValue === "subagent" || roleValue === "sub" || agent.subagent === true
          ? "subagent"
          : roleValue === "mode"
            ? "mode"
            : roleValue === "task"
              ? "task"
              : "primary";
      return {
        id,
        name: text(agent.name) || text(agent.title) || id,
        role,
        description: text(agent.description) || text(agent.prompt) || undefined,
        defaultModel: text(agent.model) || text(agent.modelID) || undefined,
        tools: stringArray(agent.tools),
        metadata: {
          ...(text(agent.path) ? { path: text(agent.path) } : {}),
          ...(text(agent.source) ? { source: text(agent.source) } : {}),
        },
      };
    })
    .filter((agent): agent is AspAgentProfile => Boolean(agent));
}

export function openCodeSession(
  item: Record<string, unknown>,
  providerId: string,
): {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  projectPath?: string;
  providerId?: string;
} {
  const id = text(item.id) || text(item.sessionID);
  const cwd = text(item.cwd) || text(item.directory);
  return {
    id,
    title: text(item.title) || text(item.name) || id,
    createdAt: timeMs(item.timeCreated ?? item.createdAt),
    updatedAt: timeMs(item.timeUpdated ?? item.updatedAt ?? item.timeIdle),
    cwd: cwd || undefined,
    projectPath: cwd || undefined,
    providerId,
  };
}

export function openCodeSessionState(
  value: unknown,
  providerId: string,
): AspSessionState | undefined {
  const source = record(record(value).session ?? value);
  const id = text(source.id) || text(source.sessionID) || text(source.sessionId);
  if (!id) return undefined;
  const contextWindowTokens = positiveInteger(
    source.contextWindowTokens ??
      source.context_window_tokens ??
      record(source.tokens).contextWindow,
  );
  const contextTokens = positiveInteger(
    source.contextTokens ?? source.context_tokens ?? record(source.tokens).context,
  );
  return {
    providerSessionId: id,
    title: text(source.title) || text(source.name) || id,
    cwd: text(source.cwd) || text(source.directory) || undefined,
    model: text(source.model) || text(source.modelID) || undefined,
    streaming: source.timeIdle === undefined ? undefined : !source.timeIdle,
    context:
      contextTokens === undefined && contextWindowTokens === undefined
        ? undefined
        : {
            usedTokens: contextTokens,
            windowTokens: contextWindowTokens,
          },
    metadata: {
      providerId,
      ...(timeMs(source.timeCreated ?? source.createdAt) === undefined
        ? {}
        : { createdAt: timeMs(source.timeCreated ?? source.createdAt) }),
      ...(timeMs(source.timeUpdated ?? source.updatedAt ?? source.timeIdle) === undefined
        ? {}
        : { updatedAt: timeMs(source.timeUpdated ?? source.updatedAt ?? source.timeIdle) }),
    },
  };
}

export function openCodeMessages(value: unknown): Array<{
  id: string;
  role: "assistant" | "user";
  content: string;
  createdAt: number;
  parts: AspMessagePart[];
  toolEvents: AspToolEvent[];
}> {
  const entries = Array.isArray(value) ? value : array(record(value).messages);
  return entries.map((entry, index) => {
    const message = record(entry);
    const info = record(message.info ?? message.message);
    const partsValue = array(message.parts ?? message.content);
    const parts: AspMessagePart[] = [];
    const toolEvents: AspToolEvent[] = [];
    const outputParts = new Map<string, string>();
    for (const partValue of partsValue) {
      const part = record(partValue);
      if (text(part.type) === "tool") {
        const tool = openCodeToolEvent(part, outputParts);
        if (tool) toolEvents.push(tool);
      } else {
        const normalized = openCodePartRecord(part);
        if (normalized) parts.push(normalized);
      }
    }
    const content = parts
      .map((part) => ("content" in part ? (rawText(part.content) ?? "") : ""))
      .filter(Boolean)
      .join("");
    return {
      id: text(info.id) || text(message.id) || `opencode-message-${index}`,
      role: text(info.role) === "user" || text(message.role) === "user" ? "user" : "assistant",
      content,
      createdAt: timeMs(info.timeCreated ?? info.createdAt) ?? Date.now(),
      parts,
      toolEvents,
    };
  });
}

export function openCodePartRecord(part: Record<string, unknown>): AspMessagePart | null {
  const id = text(part.id) || text(part.partID) || `opencode-part-${Date.now()}`;
  const type = text(part.type);
  if (type === "text") {
    const content = rawText(part.text) ?? rawText(part.content) ?? "";
    return content ? { id, content, type: "text" } : null;
  }
  if (type === "reasoning") {
    const content = rawText(part.text) ?? rawText(part.content) ?? "";
    return { id, content, type: "reasoning" };
  }
  if (type === "file") {
    return {
      id,
      name: text(part.name) || undefined,
      path: text(part.path) || undefined,
      title: text(part.path) || text(part.name) || undefined,
      type: "resource",
    };
  }
  return { id, label: type || "OpenCode part", type: "raw", value: part };
}

export function openCodePartDelta(
  id: string,
  part: Record<string, unknown>,
  parts: Map<string, string>,
): string {
  const explicit = rawText(part.delta);
  if (explicit !== undefined) {
    parts.set(id, `${parts.get(id) ?? ""}${explicit}`);
    return explicit;
  }
  const content = rawText(part.text) ?? rawText(part.content) ?? "";
  const previous = parts.get(id) ?? "";
  parts.set(id, content);
  return content.startsWith(previous) ? content.slice(previous.length) : content;
}

export function openCodeToolEvent(
  part: Record<string, unknown>,
  outputs: Map<string, string>,
): AspToolEvent | null {
  const id = text(part.id) || text(part.toolCallID) || text(part.callID);
  if (!id) return null;
  const state = record(part.state);
  const status = text(state.status) || text(part.status);
  const output = contentText(state.output ?? part.output ?? state.result);
  if (output) outputs.set(id, output);
  const phase: AspToolEvent["phase"] =
    status === "completed" || status === "error" || status === "failed"
      ? "completed"
      : outputs.has(id)
        ? "updated"
        : "started";
  return {
    id,
    error:
      status === "error" || status === "failed"
        ? text(state.error) || nestedText(state, "error", "message") || output || "Tool failed."
        : undefined,
    input: state.input ?? part.input,
    kind: text(part.tool) || text(part.kind) || "tool",
    name: text(part.tool) || text(part.name) || "Tool call",
    output: output || outputs.get(id) || undefined,
    phase,
    status: status || (phase === "completed" ? "completed" : "inProgress"),
  };
}

export function openCodeTodos(value: unknown): string[] {
  return array(value)
    .map((item) => {
      const todo = record(item);
      const status = text(todo.status);
      const content = text(todo.content) || text(todo.title) || text(todo.text);
      return content ? `${status ? `[${status}] ` : ""}${content}` : "";
    })
    .filter(Boolean);
}

export function openCodeDiffParts(properties: Record<string, unknown>): AspMessagePart[] {
  const file = record(properties.file ?? properties.diff ?? properties);
  const pathName = text(file.path) || text(file.file) || text(file.filename);
  const patch =
    rawText(file.patch) ??
    rawText(file.diff) ??
    simpleUnifiedDiff(
      pathName,
      rawText(file.old) ?? rawText(file.before),
      rawText(file.new) ?? rawText(file.after),
    );
  return patch
    ? [
        {
          content: patch,
          id: text(file.id) || `opencode-diff-${pathName || Date.now()}`,
          path: pathName || undefined,
          title: pathName ? `Diff ${pathName}` : "Diff",
          type: "diff",
        },
      ]
    : [];
}

export function openCodePermissionScope(permission: Record<string, unknown>): string {
  const type = text(permission.type) || text(permission.kind);
  if (/bash|exec|command|terminal/i.test(type)) return "command";
  if (/edit|write|file|patch/i.test(type)) return "filesystem";
  if (/web|fetch|network/i.test(type)) return "network";
  return "tool";
}

export function openCodePermissionTitle(permission: Record<string, unknown>): string {
  const metadata = record(permission.metadata ?? permission.data);
  return (
    text(permission.title) ||
    text(permission.tool) ||
    text(permission.name) ||
    text(metadata.command) ||
    text(metadata.path) ||
    "OpenCode permission request"
  );
}

export function openCodeErrorMessage(value: unknown): string {
  return text(value) || text(record(value).message) || nestedText(value, "error", "message");
}

export function randomLocalPort(): number {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

export async function waitForHttp(
  baseUrl: string,
  route: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL(route, baseUrl));
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = asError(error);
    }
    await delay(100);
  }
  throw new Error(
    `OpenCode server did not become ready.${lastError ? ` ${lastError.message}` : ""}`,
  );
}

export async function readEventStream(
  url: string,
  signal: AbortSignal,
  onEvent: (event: Record<string, unknown>) => void,
  onReady?: () => void,
): Promise<void> {
  const response = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
  if (!response.ok || !response.body)
    throw new Error(`OpenCode event stream failed with ${response.status}.`);
  onReady?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const parsed = parseJson(data);
      const event = record(parsed);
      if (Object.keys(event).length) onEvent(event);
    }
  }
}
