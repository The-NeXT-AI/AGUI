import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeClient, RuntimeMethodHandler } from "@the-next-ai/agui-runtime";
import WebSocket, { type RawData } from "ws";

type BrowserTarget = {
  annotationMode: boolean;
  annotations: BrowserAnnotation[];
  cdpCapture?: BrowserCdpCapture;
  browserContextId?: string;
  client: ChromeCdpSession;
  closed: boolean;
  faviconUrl?: string;
  history: string[];
  historyIndex: number;
  id: string;
  screencast?: BrowserScreencast;
  targetId: string;
  title: string;
  updatedAt: number;
  url: string;
  viewport: { width: number; height: number };
  webContentsId: number;
  workflowRecordingMode: boolean;
  workflowRecordingRetryTimer?: ReturnType<typeof setTimeout>;
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

type BrowserCdpCapture = {
  domains: Set<string>;
  events: BrowserCdpEventRecord[];
  eventNames: Set<string>;
  listeners: Map<string, (params: unknown) => void>;
  maxEvents: number;
  methods: Set<string>;
};

type BrowserCdpEventRecord = {
  method: string;
  params?: unknown;
  timestamp: number;
};

type BrowserScreencast = {
  format: "jpeg" | "png";
  listener: (params: unknown) => void;
  maxHeight: number;
  maxWidth: number;
  quality?: number;
  running: boolean;
};

type ChromeBrowserServiceOptions = {
  emit?: (channel: string, payload: unknown) => void;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, "error" | "info" | "warn">;
};

type ChromeBrowserService = {
  browserAutomation: true;
  browserScreencast: true;
  dispose: () => Promise<void>;
  handler: RuntimeMethodHandler;
};

type ChromeCdpSession = {
  detach?: () => Promise<void>;
  off?: (event: string, listener: (params: unknown) => void) => void;
  on: (event: string, listener: (params: unknown) => void) => void;
  removeListener?: (event: string, listener: (params: unknown) => void) => void;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

type ChromeBrowserInstance = {
  close: () => Promise<void>;
  closeTarget: (targetId: string) => Promise<void>;
  connection: ChromeCdpConnection;
  createTarget: (
    url: string,
    browserContextId?: string,
  ) => Promise<{ browserContextId?: string; client: ChromeCdpSession; targetId: string }>;
  endpoint: string;
  ownsProcess: boolean;
};

type ChromeUserDataDir = {
  path: string;
  temporary: boolean;
};

type ChromeCdpPendingRequest = {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type BrowserEvent =
  | { id: string; type: "updated"; target: BrowserTargetRecord }
  | { id: string; type: "failed"; target?: BrowserTargetRecord; error: string; url?: string }
  | { id: string; type: "destroyed" }
  | {
      id: string;
      type: "screencastFrame";
      data: string;
      metadata: Record<string, unknown>;
      mimeType: "image/jpeg" | "image/png";
      sessionId: number;
      timestamp: number;
    }
  | {
      id: string;
      type: "annotationsUpdated";
      annotationCount: number;
      annotations: BrowserAnnotation[];
    }
  | { id: string; type: "annotationTool"; action: "snapshot" | "undo" | "clear" }
  | { id: string; type: "workflowEvent"; event: BrowserWorkflowPageEvent };

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_SCREENCAST_MAX_WIDTH = 1280;
const DEFAULT_SCREENCAST_MAX_HEIGHT = 900;
const DEFAULT_SCREENCAST_QUALITY = 70;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_CHROME_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_CHROME_USER_DATA_DIR_PREFIX = "agui-chrome-";

export function chromeBrowserBackendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (
    env.AG_UI_BROWSER_BACKEND ??
    env.AGUI_BROWSER_BACKEND ??
    env.AG_UI_BROWSER ??
    env.AGUI_BROWSER ??
    ""
  )
    .trim()
    .toLowerCase();
  if (!value) return true;
  if (["0", "false", "no", "off", "none", "disabled"].includes(value)) return false;
  return ["1", "true", "yes", "on", "cdp", "remote", "chrome", "chromium"].includes(value);
}

export function createChromeBrowserService(
  options: ChromeBrowserServiceOptions = {},
): ChromeBrowserService {
  const service = new ChromeBrowserServiceImpl(options);
  return {
    browserAutomation: true,
    browserScreencast: true,
    dispose: () => service.dispose(),
    handler: (method, params, client) => service.invoke(method, params, client),
  };
}

class ChromeBrowserServiceImpl {
  private browser?: ChromeBrowserInstance;
  private browserPromise?: Promise<ChromeBrowserInstance>;
  private readonly emit: (channel: string, payload: unknown) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Pick<Console, "error" | "info" | "warn">;
  private nextWebContentsId = 1;
  private readonly targets = new Map<string, BrowserTarget>();

  constructor(options: ChromeBrowserServiceOptions) {
    this.emit = options.emit ?? (() => undefined);
    this.env = options.env ?? process.env;
    this.log = options.log ?? console;
  }

  async invoke(method: string, params: unknown, _client: RuntimeClient): Promise<unknown> {
    switch (method) {
      case "browser.create":
        return this.createTarget(
          params as {
            id?: string;
            url?: string;
            title?: string;
            bounds?: BrowserViewBoundsInput;
          },
        );
      case "browser.register":
        return this.registerTarget(
          params as {
            id?: string;
            url?: string;
            title?: string;
            bounds?: BrowserViewBoundsInput;
          },
        );
      case "browser.unregister":
        return this.unregisterTarget(String(params ?? ""));
      case "browser.setBounds":
        return this.setBounds(params as { id?: string; bounds?: BrowserViewBoundsInput });
      case "browser.releaseFocus":
        return true;
      case "browser.list":
        return this.listTargets();
      case "browser.navigate":
        return this.navigate(
          params as {
            id?: string;
            url?: string;
            waitUntil?: string;
            timeoutMs?: number;
          },
        );
      case "browser.reload":
        return this.reload(
          params as
            | {
                id?: string;
                waitUntil?: string;
                timeoutMs?: number;
              }
            | undefined,
        );
      case "browser.stop":
        return this.stopLoading(params as { id?: string } | undefined);
      case "browser.goBack":
        return this.navigateHistory(params as { id?: string } | undefined, "back");
      case "browser.goForward":
        return this.navigateHistory(params as { id?: string } | undefined, "forward");
      case "browser.evaluate":
        return this.evaluate(
          params as {
            id?: string;
            expression?: string;
            awaitPromise?: boolean;
          },
        );
      case "browser.click":
        return this.click(
          params as {
            id?: string;
            selector?: string;
            x?: number;
            y?: number;
          },
        );
      case "browser.type":
        return this.typeText(
          params as {
            id?: string;
            selector?: string;
            text?: string;
          },
        );
      case "browser.snapshot":
        return this.snapshot(params as { id?: string } | undefined);
      case "browser.screenshot":
        return this.screenshot(
          params as
            | {
                id?: string;
                format?: string;
                quality?: number;
              }
            | undefined,
        );
      case "browser.setAnnotationMode":
        return this.setAnnotationMode(params as { id?: string; enabled?: boolean } | undefined);
      case "browser.setWorkflowRecordingMode":
        return this.setWorkflowRecordingMode(
          params as { id?: string; enabled?: boolean } | undefined,
        );
      case "browser.listAnnotations":
        return this.listAnnotations(params as { id?: string } | undefined);
      case "browser.clearAnnotations":
        return this.clearAnnotations(params as { id?: string } | undefined);
      case "browser.addAnnotation":
        return this.addAnnotation(
          params as {
            id?: string;
            annotationId?: string;
            note?: string;
            selector?: string;
            type?: string;
            rect?: Partial<BrowserRect>;
            x?: number;
            y?: number;
            width?: number;
            height?: number;
          },
        );
      case "browser.deleteAnnotation":
        return this.deleteAnnotation(params as { id?: string; annotationId?: string });
      case "browser.inspectElement":
        return this.inspectElement(
          params as {
            id?: string;
            selector?: string;
            x?: number;
            y?: number;
          },
        );
      case "browser.cdpCommand":
        return this.cdpCommand(
          params as {
            id?: string;
            method?: string;
            params?: Record<string, unknown>;
          },
        );
      case "browser.cdpStartCapture":
        return this.startCdpCapture(
          params as
            | {
                id?: string;
                domains?: string[];
                methods?: string[];
                maxEvents?: number;
                clear?: boolean;
              }
            | undefined,
        );
      case "browser.cdpEvents":
        return this.readCdpEvents(
          params as
            | {
                id?: string;
                methods?: string[];
                methodPrefix?: string;
                limit?: number;
                clear?: boolean;
              }
            | undefined,
        );
      case "browser.cdpStopCapture":
        return this.stopCdpCapture(params as { id?: string } | undefined);
      case "browser.screencastStart":
        return this.startScreencast(
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
        return this.ackScreencastFrame(params as { id?: string; sessionId?: number });
      case "browser.screencastStop":
        return this.stopScreencast(params as { id?: string } | undefined);
      case "browser.dispatchMouse":
        return this.dispatchMouse(
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
        return this.dispatchKey(
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
        return this.insertText(params as { id?: string; text?: string });
      default:
        throw new Error(`Unknown Chrome browser runtime method: ${method}`);
    }
  }

  async dispose(): Promise<void> {
    for (const id of [...this.targets.keys()]) {
      await this.unregisterTarget(id);
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
    }
  }

  private async createTarget(input: {
    id?: string;
    url?: string;
    title?: string;
    bounds?: BrowserViewBoundsInput;
  }): Promise<BrowserTargetRecord> {
    const id = safeBrowserId(String(input?.id || ""));
    if (!id) throw new Error("Missing browser target id.");
    const existing = this.targets.get(id);
    if (existing) {
      if (input?.bounds) await this.setBounds({ id, bounds: input.bounds });
      return this.targetRecord(existing);
    }
    const viewport = browserViewportSize(input?.bounds) ?? DEFAULT_VIEWPORT;
    const browser = await this.ensureBrowser();
    const { browserContextId, client, targetId } = await browser.createTarget("about:blank");
    const record: BrowserTarget = {
      annotationMode: false,
      annotations: [],
      browserContextId,
      client,
      closed: false,
      history: ["about:blank"],
      historyIndex: 0,
      id,
      targetId,
      title: String(input?.title || "Browser"),
      updatedAt: Date.now(),
      url: "about:blank",
      viewport,
      webContentsId: this.nextWebContentsId++,
      workflowRecordingMode: false,
    };
    this.targets.set(id, record);
    this.attachPageEvents(record);
    await this.initializeTarget(record);
    const initialUrl = safeBrowserAutomationUrl(String(input?.url || ""));
    if (initialUrl && initialUrl !== "about:blank") {
      await this.navigate({ id, url: initialUrl, waitUntil: "none" }).catch((error) => {
        this.emitTargetLoadFailure(record, error, initialUrl);
      });
    } else {
      this.emitTargetUpdate(id);
    }
    return this.targetRecord(record);
  }

  private async registerTarget(input: {
    id?: string;
    url?: string;
    title?: string;
    bounds?: BrowserViewBoundsInput;
  }): Promise<BrowserTargetRecord> {
    return this.createTarget(input);
  }

  private async unregisterTarget(id: string): Promise<boolean> {
    const browserId = safeBrowserId(String(id || ""));
    const record = this.targets.get(browserId);
    if (!record) return false;
    this.targets.delete(browserId);
    record.closed = true;
    this.clearBrowserWorkflowRecorderRetry(record);
    await this.disposeScreencast(record);
    this.disposeCdpCapture(record);
    await record.client.detach?.().catch(() => undefined);
    await this.browser?.closeTarget(record.targetId).catch(() => undefined);
    this.emitBrowserEvent({ id: browserId, type: "destroyed" });
    return true;
  }

  private async setBounds(input: {
    id?: string;
    bounds?: BrowserViewBoundsInput;
  }): Promise<BrowserTargetRecord> {
    const record = this.targetFor(input?.id);
    const viewport = browserViewportSize(input?.bounds);
    if (viewport) await this.applyViewport(record, viewport);
    record.updatedAt = Date.now();
    return this.targetRecord(record);
  }

  private listTargets(): BrowserTargetRecord[] {
    for (const [id, record] of this.targets) {
      if (record.closed) this.targets.delete(id);
    }
    return [...this.targets.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((record) => this.targetRecord(record));
  }

  private async navigate(input: {
    id?: string;
    url?: string;
    waitUntil?: string;
    timeoutMs?: number;
  }): Promise<BrowserAutomationResult> {
    const url = safeBrowserAutomationUrl(String(input?.url || ""));
    if (!url) throw new Error("Unsupported browser URL.");
    const record = this.targetFor(input?.id);
    record.url = url;
    record.updatedAt = Date.now();
    this.emitTargetUpdate(record.id);
    try {
      await record.client.send("Page.navigate", { url });
      await this.waitForNavigation(record, input?.waitUntil, browserTimeout(input?.timeoutMs));
      await this.refreshTargetMetadata(record);
    } catch (error) {
      this.emitTargetLoadFailure(record, error, url);
    }
    return this.automationResult(record);
  }

  private async reload(input?: {
    id?: string;
    waitUntil?: string;
    timeoutMs?: number;
  }): Promise<BrowserAutomationResult> {
    const record = this.targetFor(input?.id);
    try {
      await record.client.send("Page.reload", { ignoreCache: false });
      await this.waitForNavigation(record, input?.waitUntil, browserTimeout(input?.timeoutMs));
      await this.refreshTargetMetadata(record);
    } catch (error) {
      this.emitTargetLoadFailure(record, error, record.url);
    }
    return this.automationResult(record);
  }

  private async stopLoading(input?: { id?: string }): Promise<BrowserAutomationResult> {
    const record = this.targetFor(input?.id);
    const session = await this.cdpSession(record);
    await session.send("Page.stopLoading").catch(() => undefined);
    await this.refreshTargetMetadata(record);
    return this.automationResult(record);
  }

  private async navigateHistory(
    input: { id?: string } | undefined,
    direction: "back" | "forward",
  ): Promise<BrowserAutomationResult> {
    const record = this.targetFor(input?.id);
    try {
      const history = recordValue(await record.client.send("Page.getNavigationHistory"));
      const entries = Array.isArray(history.entries) ? history.entries : [];
      const currentIndex = Math.floor(numberField(history, "currentIndex"));
      const nextIndex = direction === "back" ? currentIndex - 1 : currentIndex + 1;
      const entry = recordValue(entries[nextIndex]);
      const entryId = Math.floor(numberField(entry, "id"));
      if (!Number.isFinite(entryId)) return this.automationResult(record);
      await record.client.send("Page.navigateToHistoryEntry", { entryId });
      await this.waitForNavigation(record, "load", 10_000);
      await this.refreshTargetMetadata(record);
    } catch (error) {
      this.emitTargetLoadFailure(record, error, record.url);
    }
    return this.automationResult(record);
  }

  private async evaluate(input: {
    id?: string;
    expression?: string;
    awaitPromise?: boolean;
  }): Promise<{ type: string; value?: unknown; description?: string }> {
    const expression = String(input?.expression || "");
    if (!expression.trim()) throw new Error("Missing browser evaluation expression.");
    if (expression.length > 200_000) throw new Error("Browser evaluation expression is too long.");
    return this.evaluateInBrowser(
      this.targetFor(input?.id),
      expression,
      input?.awaitPromise !== false,
    );
  }

  private async click(input: {
    id?: string;
    selector?: string;
    x?: number;
    y?: number;
  }): Promise<BrowserAutomationResult> {
    const record = this.targetFor(input?.id);
    const point = await this.browserClickPoint(record, input);
    await this.dispatchBrowserClick(record, point.x, point.y);
    await this.refreshTargetMetadata(record);
    return this.automationResult(record);
  }

  private async typeText(input: {
    id?: string;
    selector?: string;
    text?: string;
  }): Promise<BrowserAutomationResult> {
    const text = String(input?.text ?? "");
    const record = this.targetFor(input?.id);
    if (!text) return this.automationResult(record);
    if (text.length > 20_000) throw new Error("Browser input text is too long.");
    if (typeof input?.selector === "string" && input.selector.trim()) {
      const point = await this.browserClickPoint(record, input);
      await this.dispatchBrowserClick(record, point.x, point.y);
    }
    const session = await this.cdpSession(record);
    await session.send("Input.insertText", { text });
    await this.refreshTargetMetadata(record);
    return this.automationResult(record);
  }

  private async snapshot(input?: { id?: string }): Promise<{
    id: string;
    url: string;
    title: string;
    text: string;
    html: string;
  }> {
    const record = this.targetFor(input?.id);
    const result = await this.evaluateInBrowser(
      record,
      "(() => ({ url: location.href, title: document.title, text: document.body?.innerText ?? '', html: document.documentElement?.outerHTML ?? '' }))()",
      true,
    );
    const value = recordValue(result.value);
    return {
      id: record.id,
      url: stringField(value, "url") || record.url,
      title: stringField(value, "title") || record.title,
      text: stringField(value, "text"),
      html: stringField(value, "html"),
    };
  }

  private async screenshot(input?: {
    id?: string;
    format?: string;
    quality?: number;
  }): Promise<{ id: string; mimeType: "image/png" | "image/jpeg"; data: string }> {
    const record = this.targetFor(input?.id);
    const format = input?.format === "jpeg" ? "jpeg" : "png";
    const options: Record<string, unknown> = { format };
    if (format === "jpeg" && input?.quality !== undefined) {
      options.quality = clampInteger(input.quality, 1, 100);
    }
    const result = recordValue(await record.client.send("Page.captureScreenshot", options));
    return {
      id: record.id,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      data: stringField(result, "data"),
    };
  }

  private async setAnnotationMode(input?: { id?: string; enabled?: boolean }): Promise<{
    id: string;
    enabled: boolean;
    annotationCount: number;
  }> {
    const enabled = input?.enabled === true;
    const record = this.targetFor(input?.id);
    record.annotationMode = enabled;
    const result = await this.evaluateBrowserAnnotationStep(
      record,
      `window.__aguiBrowserAnnotations.setEnabled(${enabled ? "true" : "false"})`,
      "Annotation mode toggle failed",
    );
    const value = recordValue(result.value);
    record.annotationMode = value.enabled === true;
    return {
      id: record.id,
      enabled: record.annotationMode,
      annotationCount: numberField(value, "annotationCount") || record.annotations.length,
    };
  }

  private async setWorkflowRecordingMode(input?: {
    id?: string;
    enabled?: boolean;
  }): Promise<{ id: string; enabled: boolean }> {
    const record = this.targetFor(input?.id);
    const enabled = input?.enabled === true;
    record.workflowRecordingMode = enabled;
    this.clearBrowserWorkflowRecorderRetry(record);
    const result = await this.installWorkflowRecorder(record, enabled).catch((error) => {
      if (enabled && browserWorkflowRecorderTransientError(error)) {
        this.scheduleBrowserWorkflowRecorderRetry(record);
        return { value: { enabled: true } };
      }
      if (enabled) {
        record.workflowRecordingMode = false;
        throw error;
      }
      return { value: { enabled: false } };
    });
    const value = recordValue(result.value);
    return {
      id: record.id,
      enabled: value.enabled === true,
    };
  }

  private async listAnnotations(input?: { id?: string }): Promise<{
    id: string;
    annotations: BrowserAnnotation[];
  }> {
    const record = this.targetFor(input?.id);
    const annotations = await this.readPageAnnotations(record, "Annotation list read failed");
    return { id: record.id, annotations };
  }

  private async clearAnnotations(input?: { id?: string }): Promise<{
    id: string;
    annotationCount: number;
  }> {
    const record = this.targetFor(input?.id);
    const result = await this.evaluateBrowserAnnotationStep(
      record,
      "window.__aguiBrowserAnnotations.clear()",
      "Annotation clear failed",
    );
    const value = recordValue(result.value);
    record.annotations = [];
    void this.emitPageAnnotationsUpdated(record).catch(() => undefined);
    return { id: record.id, annotationCount: numberField(value, "annotationCount") || 0 };
  }

  private async addAnnotation(input: {
    id?: string;
    annotationId?: string;
    note?: string;
    selector?: string;
    type?: string;
    rect?: Partial<BrowserRect>;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): Promise<{ id: string; annotation: BrowserAnnotation; annotationCount: number }> {
    const record = this.targetFor(input?.id);
    const note = String(input?.note ?? "").trim();
    if (!note) throw new Error("Browser annotation requires a note.");
    const result = await this.evaluateBrowserAnnotationStep(
      record,
      `window.__aguiBrowserAnnotations.add(${JSON.stringify({
        annotationId: safeAnnotationId(input?.annotationId) || generatedAnnotationId(),
        height: finiteInputNumber(input?.height),
        note,
        rect: browserAnnotationViewportRect(input),
        selector: optionalStringInput(input?.selector, 32_768),
        type:
          input?.type === "element" ? "element" : input?.type === "region" ? "region" : undefined,
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
    record.annotations = [
      ...record.annotations.filter((item) => item.id !== annotation.id),
      annotation,
    ]
      .slice(-500)
      .map((item) => item);
    void this.emitPageAnnotationsUpdated(record).catch(() => undefined);
    return { id: record.id, annotation, annotationCount };
  }

  private async deleteAnnotation(input: { id?: string; annotationId?: string }): Promise<{
    id: string;
    deleted: boolean;
    annotationCount: number;
  }> {
    const record = this.targetFor(input?.id);
    const annotationId = safeAnnotationId(input?.annotationId);
    if (!annotationId) throw new Error("Missing browser annotation id.");
    const result = await this.evaluateBrowserAnnotationStep(
      record,
      `window.__aguiBrowserAnnotations.remove(${JSON.stringify(annotationId)})`,
      "Annotation delete failed",
    );
    const value = recordValue(result.value);
    const deleted = value.deleted === true;
    if (deleted) {
      record.annotations = record.annotations.filter(
        (annotation) => annotation.id !== annotationId,
      );
      void this.emitPageAnnotationsUpdated(record).catch(() => undefined);
    }
    return {
      id: record.id,
      deleted,
      annotationCount: numberField(value, "annotationCount") || record.annotations.length,
    };
  }

  private async inspectElement(input: {
    id?: string;
    selector?: string;
    x?: number;
    y?: number;
  }): Promise<{ id: string; element: BrowserElementInspection | null }> {
    const record = this.targetFor(input?.id);
    const result = await this.evaluateInBrowser(
      record,
      browserElementInspectionExpression(input),
      true,
    );
    return {
      id: record.id,
      element: normalizeBrowserElementInspection(result.value),
    };
  }

  private async cdpCommand(input: {
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
  }): Promise<{ id: string; method: string; result: unknown }> {
    const method = safeCdpMethod(input?.method);
    if (!method) throw new Error("browser.cdpCommand requires a valid CDP method.");
    const record = this.targetFor(input?.id);
    const session = await this.cdpSession(record);
    const result = await session.send(method, safeCdpParams(input?.params));
    return { id: record.id, method, result };
  }

  private async startCdpCapture(input?: {
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
    const record = this.targetFor(input?.id);
    const previousEvents = input?.clear === false ? (record.cdpCapture?.events ?? []) : [];
    this.disposeCdpCapture(record);
    const domains = safeCdpDomains(input?.domains);
    const methods = safeCdpMethods(input?.methods);
    const maxEvents = clampInteger(input?.maxEvents ?? 2_000, 1, 10_000);
    const session = await this.cdpSession(record);
    await enableBrowserCdpDomains(session, domains);
    const eventNames = browserCdpEventNames(domains, methods);
    const capture: BrowserCdpCapture = {
      domains,
      events: previousEvents.slice(-maxEvents),
      eventNames,
      listeners: new Map(),
      maxEvents,
      methods,
    };
    for (const eventName of eventNames) {
      const listener = (params: unknown) => {
        const current = this.targets.get(record.id);
        const currentCapture = current?.cdpCapture;
        if (!currentCapture) return;
        if (currentCapture.methods.size && !currentCapture.methods.has(eventName)) return;
        currentCapture.events.push({
          method: eventName,
          params: sanitizeCdpEventParams(params),
          timestamp: Date.now(),
        });
        if (currentCapture.events.length > currentCapture.maxEvents) {
          currentCapture.events = currentCapture.events.slice(-currentCapture.maxEvents);
        }
      };
      capture.listeners.set(eventName, listener);
      session.on(eventName, listener);
    }
    record.cdpCapture = capture;
    return {
      id: record.id,
      recording: true,
      domains: [...domains],
      eventCount: capture.events.length,
      maxEvents,
    };
  }

  private readCdpEvents(input?: {
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
    const record = this.targetFor(input?.id);
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

  private stopCdpCapture(input?: { id?: string }): { id: string; recording: boolean } {
    const record = this.targetFor(input?.id);
    this.disposeCdpCapture(record);
    return { id: record.id, recording: false };
  }

  private async startScreencast(input?: {
    id?: string;
    format?: string;
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    everyNthFrame?: number;
  }): Promise<{
    id: string;
    running: boolean;
    format: "jpeg" | "png";
    maxWidth: number;
    maxHeight: number;
    quality?: number;
  }> {
    const record = this.targetFor(input?.id);
    await this.disposeScreencast(record);
    const session = await this.cdpSession(record);
    await session.send("Page.enable").catch(() => undefined);
    const format = input?.format === "png" ? "png" : "jpeg";
    const quality =
      format === "jpeg"
        ? clampInteger(input?.quality ?? DEFAULT_SCREENCAST_QUALITY, 1, 100)
        : undefined;
    const maxWidth = clampInteger(input?.maxWidth ?? DEFAULT_SCREENCAST_MAX_WIDTH, 1, 4096);
    const maxHeight = clampInteger(input?.maxHeight ?? DEFAULT_SCREENCAST_MAX_HEIGHT, 1, 4096);
    const listener = (params: unknown) => {
      const value = recordValue(params);
      const data = stringField(value, "data");
      const sessionId = Math.floor(numberField(value, "sessionId"));
      if (!data || !Number.isInteger(sessionId)) return;
      this.emitBrowserEvent({
        id: record.id,
        type: "screencastFrame",
        data,
        metadata: sanitizeCdpMetadata(recordValue(value.metadata)),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        sessionId,
        timestamp: Date.now(),
      });
    };
    record.screencast = {
      format,
      listener,
      maxHeight,
      maxWidth,
      quality,
      running: true,
    };
    session.on("Page.screencastFrame", listener);
    await session.send("Page.startScreencast", {
      everyNthFrame: clampInteger(input?.everyNthFrame ?? 1, 1, 10),
      format,
      maxHeight,
      maxWidth,
      ...(quality === undefined ? {} : { quality }),
    });
    return { id: record.id, running: true, format, maxWidth, maxHeight, quality };
  }

  private async ackScreencastFrame(input: {
    id?: string;
    sessionId?: number;
  }): Promise<{ id: string; acknowledged: boolean }> {
    const record = this.targetFor(input?.id);
    const sessionId = Math.floor(Number(input?.sessionId));
    if (!Number.isInteger(sessionId) || sessionId < 0) {
      throw new Error("browser.screencastAck requires a valid session id.");
    }
    const session = await this.cdpSession(record);
    await session.send("Page.screencastFrameAck", { sessionId });
    return { id: record.id, acknowledged: true };
  }

  private async stopScreencast(input?: { id?: string }): Promise<{ id: string; running: boolean }> {
    const record = this.targetFor(input?.id);
    await this.disposeScreencast(record);
    return { id: record.id, running: false };
  }

  private async dispatchMouse(input: {
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
    const type = safeMouseEventType(input?.type);
    const x = finiteCoordinate(input?.x, "x");
    const y = finiteCoordinate(input?.y, "y");
    const record = this.targetFor(input?.id);
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
    const session = await this.cdpSession(record);
    await session.send("Input.dispatchMouseEvent", payload);
    await this.refreshTargetMetadata(record);
    return this.automationResult(record);
  }

  private async dispatchKey(input: {
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
    const type = safeKeyEventType(input?.type);
    const record = this.targetFor(input?.id);
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
    const session = await this.cdpSession(record);
    await session.send("Input.dispatchKeyEvent", payload);
    await this.refreshTargetMetadata(record);
    return this.automationResult(record);
  }

  private async insertText(input: {
    id?: string;
    text?: string;
  }): Promise<BrowserAutomationResult> {
    const text = String(input?.text ?? "");
    if (text.length > 200_000) throw new Error("Browser input text is too long.");
    const record = this.targetFor(input?.id);
    const session = await this.cdpSession(record);
    await session.send("Input.insertText", { text });
    await this.refreshTargetMetadata(record);
    return this.automationResult(record);
  }

  private async browserClickPoint(
    record: BrowserTarget,
    input: { selector?: string; x?: number; y?: number },
  ): Promise<{ x: number; y: number }> {
    if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
      return { x: Number(input.x), y: Number(input.y) };
    }
    const selector = String(input.selector || "").trim();
    if (!selector) throw new Error("Browser click requires either selector or coordinates.");
    const result = await this.evaluateInBrowser(
      record,
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

  private async dispatchBrowserClick(record: BrowserTarget, x: number, y: number): Promise<void> {
    const session = await this.cdpSession(record);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
  }

  private async evaluateInBrowser(
    record: BrowserTarget,
    expression: string,
    awaitPromise: boolean,
  ): Promise<{ type: string; value?: unknown; description?: string }> {
    const session = await this.cdpSession(record);
    const result = await session.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
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

  private async ensureBrowserAnnotationController(record: BrowserTarget): Promise<void> {
    try {
      await this.evaluateInBrowser(record, browserAnnotationInstallExpression(), true);
    } catch (error) {
      throw new Error(`Annotation controller injection failed: ${formatRuntimeError(error)}`);
    }
  }

  private async evaluateBrowserAnnotationStep(
    record: BrowserTarget,
    expression: string,
    step: string,
  ): Promise<{ type: string; value?: unknown; description?: string }> {
    try {
      await this.ensureBrowserAnnotationController(record);
      return await this.evaluateInBrowser(record, expression, true);
    } catch (error) {
      throw new Error(`${step}: ${formatRuntimeError(error)}`);
    }
  }

  private async readPageAnnotations(
    record: BrowserTarget,
    step: string,
  ): Promise<BrowserAnnotation[]> {
    const result = await this.evaluateBrowserAnnotationStep(
      record,
      "window.__aguiBrowserAnnotations.list()",
      step,
    );
    const annotations = normalizeBrowserAnnotations(result.value);
    record.annotations = annotations;
    return annotations;
  }

  private async emitPageAnnotationsUpdated(record: BrowserTarget): Promise<void> {
    if (record.closed) return;
    const annotations = await this.readPageAnnotations(record, "Annotation event read failed");
    this.emitBrowserEvent({
      id: record.id,
      type: "annotationsUpdated",
      annotationCount: annotations.length,
      annotations,
    });
  }

  private async installWorkflowRecorder(
    record: BrowserTarget,
    enabled: boolean,
  ): Promise<{ type: string; value?: unknown; description?: string }> {
    return this.evaluateInBrowser(record, browserWorkflowRecorderInstallExpression(enabled), true);
  }

  private scheduleBrowserWorkflowRecorderRetry(record: BrowserTarget, delayMs = 250): void {
    if (record.closed || !record.workflowRecordingMode) return;
    this.clearBrowserWorkflowRecorderRetry(record);
    record.workflowRecordingRetryTimer = setTimeout(() => {
      record.workflowRecordingRetryTimer = undefined;
      if (record.closed || !record.workflowRecordingMode) return;
      void this.installWorkflowRecorder(record, true).catch((error) => {
        if (!browserWorkflowRecorderTransientError(error)) return;
        this.scheduleBrowserWorkflowRecorderRetry(record, Math.min(delayMs * 2, 2_000));
      });
    }, delayMs);
  }

  private clearBrowserWorkflowRecorderRetry(record: BrowserTarget): void {
    if (!record.workflowRecordingRetryTimer) return;
    clearTimeout(record.workflowRecordingRetryTimer);
    record.workflowRecordingRetryTimer = undefined;
  }

  private targetFor(id?: string): BrowserTarget {
    const browserId = typeof id === "string" && id.trim() ? safeBrowserId(id) : "";
    const record = browserId
      ? this.targets.get(browserId)
      : [...this.targets.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!record || record.closed) {
      if (record) this.targets.delete(record.id);
      throw new Error("No browser tab is registered for automation.");
    }
    record.updatedAt = Date.now();
    return record;
  }

  private targetRecord(record: BrowserTarget): BrowserTargetRecord {
    const url = record.url || "about:blank";
    recordBrowserHistory(record, url);
    const next: BrowserTargetRecord = {
      id: record.id,
      webContentsId: record.webContentsId,
      url,
      title: record.title || "Browser",
      faviconUrl: record.faviconUrl ?? fallbackBrowserFaviconUrl(url),
      loading: false,
      canGoBack: record.historyIndex > 0,
      canGoForward: record.historyIndex < record.history.length - 1,
      updatedAt: Date.now(),
    };
    record.url = next.url;
    record.title = next.title;
    record.faviconUrl = next.faviconUrl;
    record.updatedAt = next.updatedAt;
    return next;
  }

  private automationResult(record: BrowserTarget): BrowserAutomationResult {
    const snapshot = this.targetRecord(record);
    return {
      id: snapshot.id,
      url: snapshot.url,
      title: snapshot.title,
      faviconUrl: snapshot.faviconUrl,
    };
  }

  private async refreshTargetMetadata(record: BrowserTarget): Promise<void> {
    if (record.closed) return;
    const metadata = await this.evaluateInBrowser(
      record,
      "(() => ({ url: location.href, title: document.title }))()",
      true,
    ).catch(() => null);
    const value = recordValue(metadata?.value);
    record.url = stringField(value, "url") || record.url;
    record.title = stringField(value, "title") || record.title || "Browser";
    record.faviconUrl =
      (await refreshBrowserTargetFavicon(record).catch(() => undefined)) ??
      fallbackBrowserFaviconUrl(record.url);
    record.updatedAt = Date.now();
    this.emitTargetUpdate(record.id);
  }

  private attachPageEvents(record: BrowserTarget): void {
    const emitUpdate = () => {
      void this.refreshTargetMetadata(record);
      if (record.workflowRecordingMode) {
        void this.installWorkflowRecorder(record, true).catch(() => undefined);
      }
    };
    record.client.on("Page.domContentEventFired", emitUpdate);
    record.client.on("Page.loadEventFired", emitUpdate);
    record.client.on("Runtime.consoleAPICalled", (params: unknown) => {
      const message = cdpConsoleMessageText(params);
      if (message.includes("[AGUI_BROWSER_ANNOTATION]")) {
        void this.emitPageAnnotationsUpdated(record).catch(() => undefined);
        return;
      }
      const action = browserAnnotationToolActionFromConsoleMessage(message);
      if (action) {
        this.emitBrowserEvent({ id: record.id, type: "annotationTool", action });
        return;
      }
      const event = browserWorkflowPageEventFromConsoleMessage(message);
      if (!event) return;
      this.emitBrowserEvent({ id: record.id, type: "workflowEvent", event });
    });
    record.client.on("Page.frameNavigated", (params: unknown) => {
      const frame = recordValue(recordValue(params).frame);
      if (stringField(frame, "parentId")) return;
      record.url = stringField(frame, "url") || record.url;
      void this.refreshTargetMetadata(record);
      if (record.workflowRecordingMode) {
        void this.installWorkflowRecorder(record, true).catch(() => undefined);
      }
    });
    record.client.on("Inspector.targetCrashed", () => {
      this.emitTargetLoadFailure(record, new Error("Browser page crashed."), record.url);
    });
    record.client.on("Target.detachedFromTarget", () => {
      const current = this.targets.get(record.id);
      if (current?.webContentsId !== record.webContentsId) return;
      record.closed = true;
      this.targets.delete(record.id);
      this.clearBrowserWorkflowRecorderRetry(record);
      this.disposeCdpCapture(record);
      this.emitBrowserEvent({ id: record.id, type: "destroyed" });
    });
  }

  private emitTargetUpdate(id: string): void {
    const record = this.targets.get(id);
    if (!record || record.closed) return;
    this.emitBrowserEvent({ id, type: "updated", target: this.targetRecord(record) });
  }

  private emitTargetLoadFailure(record: BrowserTarget, error: unknown, url?: string): void {
    this.emitBrowserEvent({
      id: record.id,
      type: "failed",
      target: record.closed ? undefined : this.targetRecord(record),
      error: formatRuntimeError(error),
      url: url || record.url,
    });
  }

  private emitBrowserEvent(event: BrowserEvent): void {
    this.emit("agui:browser:event", event);
  }

  private async initializeTarget(record: BrowserTarget): Promise<void> {
    await record.client.send("Page.enable").catch(() => undefined);
    await record.client.send("Runtime.enable").catch(() => undefined);
    await record.client.send("Log.enable").catch(() => undefined);
    await this.applyViewport(record, record.viewport);
  }

  private async applyViewport(
    record: BrowserTarget,
    viewport: { width: number; height: number },
  ): Promise<void> {
    record.viewport = viewport;
    await record.client
      .send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: 1,
        height: viewport.height,
        mobile: false,
        width: viewport.width,
      })
      .catch(() => undefined);
  }

  private async waitForNavigation(
    record: BrowserTarget,
    waitUntil: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const normalized = chromeWaitUntil(waitUntil);
    if (normalized === "none") return;
    await waitForCdpEvent(
      record.client,
      normalized === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired",
      timeoutMs,
    ).catch(() => undefined);
  }

  private async ensureBrowser(): Promise<ChromeBrowserInstance> {
    if (this.browser) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = this.launchBrowser().then((browser) => {
        this.browser = browser;
        return browser;
      });
    }
    return this.browserPromise;
  }

  private async launchBrowser(): Promise<ChromeBrowserInstance> {
    const cdpEndpoint = configuredChromeCdpEndpoint(this.env);
    if (cdpEndpoint) {
      return connectChromeBrowser(cdpEndpoint, this.env, false);
    }
    const executablePath = await resolveChromeExecutablePath(this.env);
    const userDataDir = await chromeUserDataDir(this.env);
    const port = await findFreePort();
    const args = chromeLaunchArgs(this.env, port, userDataDir);
    const child = spawn(executablePath, args, {
      env: { ...process.env, ...this.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (/DevTools listening on/i.test(text)) this.log.info(text.trim());
    });
    child.on("error", (error) => {
      this.log.error(formatRuntimeError(error));
    });
    const endpoint = await waitForChromeDebugEndpoint(port, browserLaunchTimeoutMs(this.env)).catch(
      async (error) => {
        child.kill("SIGTERM");
        if (userDataDir.temporary) await rm(userDataDir.path, { force: true, recursive: true });
        throw error;
      },
    );
    const browser = await connectChromeBrowser(endpoint, this.env, true, child, userDataDir);
    return browser;
  }

  private async cdpSession(record: BrowserTarget): Promise<ChromeCdpSession> {
    return record.client;
  }

  private disposeCdpCapture(record: BrowserTarget): void {
    const capture = record.cdpCapture;
    if (!capture) return;
    record.cdpCapture = undefined;
    for (const [eventName, listener] of capture.listeners) {
      removeCdpListener(record.client, eventName, listener);
    }
  }

  private async disposeScreencast(record: BrowserTarget): Promise<void> {
    const screencast = record.screencast;
    if (!screencast) return;
    record.screencast = undefined;
    removeCdpListener(record.client, "Page.screencastFrame", screencast.listener);
    await record.client.send("Page.stopScreencast").catch(() => undefined);
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

function cdpConsoleMessageText(params: unknown): string {
  const args = recordValue(params).args;
  if (!Array.isArray(args)) return "";
  return args
    .map(recordValue)
    .map((arg) => stringField(arg, "value") || stringField(arg, "description"))
    .filter(Boolean)
    .join(" ");
}

function browserAnnotationToolActionFromConsoleMessage(
  message: string,
): "snapshot" | "undo" | "clear" | null {
  const marker = "[AGUI_BROWSER_ANNOTATION_TOOL]";
  const index = message.indexOf(marker);
  if (index < 0) return null;
  const json = message.slice(index + marker.length).trim();
  if (!json) return null;
  try {
    const action = stringField(recordValue(JSON.parse(json)), "action");
    return action === "snapshot" || action === "undo" || action === "clear" ? action : null;
  } catch {
    return null;
  }
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
    message.includes("session closed") ||
    message.includes("target session is not attached")
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

async function refreshBrowserTargetFavicon(record: BrowserTarget): Promise<string | undefined> {
  const pageUrl = record.url;
  if (pageUrl === "about:blank") return undefined;
  const result = await record.client
    .send("Runtime.evaluate", {
      expression: `(() => Array.from(document.querySelectorAll('link[rel]'))
        .filter((link) => /icon/i.test(link.rel || link.getAttribute('rel') || ''))
        .map((link) => link.href || link.getAttribute('href') || '')
        .filter(Boolean))()`,
      awaitPromise: true,
      returnByValue: true,
    })
    .catch(() => undefined);
  const favicons = recordValue(recordValue(result).result).value;
  return (
    safeBrowserFaviconUrl(
      Array.isArray(favicons)
        ? favicons.filter((item): item is string => typeof item === "string")
        : undefined,
      pageUrl,
    ) ?? fallbackBrowserFaviconUrl(pageUrl)
  );
}

async function enableBrowserCdpDomains(
  session: ChromeCdpSession,
  domains: Set<string>,
): Promise<void> {
  if (domains.has("CSS")) await session.send("DOM.enable").catch(() => undefined);
  for (const domain of domains) {
    const method = cdpEnableMethod(domain);
    if (!method) continue;
    await session.send(method).catch(() => undefined);
  }
}

function browserCdpEventNames(domains: Set<string>, methods: Set<string>): Set<string> {
  if (methods.size) return new Set(methods);
  const names = new Set<string>();
  for (const domain of domains) {
    for (const eventName of defaultCdpEventsForDomain(domain)) names.add(eventName);
  }
  return names;
}

function defaultCdpEventsForDomain(domain: string): string[] {
  switch (domain) {
    case "Log":
      return ["Log.entryAdded"];
    case "Network":
      return [
        "Network.loadingFailed",
        "Network.loadingFinished",
        "Network.requestWillBeSent",
        "Network.requestWillBeSentExtraInfo",
        "Network.responseReceived",
        "Network.responseReceivedExtraInfo",
      ];
    case "Page":
      return [
        "Page.domContentEventFired",
        "Page.frameNavigated",
        "Page.frameStartedLoading",
        "Page.frameStoppedLoading",
        "Page.javascriptDialogOpening",
        "Page.lifecycleEvent",
        "Page.loadEventFired",
      ];
    case "Runtime":
      return ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"];
    case "Tracing":
      return ["Tracing.dataCollected", "Tracing.tracingComplete"];
    default:
      return [];
  }
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

function chromeLaunchArgs(
  env: NodeJS.ProcessEnv,
  port: number,
  userDataDir: ChromeUserDataDir,
): string[] {
  const args = [
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir.path}`,
  ];
  const headlessValue = env.AG_UI_CHROME_HEADLESS ?? env.AGUI_CHROME_HEADLESS;
  if (!falsyEnv(headlessValue)) args.push("--headless=new");
  const noSandboxValue = env.AG_UI_CHROME_NO_SANDBOX ?? env.AGUI_CHROME_NO_SANDBOX;
  if (truthyEnv(noSandboxValue) || process.getuid?.() === 0) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  args.push(...chromeArgs(env));
  return [...new Set(args)];
}

function chromeArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.AG_UI_CHROME_ARGS ?? env.AGUI_CHROME_ARGS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
    }
  } catch {
    // Fall through to whitespace splitting for simple container args.
  }
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function browserViewportSize(
  bounds?: BrowserViewBoundsInput,
): { width: number; height: number } | undefined {
  if (!bounds) return undefined;
  const width = clampInteger(bounds.width ?? DEFAULT_VIEWPORT.width, 1, 4096);
  const height = clampInteger(bounds.height ?? DEFAULT_VIEWPORT.height, 1, 4096);
  return { width, height };
}

function chromeWaitUntil(value: unknown): "domcontentloaded" | "load" | "none" {
  if (value === "domcontentloaded") return "domcontentloaded";
  if (value === "none") return "none";
  return "load";
}

function recordBrowserHistory(record: BrowserTarget, url: string): void {
  if (!url) return;
  const current = record.history[record.historyIndex];
  if (current && sameBrowserUrl(current, url)) return;
  const existingIndex = record.history.findIndex((item) => sameBrowserUrl(item, url));
  if (existingIndex >= 0) {
    record.historyIndex = existingIndex;
    return;
  }
  record.history = [...record.history.slice(0, record.historyIndex + 1), url].slice(-200);
  record.historyIndex = record.history.length - 1;
}

function sameBrowserUrl(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function browserTimeout(value: unknown): number {
  return clampInteger(value ?? DEFAULT_NAVIGATION_TIMEOUT_MS, 1_000, 10 * 60_000);
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

function safeBrowserAutomationUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  return isSafeBrowserPanelUrl(url) ? url : null;
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

function sanitizeCdpMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, 80)) {
    const normalizedKey = key.replace(/[\r\n\t\0]+/g, "").slice(0, 160);
    if (!normalizedKey) continue;
    if (typeof rawValue === "string") result[normalizedKey] = rawValue.slice(0, 8_192);
    else if (typeof rawValue === "number" || typeof rawValue === "boolean")
      result[normalizedKey] = rawValue;
    else result[normalizedKey] = sanitizeCdpEventParams(rawValue);
  }
  return result;
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
  if (!Number.isFinite(number))
    throw new Error(`Browser input requires finite ${label} coordinate.`);
  return number;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteInputNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function optionalStringInput(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
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

function configuredPath(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : "";
}

function configuredChromeCdpEndpoint(env: NodeJS.ProcessEnv): string {
  return (env.AG_UI_CHROME_CDP_ENDPOINT ?? env.AGUI_CHROME_CDP_ENDPOINT ?? "").trim();
}

function chromeCdpHeaders(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const authorization = env.AG_UI_CHROME_CDP_AUTHORIZATION ?? env.AGUI_CHROME_CDP_AUTHORIZATION;
  return authorization?.trim() ? { authorization: authorization.trim() } : undefined;
}

async function resolveChromeExecutablePath(env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = configuredPath(
    env.AG_UI_CHROME_EXECUTABLE_PATH ?? env.AGUI_CHROME_EXECUTABLE_PATH ?? env.CHROME_PATH,
  );
  if (explicit) {
    if (await fileExists(explicit)) return explicit;
    throw new Error(`Chrome executable was not found at ${explicit}.`);
  }

  const candidates = chromeExecutableCandidates(env);
  for (const candidate of candidates) {
    const executable = await resolveChromeExecutableCandidate(candidate);
    if (executable) return executable;
  }
  throw new Error(
    "Chrome executable was not found. Set AG_UI_CHROME_EXECUTABLE_PATH or AG_UI_CHROME_CDP_ENDPOINT.",
  );
}

function chromeExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "google-chrome",
      "chromium",
    ];
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? "";
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? env.PROGRAMFILES_X86 ?? "";
    return [
      path.join(programFiles, "Google/Chrome/Application/chrome.exe"),
      path.join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
      path.join(localAppData, "Google/Chrome/Application/chrome.exe"),
      path.join(programFiles, "Chromium/Application/chrome.exe"),
      path.join(programFilesX86, "Chromium/Application/chrome.exe"),
      "chrome.exe",
      "chrome",
      "chromium.exe",
      "chromium",
    ].filter(Boolean);
  }
  return [
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "chromium",
    "chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

async function resolveChromeExecutableCandidate(candidate: string): Promise<string | undefined> {
  if (candidate.includes(path.sep) || (process.platform === "win32" && candidate.includes("\\"))) {
    return (await fileExists(candidate)) ? candidate : undefined;
  }
  return findExecutableOnPath(candidate);
}

async function findExecutableOnPath(command: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? "";
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command.endsWith(extension) ? command : command + extension);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function chromeUserDataDir(env: NodeJS.ProcessEnv): Promise<ChromeUserDataDir> {
  const explicit = configuredPath(env.AG_UI_CHROME_USER_DATA_DIR ?? env.AGUI_CHROME_USER_DATA_DIR);
  if (explicit) return { path: explicit, temporary: false };
  return {
    path: await mkdtemp(path.join(tmpdir(), DEFAULT_CHROME_USER_DATA_DIR_PREFIX)),
    temporary: true,
  };
}

function browserLaunchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.AG_UI_CHROME_LAUNCH_TIMEOUT_MS ?? env.AGUI_CHROME_LAUNCH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), 60 * 60 * 1000)
    : DEFAULT_CHROME_LAUNCH_TIMEOUT_MS;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" && Number.isInteger(address.port) ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("Unable to allocate a local Chrome debugging port."));
      });
    });
  });
}

