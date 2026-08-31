const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

function on(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function isMissingIpcHandler(error: unknown, channel: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`No handler registered for '${channel}'`);
}

async function chooseExtensionUpdateSource(): Promise<unknown> {
  try {
    return await ipcRenderer.invoke("agui:extensions:choose-update");
  } catch (error) {
    if (isMissingIpcHandler(error, "agui:extensions:choose-update")) {
      return ipcRenderer.invoke("agui:extensions:choose-install");
    }
    throw error;
  }
}

contextBridge.exposeInMainWorld("agentDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("agui:clipboard:write-text", text),
  },
  files: {
    getPath: (file: File) => webUtils.getPathForFile(file),
  },
  window: {
    close: () => ipcRenderer.invoke("agui:window:close"),
    openExternal: (url: string) => ipcRenderer.invoke("agui:window:open-external", url),
    openSession: (input: unknown) => ipcRenderer.invoke("agui:window:open-session", input),
    setPinned: (pinned: boolean) => ipcRenderer.invoke("agui:window:set-pinned", pinned),
    state: () => ipcRenderer.invoke("agui:window:state"),
    onState: (callback: (payload: unknown) => void) => on("agui:window:state", callback),
  },
  theme: {
    state: () => ipcRenderer.invoke("agui:theme:state"),
    setSelection: (theme: string) => ipcRenderer.invoke("agui:theme:set-selection", theme),
    setAppearance: (input: unknown) => ipcRenderer.invoke("agui:theme:set-appearance", input),
    onState: (callback: (payload: unknown) => void) => on("agui:theme:state", callback),
  },
  notifications: {
    taskCompleted: (input: unknown) =>
      ipcRenderer.invoke("agui:notifications:task-complete", input),
    consumeTaskOpens: () => ipcRenderer.invoke("agui:notifications:consume-task-opens"),
    onTaskOpen: (callback: (payload: unknown) => void) =>
      on("agui:notifications:task-open", callback),
  },
  permissions: {
    microphoneStatus: () => ipcRenderer.invoke("agui:permissions:microphone-status"),
    requestMicrophone: () => ipcRenderer.invoke("agui:permissions:request-microphone"),
    openMicrophoneSettings: () => ipcRenderer.invoke("agui:permissions:open-microphone-settings"),
  },
  voice: {
    saveRecording: (input: unknown) => ipcRenderer.invoke("agui:voice:save-recording", input),
  },
  runtimeRpc: {
    getSettings: () => ipcRenderer.invoke("agui:runtime-rpc:get-settings"),
    saveSettings: (input: unknown) => ipcRenderer.invoke("agui:runtime-rpc:save-settings", input),
  },
  providers: {
    list: () => ipcRenderer.invoke("agui:providers:list"),
    save: (provider: unknown) => ipcRenderer.invoke("agui:providers:save", provider),
    remove: (id: string) => ipcRenderer.invoke("agui:providers:remove", id),
    test: (provider: unknown) => ipcRenderer.invoke("agui:providers:test", provider),
    capabilities: (input: unknown) => ipcRenderer.invoke("agui:providers:capabilities", input),
    detect: () => ipcRenderer.invoke("agui:providers:detect"),
  },
  workspace: {
    choose: (initialPath?: string) => ipcRenderer.invoke("agui:workspace:choose", initialPath),
    getDefault: () => ipcRenderer.invoke("agui:workspace:default"),
    listDirectories: (input?: unknown) =>
      ipcRenderer.invoke("agui:workspace:list-directories", input),
    privateRoot: () => ipcRenderer.invoke("agui:workspace:private-root"),
    privateSession: (input: unknown) => ipcRenderer.invoke("agui:workspace:private-session", input),
  },
  mcpGateway: {
    getSettings: (input?: unknown) => ipcRenderer.invoke("agui:mcp-gateway:get-settings", input),
    refresh: (input?: unknown) => ipcRenderer.invoke("agui:mcp-gateway:refresh", input),
    removeServer: (input: unknown) => ipcRenderer.invoke("agui:mcp-gateway:remove-server", input),
    saveServer: (input: unknown) => ipcRenderer.invoke("agui:mcp-gateway:save-server", input),
    setEnabled: (input: unknown) => ipcRenderer.invoke("agui:mcp-gateway:set-enabled", input),
    setLlm: (input: unknown) => ipcRenderer.invoke("agui:mcp-gateway:set-llm", input),
  },
  browserWorkflows: {
    list: () => ipcRenderer.invoke("agui:browser-workflows:list"),
    get: (input: unknown) => ipcRenderer.invoke("agui:browser-workflows:get", input),
    save: (input: unknown) => ipcRenderer.invoke("agui:browser-workflows:save", input),
    remove: (input: unknown) => ipcRenderer.invoke("agui:browser-workflows:remove", input),
    generateFromAnnotations: (input: unknown) =>
      ipcRenderer.invoke("agui:browser-workflows:generate-from-annotations", input),
  },
  scheduledTasks: {
    list: () => ipcRenderer.invoke("agui:scheduled-tasks:list"),
    add: (input: unknown) => ipcRenderer.invoke("agui:scheduled-tasks:add", input),
    update: (input: unknown) => ipcRenderer.invoke("agui:scheduled-tasks:update", input),
    remove: (input: unknown) => ipcRenderer.invoke("agui:scheduled-tasks:remove", input),
    setEnabled: (input: unknown) => ipcRenderer.invoke("agui:scheduled-tasks:set-enabled", input),
    runNow: (input: unknown) => ipcRenderer.invoke("agui:scheduled-tasks:run-now", input),
  },
  storage: {
    get: (input: unknown) => ipcRenderer.invoke("agui:storage:get", input),
    set: (input: unknown) => ipcRenderer.invoke("agui:storage:set", input),
    remove: (input: unknown) => ipcRenderer.invoke("agui:storage:remove", input),
    list: (input?: unknown) => ipcRenderer.invoke("agui:storage:list", input),
  },
  sessions: {
    run: (input: unknown) => ipcRenderer.invoke("agui:asp:run", input),
    cancel: (uiSessionId: string) => ipcRenderer.invoke("agui:asp:cancel", uiSessionId),
    list: (input: unknown) => ipcRenderer.invoke("agui:asp:list-sessions", input),
    messages: (input: unknown) => ipcRenderer.invoke("agui:asp:session-messages", input),
    resume: (input: unknown) => ipcRenderer.invoke("agui:asp:resume-session", input),
    hydrateTranscript: (input: unknown) => ipcRenderer.invoke("agui:asp:hydrate-transcript", input),
    delete: (input: unknown) => ipcRenderer.invoke("agui:asp:delete-session", input),
    invokeExtension: (input: unknown) => ipcRenderer.invoke("agui:asp:extension-invoke", input),
  },
  terminal: {
    run: (input: unknown) => ipcRenderer.invoke("agui:terminal:run", input),
    exec: (input: unknown) => ipcRenderer.invoke("agui:terminal:exec", input),
    cancel: (id: string) => ipcRenderer.invoke("agui:terminal:cancel", id),
    create: (input: unknown) => ipcRenderer.invoke("agui:terminal:create", input),
    write: (input: unknown) => ipcRenderer.invoke("agui:terminal:write", input),
    resize: (input: unknown) => ipcRenderer.invoke("agui:terminal:resize", input),
    dispose: (id: string) => ipcRenderer.invoke("agui:terminal:dispose", id),
  },
  browser: {
    create: (input: unknown) => ipcRenderer.invoke("agui:browser:create", input),
    register: (input: unknown) => ipcRenderer.invoke("agui:browser:register", input),
    unregister: (id: string) => ipcRenderer.invoke("agui:browser:unregister", id),
    setBounds: (input: unknown) => ipcRenderer.invoke("agui:browser:set-bounds", input),
    releaseFocus: () => ipcRenderer.invoke("agui:browser:release-focus"),
    list: () => ipcRenderer.invoke("agui:browser:list"),
    navigate: (input: unknown) => ipcRenderer.invoke("agui:browser:navigate", input),
    reload: (input: unknown) => ipcRenderer.invoke("agui:browser:reload", input),
    stop: (input: unknown) => ipcRenderer.invoke("agui:browser:stop", input),
    goBack: (input: unknown) => ipcRenderer.invoke("agui:browser:go-back", input),
    goForward: (input: unknown) => ipcRenderer.invoke("agui:browser:go-forward", input),
    evaluate: (input: unknown) => ipcRenderer.invoke("agui:browser:evaluate", input),
    click: (input: unknown) => ipcRenderer.invoke("agui:browser:click", input),
    type: (input: unknown) => ipcRenderer.invoke("agui:browser:type", input),
    snapshot: (input: unknown) => ipcRenderer.invoke("agui:browser:snapshot", input),
    screenshot: (input: unknown) => ipcRenderer.invoke("agui:browser:screenshot", input),
    setAnnotationMode: (input: unknown) =>
      ipcRenderer.invoke("agui:browser:set-annotation-mode", input),
    setWorkflowRecordingMode: (input: unknown) =>
      ipcRenderer.invoke("agui:browser:set-workflow-recording-mode", input),
    listAnnotations: (input: unknown) => ipcRenderer.invoke("agui:browser:list-annotations", input),
    clearAnnotations: (input: unknown) =>
      ipcRenderer.invoke("agui:browser:clear-annotations", input),
    addAnnotation: (input: unknown) => ipcRenderer.invoke("agui:browser:add-annotation", input),
    deleteAnnotation: (input: unknown) =>
      ipcRenderer.invoke("agui:browser:delete-annotation", input),
    inspectElement: (input: unknown) => ipcRenderer.invoke("agui:browser:inspect-element", input),
    cdpCommand: (input: unknown) => ipcRenderer.invoke("agui:browser:cdp-command", input),
    cdpStartCapture: (input: unknown) =>
      ipcRenderer.invoke("agui:browser:cdp-start-capture", input),
    cdpEvents: (input: unknown) => ipcRenderer.invoke("agui:browser:cdp-events", input),
    cdpStopCapture: (input: unknown) => ipcRenderer.invoke("agui:browser:cdp-stop-capture", input),
    screencastStart: (input: unknown) => ipcRenderer.invoke("agui:browser:screencast-start", input),
    screencastAck: (input: unknown) => ipcRenderer.invoke("agui:browser:screencast-ack", input),
    screencastStop: (input: unknown) => ipcRenderer.invoke("agui:browser:screencast-stop", input),
    dispatchMouse: (input: unknown) => ipcRenderer.invoke("agui:browser:dispatch-mouse", input),
    dispatchKey: (input: unknown) => ipcRenderer.invoke("agui:browser:dispatch-key", input),
    insertText: (input: unknown) => ipcRenderer.invoke("agui:browser:insert-text", input),
  },
  interactiveApp: {
    create: (input: unknown) => ipcRenderer.invoke("agui:interactive-app:create", input),
    destroy: (id: string) => ipcRenderer.invoke("agui:interactive-app:destroy", id),
    setBounds: (input: unknown) => ipcRenderer.invoke("agui:interactive-app:set-bounds", input),
    postMessage: (input: unknown) => ipcRenderer.invoke("agui:interactive-app:post-message", input),
    onEvent: (callback: (payload: unknown) => void) => on("agui:interactive-app:event", callback),
  },
  ide: {
    tree: (input: unknown) => ipcRenderer.invoke("agui:ide:tree", input),
    readFile: (input: unknown) => ipcRenderer.invoke("agui:ide:read-file", input),
    writeFile: (input: unknown) => ipcRenderer.invoke("agui:ide:write-file", input),
    diagnostics: (input: unknown) => ipcRenderer.invoke("agui:ide:diagnostics", input),
    workspaceDiagnostics: (input: unknown) =>
      ipcRenderer.invoke("agui:ide:workspace-diagnostics", input),
    semanticTokens: (input: unknown) => ipcRenderer.invoke("agui:ide:semantic-tokens", input),
  },
  extensions: {
    list: (input?: unknown) => ipcRenderer.invoke("agui:extensions:list", input),
    audit: (input?: unknown) => ipcRenderer.invoke("agui:extensions:audit", input),
    chooseInstallSource: () => ipcRenderer.invoke("agui:extensions:choose-install"),
    chooseUpdateSource: chooseExtensionUpdateSource,
    install: (input: unknown) => ipcRenderer.invoke("agui:extensions:install", input),
    marketplace: (input?: unknown) => ipcRenderer.invoke("agui:extensions:marketplace", input),
    update: (input: unknown) => ipcRenderer.invoke("agui:extensions:update", input),
    uninstall: (input: unknown) => ipcRenderer.invoke("agui:extensions:uninstall", input),
    setEnabled: (input: unknown) => ipcRenderer.invoke("agui:extensions:set-enabled", input),
    grant: (input: unknown) => ipcRenderer.invoke("agui:extensions:grant", input),
    setWorkspaceTrust: (input: unknown) =>
      ipcRenderer.invoke("agui:extensions:set-workspace-trust", input),
    workspaceTrusted: (input: unknown) =>
      ipcRenderer.invoke("agui:extensions:workspace-trusted", input),
    readAsset: (input: unknown) => ipcRenderer.invoke("agui:extensions:read-asset", input),
    activate: (input: unknown) => ipcRenderer.invoke("agui:extensions:activate", input),
    executeCommand: (input: unknown) =>
      ipcRenderer.invoke("agui:extensions:execute-command", input),
    resolveAgentContributions: (input: unknown) =>
      ipcRenderer.invoke("agui:extensions:resolve-agent", input),
    getConfiguration: (input: unknown) =>
      ipcRenderer.invoke("agui:extensions:get-configuration", input),
    updateConfiguration: (input: unknown) =>
      ipcRenderer.invoke("agui:extensions:update-configuration", input),
  },
  interactions: {
    pending: () => ipcRenderer.invoke("agui:asp:pending-interactions"),
    respondApproval: (input: unknown) => ipcRenderer.invoke("agui:asp:approval-response", input),
    respondQuestion: (input: unknown) => ipcRenderer.invoke("agui:asp:question-response", input),
  },
  panel: {
    syncState: (input: unknown) => ipcRenderer.invoke("agui:panel:sync-state", input),
    syncIdeState: (input: unknown) => ipcRenderer.invoke("agui:panel:sync-ide-state", input),
    onCommand: (callback: (payload: unknown) => void) => on("agui:panel:command", callback),
  },
  onSessionEvent: (callback: (payload: unknown) => void) => on("agui:asp:event", callback),
  onTerminalEvent: (callback: (payload: unknown) => void) => on("agui:terminal:event", callback),
  onBrowserEvent: (callback: (payload: unknown) => void) => on("agui:browser:event", callback),
  onApprovalRequest: (callback: (payload: unknown) => void) => on("agui:asp:approval", callback),
  onQuestionRequest: (callback: (payload: unknown) => void) => on("agui:asp:question", callback),
  onExtensionEvent: (callback: (payload: unknown) => void) => on("agui:extensions:event", callback),
  onScheduledTaskEvent: (callback: (payload: unknown) => void) =>
    on("agui:schedule:event", callback),
});
