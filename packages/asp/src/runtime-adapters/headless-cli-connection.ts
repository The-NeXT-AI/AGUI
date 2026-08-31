import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeUsage } from "../asp-protocol.js";
import { splitProviderCommand } from "../provider-store.js";
import {
  ASP_ERROR_CODES,
  ASP_NAME,
  ASP_VERSION,
  type AspMessageRecord,
  type AspMessagePart,
  type AspModel,
  type AspProvider,
  type AspProviderCapabilities,
  type AspProviderSession,
  type AspReasoningEffort,
  type AspSessionState,
  type AspToolEvent,
} from "../types.js";
import { RuntimeConnection } from "./base.js";
import {
  array,
  asError,
  booleanValue,
  compactExtensions,
  contentText,
  ensureProviderCli,
  hasOption,
  mergeExtensions,
  nativeAdapterCapabilities,
  normalizeDecision,
  normalizeRuntimeApprovalMode,
  onJsonLines,
  positiveInteger,
  promptWithDeveloperInstructions,
  rawText,
  record,
  rpcId,
  runtimeApprovalScope,
  runtimeAutomaticApproval,
  runtimeEnvironment,
  standardExtension,
  text,
  toolSemanticFromName,
} from "./shared.js";

type HeadlessCliKind = "grok" | "kimi";

const HEADLESS_REASONING_EFFORTS = new Set<AspReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const HEADLESS_SESSION_SCAN_LIMIT = 500;

type HeadlessSessionSnapshot = {
  aliases: string[];
  directory: string;
  messages: AspMessageRecord[];
  session: AspProviderSession;
};

export class HeadlessCliRuntimeConnection extends RuntimeConnection {
  private readonly pendingControlRequests = new Map<string, Record<string, unknown>>();
  private readonly textParts = new Map<string, string>();
  private readonly toolInputs = new Map<string, string>();
  private readonly toolOutputs = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolIdsByIndex = new Map<number, string>();
  private readonly messageParts: AspMessagePart[] = [];
  private readonly tools: AspToolEvent[] = [];
  private detachStdout?: () => void;
  private runFinished = false;
  private runId = "";
  private sessionId = "";
  private sessionTitle = "";
  private startedAt = 0;
  private lastRun: Record<string, unknown> = {};
  private messageSequence = 0;
  private currentMessageKey = "";
  private deltaText = "";
  private stdoutText = "";
  private stderrText = "";
  private lastUsage: ReturnType<typeof normalizeUsage>;

  send(message: Record<string, unknown>): void {
    const method = text(message.method);
    const id = rpcId(message.id);
    if (method === "capabilities" && id !== undefined) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: headlessCliCapabilities(this.kind(), this.input.provider.capabilities),
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
    if (method === "session_messages" && id !== undefined) {
      void this.sessionMessages(id, text(message.providerSessionId));
      return;
    }
    if (method === "resume_session" && id !== undefined) {
      void this.resumeSession(id, text(message.providerSessionId));
      return;
    }
    if (method === "delete_session" && id !== undefined) {
      void this.deleteSession(
        id,
        text(message.providerSessionId),
        text(message.transcriptPath) || text(message.transcript_path),
      );
      return;
    }
    if (method === "extension.invoke" && id !== undefined) {
      this.invokeExtension(id, record(message.params));
      return;
    }
    if (
      this.handleCommonQuery(
        message,
        headlessCliCapabilities(this.kind(), this.input.provider.capabilities),
      )
    )
      return;
    if (message.type === "run") {
      this.startRun(message);
      return;
    }
    if (message.type === "abort" || method === "run.cancel") {
      this.abort();
      return;
    }
    if (id !== undefined && Object.prototype.hasOwnProperty.call(message, "result")) {
      this.respondControlRequest(String(id), record(message.result));
    }
  }

  override close(): void {
    this.detachStdout?.();
    super.close();
  }

  private kind(): HeadlessCliKind {
    return headlessCliKind(this.input.provider);
  }