async function waitForChromeDebugEndpoint(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const endpoint = await chromeWebSocketEndpoint(`http://127.0.0.1:${port}`);
      if (endpoint) return endpoint;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Chrome DevTools endpoint: ${formatRuntimeError(
      lastError,
    )}`,
  );
}

async function chromeWebSocketEndpoint(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const value = endpoint.trim();
  if (/^wss?:\/\//i.test(value)) return value;
  const base = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const jsonUrl = new URL("/json/version", base);
  const version = await fetchChromeJson(jsonUrl.toString(), env);
  const webSocketDebuggerUrl = stringField(version, "webSocketDebuggerUrl");
  if (!webSocketDebuggerUrl) {
    throw new Error(`Chrome DevTools endpoint did not return webSocketDebuggerUrl: ${jsonUrl}`);
  }
  return webSocketDebuggerUrl;
}

async function fetchChromeJson(
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: chromeCdpHeaders(env),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Chrome DevTools request failed with HTTP ${response.status}.`);
    }
    return recordValue(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function connectChromeBrowser(
  endpoint: string,
  env: NodeJS.ProcessEnv,
  ownsProcess: boolean,
  child?: ChildProcess,
  userDataDir?: ChromeUserDataDir,
): Promise<ChromeBrowserInstance> {
  const webSocketEndpoint = await chromeWebSocketEndpoint(endpoint, env);
  const connection = await ChromeCdpConnection.open(webSocketEndpoint, chromeCdpHeaders(env));
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await connection.close().catch(() => undefined);
      if (ownsProcess && child) await stopChromeProcess(child);
      if (ownsProcess && userDataDir?.temporary) {
        await rm(userDataDir.path, { force: true, recursive: true }).catch(() => undefined);
      }
    },
    async closeTarget(targetId: string) {
      await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
    },
    connection,
    async createTarget(url: string, browserContextId?: string) {
      const targetPayload: Record<string, unknown> = {
        background: false,
        url: safeBrowserAutomationUrl(url) ?? "about:blank",
      };
      if (browserContextId) targetPayload.browserContextId = browserContextId;
      const target = recordValue(await connection.send("Target.createTarget", targetPayload));
      const targetId = stringField(target, "targetId");
      if (!targetId) throw new Error("Chrome DevTools did not return a target id.");
      const attached = recordValue(
        await connection.send("Target.attachToTarget", {
          flatten: true,
          targetId,
        }),
      );
      const sessionId = stringField(attached, "sessionId");
      if (!sessionId) {
        await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
        throw new Error("Chrome DevTools did not return a target session id.");
      }
      return {
        browserContextId,
        client: connection.createSession(sessionId),
        targetId,
      };
    },
    endpoint: webSocketEndpoint,
    ownsProcess,
  };
}

