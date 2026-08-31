import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeUsage } from "../asp-protocol.js";
import {
  ancestorFiles,
  claudeSettingsFiles,
  markdownFiles,
  markdownFilesRecursive,
  mergeRecords,
  readJsonFile,
  readTextFile,
  walkDirectory,
} from "./filesystem.js";
import {
  isReadableTranscriptPath,
  safeReadDir,
  safeStat,
  summarizeTitle,
  transcriptVisibleUserText,
} from "./codex.js";
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

export function claudeApprovalResponse(
  decision: AspApprovalDecision,
  input: unknown,
): Record<string, unknown> {
  return decision === "allow" || decision === "allow-session" || decision === "allow-always"
    ? { behavior: "allow", updatedInput: record(input) }
    : {
        behavior: "deny",
        message:
          decision === "cancel"
            ? "Permission request cancelled by the user."
            : "Permission request denied by the user.",
      };
}

export function claudeCapabilities(
  capabilities: AspProviderCapabilities | undefined,
  cwd = process.cwd(),
): AspProviderCapabilities {
  return {
    ...nativeAdapterCapabilities(capabilities),
    deleteSession: true,
    resumeSession: true,
    sessionHistory: true,
    sessions: true,
    slashCommands: capabilities?.slashCommands ?? claudeSlashCommands(cwd),
    extensions: mergeExtensions(capabilities?.extensions, [
      ...compactExtensions([
        standardExtension("asp.ext.agents", [
          "list_agents",
          "select_agent",
          "invoke_agent",
          "cancel_agent",
        ]),
        standardExtension("asp.ext.hooks", ["list_hooks", "set_hooks"]),
        standardExtension("asp.ext.permissions", ["get_policy", "set_policy"]),
        standardExtension("asp.ext.tools"),
        standardExtension("asp.ext.run-control", ["steer", "follow_up", "abort_current_step"]),
        standardExtension("asp.ext.session-state", ["get_state", "get_messages"]),
        standardExtension("asp.ext.runtime", ["get_runtime"]),
        standardExtension("asp.ext.multimodal"),
      ]),
      {
        id: "vendor.claude.cli",
        version: "0.1.0",
        stability: "vendor",
        fallback: "raw",
        methods: [
          {
            name: "raw_input",
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

export function claudeQuestionResponse(
  result: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  const updatedInput = { ...record(input) };
  const answers = Array.isArray(result.answers) ? result.answers : [];
  const answerMap: Record<string, string> = {};
  for (const item of answers) {
    const answer = record(item) as Record<string, unknown> & Partial<AspQuestionAnswer>;
    const question = text(answer.question);
    const value = Array.isArray(answer.answer)
      ? answer.answer.map(String).join(", ")
      : text(answer.answer);
    if (question && value) answerMap[question] = value;
  }
  if (Object.keys(answerMap).length) updatedInput.answers = answerMap;
  const app = record(result.app);
  if (Object.keys(app).length) updatedInput.app = app;
  return { behavior: "allow", updatedInput };
}

export function claudeUserContent(
  run: Record<string, unknown>,
  selectedAgent: string,
): Array<Record<string, unknown>> {
  const contextPrompt = promptWithConversationContext(run);
  const prompt = selectedAgent
    ? `Use the ${selectedAgent} subagent for this request.\n\n${contextPrompt}`
    : contextPrompt;
  const content: Array<Record<string, unknown>> = [{ text: prompt, type: "text" }];
  for (const attachment of array(run.attachments)) {
    const item = record(attachment);
    const filePath = text(item.path);
    if (!filePath) continue;
    if (/\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(filePath)) {
      const image = imageContentBlock(filePath);
      if (image) content.push(image);
    } else {
      content.push({ text: `Attached file: ${filePath}`, type: "text" });
    }
  }
  for (const part of array(run.inputParts ?? record(run.input).parts)) {
    const input = record(part);
    const type = text(input.type);
    if (type === "image_base64" && rawText(input.data)) {
      content.push({
        source: {
          data: rawText(input.data),
          media_type: text(input.mimeType) || text(input.mime_type) || "image/png",
          type: "base64",
        },
        type: "image",
      });
    } else if (type === "image_ref" && text(input.path)) {
      const image = imageContentBlock(text(input.path));
      if (image) content.push(image);
    } else if (type === "file_ref" && text(input.path)) {
      content.push({ text: `Attached file: ${text(input.path)}`, type: "text" });
    }
  }
  return content;
}

export function imageContentBlock(filePath: string): Record<string, unknown> | null {
  try {
    return {
      source: {
        data: fs.readFileSync(filePath).toString("base64"),
        media_type: imageMimeType(filePath),
        type: "base64",
      },
      type: "image",
    };
  } catch {
    return { text: `Attached image: ${filePath}`, type: "text" };
  }
}

export function claudeAgents(cwd: string): AspAgentProfile[] {
  const directories = [
    path.join(cwd, ".claude", "agents"),
    path.join(os.homedir(), ".claude", "agents"),
  ];
  const agents = new Map<string, AspAgentProfile>();
  for (const directory of directories) {
    for (const filePath of markdownFiles(directory)) {
      const agent = claudeAgentFromFile(filePath);
      if (agent) agents.set(agent.id, agent);
    }
  }
  return [...agents.values()];
}

export function claudeAgentFromFile(filePath: string): AspAgentProfile | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const { body, frontmatter } = parseFrontmatter(content);
    const id = frontmatter.name || path.basename(filePath, path.extname(filePath));
    if (!id) return null;
    return {
      id,
      name: frontmatter.title || frontmatter.name || id,
      role: "subagent",
      description:
        frontmatter.description ||
        body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ||
        undefined,
      defaultModel: frontmatter.model,
      tools: frontmatter.tools ? splitList(frontmatter.tools) : undefined,
      isolation: frontmatter.isolation === "worktree" ? "worktree" : undefined,
      memory: frontmatter.memory === "isolated" ? "isolated" : undefined,
      background: frontmatter.background === "true",
      metadata: { path: filePath },
    };
  } catch {
    return null;
  }
}

export function claudeHooks(cwd: string): Array<Record<string, unknown>> {
  const hooks: Array<Record<string, unknown>> = [];
  for (const filePath of claudeSettingsFiles(cwd)) {
    const settings = readJsonFile(filePath);
    for (const [event, handlers] of Object.entries(record(settings.hooks))) {
      hooks.push({
        event,
        handlers,
        source: filePath.startsWith(cwd) ? "workspace" : "user",
        path: filePath,
      });
    }
  }
  return hooks;
}

export function claudePermissionPolicy(cwd: string, approvalMode: string): Record<string, unknown> {
  const normalizedMode = normalizeRuntimeApprovalMode(approvalMode);
  const permissionMode = claudePermissionMode(approvalMode);
  const settings = claudeSettingsFiles(cwd)
    .map((filePath) => ({ filePath, settings: readJsonFile(filePath) }))
    .filter((item) => Object.keys(item.settings).length);
  return {
    mode: normalizedMode,
    permissionMode,
    policy: {
      defaultEffect: normalizedMode === "full" ? "allow" : "ask",
      rules: [],
    },
    settings: settings.map((item) => ({
      path: item.filePath,
      permissions: record(item.settings.permissions),
      permissionMode: text(item.settings.permissionMode) || undefined,
      allowedTools: stringArray(item.settings.allowedTools),
      disallowedTools: stringArray(item.settings.disallowedTools),
    })),
  };
}

export function claudePermissionMode(
  approvalMode: string,
): "manual" | "auto" | "bypassPermissions" {
  const normalizedMode = normalizeRuntimeApprovalMode(approvalMode);
  if (normalizedMode === "full") return "bypassPermissions";
  if (normalizedMode === "auto") return "auto";
  return "manual";
}

export function claudeSettingsFromPolicy(policy: unknown): Record<string, unknown> {
  const source = record(policy);
  return {
    ...(source.permissionMode !== undefined
      ? { permissionMode: text(source.permissionMode) || source.permissionMode }
      : {}),
    ...(source.permissions !== undefined ? { permissions: source.permissions } : {}),
    ...(source.allowedTools !== undefined
      ? { allowedTools: stringArray(source.allowedTools) }
      : {}),
    ...(source.disallowedTools !== undefined
      ? { disallowedTools: stringArray(source.disallowedTools) }
      : {}),
  };
}

export function writeClaudeSettings(
  cwd: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const directory = path.join(cwd, ".claude");
  const filePath = path.join(directory, "settings.local.json");
  fs.mkdirSync(directory, { recursive: true });
  const current = readJsonFile(filePath);
  const next = mergeRecords(current, patch);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { path: filePath, settings: next };
}

export function claudeSlashCommands(
  cwd: string,
): NonNullable<AspProviderCapabilities["slashCommands"]> {
  return markdownFilesRecursive([
    path.join(cwd, ".claude", "commands"),
    path.join(os.homedir(), ".claude", "commands"),
  ]).map((filePath) => {
    const content = readTextFile(filePath);
    const { body, frontmatter } = parseFrontmatter(content);
    return {
      name: path.basename(filePath, path.extname(filePath)),
      title:
        frontmatter.title || frontmatter.name || path.basename(filePath, path.extname(filePath)),
      description:
        frontmatter.description ||
        body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ||
        undefined,
      path: filePath,
      source: filePath.startsWith(cwd) ? "workspace" : "user",
      arguments: frontmatter.argumentHint || frontmatter.arguments || undefined,
    };
  });
}

export function claudeOutputStyles(cwd: string): Array<Record<string, unknown>> {
  return markdownFilesRecursive([
    path.join(cwd, ".claude", "output-styles"),
    path.join(os.homedir(), ".claude", "output-styles"),
  ]).map((filePath) => {
    const content = readTextFile(filePath);
    const { body, frontmatter } = parseFrontmatter(content);
    return {
      id: frontmatter.name || path.basename(filePath, path.extname(filePath)),
      name:
        frontmatter.title || frontmatter.name || path.basename(filePath, path.extname(filePath)),
      description:
        frontmatter.description ||
        body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ||
        undefined,
      path: filePath,
      source: filePath.startsWith(cwd) ? "workspace" : "user",
    };
  });
}

export function claudeMemoryFiles(cwd: string): Array<Record<string, unknown>> {
  return ancestorFiles(cwd, "CLAUDE.md").map((filePath) => ({
    path: filePath,
    source: filePath.startsWith(cwd) ? "workspace" : "ancestor",
    preview: readTextFile(filePath).slice(0, 1000),
  }));
}

export function claudeMcpServers(cwd: string): Record<string, unknown> {
  const sources = [
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".claude", "mcp.json"),
    path.join(os.homedir(), ".claude", "mcp.json"),
  ].filter((filePath) => fs.existsSync(filePath));
  const servers: Record<string, unknown> = {};
  for (const filePath of sources) {
    const config = readJsonFile(filePath);
    Object.assign(servers, record(config.mcpServers ?? config.servers));
  }
  for (const filePath of claudeSettingsFiles(cwd)) {
    Object.assign(servers, record(readJsonFile(filePath).mcpServers));
  }
  return servers;
}

export function claudeSettingsSnapshot(cwd: string): Array<Record<string, unknown>> {
  return claudeSettingsFiles(cwd).map((filePath) => ({
    path: filePath,
    source: filePath.startsWith(cwd) ? "workspace" : "user",
    settings: readJsonFile(filePath),
  }));
}

export function claudeAgentTool(
  name: string,
  input: Record<string, unknown>,
): { agentId: string; prompt?: string } | null {
  const lower = name.toLowerCase();
  if (!["task", "agent"].includes(lower) && !lower.includes("agent")) return null;
  const agentId =
    text(input.subagent_type) ||
    text(input.agentId) ||
    text(input.agent) ||
    text(input.description) ||
    "subagent";
  return {
    agentId,
    prompt: text(input.prompt) || text(input.message) || undefined,
  };
}

export function claudeToolSemantic(
  name: string,
  input: unknown,
): NonNullable<AspToolEvent["semantic"]> {
  const semantic = toolSemanticFromName(name);
  if (semantic.toolType === "tool" && claudeAgentTool(name, record(input))) {
    return { resultKind: "json", toolType: "agent.invoke" };
  }
  return semantic;
}

export function claudeMessageRecord(
  sessionId: string,
  parts: AspMessagePart[],
  tools: AspToolEvent[],
  textParts: Map<string, string>,
): AspMessageRecord {
  return runtimeMessageRecord("claude", sessionId || "claude-session", parts, tools, textParts);
}

export type ClaudeTranscriptSnapshot = {
  aliases: string[];
  filePath: string;
  messages: AspMessageRecord[];
  session: AspProviderSession;
};

export const CLAUDE_TRANSCRIPT_FILE_LIMIT = 200;

export function claudeTranscriptSnapshotForSession(
  sessionId: string,
  providerId: string,
): ClaudeTranscriptSnapshot | null {
  const expected = sessionId.trim();
  if (!expected) return null;
  if (isReadableTranscriptPath(expected)) return claudeTranscriptSnapshot(expected, providerId);
  let aliasMatch: ClaudeTranscriptSnapshot | null = null;
  for (const filePath of claudeTranscriptFiles()) {
    const snapshot = claudeTranscriptSnapshot(filePath, providerId);
    if (snapshot.session.id === expected) return snapshot;
    if (!aliasMatch && snapshot.aliases.includes(expected)) aliasMatch = snapshot;
  }
  return aliasMatch;
}

export function claudeTranscriptFiles(limit = CLAUDE_TRANSCRIPT_FILE_LIMIT): string[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of safeReadDir(directory)) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && filePath.endsWith(".jsonl")) files.push(filePath);
    }
  };
  walk(root);
  return files
    .map((filePath) => ({ filePath, mtimeMs: safeStat(filePath)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => item.filePath);
}

export function claudeTranscriptSnapshot(
  filePath: string,
  providerId: string,
): ClaudeTranscriptSnapshot {
  const stat = safeStat(filePath);
  const fileId = path.basename(filePath, ".jsonl");
  const messages: AspMessageRecord[] = [];
  const toolMessages = new Map<string, AspMessageRecord>();
  let createdAt = stat?.birthtimeMs || stat?.ctimeMs || stat?.mtimeMs || Date.now();
  let updatedAt = stat?.mtimeMs || createdAt;
  let sessionId = fileId;
  let cwd = "";
  let model = "";
  let firstUserMessage = "";
  let lastUsage: ReturnType<typeof normalizeUsage>;

  const lines = readTextFile(filePath).split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const event = record(parseJson(lines[index] ?? ""));
    if (!Object.keys(event).length) continue;
    const timestamp = timeMs(event.timestamp);
    if (timestamp !== undefined) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }
    sessionId = text(event.sessionId) || text(event.session_id) || sessionId;
    cwd = text(event.cwd) || cwd;
    const type = text(event.type);
    if (type !== "user" && type !== "assistant") continue;
    if (event.isMeta === true) continue;

    const message = record(event.message);
    const role = text(message.role) === "user" || type === "user" ? "user" : "assistant";
    const content = Array.isArray(message.content)
      ? message.content
      : rawText(message.content)
        ? [{ text: message.content, type: "text" }]
        : [];
    if (role === "user") {
      const fallbackId = text(event.uuid) || `claude-user-${index}`;
      const parts = claudeUserTextParts(content, fallbackId);
      const attachments = claudeUserAttachments(content, fallbackId);
      const textContent = parts.map((part) => part.content).join("");
      if (textContent && !firstUserMessage) firstUserMessage = textContent;
      for (const partValue of content) {
        const part = record(partValue);
        if (text(part.type) !== "tool_result") continue;
        const toolId = text(part.tool_use_id) || text(part.toolUseId);
        if (!toolId) continue;
        const existing = toolMessages.get(toolId);
        if (existing) patchClaudeTranscriptTool(existing, part);
      }
      if (textContent || attachments.length) {
        messages.push({
          id: fallbackId,
          role: "user",
          content: textContent,
          createdAt: timestamp ?? updatedAt,
          parts: parts.length ? parts : undefined,
          metadata: claudeTranscriptMetadata(event, filePath, attachments),
        });
      }
      continue;
    }

    model = text(message.model) || model;
    const parts: AspMessagePart[] = [];
    const tools: AspToolEvent[] = [];
    for (const partValue of content) {
      const part = record(partValue);
      const partType = text(part.type);
      const partId = text(part.id) || `${text(event.uuid) || "claude"}-${parts.length}`;
      if (partType === "text") {
        const value = rawText(part.text) ?? rawText(part.content) ?? "";
        if (value) parts.push({ content: value, id: partId, type: "text" });
      } else if (partType === "thinking") {
        const value = rawText(part.thinking) ?? rawText(part.text) ?? rawText(part.content) ?? "";
        if (value) parts.push({ content: value, id: partId, type: "reasoning" });
      } else if (partType === "tool_use") {
        const tool = claudeTranscriptTool(part, "started");
        if (tool) {
          tools.push(tool);
          parts.push({ id: tool.id, toolEvent: tool, type: "tool" });
        }
      }
    }
    const usage = normalizeUsage(message.usage);
    if (usage) lastUsage = usage;
    const textContent = parts
      .map((part) => ("content" in part ? (part.content ?? "") : ""))
      .filter(Boolean)
      .join("");
    const recordMessage: AspMessageRecord = {
      id: text(event.uuid) || text(message.id) || `claude-assistant-${index}`,
      role: "assistant",
      content: textContent,
      createdAt: timestamp ?? updatedAt,
      parts: parts.length ? parts : undefined,
      toolEvents: tools.length ? tools : undefined,
      usage,
      metadata: claudeTranscriptMetadata(event, filePath),
    };
    messages.push(recordMessage);
    for (const tool of tools) toolMessages.set(tool.id, recordMessage);
  }

  const title = summarizeTitle(firstUserMessage) || sessionId;
  const session: AspProviderSession = {
    id: sessionId,
    title,
    createdAt,
    updatedAt,
    cwd: cwd || undefined,
    projectPath: cwd || undefined,
    model: model || undefined,
    providerId,
    usage: lastUsage,
    metadata: {
      adapter: "claude-code-stream-json",
      source: "claude-transcript",
      transcriptPath: filePath,
    },
  };
  return {
    aliases: Array.from(new Set([sessionId, fileId].filter(Boolean))),
    filePath,
    messages,
    session,
  };
}

