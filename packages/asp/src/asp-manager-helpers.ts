import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  eventRecord,
  normalizeMessagePart,
  normalizeMessageParts,
  normalizeToolEvent,
  normalizeUsage,
  rawStringProperty,
  stringProperty,
  visiblePartText,
} from "./asp-protocol.js";
import type { AspTransportConnection, TransportCloseResult } from "./asp-transport.js";
import { splitProviderCommand } from "./provider-store.js";
import {
  ASP_VERSION,
  type AspRpcErrorData,
  type ApprovalRequestPayload,
  type AspApprovalDecision,
  type AspExtensionDescriptor,
  type AspExtensionInvokeInput,
  type AspExtensionInvokeResult,
  type AspInteractiveApp,
  type AspMessagePart,
  type AspMessageRecord,
  type AspProvider,
  type AspProviderCapabilities,
  type AspQuestionResponse,
  type AspToolEvent,
  type QuestionRequestPayload,
  type RunInput,
} from "./types.js";

export type Running = {
  cancelRun?: () => void;
  capabilities: AspProviderCapabilities;
  connection: AspTransportConnection;
  extensionInvocations: Map<string, PendingExtensionInvocation>;
  input: RunInput;
  pendingQuestionWaits: number;
  provider: AspProvider;
  resetRunTimeout?: () => void;
  runId: string;
  sender: AspEventSender;
  suspendRunTimeout?: () => void;
};

export type AspEventSenderId = number | string;

export type AspEventSender = {
  id: AspEventSenderId;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};

export function isEmbeddableInteractionApp(
  app: AspInteractiveApp | undefined,
): app is AspInteractiveApp {
  if (!app) return false;
  const uri = typeof app.uri === "string" ? app.uri : "";
  const resourceUri = typeof app.resourceUri === "string" ? app.resourceUri : "";
  const renderer = typeof app.renderer === "string" ? app.renderer : "";
  return Boolean(
    app.html || app.src || resourceUri || uri.startsWith("ui://") || renderer === "mcp-app",
  );
}

export type PendingApproval = {
  payload: ApprovalRequestPayload;
  runId: string;
  senderId: AspEventSenderId;
  resolve(value: { decision: AspApprovalDecision; message?: string }): void;
};

export type PendingQuestion = {
  payload: QuestionRequestPayload;
  runId: string;
  senderId: AspEventSenderId;
  resolve(value: AspQuestionResponse): void;
};

export type PendingExtensionInvocation = {
  extension: string;
  method: string;
  outputSchema?: Record<string, unknown>;
  reject(error: Error): void;
  resolve(value: AspExtensionInvokeResult): void;
  timeout?: NodeJS.Timeout;
};

export type ExtensionMethodSafety = NonNullable<
  NonNullable<AspExtensionDescriptor["methods"]>[number]["safety"]
>;
export type ExtensionMethodMap = Map<string, Map<string, ExtensionMethodSafety | undefined>>;

export const defaultTimeoutMs = 30 * 60 * 1_000;
export const queryTimeoutMs = 15_000;
export const claudeModelQueryTimeoutMs = 45_000;
export const maxCapturedChars = 5_000_000;

export function normalizeProviderForTest(provider: AspProvider): AspProvider {
  const id = provider.id.trim();
  const transport = provider.transport || "stdio";
  const commandParts = splitProviderCommand(provider.command);
  const command = commandParts[0] ?? "";
  const args = [
    ...commandParts.slice(1),
    ...(Array.isArray(provider.args) ? provider.args.map(String) : []),
  ];
  if (!id) throw new Error("Provider id is required.");
  if ((transport === "stdio" || transport === "persistent-stdio") && !command) {
    throw new Error("Provider command is required for ASP stdio.");
  }
  return {
    ...provider,
    id,
    name: provider.name.trim() || id,
    command,
    args,
    env: provider.env ?? {},
    enabled: true,
    transport,
  };
}

export function validateRunInput(input: RunInput): void {
  if (!input.uiSessionId?.trim()) throw new Error("UI session id is required.");
  if (!input.providerId?.trim()) throw new Error("ASP provider id is required.");
  if (!input.cwd?.trim()) throw new Error("Workspace is required.");
  if (!input.prompt?.trim() && !input.attachments?.length) throw new Error("Prompt is required.");
}

