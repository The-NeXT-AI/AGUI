import { desktopApi, type BrowserViewBounds } from "@/asp/desktop-api";
import { useChatStore } from "./chat-store";
import type { InteractiveAppEmbed, McpAppSessionState } from "./types";

const MCP_APP_BRIDGE_SCRIPT = `
(() => {
  const context = __MCP_APP_CONTEXT__;
  const pending = new Map();
  let seq = 0;
  function postToHost(message) {
    if (window.aguiInteractiveApp && typeof window.aguiInteractiveApp.postMessage === "function") {
      window.aguiInteractiveApp.postMessage(message);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, "*");
    }
  }
  function request(method, params) {
    const id = "agui-mcp-" + Date.now().toString(36) + "-" + (++seq).toString(36);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      postToHost({ jsonrpc: "2.0", id, method, params });
    });
  }
  function notify(method, params) {
    postToHost({ jsonrpc: "2.0", method, params });
  }
  window.mcp = window.mcp || { request, notify };
  window.openai = window.openai || {
    get toolInput() { return context.toolInput; },
    get toolOutput() { return context.toolOutput; },
    get toolResponseMetadata() { return context.toolResponseMetadata; },
    get widgetState() { return context.widgetState; },
    get modelContext() { return context.modelContext; },
    get stateVersion() { return context.stateVersion || 0; },
    get displayMode() { return context.displayMode || "inline"; },
    get theme() { return context.theme || "dark"; },
    updateModelContext(nextContext) {
      const patch = nextContext && typeof nextContext === "object"
        ? nextContext
        : { content: [{ type: "text", text: String(nextContext ?? "") }] };
      if (Object.prototype.hasOwnProperty.call(patch, "widgetState")) context.widgetState = patch.widgetState;
      if (Object.prototype.hasOwnProperty.call(patch, "state")) context.widgetState = patch.state;
      if (
        Object.prototype.hasOwnProperty.call(patch, "content") ||
        Object.prototype.hasOwnProperty.call(patch, "structuredContent")
      ) {
        context.modelContext = {
          content: patch.content,
          structuredContent: patch.structuredContent,
        };
      }
      return request("ui/update-model-context", patch);
    },
    setWidgetState(state) {
      context.widgetState = state;
      return window.openai.updateModelContext({ widgetState: state });
    },
    callTool(name, args) {
      return request("tools/call", { name, arguments: args });
    },
    callServerTool(requestOrName, args) {
      const payload = typeof requestOrName === "string" ? { name: requestOrName, arguments: args } : requestOrName;
      return request("tools/call", payload || {});
    },
    readResource(uri) {
      return request("resources/read", { uri });
    },
    sendFollowUpMessage(message) {
      return request("ui/message", typeof message === "string" ? { message } : message);
    },
    openExternal(url) {
      return request("ui/open-external", { url });
    },
    openLink(url) {
      return request("ui/open-link", { url });
    },
    requestDisplayMode(mode) {
      return request("ui/request-display-mode", { mode });
    }
  };
  function handleHostMessage(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    if (Object.prototype.hasOwnProperty.call(message, "id") && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "Interactive app bridge error"));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "ui/initialize") {
      Object.assign(context, message.params || {});
    } else if (message.method === "ui/notifications/tool-input") {
      const params = message.params || {};
      context.toolInput = params && typeof params === "object" && Object.prototype.hasOwnProperty.call(params, "arguments")
        ? params.arguments
        : params;
    } else if (message.method === "ui/notifications/tool-result") {
      context.toolOutput = message.params && (message.params.structuredContent ?? message.params);
      context.toolResponseMetadata = message.params && (message.params._meta ?? message.params.metadata);
    } else if (message.method === "ui/notifications/state-changed") {
      const params = message.params || {};
      if (Object.prototype.hasOwnProperty.call(params, "widgetState")) context.widgetState = params.widgetState;
      if (Object.prototype.hasOwnProperty.call(params, "modelContext")) context.modelContext = params.modelContext;
      if (Object.prototype.hasOwnProperty.call(params, "version")) context.stateVersion = params.version;
    }
    window.dispatchEvent(new CustomEvent("mcp:notification", { detail: message }));
  }
  if (
    window.aguiInteractiveApp &&
    typeof window.aguiInteractiveApp.onMessage === "function"
  ) {
    window.aguiInteractiveApp.onMessage(handleHostMessage);
  } else {
    window.addEventListener("message", (event) => {
      if (window.parent !== window && event.source !== window.parent) return;
      if (window.parent === window && event.source !== window) return;
      handleHostMessage(event.data);
    });
  }
})();
`;

