import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  WebContentsView,
  shell,
  webContents as electronWebContents,
  type NativeImage,
  type Rectangle,
  type WebContents,
  type WebFrameMain,
} from "electron";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCREENCAST_MAX_WIDTH = 1280;
const DEFAULT_SCREENCAST_MAX_HEIGHT = 900;
const DEFAULT_SCREENCAST_QUALITY = 70;
const SCREENCAST_FRAME_INTERVAL_MS = 100;

type BrowserTarget = {
  cdpCapture?: BrowserCdpCapture;
  id: string;
  screencast?: BrowserScreencast;
  workflowRecordingMode?: boolean;
  workflowRecordingRetryTimer?: ReturnType<typeof setTimeout>;
  webContentsId: number;
  url: string;
  title: string;
  faviconUrl?: string;
  updatedAt: number;
  view?: WebContentsView;
};

type BrowserAnnotation = {
  id: string;
  type: "element" | "region";
  note: string;
  url: string;
  title: string;
  selector?: string;
  tagName?: string;
  text?: string;
  rect: BrowserRect;
  viewport: BrowserViewport;
  styles?: Record<string, string>;
  createdAt: number;
};

type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserViewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
};

type BrowserElementInspection = {
  url: string;
  title: string;
  selector?: string;
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  attributes?: Record<string, string>;
  rect?: BrowserRect;
  viewport: BrowserViewport;
  styles?: Record<string, string>;
};

type BrowserWorkflowPageEvent = {
  createdAt: number;
  eventId: string;
  inputType?: string;
  rect: BrowserRect;
  redacted?: boolean;
  selector?: string;
  tagName?: string;
  text?: string;
  title: string;
  type: "click" | "input" | "submit";
  url: string;
  value?: string;
  viewport: BrowserViewport;
};

type BrowserCdpCapture = {
  attached: boolean;
  domains: Set<string>;
  events: BrowserCdpEventRecord[];
  maxEvents: number;
  methods: Set<string>;
  onMessage: (event: unknown, method: string, params?: unknown) => void;
};

type BrowserCdpEventRecord = {
  method: string;
  params?: unknown;
  timestamp: number;
};

type BrowserScreencast = {
  awaitingAck: boolean;
  captureInFlight: boolean;
  everyNthFrame: number;
  failureCount: number;
  format: "jpeg" | "png";
  maxHeight: number;
  maxWidth: number;
  pendingSessionId?: number;
  quality?: number;
  running: boolean;
  sessionId: number;
  timer?: ReturnType<typeof setTimeout>;
};

type InteractiveAppView = {
  allowedOrigin?: string;
  bridgeEnabled: boolean;
  ignoreErrFailedAfterStart: boolean;
  initialUrl: string;
  loaded: boolean;
  id: string;
  title: string;
  updatedAt: number;
  view: WebContentsView;
  webContentsId: number;
};

type BrowserTargetRecord = {
  id: string;
  webContentsId: number;
  url: string;
  title: string;
  faviconUrl?: string;
  updatedAt: number;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserAutomationResult = {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
};

type BrowserViewBoundsInput = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
};

type BrowserEvent =
  | { id: string; type: "updated"; target: BrowserTargetRecord }
  | { id: string; type: "failed"; target?: BrowserTargetRecord; error: string; url?: string }
  | { id: string; type: "destroyed" }
  | {
      id: string;
      type: "annotationsUpdated";
      annotationCount: number;
      annotations: BrowserAnnotation[];
    }
  | { id: string; type: "annotationTool"; action: "snapshot" | "undo" | "clear" }
  | { id: string; type: "workflowEvent"; event: BrowserWorkflowPageEvent }
  | {
      id: string;
      type: "screencastFrame";
      data: string;
      metadata: Record<string, unknown>;
      mimeType: "image/jpeg" | "image/png";
      sessionId: number;
      timestamp: number;
    };

type InteractiveAppEvent =
  | { id: string; type: "message"; message: unknown }
  | { id: string; type: "failed"; error: string }
  | { id: string; type: "gone"; exitCode: number; reason: string }
  | { id: string; type: "destroyed" };

let mainWindow: BrowserWindow | null = null;
let broadcast: (channel: string, payload: unknown) => void = () => undefined;
let remoteControlEnabled: () => boolean = () => false;
const browserTargets = new Map<string, BrowserTarget>();
const interactiveAppViews = new Map<string, InteractiveAppView>();

export function configureElectronBrowserService(options: {
  broadcast(channel: string, payload: unknown): void;
  remoteControlEnabled?: () => boolean;
}): void {
  broadcast = options.broadcast;
  remoteControlEnabled = options.remoteControlEnabled ?? (() => false);
}

export function setBrowserMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

export async function invokeElectronBrowserMethod(
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case "browser.create":
      return createBrowserViewTarget(
        params as {
          id?: string;
          url?: string;
          title?: string;
          bounds?: BrowserViewBoundsInput;
        },
      );
    case "browser.register":
      return registerBrowserTarget(
        params as {
          id?: string;
          webContentsId?: number;
          title?: string;
          url?: string;
        },
      );
    case "browser.unregister":
      return unregisterBrowserTarget(String(params ?? ""));
    case "browser.setBounds":
      return setBrowserTargetBounds(params as { id?: string; bounds?: BrowserViewBoundsInput });
    case "browser.releaseFocus":
      return releaseBrowserTargetFocus();
    case "browser.list":
      return listBrowserTargets();
    case "browser.navigate":
      return navigateBrowserTarget(
        params as {
          id?: string;
          url?: string;
          waitUntil?: string;
          timeoutMs?: number;
        },
      );
    case "browser.reload":
      return reloadBrowserTarget(
        params as
          | {
              id?: string;
              waitUntil?: string;
              timeoutMs?: number;
            }
          | undefined,
      );
    case "browser.stop":
      return stopBrowserTarget(params as { id?: string } | undefined);
    case "browser.goBack":
      return navigateBrowserHistory(params as { id?: string } | undefined, "back");
    case "browser.goForward":
      return navigateBrowserHistory(params as { id?: string } | undefined, "forward");
    case "browser.evaluate":
      return evaluateBrowserTarget(
        params as {
          id?: string;
          expression?: string;
          awaitPromise?: boolean;
        },
      );
    case "browser.click":
      return clickBrowserTarget(
        params as {
          id?: string;
          selector?: string;
          x?: number;
          y?: number;
        },
      );
    case "browser.type":
      return typeBrowserTarget(
        params as {
          id?: string;
          selector?: string;
          text?: string;
        },
      );
    case "browser.snapshot":
      return snapshotBrowserTarget(params as { id?: string } | undefined);
    case "browser.screenshot":
      return screenshotBrowserTarget(
        params as
          | {
              id?: string;
              format?: string;
              quality?: number;
            }
          | undefined,
      );
    case "browser.setAnnotationMode":
      return setBrowserAnnotationMode(
        params as {
          id?: string;
          enabled?: boolean;
        },
      );
    case "browser.setWorkflowRecordingMode":
      return setBrowserWorkflowRecordingMode(
        params as {
          id?: string;
          enabled?: boolean;
        },
      );
    case "browser.listAnnotations":
      return listBrowserAnnotations(params as { id?: string } | undefined);
    case "browser.clearAnnotations":
      return clearBrowserAnnotations(params as { id?: string } | undefined);
    case "browser.addAnnotation":
      return addBrowserAnnotation(
        params as {
          id?: string;
          annotationId?: string;
          note?: string;
          rect?: Partial<BrowserRect>;
          selector?: string;
          type?: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        },
      );
    case "browser.deleteAnnotation":
      return deleteBrowserAnnotation(params as { id?: string; annotationId?: string });
    case "browser.inspectElement":
      return inspectBrowserElement(
        params as {
          id?: string;
          selector?: string;
          x?: number;
          y?: number;
        },
      );
    case "browser.cdpCommand":
      return browserCdpCommand(
        params as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        },
      );
    case "browser.cdpStartCapture":
      return startBrowserCdpCapture(
        params as {
          id?: string;
          domains?: string[];
          methods?: string[];
          maxEvents?: number;
          clear?: boolean;
        },
      );
    case "browser.cdpEvents":
      return readBrowserCdpEvents(
        params as {
          id?: string;
          methods?: string[];
          methodPrefix?: string;
          limit?: number;
          clear?: boolean;
        },
      );
    case "browser.cdpStopCapture":
      return stopBrowserCdpCapture(params as { id?: string } | undefined);
    case "browser.screencastStart":
      return startBrowserScreencast(
        params as
          | {
              id?: string;
              format?: string;
              quality?: number;
              maxWidth?: number;
              maxHeight?: number;
              everyNthFrame?: number;
            }
          | undefined,
      );
    case "browser.screencastAck":
      return ackBrowserScreencastFrame(params as { id?: string; sessionId?: number });
    case "browser.screencastStop":
      return stopBrowserScreencast(params as { id?: string } | undefined);
    case "browser.dispatchMouse":
      return dispatchBrowserMouseEvent(
        params as {
          id?: string;
          type?: string;
          x?: number;
          y?: number;
          button?: string;
          buttons?: number;
          clickCount?: number;
          deltaX?: number;
          deltaY?: number;
          modifiers?: number;
        },
      );
    case "browser.dispatchKey":
      return dispatchBrowserKeyEvent(
        params as {
          id?: string;
          type?: string;
          key?: string;
          code?: string;
          text?: string;
          unmodifiedText?: string;
          windowsVirtualKeyCode?: number;
          nativeVirtualKeyCode?: number;
          autoRepeat?: boolean;
          isKeypad?: boolean;
          modifiers?: number;
        },
      );
    case "browser.insertText":
      return insertBrowserText(params as { id?: string; text?: string });
    case "interactiveApp.create":
      return createInteractiveAppView(
        params as {
          bounds?: BrowserViewBoundsInput;
          bridgeScript?: string;
          html?: string;
          id?: string;
          title?: string;
          url?: string;
        },
      );
    case "interactiveApp.destroy":
      return destroyInteractiveAppView(String(params ?? ""));
    case "interactiveApp.setBounds":
      return setInteractiveAppViewBounds(
        params as { id?: string; bounds?: BrowserViewBoundsInput },
      );
    case "interactiveApp.postMessage":
      return postInteractiveAppViewMessage(params as { id?: string; message?: unknown });
    default:
      throw new Error(`Unknown browser runtime method: ${method}`);
  }
}