export function validateNegotiatedExtensions(
  provider: AspProvider,
  capabilities: AspProviderCapabilities,
  extensions: RunInput["extensions"],
): void {
  const declared = new Map(
    (capabilities.extensions ?? []).map((extension) => [extension.id, extension]),
  );
  for (const use of extensions ?? []) {
    const descriptor = declared.get(use.id);
    if (!descriptor) {
      throw new Error(`${provider.name} does not declare ASP extension ${use.id}.`);
    }
    if (
      use.version &&
      descriptor.version &&
      !compatibleExtensionVersion(use.version, descriptor.version)
    ) {
      throw new Error(
        `${provider.name} extension ${use.id} version mismatch: requested ${use.version}, reported ${descriptor.version}.`,
      );
    }
    if (descriptor.requiresCore?.length && !descriptor.requiresCore.includes(ASP_VERSION)) {
      throw new Error(
        `${provider.name} extension ${use.id} is not compatible with ASP v${ASP_VERSION}.`,
      );
    }
    const methods = stringArray(
      eventRecord(use.options).methods ??
        eventRecord(use.options).allowedMethods ??
        eventRecord(use.options).allowed_methods,
    );
    if (!methods.length) continue;
    const declaredMethods = new Set((descriptor.methods ?? []).map((method) => method.name));
    const unsupported = methods.filter((method) => !declaredMethods.has(method));
    if (unsupported.length) {
      throw new Error(
        `${provider.name} extension ${use.id} does not declare methods: ${unsupported.join(", ")}.`,
      );
    }
  }
}

export function compatibleExtensionVersion(requested: string, offered: string): boolean {
  if (requested === offered) return true;
  const requestedVersion = parseStableSemver(requested);
  const offeredVersion = parseStableSemver(offered);
  if (!requestedVersion || !offeredVersion || requestedVersion.major !== offeredVersion.major) {
    return false;
  }
  return (
    offeredVersion.minor > requestedVersion.minor ||
    (offeredVersion.minor === requestedVersion.minor &&
      offeredVersion.patch >= requestedVersion.patch)
  );
}

