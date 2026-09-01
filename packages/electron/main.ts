import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  Notification,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  systemPreferences,
  type WebContents,
  type WebFrameMain,
} from "electron";
import type { AspEventSender } from "@the-next-ai/asp/manager";
import { AguiRuntime, configuredRuntimeUserDataPath } from "@the-next-ai/runtime";
import type {
  ExtensionActivateInput,
  ExtensionAuditListInput,
  ExtensionAssetInput,
  ExtensionCommandInput,
  ExtensionConfigurationInput,
  ExtensionConfigurationUpdateInput,
  ExtensionEnableInput,
  ExtensionGrantInput,
  ExtensionInstallInput,
  ExtensionListInput,
  ExtensionMarketplaceListInput,
  ExtensionUninstallInput,
  ExtensionUpdateInput,
  ExtensionWorkspaceTrustInput,
  ResolveAgentContributionsInput,
} from "@the-next-ai/extensions";
import { ExtensionService } from "./extension-service.js";
import {
  configureElectronBrowserService,
  disposeBrowserTargets,
  disposeInteractiveAppViews,
  invokeElectronBrowserMethod,
  relayInteractiveAppMessage,
  setBrowserMainWindow,
  stopBrowserScreencasts,
} from "./browser-service.js";
import { cachedIdeWorkspaceDiagnostics, ideDiagnostics, ideSemanticTokens } from "./ide-service.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
app.setName("AGUI");
let runtimeRpcServerStarted = false;
let runtimeRpcLastError = "";
const runtime = new AguiRuntime({
  browserMethod: invokeElectronBrowserMethod,
  eventBroadcast: (channel, payload) => broadcastToAppWindows(channel, payload),
  extensionMethod: invokeElectronExtensionMethod,
  homeDir: () => app.getPath("home"),
  ide: {
    diagnostics: ({ root, filePath, content }) => ideDiagnostics(root, filePath, content),
    semanticTokens: ({ root, filePath, content }) => ideSemanticTokens(root, filePath, content),
    workspaceDiagnostics: ({ root }) => cachedIdeWorkspaceDiagnostics(root),
  },
  runtimeInfo: () => ({
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    },
    features: {
      filePathAccess: true,
      nativeDialogs: true,
      webview: false,
      webContentsView: true,
      browserAutomation: true,
      browserScreencast: runtimeRpcServerStarted,
    },
  }),
  staticRoot: false,
  userDataPath: electronRuntimeUserDataPath,
  workspaceChoose: chooseWorkspace,
  workspaceDefault: "",
});
configureElectronBrowserService({
  broadcast: (channel, payload) => runtime.broadcast(channel, payload),
  remoteControlEnabled: () => runtimeRpcServerStarted,
});
let mainWindow: BrowserWindow | null = null;
const appWindows = new Set<BrowserWindow>();
let appQuitting = false;
let shutdownPromise: Promise<void> | null = null;
const closingWebContents = new WeakSet<WebContents>();
const extensionService = new ExtensionService((event) => {
  runtime.broadcast("agui:extensions:event", event);
});
const pendingAgentTaskNotificationOpens: AgentTaskNotificationOpen[] = [];

type WindowStatePayload = {
  isFullScreen: boolean;
  mode: WindowMode;
  pinned: boolean;
};

type WindowMode = "standard" | "compact";

type ThemeAppearance = "dark" | "light";

type ThemeStatePayload = {
  appearance: ThemeAppearance;
  theme: string;
};

const COMPACT_WINDOW_SIZE = { width: 440, height: 680 } as const;
const COMPACT_WINDOW_MIN_SIZE = { width: 380, height: 520 } as const;
const windowModes = new WeakMap<BrowserWindow, WindowMode>();
const pinnedCompactWindows = new WeakSet<BrowserWindow>();
let currentThemeState: ThemeStatePayload | null = null;

nativeTheme.on("updated", () => {
  if (currentThemeState?.theme !== "system") return;
  const appearance = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  if (appearance === currentThemeState.appearance) return;
  currentThemeState = { ...currentThemeState, appearance };
  broadcastToAppWindows("agui:theme:state", currentThemeState);
});

type RuntimeRpcSettings = {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
};

type RuntimeRpcSettingsView = RuntimeRpcSettings & {
  disabledByEnvironment: boolean;
  error: string | null;
  rpcUrl: string | null;
  running: boolean;
  settingsPath: string;
  webUrl: string | null;
};

type AgentTaskNotificationPayload = {
  sessionId: string;
  title: string;
  body?: string;
};

type AgentTaskNotificationOpen = {
  sessionId: string;
  at: number;
};

type RuntimeClient = AspEventSender & {
  sendJsonRpc?(message: unknown): void;
};

