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

export function normalizePiArgs(args: string[]): string[] {
  if (args.includes("--mode")) return [...args];
  return ["--mode", "rpc", ...args];
}

export function piCapabilities(
  capabilities: AspProviderCapabilities | undefined,
): AspProviderCapabilities {
  return {
    ...(capabilities ?? {}),
    closeSession: false,
    createSession: false,
    approvalModes: capabilities?.approvalModes ?? ["request", "auto", "full"],
    approvalScopes: capabilities?.approvalScopes ?? ["command", "filesystem", "tool"],
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
    extensions: mergeExtensions(capabilities?.extensions, [
      ...compactExtensions([
        standardExtension("asp.ext.run-control", [
          "steer",
          "follow_up",
          "set_queue_mode",
          "compact",
          "set_model",
          "cycle_model",
          "set_effort",
          "cycle_effort",
          "abort_current_step",
        ]),
        standardExtension("asp.ext.session-state", ["get_state", "get_messages"]),
        standardExtension("asp.ext.ui", []),
        standardExtension("asp.ext.multimodal"),
        standardExtension("asp.ext.permissions", []),
        standardExtension("asp.ext.runtime", []),
      ]),
      {
        id: "vendor.pi.rpc",
        version: "0.1.0",
        stability: "vendor",
        fallback: "raw",
        methods: [
          {
            name: "raw_command",
            safety: "approval_required",
            inputSchema: { type: "object" },
            outputSchema: {},
          },
        ],
        events: [{ name: "native.event", payloadSchema: { type: "object" } }],
      },
    ]),
    humanInput: true,
    models: true,
    resumeSession: false,
    sessionHistory: false,
    sessions: false,
    toolEvents: true,
  };
}

export function piModels(value: unknown): AspModel[] {
  return array(record(value).models ?? value)
    .map((item): AspModel | null => {
      const source = record(item);
      const provider = text(source.provider);
      const id = text(source.id) || text(source.model) || text(source.name);
      if (!id) return null;
      const model = provider && !id.includes("/") ? `${provider}/${id}` : id;
      return {
        id: model,
        model,
        displayName: text(source.displayName) || text(source.name) || model,
        defaultReasoningEffort: piModelDefaultReasoningEffort(source),
        supportedReasoningEfforts: piModelReasoningEfforts(source),
      };
    })
    .filter((item): item is AspModel => Boolean(item));
}

export function piModelSelection(value: string): Record<string, string> | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1
    ? { model: value.slice(slash + 1), provider: value.slice(0, slash) }
    : { model: value };
}

export function piThinkingLevel(value: string): string | undefined {
  if (!value) return undefined;
  if (value === "none") return "off";
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value
    : undefined;
}

const PI_MODEL_REASONING_EFFORTS = new Set<AspReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function piModelReasoningEfforts(
  source: Record<string, unknown>,
): AspReasoningEffort[] | undefined {
  const efforts = array(
    source.supportedReasoningEfforts ??
      source.supported_reasoning_efforts ??
      source.reasoningEfforts ??
      source.reasoning_efforts ??
      source.supportEfforts ??
      source.support_efforts ??
      source.thinkingLevels ??
      source.thinking_levels,
  )
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
      return normalizePiModelReasoningEffort(value);
    })
    .filter((item): item is AspReasoningEffort => Boolean(item));
  if (efforts.length) return [...new Set(efforts)];
  const support =
    booleanValue(source.supportsReasoning ?? source.supports_reasoning) ??
    booleanValue(source.reasoning) ??
    booleanValue(source.thinking);
  return support === false ? ["none"] : undefined;
}