function parseStableSemver(
  value: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function assertExtensionInvocationAllowed(
  running: Running,
  input: AspExtensionInvokeInput,
): ExtensionMethodSafety | undefined {
  if (input.runId && input.runId !== running.runId) {
    throw new Error(`ASP extension invocation runId does not match the active run: ${input.runId}`);
  }
  const negotiated = negotiatedExtensionMethods(running.input.extensions);
  if (negotiated.size && !negotiated.has(input.extension)) {
    throw new Error(`ASP extension was not negotiated for this run: ${input.extension}`);
  }
  const negotiatedMethods = negotiated.get(input.extension);
  if (negotiatedMethods && negotiatedMethods.size && !negotiatedMethods.has(input.method)) {
    throw new Error(
      `ASP extension method was not negotiated for this run: ${input.extension}.${input.method}`,
    );
  }
  const allowed = extensionMethodMapForProvider(running.provider, running.capabilities);
  const methods = allowed.get(input.extension);
  if (!methods) {
    throw new Error(`${running.provider.name} does not declare ASP extension ${input.extension}.`);
  }
  if (!methods.has(input.method)) {
    throw new Error(
      `${running.provider.name} does not declare ASP extension method ${input.extension}.${input.method}.`,
    );
  }
  const safety = methods.get(input.method);
  if (!negotiated.size && extensionMethodRequiresNegotiation(input.extension, safety)) {
    throw new Error(
      `ASP extension method requires explicit run negotiation: ${input.extension}.${input.method}`,
    );
  }
  return safety;
}

export function negotiatedExtensionMethods(
  extensions: RunInput["extensions"],
): Map<string, Set<string> | null> {
  const negotiated = new Map<string, Set<string> | null>();
  for (const extension of extensions ?? []) {
    const id = extension.id.trim();
    if (!id) continue;
    const options = eventRecord(extension.options);
    const methods = stringArray(
      options.methods ?? options.allowedMethods ?? options.allowed_methods,
    );
    negotiated.set(id, methods.length ? new Set(methods) : null);
  }
  return negotiated;
}

export function extensionMethodMapForProvider(
  provider: AspProvider,
  capabilities: AspProviderCapabilities | undefined = provider.capabilities,
): ExtensionMethodMap {
  const allowed: ExtensionMethodMap = new Map();
  const adapter = (
    stringProperty(capabilities, "runtimeAdapter") ||
    stringProperty(provider.capabilities, "runtimeAdapter")
  ).toLowerCase();
  if (adapter === "opencode-server" || adapter === "opencode-http-sse") {
    addExtensionMethods(allowed, [
      extensionDescriptor("asp.ext.agents", [
        { name: "list_agents", safety: "read" },
        { name: "select_agent", safety: "write" },
        { name: "invoke_agent", safety: "approval_required" },
        { name: "cancel_agent", safety: "write" },
      ]),
      extensionDescriptor("asp.ext.run-control", [
        { name: "steer", safety: "write" },
        { name: "follow_up", safety: "write" },
        { name: "compact", safety: "write" },
        { name: "set_session_title", safety: "write" },
        { name: "abort_current_step", safety: "write" },
      ]),
      extensionDescriptor("asp.ext.session-state", [
        { name: "get_state", safety: "read" },
        { name: "get_messages", safety: "read" },
      ]),
      extensionDescriptor("asp.ext.runtime", [{ name: "get_runtime", safety: "read" }]),
      extensionDescriptor("vendor.opencode.server", [
        { name: "raw_request", safety: "approval_required" },
      ]),
    ]);
  } else if (adapter === "pi-rpc" || adapter === "pi-coding-agent-rpc") {
    addExtensionMethods(allowed, [
      extensionDescriptor("asp.ext.run-control", [
        { name: "steer", safety: "write" },
        { name: "follow_up", safety: "write" },
        { name: "set_queue_mode", safety: "write" },
        { name: "compact", safety: "write" },
        { name: "set_model", safety: "write" },
        { name: "cycle_model", safety: "write" },
        { name: "set_effort", safety: "write" },
        { name: "cycle_effort", safety: "write" },
        { name: "abort_current_step", safety: "write" },
      ]),
      extensionDescriptor("asp.ext.session-state", [
        { name: "get_state", safety: "read" },
        { name: "get_messages", safety: "read" },
      ]),
      extensionDescriptor("vendor.pi.rpc", [{ name: "raw_command", safety: "approval_required" }]),
    ]);
  } else if (adapter === "codex-app-server") {
    addExtensionMethods(allowed, [
      extensionDescriptor("asp.ext.run-control", [
        { name: "follow_up", safety: "write" },
        { name: "compact", safety: "write" },
        { name: "set_model", safety: "write" },
        { name: "set_effort", safety: "write" },
        { name: "set_session_title", safety: "write" },
        { name: "abort_current_step", safety: "write" },
      ]),
      extensionDescriptor("asp.ext.permissions", [
        { name: "get_policy", safety: "read" },
        { name: "set_policy", safety: "approval_required" },
      ]),
      extensionDescriptor("asp.ext.session-state", [
        { name: "get_state", safety: "read" },
        { name: "get_messages", safety: "read" },
      ]),
      extensionDescriptor("asp.ext.runtime", [{ name: "get_runtime", safety: "read" }]),
      extensionDescriptor("vendor.codex.app-server", [
        { name: "raw_request", safety: "approval_required" },
      ]),
    ]);
  } else if (adapter === "claude-code-stream-json") {
    addExtensionMethods(allowed, [
      extensionDescriptor("asp.ext.agents", [
        { name: "list_agents", safety: "read" },
        { name: "select_agent", safety: "write" },
        { name: "invoke_agent", safety: "approval_required" },
        { name: "cancel_agent", safety: "write" },
      ]),
      extensionDescriptor("asp.ext.hooks", [
        { name: "list_hooks", safety: "read" },
        { name: "set_hooks", safety: "approval_required" },
      ]),
      extensionDescriptor("asp.ext.permissions", [
        { name: "get_policy", safety: "read" },
        { name: "set_policy", safety: "approval_required" },
      ]),
      extensionDescriptor("asp.ext.run-control", [
        { name: "steer", safety: "write" },
        { name: "follow_up", safety: "write" },
        { name: "abort_current_step", safety: "write" },
      ]),
      extensionDescriptor("asp.ext.session-state", [
        { name: "get_state", safety: "read" },
        { name: "get_messages", safety: "read" },
      ]),
      extensionDescriptor("asp.ext.runtime", [{ name: "get_runtime", safety: "read" }]),
      extensionDescriptor("vendor.claude.cli", [
        { name: "raw_input", safety: "approval_required" },
      ]),
    ]);
  }
  addExtensionMethods(allowed, provider.capabilities?.extensions);
  if (capabilities !== provider.capabilities)
    addExtensionMethods(allowed, capabilities?.extensions);
  return allowed;
}

export function assertProtocolCompatible(
  provider: AspProvider,
  capabilities: AspProviderCapabilities,
): void {
  const versions = capabilities.protocolVersions ?? [];
  if (!versions.includes(ASP_VERSION)) {
    throw new Error(
      `${provider.name} does not support ASP v${ASP_VERSION}${versions.length ? ` (reported: ${versions.join(", ")})` : ""}.`,
    );
  }
}

export function extensionDescriptor(
  id: string,
  methods: Array<{ name: string; safety?: ExtensionMethodSafety }>,
): AspExtensionDescriptor {
  return {
    id,
    version: "0.1.0",
    stability: id.startsWith("vendor.") ? "vendor" : "experimental",
    methods,
  };
}

export function addExtensionMethods(
  target: ExtensionMethodMap,
  extensions: AspExtensionDescriptor[] | undefined,
): void {
  for (const extension of extensions ?? []) {
    const id = extension.id.trim();
    if (!id) continue;
    const methods = target.get(id) ?? new Map<string, ExtensionMethodSafety | undefined>();
    for (const method of extension.methods ?? []) {
      const name = method.name.trim();
      if (name) methods.set(name, method.safety);
    }
    target.set(id, methods);
  }
}

export function extensionMethodRequiresNegotiation(
  extension: string,
  safety: ExtensionMethodSafety | undefined,
): boolean {
  return extension.startsWith("vendor.") || safety === "approval_required";
}

export function requireDirectory(value: string): string {
  const resolved = path.resolve(value);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error(`Workspace is not a directory: ${resolved}`);
  return resolved;
}

export function automaticApproval(
  mode: RunInput["approvalMode"],
  scope: string | undefined,
  method: string,
): AspApprovalDecision | undefined {
  if (mode === "full-auto") return "allow-session";
  if (mode !== "auto-edit") return undefined;
  const haystack = `${scope ?? ""} ${method}`.toLowerCase();
  return /(file|filesystem|edit|write|patch|mkdir|move|rename)/.test(haystack)
    ? "allow-session"
    : undefined;
}

export function approvalOptions(event: Record<string, unknown>): AspApprovalDecision[] {
  const raw = event.options ?? event.approvalOptions ?? event.decisions;
  const values = Array.isArray(raw)
    ? raw
        .map((item) =>
          normalizeApprovalDecision(
            typeof item === "string"
              ? item
              : stringProperty(item, "decision") || stringProperty(item, "id"),
          ),
        )
        .filter((item): item is AspApprovalDecision => Boolean(item))
    : [];
  return values.length ? values : ["allow", "allow-session", "allow-always", "deny", "cancel"];
}

export function normalizeApprovalDecision(value: unknown): AspApprovalDecision | undefined {
  const decision = String(value ?? "").trim();
  if (decision === "allow" || decision === "deny" || decision === "cancel") return decision;
  if (decision === "allow-session" || decision === "allowForSession" || decision === "session") {
    return "allow-session";
  }
  if (
    decision === "allow-always" ||
    decision === "always-allow" ||
    decision === "allowAlways" ||
    decision === "always"
  ) {
    return "allow-always";
  }
  return undefined;
}

export function normalizeMessageRecords(value: unknown): AspMessageRecord[] {
  const source = eventRecord(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(source.messages)
      ? source.messages
      : Array.isArray(source.history)
        ? source.history
        : [];
  return items
    .map((item): AspMessageRecord | null => {
      const message = eventRecord(item);
      const roleValue = stringProperty(message, "role");
      if (roleValue !== "assistant" && roleValue !== "user") return null;
      const parts = normalizeMessageParts(message.parts ?? message.content);
      const rawToolEvents = message.toolEvents ?? message.tool_events ?? message.tools;
      const toolEvents = Array.isArray(rawToolEvents) ? rawToolEvents.map(normalizeToolEvent) : [];
      const usage = normalizeUsage(
        message.usage ??
          message.tokenUsage ??
          message.token_usage ??
          eventRecord(message.info).usage ??
          message,
      );
      const content =
        rawStringProperty(message, "content") ??
        rawStringProperty(message, "text") ??
        parts.map(visiblePartText).join("");
      return {
        id: stringProperty(message, "id") || randomUUID(),
        role: roleValue,
        content,
        createdAt:
          numberProperty(message, "createdAt") ??
          numberProperty(message, "created_at") ??
          Date.now(),
        parts: parts.length ? parts : undefined,
        toolEvents: toolEvents.length ? toolEvents : undefined,
        usage,
        metadata: Object.keys(eventRecord(message.metadata)).length
          ? eventRecord(message.metadata)
          : undefined,
      };
    })
    .filter((message): message is AspMessageRecord => Boolean(message));
}

export function responseValue(message: unknown): unknown | undefined {
  const source = eventRecord(message);
  return Object.prototype.hasOwnProperty.call(source, "result") ? source.result : undefined;
}

export class AspProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: AspRpcErrorData,
  ) {
    super(message);
    this.name = "AspProtocolError";
  }
}