function createBrowserViewTarget(input: {
  id?: string;
  url?: string;
  title?: string;
  bounds?: BrowserViewBoundsInput;
}): BrowserTargetRecord {
  const id = safeBrowserId(String(input?.id || ""));
  if (!id) throw new Error("Missing browser target id.");
  const existing = browserTargets.get(id);
  if (existing?.view) {
    if (input?.bounds) setBrowserTargetBounds({ id, bounds: input.bounds });
    return browserTargetRecord(existing, trustedBrowserWebContents(existing.webContentsId));
  }
  if (existing) unregisterBrowserTarget(id);
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("AGUI window is not available for browser views.");
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: "persist:agui-browser",
    },
  });
  view.setBackgroundColor("#ffffff");
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);

  const target = view.webContents;
  hardenViewSession(target);
  target.setWindowOpenHandler(({ url }) => {
    if (isSafeBrowserPanelUrl(url)) {
      void target.loadURL(url).catch(() => undefined);
    } else if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  target.on("will-navigate", (event, url) => {
    if (!isSafeBrowserPanelUrl(url)) event.preventDefault();
  });

  const record: BrowserTarget = {
    id,
    workflowRecordingMode: false,
    webContentsId: target.id,
    title: String(input?.title || target.getTitle() || "Browser"),
    url: target.getURL() || "about:blank",
    updatedAt: Date.now(),
    view,
  };
  browserTargets.set(id, record);
  attachBrowserTargetEvents(record);
  if (input?.bounds) setBrowserTargetBounds({ id, bounds: input.bounds });

  const initialUrl = safeBrowserAutomationUrl(String(input?.url || ""));
  if (initialUrl && initialUrl !== "about:blank") {
    record.url = initialUrl;
    void loadBrowserUrl(record, target, initialUrl);
  }

  return browserTargetRecord(record, target);
}

function registerBrowserTarget(input: {
  id?: string;
  webContentsId?: number;
  title?: string;
  url?: string;
}): BrowserTargetRecord {
  const id = safeBrowserId(String(input?.id || ""));
  if (!id) throw new Error("Missing browser target id.");
  const webContentsId = safeBrowserWebContentsId(input?.webContentsId);
  const target = trustedWebviewBrowserWebContents(webContentsId);
  const record: BrowserTarget = {
    id,
    workflowRecordingMode: false,
    webContentsId,
    title: String(input?.title || target.getTitle() || "Browser"),
    url: String(input?.url || target.getURL() || "about:blank"),
    updatedAt: Date.now(),
  };
  browserTargets.set(id, record);
  target.once("destroyed", () => {
    const current = browserTargets.get(id);
    if (current?.webContentsId === webContentsId) {
      clearBrowserWorkflowRecorderRetry(current);
      disposeBrowserScreencast(current);
      disposeBrowserCdpCapture(current);
      browserTargets.delete(id);
    }
  });
  return browserTargetRecord(record, target);
}

function unregisterBrowserTarget(id: string): boolean {
  const browserId = safeBrowserId(String(id || ""));
  const record = browserTargets.get(browserId);
  if (!record) return false;
  browserTargets.delete(browserId);
  disposeBrowserScreencast(record);
  disposeBrowserCdpCapture(record);
  if (record.view) {
    try {
      mainWindow?.contentView.removeChildView(record.view);
    } catch {
      // The host window may already be closing.
    }
    if (!record.view.webContents.isDestroyed()) {
      record.view.webContents.close({ waitForBeforeUnload: false });
    }
  }
  clearBrowserWorkflowRecorderRetry(record);
  emitBrowserEvent({ id: browserId, type: "destroyed" });
  return true;
}

export function disposeBrowserTargets(): void {
  for (const id of [...browserTargets.keys()]) unregisterBrowserTarget(id);
  browserTargets.clear();
}

export function stopBrowserScreencasts(): void {
  for (const record of browserTargets.values()) disposeBrowserScreencast(record);
}

async function createInteractiveAppView(input: {
  bounds?: BrowserViewBoundsInput;
  bridge?: boolean;
  bridgeScript?: string;
  html?: string;
  id?: string;
  title?: string;
  url?: string;
  userAgent?: string;
  userStyle?: string;
}): Promise<{ id: string; webContentsId: number }> {
  const id = safeBrowserId(String(input?.id || ""));
  if (!id) throw new Error("Missing interactive app view id.");
  destroyInteractiveAppView(id);
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("AGUI window is not available for interactive app views.");
  }

  const html = typeof input?.html === "string" ? input.html : "";
  const bridgeEnabled = input?.bridge !== false;
  const bridgeScript = typeof input?.bridgeScript === "string" ? input.bridgeScript : "";
  const requestedUrl = typeof input?.url === "string" ? input.url.trim() : "";
  const url = requestedUrl ? safeInteractiveAppUrl(requestedUrl) : "";
  const userAgent = safeInteractiveAppUserAgent(input?.userAgent);
  const userStyle = safeInteractiveAppUserStyle(input?.userStyle);
  if (requestedUrl && !url) {
    throw new Error("Interactive app URLs require HTTPS or loopback HTTP.");
  }
  if (!html && !url) throw new Error("Interactive app view requires HTML or a URL.");
  const loadUrl = html ? htmlDataUrl(html) : url;
  const allowedOrigin = url ? new URL(url).origin : undefined;

  const view = new WebContentsView({
    webPreferences: {
      additionalArguments: bridgeEnabled ? [`--agui-interactive-app-id=${id}`] : [],
      contextIsolation: true,
      nodeIntegration: false,
      partition: `agui-interactive-app:${id}`,
      ...(bridgeEnabled
        ? { preload: path.join(currentDirectory, "interactive-app-preload.cjs") }
        : {}),
      sandbox: true,
      webSecurity: true,
    },
  });
  view.setBackgroundColor("#ffffff");
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);

  const target = view.webContents;
  hardenViewSession(target);
  if (userAgent) target.setUserAgent(userAgent);
  const record: InteractiveAppView = {
    allowedOrigin,
    bridgeEnabled,
    id,
    ignoreErrFailedAfterStart: !bridgeEnabled && Boolean(url),
    initialUrl: loadUrl,
    loaded: false,
    title: String(input?.title || "Interactive content"),
    updatedAt: Date.now(),
    view,
    webContentsId: target.id,
  };
  interactiveAppViews.set(id, record);
  attachInteractiveAppViewEvents(record);
  setInteractiveAppViewBounds({ id, bounds: input.bounds });

  target.setWindowOpenHandler(({ url: nextUrl }) => {
    if (isSafeExternalUrl(nextUrl)) void shell.openExternal(nextUrl);
    return { action: "deny" };
  });
  target.on("will-navigate", (event, nextUrl) => {
    if (isAllowedInteractiveAppNavigation(record, nextUrl)) return;
    event.preventDefault();
    if (isSafeExternalUrl(nextUrl)) void shell.openExternal(nextUrl);
  });
  target.on("will-redirect", (event, nextUrl) => {
    if (isAllowedInteractiveAppNavigation(record, nextUrl)) return;
    event.preventDefault();
  });
  if (bridgeEnabled && bridgeScript) {
    target.on("dom-ready", () => {
      if (!isInteractiveAppBridgeUrl(record, target.getURL())) {
        emitInteractiveAppEvent({
          id,
          type: "failed",
          error: "Interactive app navigation left its approved origin.",
        });
        return;
      }
      void target.executeJavaScript(bridgeScript).catch((error) => {
        emitInteractiveAppEvent({ id, type: "failed", error: formatRuntimeError(error) });
      });
    });
  }
  if (userStyle) {
    target.on("dom-ready", () => {
      void target.insertCSS(userStyle).catch(() => undefined);
    });
  }

  try {
    await target.loadURL(loadUrl);
  } catch (error) {
    if (shouldIgnoreInteractiveAppLoadFailure(record, error))
      return { id, webContentsId: target.id };
    emitInteractiveAppEvent({ id, type: "failed", error: formatRuntimeError(error) });
  }
  return { id, webContentsId: target.id };
}

function destroyInteractiveAppView(id: string): boolean {
  const viewId = safeBrowserId(String(id || ""));
  const record = interactiveAppViews.get(viewId);
  if (!record) return false;
  interactiveAppViews.delete(viewId);
  try {
    mainWindow?.contentView.removeChildView(record.view);
  } catch {
    // The host window may already be closing.
  }
  if (!record.view.webContents.isDestroyed()) {
    record.view.webContents.close({ waitForBeforeUnload: false });
  }
  emitInteractiveAppEvent({ id: viewId, type: "destroyed" });
  return true;
}

export function disposeInteractiveAppViews(): void {
  for (const id of [...interactiveAppViews.keys()]) destroyInteractiveAppView(id);
  interactiveAppViews.clear();
}

function setInteractiveAppViewBounds(input: { id?: string; bounds?: BrowserViewBoundsInput }): {
  id: string;
  webContentsId: number;
} {
  const id = safeBrowserId(String(input?.id || ""));
  if (!id) throw new Error("Missing interactive app view id.");
  const record = interactiveAppViews.get(id);
  if (!record) return { id, webContentsId: 0 };
  const bounds = safeBrowserViewBounds(input?.bounds);
  record.view.setBounds(bounds);
  record.view.setVisible(Boolean(input?.bounds?.visible) && bounds.width > 0 && bounds.height > 0);
  record.updatedAt = Date.now();
  return { id, webContentsId: record.webContentsId };
}

function postInteractiveAppViewMessage(input: { id?: string; message?: unknown }): boolean {
  const id = safeBrowserId(String(input?.id || ""));
  if (!id) throw new Error("Missing interactive app view id.");
  const record = interactiveAppViews.get(id);
  if (
    !record ||
    record.view.webContents.isDestroyed() ||
    !isInteractiveAppBridgeUrl(record, record.view.webContents.getURL())
  )
    return false;
  return safeSendWebContents(
    record.view.webContents,
    "agui:interactive-app:message",
    input?.message,
  );
}

function attachInteractiveAppViewEvents(record: InteractiveAppView): void {
  const target = record.view.webContents;
  const markLoaded = () => {
    record.loaded = true;
    record.updatedAt = Date.now();
  };
  target.on("dom-ready", markLoaded);
  target.on("did-finish-load", markLoaded);
  target.on("did-navigate", (_event, url) => {
    if (!record.bridgeEnabled || isInteractiveAppBridgeUrl(record, url)) return;
    emitInteractiveAppEvent({
      id: record.id,
      type: "failed",
      error: "Interactive app navigation left its approved origin.",
    });
    destroyInteractiveAppView(record.id);
  });
  target.on("render-process-gone", (_event, details) => {
    console.error(
      `Interactive app renderer gone (${record.id}): reason=${details.reason} exitCode=${details.exitCode}`,
    );
    emitInteractiveAppEvent({
      id: record.id,
      type: "gone",
      exitCode: details.exitCode,
      reason: details.reason,
    });
  });
  target.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame === false || errorCode === -3) return;
    if (record.ignoreErrFailedAfterStart && errorCode === -2) return;
    if (record.loaded && errorCode === -2) return;
    emitInteractiveAppEvent({
      id: record.id,
      type: "failed",
      error: errorDescription || "Interactive content failed to load.",
    });
  });
  target.once("destroyed", () => {
    const current = interactiveAppViews.get(record.id);
    if (current?.webContentsId !== record.webContentsId) return;
    interactiveAppViews.delete(record.id);
    emitInteractiveAppEvent({ id: record.id, type: "destroyed" });
  });
}

export function relayInteractiveAppMessage(
  senderWebContentsId: number,
  senderUrl: string,
  payload: unknown,
): void {
  const message = recordValue(payload);
  const id = safeBrowserId(stringField(message, "id"));
  if (!id) return;
  const record = interactiveAppViews.get(id);
  if (
    !record ||
    record.webContentsId !== senderWebContentsId ||
    !isInteractiveAppBridgeUrl(record, senderUrl)
  )
    return;
  emitInteractiveAppEvent({ id, type: "message", message: message.message });
}

function emitInteractiveAppEvent(event: InteractiveAppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeSendWebContents(mainWindow.webContents, "agui:interactive-app:event", event);
  }
}

function setBrowserTargetBounds(input: {
  id?: string;
  bounds?: BrowserViewBoundsInput;
}): BrowserTargetRecord {
  const browserId = safeBrowserId(String(input?.id || ""));
  if (!browserId) throw new Error("Missing browser target id.");
  const record = browserTargets.get(browserId);
  if (!record) return staleBrowserTargetRecord(browserId);
  let target: WebContents;
  try {
    target = trustedBrowserWebContents(record.webContentsId);
  } catch {
    browserTargets.delete(record.id);
    return staleBrowserTargetRecord(browserId);
  }
  if (!record.view) return browserTargetRecord(record, target);
  const bounds = safeBrowserViewBounds(input?.bounds);
  record.view.setBounds(bounds);
  record.view.setVisible(Boolean(input?.bounds?.visible) && bounds.width > 0 && bounds.height > 0);
  if (record.screencast) scheduleBrowserScreencastFrame(record.id, 0);
  return browserTargetRecord(record, target);
}

function releaseBrowserTargetFocus(): boolean {
  for (const record of browserTargets.values()) {
    if (!record.view) continue;
    try {
      record.view.setVisible(false);
      record.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } catch {
      // The view may already be detached while the right panel is closing.
    }
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  } catch {
    return false;
  }
  return true;
}

function staleBrowserTargetRecord(id: string): BrowserTargetRecord {
  return {
    id,
    webContentsId: 0,
    url: "about:blank",
    title: "Browser",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    updatedAt: Date.now(),
  };
}

function listBrowserTargets(): BrowserTargetRecord[] {
  const records: BrowserTargetRecord[] = [];
  for (const record of browserTargets.values()) {
    try {
      records.push(browserTargetRecord(record, trustedBrowserWebContents(record.webContentsId)));
    } catch {
      browserTargets.delete(record.id);
    }
  }
  return records.sort((a, b) => a.updatedAt - b.updatedAt);
}

function attachBrowserTargetEvents(record: BrowserTarget): void {
  const target = record.view?.webContents;
  if (!target) return;
  const update = () => emitBrowserTargetUpdate(record.id);
  target.on("did-start-loading", update);
  target.on("did-stop-loading", update);
  target.on("dom-ready", () => {
    void refreshBrowserTargetFavicon(record, target);
    if (record.workflowRecordingMode) {
      void ensureBrowserWorkflowRecorder(target, true).catch(() => undefined);
    }
  });
  target.on("did-finish-load", () => {
    void refreshBrowserTargetFavicon(record, target);
  });
  target.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame === false || isInPlace) return;
    record.url = url;
    record.faviconUrl = fallbackBrowserFaviconUrl(url);
    update();
  });
  target.on("did-navigate", (_event, url) => {
    record.url = url;
    update();
  });
  target.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame === false) return;
    record.url = url;
    update();
  });
  target.on("page-title-updated", (_event, title) => {
    record.title = title;
    update();
  });
  target.on("page-favicon-updated", (_event, favicons) => {
    const pageUrl = target.getURL() || record.url;
    record.faviconUrl =
      safeBrowserFaviconUrl(favicons, pageUrl) ?? fallbackBrowserFaviconUrl(pageUrl);
    update();
  });
  target.on("console-message", (...args: unknown[]) => {
    const message = args.find((arg): arg is string => typeof arg === "string") ?? "";
    if (message.includes("[AGUI_BROWSER_ANNOTATION]")) {
      void emitBrowserAnnotationsUpdated(record.id, target).catch(() => undefined);
      return;
    }
    if (message.includes("[AGUI_BROWSER_ANNOTATION_TOOL]")) {
      emitBrowserAnnotationToolEvent(record.id, message);
      return;
    }
    emitBrowserWorkflowPageEvent(record.id, message);
  });
  target.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame === false || errorCode === -3) return;
    emitBrowserEvent({
      id: record.id,
      type: "failed",
      target: safeBrowserTargetRecord(record),
      error: errorDescription || "Unable to load page",
      url: validatedURL,
    });
  });
  target.once("destroyed", () => {
    const current = browserTargets.get(record.id);
    if (current?.webContentsId !== record.webContentsId) return;
    clearBrowserWorkflowRecorderRetry(current);
    disposeBrowserScreencast(current);
    disposeBrowserCdpCapture(current);
    browserTargets.delete(record.id);
    emitBrowserEvent({ id: record.id, type: "destroyed" });
  });
}

function emitBrowserTargetUpdate(id: string): void {
  const record = browserTargets.get(id);
  if (!record) return;
  const target = electronWebContents.fromId(record.webContentsId);
  if (!target || target.isDestroyed()) return;
  emitBrowserEvent({ id, type: "updated", target: browserTargetRecord(record, target) });
}

function emitBrowserEvent(event: BrowserEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeSendWebContents(mainWindow.webContents, "agui:browser:event", event);
  }
  broadcast("agui:browser:event", event);
}

function emitBrowserTargetLoadFailure(record: BrowserTarget, error: unknown, url?: string): void {
  emitBrowserEvent({
    id: record.id,
    type: "failed",
    target: safeBrowserTargetRecord(record),
    error: formatRuntimeError(error),
    url: url || record.url,
  });
}