const IPC_RUNTIME_METHODS = {
  "agui:providers:list": "providers.list",
  "agui:providers:save": "providers.save",
  "agui:providers:remove": "providers.remove",
  "agui:providers:test": "providers.test",
  "agui:providers:capabilities": "providers.capabilities",
  "agui:providers:detect": "providers.detect",
  "agui:workspace:choose": "workspace.choose",
  "agui:workspace:default": "workspace.getDefault",
  "agui:workspace:list-directories": "workspace.listDirectories",
  "agui:workspace:private-root": "workspace.privateRoot",
  "agui:workspace:private-session": "workspace.privateSession",
  "agui:mcp-gateway:get-settings": "mcpGateway.getSettings",
  "agui:mcp-gateway:set-enabled": "mcpGateway.setEnabled",
  "agui:mcp-gateway:save-server": "mcpGateway.saveServer",
  "agui:mcp-gateway:remove-server": "mcpGateway.removeServer",
  "agui:mcp-gateway:refresh": "mcpGateway.refresh",
  "agui:mcp-gateway:set-llm": "mcpGateway.setLlm",
  "agui:browser-workflows:list": "browserWorkflows.list",
  "agui:browser-workflows:get": "browserWorkflows.get",
  "agui:browser-workflows:save": "browserWorkflows.save",
  "agui:browser-workflows:remove": "browserWorkflows.remove",
  "agui:browser-workflows:generate-from-annotations": "browserWorkflows.generateFromAnnotations",
  "agui:scheduled-tasks:list": "scheduledTasks.list",
  "agui:scheduled-tasks:add": "scheduledTasks.add",
  "agui:scheduled-tasks:update": "scheduledTasks.update",
  "agui:scheduled-tasks:remove": "scheduledTasks.remove",
  "agui:scheduled-tasks:set-enabled": "scheduledTasks.setEnabled",
  "agui:scheduled-tasks:run-now": "scheduledTasks.runNow",
  "agui:storage:get": "storage.get",
  "agui:storage:set": "storage.set",
  "agui:storage:remove": "storage.remove",
  "agui:storage:list": "storage.list",
  "agui:asp:run": "sessions.run",
  "agui:asp:cancel": "sessions.cancel",
  "agui:asp:extension-invoke": "sessions.invokeExtension",
  "agui:asp:list-sessions": "sessions.list",
  "agui:asp:session-messages": "sessions.messages",
  "agui:asp:resume-session": "sessions.resume",
  "agui:asp:hydrate-transcript": "sessions.hydrateTranscript",
  "agui:asp:delete-session": "sessions.delete",
  "agui:asp:pending-interactions": "interactions.pending",
  "agui:asp:approval-response": "interactions.respondApproval",
  "agui:asp:question-response": "interactions.respondQuestion",
  "agui:panel:sync-state": "panel.syncState",
  "agui:panel:sync-ide-state": "panel.syncIdeState",
  "agui:terminal:run": "terminal.run",
  "agui:terminal:exec": "terminal.exec",
  "agui:terminal:cancel": "terminal.cancel",
  "agui:terminal:create": "terminal.create",
  "agui:terminal:write": "terminal.write",
  "agui:terminal:resize": "terminal.resize",
  "agui:terminal:dispose": "terminal.dispose",
  "agui:browser:create": "browser.create",
  "agui:browser:register": "browser.register",
  "agui:browser:unregister": "browser.unregister",
  "agui:browser:set-bounds": "browser.setBounds",
  "agui:browser:release-focus": "browser.releaseFocus",
  "agui:browser:list": "browser.list",
  "agui:browser:navigate": "browser.navigate",
  "agui:browser:reload": "browser.reload",
  "agui:browser:stop": "browser.stop",
  "agui:browser:go-back": "browser.goBack",
  "agui:browser:go-forward": "browser.goForward",
  "agui:browser:evaluate": "browser.evaluate",
  "agui:browser:click": "browser.click",
  "agui:browser:type": "browser.type",
  "agui:browser:snapshot": "browser.snapshot",
  "agui:browser:screenshot": "browser.screenshot",
  "agui:browser:set-annotation-mode": "browser.setAnnotationMode",
  "agui:browser:set-workflow-recording-mode": "browser.setWorkflowRecordingMode",
  "agui:browser:list-annotations": "browser.listAnnotations",
  "agui:browser:clear-annotations": "browser.clearAnnotations",
  "agui:browser:add-annotation": "browser.addAnnotation",
  "agui:browser:delete-annotation": "browser.deleteAnnotation",
  "agui:browser:inspect-element": "browser.inspectElement",
  "agui:browser:cdp-command": "browser.cdpCommand",
  "agui:browser:cdp-start-capture": "browser.cdpStartCapture",
  "agui:browser:cdp-events": "browser.cdpEvents",
  "agui:browser:cdp-stop-capture": "browser.cdpStopCapture",
  "agui:browser:screencast-start": "browser.screencastStart",
  "agui:browser:screencast-ack": "browser.screencastAck",
  "agui:browser:screencast-stop": "browser.screencastStop",
  "agui:browser:dispatch-mouse": "browser.dispatchMouse",
  "agui:browser:dispatch-key": "browser.dispatchKey",
  "agui:browser:insert-text": "browser.insertText",
  "agui:interactive-app:create": "interactiveApp.create",
  "agui:interactive-app:destroy": "interactiveApp.destroy",
  "agui:interactive-app:set-bounds": "interactiveApp.setBounds",
  "agui:interactive-app:post-message": "interactiveApp.postMessage",
  "agui:ide:tree": "ide.tree",
  "agui:ide:read-file": "ide.readFile",
  "agui:ide:write-file": "ide.writeFile",
  "agui:ide:diagnostics": "ide.diagnostics",
  "agui:ide:workspace-diagnostics": "ide.workspaceDiagnostics",
  "agui:ide:semantic-tokens": "ide.semanticTokens",
  "agui:extensions:list": "extensions.list",
  "agui:extensions:audit": "extensions.audit",
  "agui:extensions:choose-install": "extensions.chooseInstall",
  "agui:extensions:choose-update": "extensions.chooseUpdate",
  "agui:extensions:install": "extensions.install",
  "agui:extensions:marketplace": "extensions.marketplace",
  "agui:extensions:update": "extensions.update",
  "agui:extensions:uninstall": "extensions.uninstall",
  "agui:extensions:set-enabled": "extensions.setEnabled",
  "agui:extensions:grant": "extensions.grant",
  "agui:extensions:set-workspace-trust": "extensions.setWorkspaceTrust",
  "agui:extensions:workspace-trusted": "extensions.workspaceTrusted",
  "agui:extensions:read-asset": "extensions.readAsset",
  "agui:extensions:activate": "extensions.activate",
  "agui:extensions:execute-command": "extensions.executeCommand",
  "agui:extensions:resolve-agent": "extensions.resolveAgent",
  "agui:extensions:get-configuration": "extensions.getConfiguration",
  "agui:extensions:update-configuration": "extensions.updateConfiguration",
} as const;