function piModelDefaultReasoningEffort(
  source: Record<string, unknown>,
): AspReasoningEffort | null | undefined {
  const explicit = normalizePiModelReasoningEffort(
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
    normalizePiModelReasoningEffort(
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

function normalizePiModelReasoningEffort(value: string): AspReasoningEffort | undefined {
  const normalized = value === "off" ? "none" : value;
  return PI_MODEL_REASONING_EFFORTS.has(normalized as AspReasoningEffort)
    ? (normalized as AspReasoningEffort)
    : undefined;
}

export async function piPromptImages(run: Record<string, unknown>): Promise<unknown[]> {
  const images = array(run.attachments)
    .map((attachment) => text(record(attachment).path))
    .filter((filePath) => /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(filePath));
  for (const part of array(run.inputParts ?? record(run.input).parts)) {
    const input = record(part);
    if (text(input.type) === "image_base64" && rawText(input.data)) {
      images.push({
        data: rawText(input.data),
        mimeType: text(input.mimeType) || text(input.mime_type) || "image/png",
        type: "base64",
      } as never);
    } else if (text(input.type) === "image_ref" && text(input.path)) {
      images.push(text(input.path));
    }
  }
  return images;
}

export function piSessionState(value: unknown): AspSessionState | undefined {
  const source = record(value);
  const providerSessionId = text(source.sessionId) || text(source.session_id) || text(source.id);
  if (!providerSessionId) return undefined;
  const pending = positiveInteger(source.pendingMessageCount ?? source.pending_message_count);
  const usedTokens = positiveInteger(
    source.contextTokens ?? source.usedTokens ?? source.used_tokens,
  );
  const windowTokens = positiveInteger(
    source.contextWindowTokens ?? source.context_window_tokens ?? source.windowTokens,
  );
  return {
    providerSessionId,
    title: text(source.sessionName) || text(source.session_name) || text(source.title) || undefined,
    cwd: text(source.cwd) || text(source.sessionDir) || text(source.session_dir) || undefined,
    model: text(source.model) || undefined,
    effort: text(source.thinkingLevel) || text(source.thinking_level) || undefined,
    streaming:
      typeof source.isStreaming === "boolean"
        ? source.isStreaming
        : typeof source.streaming === "boolean"
          ? source.streaming
          : undefined,
    queue:
      pending === undefined
        ? undefined
        : {
            pending,
            mode:
              text(source.steeringMode) ||
              text(source.steering_mode) ||
              text(source.followUpMode) ||
              text(source.follow_up_mode) ||
              undefined,
          },
    context:
      usedTokens === undefined &&
      windowTokens === undefined &&
      typeof source.autoCompaction !== "boolean"
        ? undefined
        : {
            usedTokens,
            windowTokens,
            autoCompaction:
              typeof source.autoCompaction === "boolean" ? source.autoCompaction : undefined,
          },
    parentSessionId: text(source.parentSessionId) || text(source.parent_session_id) || undefined,
    metadata: {
      ...(positiveInteger(source.messageCount ?? source.message_count) === undefined
        ? {}
        : { messageCount: positiveInteger(source.messageCount ?? source.message_count) }),
      ...(text(source.sessionFile) ? { sessionFile: text(source.sessionFile) } : {}),
    },
  };
}

export function piRunControlEventName(type: string): string {
  if (type === "queue_update") return "queue.updated";
  if (type === "compaction_start") return "compaction.started";
  if (type === "compaction_end") return "compaction.completed";
  if (type.startsWith("auto_retry")) return type.replace(/_/g, ".");
  if (type.startsWith("summarization_retry")) return type.replace(/_/g, ".");
  return type.replace(/_/g, ".");
}

export function piMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return array(content)
    .map((part) => rawText(record(part).text) ?? rawText(record(part).content) ?? "")
    .join("");
}

export function piToolEvent(
  event: Record<string, unknown>,
  outputs: Map<string, string>,
): AspToolEvent | null {
  const tool = record(event.toolExecution ?? event.tool ?? event.execution ?? event);
  const id = text(tool.id) || text(event.id) || text(tool.callId);
  if (!id) return null;
  const type = text(event.type);
  const output = contentText(tool.output ?? tool.result ?? event.output);
  if (output) outputs.set(id, output);
  const phase: AspToolEvent["phase"] =
    type === "tool_execution_end" ? "completed" : output ? "updated" : "started";
  return {
    id,
    error: text(tool.error) || nestedText(tool, "error", "message") || undefined,
    input: tool.input ?? tool.arguments ?? event.input,
    kind: text(tool.type) || text(tool.kind) || "tool",
    name: text(tool.name) || text(tool.toolName) || "Tool call",
    output: output || outputs.get(id) || undefined,
    phase,
    status: text(tool.status) || (phase === "completed" ? "completed" : "inProgress"),
  };
}

export function piToolResult(
  item: Record<string, unknown>,
  outputs: Map<string, string>,
): AspToolEvent | null {
  const id = text(item.toolCallId) || text(item.id);
  if (!id) return null;
  const output = contentText(item.output ?? item.content ?? item.result);
  if (output) outputs.set(id, output);
  return {
    id,
    error: item.isError === true ? output || "Tool failed." : undefined,
    kind: text(item.toolName) || text(item.name) || "tool",
    name: text(item.toolName) || text(item.name) || "Tool call",
    output,
    phase: "completed",
    status: item.isError === true ? "failed" : "completed",
  };
}

export function piToolCallStreamEvent(
  event: Record<string, unknown>,
  outputs: Map<string, string>,
): AspToolEvent | null {
  const tool = record(event.toolCall ?? event.tool);
  const id = text(tool.id) || text(event.toolCallId) || text(event.id);
  if (!id) return null;
  const delta = rawText(event.delta) ?? "";
  const output = `${outputs.get(id) ?? ""}${delta}`;
  if (delta) outputs.set(id, output);
  const type = text(event.type);
  return {
    id,
    input: tool.input ?? event.input,
    kind: text(tool.type) || text(tool.name) || "tool",
    name: text(tool.name) || text(event.name) || "Tool call",
    output: output || undefined,
    phase: type === "toolcall_end" ? "completed" : delta ? "updated" : "started",
    status: type === "toolcall_end" ? "completed" : "inProgress",
  };
}

export function piStatusText(event: Record<string, unknown>): string | undefined {
  return text(event.message) || text(event.status) || text(event.summary) || undefined;
}

export function piUiQuestion(message: Record<string, unknown>): Record<string, unknown> {
  const options = array(message.options).map((option) => {
    const source = record(option);
    return {
      description: text(source.description) || undefined,
      label: text(source.label) || text(source.value) || String(option),
    };
  });
  return {
    id: text(message.id) || "pi-extension-input",
    options: options.length ? options : undefined,
    question: text(message.message) || text(message.title) || "Input",
  };
}

export function firstQuestionAnswer(result: Record<string, unknown>): string {
  const answers = array(result.answers);
  const first = record(answers[0]);
  return Array.isArray(first.answer)
    ? first.answer.map(String).join(", ")
    : text(first.answer) || text(result.value) || text(result.answer);
}