async function loadBrowserUrl(
  record: BrowserTarget,
  target: WebContents,
  url: string,
): Promise<void> {
  if (await localBrowserEndpointUnavailable(url)) {
    emitBrowserTargetLoadFailure(record, browserConnectionRefusedError(url), url);
    return;
  }
  await target.loadURL(url).catch((error) => {
    emitBrowserTargetLoadFailure(record, error, url);
  });
}

function safeBrowserTargetRecord(record: BrowserTarget): BrowserTargetRecord | undefined {
  try {
    return browserTargetRecord(record, trustedBrowserWebContents(record.webContentsId));
  } catch {
    return undefined;
  }
}

async function navigateBrowserTarget(input: {
  id?: string;
  url?: string;
  waitUntil?: string;
  timeoutMs?: number;
}): Promise<BrowserAutomationResult> {
  const url = safeBrowserAutomationUrl(String(input?.url || ""));
  if (!url) throw new Error("Unsupported browser URL.");
  const { record, target } = browserTargetFor(input?.id);
  record.url = url;
  record.updatedAt = Date.now();
  if (await localBrowserEndpointUnavailable(url)) {
    emitBrowserTargetLoadFailure(record, browserConnectionRefusedError(url), url);
    return browserAutomationResult(record, target);
  }
  const waitForLoad = waitForBrowserLoad(target, input?.waitUntil, input?.timeoutMs, url).catch(
    (error: unknown) => error,
  );
  const loadError = await target.loadURL(url).then(
    () => undefined,
    (error: unknown) => error,
  );
  const waitError = await waitForLoad;
  const navigationError = loadError ?? waitError;
  if (navigationError) {
    emitBrowserTargetLoadFailure(record, navigationError, url);
  }
  return browserAutomationResult(record, target);
}

async function reloadBrowserTarget(input?: {
  id?: string;
  waitUntil?: string;
  timeoutMs?: number;
}): Promise<BrowserAutomationResult> {
  const { record, target } = browserTargetFor(input?.id);
  const url = target.getURL() || record.url;
  if (await localBrowserEndpointUnavailable(url)) {
    emitBrowserTargetLoadFailure(record, browserConnectionRefusedError(url), url);
    return browserAutomationResult(record, target);
  }
  const waitForLoad = waitForBrowserLoad(target, input?.waitUntil, input?.timeoutMs).catch(
    (error: unknown) => error,
  );
  let reloadError: unknown;
  try {
    target.reloadIgnoringCache();
  } catch (error) {
    reloadError = error;
  }
  const waitError = await waitForLoad;
  const navigationError = reloadError ?? waitError;
  if (navigationError) {
    emitBrowserTargetLoadFailure(record, navigationError, target.getURL() || record.url);
  }
  return browserAutomationResult(record, target);
}

function stopBrowserTarget(input?: { id?: string }): BrowserAutomationResult {
  const { record, target } = browserTargetFor(input?.id);
  if (target.isLoading()) target.stop();
  return browserAutomationResult(record, target);
}

function navigateBrowserHistory(
  input: { id?: string } | undefined,
  direction: "back" | "forward",
): BrowserAutomationResult {
  const { record, target } = browserTargetFor(input?.id);
  if (!browserCanGo(target, direction)) return browserAutomationResult(record, target);
  const navigationHistory = (
    target as WebContents & {
      navigationHistory?: {
        goBack?: () => void;
        goForward?: () => void;
      };
    }
  ).navigationHistory;
  const method = direction === "back" ? "goBack" : "goForward";
  if (navigationHistory?.[method]) navigationHistory[method]();
  else if (direction === "back") target.goBack();
  else target.goForward();
  return browserAutomationResult(record, target);
}

async function evaluateBrowserTarget(input: {
  id?: string;
  expression?: string;
  awaitPromise?: boolean;
}): Promise<{ type: string; value?: unknown; description?: string }> {
  const expression = String(input?.expression || "");
  if (!expression.trim()) throw new Error("Missing browser evaluation expression.");
  if (expression.length > 200_000) throw new Error("Browser evaluation expression is too long.");
  const { target } = browserTargetFor(input?.id);
  return evaluateInBrowser(target, expression, input?.awaitPromise !== false);
}

async function clickBrowserTarget(input: {
  id?: string;
  selector?: string;
  x?: number;
  y?: number;
}): Promise<BrowserAutomationResult> {
  const { record, target } = browserTargetFor(input?.id);
  const point = await browserClickPoint(target, input);
  await dispatchBrowserClick(target, point.x, point.y);
  return browserAutomationResult(record, target);
}

async function typeBrowserTarget(input: {
  id?: string;
  selector?: string;
  text?: string;
}): Promise<BrowserAutomationResult> {
  const text = String(input?.text ?? "");
  if (!text) return browserAutomationResultFor(input?.id);
  if (text.length > 20_000) throw new Error("Browser input text is too long.");
  const { record, target } = browserTargetFor(input?.id);
  if (typeof input?.selector === "string" && input.selector.trim()) {
    const point = await browserClickPoint(target, input);
    await dispatchBrowserClick(target, point.x, point.y);
  }
  await withBrowserCdp(target, async (send) => {
    await send("Input.insertText", { text });
  });
  return browserAutomationResult(record, target);
}

async function snapshotBrowserTarget(input?: { id?: string }): Promise<{
  id: string;
  url: string;
  title: string;
  text: string;
  html: string;
}> {
  const { record, target } = browserTargetFor(input?.id);
  const result = await evaluateInBrowser(
    target,
    "(() => ({ url: location.href, title: document.title, text: document.body?.innerText ?? '', html: document.documentElement?.outerHTML ?? '' }))()",
    true,
  );
  const value = recordValue(result.value);
  return {
    id: record.id,
    url: stringField(value, "url") || target.getURL() || record.url,
    title: stringField(value, "title") || target.getTitle() || record.title,
    text: stringField(value, "text"),
    html: stringField(value, "html"),
  };
}

async function screenshotBrowserTarget(input?: {
  id?: string;
  format?: string;
  quality?: number;
}): Promise<{ id: string; mimeType: "image/png" | "image/jpeg"; data: string }> {
  const { record, target } = browserTargetFor(input?.id);
  const format = input?.format === "jpeg" ? "jpeg" : "png";
  const params: Record<string, unknown> = { format };
  if (format === "jpeg" && input?.quality !== undefined) {
    params.quality = clampInteger(input.quality, 1, 100);
  }
  const result = await withBrowserCdp(target, async (send) =>
    send("Page.captureScreenshot", params),
  );
  const data = stringField(recordValue(result), "data");
  if (!data) throw new Error("Browser screenshot capture returned no data.");
  return {
    id: record.id,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    data,
  };
}

async function setBrowserAnnotationMode(input?: {
  id?: string;
  enabled?: boolean;
}): Promise<{ id: string; enabled: boolean; annotationCount: number }> {
  const enabled = input?.enabled === true;
  const { record, target } = browserTargetFor(input?.id);
  await ensureBrowserAnnotationController(target);
  const result = await evaluateBrowserAnnotationStep(
    target,
    `window.__aguiBrowserAnnotations.setEnabled(${enabled ? "true" : "false"})`,
    "Annotation mode toggle failed",
  );
  const value = recordValue(result.value);
  return {
    id: record.id,
    enabled: value.enabled === true,
    annotationCount: numberField(value, "annotationCount") || 0,
  };
}

async function setBrowserWorkflowRecordingMode(input?: {
  id?: string;
  enabled?: boolean;
}): Promise<{ id: string; enabled: boolean }> {
  const enabled = input?.enabled === true;
  const { record, target } = browserTargetFor(input?.id);
  record.workflowRecordingMode = enabled;
  clearBrowserWorkflowRecorderRetry(record);
  const result = await ensureBrowserWorkflowRecorder(target, enabled).catch((error) => {
    if (enabled && browserWorkflowRecorderTransientError(error)) {
      scheduleBrowserWorkflowRecorderRetry(record.id);
      return { type: "object", value: { enabled: true } };
    }
    if (enabled) {
      record.workflowRecordingMode = false;
      throw error;
    }
    return { type: "object", value: { enabled: false } };
  });
  const value = recordValue(result.value);
  return {
    id: record.id,
    enabled: value.enabled === true,
  };
}

async function listBrowserAnnotations(input?: { id?: string }): Promise<{
  id: string;
  annotations: BrowserAnnotation[];
}> {
  const { record, target } = browserTargetFor(input?.id);
  await ensureBrowserAnnotationController(target);
  const result = await evaluateBrowserAnnotationStep(
    target,
    "window.__aguiBrowserAnnotations.list()",
    "Annotation list read failed",
  );
  return {
    id: record.id,
    annotations: normalizeBrowserAnnotations(result.value),
  };
}

async function clearBrowserAnnotations(input?: { id?: string }): Promise<{
  id: string;
  annotationCount: number;
}> {
  const { record, target } = browserTargetFor(input?.id);
  await ensureBrowserAnnotationController(target);
  const result = await evaluateBrowserAnnotationStep(
    target,
    "window.__aguiBrowserAnnotations.clear()",
    "Annotation clear failed",
  );
  const value = recordValue(result.value);
  void emitBrowserAnnotationsUpdated(record.id, target).catch(() => undefined);
  return {
    id: record.id,
    annotationCount: numberField(value, "annotationCount") || 0,
  };
}

