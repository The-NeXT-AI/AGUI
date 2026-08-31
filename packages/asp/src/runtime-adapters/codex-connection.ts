import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { normalizeModels, normalizeUsage } from "../asp-protocol.js";
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
  type AspModel,
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
  CODEX_TRANSCRIPT_FILE_LIMIT,
  codexTranscriptSession,
  codexToolMessage,
  patchTranscriptTool,
  codexToolAliases,
  codexTranscriptMetadata,
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
  claudeSettingsFiles,
  markdownFiles,
  markdownFilesRecursive,
  walkDirectory,
  readJsonFile,
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
  ensureProviderCli,
  closeChild,
  runtimeEnvironment,
} from "./shared.js";

export class CodexRuntimeConnection extends RuntimeConnection {
  private requestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly serverRequests = new Map<string, { method: string; params: unknown }>();
  private readonly toolOutputs = new Map<string, string>();
  private readonly textParts = new Map<string, string>();
  private readonly messageParts: AspMessagePart[] = [];
  private readonly tools: AspToolEvent[] = [];
  private lastRun: Record<string, unknown> = {};
  private lastStatus = "";
  private lastUsage: ReturnType<typeof normalizeUsage>;
  private permissionPolicyOverride: unknown;
  private sessionTitle = "";
  private threadId = "";
  private turnId = "";
  private runId = "";
  private runFinished = false;
  private startedAt = 0;
  private lines?: readline.Interface;