  private async listModels(id: string | number): Promise<void> {
    const fallback = this.input.provider.models ?? [];
    try {
      const models =
        this.kind() === "kimi"
          ? await queryKimiModels(this.input)
          : await queryGrokModels(this.input);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { models: models.length ? models : fallback },
        version: ASP_VERSION,
      });
    } catch (error) {
      if (fallback.length) {
        this.emitMessage({
          asp: ASP_NAME,
          id,
          result: { models: fallback },
          version: ASP_VERSION,
        });
        return;
      }
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: {
          code: ASP_ERROR_CODES.internalError,
          message: sanitizeCliDiagnostic(asError(error).message),
        },
        version: ASP_VERSION,
      });
    }
  }

  private async listSessions(id: string | number): Promise<void> {
    try {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: {
          sessions: headlessSessionSnapshots(this.kind(), this.input).map(
            (snapshot) => snapshot.session,
          ),
        },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: {
          code: ASP_ERROR_CODES.internalError,
          message: sanitizeCliDiagnostic(asError(error).message),
        },
        version: ASP_VERSION,
      });
    }
  }

  private async sessionMessages(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = headlessSessionSnapshotForSession(this.kind(), this.input, sessionId);
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
        error: {
          code: ASP_ERROR_CODES.internalError,
          message: sanitizeCliDiagnostic(asError(error).message),
        },
        version: ASP_VERSION,
      });
    }
  }

  private async resumeSession(id: string | number, sessionId: string): Promise<void> {
    try {
      const snapshot = headlessSessionSnapshotForSession(this.kind(), this.input, sessionId);
      if (snapshot?.session.id) this.sessionId = snapshot.session.id;
      if (snapshot?.session.title) this.sessionTitle = snapshot.session.title;
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: snapshot
          ? { messages: snapshot.messages, session: snapshot.session }
          : { messages: [] },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: {
          code: ASP_ERROR_CODES.internalError,
          message: sanitizeCliDiagnostic(asError(error).message),
        },
        version: ASP_VERSION,
      });
    }
  }

  private async deleteSession(
    id: string | number,
    sessionId: string,
    transcriptPath: string,
  ): Promise<void> {
    try {
      const deleted = deleteHeadlessSession(this.kind(), this.input, sessionId, transcriptPath);
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { deleted },
        version: ASP_VERSION,
      });
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: {
          code: ASP_ERROR_CODES.internalError,
          message: sanitizeCliDiagnostic(asError(error).message),
        },
        version: ASP_VERSION,
      });
    }
  }

  private invokeExtension(id: string | number, params: Record<string, unknown>): void {
    const extension = text(params.extension);
    const method = text(params.method);
    try {
      if (extension === "asp.ext.session-state") {
        if (method === "get_state") {
          this.emitExtensionResult(id, extension, method, this.sessionState());
          return;
        }
        if (method === "get_messages") {
          this.emitExtensionResult(id, extension, method, {
            messages: [this.messageRecord()].filter((message) => message.content),
          });
          return;
        }
      }
      if (extension === "asp.ext.runtime" && method === "get_runtime") {
        this.emitExtensionResult(id, extension, method, {
          adapter: this.kind() === "kimi" ? "kimi-cli" : "grok-cli",
          command: this.input.provider.command,
          args: this.input.provider.args,
          cwd: this.input.cwd,
          provider: {
            id: this.input.provider.id,
            name: this.input.provider.name,
          },
          sessionId: this.sessionId || undefined,
        });
        return;
      }
      throw new Error(
        `${this.input.provider.name} CLI adapter does not support ${extension}.${method}.`,
      );
    } catch (error) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: {
          code: ASP_ERROR_CODES.internalError,
          message: sanitizeCliDiagnostic(asError(error).message),
        },
        version: ASP_VERSION,
      });
    }
  }

  private emitExtensionResult(
    id: string | number,
    extension: string,
    method: string,
    result: unknown,
  ): void {
    this.emitMessage({
      asp: ASP_NAME,
      id,
      result: { extension, method, result },
      version: ASP_VERSION,
    });
  }

  private startRun(run: Record<string, unknown>): void {
    if (this.child && this.runFinished) {
      this.detachStdout?.();
      this.detachStdout = undefined;
      if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM");
      this.child = null;
    }
    this.resetRun(run);
    const args =
      this.kind() === "kimi"
        ? normalizeKimiCliArgs(this.input.provider.args, run)
        : normalizeGrokCliArgs(this.input.provider.args, run);
    const child = this.startChild(args);
    this.detachStdout = onJsonLines(child, (line) => this.handleCliLine(line));
    child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    child.once("error", (error) => {
      if (this.child === child) this.finishWithError(error);
    });
    child.once("close", (exitCode, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.finishFromExit(exitCode === 0 && !signal, exitCode ?? undefined);
    });
  }

  private resetRun(run: Record<string, unknown>): void {
    this.runId = text(run.runId);
    this.sessionId = text(run.providerSessionId);
    this.sessionTitle = "";
    this.runFinished = false;
    this.startedAt = Date.now();
    this.lastRun = run;
    this.messageSequence = 0;
    this.currentMessageKey = "";
    this.deltaText = "";
    this.stdoutText = "";
    this.stderrText = "";
    this.lastUsage = undefined;
    this.messageParts.length = 0;
    this.tools.length = 0;
    this.pendingControlRequests.clear();
    this.textParts.clear();
    this.toolInputs.clear();
    this.toolOutputs.clear();
    this.toolNames.clear();
    this.toolIdsByIndex.clear();
  }

  private handleCliLine(line: string): void {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      this.handleCliMessage(record(parsed));
    } catch {
      this.stdoutText += `${line}\n`;
      this.emitStdout(`${line}\n`);
    }
  }

  private handleCliMessage(message: Record<string, unknown>): void {
    this.emitNativeEvent(
      this.kind() === "kimi" ? "vendor.kimi.cli" : "vendor.grok.cli",
      this.lastRun.preserveNativeEvents === true,
      message,
      this.runId,
      this.sessionId || undefined,
    );
    this.updateSessionState(message);
    this.emitUsageIfPresent(message);
    const type = text(message.type);
    if (type === "stream_event") {
      this.handleAnthropicStreamEvent(
        record(message.event),
        text(message.parent_tool_use_id) || text(message.parentToolUseId),
      );
      return;
    }
    if (type === "assistant") {
      const assistant = record(message.message);
      this.handleAnthropicContent(
        assistant.content ?? message.content,
        text(message.parent_tool_use_id) || text(message.parentToolUseId),
      );
      return;
    }
    if (type === "user") {
      this.handleToolResults(
        record(message.message).content ?? message.content,
        text(message.parent_tool_use_id) || text(message.parentToolUseId),
      );
      return;
    }
    if (type === "control_request") {
      this.handleControlRequest(message);
      return;
    }
    if (type === "message_update") {
      this.handleMessageUpdate(message);
      return;
    }
    if (isCliToolEvent(type)) {
      const tool = genericToolEvent(message, type, this.toolOutputs);
      if (tool) this.emitTool(tool);
      return;
    }
    if (type === "text_delta" || type === "message_delta" || type === "agent_message_chunk") {
      const delta = cliText(message);
      if (delta) this.emitTextDelta(delta);
      return;
    }
    if (type === "thinking_delta" || type === "reasoning_delta" || type === "agent_thought_chunk") {
      const delta = cliText(message);
      if (delta) this.appendPart(`${this.kind()}-reasoning`, "reasoning", delta);
      return;
    }
    if (type === "plan") {
      this.emitPart(cliPlanPart(message, this.kind()));
      return;
    }
    if (type === "result" || type === "done" || type === "complete") {
      this.finishFromResult(message, message.is_error !== true && message.error === undefined);
      return;
    }
    if (type === "error") {
      this.emitAspError(
        cliDiagnostic(message) || `${this.input.provider.name} CLI emitted an error.`,
      );
      this.finishFromResult(message, false);
    }
  }

  private handleAnthropicStreamEvent(event: Record<string, unknown>, parentId: string): void {
    this.updateSessionState(event);
    this.emitUsageIfPresent(event);
    const type = text(event.type);
    if (type === "message_start") {
      this.currentMessageKey = this.messageKey(record(event.message)) || this.nextMessageKey();
      return;
    }
    const index = numberOrUndefined(event.index);
    if (type === "content_block_start") {
      const block = record(event.content_block);
      const blockType = text(block.type);
      if (blockType === "text") {
        const content = rawText(block.text) ?? rawText(block.content) ?? "";
        if (content) this.appendPart(this.partId("text", index, block.id), "text", content);
      } else if (blockType === "thinking" || blockType === "reasoning") {
        const content =
          rawText(block.thinking) ?? rawText(block.text) ?? rawText(block.content) ?? "";
        if (content)
          this.appendPart(this.partId("reasoning", index, block.id), "reasoning", content);
      } else if (blockType === "tool_use") {
        const tool = anthropicToolEvent(block, parentId, "started", this.kind());
        this.toolIdsByIndex.set(index ?? -1, tool.id);
        this.toolNames.set(tool.id, tool.name);
        this.emitTool(tool);
      }
      return;
    }
    if (type !== "content_block_delta") return;
    const delta = record(event.delta);
    const deltaType = text(delta.type);
    if (deltaType === "text_delta") {
      const content = rawText(delta.text);
      if (content) this.appendPart(this.partId("text", index), "text", content);
    } else if (deltaType === "thinking_delta" || deltaType === "reasoning_delta") {
      const content = rawText(delta.thinking) ?? rawText(delta.text);
      if (content) this.appendPart(this.partId("reasoning", index), "reasoning", content);
    } else if (deltaType === "input_json_delta") {
      const id = this.toolIdsByIndex.get(index ?? -1);
      const chunk = rawText(delta.partial_json);
      if (!id || !chunk) return;
      const json = `${this.toolInputs.get(id) ?? ""}${chunk}`;
      this.toolInputs.set(id, json);
      this.emitTool({
        id,
        input: tryJson(json) ?? json,
        kind: "tool_use",
        name: this.toolNames.get(id) || "Tool call",
        phase: "updated",
        semantic: toolSemanticFromName(this.toolNames.get(id) || ""),
        status: "inProgress",
      });
    }
  }

  private handleAnthropicContent(content: unknown, parentId: string): void {
    for (const item of array(content)) {
      const block = record(item);
      const type = text(block.type);
      const index = numberOrUndefined(block.index) ?? this.messageParts.length;
      if (type === "text") {
        const value = rawText(block.text) ?? rawText(block.content) ?? "";
        if (value && value !== this.textOutput()) {
          this.setPart(this.partId("text", index, block.id), "text", value);
        }
      } else if (type === "thinking" || type === "reasoning") {
        const value =
          rawText(block.thinking) ?? rawText(block.text) ?? rawText(block.content) ?? "";
        if (value) this.setPart(this.partId("reasoning", index, block.id), "reasoning", value);
      } else if (type === "tool_use") {
        this.emitTool(anthropicToolEvent(block, parentId, "started", this.kind()));
      }
    }
  }

  private handleToolResults(content: unknown, parentId: string): void {
    for (const item of array(content)) {
      const block = record(item);
      if (text(block.type) !== "tool_result") continue;
      const id = text(block.tool_use_id) || text(block.toolUseId) || text(block.id);
      if (!id) continue;
      const output = contentText(block.content ?? block.output ?? block.result);
      this.emitTool({
        id,
        error:
          block.is_error === true || block.isError === true ? output || "Tool failed." : undefined,
        kind: "tool_use",
        name: this.toolNames.get(id) || "Tool call",
        output,
        parentId: parentId || undefined,
        phase: "completed",
        semantic: toolSemanticFromName(this.toolNames.get(id) || ""),
        status: block.is_error === true || block.isError === true ? "failed" : "completed",
      });
    }
  }

  private handleMessageUpdate(message: Record<string, unknown>): void {
    const event = record(
      message.assistantMessageEvent ??
        message.assistant_message_event ??
        message.event ??
        message.delta ??
        message,
    );
    const type = text(event.type) || text(message.kind);
    if (type === "text_delta") {
      const delta = rawText(event.delta) ?? rawText(event.text) ?? rawText(message.delta);
      if (delta) this.emitTextDelta(delta);
      return;
    }
    if (type === "thinking_delta" || type === "reasoning_delta") {
      const delta = rawText(event.delta) ?? rawText(event.thinking) ?? rawText(event.text);
      if (delta) this.appendPart(`${this.kind()}-reasoning`, "reasoning", delta);
      return;
    }
    if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
      const tool = genericToolEvent(event, type, this.toolOutputs);
      if (tool) this.emitTool(tool);
      return;
    }
    if (type === "error")
      this.emitAspError(text(event.reason) || text(event.message) || "CLI stream error.");
  }

  private handleControlRequest(message: Record<string, unknown>): void {
    const request = record(message.request);
    const requestId = text(message.request_id) || text(message.requestId) || text(message.id);
    if (!requestId) return;
    const toolName = text(request.tool_name) || text(request.toolName) || text(request.name);
    const subtype = text(request.subtype) || text(request.type);
    const scope = runtimeApprovalScope({ ...request, toolName }, "tool");
    if (subtype.includes("tool") || subtype.includes("permission") || subtype.includes("approve")) {
      const automatic = runtimeAutomaticApproval(this.lastApprovalMode(), scope, toolName);
      if (automatic) {
        this.writeControlResponse(requestId, approvalControlResponse(automatic));
        return;
      }
      this.pendingControlRequests.set(requestId, message);
      this.emitMessage({
        id: requestId,
        method: "approval_request",
        params: {
          method: `${this.kind()}.cli.approval`,
          options: ["allow", "allow-session", "deny", "cancel"],
          params: message,
          scope,
          title: text(request.title) || toolName || "Approve CLI tool use",
        },
      });
      return;
    }
    this.pendingControlRequests.set(requestId, message);
    this.emitMessage({
      id: requestId,
      method: "question_request",
      params: {
        method: `${this.kind()}.cli.input`,
        params: message,
        question:
          text(record(request.input).question) || text(request.question) || "CLI needs input",
        questions: record(request.input).questions,
        title: text(record(request.input).title) || text(request.title) || "CLI input",
      },
    });
  }

  private respondControlRequest(id: string, result: Record<string, unknown>): void {
    if (!this.pendingControlRequests.has(id)) return;
    this.pendingControlRequests.delete(id);
    const decision = normalizeDecision(result.decision);
    if (result.decision !== undefined) {
      this.writeControlResponse(id, approvalControlResponse(decision));
      return;
    }
    this.writeControlResponse(id, result.answers ?? result.value ?? result);
  }

  private writeControlResponse(requestId: string, response: unknown): void {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(
      `${JSON.stringify({
        type: "control_response",
        response: {
          request_id: requestId,
          response,
        },
      })}\n`,
    );
  }

  private abort(): void {
    if (this.runFinished) return;
    this.close();
    this.finishFromResult({ stopReason: "cancelled" }, false);
  }

  private finishWithError(error: unknown): void {
    this.emitAspError(asError(error).message);
    this.finishFromResult({}, false);
  }

  private finishFromExit(success: boolean, exitCode: number | undefined): void {
    if (this.runFinished) return;
    if (!success) {
      const diagnostic =
        sanitizeCliDiagnostic(this.stderrText || this.stdoutText) ||
        `${this.input.provider.name} CLI exited with code ${exitCode ?? "unknown"}.`;
      this.emitAspError(diagnostic);
    } else if (!this.hasTextOutput() && this.stdoutText.trim()) {
      this.setPart(`${this.kind()}-stdout`, "text", stripAnsi(this.stdoutText).trim());
    }
    this.finishFromResult({ durationMs: Date.now() - this.startedAt }, success, exitCode);
  }

  private finishFromResult(result: unknown, success: boolean, exitCode = success ? 0 : 1): void {
    if (this.runFinished) return;
    const source = record(result);
    const finalText = cliResultText(result);
    if (finalText && !this.hasTextOutput()) {
      this.setPart(`${this.kind()}-result`, "text", finalText);
    }
    const usage = normalizeUsage(result);
    if (usage) this.emitUsage(usage);
    this.runFinished = true;
    const message = this.messageRecord();
    if (message.content) this.messagesPush(message);
    this.emitSessionState();
    this.emitMessage({
      type: "run_finished",
      runId: this.runId,
      providerSessionId: this.sessionId || undefined,
      durationMs:
        positiveInteger(source.durationMs ?? source.duration_ms) ?? Date.now() - this.startedAt,
      exitCode,
      success,
      usage: usage ?? this.lastUsage,
    });
  }

  private messagesPush(message: ReturnType<HeadlessCliRuntimeConnection["messageRecord"]>): void {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) this.messages[index] = message;
    else this.messages.push(message);
  }

  private readonly messages: Array<{
    id: string;
    role: "assistant";
    content: string;
    createdAt: number;
    parts?: AspMessagePart[];
    toolEvents?: AspToolEvent[];
    usage?: ReturnType<typeof normalizeUsage>;
    metadata?: Record<string, unknown>;
  }> = [];

  private emitTextDelta(delta: string): void {
    this.deltaText += delta;
    this.emitMessage({
      type: "message_delta",
      runId: this.runId,
      data: delta,
      providerSessionId: this.sessionId || undefined,
    });
  }

  private appendPart(id: string, type: "reasoning" | "text", delta: string): void {
    const content = `${this.textParts.get(id) ?? ""}${delta}`;
    this.setPart(id, type, content);
  }

  private setPart(id: string, type: "reasoning" | "text", content: string): void {
    this.textParts.set(id, content);
    this.emitPart({ id, type, content, metadata: { source: this.kind() } } as AspMessagePart);
  }

  private emitPart(part: AspMessagePart): void {
    const index = this.messageParts.findIndex((item) => item.id === part.id);
    if (index >= 0) this.messageParts[index] = part;
    else this.messageParts.push(part);
    this.emitMessage({
      type: "message_part",
      runId: this.runId,
      part,
      providerSessionId: this.sessionId || undefined,
    });
  }

  private emitTool(toolEvent: AspToolEvent): void {
    if (toolEvent.name) this.toolNames.set(toolEvent.id, toolEvent.name);
    const index = this.tools.findIndex((tool) => tool.id === toolEvent.id);
    if (index >= 0) this.tools[index] = { ...this.tools[index], ...toolEvent };
    else this.tools.push(toolEvent);
    this.emitMessage({
      type: "tool_event",
      runId: this.runId,
      toolEvent,
      providerSessionId: this.sessionId || undefined,
    });
  }

  private emitUsageIfPresent(value: unknown): void {
    const usage = normalizeUsage(value) ?? normalizeUsage(record(value).usage);
    if (usage) this.emitUsage(usage);
  }

  private emitUsage(usage: ReturnType<typeof normalizeUsage>): void {
    if (!usage) return;
    this.lastUsage = usage;
    this.emitMessage({
      type: "usage",
      runId: this.runId,
      usage,
      providerSessionId: this.sessionId || undefined,
    });
  }

  private updateSessionState(value: unknown): void {
    const state = cliSessionState(value, this.input.cwd, this.kind(), this.sessionId);
    if (!state) return;
    if (state.providerSessionId) this.sessionId = state.providerSessionId;
    if (state.title) this.sessionTitle = state.title;
    this.emitSessionState();
  }

  private emitSessionState(): void {
    const state = this.sessionState();
    if (!state.providerSessionId && !state.title) return;
    this.emitMessage({
      type: "session_state",
      runId: this.runId,
      state,
      providerSessionId: this.sessionId || undefined,
    });
  }

  private sessionState(): AspSessionState {
    const model = text(this.lastRun.model);
    const effort = text(this.lastRun.effort);
    return {
      providerSessionId: this.sessionId || undefined,
      title: this.sessionTitle || undefined,
      cwd: this.input.cwd,
      model: model || undefined,
      effort: effort || undefined,
      streaming: this.runFinished ? false : undefined,
      context: this.lastUsage
        ? {
            usedTokens: this.lastUsage.contextTokens || this.lastUsage.totalTokens,
            windowTokens: this.lastUsage.contextWindowTokens,
          }
        : undefined,
      metadata: {
        adapter: this.kind() === "kimi" ? "kimi-cli" : "grok-cli",
        ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      },
    };
  }

  private messageRecord() {
    const content =
      this.messageParts
        .map((part) => (part.type === "text" ? (part.content ?? "") : ""))
        .filter(Boolean)
        .join("") || this.deltaText;
    return {
      id: `${this.kind()}-${this.sessionId || "session"}-message`,
      role: "assistant" as const,
      content,
      createdAt: Date.now(),
      parts: this.messageParts.length ? [...this.messageParts] : undefined,
      toolEvents: this.tools.length ? [...this.tools] : undefined,
      usage: this.lastUsage,
      metadata: { providerSessionId: this.sessionId || undefined },
    };
  }

  private hasTextOutput(): boolean {
    return (
      Boolean(this.deltaText) ||
      this.messageParts.some((part) => part.type === "text" && Boolean(part.content))
    );
  }

  private textOutput(): string {
    return this.messageParts
      .map((part) => (part.type === "text" ? (part.content ?? "") : ""))
      .filter(Boolean)
      .join("");
  }

  private nextMessageKey(): string {
    return `${this.kind()}-message-${++this.messageSequence}`;
  }

  private messageKey(message: Record<string, unknown>): string {
    return text(message.id) || text(message.message_id) || text(message.messageId);
  }

  private ensureMessageKey(): string {
    if (!this.currentMessageKey) this.currentMessageKey = this.nextMessageKey();
    return this.currentMessageKey;
  }

  private partId(
    kind: "reasoning" | "text",
    index: number | undefined,
    explicitId?: unknown,
  ): string {
    return (
      text(explicitId) ||
      `${this.ensureMessageKey()}-${kind}-${index === undefined || index < 0 ? "unknown" : index}`
    );
  }

  private emitAspError(message: string): void {
    const sanitized = sanitizeCliDiagnostic(message);
    if (!sanitized) return;
    this.emitMessage({
      type: "error",
      runId: this.runId,
      message: sanitized,
      providerSessionId: this.sessionId || undefined,
    });
  }

  private lastApprovalMode(): string {
    return text(this.lastRun.approvalMode) || "suggest";
  }
}