export function rpcError(message: unknown): AspProtocolError | undefined {
  const error = eventRecord(eventRecord(message).error);
  if (!Object.keys(error).length) return undefined;
  const code = numberProperty(error, "code") ?? -32603;
  const data = eventRecord(error.data) as AspRpcErrorData;
  return new AspProtocolError(
    stringProperty(error, "message") || String(code) || "ASP request failed.",
    code,
    Object.keys(data).length ? data : undefined,
  );
}

export function eventError(event: Record<string, unknown>): string {
  return (
    stringProperty(event, "message") ||
    stringProperty(event, "error") ||
    stringProperty(eventRecord(event.error), "message")
  );
}

export function booleanProperty(value: unknown, key: string): boolean | undefined {
  const result = eventRecord(value)[key];
  return typeof result === "boolean" ? result : undefined;
}

export function numberProperty(value: unknown, key: string): number | undefined {
  const raw = eventRecord(value)[key];
  const result = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(result) ? result : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function upsertPart(parts: AspMessagePart[], next: AspMessagePart): void {
  const index = parts.findIndex((part) => part.id === next.id);
  if (index >= 0) parts[index] = next;
  else parts.push(next);
}

export function upsertTool(tools: AspToolEvent[], next: AspToolEvent): void {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index >= 0) tools[index] = { ...tools[index], ...next };
  else tools.push(next);
}

