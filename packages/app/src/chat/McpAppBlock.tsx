import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { desktopApi, type InteractiveAppEvent } from "@/asp/desktop-api";
import { cn } from "@/ui/cn";
import { useChatStore } from "./chat-store";
import {
  asRecord,
  broadcastMcpAppState,
  buildMcpAppBridgeScript,
  buildMcpAppDocument,
  clampAppHeight,
  currentMcpAppStateVersion,
  currentTheme,
  handleMcpAppRpc,
  hiddenInteractiveAppViewBounds,
  htmlFromMcpResource,
  interactiveAppViewBounds,
  mcpAppDocumentId,
  mcpAppExtensionPayload,
  mcpAppAllowsHostMessage,
  mcpAppServer,
  mcpAppStateKey,
  mcpAppStatePatchFromContext,
  mcpAppStatePatchFromToolResult,
  numberPayload,
  postMcpNotification,
  registerMcpAppFrame,
  stringPayload,
  userFacingMcpAppHeading,
  type McpAppMessageTarget,
} from "./mcp-app-bridge";
import type { InteractiveAppEmbed, McpAppSessionState } from "./types";

type McpAppBlockProps = {
  artifactId?: string;
  title?: string;
  name?: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  app: InteractiveAppEmbed;
  icon?: ReactNode;
  label?: string;
  chrome?: "default" | "none";
  sessionId?: string;
  agentProviderId?: string;
  providerSessionId?: string;
  onModelContextChange?: (state: McpAppSessionState) => void;
  onHostMessage?: (params: unknown) => void;
};