export function normalizeGrokCliArgs(args: string[], run: Record<string, unknown>): string[] {
  const output = [...args.map(String)];
  const model = text(run.model);
  if (model && model !== "default" && !hasOption(output, "--model") && !hasOption(output, "-m")) {
    output.push("--model", model);
  }
  const sessionId = text(run.providerSessionId);
  if (sessionId && !hasPromptOption(output, ["-r", "--resume", "-c", "--continue"])) {
    output.push("--resume", sessionId);
  }
  const effort = normalizeHeadlessEffort(text(run.effort));
  if (effort && !hasOption(output, "--reasoning-effort") && !hasOption(output, "--effort")) {
    output.push("--reasoning-effort", effort);
  }
  if (!hasOption(output, "--permission-mode")) {
    output.push("--permission-mode", grokPermissionMode(text(run.approvalMode)));
  }
  if (!hasOption(output, "--output-format")) {
    output.push("--output-format", "streaming-messages-json");
  }
  if (!output.includes("--include-partial-messages")) output.push("--include-partial-messages");
  if (!hasPromptOption(output, ["-p", "--single", "--prompt-file", "--prompt-json"])) {
    output.push("-p", cliPrompt(run));
  }
  return output;
}

export function normalizeKimiCliArgs(args: string[], run: Record<string, unknown>): string[] {
  const output = normalizeKimiPromptArgs(normalizeKimiBaseArgs(args));
  const model = text(run.model);
  if (model && model !== "default" && !hasOption(output, "--model") && !hasOption(output, "-m")) {
    output.push("--model", model);
  }
  const approvalMode = normalizeRuntimeApprovalMode(text(run.approvalMode));
  if (approvalMode === "full" && !output.includes("--auto")) output.push("--auto");
  const sessionId = text(run.providerSessionId);
  if (sessionId && !hasPromptOption(output, ["-S", "--session", "-c", "--continue"])) {
    output.push("--session", sessionId);
  }
  if (!hasOption(output, "--output-format")) output.push("--output-format", "stream-json");
  if (!hasPromptOption(output, ["-p", "--prompt"])) output.push("-p", cliPrompt(run));
  for (const directory of directoryAttachments(run)) {
    output.push("--add-dir", directory);
  }
  return output;
}

function normalizeKimiPromptArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "--yolo" && arg !== "-y");
}

export function headlessCliCapabilities(
  kind: HeadlessCliKind,
  capabilities: AspProviderCapabilities | undefined,
): AspProviderCapabilities {
  const runtimeAdapter = kind === "kimi" ? "kimi-cli" : "grok-cli";
  const wireProtocol = kind === "kimi" ? "kimi-stream-json" : "grok-streaming-messages-json";
  return {
    ...nativeAdapterCapabilities({ ...(capabilities ?? {}), extensions: [] }),
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
    extensions: mergeExtensions(
      [],
      [
        ...compactExtensions([
          standardExtension("asp.ext.session-state", ["get_state", "get_messages"]),
          standardExtension("asp.ext.runtime", ["get_runtime"]),
        ]),
        {
          id: kind === "kimi" ? "vendor.kimi.cli" : "vendor.grok.cli",
          version: "0.1.0",
          stability: "vendor",
          fallback: "raw",
          events: [{ name: "native.event", payloadSchema: { type: "object" } }],
        },
      ],
    ),
    humanInput: true,
    deleteSession: true,
    models: true,
    reasoningEfforts: capabilities?.reasoningEfforts ?? [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
    resumeSession: true,
    runtimeAdapter,
    sessionHistory: true,
    sessions: true,
    toolEvents: true,
    transports: ["stdio"],
    wireProtocol,
    workspace: true,
  };
}

function headlessCliKind(
  provider: Pick<AspProvider, "capabilities" | "command" | "id" | "name">,
): HeadlessCliKind {
  const signals = [
    provider.capabilities?.runtimeAdapter,
    provider.capabilities?.wireProtocol,
    provider.id,
    provider.name,
    provider.command,
  ].map((value) => String(value ?? "").toLowerCase());
  return signals.some((value) => value.includes("kimi")) ? "kimi" : "grok";
}

function headlessSessionSnapshots(
  kind: HeadlessCliKind,
  input: {
    cwd: string;
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
): HeadlessSessionSnapshot[] {
  const snapshots: HeadlessSessionSnapshot[] = [];
  const seen = new Set<string>();
  for (const root of headlessSessionRoots(kind, input)) {
    for (const directory of headlessSessionDirectories(root)) {
      const snapshot = headlessSessionSnapshot(directory, kind, input.provider.id);
      if (!snapshot || seen.has(snapshot.session.id)) continue;
      seen.add(snapshot.session.id);
      snapshots.push(snapshot);
    }
  }
  return snapshots.sort(
    (left, right) => (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0),
  );
}

function headlessSessionSnapshotForSession(
  kind: HeadlessCliKind,
  input: {
    cwd: string;
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
  sessionId: string,
): HeadlessSessionSnapshot | undefined {
  const expected = expandHome(sessionId);
  if (!expected) return undefined;
  return headlessSessionSnapshots(kind, input).find((snapshot) =>
    snapshot.aliases.some((alias) => headlessSessionAliasMatches(alias, expected)),
  );
}

function deleteHeadlessSession(
  kind: HeadlessCliKind,
  input: {
    cwd: string;
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
  sessionId: string,
  transcriptPath: string,
): boolean {
  const snapshot = sessionId
    ? headlessSessionSnapshotForSession(kind, input, sessionId)
    : undefined;
  const directory =
    snapshot?.directory ?? headlessSessionDirectoryFromPath(kind, input, transcriptPath);
  if (!directory || !headlessSessionDirectoryIsDeletable(kind, input, directory)) return false;
  fs.rmSync(directory, { force: true, recursive: true });
  return !safeStat(directory);
}

function headlessSessionDirectoryFromPath(
  kind: HeadlessCliKind,
  input: {
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
  sourcePath: string,
): string {
  const expanded = expandHome(sourcePath);
  if (!expanded) return "";
  const resolved = path.resolve(expanded);
  const stat = safeStat(resolved);
  let directory = stat?.isDirectory() ? resolved : path.dirname(resolved);
  for (let depth = 0; depth < 8; depth += 1) {
    if (headlessSessionDirectoryIsDeletable(kind, input, directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "";
}

function headlessSessionDirectoryIsDeletable(
  kind: HeadlessCliKind,
  input: {
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
  directory: string,
): boolean {
  const normalized = path.resolve(directory);
  return (
    safeStat(normalized)?.isDirectory() === true &&
    isHeadlessSessionDirectory(normalized) &&
    headlessSessionRoots(kind, input).some((root) => pathInsideOrEqual(root, normalized))
  );
}

function headlessSessionRoots(
  kind: HeadlessCliKind,
  input: {
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
): string[] {
  const env = runtimeEnvironment(input.provider.env, input.env, input.runEnvironment);
  const configured =
    kind === "kimi"
      ? [
          env.AGUI_KIMI_SESSIONS_DIR,
          env.KIMI_SESSIONS_DIR,
          env.KIMI_CODE_HOME ? path.join(env.KIMI_CODE_HOME, "sessions") : "",
          env.KIMI_HOME ? path.join(env.KIMI_HOME, "sessions") : "",
        ]
      : [
          env.AGUI_GROK_SESSIONS_DIR,
          env.GROK_SESSIONS_DIR,
          env.GROK_HOME ? path.join(env.GROK_HOME, "sessions") : "",
        ];
  const defaults =
    kind === "kimi"
      ? [
          path.join(os.homedir(), ".kimi-code", "sessions"),
          path.join(
            os.homedir(),
            ".claude-code-router",
            "profiles",
            "kimi-cli",
            "kimi",
            "sessions",
          ),
        ]
      : [path.join(os.homedir(), ".grok", "sessions")];
  return existingDirectories([
    ...configured.flatMap((value) => sessionRootCandidates(value)),
    ...defaults,
  ]);
}

function sessionRootCandidates(value: string | undefined): string[] {
  return pathList(value).flatMap((root) => [root, path.join(root, "sessions")]);
}

function pathList(value: string | undefined): string[] {
  return text(value)
    .split(path.delimiter)
    .map((item) => expandHome(item))
    .filter(Boolean);
}

function existingDirectories(candidates: string[]): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized) || !safeStat(normalized)?.isDirectory()) continue;
    seen.add(normalized);
    directories.push(normalized);
  }
  return directories;
}

function headlessSessionDirectories(root: string): string[] {
  const directories: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (directories.length >= HEADLESS_SESSION_SCAN_LIMIT) return;
    const entries = safeReaddir(directory);
    if (!entries.length) return;
    if (isHeadlessSessionDirectory(directory)) {
      directories.push(directory);
      return;
    }
    if (depth <= 0) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      visit(path.join(directory, entry.name), depth - 1);
      if (directories.length >= HEADLESS_SESSION_SCAN_LIMIT) return;
    }
  };
  visit(root, 4);
  return directories;
}

function isHeadlessSessionDirectory(directory: string): boolean {
  return [
    "summary.json",
    "state.json",
    "session.json",
    "messages.jsonl",
    "chat_history.jsonl",
    path.join("agents", "main", "wire.jsonl"),
  ].some((name) => safeStat(path.join(directory, name))?.isFile());
}

function headlessSessionSnapshot(
  directory: string,
  kind: HeadlessCliKind,
  providerId: string,
): HeadlessSessionSnapshot | null {
  const summary = headlessSessionSummary(directory, kind);
  const info = record(summary.info);
  const id =
    text(summary.sessionId) ||
    text(summary.session_id) ||
    text(summary.id) ||
    text(info.id) ||
    path.basename(directory);
  if (!id) return null;
  const messages = headlessSessionMessages(directory, kind, summary);
  const stat = safeStat(directory);
  const cwd =
    text(summary.cwd) ||
    text(summary.workDir) ||
    text(summary.work_dir) ||
    text(info.cwd) ||
    headlessProjectPathFromDirectory(directory, kind);
  const createdAt =
    timestampMs(summary.createdAt ?? summary.created_at ?? info.createdAt ?? info.created_at) ??
    stat?.birthtimeMs ??
    stat?.mtimeMs;
  const updatedAt =
    timestampMs(
      summary.updatedAt ??
        summary.updated_at ??
        summary.lastActiveAt ??
        summary.last_active_at ??
        info.updatedAt ??
        info.updated_at,
    ) ??
    stat?.mtimeMs ??
    createdAt;
  const usage =
    normalizeUsage(summary) ?? normalizeUsage(summary.usage) ?? normalizeUsage(info.usage);
  const title =
    compactHistoryTitle(
      text(summary.title) ||
        text(summary.session_summary) ||
        text(summary.summary) ||
        text(summary.lastPrompt) ||
        text(summary.last_prompt) ||
        headlessTitleFromMessages(messages),
    ) || id;
  return {
    aliases: uniqueStrings([
      id,
      path.basename(directory),
      directory,
      text(summary.sessionDir),
      text(summary.session_dir),
      text(info.id),
      id.startsWith("session_") ? id.slice("session_".length) : "",
    ]),
    directory,
    messages,
    session: {
      id,
      title,
      context: usage
        ? {
            usedTokens: usage.contextTokens || usage.totalTokens,
            windowTokens: usage.contextWindowTokens,
          }
        : undefined,
      createdAt,
      updatedAt,
      cwd: cwd || undefined,
      projectPath: cwd || undefined,
      projectName: cwd ? path.basename(cwd) : undefined,
      model:
        text(summary.model) ||
        text(summary.currentModelId) ||
        text(summary.current_model_id) ||
        text(info.model) ||
        undefined,
      providerId,
      usage,
      metadata: {
        source: kind,
        sessionDir: directory,
      },
    },
  };
}

function headlessSessionSummary(directory: string, kind: HeadlessCliKind): Record<string, unknown> {
  const files =
    kind === "kimi"
      ? ["state.json", "summary.json", "session.json"]
      : ["summary.json", "state.json", "session.json"];
  for (const file of files) {
    const value = readJsonFile(path.join(directory, file));
    if (Object.keys(value).length) return value;
  }
  return {};
}

function headlessSessionMessages(
  directory: string,
  kind: HeadlessCliKind,
  summary: Record<string, unknown>,
): AspMessageRecord[] {
  const direct = headlessHistoryMessagesFromValue(
    summary.messages ?? summary.history ?? record(summary.conversation).messages,
    kind,
    path.join(directory, kind === "kimi" ? "state.json" : "summary.json"),
  );
  if (direct.length) return direct;
  const files =
    kind === "kimi"
      ? [
          "messages.jsonl",
          path.join("agents", "main", "wire.jsonl"),
          "chat_history.jsonl",
          "events.jsonl",
          "updates.jsonl",
        ]
      : ["messages.jsonl", "chat_history.jsonl", "events.jsonl", "updates.jsonl"];
  for (const file of files) {
    const messages = headlessHistoryMessagesFromJsonLines(path.join(directory, file), kind);
    if (messages.length) return messages;
  }
  const prompt = text(summary.lastPrompt) || text(summary.last_prompt) || text(summary.prompt);
  return prompt
    ? [
        {
          id: `${kind}-${path.basename(directory)}-prompt`,
          role: "user",
          content: prompt,
          createdAt: timestampMs(summary.createdAt ?? summary.created_at) ?? Date.now(),
          metadata: { providerSessionId: path.basename(directory), source: kind },
        },
      ]
    : [];
}

function headlessHistoryMessagesFromValue(
  value: unknown,
  kind: HeadlessCliKind,
  sourcePath: string,
): AspMessageRecord[] {
  return array(value)
    .map((item, index) => headlessHistoryMessage(item, index, kind, sourcePath))
    .filter((message): message is AspMessageRecord => Boolean(message));
}

function headlessHistoryMessagesFromJsonLines(
  filePath: string,
  kind: HeadlessCliKind,
): AspMessageRecord[] {
  if (!safeStat(filePath)?.isFile()) return [];
  return safeReadText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => tryJson(line))
    .flatMap((value, index) => {
      if (Array.isArray(value)) return headlessHistoryMessagesFromValue(value, kind, filePath);
      const message = headlessHistoryMessage(value, index, kind, filePath);
      return message ? [message] : [];
    });
}

function headlessHistoryMessage(
  value: unknown,
  index: number,
  kind: HeadlessCliKind,
  sourcePath: string,
): AspMessageRecord | null {
  const source = record(value);
  const type = text(source.type);
  if (type === "context.append_loop_event") {
    return kimiLoopEventHistoryMessage(source, index, kind, sourcePath);
  }
  if (
    !Object.keys(source).length ||
    type === "metadata" ||
    type === "config.update" ||
    type === "tools.set_active_tools" ||
    type === "system"
  ) {
    return null;
  }
  const nested = record(source.message);
  let message: Record<string, unknown> = source;
  let role = historyRole(text(source.role)) || historyRole(type);
  if (type === "context.append_message" && Object.keys(nested).length) {
    message = nested;
    role = historyRole(text(nested.role));
    const origin = text(record(nested.origin).kind) || text(record(source.origin).kind);
    if (role === "user" && origin && origin !== "user") return null;
  } else if (Object.keys(nested).length) {
    message = { ...source, ...nested };
    role = role || historyRole(text(nested.role));
  }
  if (!role) return null;
  const content = historyContentText(
    message.content ?? message.text ?? message.delta ?? source.content ?? source.text,
  ).trim();
  if (!content || isInternalHistoryContent(content)) return null;
  const id =
    text(message.id) ||
    text(source.id) ||
    `${kind}-history-${path.basename(sourcePath).replace(/[^A-Za-z0-9_-]+/g, "-")}-${index}`;
  return {
    id,
    role,
    content,
    createdAt:
      timestampMs(
        message.createdAt ??
          message.created_at ??
          source.createdAt ??
          source.created_at ??
          source.time ??
          source.ts,
      ) ?? Date.now(),
    parts:
      role === "assistant"
        ? [
            {
              id: `${id}-text`,
              type: "text",
              content,
              metadata: { source: kind },
            },
          ]
        : undefined,
    usage: normalizeUsage(message) ?? normalizeUsage(source) ?? undefined,
    metadata: {
      providerSessionId: providerSessionIdFromSourcePath(sourcePath),
      source: kind,
      transcriptPath: sourcePath,
    },
  };
}

function kimiLoopEventHistoryMessage(
  source: Record<string, unknown>,
  index: number,
  kind: HeadlessCliKind,
  sourcePath: string,
): AspMessageRecord | null {
  const event = record(source.event);
  const part = record(event.part);
  if (text(part.type) !== "text") return null;
  const content = historyContentText(part.text ?? part.content).trim();
  if (!content || isInternalHistoryContent(content)) return null;
  const id =
    text(part.id) ||
    text(event.uuid) ||
    `${kind}-history-${path.basename(sourcePath).replace(/[^A-Za-z0-9_-]+/g, "-")}-${index}`;
  return {
    id,
    role: "assistant",
    content,
    createdAt: timestampMs(source.time ?? source.ts) ?? Date.now(),
    parts: [{ id: `${id}-text`, type: "text", content, metadata: { source: kind } }],
    metadata: {
      providerSessionId: providerSessionIdFromSourcePath(sourcePath),
      source: kind,
      transcriptPath: sourcePath,
    },
  };
}

function providerSessionIdFromSourcePath(sourcePath: string): string {
  const segments = sourcePath.split(path.sep);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    if (segment.match(/^session[_-]/) || segment.match(/^[0-9a-f-]{16,}$/i)) return segment;
  }
  return path.basename(path.dirname(sourcePath));
}

function historyRole(value: string): AspMessageRecord["role"] | undefined {
  if (value === "assistant" || value === "user") return value;
  return undefined;
}

function historyContentText(value: unknown): string {
  if (typeof value === "string" || Array.isArray(value)) return contentText(value);
  const source = record(value);
  const nested = source.content;
  if (typeof nested === "string" || Array.isArray(nested)) return contentText(nested);
  return rawText(source.text) ?? rawText(source.delta) ?? "";
}

function isInternalHistoryContent(value: string): boolean {
  const trimmed = value.trimStart();
  return (
    trimmed.startsWith("<system-reminder>") ||
    (trimmed.includes("<user_info>") && trimmed.includes("<git_status>"))
  );
}

function headlessTitleFromMessages(messages: AspMessageRecord[]): string {
  return compactHistoryTitle(
    messages.find((message) => message.role === "user" && message.content)?.content ||
      messages.find((message) => message.content)?.content ||
      "",
  );
}

function compactHistoryTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function headlessProjectPathFromDirectory(directory: string, kind: HeadlessCliKind): string {
  if (kind !== "grok") return "";
  const encoded = path.basename(path.dirname(directory));
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function headlessSessionAliasMatches(alias: string, expected: string): boolean {
  if (alias === expected) return true;
  return (
    path.isAbsolute(alias) &&
    path.isAbsolute(expected) &&
    path.resolve(alias) === path.resolve(expected)
  );
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const content = safeReadText(filePath);
  if (!content) return {};
  try {
    return record(JSON.parse(content) as unknown);
  } catch {
    return {};
  }
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function safeReaddir(directory: string) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function pathInsideOrEqual(parent: string, child: string): boolean {
  const parentPath = safeRealpath(parent) ?? path.resolve(parent);
  const childPath = safeRealpath(child) ?? path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function safeRealpath(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  }
  const raw = rawText(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function queryGrokModels(input: {
  cwd: string;
  env?: Record<string, string>;
  provider: AspProvider;
  runEnvironment?: Record<string, string | undefined>;
}): Promise<AspModel[]> {
  const output = await runCliOneShot(input, [...input.provider.args, "models"]);
  return mergeGrokModelMetadata(grokModelsFromOutput(output), grokModelsFromCache(input));
}

async function queryKimiModels(input: {
  cwd: string;
  env?: Record<string, string>;
  provider: AspProvider;
  runEnvironment?: Record<string, string | undefined>;
}): Promise<AspModel[]> {
  const output = await runCliOneShot(input, [
    ...normalizeKimiBaseArgs(input.provider.args),
    "provider",
    "list",
    "--json",
  ]);
  return kimiModelsFromProviderList(output, kimiConfiguredDefaultReasoningEffort(input));
}

function normalizeKimiBaseArgs(args: string[]): string[] {
  const output = [...args.map(String)];
  const [first] = output;
  return first?.trim().toLowerCase() === "acp" ? output.slice(1) : output;
}

function runCliOneShot(
  input: {
    cwd: string;
    env?: Record<string, string>;
    provider: AspProvider;
    runEnvironment?: Record<string, string | undefined>;
  },
  args: string[],
): Promise<string> {
  const commandParts = splitProviderCommand(input.provider.command);
  const command = expandHome(commandParts[0] ?? "");
  if (!command)
    return Promise.reject(new Error(`${input.provider.name} provider command is empty.`));
  const env = runtimeEnvironment(input.provider.env, input.env, input.runEnvironment);
  ensureProviderCli(input.provider, input.cwd, env);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...commandParts.slice(1), ...args], {
      cwd: input.cwd,
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
      reject(new Error(`${input.provider.name} model discovery timed out.`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
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
      const output = [stdout, stderr].filter(Boolean).join("\n");
      if (exitCode === 0) resolve(output);
      else reject(new Error(sanitizeCliDiagnostic(output) || `Command exited with ${exitCode}.`));
    });
  });
}

function cliPrompt(run: Record<string, unknown>): string {
  return [promptWithDeveloperInstructions(run), cliInputReferences(run)]
    .filter(Boolean)
    .join("\n\n");
}

function cliInputReferences(run: Record<string, unknown>): string {
  const refs = [
    ...array(run.attachments).map((attachment) => {
      const source = record(attachment);
      const pathValue = text(source.path);
      return pathValue ? `${text(source.kind) || "file"}: ${pathValue}` : "";
    }),
    ...array(run.inputParts ?? record(run.input).parts).flatMap((part) => {
      const source = record(part);
      if (text(source.type) === "file_ref" || text(source.type) === "directory_ref") {
        return text(source.path) ? [`${text(source.type)}: ${text(source.path)}`] : [];
      }
      if (text(source.type) === "uri") {
        return text(source.uri) ? [`uri: ${text(source.uri)}`] : [];
      }
      return [];
    }),
  ].filter(Boolean);
  return refs.length ? `Input references:\n${refs.map((item) => `- ${item}`).join("\n")}` : "";
}

function directoryAttachments(run: Record<string, unknown>): string[] {
  return [
    ...array(run.attachments).flatMap((attachment) => {
      const source = record(attachment);
      return text(source.kind) === "directory" && text(source.path) ? [text(source.path)] : [];
    }),
    ...array(run.inputParts ?? record(run.input).parts).flatMap((part) => {
      const source = record(part);
      return text(source.type) === "directory_ref" && text(source.path) ? [text(source.path)] : [];
    }),
  ];
}

function hasPromptOption(args: string[], options: string[]): boolean {
  return options.some((option) => hasOption(args, option));
}

function grokPermissionMode(mode: string): string {
  const normalized = normalizeRuntimeApprovalMode(mode);
  if (normalized === "full") return "bypassPermissions";
  if (normalized === "auto") return "acceptEdits";
  return "default";
}

function normalizeHeadlessEffort(value: string): AspReasoningEffort | undefined {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const raw = compact.endsWith("effort") ? compact.slice(0, -"effort".length) : compact;
  const normalized = raw === "off" ? "none" : raw === "extrahigh" ? "xhigh" : raw;
  return HEADLESS_REASONING_EFFORTS.has(normalized as AspReasoningEffort)
    ? (normalized as AspReasoningEffort)
    : undefined;
}

function grokModelsFromOutput(output: string): AspModel[] {
  const cleaned = stripAnsi(output);
  const defaultModel = text(cleaned.match(/Default model:\s*([^\n]+)/i)?.[1]);
  const models: AspModel[] = [];
  let inList = false;
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Available models:/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const match = line.match(/^[-*]\s+(.+?)(?:\s+\(default\))?$/);
    if (!match) continue;
    const model = text(match[1]?.replace(/\s+\(default\)$/i, ""));
    if (!model) continue;
    models.push({
      id: model,
      model,
      displayName: model,
      isDefault: model === defaultModel || /\(default\)$/i.test(line),
    });
  }
  return uniqueModels(models);
}

function grokModelsFromCache(input: {
  env?: Record<string, string>;
  provider: AspProvider;
  runEnvironment?: Record<string, string | undefined>;
}): AspModel[] {
  const env = runtimeEnvironment(input.provider.env, input.env, input.runEnvironment);
  const defaultEffort = grokConfiguredDefaultReasoningEffort(env);
  for (const home of grokHomeCandidates(env)) {
    const models = grokModelsFromCacheRecord(
      readJsonFile(path.join(home, "models_cache.json")),
      defaultEffort,
    );
    if (models.length) return models;
  }
  return [];
}

function grokHomeCandidates(env: Record<string, string | undefined>): string[] {
  return uniqueStrings([...pathList(env.GROK_HOME), path.join(os.homedir(), ".grok")]);
}

function grokModelsFromCacheRecord(
  cache: Record<string, unknown>,
  configuredDefaultEffort: AspReasoningEffort | undefined,
): AspModel[] {
  const result = record(cache.result);
  const rawModels = cache.models ?? cache.data ?? result.models ?? result.data;
  const entries = Array.isArray(rawModels)
    ? rawModels.map((item) => [undefined, item] as const)
    : Object.entries(record(rawModels));
  return uniqueModels(
    entries
      .map(([key, value]) => grokModelFromCacheEntry(key, value, configuredDefaultEffort))
      .filter((model): model is AspModel => Boolean(model)),
  );
}

function grokModelFromCacheEntry(
  key: string | undefined,
  value: unknown,
  configuredDefaultEffort: AspReasoningEffort | undefined,
): AspModel | null {
  const wrapper = record(value);
  const info = Object.keys(record(wrapper.info)).length ? record(wrapper.info) : wrapper;
  const id =
    text(info.id) || text(wrapper.id) || text(key) || text(info.model) || text(wrapper.model);
  const model = text(info.model) || text(wrapper.model) || id;
  if (!id || !model) return null;
  const efforts =
    headlessModelReasoningEfforts(info) ??
    headlessModelReasoningEfforts(wrapper) ??
    (headlessModelSupportsReasoning(info) === false ||
    headlessModelSupportsReasoning(wrapper) === false
      ? ["none"]
      : undefined);
  const defaultReasoningEffort =
    headlessModelDefaultReasoningEffort(info) ??
    headlessModelDefaultReasoningEffort(wrapper) ??
    grokConfiguredDefaultForModel(efforts, configuredDefaultEffort) ??
    null;
  return {
    id,
    model,
    displayName:
      text(info.displayName) ||
      text(info.display_name) ||
      text(info.name) ||
      text(wrapper.displayName) ||
      text(wrapper.display_name) ||
      text(wrapper.name) ||
      model,
    hidden: info.hidden === true || wrapper.hidden === true,
    contextWindowTokens: positiveInteger(
      info.contextWindowTokens ??
        info.context_window_tokens ??
        info.contextWindow ??
        info.context_window ??
        info.maxContextSize ??
        info.max_context_size ??
        wrapper.contextWindowTokens ??
        wrapper.context_window_tokens ??
        wrapper.contextWindow ??
        wrapper.context_window ??
        wrapper.maxContextSize ??
        wrapper.max_context_size,
    ),
    defaultReasoningEffort,
    supportedReasoningEfforts: efforts,
  };
}

function mergeGrokModelMetadata(listed: AspModel[], cached: AspModel[]): AspModel[] {
  if (!listed.length) return cached.filter((model) => !model.hidden);
  if (!cached.length) return listed;
  const cachedByKey = new Map<string, AspModel>();
  for (const model of cached) {
    for (const key of grokModelLookupKeys(model)) cachedByKey.set(key, model);
  }
  return uniqueModels(
    listed.map((model) => {
      const cachedModel = grokModelLookupKeys(model)
        .map((key) => cachedByKey.get(key))
        .find((item): item is AspModel => Boolean(item));
      if (!cachedModel) return model;
      return {
        ...model,
        displayName: cachedModel.displayName || model.displayName,
        contextWindowTokens: cachedModel.contextWindowTokens ?? model.contextWindowTokens,
        defaultReasoningEffort:
          cachedModel.defaultReasoningEffort !== undefined
            ? cachedModel.defaultReasoningEffort
            : model.defaultReasoningEffort,
        supportedReasoningEfforts: cachedModel.supportedReasoningEfforts?.length
          ? cachedModel.supportedReasoningEfforts
          : model.supportedReasoningEfforts,
      };
    }),
  );
}

function grokModelLookupKeys(model: AspModel): string[] {
  return uniqueStrings(
    [model.id, model.model, model.displayName].map((value) => text(value).trim().toLowerCase()),
  );
}

function headlessModelReasoningEfforts(
  source: Record<string, unknown>,
): AspReasoningEffort[] | undefined {
  const efforts = reasoningEfforts(
    source.supportedReasoningEfforts ??
      source.supported_reasoning_efforts ??
      source.reasoningEfforts ??
      source.reasoning_efforts ??
      source.supportEfforts ??
      source.support_efforts ??
      source.thinkingLevels ??
      source.thinking_levels,
  );
  if (efforts.length) return efforts;
  return headlessModelSupportsReasoning(source) === false ? ["none"] : undefined;
}

function headlessModelSupportsReasoning(source: Record<string, unknown>): boolean | undefined {
  return (
    booleanValue(source.supportsReasoningEffort ?? source.supports_reasoning_effort) ??
    booleanValue(source.supportsReasoning ?? source.supports_reasoning) ??
    booleanValue(source.reasoning) ??
    booleanValue(source.thinking)
  );
}

function headlessModelDefaultReasoningEffort(
  source: Record<string, unknown>,
): AspReasoningEffort | undefined {
  const explicit = normalizeHeadlessEffort(
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
  return defaultItem ? reasoningEffortValue(defaultItem) : undefined;
}

function grokConfiguredDefaultForModel(
  efforts: AspReasoningEffort[] | undefined,
  configuredDefaultEffort: AspReasoningEffort | undefined,
): AspReasoningEffort | undefined {
  if (!configuredDefaultEffort) return undefined;
  return !efforts?.length || efforts.includes(configuredDefaultEffort)
    ? configuredDefaultEffort
    : undefined;
}

function grokConfiguredDefaultReasoningEffort(
  env: Record<string, string | undefined>,
): AspReasoningEffort | undefined {
  const overlayEffort = grokDefaultReasoningEffortFromJson(text(env.GROK_CONFIG));
  if (overlayEffort) return overlayEffort;
  for (const home of grokHomeCandidates(env)) {
    const fileEffort = grokDefaultReasoningEffortFromToml(
      safeReadText(path.join(home, "config.toml")),
    );
    if (fileEffort) return fileEffort;
  }
  return undefined;
}

function grokDefaultReasoningEffortFromJson(value: string): AspReasoningEffort | undefined {
  if (!value) return undefined;
  try {
    const config = record(JSON.parse(value) as unknown);
    const models = record(config.models);
    return normalizeHeadlessEffort(
      text(models.defaultReasoningEffort ?? models.default_reasoning_effort),
    );
  } catch {
    return undefined;
  }
}

function grokDefaultReasoningEffortFromToml(value: string): AspReasoningEffort | undefined {
  let inModels = false;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/)?.[1]?.trim();
    if (section) {
      inModels = section === "models";
      continue;
    }
    if (!inModels) continue;
    const match = line.match(/^default_reasoning_effort\s*=\s*["']?([^"',\s]+)["']?/);
    const effort = normalizeHeadlessEffort(text(match?.[1]));
    if (effort) return effort;
  }
  return undefined;
}

function kimiModelsFromProviderList(
  output: string,
  configuredDefaultEffort: AspReasoningEffort | undefined,
): AspModel[] {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const parsed = record(JSON.parse(output.slice(start, end + 1)) as unknown);
  const defaultEffort =
    kimiDefaultReasoningEffortFromProviderList(parsed) ?? configuredDefaultEffort ?? "high";
  const models = record(parsed.models);
  return uniqueModels(
    Object.entries(models)
      .map(([id, value]): AspModel | null => {
        const source = record(value);
        const modelId = text(source.id) || id;
        if (!modelId) return null;
        const efforts = kimiModelReasoningEfforts(source, defaultEffort);
        return {
          id: modelId,
          model: modelId,
          displayName: text(source.displayName) || text(source.display_name) || modelId,
          contextWindowTokens: positiveInteger(source.maxContextSize ?? source.max_context_size),
          defaultReasoningEffort:
            headlessModelDefaultReasoningEffort(source) ??
            kimiConfiguredDefaultForModel(efforts, defaultEffort) ??
            null,
          supportedReasoningEfforts: efforts,
        };
      })
      .filter((item): item is AspModel => Boolean(item)),
  );
}

function kimiModelReasoningEfforts(
  source: Record<string, unknown>,
  defaultEffort: AspReasoningEffort,
): AspReasoningEffort[] | undefined {
  const efforts = headlessModelReasoningEfforts(source);
  if (efforts?.length) return efforts;
  const capabilities = kimiModelCapabilities(source);
  if (capabilities.has("no_thinking") || capabilities.has("disable_thinking")) return ["none"];
  if (capabilities.has("thinking") || capabilities.has("always_thinking")) return [defaultEffort];
  return undefined;
}

function kimiModelCapabilities(source: Record<string, unknown>): Set<string> {
  return new Set(array(source.capabilities).map((item) => text(item).trim().toLowerCase()));
}

function kimiConfiguredDefaultForModel(
  efforts: AspReasoningEffort[] | undefined,
  configuredDefaultEffort: AspReasoningEffort,
): AspReasoningEffort | undefined {
  return !efforts?.length || efforts.includes(configuredDefaultEffort)
    ? configuredDefaultEffort
    : undefined;
}

function kimiDefaultReasoningEffortFromProviderList(
  source: Record<string, unknown>,
): AspReasoningEffort | undefined {
  const thinking = record(source.thinking);
  return normalizeHeadlessEffort(
    text(
      source.defaultReasoningEffort ??
        source.default_reasoning_effort ??
        thinking.effort ??
        thinking.defaultEffort ??
        thinking.default_effort,
    ),
  );
}

function kimiConfiguredDefaultReasoningEffort(input: {
  env?: Record<string, string>;
  provider: AspProvider;
  runEnvironment?: Record<string, string | undefined>;
}): AspReasoningEffort | undefined {
  const env = runtimeEnvironment(input.provider.env, input.env, input.runEnvironment);
  const overlayEffort = kimiDefaultReasoningEffortFromJson(text(env.KIMI_CONFIG));
  if (overlayEffort) return overlayEffort;
  for (const home of kimiHomeCandidates(env)) {
    const fileEffort = kimiDefaultReasoningEffortFromToml(
      safeReadText(path.join(home, "config.toml")),
    );
    if (fileEffort) return fileEffort;
  }
  return undefined;
}

function kimiHomeCandidates(env: Record<string, string | undefined>): string[] {
  return uniqueStrings([
    ...pathList(env.KIMI_CODE_HOME),
    ...pathList(env.KIMI_HOME),
    path.join(os.homedir(), ".kimi-code"),
  ]);
}

function kimiDefaultReasoningEffortFromJson(value: string): AspReasoningEffort | undefined {
  if (!value) return undefined;
  try {
    const config = record(JSON.parse(value) as unknown);
    const thinking = record(config.thinking);
    return normalizeHeadlessEffort(
      text(thinking.effort ?? thinking.defaultEffort ?? thinking.default_effort),
    );
  } catch {
    return undefined;
  }
}

function kimiDefaultReasoningEffortFromToml(value: string): AspReasoningEffort | undefined {
  let inThinking = false;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/)?.[1]?.trim();
    if (section) {
      inThinking = section === "thinking";
      continue;
    }
    if (!inThinking) continue;
    const match = line.match(/^effort\s*=\s*["']?([^"',\s]+)["']?/);
    const effort = normalizeHeadlessEffort(text(match?.[1]));
    if (effort) return effort;
  }
  return undefined;
}