if (process.platform === "win32") app.setAppUserModelId("com.agui.desktop");

const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
  console.error("Another AGUI Desktop instance is already running.");
  app.quit();
}

app.on("second-instance", () => {
  const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

app.whenReady().then(() => {
  registerIpc();
  void startRuntimeRpcServer();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else (mainWindow ?? BrowserWindow.getAllWindows()[0])?.show();
  });
});

app.on("window-all-closed", () => {
  if (appQuitting) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownPromise) return;
  event.preventDefault();
  appQuitting = true;
  disposeInteractiveAppViews();
  disposeBrowserTargets();
  const rendererShutdown = Promise.all(
    BrowserWindow.getAllWindows().map(
      (window) =>
        new Promise<void>((resolve) => {
          const forceClose = setTimeout(() => {
            if (!window.isDestroyed()) window.destroy();
            resolve();
          }, 1_000);
          window.once("closed", () => {
            clearTimeout(forceClose);
            resolve();
          });
          window.close();
        }),
    ),
  );
  shutdownPromise = rendererShutdown
    .then(async () => {
      try {
        await runtime.stop();
      } finally {
        await extensionService.dispose();
      }
    })
    .catch((error) => console.error("AGUI shutdown failed.", error))
    .finally(() => app.quit());
});

function createMainWindow(): void {
  createAppWindow({ primary: true });
}

function createSessionWindow(sessionId: string, mode: WindowMode = "standard"): BrowserWindow {
  return createAppWindow({ mode, sessionId });
}

