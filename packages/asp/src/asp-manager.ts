import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  abortMessage,
  approvalResult,
  clientCapabilities,
  eventRecord,
  extensionInvokeMessage,
  getAspEvent,
  initializeMessage,
  normalizeCapabilities,
  normalizeExtensionEvent,
  normalizeInteractiveApp,
  normalizeMessagePart,
  normalizeMessageParts,
  normalizeModels,
  normalizeQuestions,
  normalizeSessionState,
  normalizeSessions,
  normalizeToolEvent,
  normalizeUsage,
  questionResult,
  rawMessageId,
  rawStringProperty,
  requestMessage,
  rpcApprovalResult,
  rpcErrorMessage,
  rpcQuestionResult,
  rpcResultMessage,
  runMessage,
  stringProperty,
  visiblePartText,
} from "./asp-protocol.js";
import {
  connectAspTransport,
  disposePersistentTransports,
  isSuccessfulClose,
  type AspTransportConnection,
  type TransportCloseResult,
} from "./asp-transport.js";
import { ProviderStore, type ProviderStoreOptions } from "./provider-store.js";
import {
  AspSchemaError,
  assertAspClientServiceRequest,
  assertAspEnvelope,
  assertJsonSchemaValue,
} from "./asp-schema.js";
import {
  AspProtocolError,
  appendCaptured,
  approvalOptions,
  assertExtensionInvocationAllowed,
  assertProtocolCompatible,
  automaticApproval,
  booleanProperty,
  defaultTimeoutMs,
  eventError,
  extensionMethodMapForProvider,
  formatClose,
  formatError,
  isClaudeCodeProvider,
  isEmbeddableInteractionApp,
  modelListQueryTimeoutMs,
  numberProperty,
  normalizeMessageRecords,
  normalizeProviderForTest,
  providerCloseError,
  queryTimeoutMs,
  requireDirectory,
  responseValue,
  rpcError,
  successfulClose,
  upsertPart,
  upsertTool,
  validateNegotiatedExtensions,
  validateRunInput,
  type AspEventSender,
  type AspEventSenderId,
  type PendingApproval,
  type PendingExtensionInvocation,
  type PendingQuestion,
  type Running,
} from "./asp-manager-helpers.js";
import {
  ASP_ERROR_CODES,
  ASP_VERSION,
  type ApprovalRequestPayload,
  type AspApprovalDecision,
  type AspClientServices,
  type AspExtensionDescriptor,
  type AspExtensionEvent,
  type AspExtensionFallback,
  type AspExtensionInvokeInput,
  type AspExtensionInvokeResult,
  type AspInteractiveApp,
  type AspMessagePart,
  type AspMessageRecord,
  type AspModel,
  type AspProvider,
  type AspProviderCapabilities,
  type AspProviderSession,
  type AspImplementation,
  type AspQuestionResponse,
  type AspRunEvent,
  type AspStopReason,
  type AspTokenUsage,
  type AspToolEvent,
  type DesktopSessionEvent,
  type ProviderTestResult,
  type QuestionRequestPayload,
  type RunInput,
  type RunResult,
} from "./types.js";

export type { AspEventSender } from "./asp-manager-helpers.js";

export type AspManagerOptions = {
  clientServices?: AspClientServices;
  providerStore?: ProviderStore;
  providerStoreOptions?: ProviderStoreOptions;
};

export class AspManager {
  readonly providers: ProviderStore;
  private readonly capabilitySnapshots = new Map<
    string,
    { capabilities: AspProviderCapabilities; expiresAt: number }
  >();
  private readonly extensionChannelsBySession = new Map<string, Running>();
  private readonly runningBySession = new Map<string, Running>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private clientServices?: AspClientServices;

  constructor(options: AspManagerOptions = {}) {
    this.providers = options.providerStore ?? new ProviderStore(options.providerStoreOptions);
    this.clientServices = options.clientServices;
  }

  setClientServices(services: AspClientServices | undefined): void {
    this.clientServices = services;
  }

