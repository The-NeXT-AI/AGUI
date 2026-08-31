import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { normalizeUsage } from "../asp-protocol.js";
import { splitProviderCommand } from "../provider-store.js";
import {
  ASP_ERROR_CODES,
  ASP_NAME,
  ASP_VERSION,
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
import { RuntimeConnection, type PendingRequest, type RpcMessage } from "./base.js";
import {
  openCodeCapabilities,
  normalizeOpenCodeServerArgs,
  openCodeSessionTitle,
  openCodeAgent,
  openCodeModelSelection,
  openCodePromptParts,
  openCodeModels,
  openCodeSessions,
  openCodeAgents,
  openCodeSession,
  openCodeSessionState,
  openCodeMessages,
  openCodePartRecord,
  openCodePartDelta,
  openCodeToolEvent,
  openCodeTodos,
  openCodeDiffParts,
  openCodePermissionScope,
  openCodePermissionTitle,
  openCodeErrorMessage,
  randomLocalPort,
  waitForHttp,
  readEventStream,
} from "./open-code.js";
import {
  normalizePiArgs,
  piCapabilities,
  piModels,
  piModelSelection,
  piThinkingLevel,
  piPromptImages,
  piSessionState,
  piRunControlEventName,
  piMessageText,
  piToolEvent,
  piToolResult,
  piToolCallStreamEvent,
  piStatusText,
  piUiQuestion,
  firstQuestionAnswer,
} from "./pi.js";
import {
  codexCapabilities,
  normalizeCodexArgs,
  codexApprovalSettings,
  codexUserInput,
  codexTool,
  codexReasoningText,
  isCodexReasoningKind,
  normalizeCodexTranscriptItem,
  codexTranscriptItemType,
  codexTranscriptMessageRole,
  codexTranscriptAttachments,
  joinedText,
  contentValueText,
  responseItemId,
  eventItem,
  responseStreamEvent,
  responseEventType,
  completedResponsePayload,
  isCompletedResponseLike,
  codexToolSemantic,
  codexRuntimeConfig,
  codexAgentGuidance,
  codexMcpServers,
  mergedCodexMcpServers,
  buildCodexConfig,
  normalizeCodexMcpServers,
  normalizeCodexMcpServerConfig,
  codexMcpServerToolConfig,
  isAguiMcpGatewayServer,
  codexMcpToolAliases,
  codexSkills,
  claudeSkills,
  codexHooks,
  codexPermissionPolicy,
  codexSlashCommands,
  codexDiffParts,
  codexMessageRecord,
  codexTranscriptSnapshotForSession,
  codexTranscriptFiles,
  codexTranscriptSnapshot,
  codexToolMessage,
  patchTranscriptTool,
  codexToolAliases,
  codexTranscriptMetadata,
  codexSessionIndexTitle,
  codexSessionTitleIndex,
  removeCodexSessionIndexEntry,
  transcriptTitleFromRecord,
  isTranscriptTitleEvent,
  transcriptVisibleUserText,
  isInjectedTranscriptUserText,
  summarizeTitle,
  codexTranscriptFileId,
  safeReadDir,
  safeStat,
  isReadableTranscriptPath,
  isCodexApproval,
  codexApprovalScope,
  codexApprovalTitle,
  codexApprovalResponse,
  codexAlwaysApprovalDecision,
  firstArrayItem,
} from "./codex.js";
import {
  claudeApprovalResponse,
  claudeCapabilities,
  claudeQuestionResponse,
  claudeUserContent,
  imageContentBlock,
  claudeAgents,
  claudeAgentFromFile,
  claudeHooks,
  claudePermissionPolicy,
  claudePermissionMode,
  claudeSettingsFromPolicy,
  writeClaudeSettings,
  claudeSlashCommands,
  claudeOutputStyles,
  claudeMemoryFiles,
  claudeMcpServers,
  claudeSettingsSnapshot,
  claudeAgentTool,
  claudeToolSemantic,
  claudeMessageRecord,
  claudeTranscriptSnapshotForSession,
  claudeTranscriptFiles,
  claudeTranscriptSnapshot,
  claudeUserTextParts,
  claudeTranscriptTool,
  patchClaudeTranscriptTool,
  claudeTranscriptMetadata,
} from "./claude.js";
import {
  claudeCliModels,
  claudeErrorMessage,
  isClaudeAuthenticationError,
  claudeRuntimeArguments,
  claudeTextDiagnosticError,
  sanitizeClaudeDiagnostic,
} from "./claude-model-discovery.js";
import {
  claudeSettingsFiles,
  markdownFiles,
  markdownFilesRecursive,
  walkDirectory,
  readTextFile,
  ancestorFiles,
  skillDirectories,
  parseTomlSummary,
  parseTomlHookSummary,
  parseTomlScalar,
  mergeRecords,
} from "./filesystem.js";
import {
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
  ensureProviderCli,
  runtimeEnvironment,
} from "./shared.js";

export class ClaudeRuntimeConnection extends RuntimeConnection {
  private readonly controlRequests = new Map<
    string,
    {
      toolName: string;
      input: unknown;
      question: boolean;
    }
  >();
  private readonly emittedErrorMessages = new Set<string>();
  private readonly toolIds = new Map<number, string>();
  private readonly toolMetadata = new Map<string, Record<string, unknown>>();
  private readonly toolJson = new Map<string, string>();
  private readonly agentTools = new Map<string, { agentId: string; prompt?: string }>();
  private readonly textParts = new Map<string, string>();
  private readonly textPartIds = new Map<string, string>();
  private readonly messageParts: AspMessagePart[] = [];
  private readonly tools: AspToolEvent[] = [];
  private claudeContextSnapshot: ClaudeContextSnapshot | undefined;
  private claudeContextRefresh: Promise<void> | undefined;
  private lastRun: Record<string, unknown> = {};
  private lastUsage: ReturnType<typeof normalizeUsage>;
  private messageSequence = 0;
  private currentMessageKey = "";
  private selectedAgent = "";
  private runId = "";
  private sessionId = "";
  private sessionTitle = "";
  private runFinished = false;
  private startedAt = 0;
  private lines?: readline.Interface;
  private mcpConfigDirectory = "";
  private mcpConfigPath = "";

  send(message: Record<string, unknown>): void {
    const method = text(message.method);
    const id = rpcId(message.id);
    if (method === "capabilities" && id !== undefined) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: claudeCapabilities(this.input.provider.capabilities, this.input.cwd),
        version: ASP_VERSION,
      });
      return;
    }
    if (method === "list_models" && id !== undefined) {
      void this.listClaudeModels(id);
      return;
    }
    if (method === "list_sessions" && id !== undefined) {
      void this.listClaudeSessions(id);
      return;
    }
    if (method === "session_messages" && id !== undefined) {
      void this.claudeSessionMessages(id, text(message.providerSessionId));
      return;
    }
    if (method === "resume_session" && id !== undefined) {
      void this.resumeClaudeSession(id, text(message.providerSessionId));
      return;
    }
    if (method === "delete_session" && id !== undefined) {
      void this.deleteClaudeSession(
        id,
        text(message.transcriptPath) ||
          text(message.transcript_path) ||
          text(message.providerSessionId),
      );
      return;
    }
    if (method === "extension.invoke" && id !== undefined) {
      void this.invokeExtension(id, record(message.params)).catch((error) =>
        this.emitExtensionError(id, asError(error)),
      );
      return;
    }
    if (
      this.handleCommonQuery(
        message,
        claudeCapabilities(this.input.provider.capabilities, this.input.cwd),
      )
    )
      return;
    if (message.type === "run") {
      this.startRun(message);
      return;
    }
    if (message.type === "abort" || method === "run.cancel") {
      this.close();
      return;
    }
    if (id !== undefined && Object.prototype.hasOwnProperty.call(message, "result")) {
      this.respondControl(String(id), message.result);
    }
  }

  override close(): void {
    this.lines?.close();
    if (this.mcpConfigDirectory) {
      fs.rmSync(this.mcpConfigDirectory, { recursive: true, force: true });
      this.mcpConfigDirectory = "";
    }
    super.close();
  }

  private async listClaudeModels(id: string | number): Promise<void> {
    try {
      const models = await claudeCliModels(this.input);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { models },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
        version: ASP_VERSION,
      });
    }
  }

  private startRun(run: Record<string, unknown>): void {
    this.runId = text(run.runId);
    this.sessionId = this.resolveClaudeResumeSessionId(text(run.providerSessionId));
    this.runFinished = false;
    this.startedAt = Date.now();
    this.lastRun = run;
    this.lastUsage = undefined;
    this.claudeContextSnapshot = undefined;
    this.claudeContextRefresh = undefined;
    this.sessionTitle = "";
    this.mcpConfigPath = "";
    this.emittedErrorMessages.clear();
    this.messageParts.length = 0;
    this.tools.length = 0;
    this.textParts.clear();
    this.toolIds.clear();
    this.toolMetadata.clear();
    this.toolJson.clear();
    this.agentTools.clear();
    this.textPartIds.clear();
    this.messageSequence = 0;
    this.currentMessageKey = "";
    const permissionMode = claudePermissionMode(text(run.approvalMode));
    const args = claudeRuntimeArguments(this.input.provider, [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--include-partial-messages",
    ]);
    if (this.sessionId) args.push("--resume", this.sessionId);
    const runModel = text(run.model);
    if (runModel && runModel !== "default") args.push("--model", runModel);
    if (["low", "medium", "high", "xhigh", "max"].includes(text(run.effort))) {
      args.push("--effort", text(run.effort));
    }
    args.push("--permission-mode", permissionMode, "--permission-prompt-tool", "stdio");
    const developerInstructions = developerInstructionsWithSkills(run);
    if (developerInstructions) args.push("--append-system-prompt", developerInstructions);
    const extensionMcpServers = normalizeMcpServerMap(run.mcpServers);
    if (Object.keys(extensionMcpServers).length) {
      this.mcpConfigDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agui-claude-mcp-"));
      const configPath = path.join(this.mcpConfigDirectory, "mcp.json");
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: extensionMcpServers }), "utf8");
      this.mcpConfigPath = configPath;
      args.push("--mcp-config", configPath);
    }
    const child = this.startChild(args, {
      CLAUDE_AGENT_SDK_VERSION: "0.3.169",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      NODE_OPTIONS: undefined,
    });
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleClaudeMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.handleClaudeTextOutput(line, "stdout");
      }
    });
    child.stderr.on("data", (chunk: string) => this.handleClaudeTextOutput(chunk, "stderr"));
    child.stdin.write(
      `${JSON.stringify({
        message: {
          content: claudeUserContent(run, this.selectedAgent),
          role: "user",
        },
        parent_tool_use_id: null,
        session_id: "",
        type: "user",
      })}\n`,
    );
  }

  private async listClaudeSessions(id: string | number): Promise<void> {
    try {
      const sessions = claudeTranscriptFiles()
        .map((filePath) => claudeTranscriptSnapshot(filePath, this.input.provider.id).session)
        .filter((session): session is AspProviderSession => Boolean(session));
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { sessions },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
        version: ASP_VERSION,
      });
    }
  }

  private async claudeSessionMessages(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = claudeTranscriptSnapshotForSession(sessionId, this.input.provider.id);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { messages: snapshot?.messages ?? [] },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
        version: ASP_VERSION,
      });
    }
  }

  private async resumeClaudeSession(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = claudeTranscriptSnapshotForSession(sessionId, this.input.provider.id);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: snapshot
          ? { session: snapshot.session, messages: snapshot.messages }
          : { messages: [] },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
        version: ASP_VERSION,
      });
    }
  }

  private async deleteClaudeSession(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = claudeTranscriptSnapshotForSession(sessionId, this.input.provider.id);
      if (!snapshot) {
        this.emitMessage({
          asp: ASP_NAME,
          id,
          result: { deleted: false },
          version: ASP_VERSION,
        });
        return;
      }
      fs.unlinkSync(snapshot.filePath);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { deleted: true },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
        version: ASP_VERSION,
      });
    }
  }

  private async invokeExtension(
    id: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const extension = text(params.extension);
    const method = text(params.method);
    const payload = record(params.payload);
    if (!extension || !method)
      throw new Error("Claude extension invocation requires extension and method.");
    let result: unknown;
    if (extension === "asp.ext.agents") {
      result = this.invokeClaudeAgents(method, payload);
    } else if (extension === "asp.ext.hooks") {
      result = this.invokeClaudeHooks(method, payload);
    } else if (extension === "asp.ext.permissions") {
      result = this.invokeClaudePermissions(method, payload);
    } else if (extension === "asp.ext.run-control") {
      result = this.invokeClaudeRunControl(method, payload);
    } else if (extension === "asp.ext.session-state") {
      result = this.invokeClaudeSessionState(method);
    } else if (extension === "asp.ext.runtime") {
      result = this.invokeClaudeRuntime(method);
    } else if (extension === "vendor.claude.cli") {
      result = this.invokeClaudeVendor(method, payload);
    } else {
      throw new Error(`Claude adapter does not support extension ${extension}.`);
    }
    this.emitMessage({
      asp: ASP_NAME,
      id,
      result: { extension, method, result: await result },
      version: ASP_VERSION,
    });
  }

  private invokeClaudeAgents(method: string, payload: Record<string, unknown>): unknown {
    if (method === "list_agents") return { agents: claudeAgents(this.input.cwd) };
    if (method === "select_agent") {
      const agentId =
        text(payload.agentId) || text(payload.agent_id) || text(payload.id) || text(payload.agent);
      if (!agentId) throw new Error("select_agent requires agentId.");
      this.selectedAgent = agentId;
      this.emitExtensionEvent("asp.ext.agents", "agent.selected", { agentId }, "none");
      return { agentId };
    }
    if (method === "invoke_agent") {
      const agentId =
        text(payload.agentId) ||
        text(payload.agent_id) ||
        text(payload.agent) ||
        this.selectedAgent;
      const message = text(payload.message) || text(payload.prompt);
      if (!agentId) throw new Error("invoke_agent requires agentId.");
      if (!message) throw new Error("invoke_agent requires message.");
      const agentInstanceId = `claude-agent-${agentId}-${Date.now()}`;
      this.writeClaudeUserMessage(`Use the ${agentId} subagent to handle this task:\n\n${message}`);
      this.emitExtensionEvent(
        "asp.ext.agents",
        "agent.started",
        { agentId, agentInstanceId, prompt: message },
        {
          type: "message_part",
          part: {
            id: agentInstanceId,
            content: `Subagent ${agentId} started.`,
            status: "started",
            title: agentId,
            type: "status",
          },
        },
      );
      return { agentId, agentInstanceId, queued: true };
    }
    if (method === "cancel_agent") {
      const agentId =
        text(payload.agentId) ||
        text(payload.agent_id) ||
        text(payload.agent) ||
        this.selectedAgent;
      const agentInstanceId =
        text(payload.agentInstanceId) || text(payload.agent_instance_id) || undefined;
      this.emitExtensionEvent(
        "asp.ext.agents",
        "agent.failed",
        { agentId, agentInstanceId, status: "cancelled" },
        "none",
      );
      return { agentId: agentId || undefined, cancelled: true };
    }
    throw new Error(`Claude agents method is not supported: ${method}`);
  }

  private invokeClaudeHooks(method: string, payload: Record<string, unknown> = {}): unknown {
    if (method === "list_hooks") return { hooks: claudeHooks(this.input.cwd) };
    if (method === "set_hooks") {
      const result = writeClaudeSettings(this.input.cwd, {
        hooks: record(payload.hooks ?? payload.value ?? payload),
      });
      this.emitExtensionEvent("asp.ext.hooks", "hook.completed", result, "none");
      return result;
    }
    throw new Error(`Claude hooks method is not supported: ${method}`);
  }

  private invokeClaudePermissions(method: string, payload: Record<string, unknown> = {}): unknown {
    if (method === "get_policy")
      return claudePermissionPolicy(this.input.cwd, text(this.lastRun.approvalMode));
    if (method === "set_policy") {
      const settings = claudeSettingsFromPolicy(payload.policy ?? payload);
      const result = writeClaudeSettings(this.input.cwd, settings);
      this.emitExtensionEvent("asp.ext.permissions", "policy.updated", result, "none");
      return result;
    }
    throw new Error(`Claude permissions method is not supported: ${method}`);
  }

  private invokeClaudeRunControl(method: string, payload: Record<string, unknown>): unknown {
    if (method === "steer") {
      const message = text(payload.message) || text(payload.prompt);
      if (!message) throw new Error("steer requires message.");
      this.writeClaudeUserMessage(message);
      this.emitExtensionEvent(
        "asp.ext.run-control",
        "queue.updated",
        { ...this.claudeSessionState(), message, method: "steer" },
        "none",
      );
      return { queued: true, sessionId: this.sessionId || undefined };
    }
    if (method === "follow_up") {
      const message = text(payload.message) || text(payload.prompt);
      if (!message) throw new Error("follow_up requires message.");
      this.writeClaudeUserMessage(message);
      return { queued: true };
    }
    if (method === "set_session_title") {
      const title = text(payload.title) || text(payload.name);
      if (!title) throw new Error("set_session_title requires title.");
      this.sessionTitle = title;
      this.emitExtensionEvent(
        "asp.ext.session-state",
        "state.updated",
        this.claudeSessionState(),
        "none",
      );
      return { sessionId: this.sessionId || undefined, title };
    }
    if (method === "abort_current_step") {
      this.emitExtensionEvent(
        "asp.ext.run-control",
        "step.aborted",
        this.claudeSessionState(),
        "none",
      );
      this.close();
      return { aborted: true, sessionId: this.sessionId || undefined };
    }
    throw new Error(`Claude run-control method is not supported: ${method}`);
  }

  private async invokeClaudeSessionState(method: string): Promise<unknown> {
    if (method === "get_state") {
      await this.refreshClaudeContextUsage({ emit: false });
      return this.claudeSessionState();
    }
    if (method === "get_messages") {
      return {
        messages: [
          claudeMessageRecord(this.sessionId, this.messageParts, this.tools, this.textParts),
        ],
      };
    }
    throw new Error(`Claude session-state method is not supported: ${method}`);
  }

  private invokeClaudeRuntime(method: string): unknown {
    if (method !== "get_runtime")
      throw new Error(`Claude runtime method is not supported: ${method}`);
    return {
      adapter: "claude-code-stream-json",
      cwd: this.input.cwd,
      provider: {
        id: this.input.provider.id,
        name: this.input.provider.name,
        args: this.input.provider.args,
      },
      sessionId: this.sessionId || undefined,
      selectedAgent: this.selectedAgent || undefined,
      agents: claudeAgents(this.input.cwd),
      hooks: claudeHooks(this.input.cwd),
      commands: claudeSlashCommands(this.input.cwd),
      memory: claudeMemoryFiles(this.input.cwd),
      mcpServers: {
        ...claudeMcpServers(this.input.cwd),
        ...normalizeMcpServerMap(this.lastRun.mcpServers),
      },
      skills: mergeRuntimeSkills(this.lastRun.skills, claudeSkills(this.input.cwd)),
      outputStyles: claudeOutputStyles(this.input.cwd),
      settings: claudeSettingsSnapshot(this.input.cwd),
      features: [
        "stream-json",
        "thinking",
        "tool_use",
        "control_request",
        "permission-prompt-tool",
        "subagent-files",
        "hooks-settings",
        "slash-commands",
        "output-styles",
        "CLAUDE.md",
        "mcpServers",
      ],
    };
  }

  private invokeClaudeVendor(method: string, payload: Record<string, unknown>): unknown {
    if (method !== "raw_input") throw new Error(`Claude vendor method is not supported: ${method}`);
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error("Claude process is not running.");
    }
    const message = payload.message ?? payload.value;
    if (message === undefined) throw new Error("vendor.claude.cli raw_input requires message.");
    this.child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    return { sent: true };
  }

  private handleClaudeMessage(message: Record<string, unknown>): void {
    this.emitNativeEvent(
      "vendor.claude.cli",
      this.lastRun.preserveNativeEvents === true,
      message,
      this.runId,
      this.sessionId || undefined,
    );
    this.updateClaudeSessionState(message);
    const usage = normalizeUsage(message) ?? normalizeUsage(record(message.message));
    if (usage) {
      this.lastUsage = usage;
      this.emitMessage({
        type: "usage",
        runId: this.runId,
        usage,
        model: nestedText(message, "message", "model") || text(message.model) || undefined,
        providerSessionId: this.sessionId || undefined,
      });
    }
    const type = text(message.type);
    if (type === "stream_event") {
      this.handleClaudeStreamEvent(record(message.event), text(message.parent_tool_use_id));
      return;
    }
    if (type === "assistant") {
      const assistantMessage = record(message.message);
      const messageKey = this.claudeMessageKey(assistantMessage) || this.claudeMessageKey(message);
      if (messageKey && messageKey !== this.currentMessageKey)
        this.beginClaudeMessage(assistantMessage);
      else if (!this.currentMessageKey) this.beginClaudeMessage(assistantMessage);
      this.handleClaudeContent(assistantMessage.content, text(message.parent_tool_use_id));
      return;
    }
    if (type === "user") {
      this.handleClaudeToolResults(
        record(message.message).content,
        text(message.parent_tool_use_id),
      );
      return;
    }
    if (type === "control_request") {
      this.handleClaudeControl(message);
      return;
    }
    if (type === "system" && text(message.subtype) === "local_command_output") {
      const content = rawText(message.content);
      if (content) this.emitStdout(content);
      return;
    }
    if (type === "system") {
      this.handleClaudeSystemMessage(message);
      return;
    }
    if (type === "result" && !this.runFinished) {
      this.runFinished = true;
      const resultText = rawText(message.result);
      const errorText = claudeErrorMessage(message);
      if (message.is_error === true) {
        this.emitAspError(errorText || "Claude Code failed before returning a response.");
      } else if (resultText && ![...this.textParts.values()].some(Boolean)) {
        this.emitPart({ id: "claude-result", type: "text", content: resultText });
      }
      if (Array.isArray(message.errors) && message.errors.length) {
        this.emitAspError(message.errors.map(String).join("; "));
      }
      this.emitMessage({
        type: "run_finished",
        runId: this.runId,
        providerSessionId: this.sessionId || undefined,
        durationMs: number(message.duration_ms),
        exitCode: message.is_error === true ? 1 : 0,
        success: message.is_error !== true,
        usage,
      });
      this.emitExtensionEvent(
        "asp.ext.session-state",
        "state.updated",
        this.claudeSessionState(),
        "none",
      );
      void this.refreshClaudeContextUsage();
    }
  }

  private handleClaudeSystemMessage(message: Record<string, unknown>): void {
    const subtype = text(message.subtype);
    if (subtype === "init") {
      return;
    }
    if (subtype === "status" && text(message.status) === "requesting") {
      return;
    }
    const errorText = claudeErrorMessage(message);
    if (errorText) {
      this.emitAspError(errorText, { fatal: isClaudeAuthenticationError(errorText) });
    }
  }

  private handleClaudeTextOutput(chunk: string, stream: "stdout" | "stderr"): void {
    const errorText = claudeTextDiagnosticError(chunk);
    if (errorText) this.emitAspError(errorText, { fatal: isClaudeAuthenticationError(errorText) });
    if (stream === "stdout") this.emitStdout(`${chunk.endsWith("\n") ? chunk : `${chunk}\n`}`);
  }

  private beginClaudeMessage(message: Record<string, unknown> = {}): string {
    const key = this.claudeMessageKey(message) || `claude-message-${++this.messageSequence}`;
    this.currentMessageKey = key;
    this.toolIds.clear();
    return key;
  }

  private ensureClaudeMessageKey(): string {
    return this.currentMessageKey || this.beginClaudeMessage();
  }

  private claudeMessageKey(message: Record<string, unknown>): string {
    const messageRecord = record(message.message);
    const id =
      text(message.id) ||
      text(message.message_id) ||
      text(message.messageId) ||
      text(messageRecord.id) ||
      text(messageRecord.message_id) ||
      text(messageRecord.messageId);
    return id ? `claude-message-${id}` : "";
  }

  private claudePartId(
    messageKey: string,
    kind: "reasoning" | "text" | "tool",
    index: number,
    explicitId?: unknown,
  ): string {
    if (kind === "tool") {
      return text(explicitId) || `${messageKey}-${kind}-${index >= 0 ? index : "unknown"}`;
    }
    const slot = `${messageKey}:${kind}:${index >= 0 ? index : "unknown"}`;
    const existing = this.textPartIds.get(slot);
    if (existing) return existing;
    const fallback = `${messageKey}-${kind}-${index >= 0 ? index : "unknown"}`;
    const explicit = text(explicitId);
    const id = explicit && !this.textParts.has(fallback) ? explicit : fallback;
    this.textPartIds.set(slot, id);
    return id;
  }

  private claudeContentPartId(
    messageKey: string,
    kind: "reasoning" | "text",
    index: number,
    content: string,
    explicitId?: unknown,
  ): string {
    const slot = `${messageKey}:${kind}:${index >= 0 ? index : "unknown"}`;
    const existing = this.textPartIds.get(slot);
    if (existing) return existing;
    const fallback = `${messageKey}-${kind}-${index >= 0 ? index : "unknown"}`;
    if (this.textParts.has(fallback)) {
      this.textPartIds.set(slot, fallback);
      return fallback;
    }
    const matched = this.matchClaudeTextPart(messageKey, kind, content);
    if (matched) {
      this.textPartIds.set(slot, matched);
      return matched;
    }
    const id = text(explicitId) || fallback;
    this.textPartIds.set(slot, id);
    return id;
  }

  private matchClaudeTextPart(
    messageKey: string,
    kind: "reasoning" | "text",
    content: string,
  ): string | undefined {
    const prefix = `${messageKey}:${kind}:`;
    const exact: string[] = [];
    const prefixMatches: string[] = [];
    for (const [slot, id] of this.textPartIds) {
      if (!slot.startsWith(prefix)) continue;
      const previous = this.textParts.get(id);
      if (!previous) continue;
      if (content === previous) exact.push(id);
      else if (content.startsWith(previous)) prefixMatches.push(id);
    }
    if (exact.length === 1) return exact[0];
    if (prefixMatches.length === 1) return prefixMatches[0];
    return undefined;
  }

  private handleClaudeStreamEvent(event: Record<string, unknown>, parentId: string): void {
    this.updateClaudeSessionState(event);
    const type = text(event.type);
    if (type === "message_start") {
      this.beginClaudeMessage(event);
      return;
    }
    const index = number(event.index, -1);
    if (type === "content_block_start") {
      const messageKey = this.ensureClaudeMessageKey();
      const block = record(event.content_block);
      const blockType = text(block.type);
      const metadata = this.claudeBlockMetadata(messageKey, index);
      if (blockType === "text") {
        const id = this.claudePartId(messageKey, "text", index, block.id);
        if (rawText(block.text)) this.appendClaudePart(id, "text", rawText(block.text)!, metadata);
      } else if (blockType === "thinking" || blockType === "reasoning") {
        const id = this.claudePartId(messageKey, "reasoning", index, block.id);
        const content = rawText(block.thinking) ?? rawText(block.text);
        if (content) this.appendClaudePart(id, "reasoning", content, metadata);
      } else if (blockType === "tool_use") {
        const id = text(block.id) || this.claudePartId(messageKey, "tool", index);
        this.toolIds.set(index, id);
        this.toolMetadata.set(id, metadata);
        if (block.input !== undefined) this.toolJson.set(id, JSON.stringify(block.input));
        const agent = claudeAgentTool(text(block.name), record(block.input));
        if (agent) {
          this.agentTools.set(id, agent);
          this.emitExtensionEvent(
            "asp.ext.agents",
            "agent.started",
            {
              agentId: agent.agentId,
              prompt: agent.prompt,
              toolUseId: id,
            },
            {
              type: "message_part",
              part: {
                id: `claude-agent-${id}`,
                content: `Subagent ${agent.agentId} started.`,
                status: "started",
                title: agent.agentId,
                type: "status",
              },
            },
          );
        }
        this.emitTool({
          id,
          input: block.input,
          kind: "tool_use",
          name: text(block.name) || "Tool call",
          parentId: text(block.parent_tool_use_id) || parentId || undefined,
          phase: "started",
          metadata,
          semantic: claudeToolSemantic(text(block.name), block.input),
          status: "inProgress",
        });
      }
      return;
    }
    if (type !== "content_block_delta") return;
    const messageKey = this.ensureClaudeMessageKey();
    const delta = record(event.delta);
    const metadata = this.claudeBlockMetadata(messageKey, index);
    if (text(delta.type) === "text_delta" && rawText(delta.text)) {
      this.appendClaudePart(
        this.claudePartId(messageKey, "text", index),
        "text",
        rawText(delta.text)!,
        metadata,
      );
    } else if (text(delta.type) === "thinking_delta" && rawText(delta.thinking)) {
      this.appendClaudePart(
        this.claudePartId(messageKey, "reasoning", index),
        "reasoning",
        rawText(delta.thinking)!,
        metadata,
      );
    } else if (text(delta.type) === "input_json_delta") {
      const id = this.toolIds.get(index);
      const chunk = rawText(delta.partial_json);
      if (!id || !chunk) return;
      const json = `${this.toolJson.get(id) ?? ""}${chunk}`;
      this.toolJson.set(id, json);
      this.emitTool({
        id,
        input: parseJson(json) ?? json,
        kind: "tool_use",
        name: "Tool call",
        parentId: parentId || undefined,
        phase: "updated",
        metadata: this.toolMetadata.get(id) ?? metadata,
        semantic: claudeToolSemantic("", parseJson(json) ?? json),
        status: "inProgress",
      });
    }
  }

  private handleClaudeContent(content: unknown, parentId: string): void {
    if (!Array.isArray(content)) return;
    const messageKey = this.ensureClaudeMessageKey();
    content.forEach((item, index) => {
      const block = record(item);
      const type = text(block.type);
      const metadata = this.claudeBlockMetadata(messageKey, index);
      if (type === "text" && rawText(block.text)) {
        const content = rawText(block.text)!;
        const id = this.claudeContentPartId(messageKey, "text", index, content, block.id);
        this.setClaudePartContent(id, "text", content, metadata);
      } else if (
        (type === "thinking" || type === "reasoning") &&
        (rawText(block.thinking) || rawText(block.text))
      ) {
        const content = rawText(block.thinking) ?? rawText(block.text) ?? "";
        const id = this.claudeContentPartId(messageKey, "reasoning", index, content, block.id);
        this.setClaudePartContent(id, "reasoning", content, metadata);
      } else if (type === "tool_use") {
        const id = text(block.id) || this.claudePartId(messageKey, "tool", index);
        this.toolMetadata.set(id, metadata);
        const agent = claudeAgentTool(text(block.name), record(block.input));
        if (agent) {
          this.agentTools.set(id, agent);
          this.emitExtensionEvent(
            "asp.ext.agents",
            "agent.started",
            {
              agentId: agent.agentId,
              prompt: agent.prompt,
              toolUseId: id,
            },
            {
              type: "message_part",
              part: {
                id: `claude-agent-${id}`,
                content: `Subagent ${agent.agentId} started.`,
                status: "started",
                title: agent.agentId,
                type: "status",
              },
            },
          );
        }
        this.emitTool({
          id,
          input: block.input,
          kind: "tool_use",
          name: text(block.name) || "Tool call",
          parentId: text(block.parent_tool_use_id) || parentId || undefined,
          phase: "started",
          metadata,
          semantic: claudeToolSemantic(text(block.name), block.input),
          status: "inProgress",
        });
      }
    });
  }

  private handleClaudeToolResults(content: unknown, parentId: string): void {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      const block = record(item);
      if (text(block.type) !== "tool_result") continue;
      const id = text(block.tool_use_id) || text(block.id) || `claude-tool-${Date.now()}`;
      const agent = this.agentTools.get(id);
      if (agent) {
        this.agentTools.delete(id);
        this.emitExtensionEvent(
          "asp.ext.agents",
          block.is_error === true ? "agent.failed" : "agent.completed",
          {
            agentId: agent.agentId,
            output: contentText(block.content),
            status: block.is_error === true ? "failed" : "completed",
            toolUseId: id,
          },
          "none",
        );
      }
      this.emitTool({
        id,
        kind: "tool_use",
        name: "Tool call",
        output: contentText(block.content),
        error: block.is_error === true ? contentText(block.content) : undefined,
        parentId: parentId || undefined,
        phase: "completed",
        semantic: agent
          ? { resultKind: block.is_error === true ? "text" : "json", toolType: "agent.invoke" }
          : claudeToolSemantic("", undefined),
        status: block.is_error === true ? "failed" : "completed",
      });
    }
  }

  private handleClaudeControl(message: Record<string, unknown>): void {
    const requestId = text(message.request_id);
    const request = record(message.request);
    if (!requestId) return;
    const subtype = text(request.subtype);
    const toolName = text(request.tool_name);
    const input = request.input;
    const question =
      isQuestionMethod(toolName) ||
      [
        "question_request",
        "request_question",
        "request_user_input",
        "human_input",
        "ask_user",
      ].includes(subtype);
    this.controlRequests.set(requestId, { toolName, input, question });
    const approvalScope = question ? "" : claudeApprovalScope(toolName);
    const approvalMethod = toolName || subtype || "can_use_tool";
    if (!question) {
      const automatic = runtimeAutomaticApproval(
        text(this.lastRun.approvalMode),
        approvalScope,
        approvalMethod,
      );
      if (automatic) {
        this.respondControl(requestId, { decision: automatic });
        return;
      }
    }
    this.emitMessage({
      id: requestId,
      method: question ? "question_request" : "approval_request",
      params: question
        ? {
            method: toolName || subtype,
            params: input,
            questions: record(input).questions,
            question: text(record(input).question),
            title: text(record(input).title) || toolName || "Agent question",
          }
        : {
            method: "can_use_tool",
            params: { input, toolName },
            scope: approvalScope,
            title: toolName ? `Use ${toolName}` : "Use tool",
            options: ["allow", "allow-session", "allow-always", "deny", "cancel"],
          },
    });
  }

  private respondControl(requestId: string, result: unknown): void {
    const request = this.controlRequests.get(requestId);
    if (!request || !this.child) return;
    this.controlRequests.delete(requestId);
    const source = record(result);
    const response = request.question
      ? claudeQuestionResponse(source, request.input)
      : claudeApprovalResponse(normalizeDecision(source.decision), request.input);
    this.child.stdin.write(
      `${JSON.stringify({
        response: {
          request_id: requestId,
          response,
          subtype: "success",
        },
        type: "control_response",
      })}\n`,
    );
  }

  private appendClaudePart(
    id: string,
    type: "text" | "reasoning",
    delta: string,
    metadata?: Record<string, unknown>,
  ): void {
    const content = `${this.textParts.get(id) ?? ""}${delta}`;
    this.textParts.set(id, content);
    this.emitPart({ id, type, content, ...(metadata ? { metadata } : {}) } as AspMessagePart);
  }

  private setClaudePartContent(
    id: string,
    type: "text" | "reasoning",
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    const previous = this.textParts.get(id) ?? "";
    if (!content || content === previous) return;
    if (previous && !content.startsWith(previous)) return;
    this.appendClaudePart(id, type, content.slice(previous.length), metadata);
  }

  private claudeBlockMetadata(messageKey: string, index: number): Record<string, unknown> {
    return {
      source: "claude-code",
      messageKey,
      ...(index >= 0 ? { contentBlockIndex: index } : {}),
    };
  }

  private emitPart(part: AspMessagePart): void {
    upsertRuntimePart(this.messageParts, part);
    this.emitMessage({
      type: "message_part",
      runId: this.runId,
      part,
      providerSessionId: this.sessionId || undefined,
    });
  }
  private emitTool(toolEvent: AspToolEvent): void {
    upsertRuntimeTool(this.tools, toolEvent);
    this.emitMessage({
      type: "tool_event",
      runId: this.runId,
      toolEvent,
      providerSessionId: this.sessionId || undefined,
    });
  }
  private emitAspError(message: string, options: { fatal?: boolean } = {}): void {
    const sanitized = sanitizeClaudeDiagnostic(message);
    if (!sanitized) return;
    const dedupeKey = `${options.fatal === true ? "fatal" : "error"}:${sanitized}`;
    if (this.emittedErrorMessages.has(dedupeKey)) return;
    this.emittedErrorMessages.add(dedupeKey);
    this.emitMessage({
      type: "error",
      runId: this.runId,
      message: sanitized,
      providerSessionId: this.sessionId || undefined,
      ...(options.fatal === true ? { fatal: true } : {}),
    });
  }
  private emitExtensionError(id: string | number, error: Error): void {
    this.emitMessage({
      asp: ASP_NAME,
      id,
      error: { code: ASP_ERROR_CODES.internalError, message: error.message },
      version: ASP_VERSION,
    });
  }
  private emitExtensionEvent(
    extension: string,
    event: string,
    payload: unknown,
    fallback?: AspExtensionFallback | "none",
  ): void {
    this.emitMessage({
      type: "extension_event",
      runId: this.runId,
      providerSessionId: this.sessionId || undefined,
      extension,
      event,
      payload,
      fallback,
    });
  }
  private updateClaudeSessionState(value: unknown): void {
    const previousSessionId = this.sessionId;
    const previousTitle = this.sessionTitle;
    this.sessionId = claudeRuntimeSessionId(value) || this.sessionId;
    this.sessionTitle = runtimeSessionTitle(value) || this.sessionTitle;
    if (this.sessionId !== previousSessionId || this.sessionTitle !== previousTitle) {
      this.emitExtensionEvent(
        "asp.ext.session-state",
        "state.updated",
        this.claudeSessionState(),
        "none",
      );
    }
  }
  private writeClaudeUserMessage(message: string): void {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error("Claude process is not running.");
    }
    this.child.stdin.write(
      `${JSON.stringify({
        message: {
          content: [{ text: message, type: "text" }],
          role: "user",
        },
        parent_tool_use_id: null,
        session_id: this.sessionId || "",
        type: "user",
      })}\n`,
    );
  }
  private claudeSessionState(): AspSessionState {
    const context = this.claudeContextState();
    return {
      providerSessionId: this.sessionId || undefined,
      title: this.sessionTitle || undefined,
      cwd: this.input.cwd,
      model: text(this.lastRun.model) || undefined,
      effort: text(this.lastRun.effort) || undefined,
      streaming: this.runFinished ? false : undefined,
      context,
      metadata: {
        adapter: "claude-code-stream-json",
        ...(context
          ? { contextUsageMethod: "slash-context", contextUsageSource: "claude-code-cli" }
          : {}),
        ...(this.selectedAgent ? { selectedAgent: this.selectedAgent } : {}),
        ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      },
    };
  }
  private claudeContextState(): AspSessionState["context"] | undefined {
    const usedTokens = this.claudeContextSnapshot?.usedTokens;
    const windowTokens = this.claudeContextSnapshot?.windowTokens;
    if (usedTokens === undefined && windowTokens === undefined) return undefined;
    return { usedTokens, windowTokens };
  }
  private resolveClaudeResumeSessionId(providerSessionId: string): string {
    if (!providerSessionId) return "";
    return (
      claudeTranscriptSnapshotForSession(providerSessionId, this.input.provider.id)?.session.id ??
      ""
    );
  }
  private async refreshClaudeContextUsage(options: { emit?: boolean } = {}): Promise<void> {
    const emit = options.emit !== false;
    const sessionId = this.sessionId;
    if (!sessionId || !this.runFinished) return;
    if (this.claudeContextRefresh) return this.claudeContextRefresh;
    const refresh = this.queryClaudeContextUsage(sessionId)
      .then((snapshot) => {
        if (!snapshot || this.sessionId !== sessionId) return;
        const changed =
          snapshot.usedTokens !== this.claudeContextSnapshot?.usedTokens ||
          snapshot.windowTokens !== this.claudeContextSnapshot?.windowTokens;
        if (!changed) return;
        this.claudeContextSnapshot = snapshot;
        if (emit && !this.closed) {
          this.emitExtensionEvent(
            "asp.ext.session-state",
            "state.updated",
            this.claudeSessionState(),
            "none",
          );
        }
      })
      .catch(() => {
        // Context usage is optional. If Claude cannot answer /context, keep it unavailable.
      })
      .finally(() => {
        if (this.claudeContextRefresh === refresh) this.claudeContextRefresh = undefined;
      });
    this.claudeContextRefresh = refresh;
    return refresh;
  }
  private async queryClaudeContextUsage(
    sessionId: string,
  ): Promise<ClaudeContextSnapshot | undefined> {
    const runtimeArgs = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--resume",
      sessionId,
    ];
    const runModel = text(this.lastRun.model);
    if (runModel && runModel !== "default") runtimeArgs.push("--model", runModel);
    if (["low", "medium", "high", "xhigh", "max"].includes(text(this.lastRun.effort))) {
      runtimeArgs.push("--effort", text(this.lastRun.effort));
    }
    const developerInstructions = developerInstructionsWithSkills(this.lastRun);
    if (developerInstructions) runtimeArgs.push("--append-system-prompt", developerInstructions);
    if (this.mcpConfigPath) runtimeArgs.push("--mcp-config", this.mcpConfigPath);
    runtimeArgs.push("/context");
    const stdout = await this.runClaudeOneShot(
      claudeRuntimeArguments(this.input.provider, runtimeArgs),
    );
    return claudeContextSnapshotFromJsonOutput(stdout);
  }
  private runClaudeOneShot(args: string[]): Promise<string> {
    const provider = this.input.provider;
    const commandParts = splitProviderCommand(provider.command);
    const command = expandHome(commandParts[0] ?? "");
    if (!command) return Promise.reject(new Error("Claude provider command is empty."));
    const env = runtimeEnvironment(provider.env, this.input.env, this.input.runEnvironment, {
      CLAUDE_AGENT_SDK_VERSION: "0.3.169",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      NODE_OPTIONS: undefined,
    });
    ensureProviderCli(provider, this.input.cwd, env);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...commandParts.slice(1), ...args], {
        cwd: this.input.cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
        }, 4_000).unref();
        reject(new Error("Claude /context query timed out."));
      }, 12_000);
      timeout.unref?.();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (exitCode === 0) {
          resolve(stdout);
          return;
        }
        reject(
          new Error(
            `Claude /context query failed with exit code ${exitCode ?? "unknown"}.` +
              `${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
          ),
        );
      });
    });
  }
}

type ClaudeContextSnapshot = {
  usedTokens?: number;
  windowTokens?: number;
};

function claudeRuntimeSessionId(value: unknown): string {
  const source = record(value);
  const message = record(source.message);
  return (
    text(source.session_id) ||
    text(source.sessionId) ||
    text(message.session_id) ||
    text(message.sessionId)
  );
}

function claudeContextSnapshotFromJsonOutput(output: string): ClaudeContextSnapshot | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of [...lines].reverse()) {
    const parsed = parseJson(line);
    const result = rawText(record(parsed).result);
    const snapshot = result ? claudeContextSnapshotFromMarkdown(result) : undefined;
    if (snapshot) return snapshot;
  }
  return claudeContextSnapshotFromMarkdown(output);
}

function claudeContextSnapshotFromMarkdown(markdown: string): ClaudeContextSnapshot | undefined {
  const content = stripAnsi(markdown);
  const match = content.match(/\*\*Tokens:\*\*\s*([^/\n]+?)\s*\/\s*([^\s(]+)(?:\s*\([^)]+\))?/i);
  if (!match) return undefined;
  const usedTokens = claudeContextTokenCount(match[1]);
  const windowTokens = claudeContextTokenCount(match[2]);
  if (usedTokens === undefined && windowTokens === undefined) return undefined;
  return { usedTokens, windowTokens };
}

function claudeContextTokenCount(value: string | undefined): number | undefined {
  const normalized = (value ?? "")
    .replace(/[*_`~]/g, "")
    .replace(/\btokens?\b/gi, "")
    .trim();
  const match = normalized.match(/^<?\s*([\d,.]+)\s*([kKmMbB])?$/);
  if (!match) return undefined;
  const amount = Number(match[1]?.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const suffix = match[2]?.toLowerCase();
  const multiplier =
    suffix === "b" ? 1_000_000_000 : suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