function reasoningEfforts(value: unknown): AspReasoningEffort[] {
  return [
    ...new Set(
      array(value)
        .map(reasoningEffortValue)
        .filter((item): item is AspReasoningEffort => Boolean(item)),
    ),
  ];
}

function reasoningEffortValue(value: unknown): AspReasoningEffort | undefined {
  if (typeof value === "string") return normalizeHeadlessEffort(value);
  const source = record(value);
  return normalizeHeadlessEffort(
    text(
      source.reasoningEffort ??
        source.reasoning_effort ??
        source.effort ??
        source.level ??
        source.value ??
        source.id ??
        source.label ??
        source.name,
    ),
  );
}

function uniqueModels(models: AspModel[]): AspModel[] {
  return [...new Map(models.map((model) => [model.model, model])).values()];
}

function cliSessionState(
  value: unknown,
  cwd: string,
  kind: HeadlessCliKind,
  fallbackSessionId: string,
): AspSessionState | undefined {
  const source = record(value);
  const message = record(source.message);
  const session = record(source.session ?? source.state ?? source.result);
  const providerSessionId =
    text(source.session_id) ||
    text(source.sessionId) ||
    text(source.thread_id) ||
    text(source.threadId) ||
    text(message.id) ||
    text(session.session_id) ||
    text(session.sessionId) ||
    text(session.id) ||
    fallbackSessionId;
  const title =
    text(source.session_title) ||
    text(source.sessionTitle) ||
    text(source.title) ||
    text(session.title) ||
    text(session.name);
  const model = text(source.model) || text(message.model) || text(session.model);
  const usage =
    normalizeUsage(value) ?? normalizeUsage(source.usage) ?? normalizeUsage(session.usage);
  if (!providerSessionId && !title && !model && !usage) return undefined;
  return {
    providerSessionId: providerSessionId || undefined,
    title: title || undefined,
    cwd: text(source.cwd) || text(session.cwd) || cwd,
    model: model || undefined,
    context: usage
      ? {
          usedTokens: usage.contextTokens || usage.totalTokens,
          windowTokens: usage.contextWindowTokens,
        }
      : undefined,
    metadata: { source: kind },
  };
}

