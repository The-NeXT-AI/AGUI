import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  closeChild,
  runtimeEnvironment,
} from "./shared.js";

export class OpenCodeRuntimeConnection extends RuntimeConnection {
  private readonly pendingPermissions = new Map<
    string,
    { permissionId: string; sessionId: string }
  >();
  private readonly textParts = new Map<string, string>();
  private readonly toolOutputs = new Map<string, string>();
  private baseUrl = "";
  private approvalMode = "request";
  private eventAbort?: AbortController;
  private eventReady?: Promise<void>;
  private serverReady?: Promise<void>;
  private runId = "";
  private selectedAgent = "";
  private sessionId = "";
  private runFinished = false;
  private preserveNativeEvents = false;
  private startedAt = 0;

  send(message: Record<string, unknown>): void {
    const method = text(message.method);
    const id = rpcId(message.id);
    if (method === "capabilities" && id !== undefined) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: openCodeCapabilities(this.input.provider.capabilities),
        version: ASP_VERSION,
      });
      return;
    }
    if (method === "list_models" && id !== undefined) {
      void this.listModels(id);
      return;
    }
    if (method === "list_sessions" && id !== undefined) {
      void this.listSessions(id);
      return;
    }
    if (method === "new_session" && id !== undefined) {
      void this.newSession(id, text(message.title));
      return;
    }
    if (method === "close_session" && id !== undefined) {
      void this.closeSession(id, text(message.providerSessionId));
      return;
    }
    if (method === "session_messages" && id !== undefined) {
      void this.sessionMessages(id, text(message.providerSessionId));
      return;
    }
    if (method === "resume_session" && id !== undefined) {
      void this.resumeSession(id, text(message.providerSessionId));
      return;
    }
    if (method === "delete_session" && id !== undefined) {
      void this.deleteSession(id, text(message.providerSessionId));
      return;
    }
    if (this.handleCommonQuery(message, openCodeCapabilities(this.input.provider.capabilities))) {
      return;
    }
    if (method === "extension.invoke" && id !== undefined) {
      void this.invokeExtension(id, record(message.params)).catch((error) =>
        this.emitExtensionError(id, asError(error)),
      );
      return;
    }
    if (message.type === "run") {
      void this.startRun(message).catch((error) => this.emitAspError(asError(error).message));
      return;
    }
    if (message.type === "abort" || method === "run.cancel") {
      void this.abortRun();
      return;
    }
    if (id !== undefined && Object.prototype.hasOwnProperty.call(message, "result")) {
      void this.respondPermission(String(id), record(message.result));
    }
  }

  override close(): void {
    this.eventAbort?.abort();
    super.close();
  }

  private async startRun(run: Record<string, unknown>): Promise<void> {
    this.preserveNativeEvents = run.preserveNativeEvents === true;
    this.runId = text(run.runId);
    this.sessionId = text(run.providerSessionId);
    this.runFinished = false;
    this.startedAt = Date.now();
    this.approvalMode = text(run.approvalMode) || "request";
    await this.ensureServer();
    await this.listenEvents();

    let sessionSnapshot: unknown;
    if (!this.sessionId) {
      const session = await this.request("POST", "/session", {
        title: openCodeSessionTitle(text(run.prompt)),
      });
      sessionSnapshot = session;
      this.sessionId = text(record(session).id) || nestedText(session, "session", "id");
    } else {
      sessionSnapshot = await this.request(
        "GET",
        `/session/${encodeURIComponent(this.sessionId)}`,
      ).catch(() => undefined);
    }
    if (!this.sessionId) throw new Error("OpenCode did not return a session id.");
    const state = sessionSnapshot
      ? openCodeSessionState(sessionSnapshot, this.input.provider.id)
      : undefined;
    if (state) this.emitExtensionEvent("asp.ext.session-state", "state.updated", state, "none");

    await this.request("POST", `/session/${encodeURIComponent(this.sessionId)}/prompt_async`, {
      agent: this.selectedAgent || openCodeAgent(this.input.provider.capabilities),
      messageID: `asp-${this.runId || Date.now()}`,
      model: openCodeModelSelection(text(run.model)),
      parts: await openCodePromptParts(run),
      system: developerInstructionsWithSkills(run),
    });
  }

  private async listModels(id: string | number): Promise<void> {
    try {
      await this.ensureServer();
      const providers = await this.request("GET", "/config/providers");
      const models = openCodeModels(providers);
      const fallbackModels = models.length
        ? []
        : await openCodeCliModels(this.input).catch(() => []);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: {
          models: models.length
            ? models
            : fallbackModels.length
              ? fallbackModels
              : (this.input.provider.models ?? []),
        },
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

  private async listSessions(id: string | number): Promise<void> {
    try {
      await this.ensureServer();
      const sessions = await this.request("GET", "/session");
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { sessions: openCodeSessions(sessions, this.input.provider.id) },
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

  private async newSession(id: string | number, title: string): Promise<void> {
    try {
      await this.ensureServer();
      const session = await this.request("POST", "/session", title ? { title } : {});
      this.emitMessage({
        id,
        result: { session: openCodeSession(record(session), this.input.provider.id) },
      });
    } catch (error) {
      this.emitMessage({
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
      });
    }
  }

  private async closeSession(id: string | number, sessionId: string): Promise<void> {
    try {
      await this.ensureServer();
      await this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
      this.emitMessage({ id, result: { closed: true } });
    } catch (error) {
      this.emitMessage({
        id,
        error: { code: ASP_ERROR_CODES.internalError, message: asError(error).message },
      });
    }
  }

  private async sessionMessages(id: string | number, sessionId: string): Promise<void> {
    try {
      await this.ensureServer();
      const messages = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
      );
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { messages: openCodeMessages(messages) },
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

  private async resumeSession(id: string | number, sessionId: string): Promise<void> {
    try {
      await this.ensureServer();
      const [session, messages] = await Promise.all([
        this.request("GET", `/session/${encodeURIComponent(sessionId)}`),
        this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`),
      ]);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: {
          messages: openCodeMessages(messages),
          session: openCodeSession(record(session), this.input.provider.id),
        },
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

  private async deleteSession(id: string | number, sessionId: string): Promise<void> {
    try {
      await this.ensureServer();
      await this.request("DELETE", `/session/${encodeURIComponent(sessionId)}`);
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
    await this.ensureServer();
    const extension = text(params.extension);
    const method = text(params.method);
    const providerSessionId = text(params.providerSessionId) || text(params.provider_session_id);
    const payload = {
      ...record(params.payload),
      ...(providerSessionId ? { providerSessionId } : {}),
    };
    if (!extension || !method)
      throw new Error("OpenCode extension invocation requires extension and method.");
    let result: unknown;
    if (extension === "asp.ext.agents") {
      result = await this.invokeOpenCodeAgents(method, payload);
    } else if (extension === "asp.ext.run-control") {
      result = await this.invokeOpenCodeRunControl(method, payload);
    } else if (extension === "asp.ext.session-state") {
      result = await this.invokeOpenCodeSessionState(method, payload);
    } else if (extension === "asp.ext.runtime") {
      result = await this.invokeOpenCodeRuntime(method);
    } else if (extension === "vendor.opencode.server") {
      result = await this.invokeOpenCodeVendor(method, payload);
    } else {
      throw new Error(`OpenCode adapter does not support extension ${extension}.`);
    }
    this.emitMessage({
      asp: ASP_NAME,
      id,
      result: { extension, method, result },
      version: ASP_VERSION,
    });
  }

  private async invokeOpenCodeAgents(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "list_agents") {
      const agents = await this.request("GET", "/agent").catch(() => []);
      return { agents: openCodeAgents(agents) };
    }
    if (method === "select_agent") {
      const agentId =
        text(payload.agentId) || text(payload.agent_id) || text(payload.id) || text(payload.agent);
      if (!agentId) throw new Error("select_agent requires agentId.");
      this.selectedAgent = agentId;
      this.emitExtensionEvent("asp.ext.agents", "agent.selected", { agentId }, "none");
      return { agentId };
    }
    if (method === "invoke_agent") {
      const sessionId = this.requireOpenCodeSession(payload);
      const agentId =
        text(payload.agentId) ||
        text(payload.agent_id) ||
        text(payload.agent) ||
        this.selectedAgent ||
        undefined;
      const message = text(payload.message) || text(payload.prompt);
      if (!message) throw new Error("invoke_agent requires message.");
      await this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        ...(agentId ? { agent: agentId } : {}),
        messageID: `asp-agent-${Date.now()}`,
        parts: [{ text: message, type: "text" }],
      });
      this.emitExtensionEvent("asp.ext.agents", "agent.started", { agentId, sessionId }, "none");
      return { agentId, sessionId };
    }
    if (method === "cancel_agent") {
      const sessionId = this.requireOpenCodeSession(payload);
      await this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch(
        () => undefined,
      );
      this.emitExtensionEvent(
        "asp.ext.agents",
        "agent.failed",
        { sessionId, status: "cancelled" },
        "none",
      );
      return { sessionId, cancelled: true };
    }
    throw new Error(`OpenCode agents method is not supported: ${method}`);
  }

  private async invokeOpenCodeRunControl(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "follow_up") {
      const sessionId = this.requireOpenCodeSession(payload);
      const message = text(payload.message) || text(payload.prompt);
      if (!message) throw new Error("follow_up requires message.");
      await this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        ...(this.selectedAgent ? { agent: this.selectedAgent } : {}),
        messageID: `asp-follow-up-${Date.now()}`,
        parts: [{ text: message, type: "text" }],
      });
      return { sessionId };
    }
    if (method === "compact") {
      const sessionId = this.requireOpenCodeSession(payload);
      const result = await this.request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/compact`,
        {
          instructions: text(payload.instructions) || text(payload.message) || undefined,
        },
      );
      this.emitExtensionEvent("asp.ext.run-control", "compaction.started", { sessionId }, "none");
      return result ?? { sessionId };
    }
    if (method === "set_session_title") {
      const sessionId = this.requireOpenCodeSession(payload);
      const title = text(payload.title) || text(payload.name);
      if (!title) throw new Error("set_session_title requires title.");
      const result = await this.request("POST", `/session/${encodeURIComponent(sessionId)}`, {
        title,
      });
      const state = openCodeSessionState(
        result ?? { id: sessionId, title },
        this.input.provider.id,
      );
      if (state) this.emitExtensionEvent("asp.ext.session-state", "state.updated", state, "none");
      return result ?? { id: sessionId, title };
    }
    if (method === "abort_current_step") {
      const sessionId = this.requireOpenCodeSession(payload);
      await this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch(
        () => undefined,
      );
      return { sessionId, aborted: true };
    }
    throw new Error(`OpenCode run-control method is not supported: ${method}`);
  }

  private async invokeOpenCodeSessionState(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = this.requireOpenCodeSession(payload);
    if (method === "get_state") {
      const session = await this.request("GET", `/session/${encodeURIComponent(sessionId)}`);
      return openCodeSessionState(session, this.input.provider.id);
    }
    if (method === "get_messages") {
      const messages = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
      );
      return { messages: openCodeMessages(messages) };
    }
    throw new Error(`OpenCode session-state method is not supported: ${method}`);
  }

  private async invokeOpenCodeRuntime(method: string): Promise<unknown> {
    if (method !== "get_runtime")
      throw new Error(`OpenCode runtime method is not supported: ${method}`);
    const [config, providers] = await Promise.all([
      this.request("GET", "/config").catch(() => undefined),
      this.request("GET", "/config/providers").catch(() => undefined),
    ]);
    return { config, providers };
  }

  private async invokeOpenCodeVendor(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "raw_request")
      throw new Error(`OpenCode vendor method is not supported: ${method}`);
    const httpMethod = text(payload.httpMethod) || text(payload.method) || "GET";
    if (httpMethod !== "GET" && httpMethod !== "POST")
      throw new Error("raw_request supports GET and POST only.");
    const route = text(payload.route) || text(payload.path);
    if (!route.startsWith("/")) throw new Error("raw_request requires an absolute route.");
    return this.request(httpMethod, route, payload.body);
  }

  private async abortRun(): Promise<void> {
    if (this.sessionId) {
      await this.request("POST", `/session/${encodeURIComponent(this.sessionId)}/abort`).catch(
        () => undefined,
      );
    }
    this.finishRun(false);
  }

  private handleOpenCodeEvent(event: Record<string, unknown>): void {
    this.emitNativeEvent(
      "vendor.opencode.server",
      this.preserveNativeEvents,
      event,
      this.runId,
      this.sessionId || undefined,
    );
    const properties = record(event.properties);
    const sessionId =
      text(properties.sessionID) ||
      text(properties.sessionId) ||
      nestedText(properties, "session", "id");
    if (this.sessionId && sessionId && sessionId !== this.sessionId) return;
    if (sessionId) this.sessionId = sessionId;
    const type = text(event.type);
    if (type === "message.part.updated") {
      this.handleOpenCodePart(record(properties.part));
      return;
    }
    if (type === "message.updated") {
      const usage = normalizeUsage(record(properties.message));
      if (usage) this.emitUsage(usage, text(record(properties.message).modelID) || undefined);
      return;
    }
    if (type === "permission.updated") {
      this.handleOpenCodePermission(record(properties.permission));
      return;
    }
    if (type === "todo.updated") {
      this.emitPart({
        id: "opencode-todos",
        items: openCodeTodos(properties.todos),
        title: "Plan",
        type: "plan",
      });
      return;
    }
    if (type === "file.edited" || type === "session.diff") {
      for (const part of openCodeDiffParts(properties)) this.emitPart(part);
      return;
    }
    if (type === "session.error") {
      this.emitAspError(nestedText(properties, "error", "message") || "OpenCode session error.");
      this.finishRun(false);
      return;
    }
    if (type === "session.idle") {
      this.finishRun(true);
      return;
    }
    if (type === "session.updated" || type === "session.compact" || type === "session.summarized") {
      const session = record(properties.session);
      const state = openCodeSessionState(session, this.input.provider.id);
      if (state) this.emitExtensionEvent("asp.ext.session-state", "state.updated", state, "none");
      if (type === "session.compact") {
        this.emitExtensionEvent("asp.ext.run-control", "compaction.completed", properties, "none");
      }
      this.emitPart({
        id: `opencode-${type}`,
        content: type,
        status: text(record(properties.session).timeIdle) ? "idle" : "updated",
        title: humanize(type),
        type: "status",
      });
    }
  }

  private handleOpenCodePart(part: Record<string, unknown>): void {
    const id = text(part.id) || text(part.partID) || `opencode-part-${Date.now()}`;
    const type = text(part.type);
    if (type === "text") {
      const delta = openCodePartDelta(id, part, this.textParts);
      if (delta) {
        this.emitMessage({
          type: "message_delta",
          runId: this.runId,
          data: delta,
          providerSessionId: this.sessionId || undefined,
        });
      }
      return;
    }
    if (type === "reasoning") {
      const content = rawText(part.text) ?? rawText(part.content) ?? "";
      if (content) {
        this.textParts.set(id, content);
        this.emitPart({ id, content, type: "reasoning" });
      }
      return;
    }
    if (type === "tool") {
      const tool = openCodeToolEvent(part, this.toolOutputs);
      if (tool) this.emitTool(tool);
      return;
    }
    if (type === "step-start" || type === "step-finish" || type === "agent") {
      if (type === "agent") {
        this.emitExtensionEvent(
          "asp.ext.agents",
          text(part.status) === "completed" ? "agent.completed" : "agent.started",
          {
            agentId: text(part.name) || text(part.agent) || undefined,
            part,
          },
          "none",
        );
      }
      this.emitPart({
        id,
        content: rawText(part.text) ?? rawText(part.content) ?? type,
        status: text(part.status) || type,
        title: type === "agent" ? text(part.name) || "Agent" : humanize(type),
        type: "status",
      });
      return;
    }
    if (type === "file") {
      this.emitPart({
        id,
        name: text(part.name) || undefined,
        path: text(part.path) || undefined,
        title: text(part.path) || text(part.name) || "File",
        type: "resource",
        uri: text(part.url) || undefined,
      });
      return;
    }
    this.emitPart({
      id,
      label: type || "OpenCode part",
      type: "raw",
      value: part,
    });
  }

  private handleOpenCodePermission(permission: Record<string, unknown>): void {
    const permissionId = text(permission.id);
    const sessionId = text(permission.sessionID) || this.sessionId;
    const status = text(permission.status);
    if (!permissionId || !sessionId || (status && status !== "pending")) return;
    const scope = openCodePermissionScope(permission);
    const method = text(permission.method) || text(permission.type) || "opencode.permission";
    const automatic = runtimeAutomaticApproval(this.approvalMode, scope, method);
    if (automatic) {
      void this.respondOpenCodePermissionDecision(permissionId, sessionId, automatic);
      return;
    }
    this.pendingPermissions.set(permissionId, { permissionId, sessionId });
    this.emitMessage({
      id: permissionId,
      method: "approval_request",
      params: {
        method,
        options: ["allow", "allow-session", "allow-always", "deny", "cancel"],
        params: permission,
        scope,
        title: openCodePermissionTitle(permission),
      },
    });
  }

  private async respondPermission(id: string, result: Record<string, unknown>): Promise<void> {
    const permission = this.pendingPermissions.get(id);
    if (!permission) return;
    this.pendingPermissions.delete(id);
    const decision = normalizeDecision(result.decision);
    await this.respondOpenCodePermissionDecision(
      permission.permissionId,
      permission.sessionId,
      decision,
    );
  }

  private async respondOpenCodePermissionDecision(
    permissionId: string,
    sessionId: string,
    decision: AspApprovalDecision,
  ): Promise<void> {
    const response =
      decision === "allow-session" || decision === "allow-always"
        ? "always"
        : decision === "allow"
          ? "once"
          : "reject";
    await this.request(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      { response },
    ).catch((error) => this.emitAspError(asError(error).message));
  }

  private async ensureServer(): Promise<void> {
    if (this.serverReady) return this.serverReady;
    this.serverReady = this.startServer();
    return this.serverReady;
  }

  private async startServer(): Promise<void> {
    if (this.input.provider.url) {
      this.baseUrl = this.input.provider.url.replace(/\/$/, "");
      return;
    }
    const plan = normalizeOpenCodeServerArgs(this.input.provider.args, randomLocalPort());
    this.baseUrl = `http://127.0.0.1:${plan.port}`;
    this.startChild(plan.args);
    await waitForHttp(this.baseUrl, "/config", this.input.provider.timeoutMs ?? 10_000);
  }

  private listenEvents(): Promise<void> {
    if (this.eventReady) return this.eventReady;
    this.eventAbort = new AbortController();
    let ready = false;
    this.eventReady = new Promise<void>((resolve, reject) => {
      void readEventStream(
        this.url("/event"),
        this.eventAbort!.signal,
        (event) => this.handleOpenCodeEvent(event),
        () => {
          ready = true;
          resolve();
        },
      ).catch((error) => {
        if (this.eventAbort?.signal.aborted) return;
        this.emitAspError(asError(error).message);
        if (!ready) reject(error);
      });
    });
    return this.eventReady;
  }

  private async request(
    method: "DELETE" | "GET" | "POST",
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(this.url(route), {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    });
    const responseText = await response.text();
    const data = responseText ? (parseJson(responseText) ?? responseText) : null;
    if (!response.ok) {
      throw new Error(
        openCodeErrorMessage(data) || `${method} ${route} failed with ${response.status}.`,
      );
    }
    return data;
  }

  private url(route: string): string {
    const url = new URL(route, this.baseUrl);
    url.searchParams.set("directory", this.input.cwd);
    return url.toString();
  }

  private finishRun(success: boolean): void {
    if (this.runFinished) return;
    this.runFinished = true;
    this.emitMessage({
      type: "run_finished",
      runId: this.runId,
      providerSessionId: this.sessionId || undefined,
      durationMs: Date.now() - this.startedAt,
      exitCode: success ? 0 : 1,
      success,
    });
  }

  private emitPart(part: AspMessagePart): void {
    this.emitMessage({
      type: "message_part",
      runId: this.runId,
      part,
      providerSessionId: this.sessionId || undefined,
    });
  }
  private emitTool(toolEvent: AspToolEvent): void {
    this.emitMessage({
      type: "tool_event",
      runId: this.runId,
      toolEvent,
      providerSessionId: this.sessionId || undefined,
    });
  }
  private emitUsage(usage: ReturnType<typeof normalizeUsage>, model?: string): void {
    if (!usage) return;
    this.emitMessage({
      type: "usage",
      runId: this.runId,
      usage,
      model,
      providerSessionId: this.sessionId || undefined,
    });
  }
  private emitAspError(message: string): void {
    this.emitMessage({
      type: "error",
      runId: this.runId,
      message,
      providerSessionId: this.sessionId || undefined,
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
  private requireOpenCodeSession(payload: Record<string, unknown>): string {
    const sessionId =
      text(payload.providerSessionId) ||
      text(payload.provider_session_id) ||
      text(payload.sessionId) ||
      this.sessionId;
    if (!sessionId) throw new Error("OpenCode extension method requires an active session.");
    return sessionId;
  }
}

function openCodeCliModels(input: {
  cwd: string;
  env?: Record<string, string>;
  provider: { command: string; env?: Record<string, string> };
  runEnvironment?: Record<string, string | undefined>;
}): Promise<AspModel[]> {
  const commandParts = splitProviderCommand(input.provider.command);
  const command = commandParts[0] ?? "";
  if (!command) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...commandParts.slice(1), "models"], {
      cwd: input.cwd,
      env: runtimeEnvironment(input.provider.env, input.env, input.runEnvironment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OpenCode models timed out."));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve(openCodeModelsFromCli(output));
    });
  });
}

function openCodeModelsFromCli(output: string): AspModel[] {
  const seen = new Set<string>();
  return output
    .split(/\r?\n/)
    .map((line) =>
      stripAnsi(line)
        .trim()
        .replace(/^[-*]\s+/, "")
        .trim(),
    )
    .filter((line) => line && line.includes("/") && !seen.has(line) && seen.add(line))
    .map((model) => ({
      id: model,
      model,
      displayName: model,
    }));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