export function McpAppBlock({
  app,
  artifactId,
  title,
  name,
  uri,
  path,
  mimeType,
  icon,
  label,
  chrome = "default",
  sessionId,
  agentProviderId,
  providerSessionId: providerSessionIdOverride,
  onModelContextChange,
  onHostMessage,
}: McpAppBlockProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nativeMountRef = useRef<HTMLDivElement>(null);
  const storeActiveSessionId = useChatStore((s) => s.activeSessionId);
  const activeSessionId = sessionId || storeActiveSessionId;
  const storeProviderSessionId = useChatStore(
    (s) =>
      s.sessions.find((session) => session.id === (sessionId || s.activeSessionId))
        ?.providerSessionId,
  );
  const storeProviderId = useChatStore(
    (s) =>
      s.sessions.find((session) => session.id === (sessionId || s.activeSessionId))?.providerId,
  );
  const providerRouteActive =
    (!agentProviderId || agentProviderId === storeProviderId) &&
    (!providerSessionIdOverride || providerSessionIdOverride === storeProviderSessionId);
  const providerSessionId = providerSessionIdOverride ?? storeProviderSessionId;
  const [height, setHeight] = useState(() => clampAppHeight(app.height));
  const [resourceHtml, setResourceHtml] = useState<string | undefined>();
  const [resourceError, setResourceError] = useState("");
  const [hostEvent, setHostEvent] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const appInstanceId = useRef(`mcp-app-${Math.random().toString(36).slice(2)}`);
  const nativeViewId = useMemo(() => `mcp-app-view-${appInstanceId.current}`, []);
  const heading = userFacingMcpAppHeading(
    app.title || title || name || path || uri || artifactId,
    label,
  );
  const showChrome = chrome !== "none";
  const source = app.src || undefined;
  const resourceUri = app.resourceUri || app.uri || (uri?.startsWith("ui://") ? uri : undefined);
  const server = mcpAppServer(app);
  const documentId = mcpAppDocumentId(app, { artifactId, path, uri });
  const baseAppStateKey = mcpAppStateKey({
    artifactId,
    documentId,
    resourceUri,
    server,
    title: heading,
    uri,
  });
  const appStateKey =
    agentProviderId && baseAppStateKey ? `${agentProviderId}:${baseAppStateKey}` : baseAppStateKey;
  const syncKey = activeSessionId && appStateKey ? `${activeSessionId}:${appStateKey}` : "";
  const persistedState = useChatStore((state) => {
    if (!activeSessionId || !appStateKey) return undefined;
    return state.sessions.find((session) => session.id === activeSessionId)?.mcpAppState?.[
      appStateKey
    ];
  });
  const bootContext = useMemo(
    () => ({
      appInstanceId: appInstanceId.current,
      appStateKey,
      documentId: documentId ?? null,
      title: heading,
      toolInput: app.toolInput ?? null,
      toolOutput: app.toolOutput ?? null,
      toolResponseMetadata: app.toolResponseMetadata ?? app.metadata ?? null,
      widgetState: app.widgetState ?? null,
      modelContext: null,
      stateVersion: 0,
      displayMode: "inline",
      theme: currentTheme(),
      metadata: app.metadata ?? {},
      resourceUri: resourceUri ?? null,
      server: server ?? null,
    }),
    [
      app.metadata,
      app.toolInput,
      app.toolOutput,
      app.toolResponseMetadata,
      app.widgetState,
      appStateKey,
      documentId,
      heading,
      resourceUri,
      server,
    ],
  );
  const frameContext = useMemo(
    () => ({
      ...bootContext,
      widgetState: persistedState?.widgetState ?? bootContext.widgetState,
      modelContext: persistedState?.modelContext ?? bootContext.modelContext,
      stateVersion: persistedState?.version ?? bootContext.stateVersion,
    }),
    [
      bootContext,
      persistedState?.modelContext,
      persistedState?.version,
      persistedState?.widgetState,
    ],
  );
  const frameContextRef = useRef(frameContext);
  useEffect(() => {
    frameContextRef.current = frameContext;
  }, [frameContext]);
  const updateHeight = useCallback((nextHeight: number | undefined) => {
    const clamped = clampAppHeight(nextHeight);
    setHeight((current) => (current === clamped ? current : clamped));
  }, []);
  const srcDoc = useMemo(
    () =>
      app.html || resourceHtml
        ? buildMcpAppDocument(
            app.html || resourceHtml || "",
            bootContext,
            uri || source || resourceUri,
          )
        : undefined,
    [app.html, bootContext, resourceHtml, resourceUri, source, uri],
  );
  const frameSrc = srcDoc ? undefined : source;
  const frameOrigin = useMemo(() => {
    if (!frameSrc) return undefined;
    try {
      return new URL(frameSrc).origin;
    } catch {
      return undefined;
    }
  }, [frameSrc]);
  const nativeApi = desktopApi()?.interactiveApp;
  const useNativeView = Boolean(
    nativeApi && desktopApi()?.features.webContentsView && (srcDoc || frameSrc),
  );
  const nativeTarget = useMemo<McpAppMessageTarget>(
    () => ({ kind: "native", id: nativeViewId }),
    [nativeViewId],
  );

  useEffect(() => {
    if (useNativeView) return undefined;
    const iframe = iframeRef.current;
    if (!iframe || !syncKey) return undefined;
    return registerMcpAppFrame(syncKey, { kind: "iframe", iframe, origin: frameOrigin });
  }, [frameOrigin, syncKey, useNativeView]);

  useEffect(() => {
    if (!useNativeView || !syncKey) return undefined;
    return registerMcpAppFrame(syncKey, nativeTarget);
  }, [nativeTarget, syncKey, useNativeView]);

  useEffect(() => {
    let canceled = false;
    setResourceError("");
    setResourceHtml(undefined);
    if (!providerRouteActive) {
      setResourceError("Switch back to the originating Agent to use this interactive content.");
      return undefined;
    }
    if (app.html || !resourceUri) return undefined;
    if (!resourceUri.startsWith("ui://")) return undefined;
    if (!server) {
      setResourceError("Interactive content is missing a server name.");
      return undefined;
    }
    if (!activeSessionId) return undefined;
    const api = desktopApi();
    if (!api) {
      setResourceError("Interactive content cannot reach the runtime.");
      return undefined;
    }
    let payload: Record<string, unknown>;
    try {
      payload = mcpAppExtensionPayload(
        "resources/read",
        { uri: resourceUri },
        {
          app,
          appInstanceId: appInstanceId.current,
          appStateKey,
          documentId,
          resourceUri,
          server,
          stateVersion: currentMcpAppStateVersion(activeSessionId, appStateKey),
        },
      );
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    void api.sessions
      .invokeExtension({
        uiSessionId: activeSessionId,
        providerSessionId,
        extension: "asp.ext.mcp-apps",
        method: "resources/read",
        payload,
        timeoutMs: 0,
      })
      .then(
        (result) => {
          if (canceled) return;
          const html = htmlFromMcpResource(result.result, resourceUri);
          if (html) setResourceHtml(html);
          else setResourceError("Interactive content did not return renderable HTML.");
        },
        (error) => {
          if (!canceled) setResourceError(error instanceof Error ? error.message : String(error));
        },
      );
    return () => {
      canceled = true;
    };
  }, [
    activeSessionId,
    app,
    app.html,
    appStateKey,
    documentId,
    providerSessionId,
    providerRouteActive,
    resourceUri,
    server,
  ]);

  const handleMcpAppMessage = useCallback(
    (data: unknown, target: McpAppMessageTarget) => {
      const payload = asRecord(data);
      if (!Object.keys(payload).length) return;
      const rpcMethod = stringPayload(payload.method);
      const eventType = stringPayload(payload.type);
      const eventLabel =
        stringPayload(payload.label) || stringPayload(asRecord(payload.params).label);
      const nextHostEvent = eventLabel || eventType || rpcMethod;
      if (nextHostEvent) setHostEvent(nextHostEvent);

      const heightValue =
        numberPayload(payload.height) ??
        numberPayload(asRecord(payload.params).height) ??
        numberPayload(asRecord(payload.params).maxHeight);
      if (
        heightValue &&
        [
          "mcp-app:resize",
          "resize",
          "ui/resize",
          "ui/request-size",
          "ui/request-resize",
          "ui/notifications/size-changed",
        ].includes(eventType || rpcMethod)
      ) {
        updateHeight(heightValue);
      }

      if (payload.jsonrpc === "2.0" && rpcMethod) {
        handleMcpAppRpc(target, payload, {
          onResize: updateHeight,
          onModelContext: (params) => {
            const patch = mcpAppStatePatchFromContext(params);
            if (!activeSessionId || !appStateKey || !patch) return undefined;
            const updated = useChatStore
              .getState()
              .updateMcpAppState(activeSessionId, appStateKey, {
                ...patch,
                documentId,
                resourceUri,
                server,
                title: heading,
              });
            if (updated) onModelContextChange?.(updated);
            if (updated && syncKey) broadcastMcpAppState(syncKey, target, updated);
            return updated;
          },
          context: frameContextRef.current,
          onHostMessage: (params) => {
            if (!providerRouteActive) {
              throw new Error("Switch back to the originating Agent before messaging this app.");
            }
            if (onHostMessage) {
              onHostMessage(params);
              return;
            }
            if (!mcpAppAllowsHostMessage(app)) {
              throw new Error(
                "Interactive app follow-up messages are not allowed by this resource.",
              );
            }
            const message = asRecord(params);
            const text =
              stringPayload(message.message) ||
              stringPayload(message.text) ||
              stringPayload(asRecord(message.content).text) ||
              stringPayload(message.prompt);
            if (text) void useChatStore.getState().send(text);
          },
          invokeExtension: async (method, params) => {
            if (!providerRouteActive) {
              throw new Error("Switch back to the originating Agent before using this app.");
            }
            if (!activeSessionId)
              throw new Error("No active session for interactive app tool call.");
            if (!server) throw new Error("Interactive app requests require a server name.");
            const requestPayload = mcpAppExtensionPayload(method, params, {
              app,
              appInstanceId: appInstanceId.current,
              appStateKey,
              documentId,
              resourceUri,
              server,
              stateVersion: currentMcpAppStateVersion(activeSessionId, appStateKey),
            });
            const api = desktopApi();
            if (!api) throw new Error("No runtime transport for interactive app tool call.");
            const result = await api.sessions.invokeExtension({
              uiSessionId: activeSessionId,
              providerSessionId,
              extension: "asp.ext.mcp-apps",
              method,
              payload: requestPayload,
              timeoutMs: 0,
            });
            const statePatch = mcpAppStatePatchFromToolResult(result.result);
            if (statePatch && appStateKey) {
              const updated = useChatStore
                .getState()
                .updateMcpAppState(activeSessionId, appStateKey, {
                  ...statePatch,
                  documentId,
                  resourceUri,
                  server,
                  title: heading,
                });
              if (updated) onModelContextChange?.(updated);
              if (updated && syncKey) broadcastMcpAppState(syncKey, target, updated);
            }
            return result.result;
          },
        });
      }
    },
    [
      activeSessionId,
      app,
      appStateKey,
      documentId,
      heading,
      onHostMessage,
      onModelContextChange,
      providerSessionId,
      providerRouteActive,
      resourceUri,
      server,
      syncKey,
      updateHeight,
    ],
  );

  useEffect(() => {
    if (useNativeView) return undefined;
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      if (frameOrigin && event.origin !== frameOrigin) return;
      handleMcpAppMessage(event.data, { kind: "iframe", iframe, origin: frameOrigin });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameOrigin, handleMcpAppMessage, useNativeView]);

  const sendInitialNotifications = useCallback(
    (target: McpAppMessageTarget) => {
      const context = { ...frameContextRef.current, theme: currentTheme() };
      window.setTimeout(() => {
        if (target.kind === "iframe" && iframeRef.current !== target.iframe) return;
        postMcpNotification(target, "ui/initialize", context);
        postMcpNotification(target, "ui/notifications/tool-input", {
          arguments: context.toolInput ?? {},
        });
        postMcpNotification(target, "ui/notifications/tool-result", {
          content: [],
          structuredContent: context.toolOutput,
          _meta: context.toolResponseMetadata,
        });
        postMcpNotification(target, "ui/notifications/state-changed", {
          key: appStateKey,
          modelContext: context.modelContext,
          version: context.stateVersion,
          widgetState: context.widgetState,
        });
      }, 0);
    },
    [appStateKey],
  );

  const notifyLoaded = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    setBridgeReady(true);
    setHostEvent((current) => current || "ready");
    sendInitialNotifications({ kind: "iframe", iframe, origin: frameOrigin });
  };

  useEffect(() => {
    if (!useNativeView || !nativeApi) return undefined;
    let disposed = false;
    setBridgeReady(false);
    const syncBounds = () => {
      void nativeApi
        .setBounds({
          id: nativeViewId,
          bounds: interactiveAppViewBounds(nativeMountRef.current),
        })
        .catch(() => undefined);
    };
    void nativeApi
      .create({
        id: nativeViewId,
        bridgeScript: frameSrc ? buildMcpAppBridgeScript(bootContext) : undefined,
        html: srcDoc,
        url: frameSrc,
        title: heading,
        bounds: interactiveAppViewBounds(nativeMountRef.current),
      })
      .then(() => {
        if (disposed) return;
        setBridgeReady(true);
        setHostEvent((current) => current || "ready");
        syncBounds();
        sendInitialNotifications(nativeTarget);
      })
      .catch((error) => {
        if (!disposed) setResourceError(error instanceof Error ? error.message : String(error));
      });
    const observer = new ResizeObserver(syncBounds);
    if (nativeMountRef.current) observer.observe(nativeMountRef.current);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    const timer = window.setInterval(syncBounds, 300);
    return () => {
      disposed = true;
      setBridgeReady(false);
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      window.clearInterval(timer);
      void nativeApi.destroy(nativeViewId).catch(() => undefined);
    };
  }, [
    frameSrc,
    bootContext,
    heading,
    nativeApi,
    nativeTarget,
    nativeViewId,
    sendInitialNotifications,
    srcDoc,
    useNativeView,
  ]);

  useEffect(() => {
    if (!useNativeView || !nativeApi) return undefined;
    return nativeApi.onEvent((event: InteractiveAppEvent) => {
      if (event.id !== nativeViewId) return;
      if (event.type === "message") {
        handleMcpAppMessage(event.message, nativeTarget);
        return;
      }
      if (event.type === "failed") {
        setResourceError(event.error);
        void nativeApi
          .setBounds({ id: nativeViewId, bounds: hiddenInteractiveAppViewBounds() })
          .catch(() => undefined);
        return;
      }
      if (event.type === "gone") {
        setResourceError(`Interactive content process exited (${event.reason}).`);
        void nativeApi
          .setBounds({ id: nativeViewId, bounds: hiddenInteractiveAppViewBounds() })
          .catch(() => undefined);
      }
    });
  }, [handleMcpAppMessage, nativeApi, nativeTarget, nativeViewId, useNativeView]);

  return (
    <div
      className={cn(
        "overflow-hidden",
        showChrome
          ? "border-border-subtle bg-surface/60 rounded-md border"
          : "rounded-[22px] bg-transparent",
      )}
      data-mcp-app-block
      data-mcp-app-event={hostEvent || undefined}
      data-mcp-app-ready={bridgeReady ? "true" : undefined}
    >
      {showChrome ? (
        <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-[12px]">
          {icon}
          {label ? (
            <span className="bg-info/10 text-info rounded px-1.5 py-0.5 text-[10px] font-medium tracking-normal uppercase">
              {label}
            </span>
          ) : null}
          <span className="text-fg min-w-0 flex-1 truncate font-medium">{heading}</span>
          {mimeType ? (
            <span className="bg-surface-hover text-subtle rounded px-1.5 py-0.5 font-mono text-[10px]">
              {mimeType}
            </span>
          ) : null}
          {source || uri ? (
            <a
              href={source || uri}
              target="_blank"
              rel="noreferrer"
              title={source || uri}
              className="text-subtle hover:text-info shrink-0 transition-colors"
            >
              <ExternalLink size={13} />
            </a>
          ) : null}
        </div>
      ) : null}
      {useNativeView ? (
        <div
          ref={nativeMountRef}
          data-mcp-app-native-view
          data-mcp-app-native-view-id={nativeViewId}
          className={cn("block w-full bg-white", showChrome && "border-border-subtle border-t")}
          style={{ height }}
        />
      ) : (
        <iframe
          ref={iframeRef}
          title={heading}
          src={frameSrc}
          srcDoc={srcDoc}
          sandbox={
            frameSrc
              ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              : "allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          }
          referrerPolicy="no-referrer"
          onLoad={notifyLoaded}
          data-mcp-app-frame
          className={cn("block w-full bg-white", showChrome && "border-border-subtle border-t")}
          style={{ height }}
        />
      )}
      {resourceError && (source || srcDoc) ? (
        <div
          className={cn(
            "text-danger px-3 py-2 text-[12px]",
            showChrome && "border-border-subtle border-t",
          )}
        >
          {resourceError}
        </div>
      ) : null}
      {!source && !srcDoc ? (
        <div
          className={cn(
            "text-subtle px-3 py-2 text-[12px]",
            showChrome && "border-border-subtle border-t",
          )}
        >
          {resourceError ||
            (resourceUri
              ? "Loading interactive content..."
              : "This interaction did not include renderable content.")}
        </div>
      ) : null}
    </div>
  );
}