export type McpAppMessageTarget =
  { kind: "iframe"; iframe: HTMLIFrameElement; origin?: string } | { kind: "native"; id: string };

export type McpAppStatePatch = {
  modelContext?: {
    content?: unknown[];
    structuredContent?: Record<string, unknown>;
  } | null;
  widgetState?: unknown;
};

export type McpAppRequestContext = {
  app: InteractiveAppEmbed;
  appInstanceId: string;
  appStateKey: string;
  documentId?: string;
  resourceUri?: string;
  server: string;
  stateVersion: number;
};

const mcpAppFrames = new Map<string, Set<McpAppMessageTarget>>();

export function buildMcpAppDocument(
  html: string,
  context: Record<string, unknown>,
  baseHref?: string,
): string {
  const base =
    baseHref && !baseHref.startsWith("ui://")
      ? `<base href="${escapeAttribute(baseHref)}" target="_blank">`
      : `<base target="_blank">`;
  const style = `<style>html,body{margin:0;min-height:100%;background:transparent;color:inherit;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}*{box-sizing:border-box;}</style>`;
  const bridge = `<script>${buildMcpAppBridgeScript(context)}</script>`;
  const injection = `${base}${style}${bridge}`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${injection}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${injection}</head>`);
  }
  return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
}

export function buildMcpAppBridgeScript(context: Record<string, unknown>): string {
  return MCP_APP_BRIDGE_SCRIPT.replace("__MCP_APP_CONTEXT__", safeJson(context));
}

export function handleMcpAppRpc(
  target: McpAppMessageTarget,
  payload: Record<string, unknown>,
  handlers: {
    onResize(height: number): void;
    onModelContext(params: unknown): McpAppSessionState | undefined;
    context: Record<string, unknown>;
    onHostMessage(params: unknown): void;
    invokeExtension(method: string, params: unknown): Promise<unknown>;
  },
) {
  const method = stringPayload(payload.method);
  const params = asRecord(payload.params);
  const id = payload.id;
  if (method === "initialize" || method === "ui/initialize") {
    respondToMcpApp(target, id, {
      protocolVersion: "2026-01-26",
      serverInfo: { name: "agui", version: "0.1.0" },
      capabilities: {
        resources: { read: true },
        tools: { call: true },
        displayModes: ["inline", "fullscreen"],
        state: { notifications: true },
        updateModelContext: { content: true, structuredContent: true },
      },
      hostContext: {
        appInstanceId: handlers.context.appInstanceId,
        appStateKey: handlers.context.appStateKey,
        displayMode: handlers.context.displayMode || "inline",
        modelContext: handlers.context.modelContext,
        stateVersion: handlers.context.stateVersion,
        theme: handlers.context.theme || currentTheme(),
        widgetState: handlers.context.widgetState,
      },
    });
    postMcpNotification(target, "ui/notifications/tool-input", {
      arguments: handlers.context.toolInput ?? {},
    });
    postMcpNotification(target, "ui/notifications/tool-result", {
      content: [],
      structuredContent: handlers.context.toolOutput,
      _meta: handlers.context.toolResponseMetadata,
    });
    postMcpNotification(target, "ui/notifications/host-context-changed", {
      displayMode: handlers.context.displayMode || "inline",
      theme: handlers.context.theme || currentTheme(),
    });
    return;
  }
  if (method === "ping") {
    respondToMcpApp(target, id, {});
    return;
  }
  if (
    method === "ui/resize" ||
    method === "ui/request-size" ||
    method === "ui/request-resize" ||
    method === "ui/notifications/size-changed"
  ) {
    const height = numberPayload(params.height) ?? numberPayload(params.maxHeight);
    if (height) handlers.onResize(height);
    respondToMcpApp(target, id, { ok: true });
    return;
  }
  if (method === "ui/update-model-context") {
    try {
      const state = handlers.onModelContext(payload.params);
      respondToMcpApp(target, id, {
        updatedAt: state?.updatedAt,
        version: state?.version,
      });
    } catch (error) {
      respondToMcpApp(target, id, undefined, {
        code: -32602,
        message: error instanceof Error ? error.message : "Invalid interactive app state.",
      });
    }
    return;
  }
  if (method === "ui/open-external" || method === "ui/open-link") {
    const url = stringPayload(params.url);
    if (isSafeExternalUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
    respondToMcpApp(target, id, {});
    return;
  }
  if (method === "ui/message") {
    try {
      handlers.onHostMessage(payload.params);
      respondToMcpApp(target, id, { ok: true });
    } catch (error) {
      respondToMcpApp(target, id, undefined, {
        code: -32603,
        message:
          error instanceof Error ? error.message : "Interactive app host message was rejected.",
      });
    }
    return;
  }
  if (method === "ui/request-display-mode") {
    const requested = stringPayload(params.mode);
    respondToMcpApp(target, id, { mode: requested === "fullscreen" ? "fullscreen" : "inline" });
    return;
  }
  if (method === "notifications/message") {
    respondToMcpApp(target, id, {});
    return;
  }
  if (
    method === "ui/notifications/initialized" ||
    method === "ui/notifications/error" ||
    method === "ui/notifications/host-context-changed" ||
    method === "ui/resource-teardown"
  ) {
    respondToMcpApp(target, id, {});
    return;
  }
  if (method === "tools/call" || method === "resources/read") {
    void handlers
      .invokeExtension(method, payload.params)
      .then((result) => respondToMcpApp(target, id, result))
      .catch((error) =>
        respondToMcpApp(target, id, undefined, {
          code: -32601,
          message: error instanceof Error ? error.message : "Interactive app tool call failed.",
        }),
      );
  }
}

export function postMcpNotification(target: McpAppMessageTarget, method: string, params: unknown) {
  postMcpAppMessage(target, { jsonrpc: "2.0", method, params });
}

export function clampAppHeight(value?: number): number {
  if (!value || !Number.isFinite(value)) return 360;
  return Math.min(900, Math.max(160, Math.round(value)));
}

export function interactiveAppViewBounds(element: HTMLElement | null): BrowserViewBounds {
  if (!element) return hiddenInteractiveAppViewBounds();
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  let fullyVisible =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0;
  let parent = element.parentElement;
  while (fullyVisible && parent && parent !== document.body) {
    const parentStyle = getComputedStyle(parent);
    const clips =
      /(auto|scroll|hidden|clip)/.test(parentStyle.overflow) ||
      /(auto|scroll|hidden|clip)/.test(parentStyle.overflowX) ||
      /(auto|scroll|hidden|clip)/.test(parentStyle.overflowY);
    if (clips) {
      const parentRect = parent.getBoundingClientRect();
      fullyVisible =
        rect.top >= parentRect.top &&
        rect.left >= parentRect.left &&
        rect.bottom <= parentRect.bottom &&
        rect.right <= parentRect.right;
    }
    parent = parent.parentElement;
  }
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    visible: fullyVisible,
  };
}

export function hiddenInteractiveAppViewBounds(): BrowserViewBounds {
  return { x: 0, y: 0, width: 0, height: 0, visible: false };
}

export function registerMcpAppFrame(key: string, target: McpAppMessageTarget): () => void {
  const frames = mcpAppFrames.get(key) ?? new Set<McpAppMessageTarget>();
  frames.add(target);
  mcpAppFrames.set(key, frames);
  return () => {
    frames.delete(target);
    if (!frames.size) mcpAppFrames.delete(key);
  };
}

export function broadcastMcpAppState(
  key: string,
  source: McpAppMessageTarget,
  state: McpAppSessionState,
): void {
  for (const target of mcpAppFrames.get(key) ?? []) {
    if (sameMcpAppTarget(target, source)) continue;
    postMcpNotification(target, "ui/notifications/state-changed", {
      documentId: state.documentId,
      key: state.key,
      modelContext: state.modelContext,
      resourceUri: state.resourceUri,
      server: state.server,
      updatedAt: state.updatedAt,
      version: state.version,
      widgetState: state.widgetState,
    });
  }
}

export function currentMcpAppStateVersion(sessionId: string, key: string): number {
  return (
    useChatStore.getState().sessions.find((session) => session.id === sessionId)?.mcpAppState?.[key]
      ?.version ?? 0
  );
}

export function mcpAppStateKey(input: {
  artifactId?: string;
  documentId?: string;
  resourceUri?: string;
  server?: string;
  title?: string;
  uri?: string;
}): string {
  return [
    input.server || "local",
    input.resourceUri || input.uri || input.artifactId || input.title || "app",
    input.documentId,
  ]
    .filter(Boolean)
    .map((item) => String(item).trim())
    .join("|")
    .slice(0, 512);
}

export function mcpAppDocumentId(
  app: InteractiveAppEmbed,
  source: { artifactId?: string; path?: string; uri?: string },
): string | undefined {
  const metadata = asRecord(app.metadata);
  const appContext = asRecord(metadata.appContext ?? metadata.app_context);
  const toolInput = asRecord(app.toolInput);
  return (
    stringPayload(metadata.documentId) ||
    stringPayload(metadata.document_id) ||
    stringPayload(appContext.documentId) ||
    stringPayload(appContext.document_id) ||
    stringPayload(toolInput.documentId) ||
    stringPayload(toolInput.document_id) ||
    stringPayload(toolInput.path) ||
    source.path ||
    source.artifactId ||
    source.uri ||
    undefined
  );
}

export function mcpAppStatePatchFromContext(params: unknown): McpAppStatePatch | undefined {
  const source = asRecord(params);
  const patch: McpAppStatePatch = {};
  if (Object.prototype.hasOwnProperty.call(source, "widgetState")) {
    patch.widgetState = source.widgetState;
  } else if (Object.prototype.hasOwnProperty.call(source, "widget_state")) {
    patch.widgetState = source.widget_state;
  } else if (Object.prototype.hasOwnProperty.call(source, "state")) {
    patch.widgetState = source.state;
  } else if (Object.prototype.hasOwnProperty.call(source, "appState")) {
    patch.widgetState = source.appState;
  } else if (Object.prototype.hasOwnProperty.call(source, "app_state")) {
    patch.widgetState = source.app_state;
  }
  const explicitContext = firstDefined(source.modelContext, source.model_context);
  if (explicitContext === null) patch.modelContext = null;
  const contextSource = asRecord(explicitContext ?? source);
  const content = Array.isArray(contextSource.content) ? contextSource.content : undefined;
  const structuredContent = asOptionalRecord(
    contextSource.structuredContent ?? contextSource.structured_content,
  );
  if (content || structuredContent) {
    patch.modelContext = {
      ...(content ? { content } : {}),
      ...(structuredContent ? { structuredContent } : {}),
    };
  }
  return Object.keys(patch).length ? patch : undefined;
}

export function mcpAppStatePatchFromToolResult(result: unknown): McpAppStatePatch | undefined {
  const source = asRecord(result);
  const meta = asRecord(source._meta ?? source.meta);
  const patch: McpAppStatePatch = {};
  const widgetState = firstDefined(
    meta.widgetState,
    meta.widget_state,
    meta.appState,
    meta.app_state,
    asRecord(source.structuredContent).widgetState,
  );
  if (widgetState !== undefined) patch.widgetState = widgetState;
  const contextSource = asRecord(
    meta.modelContext ?? meta.model_context ?? meta["ui/modelContext"] ?? meta["ui.modelContext"],
  );
  const content = Array.isArray(contextSource.content) ? contextSource.content : undefined;
  const structuredContent = asOptionalRecord(
    contextSource.structuredContent ?? contextSource.structured_content,
  );
  if (content || structuredContent) {
    patch.modelContext = {
      ...(content ? { content } : {}),
      ...(structuredContent ? { structuredContent } : {}),
    };
  }
  return Object.keys(patch).length ? patch : undefined;
}

export function mcpAppExtensionPayload(
  method: string,
  params: unknown,
  context: McpAppRequestContext,
): Record<string, unknown> {
  const source = asRecord(params);
  const metadata = asRecord(context.app.metadata);
  const appContext = {
    ...asRecord(metadata.appContext ?? metadata.app_context),
    appInstanceId: context.appInstanceId,
    appStateKey: context.appStateKey,
    documentId: context.documentId,
    resourceUri: context.resourceUri,
    server: context.server,
    stateVersion: context.stateVersion,
  };
  if (method === "tools/call") {
    const name = stringPayload(source.name) || stringPayload(source.tool);
    if (!name) throw new Error("Interactive app tools/call requires a tool name.");
    if (!mcpAppToolAllowed(context.app, name)) {
      throw new Error(`Interactive app tool is not allowed by this resource: ${name}`);
    }
    return {
      ...source,
      _meta: {
        ...asRecord(source._meta ?? source.meta),
        appContext,
      },
      arguments: source.arguments ?? source.args ?? source.input ?? {},
      name,
      resourceUri: context.resourceUri,
      server: context.server,
      tool: name,
    };
  }
  if (method === "resources/read") {
    const requestedUri =
      stringPayload(source.uri) ||
      stringPayload(source.resourceUri) ||
      stringPayload(source.resource_uri) ||
      context.resourceUri;
    if (!requestedUri) throw new Error("Interactive app resources/read requires a resource URI.");
    if (!mcpAppResourceAllowed(context.app, requestedUri, context.resourceUri)) {
      throw new Error(`Interactive app resource is not allowed by this resource: ${requestedUri}`);
    }
    return {
      ...source,
      appContext: {
        ...appContext,
        requestedResourceUri: requestedUri,
      },
      resourceUri: requestedUri,
      server: context.server,
      uri: requestedUri,
    };
  }
  return {
    ...source,
    appContext,
    resourceUri: context.resourceUri,
    server: context.server,
  };
}

export function mcpAppServer(app: InteractiveAppEmbed): string | undefined {
  const metadata = asRecord(app.metadata);
  const appContext = asRecord(metadata.appContext ?? metadata.app_context);
  return (
    stringPayload(app.server) ||
    stringPayload(metadata.server) ||
    stringPayload(metadata.serverName) ||
    stringPayload(appContext.server) ||
    stringPayload(asRecord(metadata.app).server) ||
    undefined
  );
}

export function mcpAppAllowsHostMessage(app: InteractiveAppEmbed): boolean {
  const appRecord = asRecord(app);
  const metadata = asRecord(app.metadata);
  const embeddedApp = asRecord(metadata.app);
  const appContext = asRecord(metadata.appContext ?? metadata.app_context);
  const ui = asRecord(metadata.ui);
  const meta = asRecord(metadata._meta);
  const metaUi = asRecord(meta.ui);
  return booleanPayload(
    appRecord.allowFollowUpMessage,
    appRecord.allowFollowUpMessages,
    appRecord.allowHostMessage,
    appRecord.allowHostMessages,
    appRecord.allow_follow_up_message,
    appRecord.allow_follow_up_messages,
    embeddedApp.allowFollowUpMessage,
    embeddedApp.allowFollowUpMessages,
    embeddedApp.allowHostMessage,
    embeddedApp.allowHostMessages,
    embeddedApp.allow_follow_up_message,
    embeddedApp.allow_follow_up_messages,
    metadata.allowFollowUpMessage,
    metadata.allowFollowUpMessages,
    metadata.allowHostMessage,
    metadata.allowHostMessages,
    metadata.allow_follow_up_message,
    metadata.allow_follow_up_messages,
    metadata["openai/allowFollowUpMessage"],
    metadata["ui.allowFollowUpMessage"],
    appContext.allowFollowUpMessage,
    appContext.allowFollowUpMessages,
    appContext.allowHostMessage,
    appContext.allowHostMessages,
    ui.allowFollowUpMessage,
    ui.allowFollowUpMessages,
    metaUi.allowFollowUpMessage,
    metaUi.allowFollowUpMessages,
  );
}

export function userFacingMcpAppHeading(
  value: string | undefined,
  label: string | undefined,
): string {
  const normalized = value?.trim();
  if (!normalized || isInternalMcpAppLabel(normalized)) return label || "Interactive content";
  return normalized;
}

export function htmlFromMcpResource(value: unknown, preferredUri?: string): string | undefined {
  const contents = Array.isArray(asRecord(value).contents)
    ? (asRecord(value).contents as unknown[]).map(asRecord)
    : [];
  const content =
    contents.find((item) => preferredUri && stringPayload(item.uri) === preferredUri) ||
    contents[0];
  if (!content) return undefined;
  const text = stringPayload(content.text);
  if (text) return text;
  const blob = stringPayload(content.blob);
  if (!blob) return undefined;
  try {
    return decodeURIComponent(
      Array.from(atob(blob), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(
        "",
      ),
    );
  } catch {
    try {
      return atob(blob);
    } catch {
      return undefined;
    }
  }
}

export function currentTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function numberPayload(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function respondToMcpApp(
  target: McpAppMessageTarget,
  id: unknown,
  result?: unknown,
  error?: { code: number; message: string },
) {
  if (id === undefined || id === null) return;
  postMcpAppMessage(target, error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
}

function postMcpAppMessage(target: McpAppMessageTarget, message: unknown): void {
  if (target.kind === "iframe") {
    target.iframe.contentWindow?.postMessage(message, target.origin ?? "*");
    return;
  }
  void desktopApi()
    ?.interactiveApp?.postMessage({ id: target.id, message })
    .catch(() => undefined);
}

function sameMcpAppTarget(a: McpAppMessageTarget, b: McpAppMessageTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "iframe"
    ? a.iframe === (b as { kind: "iframe"; iframe: HTMLIFrameElement }).iframe
    : a.id === (b as { kind: "native"; id: string }).id;
}

function mcpAppAllowedTools(app: InteractiveAppEmbed): string[] {
  const appRecord = asRecord(app);
  const metadata = asRecord(app.metadata);
  const embeddedApp = asRecord(metadata.app);
  const appContext = asRecord(metadata.appContext ?? metadata.app_context);
  const ui = asRecord(metadata.ui);
  const meta = asRecord(metadata._meta);
  const metaUi = asRecord(meta.ui);
  return uniqueStrings([
    ...stringArray(appRecord.allowedTools),
    ...stringArray(appRecord.allowed_tools),
    ...stringArray(embeddedApp.allowedTools),
    ...stringArray(embeddedApp.allowed_tools),
    ...stringArray(metadata.allowedTools),
    ...stringArray(metadata.allowed_tools),
    ...stringArray(appContext.allowedTools),
    ...stringArray(appContext.allowed_tools),
    ...stringArray(ui.allowedTools),
    ...stringArray(metaUi.allowedTools),
  ]);
}

function mcpAppToolAllowed(app: InteractiveAppEmbed, name: string): boolean {
  return mcpAppAllowedTools(app).some((pattern) => mcpAppPatternMatches(pattern, name));
}

function mcpAppResourceAllowed(
  app: InteractiveAppEmbed,
  requestedUri: string,
  currentResourceUri?: string,
): boolean {
  const allowed = mcpAppAllowedResources(app, currentResourceUri);
  return allowed.some((pattern) => mcpAppPatternMatches(pattern, requestedUri));
}

function mcpAppAllowedResources(app: InteractiveAppEmbed, currentResourceUri?: string): string[] {
  const appRecord = asRecord(app);
  const metadata = asRecord(app.metadata);
  const embeddedApp = asRecord(metadata.app);
  const appContext = asRecord(metadata.appContext ?? metadata.app_context);
  const ui = asRecord(metadata.ui);
  const meta = asRecord(metadata._meta);
  const metaUi = asRecord(meta.ui);
  return uniqueStrings([
    currentResourceUri || "",
    stringPayload(appRecord.resourceUri),
    stringPayload(appRecord.resource_uri),
    stringPayload(embeddedApp.resourceUri),
    stringPayload(embeddedApp.resource_uri),
    ...stringArray(appRecord.allowedResources),
    ...stringArray(appRecord.allowed_resources),
    ...stringArray(embeddedApp.allowedResources),
    ...stringArray(embeddedApp.allowed_resources),
    stringPayload(metadata.resourceUri),
    stringPayload(metadata.resource_uri),
    stringPayload(metaUi.resourceUri),
    ...stringArray(metadata.allowedResources),
    ...stringArray(metadata.allowed_resources),
    ...stringArray(appContext.allowedResources),
    ...stringArray(appContext.allowed_resources),
    ...stringArray(ui.allowedResources),
    ...stringArray(metaUi.allowedResources),
  ]);
}

function isInternalMcpAppLabel(value: string): boolean {
  return /^(mcp app|agent interaction)$/i.test(value.trim());
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isSafeExternalUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length ? record : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function booleanPayload(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return false;
}

function mcpAppPatternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringPayload).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(stringPayload).filter(Boolean))];
}
