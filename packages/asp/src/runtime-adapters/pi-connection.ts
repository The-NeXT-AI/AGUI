import { type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { normalizeUsage } from "../asp-protocol.js";
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

export class PiRuntimeConnection extends RuntimeConnection {
  private requestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly uiRequests = new Map<string, Record<string, unknown>>();
  private readonly toolOutputs = new Map<string, string>();
  private readonly textParts = new Map<string, string>();
  private detachStdout?: () => void;
  private approvalMode = "request";
  private runId = "";
  private sessionId = "";
  private runFinished = false;
  private preserveNativeEvents = false;

  send(message: Record<string, unknown>): void {
    const method = text(message.method);
    const id = rpcId(message.id);
    if (method === "capabilities" && id !== undefined) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: piCapabilities(this.input.provider.capabilities),
        version: ASP_VERSION,
      });
      return;
    }
    if (method === "list_models" && id !== undefined) {
      void this.listModels(id);
      return;
    }
    if (method === "extension.invoke" && id !== undefined) {
      void this.invokeExtension(id, record(message.params)).catch((error) =>
        this.emitExtensionError(id, asError(error)),
      );
      return;
    }
    if (this.handleCommonQuery(message, piCapabilities(this.input.provider.capabilities))) return;
    if (message.type === "run") {
      void this.startRun(message).catch((error) => this.finishWithPiError(asError(error).message));
      return;
    }
    if (message.type === "abort" || method === "run.cancel") {
      void this.abort();
      return;
    }
    if (id !== undefined && Object.prototype.hasOwnProperty.call(message, "result")) {
      this.respondUiRequest(String(id), record(message.result));
    }
  }

  override close(): void {
    this.detachStdout?.();
    super.close();
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    const child = this.startChild(normalizePiArgs(this.input.provider.args));
    if (!this.detachStdout) {
      this.detachStdout = onJsonLines(child, (line) => {
        if (!line.trim()) return;
        try {
          this.handlePiMessage(JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          this.emitStdout(`${line}\n`);
          this.emitAspError(`Failed to parse Pi RPC message: ${asError(error).message}`);
        }
      });
    }
    return child;
  }

  private async listModels(id: string | number): Promise<void> {
    try {
      this.ensureStarted();
      const data = await this.request("get_available_models");
      const models = piModels(data);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { models: models.length ? models : (this.input.provider.models ?? []) },
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
    this.ensureStarted();
    const extension = text(params.extension);
    const method = text(params.method);
    const payload = record(params.payload);
    if (!extension || !method)
      throw new Error("Pi extension invocation requires extension and method.");
    let result: unknown;
    if (extension === "asp.ext.run-control") {
      result = await this.invokePiRunControl(method, payload);
    } else if (extension === "asp.ext.session-state") {
      result = await this.invokePiSessionState(method, payload);
    } else if (extension === "vendor.pi.rpc") {
      result = await this.invokePiVendor(method, payload);
    } else {
      throw new Error(`Pi adapter does not support extension ${extension}.`);
    }
    this.emitMessage({
      asp: ASP_NAME,
      id,
      result: { extension, method, result },
      version: ASP_VERSION,
    });
  }

  private async invokePiRunControl(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "steer") {
      return this.request("steer", { message: text(payload.message) || text(payload.prompt) });
    }
    if (method === "follow_up") {
      return this.request("follow_up", { message: text(payload.message) || text(payload.prompt) });
    }
    if (method === "set_queue_mode") {
      const steeringMode = text(payload.steeringMode) || text(payload.steering_mode);
      const followUpMode = text(payload.followUpMode) || text(payload.follow_up_mode);
      const results: Record<string, unknown> = {};
      if (steeringMode)
        results.steering = await this.request("set_steering_mode", { mode: steeringMode });
      if (followUpMode)
        results.followUp = await this.request("set_follow_up_mode", { mode: followUpMode });
      if (!steeringMode && !followUpMode)
        throw new Error("set_queue_mode requires steeringMode or followUpMode.");
      return results;
    }
    if (method === "compact") {
      return this.request("compact", {
        instructions: text(payload.instructions) || text(payload.message) || undefined,
      });
    }
    if (method === "set_model") {
      const model = piModelSelection(text(payload.model));
      if (!model) throw new Error("set_model requires a model.");
      return this.request("set_model", model);
    }
    if (method === "cycle_model") return this.request("cycle_model");
    if (method === "set_effort") {
      const level = piThinkingLevel(text(payload.effort) || text(payload.level));
      if (!level) throw new Error("set_effort requires a Pi thinking level.");
      return this.request("set_thinking_level", { level });
    }
    if (method === "cycle_effort") return this.request("cycle_thinking_level");
    if (method === "abort_current_step") return this.request("abort");
    throw new Error(`Pi run-control method is not supported: ${method}`);
  }

  private async invokePiSessionState(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "get_state") {
      const state = await this.request("get_state");
      this.updateSessionState(state);
      return piSessionState(state);
    }
    if (method === "get_messages") {
      return this.request("get_messages", {
        limit: positiveInteger(payload.limit) ?? undefined,
      });
    }
    throw new Error(`Pi session-state method is not supported: ${method}`);
  }

  private async invokePiVendor(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (method !== "raw_command") throw new Error(`Pi vendor method is not supported: ${method}`);
    const command = text(payload.command);
    if (!command) throw new Error("vendor.pi.rpc raw_command requires command.");
    const params = record(payload.params);
    return this.request(command, params);
  }

  private emitExtensionError(id: string | number, error: Error): void {
    this.emitMessage({
      asp: ASP_NAME,
      id,
      error: { code: ASP_ERROR_CODES.internalError, message: error.message },
      version: ASP_VERSION,
    });
  }

  private async startRun(run: Record<string, unknown>): Promise<void> {
    this.preserveNativeEvents = run.preserveNativeEvents === true;
    this.runId = text(run.runId);
    this.sessionId = text(run.providerSessionId);
    this.runFinished = false;
    this.approvalMode = text(run.approvalMode) || "request";
    this.ensureStarted();
    const model = piModelSelection(text(run.model));
    if (model)
      await this.request("set_model", model).catch((error) =>
        this.emitAspError(asError(error).message),
      );
    const effort = piThinkingLevel(text(run.effort));
    if (effort) await this.request("set_thinking_level", { level: effort }).catch(() => undefined);
    const state = await this.request("get_state").catch(() => undefined);
    this.updateSessionState(state);
    const promptResult = await this.request("prompt", {
      images: await piPromptImages(run),
      message: promptWithDeveloperInstructions(run),
    });
    this.updateSessionState(promptResult);
  }

  private handlePiMessage(message: Record<string, unknown>): void {
    this.emitNativeEvent(
      "vendor.pi.rpc",
      this.preserveNativeEvents,
      message,
      this.runId,
      this.sessionId || undefined,
    );
    if (text(message.type) === "response") {
      const id = rpcId(message.id);
      if (id === undefined) return;
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      if (message.success === false) {
        pending.reject(
          new Error(
            text(message.error) ||
              nestedText(message, "error", "message") ||
              "Pi RPC request failed.",
          ),
        );
      } else {
        pending.resolve(message.data ?? message);
      }
      return;
    }
    if (text(message.type) === "extension_ui_request") {
      this.handlePiUiRequest(message);
      return;
    }
    this.handlePiEvent(message);
  }

  private handlePiEvent(event: Record<string, unknown>): void {
    const type = text(event.type);
    const usage = normalizeUsage(event) ?? normalizeUsage(record(event.result));
    if (usage) this.emitUsage(usage);
    if (isPiSessionStateEvent(type)) {
      this.updateSessionState(event);
      return;
    }
    if (type === "message_update") {
      this.handlePiMessageUpdate(event);
      return;
    }
    if (
      type === "tool_execution_start" ||
      type === "tool_execution_update" ||
      type === "tool_execution_end"
    ) {
      const tool = piToolEvent(event, this.toolOutputs);
      if (tool) this.emitTool(tool);
      return;
    }
    if (type === "bash_execution_update") {
      const id = text(event.id) || "pi-bash";
      const delta = rawText(event.delta) ?? "";
      const output = `${this.toolOutputs.get(id) ?? ""}${delta}`;
      this.toolOutputs.set(id, output);
      this.emitTool({
        id,
        kind: "commandExecution",
        name: "bash",
        output,
        phase: "updated",
        status: "inProgress",
      });
      return;
    }
    if (type === "turn_end") {
      this.emitPiFinalMessage(record(event.message));
      const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
      for (const item of toolResults) {
        const tool = piToolResult(record(item), this.toolOutputs);
        if (tool) this.emitTool(tool);
      }
      return;
    }
    if (type === "agent_settled") {
      void this.finishFromPiState(true);
      return;
    }
    if (type === "extension_error") {
      this.emitAspError(text(event.message) || text(event.error) || "Pi extension error.");
      return;
    }
    if (
      [
        "queue_update",
        "compaction_start",
        "compaction_end",
        "auto_retry_start",
        "auto_retry_end",
        "summarization_retry_scheduled",
        "summarization_retry_attempt_start",
        "summarization_retry_finished",
      ].includes(type)
    ) {
      const statusPart: AspMessagePart = {
        id: `pi-${type}`,
        content: piStatusText(event),
        status: type,
        title: humanize(type),
        type: "status",
      };
      this.emitExtensionEvent("asp.ext.run-control", piRunControlEventName(type), event, {
        type: "message_part",
        part: statusPart,
      });
    }
  }

  private handlePiMessageUpdate(event: Record<string, unknown>): void {
    const assistantEvent = record(event.assistantMessageEvent);
    const type = text(assistantEvent.type);
    if (type === "text_delta") {
      const delta = rawText(assistantEvent.delta);
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
    if (type === "thinking_delta") {
      const delta = rawText(assistantEvent.delta);
      if (delta)
        this.appendPart(`pi-thinking-${number(assistantEvent.contentIndex)}`, "reasoning", delta);
      return;
    }
    if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
      const tool = piToolCallStreamEvent(assistantEvent, this.toolOutputs);
      if (tool) this.emitTool(tool);
      return;
    }
    if (type === "error") {
      this.emitAspError(text(assistantEvent.reason) || "Pi message stream error.");
    }
  }

  private handlePiUiRequest(message: Record<string, unknown>): void {
    const id = text(message.id);
    const method = text(message.method);
    if (!id) {
      this.emitExtensionEvent("asp.ext.ui", "ui.updated", message, {
        type: "message_part",
        part: {
          id: `pi-ui-${Date.now()}`,
          content: text(message.message) || text(message.title) || method || "Pi UI update",
          status: method || "ui",
          title: text(message.title) || "Pi UI",
          type: "status",
        },
      });
      return;
    }
    this.uiRequests.set(id, message);
    if (method === "confirm") {
      const scope = runtimeApprovalScope(message, "tool");
      const automatic = runtimeAutomaticApproval(
        this.approvalMode,
        scope,
        "pi.extension_ui.confirm",
      );
      if (automatic) {
        this.respondUiRequest(id, { decision: automatic });
        return;
      }
      this.emitMessage({
        id,
        method: "approval_request",
        params: {
          method: "pi.extension_ui.confirm",
          options: ["allow", "deny", "cancel"],
          params: message,
          scope,
          title: text(message.title) || text(message.message) || "Pi confirmation",
        },
      });
      return;
    }
    this.emitMessage({
      id,
      method: "question_request",
      params: {
        method: `pi.extension_ui.${method || "input"}`,
        params: message,
        question: text(message.title) || text(message.message) || "Pi extension input",
        questions: [piUiQuestion(message)],
        title: text(message.title) || "Pi extension",
      },
    });
  }

  private respondUiRequest(id: string, result: Record<string, unknown>): void {
    const request = this.uiRequests.get(id);
    if (!request) return;
    this.uiRequests.delete(id);
    const method = text(request.method);
    const decision = normalizeDecision(result.decision);
    if (method === "confirm") {
      this.write({
        cancelled: decision === "cancel",
        confirmed:
          decision === "allow" || decision === "allow-session" || decision === "allow-always",
        id,
        type: "extension_ui_response",
      });
      return;
    }
    const answer = firstQuestionAnswer(result);
    this.write({
      cancelled: decision === "cancel",
      id,
      type: "extension_ui_response",
      value: answer,
    });
  }

  private emitPiFinalMessage(message: Record<string, unknown>): void {
    const id = text(message.id) || "pi-final-message";
    const finalText = piMessageText(message);
    if (!finalText) return;
    const streamed = this.textParts.get(id) ?? "";
    if (!streamed) {
      this.textParts.set(id, finalText);
      this.emitPart({ id, type: "text", content: finalText });
    }
  }

  private updateSessionState(value: unknown): void {
    const source = record(value);
    const merged: Record<string, unknown> = {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...source,
    };
    this.sessionId = text(merged.sessionId) || text(merged.session_id) || this.sessionId;
    const usage = normalizeUsage(merged);
    if (usage) this.emitUsage(usage);
    const state = piSessionState(merged);
    if (state) this.emitExtensionEvent("asp.ext.session-state", "state.updated", state, "none");
  }

  private async finishFromPiState(success: boolean): Promise<void> {
    if (this.runFinished) return;
    const state = await this.request("get_state").catch(() => undefined);
    this.updateSessionState(state);
    const stats = await this.request("get_session_stats").catch(() => undefined);
    const usage = normalizeUsage(stats) ?? normalizeUsage(record(stats).tokens);
    if (usage) this.emitUsage(usage);
    this.runFinished = true;
    this.emitMessage({
      type: "run_finished",
      runId: this.runId,
      providerSessionId: this.sessionId || undefined,
      success,
      exitCode: success ? 0 : 1,
    });
  }

  private finishWithPiError(message: string): void {
    if (this.runFinished) return;
    if (message) this.emitAspError(message);
    this.runFinished = true;
    this.emitMessage({
      type: "run_finished",
      runId: this.runId,
      providerSessionId: this.sessionId || undefined,
      success: false,
      exitCode: 1,
    });
  }

  private request(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = `asp-${this.requestId++}`;
    this.write({ id, type, ...params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async abort(): Promise<void> {
    await this.request("abort").catch(() => undefined);
    await this.finishFromPiState(false).catch(() => undefined);
    this.close();
  }

  private appendPart(id: string, type: "reasoning" | "text", delta: string): void {
    const content = `${this.textParts.get(id) ?? ""}${delta}`;
    this.textParts.set(id, content);
    this.emitPart({ id, type, content } as AspMessagePart);
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
  private emitUsage(usage: ReturnType<typeof normalizeUsage>): void {
    if (!usage) return;
    this.emitMessage({
      type: "usage",
      runId: this.runId,
      usage,
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
}