  async run(input: RunInput, sender: AspEventSender): Promise<RunResult> {
    validateRunInput(input);
    if (this.runningBySession.has(input.uiSessionId)) {
      throw new Error("This ASP session is already processing a run.");
    }
    this.closeExtensionChannel(input.uiSessionId, new Error("ASP session started a new run."));
    const provider = this.providers.get(input.providerId);
    if (!provider?.enabled) throw new Error(`ASP provider is not available: ${input.providerId}`);
    const cwd = requireDirectory(input.cwd);
    const runId = randomUUID();
    const connection = await connectAspTransport({
      provider,
      cwd,
      runEnvironment: {
        ASP_PROTOCOL_VERSION: ASP_VERSION,
        ASP_PROTOCOL_SUPPORTED_VERSIONS: ASP_VERSION,
      },
    });
    let capabilities: AspProviderCapabilities;
    try {
      ({ capabilities } = await this.negotiateConnection(provider, connection, cwd));
      validateNegotiatedExtensions(provider, capabilities, input.extensions);
    } catch (error) {
      connection.close();
      throw error;
    }
    const running: Running = {
      capabilities,
      connection,
      extensionInvocations: new Map(),
      input: { ...input, cwd },
      pendingQuestionWaits: 0,
      provider,
      runId,
      sender,
    };
    this.runningBySession.set(input.uiSessionId, running);
    this.emitState(running, "running");
    this.emitRun(running, {
      type: "run_started",
      runId,
      providerSessionId: input.providerSessionId,
    });

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const parts: AspMessagePart[] = [];
      const tools: AspToolEvent[] = [];
      let output = "";
      let stderr = "";
      let stdout = "";
      let providerSessionId = input.providerSessionId ?? "";
      let usage: AspTokenUsage | undefined;
      let canceled = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const timeoutMs = provider.timeoutMs ?? defaultTimeoutMs;

      const clearRunTimeout = () => {
        if (!timeout) return;
        clearTimeout(timeout);
        timeout = undefined;
      };
      const armRunTimeout = () => {
        clearRunTimeout();
        if (settled || running.pendingQuestionWaits > 0) return;
        timeout = setTimeout(() => {
          fail(
            new AspProtocolError(
              `${provider.name} ASP run timed out after ${timeoutMs}ms.`,
              ASP_ERROR_CODES.internalError,
              { retryable: true, runId },
            ),
            "timeout",
          );
        }, timeoutMs);
      };
      running.suspendRunTimeout = clearRunTimeout;
      running.resetRunTimeout = armRunTimeout;
      armRunTimeout();

      const cleanup = (
        retainExtensionChannel = false,
        extensionError = new Error(`ASP run ${runId} ended.`),
      ) => {
        clearRunTimeout();
        this.runningBySession.delete(input.uiSessionId);
        this.cancelInteractions(sender.id, runId);
        if (retainExtensionChannel) {
          this.extensionChannelsBySession.set(input.uiSessionId, running);
        } else {
          this.cancelExtensionInvocations(running, extensionError);
        }
      };

      const finish = (event: Record<string, unknown> = {}) => {
        if (settled) return;
        settled = true;
        const finalParts = normalizeMessageParts(
          event.parts ?? event.messageParts ?? event.contentParts,
        );
        const resultParts = finalParts.length ? finalParts : parts;
        const partsOutput = resultParts.map(visiblePartText).filter(Boolean).join("");
        output =
          stringProperty(event, "output") ||
          stringProperty(event, "content") ||
          partsOutput ||
          output ||
          stdout;
        const success = booleanProperty(event, "success") ?? true;
        const stopReason = this.normalizeStopReason(
          stringProperty(event, "stopReason") || stringProperty(event, "stop_reason"),
          success ? "end_turn" : "error",
        );
        const exitCode = numberProperty(event, "exitCode") ?? (success ? 0 : 1);
        const durationMs = numberProperty(event, "durationMs") ?? Date.now() - startedAt;
        const finalUsage = normalizeUsage(event) ?? usage;
        emitSessionState(event);
        const retainExtensionChannel = Boolean(
          capabilities.extensions?.some((extension) =>
            extension.id === "asp.ext.mcp-apps"
              ? Boolean(extension.methods?.length)
              : extension.methods?.some((method) => method.requiresRun !== true),
          ),
        );
        cleanup(retainExtensionChannel);
        if (!retainExtensionChannel) connection.close();
        this.emitRun(running, {
          type: "run_finished",
          runId,
          providerSessionId: providerSessionId || undefined,
          durationMs,
          exitCode,
          success,
          stopReason,
          usage: finalUsage,
        });
        this.emitState(running, "idle");
        resolve({
          success,
          runId,
          providerSessionId: providerSessionId || undefined,
          output,
          durationMs,
          exitCode,
          usage: finalUsage,
          model: stringProperty(event, "model") || input.model || undefined,
          stopReason,
        });
      };

      const fail = (error: Error, stopReason: AspStopReason = "error") => {
        if (settled) return;
        settled = true;
        const durationMs = Date.now() - startedAt;
        cleanup();
        connection.close();
        this.emitRun(running, {
          type: "error",
          runId,
          message: error.message,
          providerSessionId: providerSessionId || undefined,
        });
        this.emitRun(running, {
          type: "run_finished",
          runId,
          providerSessionId: providerSessionId || undefined,
          durationMs,
          exitCode: null,
          success: false,
          stopReason,
          usage,
        });
        this.emitState(running, "error", error.message);
        reject(error);
      };

      running.cancelRun = () => {
        if (settled) return;
        canceled = true;
        settled = true;
        const durationMs = Date.now() - startedAt;
        const finalOutput = output || stdout;
        cleanup(false, new Error(`ASP run ${runId} was canceled.`));
        connection.close();
        this.emitRun(running, {
          type: "run_finished",
          runId,
          providerSessionId: providerSessionId || undefined,
          durationMs,
          exitCode: null,
          success: false,
          stopReason: "canceled",
          usage,
        });
        this.emitState(running, "idle");
        resolve({
          success: false,
          canceled: true,
          runId,
          providerSessionId: providerSessionId || undefined,
          output: finalOutput,
          durationMs,
          exitCode: null,
          usage,
          model: input.model || undefined,
          stopReason: "canceled",
        });
      };

      const emitSessionState = (value: unknown, fallbackSessionId?: string): boolean => {
        const state = normalizeSessionState(value);
        if (!state) return false;
        const nextProviderSessionId =
          state.providerSessionId ||
          fallbackSessionId ||
          providerSessionId ||
          input.providerSessionId ||
          "";
        if (nextProviderSessionId) providerSessionId = nextProviderSessionId;
        const nextState = { ...state, providerSessionId: nextProviderSessionId };
        this.emitRun(running, {
          type: "session_state",
          runId,
          state: nextState,
          providerSessionId: nextProviderSessionId || undefined,
        });
        return true;
      };

      connection.onStdout((chunk) => {
        stdout = appendCaptured(stdout, chunk);
        this.emitRun(running, {
          type: "stdout",
          runId,
          data: chunk,
          providerSessionId: providerSessionId || undefined,
        });
      });
      connection.onStderr((chunk) => {
        stderr = appendCaptured(stderr, chunk);
        this.emitRun(running, {
          type: "stderr",
          runId,
          data: chunk,
          providerSessionId: providerSessionId || undefined,
        });
      });
      connection.onMessage((message) => {
        if (canceled) return;
        try {
          assertAspEnvelope(message);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (this.handleExtensionResponse(running, message)) return;
        if (stringProperty(message, "method").startsWith("client.")) {
          if (settled) {
            const id = rawMessageId(message);
            if (id !== undefined) {
              running.connection.send(
                rpcErrorMessage(id, {
                  code: ASP_ERROR_CODES.invalidRequest,
                  message: `ASP run ${runId} has already finished.`,
                  data: { method: stringProperty(message, "method"), runId },
                }),
              );
            }
            return;
          }
          void this.handleClientServiceRequest(running, message);
          return;
        }
        const event = getAspEvent(message);
        if (!event) {
          const error = rpcError(message);
          if (error) fail(error);
          return;
        }
        const incomingRunId = stringProperty(event, "runId") || stringProperty(message, "runId");
        if (incomingRunId && incomingRunId !== runId) return;
        const topSessionId =
          stringProperty(message, "providerSessionId") || stringProperty(message, "sessionId");
        if (topSessionId) providerSessionId = topSessionId;
        const eventSessionId =
          stringProperty(event, "providerSessionId") || stringProperty(event, "sessionId");
        if (eventSessionId) providerSessionId = eventSessionId;
        const type = stringProperty(event, "type");
        const eventUsage = normalizeUsage(event);
        if (eventUsage) usage = eventUsage;

        if (
          type === "session_state" ||
          type === "session_title" ||
          type === "session.updated" ||
          type === "session_update" ||
          type === "session_title_updated" ||
          type === "thread.updated" ||
          type === "thread_update" ||
          type === "thread_title" ||
          type === "thread_title_updated" ||
          type === "conversation.updated" ||
          type === "conversation_update" ||
          type === "conversation_title" ||
          type === "conversation_title_updated" ||
          type === "title_updated"
        ) {
          emitSessionState(
            eventRecord(event).state ??
              eventRecord(event).session ??
              eventRecord(event).thread ??
              eventRecord(event).conversation ??
              eventRecord(event).payload ??
              eventRecord(event).data ??
              event,
            eventSessionId || topSessionId || undefined,
          );
          return;
        }

        if (type === "extension_event") {
          const extensionEvent = normalizeExtensionEvent(event);
          if (extensionEvent) {
            const eventDescriptor = capabilities.extensions
              ?.find((descriptor) => descriptor.id === extensionEvent.extension)
              ?.events?.find((descriptor) => descriptor.name === extensionEvent.event);
            assertJsonSchemaValue(
              eventDescriptor?.payloadSchema,
              extensionEvent.payload,
              `${extensionEvent.extension}.${extensionEvent.event} event payload`,
            );
            if (extensionEvent.providerSessionId)
              providerSessionId = extensionEvent.providerSessionId;
            if (extensionEvent.extension === "asp.ext.session-state") {
              emitSessionState(extensionEvent.payload, extensionEvent.providerSessionId);
            }
            this.emitRun(running, {
              type: "extension_event",
              runId,
              extensionEvent,
              providerSessionId: providerSessionId || extensionEvent.providerSessionId || undefined,
            });
            this.emitExtensionFallback(running, extensionEvent.fallback, {
              output: (chunk) => {
                output = appendCaptured(output, chunk);
              },
              providerSessionId: providerSessionId || extensionEvent.providerSessionId || undefined,
              tools,
              usage: (next) => {
                usage = next;
              },
              parts,
            });
          }
          return;
        }

        if (type === "message_delta" || type === "assistant_message") {
          const delta =
            rawStringProperty(event, "data") ??
            rawStringProperty(event, "delta") ??
            rawStringProperty(event, "text") ??
            rawStringProperty(event, "content") ??
            "";
          if (delta) {
            const itemId =
              rawStringProperty(event, "itemId") ??
              rawStringProperty(event, "item_id") ??
              rawStringProperty(event, "blockId") ??
              rawStringProperty(event, "partId");
            output = appendCaptured(output, delta);
            this.emitRun(running, {
              type: "message_delta",
              runId,
              data: delta,
              itemId,
              providerSessionId: providerSessionId || undefined,
            });
          }
          return;
        }

        if (
          type === "message_part" ||
          type === "content_part" ||
          type === "artifact" ||
          type === "diff" ||
          type === "status"
        ) {
          const part = normalizeMessagePart(
            eventRecord(event).part ?? eventRecord(event).messagePart ?? event,
          );
          if (part) {
            upsertPart(parts, part);
            this.emitRun(running, {
              type: "message_part",
              runId,
              part,
              providerSessionId: providerSessionId || undefined,
            });
          }
          return;
        }

        if (type === "tool_event") {
          const tool = normalizeToolEvent(eventRecord(event).toolEvent ?? event);
          upsertTool(tools, tool);
          this.emitRun(running, {
            type: "tool_event",
            runId,
            toolEvent: tool,
            providerSessionId: providerSessionId || undefined,
          });
          return;
        }

        if (type === "usage") {
          if (eventUsage) {
            usage = eventUsage;
            this.emitRun(running, {
              type: "usage",
              runId,
              usage: eventUsage,
              model: stringProperty(event, "model") || input.model || undefined,
              providerSessionId: providerSessionId || undefined,
            });
          }
          return;
        }

        if (type === "approval_request") {
          void this.handleApproval(running, message, event).catch((error) =>
            this.emitRun(running, {
              type: "error",
              runId,
              message: formatError(error),
              providerSessionId: providerSessionId || undefined,
            }),
          );
          return;
        }

        if (type === "question_request") {
          void this.handleQuestion(running, message, event).catch((error) =>
            this.emitRun(running, {
              type: "error",
              runId,
              message: formatError(error),
              providerSessionId: providerSessionId || undefined,
            }),
          );
          return;
        }

        if (type === "stdout" || type === "stderr") {
          const data =
            rawStringProperty(event, "data") ??
            rawStringProperty(event, "text") ??
            rawStringProperty(event, "content") ??
            "";
          if (!data) return;
          if (type === "stdout") stdout = appendCaptured(stdout, data);
          else stderr = appendCaptured(stderr, data);
          this.emitRun(running, {
            type,
            runId,
            data,
            providerSessionId: providerSessionId || undefined,
          });
          return;
        }

        if (type === "error") {
          const messageText = eventError(event) || `${provider.name} emitted an error.`;
          this.emitRun(running, {
            type: "error",
            runId,
            message: messageText,
            providerSessionId: providerSessionId || undefined,
          });
          if (booleanProperty(event, "fatal")) finish({ ...event, success: false });
          return;
        }

        if (type === "run_finished" || type === "finished" || type === "result") finish(event);
      });
      connection.onError(fail);
      connection.onClose((close) => {
        if (settled) {
          if (this.extensionChannelsBySession.get(input.uiSessionId) === running) {
            this.extensionChannelsBySession.delete(input.uiSessionId);
            this.cancelExtensionInvocations(
              running,
              new Error(`${provider.name} ASP extension channel closed (${formatClose(close)}).`),
            );
            this.emitState(running, "closed");
          }
          return;
        }
        if (isSuccessfulClose(provider.transport, close)) {
          finish(successfulClose(close));
        } else {
          fail(providerCloseError(provider, close, "completing the ASP run", stdout, stderr));
        }
      });
      connection.send(runMessage(running.input, runId, this.advertisedClientCapabilities()));
    });
  }

  invokeExtension(
    input: AspExtensionInvokeInput,
    senderId?: AspEventSenderId,
  ): Promise<AspExtensionInvokeResult> {
    const running =
      this.runningBySession.get(input.uiSessionId) ??
      this.extensionChannelsBySession.get(input.uiSessionId);
    if (!running)
      throw new Error(`ASP session extension channel is not available: ${input.uiSessionId}`);
    if (senderId !== undefined && running.sender.id !== senderId) {
      throw new Error("Extension invocation came from an untrusted renderer.");
    }
    const extension = input.extension.trim();
    const method = input.method.trim();
    if (!extension) throw new Error("ASP extension id is required.");
    if (!method) throw new Error("ASP extension method is required.");
    const safety = assertExtensionInvocationAllowed(running, { ...input, extension, method });
    if (safety === "approval_required") {
      return this.requestApproval(running, {
        title: `Allow ${running.provider.name} extension action?`,
        method: `${extension}.${method}`,
        scope: "extension",
        params: input.payload,
        options: ["allow", "deny", "cancel"],
      }).then((response) => {
        if (response.decision !== "allow") {
          throw new Error(`ASP extension invocation was not approved: ${extension}.${method}`);
        }
        return this.sendExtensionInvocation(running, { ...input, extension, method });
      });
    }
    return this.sendExtensionInvocation(running, { ...input, extension, method });
  }

  private sendExtensionInvocation(
    running: Running,
    input: AspExtensionInvokeInput,
  ): Promise<AspExtensionInvokeResult> {
    const { extension, method } = input;
    const methodDescriptor = running.capabilities.extensions
      ?.find((descriptor) => descriptor.id === extension)
      ?.methods?.find((descriptor) => descriptor.name === method);
    assertJsonSchemaValue(
      methodDescriptor?.inputSchema,
      input.payload ?? {},
      `${extension}.${method} input`,
    );
    const id = randomUUID();
    const timeoutMs = input.timeoutMs ?? queryTimeoutMs;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            const pending = running.extensionInvocations.get(id);
            if (!pending) return;
            running.extensionInvocations.delete(id);
            pending.reject(new Error(`${extension}.${method} timed out.`));
          }, timeoutMs)
        : undefined;
    const message = extensionInvokeMessage(
      {
        extension,
        method,
        payload: input.payload,
        providerSessionId: input.providerSessionId,
        runId: input.runId || running.runId,
      },
      id,
    );
    return new Promise((resolve, reject) => {
      running.extensionInvocations.set(id, {
        extension,
        method,
        outputSchema: methodDescriptor?.outputSchema,
        reject,
        resolve,
        timeout,
      });
      running.connection.send(message);
    });
  }

  async cancel(uiSessionId: string): Promise<boolean> {
    const running = this.runningBySession.get(uiSessionId);
    const extensionChannel = this.extensionChannelsBySession.get(uiSessionId);
    if (!running && !extensionChannel) return false;
    if (running) {
      running.connection.send(abortMessage(running.runId));
      if (running.cancelRun) {
        running.cancelRun();
      } else {
        this.runningBySession.delete(uiSessionId);
        this.cancelInteractions(running.sender.id, running.runId);
        this.cancelExtensionInvocations(
          running,
          new Error(`ASP run ${running.runId} was canceled.`),
        );
        running.connection.close();
        this.emitState(running, "idle");
      }
    }
    if (extensionChannel && extensionChannel !== running) {
      this.closeExtensionChannel(uiSessionId, new Error("ASP extension channel was canceled."));
      this.emitState(extensionChannel, "closed");
    }
    return true;
  }

  async listSessions(providerId: string, cwd: string): Promise<AspProviderSession[]> {
    const provider = this.requireProvider(providerId);
    return this.query(
      provider,
      requestMessage(providerId, "list_sessions", {
        cwd,
        projectPath: cwd,
      }),
      (message) => {
        const response = responseValue(message);
        if (response !== undefined) return normalizeSessions(response);
        const event = getAspEvent(message);
        return event &&
          ["sessions", "session_list", "list_sessions_result"].includes(
            stringProperty(event, "type"),
          )
          ? normalizeSessions(event)
          : null;
      },
    );
  }

  async newSession(providerId: string, cwd: string, title?: string): Promise<AspProviderSession> {
    const provider = this.requireProvider(providerId);
    const workspace = requireDirectory(cwd);
    const { capabilities } = await this.negotiateProvider(provider, workspace, true);
    if (capabilities.createSession !== true) {
      throw new AspProtocolError(
        `${provider.name} does not negotiate ASP session creation.`,
        ASP_ERROR_CODES.capabilityNotNegotiated,
        { method: "new_session" },
      );
    }
    return this.query(
      provider,
      requestMessage(providerId, "new_session", {
        cwd: workspace,
        projectPath: workspace,
        ...(title ? { title } : {}),
      }),
      (message) => {
        const value = responseValue(message);
        const event = value === undefined ? getAspEvent(message) : value;
        if (event === undefined || event === null) return null;
        return normalizeSessions({ sessions: [eventRecord(event).session ?? event] })[0] ?? null;
      },
      queryTimeoutMs,
      workspace,
    );
  }

  async closeSession(providerId: string, providerSessionId: string, cwd: string): Promise<boolean> {
    const provider = this.requireProvider(providerId);
    const workspace = requireDirectory(cwd);
    const { capabilities } = await this.negotiateProvider(provider, workspace, true);
    if (capabilities.closeSession !== true) {
      throw new AspProtocolError(
        `${provider.name} does not negotiate ASP session closure.`,
        ASP_ERROR_CODES.capabilityNotNegotiated,
        { method: "close_session", providerSessionId },
      );
    }
    return this.query(
      provider,
      requestMessage(providerId, "close_session", { providerSessionId }),
      (message) => {
        const value = responseValue(message);
        if (typeof value === "boolean") return value;
        if (value === undefined) return null;
        const source = eventRecord(value);
        return source.closed !== false && source.ok !== false && source.success !== false;
      },
      queryTimeoutMs,
      workspace,
    );
  }

  async sessionMessages(
    providerId: string,
    providerSessionId: string,
  ): Promise<AspMessageRecord[]> {
    const provider = this.requireProvider(providerId);
    return this.query(
      provider,
      requestMessage(providerId, "session_messages", { providerSessionId }),
      (message) => {
        const response = responseValue(message);
        if (response !== undefined) return normalizeMessageRecords(response);
        const event = getAspEvent(message);
        return event &&
          ["session_messages", "session_history", "history"].includes(stringProperty(event, "type"))
          ? normalizeMessageRecords(event)
          : null;
      },
    );
  }

  async sessionUsage(
    providerId: string,
    providerSessionId: string,
  ): Promise<AspTokenUsage | undefined> {
    const provider = this.requireProvider(providerId);
    return this.query(
      provider,
      requestMessage(providerId, "session_usage", { providerSessionId }),
      (message) => {
        const response = responseValue(message);
        if (response !== undefined) return normalizeUsage(response) ?? null;
        const event = getAspEvent(message);
        return event &&
          ["usage", "session_usage", "session_usage_result"].includes(stringProperty(event, "type"))
          ? (normalizeUsage(event) ?? null)
          : null;
      },
    );
  }

  async resumeSession(
    providerId: string,
    providerSessionId: string,
    cwd: string,
  ): Promise<{ session?: AspProviderSession; messages: AspMessageRecord[] }> {
    const provider = this.requireProvider(providerId);
    return this.query(
      provider,
      requestMessage(providerId, "resume_session", {
        providerSessionId,
        cwd,
        projectPath: cwd,
      }),
      (message) => {
        const value = responseValue(message);
        const event = value === undefined ? getAspEvent(message) : value;
        if (!event) return null;
        const source = eventRecord(event);
        const session = normalizeSessions(source.session ?? source.providerSession ?? source)[0];
        return {
          session,
          messages: normalizeMessageRecords(
            source.messages ?? source.history ?? eventRecord(source.result).messages,
          ),
        };
      },
    );
  }

  async deleteSession(
    providerId: string,
    providerSessionId: string,
    cwd: string,
    transcriptPath?: string,
  ): Promise<boolean> {
    const provider = this.requireProvider(providerId);
    return this.query(
      provider,
      requestMessage(providerId, "delete_session", {
        providerSessionId,
        ...(transcriptPath ? { transcriptPath } : {}),
        cwd,
        projectPath: cwd,
      }),
      (message) => {
        const value = responseValue(message);
        const event = value === undefined ? getAspEvent(message) : value;
        if (event === undefined || event === null) return null;
        if (typeof event === "boolean") return event;
        const source = eventRecord(event);
        const result = eventRecord(source.result);
        const type = stringProperty(source, "type");
        if (["session_deleted", "delete_session_result", "session_removed"].includes(type)) {
          return source.ok !== false && source.success !== false && source.deleted !== false;
        }
        if (
          source.ok !== undefined ||
          source.success !== undefined ||
          source.deleted !== undefined
        ) {
          return source.ok !== false && source.success !== false && source.deleted !== false;
        }
        if (
          result.ok !== undefined ||
          result.success !== undefined ||
          result.deleted !== undefined
        ) {
          return result.ok !== false && result.success !== false && result.deleted !== false;
        }
        return null;
      },
    );
  }

  async testProvider(provider: AspProvider): Promise<ProviderTestResult> {
    try {
      const normalized = normalizeProviderForTest(provider);
      const { agentInfo, capabilities, protocolVersion } = await this.negotiateProvider(
        normalized,
        process.cwd(),
        true,
      );
      let models: AspModel[] = normalized.models ?? [];
      if (capabilities.models !== false) {
        models = await this.query(
          normalized,
          requestMessage(normalized.id, "list_models"),
          (message) => {
            const value = responseValue(message);
            if (value !== undefined) return normalizeModels(value);
            const event = getAspEvent(message);
            return event &&
              ["models", "model_list", "list_models_result"].includes(stringProperty(event, "type"))
              ? normalizeModels(event)
              : null;
          },
          modelListQueryTimeoutMs(normalized),
        ).catch((error) => {
          if (isClaudeCodeProvider(normalized)) throw error;
          return models;
        });
      }
      return { ok: true, protocolVersion, capabilities, models, agentInfo };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async providerCapabilities(providerId: string, cwd: string): Promise<ProviderTestResult> {
    try {
      const provider = this.requireProvider(providerId);
      const workspace = requireDirectory(cwd);
      const { agentInfo, capabilities, protocolVersion } = await this.negotiateProvider(
        provider,
        workspace,
        true,
      );
      let models: AspModel[] = provider.models ?? [];
      if (capabilities.models !== false) {
        models = await this.query(
          provider,
          requestMessage(provider.id, "list_models"),
          (message) => {
            const value = responseValue(message);
            if (value !== undefined) return normalizeModels(value);
            const event = getAspEvent(message);
            return event &&
              ["models", "model_list", "list_models_result"].includes(stringProperty(event, "type"))
              ? normalizeModels(event)
              : null;
          },
          modelListQueryTimeoutMs(provider),
          workspace,
        ).catch((error) => {
          if (isClaudeCodeProvider(provider)) throw error;
          return models;
        });
      }
      return { ok: true, protocolVersion, capabilities, models, agentInfo };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  respondApproval(
    requestId: string,
    decision: AspApprovalDecision,
    message: string | undefined,
    senderId: AspEventSenderId,
  ): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.senderId !== senderId) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve({ decision, message });
    return true;
  }

  respondQuestion(
    requestId: string,
    response: AspQuestionResponse,
    senderId: AspEventSenderId,
  ): boolean {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || pending.senderId !== senderId) return false;
    this.pendingQuestions.delete(requestId);
    pending.resolve(response);
    return true;
  }

  pendingInteractions(sender: AspEventSender): {
    approvals: ApprovalRequestPayload[];
    questions: QuestionRequestPayload[];
  } {
    const approvals: ApprovalRequestPayload[] = [];
    const questions: QuestionRequestPayload[] = [];
    for (const pending of this.pendingApprovals.values()) {
      pending.senderId = sender.id;
      approvals.push(pending.payload);
    }
    for (const pending of this.pendingQuestions.values()) {
      pending.senderId = sender.id;
      questions.push(pending.payload);
    }
    return { approvals, questions };
  }

  requestUserInput(
    uiSessionId: string,
    request: Omit<QuestionRequestPayload, "requestId" | "runId" | "uiSessionId">,
  ): Promise<AspQuestionResponse> {
    const running = this.runningBySession.get(uiSessionId) ?? this.singleRunningSession();
    if (!running) {
      throw new Error(
        this.runningBySession.size
          ? `No active ASP run for UI session ${uiSessionId}; multiple runs are active, so request_user_input needs a session scope.`
          : `No active ASP run for UI session ${uiSessionId}.`,
      );
    }
    return this.requestQuestion(running, {
      ...request,
      method: request.method || "request_user_input",
      providerSessionId: request.providerSessionId || running.input.providerSessionId || undefined,
      questions: request.questions ?? [],
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [
        ...new Set([...this.runningBySession.keys(), ...this.extensionChannelsBySession.keys()]),
      ].map((id) => this.cancel(id)),
    );
    disposePersistentTransports();
    this.capabilitySnapshots.clear();
  }

  private async handleApproval(
    running: Running,
    rawMessage: unknown,
    event: Record<string, unknown>,
  ): Promise<void> {
    const nestedParams = eventRecord(
      event.params ?? event.input ?? event.arguments ?? event.details,
    );
    const params = { ...event, ...nestedParams };
    const method =
      stringProperty(event, "method") ||
      stringProperty(event, "name") ||
      stringProperty(params, "method") ||
      stringProperty(params, "toolName") ||
      stringProperty(params, "tool") ||
      "approval_request";
    const scope =
      stringProperty(event, "scope") ||
      stringProperty(event, "kind") ||
      stringProperty(params, "scope") ||
      undefined;
    const automatic = automaticApproval(running.input.approvalMode, scope, method);
    const response = automatic
      ? { decision: automatic }
      : await this.requestApproval(running, {
          approvalId:
            stringProperty(event, "approvalId") || stringProperty(event, "id") || undefined,
          title:
            stringProperty(event, "title") ||
            stringProperty(params, "title") ||
            stringProperty(params, "toolName") ||
            `Approve ${method}`,
          method,
          scope,
          params: { ...params, tool: stringProperty(params, "tool") || method },
          options: approvalOptions(params),
        });
    const messageId = rawMessageId(rawMessage);
    running.connection.send(
      messageId !== undefined
        ? rpcApprovalResult(messageId, response.decision, response.message)
        : approvalResult(
            stringProperty(event, "approvalId") || stringProperty(event, "id") || undefined,
            method,
            response.decision,
            response.message,
          ),
    );
  }

  private async handleQuestion(
    running: Running,
    rawMessage: unknown,
    event: Record<string, unknown>,
  ): Promise<void> {
    const params = eventRecord(event.params ?? event.input ?? event.arguments ?? event);
    const nestedParams = eventRecord(params.params);
    const source = { ...nestedParams, ...params, ...event };
    const metadata = eventRecord(params.metadata ?? nestedParams.metadata ?? event.metadata);
    const questions = normalizeQuestions(
      event.questions ??
        params.questions ??
        nestedParams.questions ??
        params.question ??
        nestedParams.question,
    );
    const fallback =
      stringProperty(event, "question") ||
      stringProperty(params, "question") ||
      stringProperty(nestedParams, "question") ||
      stringProperty(event, "message") ||
      stringProperty(params, "message") ||
      stringProperty(nestedParams, "message") ||
      stringProperty(event, "text") ||
      stringProperty(params, "text") ||
      stringProperty(nestedParams, "text") ||
      stringProperty(event, "title");
    const appCandidate = normalizeInteractiveApp(source, metadata);
    const app = isEmbeddableInteractionApp(appCandidate) ? appCandidate : undefined;
    const response = await this.requestQuestion(running, {
      questionId: stringProperty(event, "questionId") || stringProperty(event, "id") || undefined,
      providerSessionId:
        stringProperty(event, "providerSessionId") ||
        stringProperty(params, "providerSessionId") ||
        stringProperty(nestedParams, "providerSessionId") ||
        running.input.providerSessionId ||
        undefined,
      title:
        stringProperty(event, "title") ||
        stringProperty(params, "title") ||
        stringProperty(nestedParams, "title") ||
        undefined,
      question: fallback || undefined,
      instructions:
        stringProperty(params, "instructions") ||
        stringProperty(nestedParams, "instructions") ||
        stringProperty(params, "description") ||
        stringProperty(nestedParams, "description") ||
        undefined,
      method:
        stringProperty(event, "method") ||
        stringProperty(event, "name") ||
        stringProperty(event, "tool") ||
        "question_request",
      interactionType: app
        ? "mcp_app"
        : stringProperty(params, "interactionType") === "custom" ||
            stringProperty(params, "interaction_type") === "custom"
          ? "custom"
          : "form",
      app,
      metadata,
      submitLabel:
        stringProperty(params, "submitLabel") ||
        stringProperty(params, "submit_label") ||
        stringProperty(nestedParams, "submitLabel") ||
        stringProperty(nestedParams, "submit_label") ||
        undefined,
      cancelLabel:
        stringProperty(params, "cancelLabel") ||
        stringProperty(params, "cancel_label") ||
        stringProperty(nestedParams, "cancelLabel") ||
        stringProperty(nestedParams, "cancel_label") ||
        undefined,
      questions: questions.length ? questions : fallback ? [{ question: fallback }] : [],
    });
    const responsePayload =
      response.answers?.length || response.app || response.metadata
        ? {
            ...(response.answers?.length ? { answers: response.answers } : {}),
            ...(response.app ? { app: response.app } : {}),
            ...(response.metadata ? { metadata: response.metadata } : {}),
          }
        : undefined;
    const result =
      response.result ??
      (response.unanswered || response.canceled || !responsePayload
        ? "The user did not answer the questions."
        : responsePayload);
    const messageId = rawMessageId(rawMessage);
    running.connection.send(
      messageId !== undefined
        ? rpcQuestionResult(messageId, result)
        : questionResult(
            stringProperty(event, "questionId") || stringProperty(event, "id") || undefined,
            stringProperty(event, "method") || undefined,
            result,
          ),
    );
  }

  private async handleClientServiceRequest(running: Running, rawMessage: unknown): Promise<void> {
    const id = rawMessageId(rawMessage);
    if (id === undefined) {
      this.emitRun(running, {
        type: "error",
        runId: running.runId,
        message: "ASP client service requests require an id.",
        providerSessionId: running.input.providerSessionId,
      });
      return;
    }
    try {
      assertAspClientServiceRequest(rawMessage);
      const message = eventRecord(rawMessage);
      const method = stringProperty(message, "method");
      const params = eventRecord(message.params);
      if (stringProperty(params, "runId") !== running.runId) {
        throw new AspProtocolError(
          `ASP client service request does not belong to active run ${running.runId}.`,
          ASP_ERROR_CODES.invalidRequest,
          { method, runId: running.runId },
        );
      }
      const services = this.clientServices;
      const context = {
        cwd: running.input.cwd,
        providerId: running.provider.id,
        providerSessionId:
          stringProperty(params, "providerSessionId") || running.input.providerSessionId,
        runId: running.runId,
        uiSessionId: running.input.uiSessionId,
      };
      let result: unknown;
      switch (method) {
        case "client.fs.read_text_file":
          if (!services?.readTextFile) throw this.clientServiceUnavailable(method);
          result = await services.readTextFile(
            {
              path: stringProperty(params, "path"),
              line: numberProperty(params, "line"),
              limit: numberProperty(params, "limit"),
            },
            context,
          );
          break;
        case "client.fs.write_text_file":
          if (!services?.writeTextFile) throw this.clientServiceUnavailable(method);
          await this.requireClientServiceApproval(running, method, "filesystem", params);
          result = await services.writeTextFile(
            {
              path: stringProperty(params, "path"),
              content: rawStringProperty(params, "content") ?? "",
            },
            context,
          );
          break;
        case "client.terminal.create":
          if (!services?.terminalCreate) throw this.clientServiceUnavailable(method);
          await this.requireClientServiceApproval(running, method, "command", params);
          result = await services.terminalCreate(
            {
              id: stringProperty(params, "id"),
              command: stringProperty(params, "command"),
              args: Array.isArray(params.args) ? params.args.map(String) : undefined,
              cwd: stringProperty(params, "cwd") || undefined,
              env: Object.fromEntries(
                Object.entries(eventRecord(params.env)).map(([key, value]) => [key, String(value)]),
              ),
            },
            context,
          );
          break;
        case "client.terminal.output":
          if (!services?.terminalOutput) throw this.clientServiceUnavailable(method);
          result = await services.terminalOutput(
            {
              id: stringProperty(params, "id"),
              maxChars: numberProperty(params, "maxChars"),
            },
            context,
          );
          break;
        case "client.terminal.wait_for_exit":
          if (!services?.terminalWaitForExit) throw this.clientServiceUnavailable(method);
          result = await services.terminalWaitForExit(
            {
              id: stringProperty(params, "id"),
              timeoutMs: numberProperty(params, "timeoutMs"),
            },
            context,
          );
          break;
        case "client.terminal.kill":
          if (!services?.terminalKill) throw this.clientServiceUnavailable(method);
          await this.requireClientServiceApproval(running, method, "command", params);
          result = await services.terminalKill({ id: stringProperty(params, "id") }, context);
          break;
        case "client.terminal.release":
          if (!services?.terminalRelease) throw this.clientServiceUnavailable(method);
          result = await services.terminalRelease({ id: stringProperty(params, "id") }, context);
          break;
        case "client.permission.request": {
          const response = await this.resolveClientPermission(running, params);
          result = {
            approved: ["allow", "allow-session", "allow-always"].includes(response.decision),
            ...response,
          };
          break;
        }
        case "client.elicitation.create":
          result = await this.requestQuestion(running, {
            title: stringProperty(params, "title") || undefined,
            question: stringProperty(params, "message"),
            method,
            interactionType: "form",
            metadata: eventRecord(params.metadata),
            providerSessionId: context.providerSessionId,
            questions: normalizeQuestions(params.questions ?? params.message),
          });
          break;
        default:
          throw this.clientServiceUnavailable(method);
      }
      running.connection.send(rpcResultMessage(id, result));
    } catch (error) {
      const protocolError = error instanceof AspProtocolError ? error : undefined;
      running.connection.send(
        rpcErrorMessage(id, {
          code:
            protocolError?.code ??
            (error instanceof AspSchemaError
              ? ASP_ERROR_CODES.invalidParams
              : ASP_ERROR_CODES.internalError),
          message: formatError(error),
          data: protocolError?.data,
        }),
      );
    }
  }

  private clientServiceUnavailable(method: string): AspProtocolError {
    return new AspProtocolError(
      `ASP client service is not available: ${method}.`,
      ASP_ERROR_CODES.methodNotFound,
      { method },
    );
  }

  private async requireClientServiceApproval(
    running: Running,
    method: string,
    scope: string,
    params: unknown,
  ): Promise<void> {
    const response = await this.resolveClientPermission(running, {
      method,
      scope,
      title: `Allow ${running.provider.name} to use ${method}?`,
      input: params,
    });
    if (!["allow", "allow-session", "allow-always"].includes(response.decision)) {
      throw new AspProtocolError(
        `ASP client service request was not approved: ${method}.`,
        ASP_ERROR_CODES.approvalDenied,
        { method, runId: running.runId },
      );
    }
  }

  private async resolveClientPermission(
    running: Running,
    params: Record<string, unknown>,
  ): Promise<{ decision: AspApprovalDecision; message?: string }> {
    const method = stringProperty(params, "method") || "client.permission.request";
    const scope = stringProperty(params, "scope") || "tool";
    const automatic = automaticApproval(running.input.approvalMode, scope, method);
    if (automatic) return { decision: automatic };
    return this.requestApproval(running, {
      title: stringProperty(params, "title") || `Approve ${method}`,
      method,
      scope,
      params: params.input ?? params,
      options: approvalOptions(params),
    });
  }

  private requestApproval(
    running: Running,
    request: Omit<ApprovalRequestPayload, "requestId" | "uiSessionId" | "runId">,
  ): Promise<{ decision: AspApprovalDecision; message?: string }> {
    const requestId = randomUUID();
    const payload: ApprovalRequestPayload = {
      ...request,
      requestId,
      uiSessionId: running.input.uiSessionId,
      runId: running.runId,
    };
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, {
        payload,
        runId: running.runId,
        senderId: running.sender.id,
        resolve,
      });
      if (!running.sender.isDestroyed()) running.sender.send("agui:asp:approval", payload);
    });
  }

  private requestQuestion(
    running: Running,
    request: Omit<QuestionRequestPayload, "requestId" | "uiSessionId" | "runId">,
  ): Promise<AspQuestionResponse> {
    const requestId = randomUUID();
    const payload: QuestionRequestPayload = {
      ...request,
      requestId,
      uiSessionId: running.input.uiSessionId,
      runId: running.runId,
    };
    const endQuestionWait = this.beginQuestionWait(running);
    return new Promise((resolve) => {
      this.pendingQuestions.set(requestId, {
        payload,
        runId: running.runId,
        senderId: running.sender.id,
        resolve: (value) => {
          endQuestionWait();
          resolve(value);
        },
      });
      if (!running.sender.isDestroyed()) {
        running.sender.send("agui:asp:question", payload);
        return;
      }
      const pending = this.pendingQuestions.get(requestId);
      this.pendingQuestions.delete(requestId);
      pending?.resolve({ canceled: true });
    });
  }

  private beginQuestionWait(running: Running): () => void {
    running.pendingQuestionWaits += 1;
    running.suspendRunTimeout?.();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      running.pendingQuestionWaits = Math.max(0, running.pendingQuestionWaits - 1);
      if (running.pendingQuestionWaits === 0) running.resetRunTimeout?.();
    };
  }

  private singleRunningSession(): Running | undefined {
    return this.runningBySession.size === 1 ? [...this.runningBySession.values()][0] : undefined;
  }

  private negotiateConnection(
    provider: AspProvider,
    connection: AspTransportConnection,
    cwd: string,
  ): Promise<{
    agentInfo?: AspImplementation;
    capabilities: AspProviderCapabilities;
    protocolVersion: string;
  }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr = "";
      let phase: "initialize" | "capabilities" = "initialize";
      let expectedId = randomUUID();
      const timeout = setTimeout(() => {
        fail(
          new AspProtocolError(
            `${provider.name} ASP initialize timed out after 8000ms.${stderr ? `\n${stderr}` : ""}`,
            ASP_ERROR_CODES.internalError,
            { method: phase, retryable: true },
          ),
        );
      }, 8_000);
      const finish = (value: {
        agentInfo?: AspImplementation;
        capabilities: AspProviderCapabilities;
        protocolVersion: string;
      }) => {
        if (settled) return;
        if (value.protocolVersion !== ASP_VERSION) {
          fail(
            new AspProtocolError(
              `${provider.name} selected incompatible ASP v${value.protocolVersion}.`,
              ASP_ERROR_CODES.protocolVersionMismatch,
              { method: "initialize", details: { supportedProtocolVersions: [ASP_VERSION] } },
            ),
          );
          return;
        }
        try {
          assertProtocolCompatible(provider, value.capabilities);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.capabilitySnapshots.set(this.capabilitySnapshotKey(provider, cwd), {
          capabilities: value.capabilities,
          expiresAt: Date.now() + 30_000,
        });
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      connection.onMessage((message) => {
        if (settled || String(rawMessageId(message)) !== String(expectedId)) return;
        try {
          assertAspEnvelope(message);
          const error = rpcError(message);
          if (error) {
            if (phase === "initialize" && error.code === ASP_ERROR_CODES.methodNotFound) {
              phase = "capabilities";
              expectedId = randomUUID();
              connection.send(requestMessage(provider.id, "capabilities", {}, expectedId));
              return;
            }
            fail(error);
            return;
          }
          const value = responseValue(message);
          if (value === undefined) return;
          if (phase === "capabilities") {
            finish({
              capabilities: normalizeCapabilities(value),
              protocolVersion: ASP_VERSION,
            });
            return;
          }
          finish(this.normalizeInitializeResult(provider, value));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      connection.onStderr((chunk) => {
        if (!settled) stderr = appendCaptured(stderr, chunk);
      });
      connection.onError(fail);
      connection.onClose((close) => {
        if (!settled) {
          fail(providerCloseError(provider, close, "initializing the ASP connection", "", stderr));
        }
      });
      connection.send(
        initializeMessage(provider.id, expectedId, this.advertisedClientCapabilities()),
      );
    });
  }

  private async query<T>(
    provider: AspProvider,
    request: Record<string, unknown>,
    extract: (message: unknown) => T | null,
    timeoutMs = queryTimeoutMs,
    cwd = process.cwd(),
  ): Promise<T> {
    const connection = await connectAspTransport({
      provider,
      cwd,
      runEnvironment: {
        ASP_PROTOCOL_VERSION: ASP_VERSION,
        ASP_PROTOCOL_SUPPORTED_VERSIONS: ASP_VERSION,
      },
    });
    const method = stringProperty(request, "method");
    if (method !== "initialize" && method !== "capabilities") {
      try {
        await this.negotiateConnection(provider, connection, cwd);
      } catch (error) {
        connection.close();
        throw error;
      }
    }
    const expectedResponseId = rawMessageId(request);
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr = "";
      const timeout = setTimeout(() => {
        fail(
          new Error(
            `${provider.name} ASP query timed out after ${timeoutMs}ms.${stderr ? `\n${stderr}` : ""}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        connection.close();
      };
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      connection.onMessage((message) => {
        try {
          assertAspEnvelope(message);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const responseId = rawMessageId(message);
        if (
          expectedResponseId !== undefined &&
          responseId !== undefined &&
          String(responseId) !== String(expectedResponseId)
        ) {
          return;
        }
        const error = rpcError(message);
        if (error) {
          fail(error);
          return;
        }
        const result = extract(message);
        if (result !== null) finish(result);
      });
      connection.onStderr((chunk) => {
        stderr = appendCaptured(stderr, chunk);
      });
      connection.onError(fail);
      connection.onClose((close) => {
        if (!settled)
          fail(providerCloseError(provider, close, "returning an ASP response", "", stderr));
      });
      connection.send(request);
    });
  }

  private requireProvider(id: string): AspProvider {
    const provider = this.providers.get(id);
    if (!provider?.enabled) throw new Error(`ASP provider is not available: ${id}`);
    return provider;
  }

  private async negotiateProvider(
    provider: AspProvider,
    cwd: string,
    forceRefresh = false,
  ): Promise<{
    agentInfo?: AspImplementation;
    capabilities: AspProviderCapabilities;
    protocolVersion: string;
  }> {
    const key = this.capabilitySnapshotKey(provider, cwd);
    const cached = this.capabilitySnapshots.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return { capabilities: cached.capabilities, protocolVersion: ASP_VERSION };
    }
    let negotiation: {
      agentInfo?: AspImplementation;
      capabilities: AspProviderCapabilities;
      protocolVersion: string;
    };
    try {
      negotiation = await this.query(
        provider,
        initializeMessage(provider.id, randomUUID(), this.advertisedClientCapabilities()),
        (message) => {
          const value = responseValue(message);
          if (value === undefined) return null;
          return this.normalizeInitializeResult(provider, value);
        },
        8_000,
        cwd,
      );
    } catch (error) {
      if (!(error instanceof AspProtocolError) || error.code !== ASP_ERROR_CODES.methodNotFound) {
        throw error;
      }
      const capabilities = await this.query(
        provider,
        requestMessage(provider.id, "capabilities"),
        (message) => {
          const value = responseValue(message);
          if (value !== undefined) return normalizeCapabilities(value);
          const event = getAspEvent(message);
          return event && stringProperty(event, "type") === "capabilities"
            ? normalizeCapabilities(event)
            : null;
        },
        8_000,
        cwd,
      );
      negotiation = { capabilities, protocolVersion: ASP_VERSION };
    }
    if (negotiation.protocolVersion !== ASP_VERSION) {
      throw new AspProtocolError(
        `${provider.name} selected incompatible ASP v${negotiation.protocolVersion}.`,
        ASP_ERROR_CODES.protocolVersionMismatch,
        { method: "initialize", details: { supportedProtocolVersions: [ASP_VERSION] } },
      );
    }
    const { capabilities } = negotiation;
    assertProtocolCompatible(provider, capabilities);
    this.capabilitySnapshots.set(key, {
      capabilities,
      expiresAt: Date.now() + 30_000,
    });
    return negotiation;
  }

  private normalizeInitializeResult(
    provider: AspProvider,
    value: unknown,
  ): {
    agentInfo?: AspImplementation;
    capabilities: AspProviderCapabilities;
    protocolVersion: string;
  } {
    const source = eventRecord(value);
    const protocolVersion = stringProperty(source, "protocolVersion");
    if (!protocolVersion) {
      throw new AspProtocolError(
        `${provider.name} initialize response omitted protocolVersion.`,
        ASP_ERROR_CODES.invalidRequest,
        { method: "initialize" },
      );
    }
    const info = eventRecord(source.agentInfo ?? source.serverInfo ?? source.implementation);
    const name = stringProperty(info, "name");
    const version = stringProperty(info, "version");
    return {
      ...(name && version
        ? {
            agentInfo: {
              name,
              version,
              title: stringProperty(info, "title") || undefined,
              url: stringProperty(info, "url") || undefined,
            },
          }
        : {}),
      capabilities: normalizeCapabilities(source.capabilities),
      protocolVersion,
    };
  }

  private capabilitySnapshotKey(provider: AspProvider, cwd: string): string {
    return JSON.stringify({
      args: provider.args,
      capabilities: provider.capabilities,
      command: provider.command,
      cwd: path.resolve(cwd),
      env: provider.env,
      id: provider.id,
      transport: provider.transport,
      url: provider.url,
    });
  }

  private advertisedClientCapabilities(): AspProviderCapabilities {
    const services = this.clientServices;
    return {
      ...clientCapabilities,
      clientServices: {
        filesystem: {
          readTextFile: Boolean(services?.readTextFile),
          writeTextFile: Boolean(services?.writeTextFile),
        },
        terminal: {
          create: Boolean(services?.terminalCreate),
          output: Boolean(services?.terminalOutput),
          waitForExit: Boolean(services?.terminalWaitForExit),
          kill: Boolean(services?.terminalKill),
          release: Boolean(services?.terminalRelease),
        },
        permissions: true,
        elicitation: true,
      },
    };
  }

  private normalizeStopReason(value: string, fallback: AspStopReason): AspStopReason {
    return [
      "end_turn",
      "canceled",
      "error",
      "timeout",
      "max_tokens",
      "max_turns",
      "refusal",
    ].includes(value)
      ? (value as AspStopReason)
      : fallback;
  }

  private emitRun(running: Running, event: AspRunEvent): void {
    this.emit(running.sender, {
      type: "run_event",
      uiSessionId: running.input.uiSessionId,
      clientRequestId: running.input.clientRequestId,
      event,
    });
  }

  private emitExtensionFallback(
    running: Running,
    fallback: AspExtensionFallback | "none" | undefined,
    state: {
      output(chunk: string): void;
      parts: AspMessagePart[];
      providerSessionId?: string;
      tools: AspToolEvent[];
      usage(value: AspTokenUsage): void;
    },
  ): void {
    if (!fallback || fallback === "none") return;
    if (fallback.type === "message_delta") {
      state.output(fallback.data);
      this.emitRun(running, {
        type: "message_delta",
        runId: running.runId,
        data: fallback.data,
        providerSessionId: state.providerSessionId,
      });
      return;
    }
    if (fallback.type === "message_part") {
      upsertPart(state.parts, fallback.part);
      this.emitRun(running, {
        type: "message_part",
        runId: running.runId,
        part: fallback.part,
        providerSessionId: state.providerSessionId,
      });
      return;
    }
    if (fallback.type === "tool_event") {
      upsertTool(state.tools, fallback.toolEvent);
      this.emitRun(running, {
        type: "tool_event",
        runId: running.runId,
        toolEvent: fallback.toolEvent,
        providerSessionId: state.providerSessionId,
      });
      return;
    }
    if (fallback.type === "usage") {
      state.usage(fallback.usage);
      this.emitRun(running, {
        type: "usage",
        runId: running.runId,
        usage: fallback.usage,
        model: fallback.model || running.input.model || undefined,
        providerSessionId: state.providerSessionId,
      });
      return;
    }
    if (fallback.type === "stdout" || fallback.type === "stderr") {
      this.emitRun(running, {
        type: fallback.type,
        runId: running.runId,
        data: fallback.data,
        providerSessionId: state.providerSessionId,
      });
      return;
    }
    if (fallback.type === "error") {
      this.emitRun(running, {
        type: "error",
        runId: running.runId,
        message: fallback.message,
        providerSessionId: state.providerSessionId,
      });
    }
  }

  private handleExtensionResponse(running: Running, message: unknown): boolean {
    const id = rawMessageId(message);
    if (id === undefined) return false;
    const pending = running.extensionInvocations.get(String(id));
    if (!pending) return false;
    const source = eventRecord(message);
    if (!Object.prototype.hasOwnProperty.call(source, "result") && !source.error) return false;
    if (pending.timeout) clearTimeout(pending.timeout);
    running.extensionInvocations.delete(String(id));
    const error = rpcError(message);
    if (error) pending.reject(error);
    else {
      try {
        const result = eventRecord(source.result);
        const responseResult = Object.prototype.hasOwnProperty.call(result, "result")
          ? result.result
          : source.result;
        assertJsonSchemaValue(
          pending.outputSchema,
          responseResult,
          `${pending.extension}.${pending.method} output`,
        );
        pending.resolve({
          extension:
            stringProperty(result, "extension") ||
            stringProperty(eventRecord(source.params), "extension") ||
            pending.extension,
          method:
            stringProperty(result, "method") ||
            stringProperty(eventRecord(source.params), "method") ||
            pending.method,
          result: responseResult,
        });
      } catch (validationError) {
        pending.reject(
          validationError instanceof Error ? validationError : new Error(String(validationError)),
        );
      }
    }
    return true;
  }

  private cancelExtensionInvocations(running: Running, error: Error): void {
    for (const [id, pending] of running.extensionInvocations) {
      running.extensionInvocations.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private closeExtensionChannel(uiSessionId: string, error: Error): void {
    const running = this.extensionChannelsBySession.get(uiSessionId);
    if (!running) return;
    this.extensionChannelsBySession.delete(uiSessionId);
    this.cancelExtensionInvocations(running, error);
    running.connection.close();
  }

  private emitState(
    running: Running,
    state: Extract<DesktopSessionEvent, { type: "connection_state" }>["state"],
    message?: string,
  ): void {
    this.emit(running.sender, {
      type: "connection_state",
      uiSessionId: running.input.uiSessionId,
      clientRequestId: running.input.clientRequestId,
      runId: running.runId,
      providerId: running.input.providerId,
      state,
      message,
    });
  }

  private emit(sender: AspEventSender, event: DesktopSessionEvent): void {
    if (!sender.isDestroyed()) sender.send("agui:asp:event", event);
  }

  private cancelInteractions(senderId: AspEventSenderId, runId: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.senderId !== senderId || pending.runId !== runId) continue;
      this.pendingApprovals.delete(id);
      pending.resolve({ decision: "cancel", message: `ASP run ${runId} ended.` });
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.senderId !== senderId || pending.runId !== runId) continue;
      this.pendingQuestions.delete(id);
      pending.resolve({ canceled: true });
    }
  }
}