async function addBrowserAnnotation(input: {
  id?: string;
  annotationId?: string;
  note?: string;
  rect?: Partial<BrowserRect>;
  selector?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Promise<{ id: string; annotation: BrowserAnnotation; annotationCount: number }> {
  const note = String(input?.note ?? "").trim();
  if (!note) throw new Error("Browser annotation requires a note.");
  const { record, target } = browserTargetFor(input?.id);
  await ensureBrowserAnnotationController(target);
  const result = await evaluateBrowserAnnotationStep(
    target,
    `window.__aguiBrowserAnnotations.add(${JSON.stringify({
      annotationId: safeAnnotationId(input?.annotationId) || generatedAnnotationId(),
      height: finiteInputNumber(input?.height),
      note,
      rect: browserAnnotationViewportRect(input),
      selector: optionalStringInput(input?.selector, 32_768),
      type: input?.type === "element" ? "element" : input?.type === "region" ? "region" : undefined,
      width: finiteInputNumber(input?.width),
      x: finiteInputNumber(input?.x),
      y: finiteInputNumber(input?.y),
    })})`,
    "Annotation add failed",
  );
  const value = recordValue(result.value);
  const annotation = normalizeBrowserAnnotations([value.annotation])[0];
  if (!annotation) throw new Error("Annotation add returned no annotation.");
  const annotationCount = numberField(value, "annotationCount") || 1;
  void emitBrowserAnnotationsUpdated(record.id, target).catch(() => undefined);
  return { id: record.id, annotation, annotationCount };
}

async function deleteBrowserAnnotation(input: {
  id?: string;
  annotationId?: string;
}): Promise<{ id: string; deleted: boolean; annotationCount: number }> {
  const annotationId = safeAnnotationId(input?.annotationId);
  if (!annotationId) throw new Error("Missing browser annotation id.");
  const { record, target } = browserTargetFor(input?.id);
  await ensureBrowserAnnotationController(target);
  const result = await evaluateBrowserAnnotationStep(
    target,
    `window.__aguiBrowserAnnotations.remove(${JSON.stringify(annotationId)})`,
    "Annotation delete failed",
  );
  const value = recordValue(result.value);
  void emitBrowserAnnotationsUpdated(record.id, target).catch(() => undefined);
  return {
    id: record.id,
    deleted: value.deleted === true,
    annotationCount: numberField(value, "annotationCount") || 0,
  };
}

async function emitBrowserAnnotationsUpdated(id: string, target: WebContents): Promise<void> {
  if (target.isDestroyed()) return;
  await ensureBrowserAnnotationController(target);
  const result = await evaluateBrowserAnnotationStep(
    target,
    "window.__aguiBrowserAnnotations.list()",
    "Annotation event read failed",
  );
  const annotations = normalizeBrowserAnnotations(result.value);
  emitBrowserEvent({
    id,
    type: "annotationsUpdated",
    annotationCount: annotations.length,
    annotations,
  });
}

function emitBrowserWorkflowPageEvent(id: string, message: string): void {
  const event = browserWorkflowPageEventFromConsoleMessage(message);
  if (!event) return;
  emitBrowserEvent({ id, type: "workflowEvent", event });
}

function emitBrowserAnnotationToolEvent(id: string, message: string): void {
  const marker = "[AGUI_BROWSER_ANNOTATION_TOOL]";
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) return;
  const json = message.slice(markerIndex + marker.length).trim();
  if (!json) return;
  try {
    const action = stringField(recordValue(JSON.parse(json)), "action");
    if (action !== "snapshot" && action !== "undo" && action !== "clear") return;
    emitBrowserEvent({ id, type: "annotationTool", action });
  } catch {
    return;
  }
}

function scheduleBrowserWorkflowRecorderRetry(id: string, delayMs = 250): void {
  const record = browserTargets.get(id);
  if (!record || !record.workflowRecordingMode) return;
  clearBrowserWorkflowRecorderRetry(record);
  record.workflowRecordingRetryTimer = setTimeout(() => {
    record.workflowRecordingRetryTimer = undefined;
    const current = browserTargets.get(id);
    if (!current?.workflowRecordingMode) return;
    const target = electronWebContents.fromId(current.webContentsId);
    if (!target || target.isDestroyed()) return;
    void ensureBrowserWorkflowRecorder(target, true).catch((error) => {
      if (!browserWorkflowRecorderTransientError(error)) return;
      scheduleBrowserWorkflowRecorderRetry(id, Math.min(delayMs * 2, 2_000));
    });
  }, delayMs);
}

function clearBrowserWorkflowRecorderRetry(record: BrowserTarget): void {
  if (!record.workflowRecordingRetryTimer) return;
  clearTimeout(record.workflowRecordingRetryTimer);
  record.workflowRecordingRetryTimer = undefined;
}

function browserWorkflowRecorderTransientError(error: unknown): boolean {
  const message = formatRuntimeError(error).toLowerCase();
  return (
    message.includes("target closed") ||
    message.includes("browser target is not available") ||
    message.includes("execution context was destroyed") ||
    message.includes("inspected target navigated") ||
    message.includes("cannot find context with specified id") ||
    message.includes("target crashed") ||
    message.includes("webcontents was destroyed")
  );
}

function browserWorkflowPageEventFromConsoleMessage(
  message: string,
): BrowserWorkflowPageEvent | null {
  const marker = "[AGUI_BROWSER_WORKFLOW]";
  const index = message.indexOf(marker);
  if (index < 0) return null;
  const json = message.slice(index + marker.length).trim();
  if (!json) return null;
  try {
    return normalizeBrowserWorkflowPageEvent(JSON.parse(json));
  } catch {
    return null;
  }
}

function normalizeBrowserWorkflowPageEvent(value: unknown): BrowserWorkflowPageEvent | null {
  const item = recordValue(value);
  const type = stringField(item, "type");
  if (type !== "click" && type !== "input" && type !== "submit") return null;
  return {
    createdAt: finiteNumberField(item, "createdAt") || Date.now(),
    eventId: stringField(item, "eventId").slice(0, 160) || `workflow-event-${Date.now()}`,
    inputType: optionalStringField(item, "inputType", 128),
    rect: normalizeBrowserRect(recordValue(item.rect)),
    redacted: item.redacted === true ? true : undefined,
    selector: optionalStringField(item, "selector", 32_768),
    tagName: optionalStringField(item, "tagName", 128),
    text: optionalStringField(item, "text", 4_000),
    title: stringField(item, "title").slice(0, 8_192),
    type,
    url: stringField(item, "url").slice(0, 16_384),
    value: optionalStringField(item, "value", 200_000),
    viewport: normalizeBrowserViewport(recordValue(item.viewport)),
  };
}

async function inspectBrowserElement(input: {
  id?: string;
  selector?: string;
  x?: number;
  y?: number;
}): Promise<{ id: string; element: BrowserElementInspection | null }> {
  const { record, target } = browserTargetFor(input?.id);
  const result = await evaluateInBrowser(target, browserElementInspectionExpression(input), true);
  return {
    id: record.id,
    element: normalizeBrowserElementInspection(result.value),
  };
}

async function browserCdpCommand(input: {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<{ id: string; method: string; result: unknown }> {
  const method = safeCdpMethod(input?.method);
  if (!method) throw new Error("browser.cdpCommand requires a valid CDP method.");
  const params = safeCdpParams(input?.params);
  const { record, target } = browserTargetFor(input?.id);
  const result = await withBrowserCdp(target, (send) => send(method, params));
  return { id: record.id, method, result };
}

async function startBrowserCdpCapture(input?: {
  id?: string;
  domains?: string[];
  methods?: string[];
  maxEvents?: number;
  clear?: boolean;
}): Promise<{
  id: string;
  recording: boolean;
  domains: string[];
  eventCount: number;
  maxEvents: number;
}> {
  const { record, target } = browserTargetFor(input?.id);
  const domains = safeCdpDomains(input?.domains);
  const methods = safeCdpMethods(input?.methods);
  const maxEvents = clampInteger(input?.maxEvents ?? 2_000, 1, 10_000);
  const capture = ensureBrowserCdpCapture(record, target, maxEvents);
  capture.maxEvents = maxEvents;
  capture.domains = domains;
  capture.methods = methods;
  if (input?.clear !== false) capture.events = [];
  await enableBrowserCdpDomains(target, domains);
  return {
    id: record.id,
    recording: true,
    domains: [...capture.domains],
    eventCount: capture.events.length,
    maxEvents: capture.maxEvents,
  };
}

function readBrowserCdpEvents(input?: {
  id?: string;
  methods?: string[];
  methodPrefix?: string;
  limit?: number;
  clear?: boolean;
}): {
  id: string;
  recording: boolean;
  events: BrowserCdpEventRecord[];
} {
  const { record } = browserTargetFor(input?.id);
  const capture = record.cdpCapture;
  const methods = safeCdpMethods(input?.methods);
  const methodPrefix = safeCdpMethodPrefix(input?.methodPrefix);
  const limit = clampInteger(input?.limit ?? 500, 1, 10_000);
  const events = (capture?.events ?? []).filter((event) => {
    if (methods.size && !methods.has(event.method)) return false;
    if (methodPrefix && !event.method.startsWith(methodPrefix)) return false;
    return true;
  });
  const selected = events.slice(-limit);
  if (capture && input?.clear === true) capture.events = [];
  return {
    id: record.id,
    recording: Boolean(capture),
    events: selected,
  };
}

function stopBrowserCdpCapture(input?: { id?: string }): {
  id: string;
  recording: boolean;
} {
  const { record } = browserTargetFor(input?.id);
  disposeBrowserCdpCapture(record);
  return { id: record.id, recording: false };
}

function startBrowserScreencast(input?: {
  id?: string;
  format?: string;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}): {
  id: string;
  running: boolean;
  format: "jpeg" | "png";
  maxWidth: number;
  maxHeight: number;
  quality?: number;
} {
  requireRemoteBrowserControl();
  const { record } = browserTargetFor(input?.id);
  if (!record.view) throw new Error("Browser screencast requires an Electron browser view.");
  disposeBrowserScreencast(record);
  const format = input?.format === "png" ? "png" : "jpeg";
  const quality =
    format === "jpeg"
      ? clampInteger(input?.quality ?? DEFAULT_SCREENCAST_QUALITY, 1, 100)
      : undefined;
  const screencast: BrowserScreencast = {
    awaitingAck: false,
    captureInFlight: false,
    everyNthFrame: clampInteger(input?.everyNthFrame ?? 1, 1, 10),
    failureCount: 0,
    format,
    maxHeight: clampInteger(input?.maxHeight ?? DEFAULT_SCREENCAST_MAX_HEIGHT, 1, 4096),
    maxWidth: clampInteger(input?.maxWidth ?? DEFAULT_SCREENCAST_MAX_WIDTH, 1, 4096),
    quality,
    running: true,
    sessionId: 0,
  };
  record.screencast = screencast;
  browserTargets.set(record.id, record);
  scheduleBrowserScreencastFrame(record.id, 0);
  return {
    id: record.id,
    running: true,
    format: screencast.format,
    maxWidth: screencast.maxWidth,
    maxHeight: screencast.maxHeight,
    quality: screencast.quality,
  };
}

function ackBrowserScreencastFrame(input: { id?: string; sessionId?: number }): {
  id: string;
  acknowledged: boolean;
} {
  const { record } = browserTargetFor(input?.id);
  const sessionId = Math.floor(Number(input?.sessionId));
  if (!Number.isInteger(sessionId) || sessionId < 0) {
    throw new Error("browser.screencastAck requires a valid session id.");
  }
  const screencast = record.screencast;
  if (!screencast || !screencast.awaitingAck || screencast.pendingSessionId !== sessionId) {
    return { id: record.id, acknowledged: false };
  }
  screencast.awaitingAck = false;
  screencast.pendingSessionId = undefined;
  scheduleBrowserScreencastFrame(record.id, browserScreencastFrameDelay(screencast));
  return { id: record.id, acknowledged: true };
}

function stopBrowserScreencast(input?: { id?: string }): { id: string; running: boolean } {
  const { record } = browserTargetFor(input?.id);
  disposeBrowserScreencast(record);
  return { id: record.id, running: false };
}

async function dispatchBrowserMouseEvent(input: {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  button?: string;
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}): Promise<BrowserAutomationResult> {
  requireRemoteBrowserControl();
  const type = safeMouseEventType(input?.type);
  const x = finiteCoordinate(input?.x, "x");
  const y = finiteCoordinate(input?.y, "y");
  const { record, target } = browserTargetFor(input?.id);
  const payload: Record<string, unknown> = {
    type,
    x,
    y,
    button: safeMouseButton(input?.button),
    buttons: clampInteger(input?.buttons ?? (type === "mousePressed" ? 1 : 0), 0, 31),
    clickCount: clampInteger(input?.clickCount ?? 1, 0, 10),
    modifiers: clampInteger(input?.modifiers ?? 0, 0, 15),
    pointerType: "mouse",
  };
  if (type === "mouseWheel") {
    payload.deltaX = finiteNumber(input?.deltaX, 0);
    payload.deltaY = finiteNumber(input?.deltaY, 0);
  }
  await withBrowserCdp(target, (send) => send("Input.dispatchMouseEvent", payload));
  scheduleBrowserScreencastFrame(record.id, 0);
  return browserAutomationResult(record, target);
}

async function dispatchBrowserKeyEvent(input: {
  id?: string;
  type?: string;
  key?: string;
  code?: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  autoRepeat?: boolean;
  isKeypad?: boolean;
  modifiers?: number;
}): Promise<BrowserAutomationResult> {
  requireRemoteBrowserControl();
  const type = safeKeyEventType(input?.type);
  const { record, target } = browserTargetFor(input?.id);
  const payload: Record<string, unknown> = {
    type,
    autoRepeat: input?.autoRepeat === true,
    isKeypad: input?.isKeypad === true,
    modifiers: clampInteger(input?.modifiers ?? 0, 0, 15),
  };
  copyOptionalString(payload, "key", input?.key, 128);
  copyOptionalString(payload, "code", input?.code, 128);
  copyOptionalString(payload, "text", input?.text, 4_096);
  copyOptionalString(payload, "unmodifiedText", input?.unmodifiedText, 4_096);
  if (input?.windowsVirtualKeyCode !== undefined) {
    payload.windowsVirtualKeyCode = clampInteger(input.windowsVirtualKeyCode, 0, 1_000_000);
  }
  if (input?.nativeVirtualKeyCode !== undefined) {
    payload.nativeVirtualKeyCode = clampInteger(input.nativeVirtualKeyCode, 0, 1_000_000);
  }
  await withBrowserCdp(target, (send) => send("Input.dispatchKeyEvent", payload));
  scheduleBrowserScreencastFrame(record.id, 0);
  return browserAutomationResult(record, target);
}

async function insertBrowserText(input: {
  id?: string;
  text?: string;
}): Promise<BrowserAutomationResult> {
  requireRemoteBrowserControl();
  const text = String(input?.text ?? "");
  if (text.length > 200_000) throw new Error("Browser input text is too long.");
  const { record, target } = browserTargetFor(input?.id);
  await withBrowserCdp(target, (send) => send("Input.insertText", { text }));
  scheduleBrowserScreencastFrame(record.id, 0);
  return browserAutomationResult(record, target);
}

function browserTargetFor(id?: string): { record: BrowserTarget; target: WebContents } {
  const browserId = typeof id === "string" && id.trim() ? safeBrowserId(id) : "";
  const record = browserId
    ? browserTargets.get(browserId)
    : [...browserTargets.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!record) throw new Error("No browser tab is registered for automation.");
  try {
    const target = trustedBrowserWebContents(record.webContentsId);
    return { record, target };
  } catch (error) {
    browserTargets.delete(record.id);
    throw error;
  }
}

function browserAutomationResultFor(id?: string): BrowserAutomationResult {
  const { record, target } = browserTargetFor(id);
  return browserAutomationResult(record, target);
}

function browserTargetRecord(record: BrowserTarget, target: WebContents): BrowserTargetRecord {
  const currentUrl = target.getURL();
  const url =
    currentUrl && (currentUrl !== "about:blank" || record.url === "about:blank")
      ? currentUrl
      : record.url || "about:blank";
  const next: BrowserTargetRecord = {
    id: record.id,
    webContentsId: record.webContentsId,
    url,
    title: target.getTitle() || record.title || "Browser",
    faviconUrl:
      url === "about:blank" ? undefined : (record.faviconUrl ?? fallbackBrowserFaviconUrl(url)),
    loading: target.isLoadingMainFrame(),
    canGoBack: browserCanGo(target, "back"),
    canGoForward: browserCanGo(target, "forward"),
    updatedAt: Date.now(),
  };
  browserTargets.set(record.id, {
    cdpCapture: record.cdpCapture,
    id: next.id,
    screencast: record.screencast,
    webContentsId: next.webContentsId,
    url: next.url,
    title: next.title,
    faviconUrl: next.faviconUrl,
    updatedAt: next.updatedAt,
    view: record.view,
  });
  return next;
}

function browserCanGo(target: WebContents, direction: "back" | "forward"): boolean {
  const navigationHistory = (
    target as WebContents & {
      navigationHistory?: {
        canGoBack?: () => boolean;
        canGoForward?: () => boolean;
      };
    }
  ).navigationHistory;
  const method = direction === "back" ? "canGoBack" : "canGoForward";
  if (navigationHistory?.[method]) return navigationHistory[method]() === true;
  return direction === "back" ? target.canGoBack() : target.canGoForward();
}

function browserAutomationResult(
  record: BrowserTarget,
  target: WebContents,
): { id: string; url: string; title: string; faviconUrl?: string } {
  const snapshot = browserTargetRecord(record, target);
  return {
    id: snapshot.id,
    url: snapshot.url,
    title: snapshot.title,
    faviconUrl: snapshot.faviconUrl,
  };
}

function requireRemoteBrowserControl(): void {
  if (!remoteControlEnabled()) {
    throw new Error(
      "Browser remote control is only available while AGUI Remote Access is running.",
    );
  }
}

function scheduleBrowserScreencastFrame(id: string, delayMs: number): void {
  const record = browserTargets.get(id);
  const screencast = record?.screencast;
  if (
    !record ||
    !screencast ||
    !screencast.running ||
    screencast.awaitingAck ||
    screencast.captureInFlight ||
    screencast.timer
  ) {
    return;
  }
  screencast.timer = setTimeout(
    () => {
      screencast.timer = undefined;
      void captureBrowserScreencastFrame(id);
    },
    Math.max(0, delayMs),
  );
}

async function captureBrowserScreencastFrame(id: string): Promise<void> {
  const record = browserTargets.get(id);
  const screencast = record?.screencast;
  if (!record || !screencast || !screencast.running) return;
  if (!remoteControlEnabled()) {
    disposeBrowserScreencast(record);
    return;
  }
  if (!record.view) {
    disposeBrowserScreencast(record);
    return;
  }
  const target = electronWebContents.fromId(record.webContentsId);
  if (!target || target.isDestroyed()) {
    disposeBrowserScreencast(record);
    return;
  }
  const bounds = record.view.getBounds();
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  if (width <= 1 || height <= 1) {
    scheduleBrowserScreencastFrame(id, browserScreencastFrameDelay(screencast));
    return;
  }
  screencast.captureInFlight = true;
  try {
    const image = await target.capturePage({ x: 0, y: 0, width, height });
    const frame = resizeBrowserScreencastImage(image, screencast.maxWidth, screencast.maxHeight);
    if (frame.isEmpty()) throw new Error("Browser screencast captured an empty frame.");
    const timestamp = Date.now();
    const sessionId = screencast.sessionId + 1;
    screencast.sessionId = sessionId;
    screencast.awaitingAck = true;
    screencast.pendingSessionId = sessionId;
    screencast.failureCount = 0;
    emitBrowserEvent({
      id: record.id,
      type: "screencastFrame",
      data:
        screencast.format === "png"
          ? frame.toPNG().toString("base64")
          : frame.toJPEG(screencast.quality ?? DEFAULT_SCREENCAST_QUALITY).toString("base64"),
      metadata: {
        deviceHeight: height,
        deviceWidth: width,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
      mimeType: screencast.format === "png" ? "image/png" : "image/jpeg",
      sessionId,
      timestamp,
    });
  } catch (error) {
    screencast.failureCount += 1;
    if (screencast.failureCount === 1) emitBrowserTargetLoadFailure(record, error);
    if (screencast.failureCount >= 3) disposeBrowserScreencast(record);
  } finally {
    const current = browserTargets.get(id);
    if (current?.screencast === screencast) {
      screencast.captureInFlight = false;
      if (!screencast.awaitingAck) {
        scheduleBrowserScreencastFrame(id, browserScreencastFrameDelay(screencast));
      }
    }
  }
}

function browserScreencastFrameDelay(screencast: BrowserScreencast): number {
  return SCREENCAST_FRAME_INTERVAL_MS * screencast.everyNthFrame;
}

function resizeBrowserScreencastImage(
  image: NativeImage,
  maxWidth: number,
  maxHeight: number,
): NativeImage {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return image;
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  if (scale >= 1) return image;
  return image.resize({
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "good",
    width: Math.max(1, Math.round(size.width * scale)),
  });
}

function disposeBrowserScreencast(record: BrowserTarget): void {
  const screencast = record.screencast;
  if (!screencast) return;
  record.screencast = undefined;
  screencast.running = false;
  if (screencast.timer) clearTimeout(screencast.timer);
  screencast.timer = undefined;
  screencast.awaitingAck = false;
  screencast.pendingSessionId = undefined;
}

async function withBrowserCdp<T>(
  target: WebContents,
  callback: (
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<T>,
): Promise<T> {
  let attachedHere = false;
  if (!target.debugger.isAttached()) {
    target.debugger.attach("1.3");
    attachedHere = true;
  }
  const send = (method: string, params?: Record<string, unknown>) =>
    target.debugger.sendCommand(method, params);
  try {
    await send("Runtime.enable").catch(() => undefined);
    await send("Page.enable").catch(() => undefined);
    return await callback(send);
  } finally {
    if (attachedHere && !target.isDestroyed() && target.debugger.isAttached()) {
      target.debugger.detach();
    }
  }
}

async function evaluateInBrowser(
  target: WebContents,
  expression: string,
  awaitPromise: boolean,
): Promise<{ type: string; value?: unknown; description?: string }> {
  const result = await withBrowserCdp(target, async (send) =>
    send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    }),
  );
  const payload = recordValue(result);
  const exceptionDetails = recordValue(payload.exceptionDetails);
  if (Object.keys(exceptionDetails).length > 0) {
    const exception = recordValue(exceptionDetails.exception);
    throw new Error(
      stringField(exception, "description") ||
        stringField(exceptionDetails, "text") ||
        "Browser evaluation failed.",
    );
  }
  const runtimeResult = recordValue(payload.result);
  return {
    type: stringField(runtimeResult, "type") || "undefined",
    value: runtimeResult.value,
    description: stringField(runtimeResult, "description") || undefined,
  };
}

async function browserClickPoint(
  target: WebContents,
  input: { selector?: string; x?: number; y?: number },
): Promise<{ x: number; y: number }> {
  if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
    return { x: Number(input.x), y: Number(input.y) };
  }
  const selector = String(input.selector || "").trim();
  if (!selector) throw new Error("Browser click requires either selector or coordinates.");
  const result = await evaluateInBrowser(
    target,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    true,
  );
  const point = recordValue(result.value);
  const x = numberField(point, "x");
  const y = numberField(point, "y");
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Browser click target was not found or visible: ${selector}`);
  }
  return { x, y };
}

async function dispatchBrowserClick(target: WebContents, x: number, y: number): Promise<void> {
  target.focus();
  await withBrowserCdp(target, async (send) => {
    const marker = `__agui_cdp_click_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    await send("Runtime.evaluate", {
      expression: `(() => {
        const key = ${JSON.stringify(marker)};
        window[key] = false;
        document.addEventListener("click", () => { window[key] = true; }, { capture: true, once: true });
      })()`,
      returnByValue: true,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const clickedResult = await send("Runtime.evaluate", {
      expression: `Boolean(window[${JSON.stringify(marker)}])`,
      returnByValue: true,
    }).catch(() => undefined);
    const clicked = recordValue(recordValue(clickedResult).result).value === true;
    if (!clicked) {
      await send("Runtime.evaluate", {
        expression: `(() => {
          const x = ${JSON.stringify(x)};
          const y = ${JSON.stringify(y)};
          const hit = document.elementFromPoint(x, y);
          if (!hit) return false;
          const target = hit.closest("button, input, textarea, select, a, [role='button'], [onclick]") || hit;
          if (typeof target.focus === "function") {
            try { target.focus({ preventScroll: true }); } catch { target.focus(); }
          }
          const base = { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
          if (typeof PointerEvent === "function") {
            target.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          }
          target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
          if (typeof PointerEvent === "function") {
            target.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          }
          target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
          target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
          return true;
        })()`,
        returnByValue: true,
      });
    }
    await send("Runtime.evaluate", {
      expression: `delete window[${JSON.stringify(marker)}]`,
      returnByValue: true,
    }).catch(() => undefined);
  });
}

async function ensureBrowserAnnotationController(target: WebContents): Promise<void> {
  await evaluateBrowserAnnotationStep(
    target,
    browserAnnotationInstallExpression(),
    "Annotation controller injection failed",
  );
}

async function ensureBrowserWorkflowRecorder(
  target: WebContents,
  enabled: boolean,
): Promise<{ type: string; value?: unknown; description?: string }> {
  return evaluateBrowserAnnotationStep(
    target,
    browserWorkflowRecorderInstallExpression(enabled),
    "Workflow recorder injection failed",
  );
}

async function evaluateBrowserAnnotationStep(
  target: WebContents,
  expression: string,
  step: string,
): Promise<{ type: string; value?: unknown; description?: string }> {
  try {
    return await evaluateInBrowser(target, expression, true);
  } catch (error) {
    throw new Error(`${step}: ${formatRuntimeError(error)}`);
  }
}

function browserWorkflowRecorderInstallExpression(enabled: boolean): string {
  return `(() => {
    const enabled = ${enabled ? "true" : "false"};
    const marker = "[AGUI_BROWSER_WORKFLOW]";
    if (window.__aguiBrowserWorkflowRecorder?.version === 1) {
      return window.__aguiBrowserWorkflowRecorder.setEnabled(enabled);
    }
    try {
      window.__aguiBrowserWorkflowRecorder?.destroy?.();
    } catch {}

    const state = { enabled: false };
    const truncate = (value, maxLength) => {
      const text = typeof value === "string" ? value.trim() : "";
      return text.length > maxLength ? text.slice(0, maxLength) : text;
    };
    const cssEscape = (value) => {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return String(value).replace(/[^A-Za-z0-9_-]/g, (char) => "\\\\" + char);
    };
    const viewport = () => ({
      width: Math.max(0, Math.round(window.innerWidth || document.documentElement.clientWidth || 0)),
      height: Math.max(0, Math.round(window.innerHeight || document.documentElement.clientHeight || 0)),
      scrollX: Math.round(window.scrollX || document.documentElement.scrollLeft || 0),
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0)
    });
    const rectPayload = (element) => {
      const rect = element?.getBoundingClientRect?.();
      if (!rect) return { x: 0, y: 0, width: 0, height: 0 };
      return {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height))
      };
    };
    const elementText = (element) => truncate(
      element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || element?.getAttribute?.("title") || "",
      1000
    );
    const elementFromEvent = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const candidate = path.find((item) => item instanceof Element) || event.target;
      return candidate instanceof Element ? candidate : null;
    };
    const actionableElement = (element) =>
      element.closest?.("button,a,input,textarea,select,option,label,summary,[role='button'],[role='link'],[role='menuitem'],[role='option'],[contenteditable='true']") || element;
    const isInputLike = (element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element.isContentEditable === true;
    const isRedactedInput = (element) => {
      if (!(element instanceof HTMLInputElement)) return false;
      const inputType = (element.type || "").toLowerCase();
      const autocomplete = (element.autocomplete || "").toLowerCase();
      return inputType === "password" || /password|one-time-code|cc-|card|token|secret/.test(autocomplete);
    };
    const elementValue = (element) => {
      if (!isInputLike(element)) return undefined;
      if (isRedactedInput(element)) return "";
      if (element instanceof HTMLSelectElement) return element.value;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
      return element.textContent || "";
    };
    const uniqueSelector = (selector, element) => {
      if (!selector) return "";
      try {
        return document.querySelector(selector) === element ? selector : "";
      } catch {
        return "";
      }
    };
    const selectorFor = (element) => {
      if (!(element instanceof Element)) return undefined;
      if (element.id) {
        const idSelector = uniqueSelector("#" + cssEscape(element.id), element);
        if (idSelector) return idSelector;
      }
      const attrNames = ["data-testid", "data-test", "data-cy", "name", "aria-label", "placeholder", "title", "role", "type"];
      for (const name of attrNames) {
        const raw = element.getAttribute(name);
        if (!raw || raw.length > 120) continue;
        const selector = uniqueSelector(
          element.tagName.toLowerCase() + "[" + name + "=" + JSON.stringify(raw) + "]",
          element
        );
        if (selector) return selector;
      }
      const parts = [];
      let current = element;
      for (let depth = 0; current && current instanceof Element && depth < 5; depth += 1) {
        const tag = current.tagName.toLowerCase();
        const classes = Array.from(current.classList || [])
          .filter((name) => /^[A-Za-z0-9_-]{1,48}$/.test(name))
          .slice(0, 2)
          .map((name) => "." + cssEscape(name))
          .join("");
        let part = tag + classes;
        const parent = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        const selector = uniqueSelector(parts.join(" > "), element);
        if (selector) return selector;
        current = parent;
      }
      return parts.join(" > ") || undefined;
    };
    const emit = (type, event, targetElement) => {
      if (!state.enabled || !(targetElement instanceof Element)) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.some((item) => item instanceof Element && item.id === "__agui_browser_annotation_host")) return;
      if (targetElement.closest("#__agui_browser_annotation_host")) return;
      const inputType =
        targetElement instanceof HTMLInputElement ? truncate(targetElement.type || "text", 80) : undefined;
      const redacted = isRedactedInput(targetElement);
      const value = elementValue(targetElement);
      const payload = {
        createdAt: Date.now(),
        eventId: "workflow-event-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36),
        inputType,
        rect: rectPayload(targetElement),
        redacted: redacted || undefined,
        selector: selectorFor(targetElement),
        tagName: truncate(targetElement.tagName.toLowerCase(), 128),
        text: elementText(targetElement),
        title: truncate(document.title || "", 8192),
        type,
        url: truncate(location.href || "", 16384),
        value: value === undefined ? undefined : truncate(value, 200000),
        viewport: viewport()
      };
      try {
        console.info(marker + " " + JSON.stringify(payload));
      } catch {}
    };
    const onClick = (event) => {
      const element = elementFromEvent(event);
      if (!element) return;
      emit("click", event, actionableElement(element));
    };
    const onInput = (event) => {
      const element = elementFromEvent(event);
      if (!element || !isInputLike(element)) return;
      emit("input", event, element);
    };
    const onChange = (event) => {
      const element = elementFromEvent(event);
      if (!element || !isInputLike(element)) return;
      emit("input", event, element);
    };
    const onSubmit = (event) => {
      const element = elementFromEvent(event);
      const form = element instanceof HTMLFormElement ? element : element?.closest?.("form");
      emit("submit", event, form || element);
    };
    const addListeners = () => {
      if (state.enabled) return;
      document.addEventListener("click", onClick, true);
      document.addEventListener("input", onInput, true);
      document.addEventListener("change", onChange, true);
      document.addEventListener("submit", onSubmit, true);
      state.enabled = true;
    };
    const removeListeners = () => {
      if (!state.enabled) return;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("submit", onSubmit, true);
      state.enabled = false;
    };
    const status = () => ({ enabled: state.enabled, version: 1 });
    window.__aguiBrowserWorkflowRecorder = {
      version: 1,
      setEnabled(value) {
        if (value === true) addListeners();
        else removeListeners();
        return status();
      },
      status,
      destroy() {
        removeListeners();
      }
    };
    return window.__aguiBrowserWorkflowRecorder.setEnabled(enabled);
  })()`;
}

function browserAnnotationInstallExpression(): string {
  return `(() => {
    if (window.__aguiBrowserAnnotations?.version === 7) {
      return window.__aguiBrowserAnnotations.status();
    }
    const previousAnnotations = (() => {
      try {
        const existing = window.__aguiBrowserAnnotations?.list?.();
        return Array.isArray(existing) ? existing.slice(-500) : [];
      } catch {
        return [];
      }
    })();
    try {
      document.getElementById("__agui_browser_annotation_host")?.remove();
    } catch {}
    const styleFields = [
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "line-height",
      "letter-spacing",
      "color",
      "background-color",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "border",
      "border-radius",
      "display",
      "position",
      "width",
      "height",
      "text-align",
      "text-transform"
    ];
    const state = {
      annotations: previousAnnotations,
      enabled: false,
      toolbarVisible: false,
      toolbarExpanded: false,
      host: null,
      shadow: null,
      start: null,
      selection: null,
      pendingMarker: null,
      activeEditor: null
    };
    const cssEscape = (value) => {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    };
    const viewport = () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    });
    const rectPayload = (rect) => ({
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
    const selectorFor = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
      if (element.id) return "#" + cssEscape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const parent = current.parentElement;
        const tag = current.tagName.toLowerCase();
        const siblings = parent
          ? Array.from(parent.children).filter((item) => item.tagName === current.tagName)
          : [];
        const index = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "";
        parts.unshift(tag + index);
        current = parent;
        if (parts.length >= 6) break;
      }
      return parts.join(" > ");
    };
    const stylesFor = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return {};
      const computed = window.getComputedStyle(element);
      const styles = {};
      for (const field of styleFields) styles[field] = computed.getPropertyValue(field);
      return styles;
    };
    const targetFromElement = (element) => {
      if (!element || element === state.host || state.host?.contains(element)) return null;
      const rect = element.getBoundingClientRect();
      return {
        type: "element",
        selector: selectorFor(element),
        tagName: element.tagName.toLowerCase(),
        text: (element.innerText || element.textContent || "").trim().slice(0, 1000),
        rect: rectPayload(rect),
        styles: stylesFor(element)
      };
    };
    const normalizeViewportRect = (input) => {
      const rect = input?.rect || input || {};
      const x = Number.isFinite(Number(rect.x)) ? Number(rect.x) : Number.isFinite(Number(input?.x)) ? Number(input.x) : NaN;
      const y = Number.isFinite(Number(rect.y)) ? Number(rect.y) : Number.isFinite(Number(input?.y)) ? Number(input.y) : NaN;
      const width = Number.isFinite(Number(rect.width)) ? Number(rect.width) : Number.isFinite(Number(input?.width)) ? Number(input.width) : 1;
      const height = Number.isFinite(Number(rect.height)) ? Number(rect.height) : Number.isFinite(Number(input?.height)) ? Number(input.height) : 1;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height))
      };
    };
    const pageRectFromViewportRect = (rect) => ({
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height))
    });
    const targetFromInput = (input) => {
      const requestedType = input?.type === "element" || input?.type === "region" ? input.type : "";
      const selector = typeof input?.selector === "string" ? input.selector.trim() : "";
      const viewportRect = normalizeViewportRect(input);
      if (requestedType === "region") {
        if (!viewportRect) return null;
        return { type: "region", rect: pageRectFromViewportRect(viewportRect) };
      }
      const element = selector
        ? document.querySelector(selector)
        : viewportRect
          ? elementAt(viewportRect.x + viewportRect.width / 2, viewportRect.y + viewportRect.height / 2)
          : null;
      const elementTarget = targetFromElement(element);
      if (elementTarget) return elementTarget;
      if (viewportRect) return { type: "region", rect: pageRectFromViewportRect(viewportRect) };
      return null;
    };
    const annotationFromTarget = (target, note, annotationId) => ({
      id: annotationId || "ann-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      type: target.type,
      note,
      url: location.href,
      title: document.title,
      selector: target.selector,
      tagName: target.tagName,
      text: target.text,
      rect: target.rect,
      viewport: viewport(),
      styles: target.styles,
      createdAt: Date.now()
    });
    const elementAt = (x, y) => {
      const host = state.host;
      if (!host) return null;
      const previous = host.style.pointerEvents;
      host.style.pointerEvents = "none";
      const element = document.elementFromPoint(x, y);
      host.style.pointerEvents = previous;
      return element;
    };
    const removeNode = (node) => node?.parentNode?.removeChild(node);
    const ensureHost = () => {
      if (state.host && document.documentElement.contains(state.host)) return state.host;
      const host = document.createElement("div");
      host.id = "__agui_browser_annotation_host";
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.zIndex = "2147483647";
      host.style.pointerEvents = "none";
      host.style.display = "none";
      host.style.colorScheme = "light";
      host.style.userSelect = "none";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = [
        ":host{all:initial}",
        ".surface{position:fixed;inset:0;cursor:crosshair;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;pointer-events:none}",
        ".hint{position:fixed;left:12px;top:12px;display:none;align-items:center;gap:8px;border:1px solid rgba(37,99,235,.28);border-radius:999px;background:rgba(15,23,42,.92);color:white;box-shadow:0 10px 28px rgba(15,23,42,.24);padding:7px 11px;font:600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;pointer-events:none}",
        ".hint::before{content:\\"\\";width:7px;height:7px;border-radius:999px;background:#60a5fa;box-shadow:0 0 0 4px rgba(96,165,250,.20)}",
        ".toolbar{position:fixed;left:50%;bottom:12px;z-index:3;display:none;align-items:center;transform:translateX(-50%);pointer-events:auto;color:white;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}",
        ".toolbar .handle,.toolbar .bar{border:1px solid rgba(255,255,255,.10);background:#15171d;box-shadow:0 14px 34px rgba(0,0,0,.28)}",
        ".toolbar .handle{display:flex;height:40px;min-width:40px;align-items:center;justify-content:center;border-radius:999px;padding:0 12px;color:white;cursor:pointer}",
        ".toolbar .handle:hover{border-color:rgba(255,255,255,.16);background:#191b22}",
        ".toolbar .bar{display:flex;height:40px;align-items:center;gap:4px;border-radius:999px;padding:0 6px}",
        ".toolbar.collapsed .bar{display:none}",
        ".toolbar:not(.collapsed) .handle{display:none}",
        ".toolbar button{display:flex;height:28px;width:28px;align-items:center;justify-content:center;border:0;border-radius:999px;background:transparent;color:rgba(255,255,255,.82);cursor:pointer;padding:0}",
        ".toolbar button:hover{background:rgba(255,255,255,.07);color:white}",
        ".toolbar button.active{background:#4f7cff;color:white}",
        ".toolbar button:focus-visible{outline:2px solid rgba(255,255,255,.70);outline-offset:2px}",
        ".toolbar svg{width:16px;height:16px;stroke:currentColor;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round;fill:none}",
        ".toolbar .divider{height:20px;width:1px;background:rgba(255,255,255,.12)}",
        ".toolbar .badge{position:absolute;right:-4px;top:-4px;display:none;height:14px;min-width:14px;align-items:center;justify-content:center;border-radius:999px;background:#4f7cff;color:white;padding:0 2px;font:600 9px/14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.22)}",
        ".toolbar .tool{position:relative}",
        ".selection{position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.12);pointer-events:none;box-sizing:border-box}",
        ".pending{position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.14);box-sizing:border-box;pointer-events:none;box-shadow:0 0 0 1px rgba(255,255,255,.85),0 0 0 4px rgba(37,99,235,.18)}",
        ".marker{position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.10);box-sizing:border-box;pointer-events:none}",
        ".label{position:absolute;left:-2px;top:-22px;min-width:18px;height:18px;border-radius:9px;background:#2563eb;color:white;font:600 11px/18px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;text-align:center;padding:0 5px;box-sizing:border-box}",
        ".remove{position:absolute;right:-10px;top:-10px;display:flex;width:20px;height:20px;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.92);border-radius:999px;background:#ef4444;color:white;box-shadow:0 5px 16px rgba(15,23,42,.25);font:700 14px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;pointer-events:auto;cursor:pointer;padding:0}",
        ".remove:hover{background:#dc2626}",
        ".remove:focus-visible{outline:2px solid white;outline-offset:2px}",
        ".editor{position:fixed;width:260px;border:1px solid rgba(15,23,42,.18);border-radius:8px;background:white;box-shadow:0 16px 38px rgba(15,23,42,.22);padding:10px;box-sizing:border-box;color:#0f172a;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}",
        ".editor textarea{display:block;width:100%;height:84px;resize:vertical;border:1px solid rgba(15,23,42,.20);border-radius:6px;padding:8px;box-sizing:border-box;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#0f172a;background:white;outline:none}",
        ".editor textarea:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.18)}",
        ".actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}",
        ".actions button{border:1px solid rgba(15,23,42,.16);border-radius:6px;background:#f8fafc;color:#0f172a;font:500 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:7px 9px;cursor:pointer}",
        ".actions button.primary{border-color:#2563eb;background:#2563eb;color:white}"
      ].join("\\n");
      const surface = document.createElement("div");
      surface.className = "surface";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Annotation mode: click or drag to comment";
      const toolbar = document.createElement("div");
      toolbar.className = "toolbar collapsed";
      const chevronUpIcon =
        "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"m18 15-6-6-6 6\\"></path></svg>";
      const chevronDownIcon =
        "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"m6 9 6 6 6-6\\"></path></svg>";
      const cameraIcon =
        "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z\\"></path><circle cx=\\"12\\" cy=\\"13\\" r=\\"3\\"></circle></svg>";
      const pencilIcon =
        "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M21.2 6.8 17.2 2.8 4 16v4h4L21.2 6.8z\\"></path><path d=\\"m14 6 4 4\\"></path></svg>";
      const undoIcon =
        "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M3 7v6h6\\"></path><path d=\\"M21 17a9 9 0 0 0-15-6.7L3 13\\"></path></svg>";
      const trashIcon =
        "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M3 6h18\\"></path><path d=\\"M8 6V4h8v2\\"></path><path d=\\"m19 6-1 14H6L5 6\\"></path><path d=\\"M10 11v5\\"></path><path d=\\"M14 11v5\\"></path></svg>";
      toolbar.innerHTML = [
        "<button class=\\"handle\\" type=\\"button\\" aria-label=\\"Show annotation tools\\">" +
          chevronUpIcon +
          "</button>",
        "<div class=\\"bar\\">",
        "<button class=\\"collapse\\" type=\\"button\\" aria-label=\\"Collapse annotation tools\\">" +
          chevronDownIcon +
          "</button>",
        "<div class=\\"divider\\"></div>",
        "<button class=\\"tool snapshot\\" type=\\"button\\" aria-label=\\"Capture page snapshot\\">" +
          cameraIcon +
          "</button>",
        "<button class=\\"tool annotate\\" type=\\"button\\" aria-label=\\"Add annotation\\" aria-pressed=\\"false\\">" +
          pencilIcon +
          "<span class=\\"badge\\"></span></button>",
        "<button class=\\"tool undo\\" type=\\"button\\" aria-label=\\"Undo last browser context\\">" +
          undoIcon +
          "</button>",
        "<button class=\\"tool clear\\" type=\\"button\\" aria-label=\\"Clear browser context\\">" +
          trashIcon +
          "</button>",
        "</div>"
      ].join("");
      shadow.append(style, surface, hint, toolbar);
      document.documentElement.append(host);
      state.host = host;
      state.shadow = shadow;
      surface.addEventListener("pointerdown", onPointerDown);
      surface.addEventListener("pointermove", onPointerMove);
      surface.addEventListener("pointerup", onPointerUp);
      toolbar.querySelector(".handle")?.addEventListener("click", () => {
        state.toolbarExpanded = true;
        syncHost();
      });
      toolbar.querySelector(".collapse")?.addEventListener("click", () => {
        state.toolbarExpanded = false;
        syncHost();
      });
      toolbar.querySelector(".annotate")?.addEventListener("click", () => {
        state.enabled = !state.enabled;
        if (!state.enabled) closeEditor();
        state.toolbarExpanded = false;
        syncHost();
      });
      const emitToolAction = (action) => {
        try {
          console.info("[AGUI_BROWSER_ANNOTATION_TOOL] " + JSON.stringify({ action }));
        } catch {}
      };
      toolbar.querySelector(".snapshot")?.addEventListener("click", () => {
        state.toolbarExpanded = false;
        syncHost();
        emitToolAction("snapshot");
      });
      toolbar.querySelector(".undo")?.addEventListener("click", () => {
        state.toolbarExpanded = false;
        syncHost();
        emitToolAction("undo");
      });
      toolbar.querySelector(".clear")?.addEventListener("click", () => {
        state.toolbarExpanded = false;
        syncHost();
        emitToolAction("clear");
      });
      window.addEventListener("scroll", renderMarkers, true);
      window.addEventListener("resize", renderMarkers);
      return host;
    };
    const surface = () => state.shadow?.querySelector(".surface");
    const viewportBoxForTarget = (target) => {
      let rect = target?.rect;
      if (target?.type === "element" && target.selector) {
        const element = document.querySelector(target.selector);
        if (element) rect = rectPayload(element.getBoundingClientRect());
      }
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return {
        left: Math.round(rect.x - window.scrollX),
        top: Math.round(rect.y - window.scrollY),
        width: Math.max(8, Math.round(rect.width)),
        height: Math.max(8, Math.round(rect.height))
      };
    };
    const positionMarkerNode = (node, target) => {
      const box = viewportBoxForTarget(target);
      if (!box) {
        node.style.display = "none";
        return;
      }
      node.style.display = "block";
      node.style.left = box.left + "px";
      node.style.top = box.top + "px";
      node.style.width = box.width + "px";
      node.style.height = box.height + "px";
    };
    const renderPendingMarker = () => {
      if (!state.pendingMarker) return;
      positionMarkerNode(state.pendingMarker.node, state.pendingMarker.target);
    };
    const removePendingMarker = () => {
      removeNode(state.pendingMarker?.node);
      state.pendingMarker = null;
    };
    const showPendingMarker = (target) => {
      const pane = surface();
      if (!pane) return;
      removePendingMarker();
      const node = document.createElement("div");
      node.className = "pending";
      state.pendingMarker = { node, target };
      pane.append(node);
      positionMarkerNode(node, target);
    };
    const onPointerDown = (event) => {
      if (!state.enabled || event.button !== 0 || state.activeEditor) return;
      event.preventDefault();
      state.start = { x: event.clientX, y: event.clientY };
      state.selection = document.createElement("div");
      state.selection.className = "selection";
      surface()?.append(state.selection);
    };
    const onPointerMove = (event) => {
      if (!state.start || !state.selection) return;
      const left = Math.min(state.start.x, event.clientX);
      const top = Math.min(state.start.y, event.clientY);
      const width = Math.abs(event.clientX - state.start.x);
      const height = Math.abs(event.clientY - state.start.y);
      Object.assign(state.selection.style, {
        left: left + "px",
        top: top + "px",
        width: width + "px",
        height: height + "px"
      });
    };
    const onPointerUp = (event) => {
      if (!state.start) return;
      event.preventDefault();
      const start = state.start;
      const selection = state.selection;
      state.start = null;
      state.selection = null;
      removeNode(selection);
      const width = Math.abs(event.clientX - start.x);
      const height = Math.abs(event.clientY - start.y);
      if (width >= 8 && height >= 8) {
        const left = Math.min(start.x, event.clientX);
        const top = Math.min(start.y, event.clientY);
        openEditor(event.clientX, event.clientY, {
          type: "region",
          rect: {
            x: Math.round(left + window.scrollX),
            y: Math.round(top + window.scrollY),
            width: Math.round(width),
            height: Math.round(height)
          }
        });
        return;
      }
      const target = targetFromElement(elementAt(event.clientX, event.clientY));
      if (target) openEditor(event.clientX, event.clientY, target);
    };
    const openEditor = (x, y, target) => {
      closeEditor();
      showPendingMarker(target);
      const editor = document.createElement("div");
      editor.className = "editor";
      editor.style.left = Math.min(Math.max(8, x + 10), window.innerWidth - 276) + "px";
      editor.style.top = Math.min(Math.max(8, y + 10), window.innerHeight - 150) + "px";
      const textarea = document.createElement("textarea");
      textarea.placeholder = "Comment on selected element or area";
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary";
      save.textContent = "Save";
      actions.append(cancel, save);
      editor.append(textarea, actions);
      editor.addEventListener("pointerdown", (event) => event.stopPropagation());
      cancel.addEventListener("click", stopCapture);
      save.addEventListener("click", () => {
        const note = textarea.value.trim();
        if (!note) {
          textarea.focus();
          return;
        }
        const annotation = annotationFromTarget(target, note);
        state.annotations.push(annotation);
        state.enabled = false;
        state.toolbarExpanded = false;
        console.info("[AGUI_BROWSER_ANNOTATION]", JSON.stringify({ annotationId: annotation.id }));
        closeEditor();
        renderMarkers();
        syncHost();
      });
      surface()?.append(editor);
      state.activeEditor = editor;
      setTimeout(() => textarea.focus(), 0);
    };
    const closeEditor = () => {
      removeNode(state.activeEditor);
      state.activeEditor = null;
      removePendingMarker();
    };
    const stopCapture = () => {
      state.enabled = false;
      state.toolbarExpanded = false;
      state.start = null;
      removeNode(state.selection);
      state.selection = null;
      closeEditor();
      renderMarkers();
      syncHost();
    };
    const removeAnnotation = (id) => {
      const next = state.annotations.filter((annotation) => annotation.id !== id);
      if (next.length === state.annotations.length) return;
      state.annotations = next;
      console.info("[AGUI_BROWSER_ANNOTATION]", JSON.stringify({ removedAnnotationId: id }));
      renderMarkers();
      syncHost();
    };
    const renderMarkers = () => {
      const pane = surface();
      if (!pane) return;
      pane.querySelectorAll(".marker").forEach((node) => node.remove());
      state.annotations.forEach((annotation, index) => {
        const box = viewportBoxForTarget(annotation);
        if (!box) return;
        const marker = document.createElement("div");
        marker.className = "marker";
        marker.style.left = box.left + "px";
        marker.style.top = box.top + "px";
        marker.style.width = box.width + "px";
        marker.style.height = box.height + "px";
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = String(index + 1);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove";
        remove.textContent = "×";
        remove.title = "Remove annotation";
        remove.setAttribute("aria-label", "Remove annotation " + (index + 1));
        remove.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          removeAnnotation(annotation.id);
        });
        marker.append(label, remove);
        pane.append(marker);
      });
      renderPendingMarker();
    };
    const status = () => ({
      enabled: state.enabled,
      toolbarVisible: state.toolbarVisible,
      toolbarExpanded: state.toolbarExpanded,
      annotationCount: state.annotations.length
    });
    const syncHint = () => {
      const hint = state.shadow?.querySelector(".hint");
      if (hint) hint.style.display = "none";
    };
    const renderToolbar = () => {
      const toolbar = state.shadow?.querySelector(".toolbar");
      if (!toolbar) return;
      toolbar.style.display = state.toolbarVisible ? "flex" : "none";
      toolbar.classList.toggle("collapsed", !state.toolbarExpanded);
      const annotate = toolbar.querySelector(".annotate");
      annotate?.classList.toggle("active", state.enabled);
      annotate?.setAttribute("aria-pressed", state.enabled ? "true" : "false");
      const badge = toolbar.querySelector(".badge");
      if (badge) {
        badge.textContent = state.annotations.length > 9 ? "9+" : String(state.annotations.length);
        badge.style.display = state.annotations.length ? "flex" : "none";
      }
    };
    const syncHost = () => {
      if (!state.host) return;
      const visible = state.enabled || state.toolbarVisible || state.annotations.length;
      state.host.style.display = visible ? "block" : "none";
      state.host.style.pointerEvents = state.enabled ? "auto" : "none";
      const pane = surface();
      if (pane) pane.style.pointerEvents = state.enabled ? "auto" : "none";
      syncHint();
      renderToolbar();
    };
    const setEnabled = (enabled) => {
      ensureHost();
      state.enabled = Boolean(enabled);
      if (state.enabled) state.toolbarVisible = true;
      state.toolbarExpanded = false;
      closeEditor();
      syncHost();
      renderMarkers();
      return status();
    };
    const setToolbarVisible = (visible) => {
      ensureHost();
      state.toolbarVisible = Boolean(visible);
      state.toolbarExpanded = false;
      if (!state.toolbarVisible) {
        state.enabled = false;
        state.start = null;
        removeNode(state.selection);
        state.selection = null;
        closeEditor();
      }
      syncHost();
      renderMarkers();
      return status();
    };
    const list = () => state.annotations.map((annotation) => ({ ...annotation }));
    const clear = () => {
      state.annotations = [];
      closeEditor();
      renderMarkers();
      syncHost();
      console.info("[AGUI_BROWSER_ANNOTATION]", JSON.stringify({ cleared: true }));
      return status();
    };
    const add = (input) => {
      const note = typeof input?.note === "string" ? input.note.trim() : "";
      if (!note) throw new Error("Annotation note is required.");
      const target = targetFromInput(input);
      if (!target) throw new Error("Annotation target was not found.");
      const requestedId = typeof input?.annotationId === "string" ? input.annotationId.trim() : "";
      const annotation = annotationFromTarget(target, note, requestedId || undefined);
      state.annotations = state.annotations.filter((item) => item.id !== annotation.id);
      state.annotations.push(annotation);
      state.annotations = state.annotations.slice(-500);
      renderMarkers();
      syncHost();
      console.info("[AGUI_BROWSER_ANNOTATION]", JSON.stringify({ annotationId: annotation.id }));
      return { annotation, annotationCount: state.annotations.length };
    };
    const remove = (id) => {
      const previous = state.annotations.length;
      removeAnnotation(id);
      return { deleted: state.annotations.length !== previous, annotationCount: state.annotations.length };
    };
    window.__aguiBrowserAnnotations = { version: 7, setEnabled, setToolbarVisible, list, clear, add, remove, status };
    return status();
  })()`;
}

function browserElementInspectionExpression(input: {
  selector?: string;
  x?: number;
  y?: number;
}): string {
  const selector = typeof input?.selector === "string" ? input.selector.trim() : "";
  const x = Number.isFinite(input?.x) ? Number(input.x) : Number.NaN;
  const y = Number.isFinite(input?.y) ? Number(input.y) : Number.NaN;
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const x = ${JSON.stringify(x)};
    const y = ${JSON.stringify(y)};
    const styleFields = [
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "line-height",
      "letter-spacing",
      "color",
      "background-color",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "border",
      "border-radius",
      "display",
      "position",
      "width",
      "height",
      "text-align",
      "text-transform"
    ];
    const cssEscape = (value) => {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    };
    const selectorFor = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
      if (element.id) return "#" + cssEscape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const parent = current.parentElement;
        const tag = current.tagName.toLowerCase();
        const siblings = parent
          ? Array.from(parent.children).filter((item) => item.tagName === current.tagName)
          : [];
        const index = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "";
        parts.unshift(tag + index);
        current = parent;
        if (parts.length >= 6) break;
      }
      return parts.join(" > ");
    };
    const element = selector
      ? document.querySelector(selector)
      : Number.isFinite(x) && Number.isFinite(y)
        ? document.elementFromPoint(x, y)
        : null;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const computed = window.getComputedStyle(element);
    const styles = {};
    for (const field of styleFields) styles[field] = computed.getPropertyValue(field);
    const attributes = {};
    for (const attribute of Array.from(element.attributes || [])) {
      attributes[attribute.name] = attribute.value;
    }
    return {
      url: location.href,
      title: document.title,
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      className: typeof element.className === "string" ? element.className : "",
      text: (element.innerText || element.textContent || "").trim().slice(0, 2000),
      attributes,
      rect: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      styles
    };
  })()`;
}

function waitForBrowserLoad(
  target: WebContents,
  waitUntil?: string,
  timeoutMs?: number,
  expectedUrl?: string,
): Promise<void> {
  if (waitUntil === "none") return Promise.resolve();
  const eventName = waitUntil === "domcontentloaded" ? "dom-ready" : "did-finish-load";
  const timeout = timeoutMs === undefined ? 15_000 : clampInteger(timeoutMs, 1_000, 60_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Browser ${waitUntil || "load"} timed out.`));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      target.removeListener(eventName as "did-finish-load", done);
      target.removeListener("did-fail-load", failed);
      target.removeListener("destroyed", destroyed);
    };
    const done = () => {
      if (expectedUrl && !sameBrowserUrl(target.getURL(), expectedUrl)) return;
      cleanup();
      resolve();
    };
    const failed = (
      _event: unknown,
      _errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame === false) return;
      if (expectedUrl && !sameBrowserUrl(validatedURL, expectedUrl)) return;
      cleanup();
      reject(new Error(errorDescription || "Browser failed to load."));
    };
    const destroyed = () => {
      cleanup();
      reject(new Error("Browser target was destroyed."));
    };
    target.on(eventName as "did-finish-load", done);
    target.on("did-fail-load", failed);
    target.once("destroyed", destroyed);
  });
}

