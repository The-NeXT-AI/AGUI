import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeUsage } from "../asp-protocol.js";
import {
  ancestorFiles,
  markdownFilesRecursive,
  parseTomlHookSummary,
  parseTomlSummary,
  readJsonFile,
  readTextFile,
  skillDirectories,
} from "./filesystem.js";
import {
  type AspApprovalDecision,
  type AspAgentProfile,
  type AspExtensionFallback,
  type AspMessageRecord,
  type AspMessagePart,
  type AspProviderCapabilities,
  type AspProviderSession,
  type AspQuestionAnswer,
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
  normalizeRuntimeApprovalMode,
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
import {
  codexSessionIndexTitleForEnv,
  codexTranscriptFileForSession,
  codexTranscriptFileId,
  codexTranscriptRoots,
  codexTranscriptMetadata,
  isTranscriptTitleEvent,
  readFilePrefix,
  safeReadDir,
  safeStat,
  summarizeTitle,
  transcriptTitleFromRecord,
  transcriptVisibleUserText,
} from "./codex-transcript-utils.js";

export {
  codexSessionIndexTitle,
  codexSessionTitleIndex,
  codexTranscriptFileId,
  codexTranscriptMetadata,
  isInjectedTranscriptUserText,
  isReadableTranscriptPath,
  isTranscriptTitleEvent,
  removeCodexSessionIndexEntry,
  safeReadDir,
  safeStat,
  summarizeTitle,
  transcriptTitleFromRecord,
  transcriptVisibleUserText,
} from "./codex-transcript-utils.js";

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export function codexCapabilities(
  capabilities: AspProviderCapabilities | undefined,
  cwd = process.cwd(),
): AspProviderCapabilities {
  return {
    ...nativeAdapterCapabilities(capabilities),
    deleteSession: true,
    models: true,
    resumeSession: true,
    sessionHistory: true,
    sessions: true,
    slashCommands: capabilities?.slashCommands ?? codexSlashCommands(cwd),
    extensions: mergeExtensions(capabilities?.extensions, [
      ...compactExtensions([
        standardExtension("asp.ext.run-control", [
          "steer",
          "follow_up",
          "compact",
          "set_model",
          "set_effort",
          "set_session_title",
          "abort_current_step",
        ]),
        standardExtension("asp.ext.permissions", ["get_policy", "set_policy"]),
        standardExtension("asp.ext.tools"),
        standardExtension("asp.ext.session-state", ["get_state", "get_messages"]),
        standardExtension("asp.ext.runtime", ["get_runtime"]),
        standardExtension("asp.ext.multimodal"),
      ]),
      {
        id: "vendor.codex.app-server",
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
  };
}

export function normalizeCodexArgs(args: string[], speed: string): string[] {
  const normalized = args.length
    ? args[0] === "app-server"
      ? [...args]
      : ["app-server", ...args]
    : ["app-server"];
  if (speed === "fast") normalized.push("-c", 'service_tier="fast"');
  if (!normalized.includes("--listen") && !normalized.includes("--stdio")) {
    normalized.push("--listen", "stdio://");
  }
  return normalized;
}

export function codexApprovalSettings(mode: string, cwd: string): Record<string, unknown> {
  const approvalMode = normalizeRuntimeApprovalMode(mode);
  if (approvalMode === "full") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  const sandboxPolicy = {
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: [cwd],
  };
  return approvalMode === "auto"
    ? { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy }
    : { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy };
}

export function codexUserInput(run: Record<string, unknown>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [
    { text: promptWithConversationContext(run), text_elements: [], type: "text" },
  ];
  if (Array.isArray(run.attachments)) {
    for (const attachment of run.attachments) {
      const item = record(attachment);
      const filePath = text(item.path);
      if (text(item.kind) === "file" && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(filePath)) {
        result.push({ detail: "auto", path: filePath, type: "localImage" });
      }
    }
  }
  return result;
}

export function codexTool(
  item: Record<string, unknown>,
  phase: "started" | "completed",
  streamedOutput: string,
): AspToolEvent | null {
  const id = text(item.id);
  const kind = codexTranscriptItemType(text(item.type));
  if (
    !id ||
    !kind ||
    ["agentMessage", "message", "plan"].includes(kind) ||
    isCodexReasoningKind(kind)
  ) {
    return null;
  }
  const explicitName =
    text(item.name) || text(item.tool) || text(item.toolName) || text(item.tool_name);
  const name =
    kind === "commandExecution"
      ? "Command"
      : kind === "fileChange"
        ? "File change"
        : kind === "mcpToolCall"
          ? explicitName || "MCP tool"
          : kind === "function_call" || kind === "custom_tool_call"
            ? explicitName || humanize(kind)
            : humanize(kind);
  return {
    id,
    kind,
    name,
    input:
      item.command ??
      item.parsed_cmd ??
      item.parsedCmd ??
      item.arguments ??
      item.input ??
      item.changes ??
      item.query,
    output:
      streamedOutput ||
      codexReasoningText(item) ||
      rawText(item.aggregatedOutput) ||
      rawText(item.aggregated_output) ||
      rawText(item.formattedOutput) ||
      rawText(item.formatted_output) ||
      rawText(item.output) ||
      joinedText(item.stdout, item.stderr) ||
      contentText(item.result) ||
      undefined,
    error: rawText(item.error) || nestedText(item, "error", "message") || undefined,
    phase,
    status: text(item.status) || (phase === "completed" ? "completed" : "inProgress"),
    metadata: {
      ...(text(item.cwd) ? { cwd: text(item.cwd) } : {}),
      ...(text(item.path) ? { path: text(item.path) } : {}),
    },
    semantic: codexToolSemantic(item),
  };
}

export function codexReasoningText(item: Record<string, unknown>): string | undefined {
  const kind = codexTranscriptItemType(text(item.type)).toLowerCase();
  if (!isCodexReasoningKind(kind)) return undefined;
  const candidates = [
    item.text,
    item.content,
    item.summary,
    item.summary_text,
    item.summaryText,
    item.thinking,
    item.reasoning,
    item.details,
    item.explanation,
    item.raw_content,
    item.rawContent,
    item.result,
  ];
  for (const candidate of candidates) {
    const value = contentValueText(candidate);
    if (value?.trim()) return value;
  }
  return undefined;
}

export function isCodexReasoningKind(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  return normalized === "reasoning" || normalized === "thinking";
}

export function normalizeCodexTranscriptItem(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const type = codexTranscriptItemType(text(item.type));
  return type ? { ...item, type } : item;
}

export function codexTranscriptItemType(value: string): string {
  const normalized = value
    .trim()
    .replace(/[-_\s]+/g, "")
    .toLowerCase();
  switch (normalized) {
    case "usermessage":
    case "assistantmessage":
    case "agentmessage":
    case "message":
      return "message";
    case "reasoning":
    case "thinking":
      return "reasoning";
    case "commandexecution":
      return "commandExecution";
    case "filechange":
      return "fileChange";
    case "mcptoolcall":
      return "mcpToolCall";
    case "websearch":
      return "web_search_call";
    case "toolsearch":
      return "tool_search_call";
    case "functioncall":
      return "function_call";
    case "functioncalloutput":
      return "function_call_output";
    case "customtoolcall":
      return "custom_tool_call";
    case "customtoolcalloutput":
      return "custom_tool_call_output";
    default:
      return value;
  }
}

export function codexTranscriptMessageRole(
  eventPayload: Record<string, unknown>,
  item: Record<string, unknown>,
): "assistant" | "user" | "" {
  const explicit = text(item.role).toLowerCase();
  if (explicit === "assistant" || explicit === "user") return explicit;
  const rawType = text(record(eventPayload.item).type || item.type)
    .trim()
    .replace(/[-_\s]+/g, "")
    .toLowerCase();
  if (rawType === "usermessage") return "user";
  if (rawType === "agentmessage" || rawType === "assistantmessage") return "assistant";
  return "";
}

export function codexTranscriptAttachments(
  item: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];
  const add = (value: unknown, fallbackId: string) => {
    const source = record(value);
    const kind = text(source.type).toLowerCase();
    if (kind && !kind.includes("image")) return;
    const imagePath =
      text(source.path) ||
      text(source.local_path) ||
      text(source.localPath) ||
      text(source.file_path) ||
      text(source.filePath);
    const url =
      text(source.url) ||
      text(source.image_url) ||
      text(source.imageUrl) ||
      nestedText(source, "image_url", "url") ||
      nestedText(source, "imageUrl", "url");
    if (!imagePath && !url) return;
    const name = text(source.name) || (imagePath ? path.basename(imagePath) : "Image");
    attachments.push({
      id: text(source.id) || fallbackId,
      kind: "image",
      name,
      ...(imagePath ? { path: imagePath } : {}),
      ...(url ? { url } : {}),
      ...(text(source.mime) ? { mime: text(source.mime) } : {}),
      ...(text(source.mime_type) ? { mime: text(source.mime_type) } : {}),
      ...(text(source.mimeType) ? { mime: text(source.mimeType) } : {}),
    });
  };
  array(item.content).forEach((part, index) =>
    add(part, `${text(item.id) || "codex"}-attachment-${index}`),
  );
  array(item.images).forEach((part, index) =>
    add(part, `${text(item.id) || "codex"}-image-${index}`),
  );
  array(item.local_images).forEach((part, index) =>
    add(part, `${text(item.id) || "codex"}-local-image-${index}`),
  );
  array(item.localImages).forEach((part, index) =>
    add(part, `${text(item.id) || "codex"}-local-image-${index}`),
  );
  return attachments;
}

export function joinedText(...values: unknown[]): string {
  return values
    .map((value) => rawText(value) ?? "")
    .filter(Boolean)
    .join("\n");
}

export function contentValueText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const content = value
      .map((item) => (typeof item === "string" ? item : contentText([item])))
      .filter(Boolean)
      .join("");
    return content || undefined;
  }
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  return (
    rawText(source.text) ??
    rawText(source.content) ??
    rawText(source.summary) ??
    contentValueText(source.summary) ??
    contentValueText(source.content)
  );
}

export function responseItemId(event: Record<string, unknown>, fallback: string): string {
  return text(event.item_id) || text(event.itemId) || text(event.id) || fallback;
}

export function eventItem(event: Record<string, unknown>): Record<string, unknown> {
  const source = record(event.item);
  const item = Object.keys(source).length ? { ...source } : {};
  const id = responseItemId(event, "");
  if (id && !text(item.id)) item.id = id;
  const itemType = text(event.item_type) || text(event.itemType);
  if (itemType && !text(item.type)) item.type = itemType;
  return item;
}

export function responseStreamEvent(
  message: RpcMessage,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 4) return null;
  const source = record(message);
  const params = record(source.params);
  const type =
    responseEventType(source.type) ||
    responseEventType(params.type) ||
    responseEventType(source.method);
  if (type) return { ...source, ...params, type };
  for (const key of ["event", "payload", "data", "result", "message", "params"]) {
    const candidate = responseStreamEvent(source[key] as RpcMessage, depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

export function responseEventType(value: unknown): string {
  const raw = text(value);
  if (raw.startsWith("response.")) return raw;
  if (raw.startsWith("response/"))
    return `response.${raw.slice("response/".length).replace(/\//g, ".")}`;
  if (raw.startsWith("response:"))
    return `response.${raw.slice("response:".length).replace(/:/g, ".")}`;
  return "";
}

export function completedResponsePayload(
  value: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    return value.some((item) => responseStreamEvent(record(item) as RpcMessage))
      ? { streamed_data: value }
      : null;
  }
  const source = record(value);
  if (!Object.keys(source).length) return null;
  if (isCompletedResponseLike(source)) {
    return source;
  }
  for (const key of [
    "response",
    "params",
    "payload",
    "data",
    "result",
    "turn",
    "message",
    "item",
    "metadata",
    "gatewayTrace",
    "gateway_trace",
    "trace",
    "raw",
    "rawResponse",
    "raw_response",
    "providerResponse",
    "provider_response",
  ]) {
    const candidate = completedResponsePayload(source[key], depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

export function isCompletedResponseLike(source: Record<string, unknown>): boolean {
  if (text(source.object) === "response") return true;
  if (rawText(source.output_text)) return true;
  if (
    array(source.streamed_data).some((event) => responseStreamEvent(record(event) as RpcMessage))
  ) {
    return true;
  }
  const output = array(source.output);
  return output.some((item) => {
    const entry = record(item);
    const kind = text(entry.type);
    if (kind === "reasoning" || kind === "message") return true;
    return array(entry.content).some((part) => {
      const partType = text(record(part).type);
      return partType === "reasoning_text" || partType === "output_text" || partType === "text";
    });
  });
}

export function codexToolSemantic(item: Record<string, unknown>): AspToolEvent["semantic"] {
  const kind = codexTranscriptItemType(text(item.type));
  const name = text(item.tool) || text(item.name) || kind;
  if (kind === "commandExecution") {
    return { resultKind: "text", toolType: "shell" };
  }
  if (kind === "fileChange") {
    const diff = codexDiffParts(item)[0];
    return { diff, operation: "write", resultKind: "diff", toolType: "patch.apply" };
  }
  if (kind === "mcpToolCall") {
    return { resultKind: "json", toolType: "mcp.call" };
  }
  return toolSemanticFromName(name);
}

export function codexRuntimeConfig(cwd: string): Record<string, unknown> {
  const files = [
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(cwd, ".codex", "config.toml"),
  ].filter((filePath) => fs.existsSync(filePath));
  return {
    files: files.map((filePath) => ({
      path: filePath,
      source: filePath.startsWith(cwd) ? "workspace" : "user",
      values: parseTomlSummary(readTextFile(filePath)),
    })),
  };
}

export function codexAgentGuidance(cwd: string): Array<Record<string, unknown>> {
  return ancestorFiles(cwd, "AGENTS.md").map((filePath) => ({
    path: filePath,
    source: filePath.startsWith(cwd) ? "workspace" : "ancestor",
    preview: readTextFile(filePath).slice(0, 1000),
  }));
}

export function codexMcpServers(cwd: string): Record<string, unknown> {
  const sources = [
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".codex", "mcp.json"),
    path.join(os.homedir(), ".codex", "mcp.json"),
  ].filter((filePath) => fs.existsSync(filePath));
  const servers: Record<string, unknown> = {};
  for (const filePath of sources) {
    Object.assign(
      servers,
      record(readJsonFile(filePath).mcpServers ?? readJsonFile(filePath).servers),
    );
  }
  return servers;
}

export function mergedCodexMcpServers(
  cwd: string,
  provided: unknown,
): Record<string, unknown> | null {
  const merged = {
    ...codexMcpServers(cwd),
    ...normalizeMcpServerMap(provided),
  };
  return Object.keys(merged).length ? merged : null;
}

export type CodexRuntimeEnv = Record<string, string | undefined>;

export function buildCodexConfig(
  mcpServers: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const codexMcpServers = normalizeCodexMcpServers(mcpServers);
  return codexMcpServers ? { mcp_servers: codexMcpServers } : null;
}

export function normalizeCodexMcpServers(mcpServers: unknown): Record<string, unknown> | undefined {
  const source = normalizeMcpServerMap(mcpServers);
  const normalizedServers = Object.fromEntries(
    Object.entries(source).flatMap(([serverId, server]) => {
      const config = normalizeCodexMcpServerConfig(serverId, server);
      return Object.keys(config).length ? [[serverId, config] as const] : [];
    }),
  );
  return Object.keys(normalizedServers).length ? normalizedServers : undefined;
}

export function normalizeCodexMcpServerConfig(
  serverId: string,
  server: Record<string, unknown>,
): Record<string, unknown> {
  const baseConfig = codexMcpServerToolConfig(serverId, server);
  const url = text(server.url);
  if (url) {
    const headers = record(server.http_headers);
    const fallbackHeaders = record(server.headers);
    return {
      ...baseConfig,
      ...(Object.keys(headers).length ? { http_headers: headers } : {}),
      ...(!Object.keys(headers).length && Object.keys(fallbackHeaders).length
        ? { http_headers: fallbackHeaders }
        : {}),
      url,
    };
  }

  const command = text(server.command);
  if (command) {
    return {
      ...baseConfig,
      ...(stringArray(server.args).length ? { args: stringArray(server.args) } : {}),
      ...(Object.keys(record(server.env)).length ? { env: record(server.env) } : {}),
      command,
    };
  }

  return {};
}

export function codexMcpServerToolConfig(
  serverId: string,
  server: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const defaultToolsApprovalMode =
    text(server.default_tools_approval_mode) || text(server.defaultToolsApprovalMode);
  if (defaultToolsApprovalMode) config.default_tools_approval_mode = defaultToolsApprovalMode;
  const disabledTools = stringArray(server.disabled_tools ?? server.disabledTools);
  if (disabledTools.length) config.disabled_tools = disabledTools;
  const enabledTools = stringArray(server.enabled_tools ?? server.enabledTools);
  if (enabledTools.length) config.enabled_tools = enabledTools;
  const startupTimeoutSec = positiveInteger(server.startup_timeout_sec ?? server.startupTimeoutSec);
  if (startupTimeoutSec !== undefined) config.startup_timeout_sec = startupTimeoutSec;
  const toolTimeoutSec = positiveInteger(server.tool_timeout_sec ?? server.toolTimeoutSec);
  if (toolTimeoutSec !== undefined) config.tool_timeout_sec = toolTimeoutSec;
  const supportsParallelToolCalls = booleanValue(
    server.supports_parallel_tool_calls ?? server.supportsParallelToolCalls,
  );
  if (supportsParallelToolCalls !== undefined)
    config.supports_parallel_tool_calls = supportsParallelToolCalls;

  if (isAguiMcpGatewayServer(serverId, server)) {
    const toolAliases = codexMcpToolAliases(AGUI_MCP_GATEWAY_TOOL_NAMES);
    config.default_tools_approval_mode = text(config.default_tools_approval_mode) || "approve";
    config.enabled_tools = toolAliases;
    config.tools = {
      ...record(server.tools),
      ...Object.fromEntries(toolAliases.map((tool) => [tool, { approval_mode: "approve" }])),
    };
  } else if (Object.keys(record(server.tools)).length) {
    config.tools = record(server.tools);
  }

  return config;
}

export function isAguiMcpGatewayServer(serverId: string, server: Record<string, unknown>): boolean {
  const metadata = record(server.metadata);
  return (
    serverId === AGUI_MCP_GATEWAY_SERVER_ID ||
    metadata.source === "agui.mcpGateway" ||
    metadata.gateway === true
  );
}

export function codexMcpToolAliases(toolNames: string[]): string[] {
  return Array.from(
    new Set(toolNames.flatMap((toolName) => [toolName, toolName.replace(/[^A-Za-z0-9_-]+/g, "_")])),
  );
}

export function codexSkills(cwd: string): Array<Record<string, unknown>> {
  return skillDirectories([
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".codex", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
  ]);
}

export function claudeSkills(cwd: string): Array<Record<string, unknown>> {
  return skillDirectories([
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
  ]);
}

export function codexHooks(cwd: string): Array<Record<string, unknown>> {
  const configFiles = [
    path.join(cwd, ".codex", "config.toml"),
    path.join(os.homedir(), ".codex", "config.toml"),
  ].filter((filePath) => fs.existsSync(filePath));
  return configFiles
    .map((filePath) => ({
      path: filePath,
      hooks: parseTomlHookSummary(readTextFile(filePath)),
    }))
    .filter((item) => Object.keys(item.hooks).length);
}

export function codexPermissionPolicy(
  cwd: string,
  approvalMode: string,
  override: unknown,
): Record<string, unknown> {
  const normalizedMode = normalizeRuntimeApprovalMode(approvalMode);
  return {
    mode: normalizedMode,
    policy: override ?? {
      defaultEffect: normalizedMode === "full" ? "allow" : "ask",
      rules: [],
    },
    sandbox: codexApprovalSettings(approvalMode, cwd).sandboxPolicy,
    config: codexRuntimeConfig(cwd),
  };
}

export function codexSlashCommands(
  cwd: string,
): NonNullable<AspProviderCapabilities["slashCommands"]> {
  return markdownFilesRecursive([
    path.join(cwd, ".codex", "commands"),
    path.join(cwd, ".codex", "prompts"),
    path.join(os.homedir(), ".codex", "commands"),
    path.join(os.homedir(), ".codex", "prompts"),
  ]).map((filePath) => {
    const content = readTextFile(filePath);
    const { body, frontmatter } = parseFrontmatter(content);
    const name = path.basename(filePath, path.extname(filePath));
    return {
      name,
      title: frontmatter.title || frontmatter.name || name,
      description:
        frontmatter.description ||
        body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ||
        undefined,
      insertText: `/${name}`,
      category: filePath.startsWith(cwd) ? "workspace" : "user",
    };
  });
}

export function codexDiffParts(item: Record<string, unknown>): AspMessagePart[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const parts = changes.flatMap((change, index) => {
    const source = record(change);
    const content = rawText(source.diff) ?? rawText(source.patch) ?? rawText(source.content) ?? "";
    if (!content) return [];
    const changedPath = text(source.path) || text(source.newPath) || text(source.new_path);
    return [
      {
        content,
        id: `${text(item.id) || "codex-file-change"}-diff-${index}`,
        oldPath: text(source.oldPath) || text(source.old_path) || undefined,
        path: changedPath || undefined,
        title: changedPath ? `Diff ${changedPath}` : "Diff",
        type: "diff" as const,
      },
    ];
  });
  if (parts.length) return parts;
  const content = rawText(item.diff) ?? rawText(item.patch) ?? "";
  return content
    ? [
        {
          content,
          id: `${text(item.id) || "codex-file-change"}-diff`,
          path: text(item.path) || undefined,
          title: text(item.path) ? `Diff ${text(item.path)}` : "Diff",
          type: "diff",
        },
      ]
    : [];
}

export function codexMessageRecord(
  threadId: string,
  parts: AspMessagePart[],
  tools: AspToolEvent[],
  textParts: Map<string, string>,
): AspMessageRecord {
  return runtimeMessageRecord("codex", threadId || "codex-thread", parts, tools, textParts);
}

export type CodexTranscriptSnapshot = {
  aliases: string[];
  filePath: string;
  messages: AspMessageRecord[];
  session: AspProviderSession;
};

export const CODEX_TRANSCRIPT_FILE_LIMIT = 200;
const CODEX_TRANSCRIPT_SESSION_PREFIX_BYTES = 256 * 1024;
export function codexTranscriptSnapshotForSession(
  sessionId: string,
  providerId: string,
  env: CodexRuntimeEnv = process.env,
): CodexTranscriptSnapshot | null {
  const expected = sessionId.trim();
  if (!expected) return null;
  const directFilePath = codexTranscriptFileForSession(expected, env);
  if (directFilePath) return codexTranscriptSnapshot(directFilePath, providerId, env);
  let aliasMatch: CodexTranscriptSnapshot | null = null;
  for (const filePath of codexTranscriptFiles(CODEX_TRANSCRIPT_FILE_LIMIT, env)) {
    const snapshot = codexTranscriptSnapshot(filePath, providerId, env);
    if (snapshot.session.id === expected) return snapshot;
    if (!aliasMatch && snapshot.aliases.includes(expected)) aliasMatch = snapshot;
  }
  return aliasMatch;
}

export function codexTranscriptFiles(
  limit = CODEX_TRANSCRIPT_FILE_LIMIT,
  env: CodexRuntimeEnv = process.env,
): string[] {
  const roots = codexTranscriptRoots(env);
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of safeReadDir(directory)) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && filePath.endsWith(".jsonl")) {
        files.push(filePath);
      }
    }
  };
  for (const root of roots) walk(root);
  return files
    .map((filePath) => ({ filePath, mtimeMs: safeStat(filePath)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => item.filePath);
}

export function codexTranscriptSession(
  filePath: string,
  providerId: string,
  env: CodexRuntimeEnv = process.env,
): AspProviderSession {
  const stat = safeStat(filePath);
  const fileId = codexTranscriptFileId(filePath);
  let createdAt = stat?.birthtimeMs || stat?.ctimeMs || stat?.mtimeMs || Date.now();
  const updatedAt = stat?.mtimeMs || createdAt;
  let transcriptId = fileId;
  let sourceSessionId = "";
  let cwd = "";
  let model = "";
  let transcriptTitle = "";
  let firstUserMessage = "";
  let windowTokens: number | undefined;
  let autoCompaction: boolean | undefined;
  const content = readFilePrefix(filePath, CODEX_TRANSCRIPT_SESSION_PREFIX_BYTES);
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = record(parseJson(line));
    if (!Object.keys(event).length) continue;
    const timestamp = timeMs(event.timestamp);
    if (timestamp !== undefined) createdAt = Math.min(createdAt, timestamp);
    const payload = record(event.payload);
    const outerType = text(event.type);
    const payloadType = text(payload.type);
    if (outerType === "session_meta") {
      transcriptId = text(payload.id) || transcriptId;
      sourceSessionId = text(payload.session_id) || sourceSessionId;
      cwd = text(payload.cwd) || cwd;
      model = text(payload.model) || model;
      transcriptTitle = transcriptTitleFromRecord(payload) || transcriptTitle;
      windowTokens = positiveInteger(payload.model_context_window) ?? windowTokens;
      continue;
    }
    if (isTranscriptTitleEvent(outerType, payloadType)) {
      transcriptTitle =
        transcriptTitleFromRecord(payload) || transcriptTitleFromRecord(event) || transcriptTitle;
      continue;
    }
    if (outerType === "turn_context") {
      cwd = text(payload.cwd) || cwd;
      model = text(payload.model) || model;
      continue;
    }
    if (outerType === "compacted" || payloadType === "context_compacted") {
      autoCompaction = true;
      continue;
    }
    if (outerType === "event_msg" && payloadType === "task_started") {
      windowTokens = positiveInteger(payload.model_context_window) ?? windowTokens;
      continue;
    }
    if (!firstUserMessage && outerType === "response_item") {
      const item = normalizeCodexTranscriptItem(payload);
      if (codexTranscriptMessageRole(payload, item) === "user") {
        firstUserMessage = transcriptVisibleUserText(
          contentText(item.content) || rawText(item.text) || rawText(item.message) || "",
        );
      }
    }
  }
  const id = transcriptId || sourceSessionId || fileId || path.basename(filePath, ".jsonl");
  const title =
    codexSessionIndexTitleForEnv(env, id, transcriptId, sourceSessionId, fileId) ||
    transcriptTitle ||
    summarizeTitle(firstUserMessage) ||
    id;
  const context = {
    windowTokens,
    autoCompaction,
  };
  return {
    id,
    title,
    context:
      context.windowTokens === undefined && context.autoCompaction === undefined
        ? undefined
        : context,
    createdAt,
    updatedAt,
    cwd: cwd || undefined,
    projectPath: cwd || undefined,
    model: model || undefined,
    providerId,
    metadata: {
      adapter: "codex-app-server",
      source: "codex-transcript",
      transcriptPath: filePath,
      ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
    },
  };
}

export function codexTranscriptSnapshot(
  filePath: string,
  providerId: string,
  env: CodexRuntimeEnv = process.env,
): CodexTranscriptSnapshot {
  const stat = safeStat(filePath);
  const messages: AspMessageRecord[] = [];
  const toolMessages = new Map<string, AspMessageRecord>();
  const outputByCallId = new Map<string, string>();
  const fileId = codexTranscriptFileId(filePath);
  let createdAt = stat?.birthtimeMs || stat?.ctimeMs || stat?.mtimeMs || Date.now();
  let updatedAt = stat?.mtimeMs || createdAt;
  let transcriptId = fileId;
  let sourceSessionId = "";
  let cwd = "";
  let model = "";
  let firstUserMessage = "";
  let transcriptTitle = "";
  let lastUsage: ReturnType<typeof normalizeUsage>;
  let windowTokens: number | undefined;
  let autoCompaction: boolean | undefined;

  const lines = readTextFile(filePath).split(/\r?\n/).filter(Boolean);
  const seenTranscriptMessageIds = new Set<string>();
  const responseItemIds = new Set<string>();
  for (const line of lines) {
    const event = record(parseJson(line));
    if (text(event.type) !== "response_item") continue;
    const item = record(event.payload);
    for (const alias of codexToolAliases(item, text(item.id))) {
      if (alias) responseItemIds.add(alias);
    }
  }
  const appendTranscriptMessage = (
    item: Record<string, unknown>,
    eventPayload: Record<string, unknown>,
    fallbackId: string,
    at: number,
  ) => {
    const role = codexTranscriptMessageRole(eventPayload, item);
    if (role !== "assistant" && role !== "user") return;
    const rawContent =
      contentText(item.content) || rawText(item.text) || rawText(item.message) || "";
    const content = role === "user" ? transcriptVisibleUserText(rawContent) : rawContent;
    const attachments = role === "user" ? codexTranscriptAttachments(item) : [];
    if (role === "user" && !content && !attachments.length) return;
    const messageId = text(item.id) || fallbackId;
    if (seenTranscriptMessageIds.has(messageId)) return;
    seenTranscriptMessageIds.add(messageId);
    if (role === "user" && !firstUserMessage && content.trim()) firstUserMessage = content;
    const part = content
      ? {
          content,
          id: `${messageId}-text`,
          type: "text" as const,
        }
      : undefined;
    messages.push({
      id: messageId,
      role,
      content,
      createdAt: at,
      parts: part ? [part] : undefined,
      metadata: {
        ...codexTranscriptMetadata(item, filePath),
        ...(attachments.length ? { attachments } : {}),
      },
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const event = record(parseJson(lines[index] ?? ""));
    if (!Object.keys(event).length) continue;
    const timestamp = timeMs(event.timestamp);
    if (timestamp !== undefined) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }
    const payload = record(event.payload);
    const outerType = text(event.type);
    const payloadType = text(payload.type);

    if (outerType === "session_meta") {
      transcriptId = text(payload.id) || transcriptId;
      sourceSessionId = text(payload.session_id) || sourceSessionId;
      cwd = text(payload.cwd) || cwd;
      model = text(payload.model) || model;
      transcriptTitle = transcriptTitleFromRecord(payload) || transcriptTitle;
      windowTokens = positiveInteger(payload.model_context_window) ?? windowTokens;
      continue;
    }

    if (isTranscriptTitleEvent(outerType, payloadType)) {
      transcriptTitle =
        transcriptTitleFromRecord(payload) || transcriptTitleFromRecord(event) || transcriptTitle;
      continue;
    }

    if (outerType === "turn_context") {
      cwd = text(payload.cwd) || cwd;
      model = text(payload.model) || model;
      continue;
    }

    if (outerType === "compacted" || payloadType === "context_compacted") {
      autoCompaction = true;
      const replacementHistory = array(payload.replacement_history ?? payload.replacementHistory);
      for (let historyIndex = 0; historyIndex < replacementHistory.length; historyIndex += 1) {
        const historyItem = normalizeCodexTranscriptItem(record(replacementHistory[historyIndex]));
        if (text(historyItem.type) !== "message") continue;
        appendTranscriptMessage(
          historyItem,
          historyItem,
          `codex-compacted-${index}-${historyIndex}`,
          timestamp ?? updatedAt,
        );
      }
      continue;
    }

    if (outerType === "event_msg" && payloadType === "task_started") {
      windowTokens = positiveInteger(payload.model_context_window) ?? windowTokens;
      continue;
    }

    if (outerType === "event_msg" && payloadType === "token_count") {
      const usage = normalizeUsage(payload);
      if (usage) {
        lastUsage = usage;
        windowTokens = usage.contextWindowTokens ?? windowTokens;
      }
      continue;
    }

    const completedItem =
      outerType === "event_msg" && payloadType === "item_completed"
        ? normalizeCodexTranscriptItem(record(payload.item))
        : null;
    if (completedItem) {
      const aliases = codexToolAliases(completedItem, text(completedItem.id));
      if (aliases.some((alias) => responseItemIds.has(alias))) continue;
    } else if (outerType !== "response_item") {
      continue;
    }
    const item = completedItem ?? normalizeCodexTranscriptItem(payload);
    const itemType = text(item.type);
    const messageCreatedAt = timeMs(payload.completed_at_ms) ?? timestamp ?? updatedAt;

    if (itemType === "message") {
      appendTranscriptMessage(item, payload, `codex-message-${index}`, messageCreatedAt);
      continue;
    }

    if (isCodexReasoningKind(itemType)) {
      const content = codexReasoningText(item) ?? "";
      if (!content.trim()) continue;
      messages.push({
        id: text(item.id) || `codex-reasoning-${index}`,
        role: "assistant",
        content,
        createdAt: messageCreatedAt,
        parts: [
          {
            content,
            id: text(item.id) || `codex-reasoning-${index}`,
            type: "reasoning",
          },
        ],
        metadata: codexTranscriptMetadata(item, filePath),
      });
      continue;
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = text(item.call_id) || text(item.callId) || text(item.id);
      const output = contentText(item.output ?? item.content);
      if (callId && output) outputByCallId.set(callId, output);
      const existing = callId ? toolMessages.get(callId) : undefined;
      if (existing) {
        patchTranscriptTool(existing, output, item);
      } else {
        const tool = codexTool(item, "completed", output);
        if (tool) {
          const message = codexToolMessage(tool, messageCreatedAt, filePath);
          messages.push(message);
          for (const alias of codexToolAliases(item, tool.id)) toolMessages.set(alias, message);
        }
      }
      continue;
    }

    const tool = codexTool(item, "started", "");
    if (tool) {
      const callId = text(item.call_id) || text(item.callId);
      const output = callId ? (outputByCallId.get(callId) ?? "") : "";
      if (output) {
        tool.output = output;
        tool.phase = "completed";
        tool.status = "completed";
      }
      const message = codexToolMessage(tool, messageCreatedAt, filePath);
      messages.push(message);
      for (const alias of codexToolAliases(item, tool.id)) toolMessages.set(alias, message);
    }
  }

  const id = transcriptId || sourceSessionId || fileId || path.basename(filePath, ".jsonl");
  const title =
    codexSessionIndexTitleForEnv(env, id, transcriptId, sourceSessionId, fileId) ||
    transcriptTitle ||
    summarizeTitle(firstUserMessage) ||
    id;
  const context = {
    usedTokens: lastUsage?.contextTokens ?? lastUsage?.totalTokens,
    windowTokens: lastUsage?.contextWindowTokens ?? windowTokens,
    autoCompaction,
  };
  const session: AspProviderSession = {
    id,
    title,
    context:
      context.usedTokens === undefined &&
      context.windowTokens === undefined &&
      context.autoCompaction === undefined
        ? undefined
        : context,
    createdAt,
    updatedAt,
    cwd: cwd || undefined,
    projectPath: cwd || undefined,
    model: model || undefined,
    providerId,
    usage: lastUsage,
    metadata: {
      adapter: "codex-app-server",
      source: "codex-transcript",
      transcriptPath: filePath,
      ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
    },
  };
  return {
    aliases: Array.from(new Set([id, transcriptId, sourceSessionId, fileId].filter(Boolean))),
    filePath,
    messages,
    session,
  };
}

export function codexToolMessage(
  tool: AspToolEvent,
  createdAt: number,
  filePath: string,
): AspMessageRecord {
  return {
    id: `${tool.id}-message`,
    role: "assistant",
    content: tool.output ?? "",
    createdAt,
    parts: [{ id: tool.id, toolEvent: tool, type: "tool" }],
    toolEvents: [tool],
    metadata: { source: "codex-transcript", transcriptPath: filePath },
  };
}

export function patchTranscriptTool(
  message: AspMessageRecord,
  output: string,
  source: Record<string, unknown>,
): void {
  const firstPart = message.parts?.[0];
  const tool =
    message.toolEvents?.[0] ?? (firstPart?.type === "tool" ? firstPart.toolEvent : undefined);
  if (!tool) return;
  tool.output = output || tool.output;
  tool.error = rawText(source.error) || nestedText(source, "error", "message") || tool.error;
  tool.phase = "completed";
  tool.status = tool.error ? "failed" : "completed";
  message.content = tool.output ?? message.content;
}

export function codexToolAliases(item: Record<string, unknown>, fallback: string): string[] {
  return Array.from(
    new Set(
      [
        fallback,
        text(item.id),
        text(item.call_id),
        text(item.callId),
        text(item.tool_call_id),
        text(item.toolCallId),
      ].filter(Boolean),
    ),
  );
}

export function isCodexApproval(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(method);
}

export function codexApprovalScope(method: string, params: unknown): string {
  const lower = method.toLowerCase();
  if (lower.includes("exec") || lower.includes("command")) return "command";
  if (lower.includes("patch") || lower.includes("file")) return "filesystem";
  if (lower.includes("permission") || record(params).permissions !== undefined) return "sandbox";
  return "tool";
}

export function codexApprovalTitle(method: string, params: unknown): string {
  const source = record(params);
  return (
    text(source.command) ||
    text(source.cmd) ||
    text(source.tool) ||
    text(source.toolName) ||
    text(source.name) ||
    method
  );
}

export function codexApprovalResponse(
  method: string,
  params: unknown,
  decision: AspApprovalDecision,
): unknown | Error {
  if (method === "item/permissions/requestApproval") {
    if (decision !== "allow" && decision !== "allow-session" && decision !== "allow-always") {
      return new Error("Permission request declined by the user.");
    }
    const requested = record(record(params).permissions);
    return {
      permissions: {
        ...(requested.network !== undefined ? { network: requested.network } : {}),
        ...(requested.fileSystem !== undefined ? { fileSystem: requested.fileSystem } : {}),
      },
      scope: decision === "allow" ? "turn" : "session",
    };
  }
  const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
  const mapped = legacy
    ? decision === "allow"
      ? "approved"
      : decision === "allow-session"
        ? "approved_for_session"
        : decision === "allow-always"
          ? "approved_for_session"
          : decision === "cancel"
            ? "abort"
            : "denied"
    : decision === "allow"
      ? "accept"
      : decision === "allow-session"
        ? "acceptForSession"
        : decision === "allow-always"
          ? codexAlwaysApprovalDecision(params)
          : decision === "cancel"
            ? "cancel"
            : "decline";
  return { decision: mapped };
}

export function codexAlwaysApprovalDecision(params: unknown): unknown {
  const source = record(params);
  const execpolicyAmendment =
    source.proposedExecpolicyAmendment ??
    source.proposedExecPolicyAmendment ??
    source.execpolicyAmendment ??
    source.execPolicyAmendment;
  if (execpolicyAmendment !== undefined) {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: execpolicyAmendment,
      },
    };
  }
  const networkPolicyAmendment =
    firstArrayItem(source.proposedNetworkPolicyAmendments) ??
    source.proposedNetworkPolicyAmendment ??
    firstArrayItem(source.networkPolicyAmendments) ??
    source.networkPolicyAmendment;
  if (networkPolicyAmendment !== undefined) {
    return {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: networkPolicyAmendment,
      },
    };
  }
  return "acceptForSession";
}

export function firstArrayItem(value: unknown): unknown {
  return Array.isArray(value) && value.length ? value[0] : undefined;
}