function cliText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return (
    rawText(message.text) ??
    rawText(message.delta) ??
    rawText(message.message) ??
    rawText(record(content).text) ??
    rawText(record(content).delta) ??
    contentText(content)
  );
}

function cliResultText(value: unknown): string {
  const source = record(value);
  const message = record(source.message);
  return (
    rawText(source.result) ??
    rawText(source.text) ??
    rawText(source.output) ??
    rawText(source.content) ??
    rawText(message.text) ??
    rawText(message.content) ??
    ""
  );
}

function cliPlanPart(message: Record<string, unknown>, kind: HeadlessCliKind): AspMessagePart {
  const items = array(message.entries ?? message.items)
    .map((item) =>
      typeof item === "string" ? item : text(record(item).title) || text(record(item).text),
    )
    .filter(Boolean);
  return {
    id: text(message.id) || `${kind}-plan`,
    items,
    content: rawText(message.content) ?? rawText(message.text) ?? undefined,
    metadata: { source: kind },
    title: text(message.title) || "Plan",
    type: "plan",
  };
}

function anthropicToolEvent(
  block: Record<string, unknown>,
  parentId: string,
  phase: AspToolEvent["phase"],
  kind: HeadlessCliKind,
): AspToolEvent {
  const name = text(block.name) || "Tool call";
  return {
    id: text(block.id) || `${kind}-tool-${Date.now()}`,
    input: block.input,
    kind: text(block.type) || "tool_use",
    name,
    parentId: parentId || undefined,
    phase,
    semantic: toolSemanticFromName(name),
    status: phase === "completed" ? "completed" : "inProgress",
    metadata: { source: kind },
  };
}