async function stopChromeProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([closed, delay(2_000)]).catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([closed, delay(1_000)]).catch(() => undefined);
}

function waitForCdpEvent(
  session: ChromeCdpSession,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for ${eventName}.`));
    }, timeoutMs);
    const listener = () => finish();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeCdpListener(session, eventName, listener);
      if (error) reject(error);
      else resolve();
    };
    session.on(eventName, listener);
  });
}

class ChromeCdpConnection {
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, ChromeCdpPendingRequest>();
  private readonly sessions = new Map<string, ChromeCdpSessionImpl>();

  private constructor(private readonly socket: WebSocket) {
    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("close", () => {
      this.handleClose(new Error("Chrome DevTools connection closed."));
    });
    this.socket.on("error", (error) => {
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
    });
  }

  static open(endpoint: string, headers?: Record<string, string>): Promise<ChromeCdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, headers ? { headers } : undefined);
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error("Timed out connecting to Chrome DevTools WebSocket."));
        socket.terminate();
      }, 10_000);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners("open");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        if (error) reject(error);
        else resolve(new ChromeCdpConnection(socket));
      };
      socket.once("open", () => finish());
      socket.once("error", (error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
      socket.once("close", () => {
        finish(new Error("Chrome DevTools WebSocket closed before it opened."));
      });
    });
  }

  createSession(sessionId: string): ChromeCdpSessionImpl {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new ChromeCdpSessionImpl(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Chrome DevTools connection is closed."));
    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      ...(params === undefined ? {} : { params }),
      ...(sessionId ? { sessionId } : {}),
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, reject, resolve });
      this.socket.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const closed = new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.socket.once("close", () => resolve());
    });
    this.rejectPending(new Error("Chrome DevTools connection was closed."));
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
    return Promise.race([
      closed,
      delay(1_000).then(() => {
        if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
      }),
    ]).then(() => undefined);
  }

  private handleMessage(data: RawData): void {
    let message: Record<string, unknown>;
    try {
      message = recordValue(JSON.parse(cdpRawDataToString(data)));
    } catch {
      return;
    }
    const id = Math.floor(numberField(message, "id"));
    if (Number.isInteger(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = recordValue(message.error);
      if (Object.keys(error).length > 0) {
        pending.reject(new Error(formatCdpError(pending.method, error)));
      } else {
        pending.resolve(recordValue(message.result));
      }
      return;
    }
    const method = stringField(message, "method");
    if (!method) return;
    const params = recordValue(message.params);
    const sessionId = stringField(message, "sessionId");
    if (sessionId) this.sessions.get(sessionId)?.emitEvent(method, params);
    const detachedSessionId = stringField(params, "sessionId");
    if (method === "Target.detachedFromTarget" && detachedSessionId) {
      this.sessions.get(detachedSessionId)?.emitEvent(method, params);
      this.sessions.delete(detachedSessionId);
    }
  }

  private handleClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class ChromeCdpSessionImpl extends EventEmitter {
  constructor(
    private readonly connection: ChromeCdpConnection,
    private readonly sessionId: string,
  ) {
    super();
  }

  async detach(): Promise<void> {
    await this.connection
      .send("Target.detachFromTarget", { sessionId: this.sessionId })
      .catch(() => undefined);
    this.connection.forgetSession(this.sessionId);
    this.removeAllListeners();
  }

  emitEvent(eventName: string, params: unknown): void {
    this.emit(eventName, params);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.connection.send(method, params, this.sessionId);
  }
}

function cdpRawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function formatCdpError(method: string, error: Record<string, unknown>): string {
  const message = stringField(error, "message") || "Chrome DevTools command failed.";
  const data = stringField(error, "data");
  return data ? `${method}: ${message} (${data})` : `${method}: ${message}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function truthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function falsyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return ["0", "false", "no", "off", "none", "disabled"].includes(normalized ?? "");
}

function removeCdpListener(
  session: ChromeCdpSession,
  eventName: string,
  listener: (params: unknown) => void,
): void {
  if (session.off) session.off(eventName, listener);
  else session.removeListener?.(eventName, listener);
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