export function claudeUserTextParts(
  content: unknown[],
  fallbackId: string,
): Array<Extract<AspMessagePart, { type: "text" }>> {
  return content.flatMap((partValue, index) => {
    const part = record(partValue);
    if (text(part.type) !== "text") return [];
    const value = transcriptVisibleUserText(rawText(part.text) ?? rawText(part.content) ?? "");
    return value
      ? [{ content: value, id: `${fallbackId}-text-${index}`, type: "text" as const }]
      : [];
  });
}

export function claudeUserAttachments(
  content: unknown[],
  fallbackId: string,
): Array<Record<string, unknown>> {
  return content.flatMap((partValue, index) => {
    const part = record(partValue);
    const partType = text(part.type);
    if (partType !== "image" && partType !== "image_ref") return [];
    const source = record(part.source);
    const mime = safeImageMimeType(
      text(source.media_type) ||
        text(source.mediaType) ||
        text(part.mimeType) ||
        text(part.mime_type),
    );
    const data = rawText(source.data) ?? rawText(part.data);
    const url =
      data && (text(source.type) === "base64" || !text(source.type))
        ? `data:${mime};base64,${data}`
        : text(source.url) || text(part.url);
    const imagePath =
      text(part.path) ||
      text(part.file_path) ||
      text(part.filePath) ||
      text(source.path) ||
      text(source.file_path) ||
      text(source.filePath);
    if (!url && !imagePath) return [];
    return [
      {
        id: `${fallbackId}-image-${index}`,
        kind: "image",
        name: text(part.name) || text(source.name) || `Image ${index + 1}`,
        mime,
        ...(url ? { url } : {}),
        ...(imagePath ? { path: imagePath } : {}),
      },
    ];
  });
}