function sameBrowserUrl(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function browserConnectionRefusedError(url: string): Error {
  return new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}'`);
}

async function localBrowserEndpointUnavailable(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!isLoopbackBrowserHost(parsed.hostname)) return false;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const hosts =
    parsed.hostname.toLowerCase() === "localhost"
      ? ["127.0.0.1", "::1"]
      : [parsed.hostname.replace(/^\[(.*)\]$/, "$1")];
  const results = await Promise.all(
    hosts.map((host) => localBrowserEndpointHostUnavailable(host, port)),
  );
  return results.every(Boolean);
}

function localBrowserEndpointHostUnavailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const settle = (unavailable: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(unavailable);
    };
    socket.setTimeout(300, () => settle(true));
    socket.once("connect", () => settle(false));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ECONNREFUSED" || error.code === "EADDRNOTAVAIL");
    });
  });
}

function isLoopbackBrowserHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function trustedBrowserWebContents(webContentsId: number): WebContents {
  const target = electronWebContents.fromId(webContentsId);
  if (!target || target.isDestroyed()) throw new Error("Browser target is not available.");
  const record = [...browserTargets.values()].find((item) => item.webContentsId === webContentsId);
  if (record?.view?.webContents.id === webContentsId) return target;
  return trustedWebviewBrowserWebContents(webContentsId);
}