  send(message: Record<string, unknown>): void {
    const method = text(message.method);
    const id = rpcId(message.id);
    if (method === "capabilities" && id !== undefined) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: codexCapabilities(this.input.provider.capabilities, this.input.cwd),
        version: ASP_VERSION,
      });
      return;
    }
    if (method === "list_models" && id !== undefined) {
      void this.listCodexModels(id);
      return;
    }
    if (method === "list_sessions" && id !== undefined) {
      void this.listCodexSessions(id);
      return;
    }
    if (method === "session_messages" && id !== undefined) {
      void this.codexSessionMessages(id, text(message.providerSessionId));
      return;
    }
    if (method === "resume_session" && id !== undefined) {
      void this.resumeCodexSession(id, text(message.providerSessionId));
      return;
    }
    if (method === "delete_session" && id !== undefined) {
      void this.deleteCodexSession(
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
        codexCapabilities(this.input.provider.capabilities, this.input.cwd),
      )
    )
      return;
    if (message.type === "run") {
      void this.startRun(message).catch((error) => this.emitError(asError(error)));
      return;
    }
    if (message.type === "abort" || method === "run.cancel") {
      void this.interrupt();
      return;
    }
    if (id !== undefined && Object.prototype.hasOwnProperty.call(message, "result")) {
      this.respondToServerRequest(id, record(message.result));
    }
  }

  override close(): void {
    this.lines?.close();
    super.close();
  }

  private async startRun(run: Record<string, unknown>): Promise<void> {
    this.runId = text(run.runId);
    this.threadId = text(run.providerSessionId);
    this.turnId = "";
    this.runFinished = false;
    this.startedAt = Date.now();
    this.lastRun = run;
    this.lastStatus = "starting";
    this.lastUsage = undefined;
    this.sessionTitle = openCodeSessionTitle(text(run.prompt));
    this.messageParts.length = 0;
    this.tools.length = 0;
    this.textParts.clear();
    this.toolOutputs.clear();
    const providerEnv = this.input.provider.env ?? {};
    const args = normalizeCodexArgs(this.input.provider.args, text(run.speed));
    const child = this.startChild(args);
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleNativeMessage(JSON.parse(line) as RpcMessage);
      } catch (error) {
        this.emitAspError(`Failed to parse Codex app-server message: ${asError(error).message}`);
      }
    });

    await this.request("initialize", {
      capabilities: { experimentalApi: true, requestAttestation: false },
      clientInfo: {
        name: "codex",
        title: "codex",
        version: "0.1.0",
      },
    });
    this.write({ method: "initialized" });

    const approval = codexApprovalSettings(text(run.approvalMode), this.input.cwd);
    const mcpServers = mergedCodexMcpServers(this.input.cwd, run.mcpServers);
    const config = buildCodexConfig(mcpServers);
    const common = {
      ...approval,
      config,
      cwd: this.input.cwd,
      developerInstructions: developerInstructionsWithSkills(run),
      mcpServers,
      model: nullableText(run.model),
    };
    let thread: unknown;
    if (this.threadId) {
      try {
        thread = await this.request("thread/resume", { ...common, threadId: this.threadId });
      } catch {
        thread = await this.request("thread/start", common);
      }
    } else {
      thread = await this.request("thread/start", common);
    }
    this.threadId = nestedText(thread, "thread", "id");
    this.sessionTitle = runtimeSessionTitle(thread) || this.sessionTitle;
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id.");

    const turn = await this.request("turn/start", {
      ...approval,
      cwd: this.input.cwd,
      developerInstructions: developerInstructionsWithSkills(run),
      effort: nullableText(run.effort),
      input: codexUserInput(run),
      mcpServers,
      model: nullableText(run.model),
      threadId: this.threadId,
    });
    this.turnId = nestedText(turn, "turn", "id");
    this.sessionTitle = runtimeSessionTitle(turn) || this.sessionTitle;
    this.emitSessionState();
  }

  private async listCodexModels(id: string | number): Promise<void> {
    const fallbackModels = this.input.provider.models ?? [];
    try {
      const models = await this.fetchCodexModels();
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { models: models.length ? models : fallbackModels },
        version: ASP_VERSION,
      });
    } catch {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { models: fallbackModels },
        version: ASP_VERSION,
      });
    }
  }

  private async fetchCodexModels(): Promise<AspModel[]> {
    const { args, command } = codexQueryCommand(this.input.provider, "default");
    if (!command) throw new Error("Codex app-server model listing requires a command.");
    const env = runtimeEnvironment(
      this.input.provider.env,
      this.input.env,
      this.input.runEnvironment,
    );
    ensureProviderCli(this.input.provider, this.input.cwd, env);
    const child = spawn(command, args, {
      cwd: this.input.cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const pending = new Map<
      string,
      {
        method: string;
        reject(error: Error): void;
        resolve(value: unknown): void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >();
    let requestId = 1;
    let stderr = "";
    const failPending = (error: Error) => {
      for (const [key, request] of pending) {
        clearTimeout(request.timeout);
        request.reject(error);
        pending.delete(key);
      }
    };
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", failPending);
    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
      failPending(new Error(`Codex app-server model listing stopped with ${reason}. ${stderr}`));
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      const responseId = rpcId(message.id);
      if (responseId === undefined) return;
      const request = pending.get(String(responseId));
      if (!request) return;
      pending.delete(String(responseId));
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(message.error.message || `${request.method} failed.`));
      } else {
        request.resolve(message.result);
      }
    });

    const request = (method: string, params: unknown): Promise<unknown> => {
      const nextId = requestId++;
      child.stdin.write(`${JSON.stringify({ id: nextId, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(String(nextId));
          reject(new Error(`Codex app-server ${method} timed out.`));
        }, 30_000);
        pending.set(String(nextId), { method, reject, resolve, timeout });
      });
    };

    try {
      await request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: {
          name: "codex",
          title: "codex",
          version: "0.1.0",
        },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const models: AspModel[] = [];
      let cursor = "";
      do {
        const page = record(
          await request("model/list", {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        models.push(...normalizeModels(page));
        cursor = text(page.nextCursor ?? page.next_cursor);
      } while (cursor);
      return [...new Map(models.map((model) => [model.id, model])).values()];
    } finally {
      lines.close();
      for (const request of pending.values()) clearTimeout(request.timeout);
      pending.clear();
      closeChild(child);
    }
  }

  private async listCodexSessions(id: string | number): Promise<void> {
    try {
      const providerEnv = this.input.provider.env ?? {};
      const sessions = codexTranscriptFiles(CODEX_TRANSCRIPT_FILE_LIMIT, providerEnv)
        .map((filePath) => codexTranscriptSession(filePath, this.input.provider.id, providerEnv))
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

  private async codexSessionMessages(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = codexTranscriptSnapshotForSession(
        sessionId,
        this.input.provider.id,
        this.input.provider.env ?? {},
      );
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

  private async resumeCodexSession(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = codexTranscriptSnapshotForSession(
        sessionId,
        this.input.provider.id,
        this.input.provider.env ?? {},
      );
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

  private async deleteCodexSession(id: string | number, sessionId: string): Promise<void> {
    try {
      const providerEnv = this.input.provider.env ?? {};
      const snapshot = codexTranscriptSnapshotForSession(
        sessionId,
        this.input.provider.id,
        providerEnv,
      );
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
      removeCodexSessionIndexEntry(snapshot.aliases, providerEnv);
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
      throw new Error("Codex extension invocation requires extension and method.");
    let result: unknown;
    if (extension === "asp.ext.run-control") {
      result = await this.invokeCodexRunControl(method, payload);
    } else if (extension === "asp.ext.permissions") {
      result = this.invokeCodexPermissions(method, payload);
    } else if (extension === "asp.ext.session-state") {
      result = this.invokeCodexSessionState(method);
    } else if (extension === "asp.ext.runtime") {
      result = this.invokeCodexRuntime(method);
    } else if (extension === "vendor.codex.app-server") {
      result = await this.invokeCodexVendor(method, payload);
    } else {
      throw new Error(`Codex adapter does not support extension ${extension}.`);
    }
    this.emitMessage({
      asp: ASP_NAME,
      id,
      result: { extension, method, result },
      version: ASP_VERSION,
    });
  }

  private async invokeCodexRunControl(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "steer") {
      const message = text(payload.message) || text(payload.prompt);
      if (!message) throw new Error("steer requires message.");
      if (!this.threadId) throw new Error("steer requires an active Codex thread.");
      const approval = codexApprovalSettings(text(this.lastRun.approvalMode), this.input.cwd);
      const turn = await this.request("turn/start", {
        ...approval,
        cwd: this.input.cwd,
        developerInstructions: developerInstructionsWithSkills(this.lastRun),
        effort: nullableText(this.lastRun.effort),
        input: [{ text: message, text_elements: [], type: "text" }],
        mcpServers: mergedCodexMcpServers(this.input.cwd, this.lastRun.mcpServers),
        model: nullableText(this.lastRun.model),
        threadId: this.threadId,
      });
      this.turnId = nestedText(turn, "turn", "id") || this.turnId;
      this.lastStatus = "inProgress";
      this.emitExtensionEvent(
        "asp.ext.run-control",
        "queue.updated",
        { ...this.codexSessionState(), message, method: "steer" },
        "none",
      );
      this.emitSessionState();
      return { threadId: this.threadId, turnId: this.turnId || undefined, queued: true };
    }
    if (method === "abort_current_step") {
      await this.interrupt({ close: false });
      this.lastStatus = "interrupted";
      this.emitExtensionEvent(
        "asp.ext.run-control",
        "step.aborted",
        this.codexSessionState(),
        "none",
      );
      return {
        threadId: this.threadId || undefined,
        turnId: this.turnId || undefined,
        aborted: true,
      };
    }
    if (method === "follow_up") {
      const message = text(payload.message) || text(payload.prompt);
      if (!message) throw new Error("follow_up requires message.");
      if (!this.threadId) throw new Error("follow_up requires an active Codex thread.");
      const approval = codexApprovalSettings(text(this.lastRun.approvalMode), this.input.cwd);
      const turn = await this.request("turn/start", {
        ...approval,
        cwd: this.input.cwd,
        developerInstructions: developerInstructionsWithSkills(this.lastRun),
        effort: nullableText(this.lastRun.effort),
        input: [{ text: message, text_elements: [], type: "text" }],
        mcpServers: mergedCodexMcpServers(this.input.cwd, this.lastRun.mcpServers),
        model: nullableText(this.lastRun.model),
        threadId: this.threadId,
      });
      this.turnId = nestedText(turn, "turn", "id") || this.turnId;
      this.lastStatus = "inProgress";
      this.emitSessionState();
      return { threadId: this.threadId, turnId: this.turnId || undefined };
    }
    if (method === "compact") {
      this.emitExtensionEvent(
        "asp.ext.run-control",
        "compaction.started",
        this.codexSessionState(),
        "none",
      );
      this.emitExtensionEvent(
        "asp.ext.run-control",
        "compaction.completed",
        this.codexSessionState(),
        "none",
      );
      return {
        threadId: this.threadId || undefined,
        turnId: this.turnId || undefined,
        compacted: true,
      };
    }
    if (method === "set_session_title") {
      const title = text(payload.title) || text(payload.name);
      if (!title) throw new Error("set_session_title requires title.");
      this.sessionTitle = title;
      this.emitSessionState();
      return { threadId: this.threadId || undefined, title };
    }
    if (method === "set_model") {
      const model = text(payload.model);
      if (!model) throw new Error("set_model requires model.");
      this.lastRun = { ...this.lastRun, model };
      this.emitExtensionEvent("asp.ext.run-control", "model.changed", { model }, "none");
      this.emitSessionState();
      return { model };
    }
    if (method === "set_effort") {
      const effort = text(payload.effort) || text(payload.level);
      if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
        throw new Error("set_effort requires a supported reasoning effort.");
      }
      this.lastRun = { ...this.lastRun, effort };
      this.emitExtensionEvent("asp.ext.run-control", "effort.changed", { effort }, "none");
      this.emitSessionState();
      return { effort };
    }
    throw new Error(`Codex run-control method is not supported: ${method}`);
  }

  private invokeCodexPermissions(method: string, payload: Record<string, unknown>): unknown {
    if (method === "get_policy")
      return codexPermissionPolicy(
        this.input.cwd,
        text(this.lastRun.approvalMode),
        this.permissionPolicyOverride,
      );
    if (method === "set_policy") {
      this.permissionPolicyOverride = payload.policy ?? payload;
      const policy = codexPermissionPolicy(
        this.input.cwd,
        text(this.lastRun.approvalMode),
        this.permissionPolicyOverride,
      );
      this.emitExtensionEvent("asp.ext.permissions", "policy.updated", policy, "none");
      return policy;
    }
    throw new Error(`Codex permissions method is not supported: ${method}`);
  }

  private invokeCodexSessionState(method: string): unknown {
    if (method === "get_state") return this.codexSessionState();
    if (method === "get_messages") {
      return {
        messages: [
          codexMessageRecord(this.threadId, this.messageParts, this.tools, this.textParts),
        ],
      };
    }
    throw new Error(`Codex session-state method is not supported: ${method}`);
  }

  private invokeCodexRuntime(method: string): unknown {
    if (method !== "get_runtime")
      throw new Error(`Codex runtime method is not supported: ${method}`);
    return {
      adapter: "codex-app-server",
      cwd: this.input.cwd,
      provider: {
        id: this.input.provider.id,
        name: this.input.provider.name,
        args: this.input.provider.args,
      },
      threadId: this.threadId || undefined,
      turnId: this.turnId || undefined,
      title: this.sessionTitle || undefined,
      config: codexRuntimeConfig(this.input.cwd),
      agentsGuidance: codexAgentGuidance(this.input.cwd),
      commands: codexSlashCommands(this.input.cwd),
      mcpServers: mergedCodexMcpServers(this.input.cwd, this.lastRun.mcpServers),
      skills: mergeRuntimeSkills(this.lastRun.skills, codexSkills(this.input.cwd)),
      hooks: codexHooks(this.input.cwd),
      features: [
        "threads",
        "turns",
        "plan",
        "diff",
        "approvals",
        "questions",
        "mcpServers",
        "sandbox",
        "interrupt",
        "AGENTS.md",
        "config.toml",
        "skills",
        "hooks",
      ],
    };
  }

  private async invokeCodexVendor(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "raw_request")
      throw new Error(`Codex vendor method is not supported: ${method}`);
    const nativeMethod = text(payload.nativeMethod) || text(payload.method);
    if (!nativeMethod) throw new Error("vendor.codex.app-server raw_request requires method.");
    if (nativeMethod === "extension.invoke")
      throw new Error("raw_request cannot invoke ASP extensions recursively.");
    return this.request(nativeMethod, payload.params ?? {});
  }

  private emitCodexUsage(usage: ReturnType<typeof normalizeUsage>): void {
    if (!usage) return;
    this.lastUsage = usage;
    this.emitMessage({
      type: "usage",
      runId: this.runId,
      usage,
      model: text(this.lastRun.model) || undefined,
      providerSessionId: this.threadId || undefined,
    });
    this.emitSessionState();
  }

  private handleNativeMessage(message: RpcMessage): void {
    this.emitNativeEvent(
      "vendor.codex.app-server",
      this.lastRun.preserveNativeEvents === true,
      message,
      this.runId,
      this.threadId || undefined,
    );
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error)
        pending.reject(new Error(message.error.message || "Codex request failed."));
      else {
        if (pending.method === "turn/start") {
          this.emitEmbeddedResponse(message.result);
        }
        pending.resolve(message.result);
      }
      return;
    }
    if (this.handleResponseStreamEvent(message)) return;
    if (this.handleCodexTranscriptEvent(message)) return;
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (!message.method) return;
    const params = record(message.params);
    this.emitEmbeddedResponse(params);
    const usage = normalizeUsage(params);
    if (usage && /(usage|tokenUsage)/i.test(message.method)) {
      this.emitCodexUsage(usage);
      return;
    }
    if (isRuntimeSessionStateMethod(message.method)) {
      this.threadId = runtimeSessionId(params) || this.threadId;
      this.sessionTitle = runtimeSessionTitle(params) || this.sessionTitle;
      this.emitSessionState();
      return;
    }

    if (
      message.method === "item/reasoning/textDelta" ||
      message.method === "item/reasoning/summaryTextDelta"
    ) {
      const delta = rawText(params.delta);
      if (!delta) return;
      this.emitReasoningDelta(
        text(params.itemId) || text(params.item_id) || "codex-reasoning",
        delta,
      );
      return;
    }
    if (message.method === "item/reasoning/summaryPartAdded") {
      return;
    }
    if (message.method === "rawResponseItem/completed") {
      this.emitResponseOutputItem(record(params.item));
      return;
    }
    if (message.method === "rawResponse/completed") {
      const usage = normalizeUsage(record(params.usage)) ?? normalizeUsage(params);
      if (usage) this.emitCodexUsage(usage);
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const delta = rawText(params.delta);
      if (!delta) return;
      const id = text(params.itemId) || "codex-assistant";
      this.emitAssistantDelta(id, delta);
      return;
    }
    if (message.method === "item/plan/delta") {
      const delta = rawText(params.delta);
      if (!delta) return;
      const id = text(params.itemId) || "codex-plan";
      const content = `${this.textParts.get(id) ?? ""}${delta}`;
      this.textParts.set(id, content);
      this.emitPart({ id, type: "plan", content });
      return;
    }
    if (message.method === "item/status") {
      this.lastStatus = text(params.status) || text(params.message) || this.lastStatus;
      this.emitPart({
        id: text(params.itemId) || text(params.id) || `codex-status-${Date.now()}`,
        type: "status",
        content: text(params.message) || text(params.text) || undefined,
        status: text(params.status) || undefined,
      } as AspMessagePart);
      return;
    }
    if (
      message.method === "item/commandExecution/outputDelta" ||
      message.method === "command/exec/outputDelta" ||
      message.method === "process/outputDelta"
    ) {
      const id = text(params.itemId) || text(params.id) || text(params.processId);
      const delta = rawText(params.delta) ?? rawText(params.output) ?? rawText(params.chunk);
      if (!id || !delta) return;
      const output = `${this.toolOutputs.get(id) ?? ""}${delta}`;
      this.toolOutputs.set(id, output);
      this.emitTool({
        id,
        kind: "commandExecution",
        name: "Command",
        output,
        phase: "updated",
        status: "inProgress",
      });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = record(params.item);
      const phase = message.method === "item/completed" ? "completed" : "started";
      const itemType = text(item.type);
      if (itemType === "agentMessage") {
        const id = text(item.id) || "codex-assistant";
        if (phase === "started") {
          this.emitAssistantPlaceholder(id);
          return;
        }
        if (phase === "completed") {
          const finalText = rawText(item.text) ?? rawText(item.content) ?? "";
          this.emitAssistantFinalText(id, finalText);
        }
        return;
      }
      if (itemType === "plan") {
        const content = rawText(item.text) ?? rawText(item.content) ?? "";
        if (content) this.emitPart({ id: text(item.id) || "codex-plan", type: "plan", content });
        return;
      }
      if (isCodexReasoningKind(itemType)) {
        const content = codexReasoningText(item);
        if (content) this.emitReasoningContent(text(item.id) || "codex-reasoning", content);
        return;
      }
      const tool = codexTool(item, phase, this.toolOutputs.get(text(item.id)) ?? "");
      if (tool) this.emitTool(tool);
      if (phase === "completed" && itemType === "fileChange") {
        for (const part of codexDiffParts(item)) this.emitPart(part);
      }
      return;
    }
    if (message.method === "turn/started") {
      this.turnId = nestedText(params, "turn", "id") || this.turnId;
      this.lastStatus = nestedText(params, "turn", "status") || "inProgress";
      this.emitSessionState();
      return;
    }
    if (message.method === "turn/completed") {
      if (this.runFinished) return;
      this.emitEmbeddedResponse(params);
      this.runFinished = true;
      const status = nestedText(params, "turn", "status");
      this.lastStatus = status || (this.runFinished ? "completed" : this.lastStatus);
      this.emitMessage({
        type: "run_finished",
        runId: this.runId,
        providerSessionId: this.threadId || undefined,
        success: status !== "failed" && status !== "interrupted",
        exitCode: status === "failed" ? 1 : 0,
      });
      this.emitSessionState();
      return;
    }
    if (message.method === "error") {
      this.emitAspError(
        text(params.message) || nestedText(params, "error", "message") || "Codex app-server error.",
      );
    }
  }

  private handleCodexTranscriptEvent(message: RpcMessage): boolean {
    const source = record(message);
    const type = text(source.type);
    if (type === "response_item") {
      const item = record(source.payload);
      if (!Object.keys(item).length) return true;
      this.emitResponseOutputItem(item);
      if (!["message", "reasoning"].includes(text(item.type))) {
        const tool = codexTool(item, "completed", this.toolOutputs.get(text(item.id)) ?? "");
        if (tool) this.emitTool(tool);
      }
      return true;
    }
    if (type === "event_msg") {
      const payload = record(source.payload);
      const payloadType = text(payload.type);
      if (payloadType === "agent_reasoning") {
        const content = rawText(payload.text);
        if (content)
          this.emitReasoningContent(
            text(payload.id) || `codex-agent-reasoning-${Date.now()}`,
            content,
          );
        return true;
      }
      if (payloadType === "agent_message") {
        const id = text(payload.id) || "codex-assistant";
        const delta = rawText(payload.delta);
        if (delta) {
          this.emitAssistantDelta(id, delta);
          return true;
        }
        const content = rawText(payload.message) ?? rawText(payload.text);
        if (content) this.emitAssistantFinalText(id, content);
        return true;
      }
      if (payloadType === "token_count") {
        const usage = normalizeUsage(payload);
        if (usage) this.emitCodexUsage(usage);
        return true;
      }
      if (payloadType === "task_complete" || payloadType === "task_completed") {
        this.emitTaskComplete(payload);
        return true;
      }
      if (payloadType === "task_failed" || payloadType === "turn_aborted") {
        this.emitTaskComplete(payload, { success: false });
        return true;
      }
      return true;
    }
    return false;
  }

  private handleResponseStreamEvent(message: RpcMessage): boolean {
    const event = responseStreamEvent(message);
    if (!event) {
      const directResponse = completedResponsePayload(message);
      if (directResponse) {
        this.emitCompletedResponse(directResponse);
        return true;
      }
      return false;
    }
    const type = text(event.type);
    if (!type.startsWith("response.")) {
      const directResponse = completedResponsePayload(event);
      if (directResponse) {
        this.emitCompletedResponse(directResponse);
        return true;
      }
      return false;
    }

    if (type === "response.reasoning_text.delta") {
      const id = responseItemId(event, "codex-reasoning");
      const delta = rawText(event.delta);
      if (delta) this.emitReasoningDelta(id, delta);
      return true;
    }

    if (type === "response.reasoning_text.done") {
      const id = responseItemId(event, "codex-reasoning");
      const content = rawText(event.text);
      if (content) this.emitReasoningContent(id, content);
      return true;
    }

    if (type === "response.output_text.delta") {
      const id = responseItemId(event, "codex-assistant");
      const delta = rawText(event.delta);
      if (delta) this.emitAssistantDelta(id, delta);
      return true;
    }

    if (type === "response.output_text.done") {
      const id = responseItemId(event, "codex-assistant");
      this.emitAssistantFinalText(id, rawText(event.text) ?? "");
      return true;
    }

    if (type === "response.output_item.added") {
      this.emitResponseOutputItemStarted(eventItem(event));
      return true;
    }

    if (type === "response.output_item.done") {
      this.emitResponseOutputItem(eventItem(event));
      return true;
    }

    if (type === "response.completed") {
      this.emitCompletedResponse(record(event.response));
      return true;
    }

    return true;
  }

  private emitEmbeddedResponse(value: unknown): void {
    const response = completedResponsePayload(value);
    if (response) this.emitCompletedResponse(response, { finish: false });
  }

  private emitCompletedResponse(
    response: Record<string, unknown>,
    options: { finish?: boolean } = {},
  ): void {
    const output = array(response.output);
    if (output.length) {
      for (const item of output) this.emitResponseOutputItem(record(item));
    } else {
      for (const event of array(response.streamed_data).map(record)) {
        if (Object.keys(event).length) this.handleResponseStreamEvent(event as RpcMessage);
      }
      this.emitAssistantFinalText("codex-assistant", rawText(response.output_text) ?? "");
    }
    const usage = normalizeUsage(record(response.usage));
    if (usage) this.emitCodexUsage(usage);
    if (options.finish !== false && !this.runFinished) {
      this.runFinished = true;
      this.emitMessage({
        type: "run_finished",
        runId: this.runId,
        providerSessionId: this.threadId || undefined,
        success: text(response.status) !== "failed",
        exitCode: text(response.status) === "failed" ? 1 : 0,
      });
    }
  }

  private emitTaskComplete(
    payload: Record<string, unknown>,
    options: { success?: boolean } = {},
  ): void {
    const finalText = rawText(payload.last_agent_message) || rawText(payload.lastAgentMessage);
    if (finalText) this.emitAssistantFinalText("codex-assistant", finalText);
    if (this.runFinished) return;
    this.runFinished = true;
    const success = options.success ?? true;
    this.lastStatus = success ? "completed" : "failed";
    this.emitMessage({
      type: "run_finished",
      runId: this.runId,
      providerSessionId: this.threadId || undefined,
      success,
      exitCode: success ? 0 : 1,
      durationMs: number(payload.duration_ms) ?? number(payload.durationMs),
      usage: this.lastUsage,
    });
    this.emitSessionState();
  }

  private emitResponseOutputItem(item: Record<string, unknown>): void {
    const itemType = text(item.type);
    const id =
      text(item.id) || (isCodexReasoningKind(itemType) ? "codex-reasoning" : "codex-assistant");
    if (isCodexReasoningKind(itemType)) {
      const content = codexReasoningText(item);
      if (content) this.emitReasoningContent(id, content);
      return;
    }
    if (itemType === "message" || itemType === "agentMessage") {
      this.emitAssistantFinalText(id, contentText(item.content) || rawText(item.text) || "");
      return;
    }
    const tool = codexTool(item, "completed", this.toolOutputs.get(id) ?? "");
    if (tool) this.emitTool(tool);
  }

  private emitResponseOutputItemStarted(item: Record<string, unknown>): void {
    const itemType = text(item.type);
    const id =
      text(item.id) || (isCodexReasoningKind(itemType) ? "codex-reasoning" : "codex-assistant");
    if (isCodexReasoningKind(itemType)) {
      this.emitReasoningPlaceholder(id);
      return;
    }
    if (itemType === "message" || itemType === "agentMessage") {
      this.emitAssistantPlaceholder(id);
      return;
    }
    const tool = codexTool(item, "started", this.toolOutputs.get(id) ?? "");
    if (tool) this.emitTool(tool);
  }

  private emitAssistantPlaceholder(id: string): void {
    this.emitPlaceholderPart({
      id,
      type: "text",
      content: "",
      metadata: { placeholder: true },
    });
  }

  private emitReasoningPlaceholder(id: string): void {
    this.emitPlaceholderPart({
      id,
      type: "reasoning",
      content: "",
      metadata: { placeholder: true },
      status: "inProgress",
    } as AspMessagePart);
  }

  private emitPlaceholderPart(part: AspMessagePart): void {
    this.emitMessage({
      type: "message_part",
      runId: this.runId,
      part,
      providerSessionId: this.threadId || undefined,
    });
  }

  private emitReasoningContent(id: string, content: string): void {
    this.textParts.set(id, content);
    this.emitPart({ id, type: "reasoning", content } as AspMessagePart);
  }

  private emitReasoningDelta(id: string, delta: string): void {
    this.emitReasoningContent(id, `${this.textParts.get(id) ?? ""}${delta}`);
  }

  private emitAssistantDelta(id: string, delta: string): void {
    this.textParts.set(id, `${this.textParts.get(id) ?? ""}${delta}`);
    this.emitMessage({
      type: "message_delta",
      runId: this.runId,
      data: delta,
      itemId: id,
      providerSessionId: this.threadId || undefined,
    });
  }

  private emitAssistantFinalText(id: string, finalText: string): void {
    if (!finalText) return;
    const streamed = this.textParts.get(id) ?? "";
    const delta = finalText.startsWith(streamed)
      ? finalText.slice(streamed.length)
      : streamed
        ? ""
        : finalText;
    this.textParts.set(id, finalText || streamed);
    if (delta) {
      this.emitMessage({
        type: "message_delta",
        runId: this.runId,
        data: delta,
        itemId: id,
        providerSessionId: this.threadId || undefined,
      });
    }
  }

  private handleServerRequest(message: RpcMessage): void {
    const id = rpcId(message.id);
    if (id === undefined || !message.method) return;
    if (isCodexApproval(message.method)) {
      const scope = codexApprovalScope(message.method, message.params);
      const automatic = runtimeAutomaticApproval(
        text(this.lastRun.approvalMode),
        scope,
        message.method,
      );
      if (automatic) {
        const response = codexApprovalResponse(message.method, message.params, automatic);
        if (response instanceof Error) {
          this.write({
            id,
            error: { code: ASP_ERROR_CODES.internalError, message: response.message },
          });
        } else {
          this.write({ id, result: response });
        }
        return;
      }
      this.serverRequests.set(String(id), { method: message.method, params: message.params });
      this.emitMessage({
        id,
        method: "approval_request",
        params: {
          method: message.method,
          params: message.params,
          scope,
          title: codexApprovalTitle(message.method, message.params),
          options: ["allow", "allow-session", "allow-always", "deny", "cancel"],
        },
      });
      return;
    }
    if (isQuestionMethod(message.method)) {
      this.serverRequests.set(String(id), { method: message.method, params: message.params });
      const params = record(message.params);
      this.emitMessage({
        id,
        method: "question_request",
        params: {
          method: message.method,
          params: message.params,
          questions: params.questions,
          question: text(params.question) || text(params.message),
          title: text(params.title) || message.method,
        },
      });
      return;
    }
    this.write({
      id,
      error: {
        code: ASP_ERROR_CODES.methodNotFound,
        message: `Unsupported Codex app-server request: ${message.method}`,
      },
    });
  }

  private respondToServerRequest(id: string | number, result: Record<string, unknown>): void {
    const request = this.serverRequests.get(String(id));
    if (!request) return;
    this.serverRequests.delete(String(id));
    if (isCodexApproval(request.method)) {
      const decision = normalizeDecision(result.decision);
      const response = codexApprovalResponse(request.method, request.params, decision);
      if (response instanceof Error) {
        this.write({
          id,
          error: { code: ASP_ERROR_CODES.internalError, message: response.message },
        });
      } else {
        this.write({ id, result: response });
      }
      return;
    }
    this.write({ id, result });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.requestId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { method, resolve, reject });
    });
  }

  private write(message: RpcMessage): void {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async interrupt(options: { close?: boolean } = {}): Promise<void> {
    if (this.threadId && this.turnId) {
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      }).catch(() => undefined);
    }
    if (options.close !== false) this.close();
  }

  private emitPart(part: AspMessagePart): void {
    upsertRuntimePart(this.messageParts, part);
    this.emitMessage({
      type: "message_part",
      runId: this.runId,
      part,
      providerSessionId: this.threadId || undefined,
    });
  }

  private emitTool(toolEvent: AspToolEvent): void {
    upsertRuntimeTool(this.tools, toolEvent);
    this.emitMessage({
      type: "tool_event",
      runId: this.runId,
      toolEvent,
      providerSessionId: this.threadId || undefined,
    });
  }

  private emitAspError(message: string): void {
    this.emitMessage({
      type: "error",
      runId: this.runId,
      message,
      providerSessionId: this.threadId || undefined,
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
      providerSessionId: this.threadId || undefined,
      extension,
      event,
      payload,
      fallback,
    });
  }
  private emitSessionState(): void {
    this.emitExtensionEvent(
      "asp.ext.session-state",
      "state.updated",
      this.codexSessionState(),
      "none",
    );
  }
  private codexSessionState(): AspSessionState {
    return {
      providerSessionId: this.threadId || undefined,
      title: this.sessionTitle || undefined,
      cwd: this.input.cwd,
      model: text(this.lastRun.model) || undefined,
      effort: text(this.lastRun.effort) || undefined,
      streaming: this.runFinished ? false : undefined,
      context: this.lastUsage
        ? {
            usedTokens: this.lastUsage.contextTokens ?? this.lastUsage.totalTokens,
            windowTokens: this.lastUsage.contextWindowTokens,
          }
        : undefined,
      metadata: {
        adapter: "codex-app-server",
        ...(this.turnId ? { turnId: this.turnId } : {}),
        ...(this.lastStatus ? { status: this.lastStatus } : {}),
        ...(this.startedAt ? { startedAt: this.startedAt } : {}),
        agentsGuidance: codexAgentGuidance(this.input.cwd).map((item) => item.path),
      },
    };
  }
}

function codexQueryCommand(
  provider: { args?: string[]; command: string },
  speed: string,
): { args: string[]; command: string } {
  const commandParts = splitProviderCommand(provider.command);
  return {
    command: expandHome(commandParts[0] ?? ""),
    args: [...commandParts.slice(1), ...normalizeCodexArgs(provider.args ?? [], speed)],
  };
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