export function successfulClose(close: TransportCloseResult): Record<string, unknown> {
  return { success: true, exitCode: close.exitCode ?? 0 };
}

export function formatClose(close: TransportCloseResult): string {
  if (close.signal) return `signal ${close.signal}`;
  if (close.exitCode !== undefined) return `code ${close.exitCode}`;
  if (close.code !== undefined) {
    return close.reason ? `close code ${close.code} (${close.reason})` : `close code ${close.code}`;
  }
  return "unknown close state";
}

export function appendCaptured(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > maxCapturedChars ? next.slice(-maxCapturedChars) : next;
}

export function providerCloseError(
  provider: AspProvider,
  close: TransportCloseResult,
  action: string,
  stdout: string,
  stderr: string,
): Error {
  const diagnostics = closeDiagnostics(stdout, stderr);
  const piHint = isPiProvider(provider)
    ? "Pi did not return a structured RPC error before exiting. Run `pi --mode rpc` in this workspace to see the underlying Pi startup/authentication error, and verify Pi is logged in or has an API key configured."
    : "";
  const codexProfileHint = codexProfileMissingHint(provider, diagnostics);
  return new Error(
    [
      `${provider.name} exited before ${action} (${formatClose(close)}).`,
      diagnostics,
      codexProfileHint,
      diagnostics ? "" : piHint,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function closeDiagnostics(stdout: string, stderr: string): string {
  const stderrText = stderr.trim();
  const stdoutText = stdout.trim();
  if (stderrText && stdoutText) return `stderr:\n${stderrText}\nstdout:\n${stdoutText}`;
  return stderrText || stdoutText;
}

export function isPiProvider(provider: AspProvider): boolean {
  return stringProperty(provider.capabilities, "runtimeAdapter").toLowerCase() === "pi-rpc";
}

export function modelListQueryTimeoutMs(provider: AspProvider): number {
  return isClaudeCodeProvider(provider) ? claudeModelQueryTimeoutMs : queryTimeoutMs;
}

export function isClaudeCodeProvider(provider: AspProvider): boolean {
  return (
    stringProperty(provider.capabilities, "runtimeAdapter").toLowerCase() ===
    "claude-code-stream-json"
  );
}

export function codexProfileMissingHint(provider: AspProvider, diagnostics: string): string {
  if (
    !isCodexProvider(provider) ||
    !/Profile\s+"[^"]+"\s+was not found or is disabled/i.test(diagnostics)
  ) {
    return "";
  }
  return [
    "Codex failed while loading a CLI config profile. Check this agent's Codex startup command and CODEX_HOME; the selected profile file must exist and be enabled.",
    `Agent command: ${provider.command}`,
  ].join("\n");
}

export function isCodexProvider(provider: AspProvider): boolean {
  const signature = [
    provider.id,
    provider.name,
    provider.command,
    stringProperty(provider.capabilities, "runtimeAdapter"),
    stringProperty(provider.capabilities, "wireProtocol"),
  ]
    .join(" ")
    .toLowerCase();
  return signature.includes("codex") || signature.includes("app-server");
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