function genericToolEvent(
  event: Record<string, unknown>,
  type: string,
  outputs: Map<string, string>,
): AspToolEvent | null {
  const tool = record(
    event.toolExecution ?? event.tool_execution ?? event.toolCall ?? event.tool ?? event,
  );
  const id =
    text(tool.id) ||
    text(event.toolCallId) ||
    text(event.tool_call_id) ||
    text(event.id) ||
    text(tool.callId);
  if (!id) return null;
  const name =
    text(tool.name) ||
    text(tool.toolName) ||
    text(tool.tool_name) ||
    text(event.toolName) ||
    text(event.name) ||
    "Tool call";
  const rawOutput = tool.output ?? tool.result ?? event.output ?? event.content;
  const output = contentText(rawOutput);
  if (output) outputs.set(id, output);
  const completed =
    /(_end|_result|completed|complete|toolcall_end|tool_call_end|tool_execution_end)$/i.test(
      type,
    ) ||
    text(tool.status) === "completed" ||
    text(tool.status) === "failed";
  const phase: AspToolEvent["phase"] = completed ? "completed" : output ? "updated" : "started";
  return {
    id,
    error: text(tool.error) || text(record(tool.error).message) || undefined,
    input: tool.input ?? tool.arguments ?? event.input,
    kind: text(tool.type) || text(tool.kind) || "tool",
    name,
    output: output || outputs.get(id) || undefined,
    phase,
    semantic: toolSemanticFromName(name),
    status: text(tool.status) || (completed ? "completed" : "inProgress"),
  };
}

function isCliToolEvent(type: string): boolean {
  return (
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end" ||
    type === "tool_call" ||
    type === "tool_call_update" ||
    type === "tool_call_result" ||
    type === "toolcall_start" ||
    type === "toolcall_delta" ||
    type === "toolcall_end"
  );
}

function approvalControlResponse(decision: string): Record<string, unknown> {
  return {
    behavior: decision === "allow" || decision.startsWith("allow-") ? "allow" : "deny",
    message: decision === "cancel" ? "Cancelled by user." : undefined,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function tryJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function cliDiagnostic(value: unknown): string {
  const source = record(value);
  return text(source.message) || text(source.error) || text(record(source.error).message) || "";
}

function sanitizeCliDiagnostic(message: string): string {
  return stripAnsi(message)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(api[_-]?key|apikey|authorization|x-api-key)(["'\s:=]+)([^"'\s,}]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,})\b/g, "[REDACTED]")
    .trim();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