function safeImageMimeType(value: string): string {
  return /^image\/[-+.\w]+$/i.test(value) ? value : "image/png";
}

export function claudeTranscriptTool(
  part: Record<string, unknown>,
  phase: AspToolEvent["phase"],
  output = "",
): AspToolEvent | null {
  const id = text(part.id) || text(part.tool_use_id) || text(part.toolUseId);
  if (!id) return null;
  const name = text(part.name) || text(part.tool) || "Tool call";
  const error =
    part.is_error === true || part.isError === true ? output || "Tool failed." : undefined;
  return {
    id,
    error,
    input: part.input,
    kind: name,
    name,
    output: output || undefined,
    phase,
    semantic: claudeToolSemantic(name, part.input),
    status: error ? "failed" : phase === "completed" ? "completed" : "inProgress",
  };
}

export function patchClaudeTranscriptTool(
  message: AspMessageRecord,
  result: Record<string, unknown>,
): void {
  const toolId = text(result.tool_use_id) || text(result.toolUseId);
  const tool = message.toolEvents?.find((item) => item.id === toolId);
  if (!tool) return;
  const output = contentText(result.content);
  tool.output = output || tool.output;
  tool.error =
    result.is_error === true || result.isError === true ? output || "Tool failed." : tool.error;
  tool.phase = "completed";
  tool.status = tool.error ? "failed" : "completed";
}

export function claudeTranscriptMetadata(
  event: Record<string, unknown>,
  filePath: string,
  attachments: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    source: "claude-transcript",
    transcriptPath: filePath,
    ...(text(event.parentUuid) ? { parentUuid: text(event.parentUuid) } : {}),
    ...(text(event.uuid) ? { uuid: text(event.uuid) } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}