function trustedWebviewBrowserWebContents(webContentsId: number): WebContents {
  const target = electronWebContents.fromId(webContentsId);
  if (!target || target.isDestroyed()) throw new Error("Browser target is not available.");
  if (target.getType() !== "webview") {
    throw new Error("Browser automation can only target AGUI browser views.");
  }
  const host = (target as WebContents & { hostWebContents?: WebContents | null }).hostWebContents;
  if (!mainWindow || mainWindow.isDestroyed() || host?.id !== mainWindow.webContents.id) {
    throw new Error("Browser target does not belong to the AGUI window.");
  }
  return target;
}

function shouldIgnoreInteractiveAppLoadFailure(
  record: InteractiveAppView,
  error: unknown,
): boolean {
  if (!record.ignoreErrFailedAfterStart) return false;
  const code =
    typeof error === "object" && error !== null
      ? Number(
          (error as { errno?: unknown; code?: unknown }).errno ??
            (error as { code?: unknown }).code,
        )
      : NaN;
  if (code === -2) return true;
  return /\bERR_FAILED\b|\(-2\)/.test(formatRuntimeError(error));
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isSafeBrowserPanelUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function safeBrowserId(value: string): string {
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : "";
}

function safeAnnotationId(value: unknown): string {
  const annotationId = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9._:-]{1,256}$/.test(annotationId) ? annotationId : "";
}