function createAppWindow(
  options: { mode?: WindowMode; primary?: boolean; sessionId?: string } = {},
): BrowserWindow {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const mode = options.mode ?? "standard";
  const compact = mode === "compact";
  const titleBarHeight = 52;
  const window = new BrowserWindow({
    width: compact ? COMPACT_WINDOW_SIZE.width : isMac ? 1180 : 1440,
    height: compact ? COMPACT_WINDOW_SIZE.height : isMac ? 780 : 920,
    minWidth: compact ? COMPACT_WINDOW_MIN_SIZE.width : 900,
    minHeight: compact ? COMPACT_WINDOW_MIN_SIZE.height : 620,
    center: compact,
    frame: !compact,
    fullscreenable: !compact,
    hasShadow: !compact,
    maximizable: !compact,
    roundedCorners: true,
    show: false,
    title: "AGUI",
    ...(compact && isMac
      ? {
          vibrancy: "popover" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    ...(compact && isWindows
      ? {
          backgroundColor: "#00000000",
          backgroundMaterial: "acrylic" as const,
        }
      : {}),
    ...(compact && !isMac && !isWindows ? { backgroundColor: "#00000000", transparent: true } : {}),
    ...(!compact ? { backgroundColor: isMac ? "#171717" : "#212121" } : {}),
    ...(!compact
      ? {
          titleBarStyle: isMac ? ("hidden" as const) : ("default" as const),
        }
      : {}),
    ...(!compact && isMac
      ? {
          trafficLightPosition: {
            x: 16,
            y: Math.round((titleBarHeight - 14) / 2),
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  windowModes.set(window, mode);
  if (options.primary) {
    mainWindow = window;
    setBrowserMainWindow(window);
  }
  appWindows.add(window);
  const createdWindow = window;
  const createdWebContents = window.webContents;
  hardenMainWindow(createdWebContents);

  if (isMac) {
    window.setWindowButtonVisibility(!compact);
    if (!compact) window.setSheetOffset(titleBarHeight);
  }
  window.once("ready-to-show", () => {
    createdWindow.show();
    sendWindowState(createdWindow);
  });
  window.on("enter-full-screen", () => sendWindowState(createdWindow));
  window.on("leave-full-screen", () => sendWindowState(createdWindow));
  window.on("always-on-top-changed", () => sendWindowState(createdWindow));
  createdWebContents.once("destroyed", () => {
    closingWebContents.add(createdWebContents);
  });
  window.on("close", () => {
    closingWebContents.add(createdWebContents);
    if (mainWindow === createdWindow) {
      disposeInteractiveAppViews();
      disposeBrowserTargets();
    }
  });
  window.on("closed", () => {
    appWindows.delete(createdWindow);
    if (mainWindow === createdWindow) {
      mainWindow = null;
      setBrowserMainWindow(null);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
  });
  createdWebContents.on("unresponsive", () => {
    console.warn("Main renderer became unresponsive.");
  });
  createdWebContents.on("responsive", () => {
    console.info("Main renderer became responsive.");
  });
  createdWebContents.on("render-process-gone", (_event, details) => {
    console.error(
      `Main renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });

  const devServerUrl = developmentServerUrl();
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    if (options.sessionId) url.searchParams.set("sessionId", options.sessionId);
    if (compact) url.searchParams.set("windowMode", "compact");
    void window.loadURL(url.toString());
  } else {
    const query: Record<string, string> = {};
    if (options.sessionId) query.sessionId = options.sessionId;
    if (compact) query.windowMode = "compact";
    const loadOptions = Object.keys(query).length > 0 ? { query } : undefined;
    void window.loadFile(path.join(currentDirectory, "..", "dist", "index.html"), loadOptions);
  }
  return window;
}

function registerIpc(): void {
  ipcMain.handle("agui:window:state", (event) => {
    assertTrustedSender(event);
    return getWindowState(BrowserWindow.fromWebContents(event.sender) ?? mainWindow);
  });

  ipcMain.handle("agui:window:open-external", (event, url?: unknown) => {
    assertTrustedSender(event);
    if (typeof url !== "string" || !isSafeExternalUrl(url)) return false;
    void shell.openExternal(url);
    return true;
  });

  ipcMain.handle("agui:window:open-session", (event, params?: unknown) => {
    assertTrustedSender(event);
    const sessionId = stringField(params, "sessionId");
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(sessionId)) return false;
    const mode = stringField(params, "mode") === "compact" ? "compact" : "standard";
    createSessionWindow(sessionId, mode);
    return true;
  });

  ipcMain.handle("agui:window:set-pinned", (event, pinned?: unknown) => {
    assertTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || windowModes.get(window) !== "compact" || typeof pinned !== "boolean") {
      return getWindowState(window);
    }
    setCompactWindowPinned(window, pinned);
    return getWindowState(window);
  });

  ipcMain.handle("agui:window:close", (event) => {
    assertTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    setImmediate(() => {
      if (!window.isDestroyed()) window.close();
    });
    return true;
  });

  ipcMain.handle("agui:theme:state", (event) => {
    assertTrustedSender(event);
    return currentThemeState;
  });

  ipcMain.handle("agui:theme:set-selection", (event, value?: unknown) => {
    assertTrustedSender(event);
    const theme = safeThemeId(value);
    if (!theme) return currentThemeState ?? nativeThemeState("dark");
    return setThemeSelection(theme);
  });

  ipcMain.handle("agui:theme:set-appearance", (event, value?: unknown) => {
    assertTrustedSender(event);
    const state = safeThemeState(value);
    if (!state || state.theme !== currentThemeState?.theme) return currentThemeState;
    return setThemeAppearance(state.appearance);
  });

  ipcMain.handle("agui:notifications:task-complete", (event, params?: unknown) => {
    assertTrustedSender(event);
    return showAgentTaskNotification(params);
  });

  ipcMain.handle("agui:notifications:consume-task-opens", (event) => {
    assertTrustedSender(event);
    return consumePendingAgentTaskNotificationOpens();
  });

  ipcMain.handle("agui:permissions:microphone-status", (event) => {
    assertTrustedSender(event);
    return microphonePermissionResult(microphoneAccessAlreadyGranted());
  });

  ipcMain.handle("agui:permissions:request-microphone", async (event) => {
    assertTrustedSender(event);
    return requestNativeMicrophoneAccess();
  });

  ipcMain.handle("agui:permissions:open-microphone-settings", async (event) => {
    assertTrustedSender(event);
    return openMicrophonePrivacySettings();
  });

  ipcMain.handle("agui:voice:save-recording", async (event, input?: unknown) => {
    assertTrustedSender(event);
    try {
      return await saveVoiceRecording(input);
    } catch (error) {
      console.error(`Voice recording save failed: ${formatRuntimeError(error)}`);
      throw error;
    }
  });

  ipcMain.handle("agui:clipboard:write-text", (event, value?: unknown) => {
    assertTrustedSender(event);
    clipboard.writeText(typeof value === "string" ? value : String(value ?? ""));
    return true;
  });

  ipcMain.handle("agui:runtime-rpc:get-settings", (event) => {
    assertTrustedSender(event);
    return runtimeRpcSettingsView();
  });

  ipcMain.handle("agui:runtime-rpc:save-settings", async (event, params?: unknown) => {
    assertTrustedSender(event);
    const settings = normalizeRuntimeRpcSettings(params, readRuntimeRpcSettings());
    writeRuntimeRpcSettings(settings);
    await applyRuntimeRpcSettings(settings);
    return runtimeRpcSettingsView(settings);
  });

  for (const [channel, method] of Object.entries(IPC_RUNTIME_METHODS)) {
    ipcMain.handle(channel, async (event, params?: unknown) => {
      assertTrustedSender(event);
      const client = electronRuntimeClient(event.sender);
      try {
        return await invokeRuntimeMethod(method, params, client);
      } catch (error) {
        if (shouldIgnoreRuntimeIpcError(error, client)) return null;
        throw error;
      }
    });
  }

  ipcMain.on("agui:interactive-app:message", (event, payload?: unknown) => {
    relayInteractiveAppMessage(event.sender.id, event.senderFrame?.url ?? "", payload);
  });
}

function getWindowState(window: BrowserWindow | null = mainWindow): WindowStatePayload {
  return {
    isFullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    mode: window && !window.isDestroyed() ? (windowModes.get(window) ?? "standard") : "standard",
    pinned: Boolean(window && !window.isDestroyed() && pinnedCompactWindows.has(window)),
  };
}

function setCompactWindowPinned(window: BrowserWindow, pinned: boolean): void {
  if (window.isDestroyed() || windowModes.get(window) !== "compact") return;
  if (pinned) pinnedCompactWindows.add(window);
  else pinnedCompactWindows.delete(window);
  window.setAlwaysOnTop(pinned, "floating");
  window.setResizable(!pinned);
  window.setMovable(!pinned);
  sendWindowState(window);
}

function sendWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  safeSendWebContents(window.webContents, "agui:window:state", getWindowState(window));
}

function setThemeSelection(theme: string): ThemeStatePayload {
  const previousAppearance =
    currentThemeState?.appearance ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  const requestedSource =
    theme === "system" ? "system" : theme === "dark" || theme === "light" ? theme : null;
  if (requestedSource && nativeTheme.themeSource !== requestedSource) {
    nativeTheme.themeSource = requestedSource;
  }
  const appearance =
    theme === "system"
      ? nativeTheme.shouldUseDarkColors
        ? "dark"
        : "light"
      : theme === "dark" || theme === "light"
        ? theme
        : previousAppearance;
  const next = { appearance, theme } satisfies ThemeStatePayload;
  if (currentThemeState?.theme !== next.theme || currentThemeState.appearance !== next.appearance) {
    currentThemeState = next;
    broadcastToAppWindows("agui:theme:state", next);
  }
  return currentThemeState ?? next;
}

function setThemeAppearance(appearance: ThemeAppearance): ThemeStatePayload | null {
  if (!currentThemeState) return null;
  const next = { ...currentThemeState, appearance };
  const source = next.theme === "system" ? "system" : appearance;
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  if (currentThemeState.appearance !== appearance) {
    currentThemeState = next;
    broadcastToAppWindows("agui:theme:state", next);
  }
  return currentThemeState;
}

function nativeThemeState(theme: ThemeAppearance): ThemeStatePayload {
  return { appearance: theme, theme };
}

function safeThemeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const theme = value.trim();
  return theme.length > 0 && theme.length <= 200 && !/[\u0000-\u001f\u007f<>]/.test(theme)
    ? theme
    : null;
}

function safeThemeState(value: unknown): ThemeStatePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const theme = safeThemeId(source.theme);
  const appearance = source.appearance;
  return theme && (appearance === "dark" || appearance === "light") ? { appearance, theme } : null;
}

function showAgentTaskNotification(input: unknown): boolean {
  const payload = safeAgentTaskNotificationPayload(input);
  if (!payload || !Notification.isSupported()) return false;
  if (process.env.AG_UI_DISABLE_SYSTEM_NOTIFICATIONS === "1") return false;

  const notification = new Notification({
    title: payload.title,
    body: payload.body,
    silent: false,
  });
  notification.on("click", () => openAgentTaskFromNotification(payload.sessionId));
  notification.show();
  return true;
}

function openAgentTaskFromNotification(sessionId: string): void {
  const payload = { sessionId, at: Date.now() };
  pendingAgentTaskNotificationOpens.push(payload);
  focusMainWindowFromNotification();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    return;
  }
  safeSendWebContents(mainWindow.webContents, "agui:notifications:task-open", payload);
}

function focusMainWindowFromNotification(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function consumePendingAgentTaskNotificationOpens(): AgentTaskNotificationOpen[] {
  return pendingAgentTaskNotificationOpens.splice(0);
}

async function invokeRuntimeMethod(
  method: string,
  params: unknown,
  client: RuntimeClient,
): Promise<unknown> {
  return runtime.invokeRuntimeMethod(method, params, client);
}

let extensionMethodQueue: Promise<void> = Promise.resolve();

function invokeElectronExtensionMethod(method: string, params: unknown): Promise<unknown> {
  if (method === "extensions.chooseInstall" || method === "extensions.chooseUpdate") {
    return invokeElectronExtensionMethodNow(method, params);
  }
  const pending = extensionMethodQueue.then(() => invokeElectronExtensionMethodNow(method, params));
  extensionMethodQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function invokeElectronExtensionMethodNow(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "extensions.list": {
      const input = params as ExtensionListInput | undefined;
      return extensionService.list(
        String(input?.workspacePath ?? ""),
        String(input?.workspaceId ?? ""),
        input?.extensionIds,
      );
    }
    case "extensions.audit": {
      return extensionService.audit((params as ExtensionAuditListInput | undefined) ?? {});
    }
    case "extensions.marketplace": {
      return extensionService.marketplace(
        (params as ExtensionMarketplaceListInput | undefined) ?? {},
      );
    }
    case "extensions.chooseInstall": {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        title: "Install AGUI Extension",
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "AGUI Extension", extensions: ["aguix"] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
    case "extensions.chooseUpdate": {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        title: "Update AGUI Extension",
        properties: ["openFile"],
        filters: [{ name: "AGUI Extension Package", extensions: ["aguix"] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
    case "extensions.install": {
      const input = params as ExtensionInstallInput;
      return extensionService.install(
        input?.sourcePath ? String(input.sourcePath) : "",
        input?.workspaceId,
        input?.workspacePath,
        {
          expectedSha256: input?.expectedSha256,
          sourceUrl: input?.sourceUrl,
          updateUrl: input?.updateUrl,
        },
      );
    }
    case "extensions.update": {
      const input = params as ExtensionUpdateInput;
      return extensionService.update(
        String(input?.extensionId ?? ""),
        {
          expectedSha256: input?.expectedSha256,
          sourcePath: input?.sourcePath,
          sourceUrl: input?.sourceUrl,
        },
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.uninstall": {
      const input = params as ExtensionUninstallInput | string;
      return typeof input === "string"
        ? extensionService.uninstall(input)
        : extensionService.uninstall(
            String(input?.extensionId ?? ""),
            input?.workspaceId,
            input?.workspacePath,
          );
    }
    case "extensions.setEnabled": {
      const input = params as ExtensionEnableInput;
      return extensionService.setEnabled(
        String(input?.extensionId ?? ""),
        Boolean(input?.enabled),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.grant": {
      const input = params as ExtensionGrantInput;
      return extensionService.grant(
        String(input?.extensionId ?? ""),
        input?.permissions ?? [],
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.setWorkspaceTrust": {
      const input = params as ExtensionWorkspaceTrustInput;
      return extensionService.setWorkspaceTrust(
        String(input?.workspacePath ?? ""),
        Boolean(input?.trusted),
        input?.workspaceId,
      );
    }
    case "extensions.workspaceTrusted": {
      const input = params as { workspacePath?: string };
      return extensionService.isWorkspaceTrusted(String(input?.workspacePath ?? ""));
    }
    case "extensions.readAsset": {
      const input = params as ExtensionAssetInput;
      return extensionService.readAsset(
        String(input?.extensionId ?? ""),
        String(input?.path ?? ""),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.activate": {
      const input = params as ExtensionActivateInput;
      return extensionService.activate(
        String(input?.extensionId ?? ""),
        String(input?.event ?? ""),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.executeCommand": {
      const input = params as ExtensionCommandInput;
      return extensionService.executeCommand(
        String(input?.extensionId ?? ""),
        String(input?.command ?? ""),
        Array.isArray(input?.args) ? input.args : [],
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.resolveAgent": {
      const input = params as ResolveAgentContributionsInput;
      return extensionService.resolveAgentContributions(
        String(input?.workspacePath ?? ""),
        String(input?.workspaceId ?? ""),
        input?.extensionIds,
      );
    }
    case "extensions.getConfiguration": {
      const input = params as ExtensionConfigurationInput;
      return extensionService.getConfiguration(
        String(input?.extensionId ?? ""),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.updateConfiguration": {
      const input = params as ExtensionConfigurationUpdateInput;
      return extensionService.updateConfiguration(
        String(input?.extensionId ?? ""),
        input?.values && typeof input.values === "object" && !Array.isArray(input.values)
          ? input.values
          : {},
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    default:
      throw new Error(`Unknown extension runtime method: ${method}`);
  }
}

async function chooseWorkspace(initialPath?: string): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!window) return null;
  const result = await dialog.showOpenDialog(window, {
    defaultPath: typeof initialPath === "string" ? initialPath : undefined,
    properties: ["openDirectory", "createDirectory"],
    title: "Choose workspace",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function electronRuntimeClient(sender: WebContents): RuntimeClient {
  return {
    id: sender.id,
    isDestroyed: () => !canSendToWebContents(sender),
    send: (channel, payload) => {
      safeSendWebContents(sender, channel, payload);
    },
  };
}

function broadcastToAppWindows(channel: string, payload: unknown): void {
  for (const window of appWindows) {
    if (window.isDestroyed()) continue;
    safeSendWebContents(window.webContents, channel, payload);
  }
}

function canSendToWebContents(contents: WebContents): boolean {
  return liveMainFrame(contents) !== null;
}

function safeSendWebContents(contents: WebContents, channel: string, payload: unknown): boolean {
  const frame = liveMainFrame(contents);
  if (!frame) return false;
  try {
    frame.send(channel, payload);
    return true;
  } catch (error) {
    if (isDisposedRendererError(error)) return false;
    console.warn(`Failed to send ${channel}: ${formatRuntimeError(error)}`);
    return false;
  }
}

function liveMainFrame(contents: WebContents): WebFrameMain | null {
  if (closingWebContents.has(contents) || contents.isDestroyed() || contents.isCrashed())
    return null;
  try {
    const frame = contents.mainFrame;
    if (frame.isDestroyed() || frame.detached) return null;
    return frame;
  } catch {
    return null;
  }
}

function shouldIgnoreRuntimeIpcError(error: unknown, client: RuntimeClient): boolean {
  if (!appQuitting && !client.isDestroyed()) return false;
  const message = formatRuntimeError(error);
  return (
    isDisposedRendererError(error) ||
    /exited before completing the ASP run/i.test(message) ||
    /ASP run .* (ended|was canceled)/i.test(message) ||
    /AGUI runtime WebSocket closed/i.test(message)
  );
}

function isDisposedRendererError(error: unknown): boolean {
  const message = formatRuntimeError(error);
  return (
    /Render frame was disposed before WebFrameMain could be accessed/i.test(message) ||
    /Object has been destroyed/i.test(message) ||
    /webContents.*destroyed/i.test(message)
  );
}

async function startRuntimeRpcServer(): Promise<void> {
  await applyRuntimeRpcSettings(readRuntimeRpcSettings());
}

async function applyRuntimeRpcSettings(settings: RuntimeRpcSettings): Promise<void> {
  runtimeRpcLastError = "";
  if (runtimeRpcServerStarted) {
    runtimeRpcServerStarted = false;
    await runtime.stopRpcServer();
    stopBrowserScreencasts();
  }
  runtime.configureRpcServer({
    host: settings.host,
    port: settings.port,
    token: settings.token || randomBytes(24).toString("base64url"),
  });
  if (!settings.enabled || runtimeRpcDisabledByEnvironment()) {
    stopBrowserScreencasts();
    return;
  }
  if (!settings.token) {
    stopBrowserScreencasts();
    runtimeRpcLastError = "AGUI JSON-RPC requires an access token before it can be exposed.";
    return;
  }
  try {
    await runtime.start();
    runtimeRpcServerStarted = true;
  } catch (error) {
    stopBrowserScreencasts();
    runtimeRpcLastError = formatRuntimeError(error);
    console.warn(`AGUI JSON-RPC server failed: ${runtimeRpcLastError}`);
  }
}

function readRuntimeRpcSettings(): RuntimeRpcSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeRpcSettingsPath(), "utf8")) as unknown;
    return normalizeRuntimeRpcSettings(parsed, defaultRuntimeRpcSettings());
  } catch {
    return defaultRuntimeRpcSettings();
  }
}

function writeRuntimeRpcSettings(settings: RuntimeRpcSettings): void {
  const filePath = runtimeRpcSettingsPath();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

function runtimeRpcSettingsView(settings = readRuntimeRpcSettings()): RuntimeRpcSettingsView {
  const disabledByEnvironment = runtimeRpcDisabledByEnvironment();
  return {
    ...settings,
    disabledByEnvironment,
    error: disabledByEnvironment
      ? "AGUI JSON-RPC is disabled by AG_UI_RPC_DISABLED."
      : runtimeRpcLastError || null,
    rpcUrl: runtimeRpcServerStarted ? runtime.rpcUrl() : null,
    running: runtimeRpcServerStarted,
    settingsPath: runtimeRpcSettingsPath(),
    webUrl: runtimeRpcServerStarted ? runtime.webUrl() : null,
  };
}

function normalizeRuntimeRpcSettings(
  input: unknown,
  fallback: RuntimeRpcSettings,
): RuntimeRpcSettings {
  const source = record(input);
  const unknownKeys = Object.keys(source).filter(
    (key) => !["enabled", "host", "port", "token"].includes(key),
  );
  if (unknownKeys.length) {
    throw new Error(`Unknown runtime RPC settings: ${unknownKeys.join(", ")}`);
  }
  const enabled = typeof source.enabled === "boolean" ? source.enabled : fallback.enabled;
  const host = normalizeRuntimeRpcHost(source.host ?? fallback.host);
  const port = runtimeRpcPortValue(source.port ?? fallback.port);
  const suppliedToken = stringValue(source.token);
  if (
    suppliedToken &&
    (suppliedToken.length < 24 ||
      suppliedToken.length > 512 ||
      /[\x00-\x20\x7f]/.test(suppliedToken))
  ) {
    throw new Error("Runtime RPC access token must be 24-512 visible characters.");
  }
  const token =
    suppliedToken ||
    (enabled ? fallback.token || randomBytes(24).toString("base64url") : fallback.token);
  return {
    enabled,
    host,
    port,
    token,
  };
}

function normalizeRuntimeRpcHost(value: unknown): string {
  const rawHost = stringValue(value) || "127.0.0.1";
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const validHostname =
    host.length <= 253 &&
    host
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
      );
  if (!isIP(host) && !validHostname) {
    throw new Error("Runtime RPC host is not a valid hostname or IP address.");
  }
  return host;
}

function defaultRuntimeRpcSettings(): RuntimeRpcSettings {
  const token = stringValue(process.env.AG_UI_RPC_TOKEN ?? process.env.AGUI_RPC_TOKEN);
  return {
    enabled: Boolean(token) && !runtimeRpcDisabledByEnvironment(),
    host: stringValue(process.env.AG_UI_WEB_HOST ?? process.env.AGUI_WEB_HOST) || "127.0.0.1",
    port: runtimeRpcPortValue(
      process.env.AG_UI_WEB_PORT ??
        process.env.AGUI_WEB_PORT ??
        process.env.AG_UI_RPC_PORT ??
        process.env.AGUI_RPC_PORT,
    ),
    token,
  };
}

function runtimeRpcSettingsPath(): string {
  return path.join(electronRuntimeUserDataPath(), "runtime-rpc.json");
}

function runtimeRpcDisabledByEnvironment(): boolean {
  return process.env.AG_UI_RPC_DISABLED === "1";
}

function electronRuntimeUserDataPath(): string {
  return configuredRuntimeUserDataPath({
    env: process.env,
    homeDir: () => app.getPath("home"),
  });
}

function runtimeRpcPortValue(value: unknown): number {
  const parsed = Number(value ?? 17371);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 17371;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertTrustedSender(event: {
  sender: WebContents;
  senderFrame?: WebFrameMain | null;
}): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed() || !appWindows.has(senderWindow)) {
    throw new Error("IPC request came from an untrusted renderer.");
  }
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || frame.isDestroyed() || frame.detached) {
    throw new Error("IPC requests are only accepted from the main renderer frame.");
  }
  if (!isTrustedRendererUrl(frame.url)) {
    throw new Error("IPC request came from an untrusted renderer origin.");
  }
}

function developmentServerUrl(): string {
  return process.env.VITE_DEV_SERVER_URL || processArgumentValue("--dev-server-url");
}

function processArgumentValue(name: string): string {
  const inlinePrefix = `${name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const value = process.argv[index] ?? "";
    if (value.startsWith(inlinePrefix)) return value.slice(inlinePrefix.length);
    if (value === name) return process.argv[index + 1] ?? "";
  }
  return "";
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const devServerUrl = developmentServerUrl();
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
    if (url.protocol !== "file:") return false;
    const expected = path.resolve(currentDirectory, "..", "dist", "index.html");
    return path.resolve(fileURLToPath(url)) === expected;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function hardenMainWindow(contents: WebContents): void {
  contents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (!isTrustedAppWindowContents(webContents) || permission !== "media") return false;
    if (!isTrustedMediaPermissionCheck(details)) return false;
    return microphoneAccessAlreadyGranted();
  });
  contents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    void resolveMainWindowPermissionRequest(webContents, permission, details)
      .then(callback)
      .catch(() => callback(false));
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function isTrustedAppWindowContents(webContents: WebContents | null): boolean {
  if (!webContents || webContents.isDestroyed()) return false;
  const senderWindow = BrowserWindow.fromWebContents(webContents);
  return Boolean(senderWindow && !senderWindow.isDestroyed() && appWindows.has(senderWindow));
}

function isTrustedMediaPermissionCheck(details: Electron.PermissionCheckHandlerHandlerDetails) {
  if (!details.isMainFrame) return false;
  if (details.mediaType !== "audio") return false;
  const requestingUrl = details.requestingUrl ?? "";
  if (!isTrustedRendererUrl(requestingUrl)) return false;
  const securityOrigin = details.securityOrigin || requestingUrl;
  return isTrustedRendererOrigin(securityOrigin);
}

async function resolveMainWindowPermissionRequest(
  webContents: WebContents,
  permission: string,
  details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest,
): Promise<boolean> {
  if (!isTrustedAppWindowContents(webContents) || permission !== "media") return false;
  if (!isTrustedMediaPermissionRequest(details)) return false;
  const result = await requestNativeMicrophoneAccess();
  console.info(
    `Media permission request resolved. status=${result.status} granted=${result.granted}`,
  );
  return result.granted;
}

function isTrustedMediaPermissionRequest(
  details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest,
): boolean {
  if (!details.isMainFrame) return false;
  if (!isTrustedRendererUrl(details.requestingUrl)) return false;
  const mediaDetails = details as Electron.MediaAccessPermissionRequest;
  if (mediaDetails.mediaTypes?.includes("video")) return false;
  if (mediaDetails.mediaTypes && !mediaDetails.mediaTypes.includes("audio")) return false;
  return isTrustedRendererOrigin(mediaDetails.securityOrigin || details.requestingUrl);
}

function isTrustedRendererOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const devServerUrl = developmentServerUrl();
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
    return url.protocol === "file:";
  } catch {
    return false;
  }
}

function microphoneAccessAlreadyGranted(): boolean {
  if (process.platform !== "darwin") return true;
  return systemPreferences.getMediaAccessStatus("microphone") === "granted";
}

type MicrophoneAccessStatus = "denied" | "granted" | "not-determined" | "restricted" | "unknown";

function microphonePermissionResult(granted: boolean, previousStatus?: MicrophoneAccessStatus) {
  return {
    granted,
    platform: process.platform,
    ...(previousStatus ? { previousStatus } : {}),
    status: nativeMicrophoneAccessStatus(),
  };
}

function nativeMicrophoneAccessStatus(): MicrophoneAccessStatus {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("microphone");
}

async function requestNativeMicrophoneAccess() {
  if (process.platform !== "darwin") return microphonePermissionResult(true);
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return microphonePermissionResult(true, status);
  try {
    console.info(`Microphone permission request started. status=${status}`);
    const granted = await systemPreferences.askForMediaAccess("microphone");
    console.info(
      `Microphone permission request finished. before=${status} after=${nativeMicrophoneAccessStatus()} granted=${granted}`,
    );
    return microphonePermissionResult(granted, status);
  } catch {
    console.warn(
      `Microphone permission request failed. before=${status} after=${nativeMicrophoneAccessStatus()}`,
    );
    return microphonePermissionResult(false, status);
  }
}

async function openMicrophonePrivacySettings(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
    return true;
  } catch {
    const appPaths = [
      "/System/Applications/System Settings.app",
      "/System/Applications/System Preferences.app",
    ];
    for (const appPath of appPaths) {
      if (!fs.existsSync(appPath)) continue;
      if (!(await shell.openPath(appPath))) return true;
    }
    return false;
  }
}

const voiceRecordingMaxBytes = 50 * 1024 * 1024;
const voiceRecordingMimeExtensions = new Map([
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/webm", "webm"],
  ["audio/webm;codecs=opus", "webm"],
]);

async function saveVoiceRecording(input: unknown) {
  const payload = record(input);
  const data = voiceRecordingBuffer(payload);
  if (!data.length) throw new Error("Voice recording is empty.");
  if (data.length > voiceRecordingMaxBytes) throw new Error("Voice recording is too large.");
  const mime = voiceRecordingMime(payload.mime);
  const extension = voiceRecordingExtension(payload.extension, mime);
  const name = `voice-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString(
    "hex",
  )}.${extension}`;
  const filePath = await writeVoiceRecordingFile(name, data);
  return {
    mime,
    name,
    path: filePath,
    size: data.length,
  };
}

async function writeVoiceRecordingFile(name: string, data: Buffer): Promise<string> {
  const directories = [
    path.join(app.getPath("userData"), "voice-recordings"),
    path.join(app.getPath("temp"), "agui-voice-recordings"),
  ];
  let lastError: unknown;
  for (const directory of directories) {
    try {
      await fs.promises.mkdir(directory, { recursive: true });
      const filePath = path.join(directory, name);
      await fs.promises.writeFile(filePath, data);
      return filePath;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Voice recording could not be saved.");
}

function voiceRecordingBuffer(payload: Record<string, unknown>): Buffer {
  const encoded = stringValue(payload.dataBase64);
  if (encoded) return Buffer.from(encoded.replace(/^data:[^,]+,/, ""), "base64");
  const value = payload.data;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Buffer.from(value);
  throw new Error("Voice recording data must be binary.");
}

function voiceRecordingMime(value: unknown): string {
  const mime = typeof value === "string" ? value.toLowerCase().trim() : "";
  if (mime && voiceRecordingMimeExtensions.has(mime)) return mime;
  if (mime.startsWith("audio/webm")) return "audio/webm";
  return "audio/webm";
}

function voiceRecordingExtension(value: unknown, mime: string): string {
  const requested = typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  if (["m4a", "mp3", "ogg", "wav", "webm"].includes(requested)) return requested;
  return voiceRecordingMimeExtensions.get(mime) ?? "webm";
}

function safeAgentTaskNotificationPayload(input: unknown): AgentTaskNotificationPayload | null {
  const source = recordValue(input);
  const sessionId = stringField(source, "sessionId").trim();
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(sessionId)) return null;
  const title = safeNotificationText(stringField(source, "title"), 120) || "Agent task";
  const body = safeNotificationText(stringField(source, "body"), 240);
  return {
    sessionId,
    title,
    ...(body ? { body } : {}),
  };
}

function safeNotificationText(value: string, maxLength: number): string {
  const clean = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 3))}...` : clean;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string {
  const field = recordValue(value)[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: unknown, key: string): number {
  const field = recordValue(value)[key];
  return typeof field === "number" ? field : Number.NaN;
}

function clampInteger(value: unknown, min: number, max: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}