function generatedAnnotationId(): string {
  return `annotation-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function safeBrowserWebContentsId(value: unknown): number {
  const id = Math.floor(Number(value));
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid browser webContents id.");
  return id;
}

function safeBrowserViewBounds(value?: BrowserViewBoundsInput): Rectangle {
  return {
    x: value?.x === undefined ? 0 : clampInteger(value.x, -20_000, 20_000),
    y: value?.y === undefined ? 0 : clampInteger(value.y, -20_000, 20_000),
    width: value?.width === undefined ? 0 : clampInteger(value.width, 0, 20_000),
    height: value?.height === undefined ? 0 : clampInteger(value.height, 0, 20_000),
  };
}

function safeBrowserAutomationUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  return isSafeBrowserPanelUrl(url) ? url : null;
}

function safeInteractiveAppUrl(value: string): string {
  const url = value.trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return parsed.toString();
    if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
      return parsed.toString();
    }
    return "";
  } catch {
    return "";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1") return true;
  return net.isIP(normalized) === 4 && normalized.startsWith("127.");
}

function isAllowedInteractiveAppNavigation(record: InteractiveAppView, value: string): boolean {
  if (value === record.initialUrl) return true;
  if (!record.allowedOrigin) return false;
  try {
    return new URL(value).origin === record.allowedOrigin;
  } catch {
    return false;
  }
}

function isInteractiveAppBridgeUrl(record: InteractiveAppView, value: string): boolean {
  return record.bridgeEnabled && isAllowedInteractiveAppNavigation(record, value);
}

function safeInteractiveAppUserAgent(value: unknown): string {
  if (typeof value !== "string") return "";
  const userAgent = value.trim();
  if (!userAgent || userAgent.length > 500 || /[\r\n]/.test(userAgent)) return "";
  return userAgent;
}

function safeInteractiveAppUserStyle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length <= 10_000 ? value : "";
}

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

async function refreshBrowserTargetFavicon(
  record: BrowserTarget,
  target: WebContents,
): Promise<void> {
  if (target.isDestroyed()) return;
  const pageUrl = target.getURL() || record.url;
  if (pageUrl === "about:blank") return;
  const linkFavicons = await target
    .executeJavaScript(
      `
    (() => Array.from(document.querySelectorAll('link[rel]'))
      .filter((link) => /icon/i.test(link.rel || link.getAttribute('rel') || ''))
      .map((link) => link.href || link.getAttribute('href') || '')
      .filter(Boolean))()
  `,
      true,
    )
    .catch(() => undefined);
  if (target.isDestroyed() || !sameBrowserUrl(target.getURL() || record.url, pageUrl)) return;
  const favicons = Array.isArray(linkFavicons)
    ? linkFavicons.filter((item): item is string => typeof item === "string")
    : [];
  const next = safeBrowserFaviconUrl(favicons, pageUrl) ?? fallbackBrowserFaviconUrl(pageUrl);
  if (!next || record.faviconUrl === next) return;
  record.faviconUrl = next;
  emitBrowserTargetUpdate(record.id);
}

function fallbackBrowserFaviconUrl(pageUrl: string): string | undefined {
  if (pageUrl === "about:blank") return undefined;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return new URL("/favicon.ico", parsed).toString();
  } catch {
    return undefined;
  }
}

function safeBrowserFaviconUrl(
  favicons: string[] | undefined,
  baseUrl?: string,
): string | undefined {
  for (const favicon of favicons ?? []) {
    const url = safeBrowserFaviconCandidate(favicon, baseUrl);
    if (url) return url;
  }
  return undefined;
}

function safeBrowserFaviconCandidate(value: string, baseUrl?: string): string | undefined {
  const url = value.trim();
  if (!url || url.length > 50_000 || /[\r\n\t\0]/.test(url)) return undefined;
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);/i.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url, baseUrl);
    if (parsed.protocol === "http:" && baseUrl) {
      const base = new URL(baseUrl);
      if (base.protocol === "https:" && parsed.hostname === base.hostname) {
        parsed.protocol = "https:";
      }
    }
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBrowserAnnotations(value: unknown): BrowserAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 500)
    .map(recordValue)
    .map((item) => ({
      id: stringField(item, "id").slice(0, 160),
      type: stringField(item, "type") === "region" ? "region" : "element",
      note: stringField(item, "note").slice(0, 20_000),
      url: stringField(item, "url").slice(0, 16_384),
      title: stringField(item, "title").slice(0, 8_192),
      selector: optionalStringField(item, "selector", 32_768),
      tagName: optionalStringField(item, "tagName", 128),
      text: optionalStringField(item, "text", 4_000),
      rect: normalizeBrowserRect(recordValue(item.rect)),
      viewport: normalizeBrowserViewport(recordValue(item.viewport)),
      styles: normalizeBrowserStyleRecord(recordValue(item.styles)),
      createdAt: finiteNumberField(item, "createdAt") || Date.now(),
    }));
}

function normalizeBrowserElementInspection(value: unknown): BrowserElementInspection | null {
  const item = recordValue(value);
  if (Object.keys(item).length === 0) return null;
  return {
    url: stringField(item, "url").slice(0, 16_384),
    title: stringField(item, "title").slice(0, 8_192),
    selector: optionalStringField(item, "selector", 32_768),
    tagName: optionalStringField(item, "tagName", 128),
    id: optionalStringField(item, "id", 512),
    className: optionalStringField(item, "className", 4_000),
    text: optionalStringField(item, "text", 8_000),
    attributes: normalizeBrowserStyleRecord(recordValue(item.attributes), 200, 4_000),
    rect: normalizeBrowserRect(recordValue(item.rect)),
    viewport: normalizeBrowserViewport(recordValue(item.viewport)),
    styles: normalizeBrowserStyleRecord(recordValue(item.styles)),
  };
}

function normalizeBrowserRect(value: Record<string, unknown>): BrowserRect {
  return {
    x: Math.round(finiteNumberField(value, "x")),
    y: Math.round(finiteNumberField(value, "y")),
    width: Math.max(0, Math.round(finiteNumberField(value, "width"))),
    height: Math.max(0, Math.round(finiteNumberField(value, "height"))),
  };
}

function normalizeBrowserViewport(value: Record<string, unknown>): BrowserViewport {
  return {
    width: Math.max(0, Math.round(finiteNumberField(value, "width"))),
    height: Math.max(0, Math.round(finiteNumberField(value, "height"))),
    scrollX: Math.round(finiteNumberField(value, "scrollX")),
    scrollY: Math.round(finiteNumberField(value, "scrollY")),
  };
}

function normalizeBrowserStyleRecord(
  value: Record<string, unknown>,
  maxEntries = 80,
  maxValueLength = 1_000,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, maxEntries)) {
    if (typeof rawValue !== "string") continue;
    const normalizedKey = key.replace(/[\r\n\t\0]+/g, "").slice(0, 160);
    if (!normalizedKey) continue;
    result[normalizedKey] = rawValue.replace(/[\r\n\t\0]+/g, " ").slice(0, maxValueLength);
  }
  return result;
}

function browserAnnotationViewportRect(input: {
  rect?: Partial<BrowserRect>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): BrowserRect | undefined {
  const rect = recordValue(input?.rect);
  const x = finiteInputNumber(rect.x ?? input?.x);
  const y = finiteInputNumber(rect.y ?? input?.y);
  const width = finiteInputNumber(rect.width ?? input?.width);
  const height = finiteInputNumber(rect.height ?? input?.height);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    x,
    y,
    width: Math.max(1, Number.isFinite(width) ? width : 1),
    height: Math.max(1, Number.isFinite(height) ? height : 1),
  };
}

function ensureBrowserCdpCapture(
  record: BrowserTarget,
  target: WebContents,
  maxEvents: number,
): BrowserCdpCapture {
  const existing = record.cdpCapture;
  if (existing) return existing;
  let attached = false;
  if (!target.debugger.isAttached()) {
    target.debugger.attach("1.3");
    attached = true;
  }
  const capture: BrowserCdpCapture = {
    attached,
    domains: new Set(),
    events: [],
    maxEvents,
    methods: new Set(),
    onMessage: (_event, method, params) => {
      const current = browserTargets.get(record.id);
      const currentCapture = current?.cdpCapture;
      if (!currentCapture) return;
      if (currentCapture.methods.size && !currentCapture.methods.has(method)) return;
      currentCapture.events.push({
        method,
        params: sanitizeCdpEventParams(params),
        timestamp: Date.now(),
      });
      if (currentCapture.events.length > currentCapture.maxEvents) {
        currentCapture.events = currentCapture.events.slice(-currentCapture.maxEvents);
      }
    },
  };
  target.debugger.on("message", capture.onMessage);
  record.cdpCapture = capture;
  browserTargets.set(record.id, record);
  return capture;
}

function disposeBrowserCdpCapture(record: BrowserTarget): void {
  const capture = record.cdpCapture;
  if (!capture) return;
  record.cdpCapture = undefined;
  try {
    const target = electronWebContents.fromId(record.webContentsId);
    if (!target || target.isDestroyed()) return;
    target.debugger.removeListener("message", capture.onMessage);
    if (capture.attached && target.debugger.isAttached()) target.debugger.detach();
  } catch {
    // The target may already be destroyed while its tab is closing.
  }
}

async function enableBrowserCdpDomains(target: WebContents, domains: Set<string>): Promise<void> {
  await withBrowserCdp(target, async (send) => {
    if (domains.has("CSS")) {
      await send("DOM.enable").catch(() => undefined);
    }
    for (const domain of domains) {
      const method = cdpEnableMethod(domain);
      if (!method) continue;
      await send(method).catch(() => undefined);
    }
  });
}

function cdpEnableMethod(domain: string): string | undefined {
  switch (domain) {
    case "CSS":
      return "CSS.enable";
    case "DOM":
      return "DOM.enable";
    case "Log":
      return "Log.enable";
    case "Network":
      return "Network.enable";
    case "Page":
      return "Page.enable";
    case "Performance":
      return "Performance.enable";
    case "Runtime":
      return "Runtime.enable";
    default:
      return undefined;
  }
}

function safeCdpMethod(value: unknown): string {
  const method = typeof value === "string" ? value.trim() : "";
  if (method.length > 160) return "";
  return /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(method) ? method : "";
}

function safeCdpMethodPrefix(value: unknown): string {
  const prefix = typeof value === "string" ? value.trim() : "";
  if (!prefix) return "";
  if (prefix.length > 160 || /[^A-Za-z0-9.]/.test(prefix)) return "";
  return prefix;
}

function safeCdpParams(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const params = recordValue(value);
  if (Object.keys(params).length === 0) return undefined;
  const serialized = JSON.stringify(params);
  if (serialized.length > 2_000_000) throw new Error("CDP params are too large.");
  return params;
}

function safeCdpDomains(value: unknown): Set<string> {
  const allowed = new Set([
    "CSS",
    "DOM",
    "Log",
    "Network",
    "Page",
    "Performance",
    "Runtime",
    "Tracing",
  ]);
  const values = Array.isArray(value) ? value : ["Runtime", "Log", "Network", "Page"];
  return new Set(
    values
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => allowed.has(item))
      .slice(0, 16),
  );
}

function safeCdpMethods(value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : [];
  return new Set(values.map(safeCdpMethod).filter(Boolean).slice(0, 128));
}

function sanitizeCdpEventParams(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 500_000) return value;
    return {
      truncated: true,
      preview: serialized.slice(0, 500_000),
    };
  } catch {
    return String(value);
  }
}

function safeMouseEventType(value: unknown): string {
  const type = typeof value === "string" ? value.trim() : "";
  if (["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(type)) return type;
  throw new Error("Invalid browser mouse event type.");
}

function safeMouseButton(value: unknown): string {
  const button = typeof value === "string" ? value.trim() : "";
  if (["none", "left", "middle", "right", "back", "forward"].includes(button)) return button;
  return "none";
}

function safeKeyEventType(value: unknown): string {
  const type = typeof value === "string" ? value.trim() : "";
  if (["keyDown", "keyUp", "rawKeyDown", "char"].includes(type)) return type;
  throw new Error("Invalid browser key event type.");
}

function finiteCoordinate(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Browser input requires finite ${label} coordinate.`);
  }
  return number;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function copyOptionalString(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
  maxLength: number,
): void {
  if (typeof value !== "string") return;
  output[key] = value.slice(0, maxLength);
}

function optionalStringInput(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function finiteInputNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const normalized = stringField(value, key).trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function stringField(value: unknown, key: string): string {
  const field = recordValue(value)[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: unknown, key: string): number {
  const field = recordValue(value)[key];
  return typeof field === "number" ? field : Number.NaN;
}

function finiteNumberField(value: unknown, key: string): number {
  const number = numberField(value, key);
  return Number.isFinite(number) ? number : 0;
}

function clampInteger(value: unknown, min: number, max: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeSendWebContents(contents: WebContents, channel: string, payload: unknown): boolean {
  const frame = liveMainFrame(contents);
  if (!frame) return false;
  try {
    frame.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function liveMainFrame(contents: WebContents): WebFrameMain | null {
  if (contents.isDestroyed() || contents.isCrashed()) return null;
  try {
    const frame = contents.mainFrame;
    return frame.isDestroyed() || frame.detached ? null : frame;
  } catch {
    return null;
  }
}

function hardenViewSession(contents: WebContents): void {
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
