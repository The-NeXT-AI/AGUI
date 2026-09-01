import type {
  ApprovalMode,
  ApprovalRequestPayload,
  AspApprovalDecision,
  AspExtensionInvokeInput,
  AspExtensionInvokeResult,
  AspMessageRecord,
  AspProvider,
  AspProviderSession,
  AspQuestionResponse,
  AspReasoningEffort,
  AspRunSpeed,
  AspTokenUsage,
  DesktopSessionEvent,
  ProviderTestResult,
  QuestionRequestPayload,
  RunInput,
  RunResult,
} from "@the-next-ai/asp/types";
import type {
  AppExtensionRecord,
  ExtensionAuditListInput,
  ExtensionAuditRecord,
  ExtensionActivateInput,
  ExtensionAssetInput,
  ExtensionAssetResult,
  ExtensionCommandInput,
  ExtensionConfigurationInput,
  ExtensionConfigurationResult,
  ExtensionConfigurationUpdateInput,
  ExtensionEnableInput,
  ExtensionGrantInput,
  ExtensionInstallInput,
  ExtensionListInput,
  ExtensionMarketplaceListInput,
  ExtensionMarketplaceResult,
  ExtensionRuntimeEvent,
  ExtensionUninstallInput,
  ExtensionUpdateInput,
  ExtensionWorkspaceTrustInput,
  ResolveAgentContributionsInput,
  ResolvedAgentContributions,
} from "@the-next-ai/extensions";
import { t } from "@/lib/i18n";
import { alertDialog } from "@/ui/confirm-dialog";

export type {
  AppExtensionManifest,
  AppExtensionPermission,
  AppExtensionRecord,
  AppExtensionSecuritySummary,
  ExtensionAuditListInput,
  ExtensionAuditRecord,
  ExtensionAssetResult,
  ExtensionChatRendererContribution,
  ExtensionConfigurationProperty,
  ExtensionConfigurationResult,
  ExtensionConfigurationUpdateInput,
  ExtensionDeclarativeNode,
  ExtensionFloatingWidgetContribution,
  ExtensionFloatingWidgetPosition,
  ExtensionLocalizedContribution,
  ExtensionLocalizationBundle,
  ExtensionMenuContribution,
  ExtensionMenusContribution,
  ExtensionMarketplaceItem,
  ExtensionMarketplaceListInput,
  ExtensionMarketplaceResult,
  ExtensionToolbarControlContribution,
  ExtensionRuntimeEvent,
  ExtensionSessionTreeContribution,
  ExtensionSessionTreeNodeContribution,
  ExtensionSessionTreeSessionContribution,
  ExtensionStyleContribution,
  ExtensionThemeContribution,
  ExtensionThemeDefinition,
  ExtensionUiRenderMode,
  ExtensionUpdateInput,
  ExtensionViewContribution,
  ExtensionViewsContainerContribution,
  ExtensionViewsContainersContribution,
  ResolvedAgentContributions,
  ResolvedExtensionMcpServer,
  ResolvedExtensionPrompt,
  ResolvedExtensionSkill,
  ResolveAgentContributionsInput,
} from "@the-next-ai/extensions";

export type {
  ApprovalRequestPayload,
  AspApprovalDecision,
  AspAgentProfile,
  AspAttachment,
  AspExtensionDescriptor,
  AspExtensionEvent,
  AspExtensionFallback,
  AspExtensionInvokeInput,
  AspExtensionInvokeResult,
  AspExtensionUse,
  AspInputPart,
  AspMessagePart,
  AspMessagePartType,
  AspMessageRecord,
  AspConversationArtifact,
  AspConversationContext,
  AspConversationFile,
  AspConversationContextMessage,
  AspModel,
  AspProvider,
  AspProviderCapabilities,
  AspProviderSession,
  AspProviderTransport,
  AspQuestion,
  AspQuestionAnswer,
  AspQuestionOption,
  AspQuestionResponse,
  AspReasoningEffort,
  AspRunSpeed,
  AspSkillRef,
  AspRunEvent,
  AspPermissionPolicy,
  AspPermissionRule,
  AspSlashCommand,
  AspSessionState,
  AspTokenUsage,
  AspToolEvent,
  AspToolSemantic,
  DesktopSessionEvent,
  ProviderTestResult,
  QuestionRequestPayload,
  RunInput,
  RunResult,
} from "@the-next-ai/asp/types";

export type TerminalRunEvent =
  | { id: string; type: "ready" }
  | { id: string; type: "stdin"; data: string }
  | { id: string; type: "stdout"; chunk: string }
  | { id: string; type: "stderr"; chunk: string }
  | {
      id: string;
      type: "exit";
      status: "success" | "error";
      code: number | null;
      signal: string | null;
      message?: string;
    };

export type DetailPanelRuntimeState = {
  activeDetailPanelId?: string | null;
  activeDetailPanelTabId?: string | null;
  detailPanelOpen: boolean;
  panels: Array<{
    allowMultiple?: boolean;
    id: string;
    order?: number;
    title: string;
  }>;
  project?: {
    root?: string;
    workspaceId?: string;
  };
  tabs: Array<{
    active?: boolean;
    createdAt?: number;
    id: string;
    ordinal?: number;
    panelId: string;
    title?: string;
  }>;
  updatedAt?: number;
};

export type IdePanelRuntimeState = {
  activeContent?: string;
  activePath?: string | null;
  root?: string;
  tabs: Array<{
    diagnostics?: IdeDiagnostic[];
    diagnosticsLoading?: boolean;
    dirty?: boolean;
    error?: string;
    language?: string;
    mtimeMs?: number;
    name?: string;
    path: string;
  }>;
  updatedAt?: number;
};

export type DetailPanelRuntimeCommand =
  | { type: "panel.open"; allowMultiple?: boolean; panelId: string }
  | { type: "panel.selectTab"; tabId: string }
  | { type: "panel.closeTab"; tabId: string }
  | { type: "panel.setOpen"; open: boolean }
  | { type: "ide.openFile"; filePath: string; root?: string };

export type IdeFileTreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: IdeFileTreeNode[];
};

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
};

export type WorkspaceDirectoryListing = {
  entries: WorkspaceDirectoryEntry[];
  parentPath: string | null;
  path: string;
  roots: WorkspaceDirectoryEntry[];
};

export type IdeFileReadResult = {
  path: string;
  name: string;
  content: string;
  language: string;
  mtimeMs: number;
};

export type IdeDiagnostic = {
  filePath: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string;
  code?: string;
  start: number;
  length: number;
  line: number;
  column: number;
};

export type IdeSemanticTokensResult = {
  data: number[];
};

export type BrowserTargetRecord = {
  id: string;
  webContentsId: number;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  updatedAt: number;
};

export type BrowserViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
};

export type BrowserWorkflowPageEvent = {
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

export type BrowserEvent =
  | {
      id: string;
      type: "updated";
      target: BrowserTargetRecord;
    }
  | {
      id: string;
      type: "failed";
      target?: BrowserTargetRecord;
      error: string;
      url?: string;
    }
  | {
      id: string;
      type: "destroyed";
    }
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
  | {
      id: string;
      type: "annotationTool";
      action: "snapshot" | "undo" | "clear";
    }
  | {
      id: string;
      type: "workflowEvent";
      event: BrowserWorkflowPageEvent;
    };

export type InteractiveAppViewRecord = {
  id: string;
  webContentsId: number;
};

export type InteractiveAppEvent =
  | { id: string; type: "message"; message: unknown }
  | { id: string; type: "failed"; error: string }
  | { id: string; type: "gone"; exitCode: number; reason: string }
  | { id: string; type: "destroyed" };

export type BrowserAutomationResult = {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
};

export type BrowserEvaluateResult = {
  type: string;
  value?: unknown;
  description?: string;
};

export type BrowserSnapshotResult = {
  id: string;
  url: string;
  title: string;
  text: string;
  html: string;
};

export type BrowserScreenshotResult = {
  id: string;
  mimeType: "image/png" | "image/jpeg";
  data: string;
};

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserViewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
};

export type BrowserAnnotation = {
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

export type BrowserElementInspection = {
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

export type BrowserCdpEventRecord = {
  method: string;
  params?: unknown;
  timestamp: number;
};

export type McpGatewayAuthConfig =
  | { type: "api-key"; headerName?: string; value: string }
  | { type: "basic"; password: string; username: string }
  | { type: "bearer"; token: string }
  | { type: "none" };

export type McpGatewayServerConfig = {
  args?: string[];
  authentication?: McpGatewayAuthConfig;
  command?: string;
  enabled: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  id: string;
  label?: string;
  type?: "http" | "sse" | "stdio";
  url?: string;
};

export type McpGatewayToolView = {
  toolName: string;
  title: string;
  description: string;
  remoteToolName: string;
  status: "offline" | "online" | "unknown";
};

export type McpGatewayServerView = {
  error?: string;
  extensionId?: string;
  id: string;
  label?: string;
  namespace?: string;
  readOnly?: boolean;
  source?: string;
  status: "offline" | "online" | "unknown";
  toolCount: number;
  tools: McpGatewayToolView[];
  type: "http" | "sse" | "stdio" | "provider";
};

export type McpGatewayManagedServer = McpGatewayServerConfig & {
  error?: string;
  extensionId?: string;
  namespace?: string;
  readOnly?: boolean;
  source?: string;
  status?: "offline" | "online" | "unknown";
  toolCount?: number;
  tools?: McpGatewayToolView[];
};

export type McpGatewayScopeInput = {
  workspacePath?: string;
  workspaceId?: string;
};

export type McpGatewayLlmSettings = {
  apiKey?: string;
  baseUrl?: string;
  enabled: boolean;
  model?: string;
};

export type McpGatewaySettings = {
  enabled: boolean;
  llm: McpGatewayLlmSettings;
  runtime?: {
    endpoint?: string | null;
    error?: string | null;
    nativeProviders?: string[];
    resolveModelReady?: boolean;
    transport?: "stdio" | null;
  };
  servers: McpGatewayManagedServer[];
  summary?: {
    offlineServerCount: number;
    onlineServerCount: number;
    serverCount: number;
    toolCount: number;
    unknownServerCount: number;
  };
};

export type BrowserWorkflowStep = {
  clearFirst?: boolean;
  input?: string;
  note?: string;
  rect?: BrowserRect;
  saveAs?: string;
  selector?: string;
  text?: string;
  textContains?: string;
  timeoutMs?: number;
  type: "assert" | "click" | "navigate" | "snapshot" | "submit" | "type" | "waitFor";
  url?: string;
  urlIncludes?: string;
  waitAfterMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "none";
  x?: number;
  y?: number;
};

export type BrowserWorkflowDefinition = {
  createdAt: number;
  description: string;
  enabled: boolean;
  id: string;
  inputSchema: Record<string, unknown>;
  requireConfirmation: boolean;
  sideEffect: boolean;
  steps: BrowserWorkflowStep[];
  tags: string[];
  title: string;
  toolName: string;
  updatedAt: number;
  version: 1;
};

export type BrowserWorkflowSaveInput = Partial<
  Omit<BrowserWorkflowDefinition, "createdAt" | "toolName" | "updatedAt" | "version">
> & {
  createdAt?: number;
  toolName?: string;
  updatedAt?: number;
};

export type PersistentStorageRecord = {
  key: string;
  namespace: string;
  updatedAt: number;
  value: string;
};

export type RuntimeTransport = "electron" | "websocket";

export type DetectedAgentCli = {
  command: string;
  error?: string;
  id: string;
  name: string;
  path: string;
  version?: string;
};

export type RuntimeRpcSettings = {
  disabledByEnvironment: boolean;
  enabled: boolean;
  error: string | null;
  host: string;
  port: number;
  rpcUrl: string | null;
  running: boolean;
  settingsPath: string;
  token: string;
  webUrl: string | null;
};

export type RuntimeRpcSettingsInput = {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
};

export type DesktopWindowState = {
  isFullScreen: boolean;
  mode: "standard" | "compact";
  pinned: boolean;
};

export type DesktopThemeState = {
  appearance: "dark" | "light";
  theme: string;
};

export type AgentTaskNotificationInput = {
  sessionId: string;
  title: string;
  body?: string;
};

export type AgentTaskNotificationOpen = {
  sessionId: string;
  at: number;
};

export type ScheduledTaskFrequency = "once" | "daily" | "weekly" | "interval";

export type ScheduledTaskSchedule =
  | {
      type: "once";
      date: string;
      time: string;
    }
  | {
      type: "daily";
      time: string;
    }
  | {
      type: "weekly";
      weekdays: number[];
      time: string;
    }
  | {
      type: "interval";
      intervalMinutes: number;
    };

export type ScheduledTaskRetryPolicy = {
  backoffMinutes: number;
  maxRetries: number;
};

export type ScheduledTaskRunStatus = "running" | "success" | "failed" | "canceled";

export type ScheduledTaskRunReason = "scheduled" | "manual" | "retry" | "catch_up";

export type ScheduledTaskRunHistoryEntry = {
  attempt: number;
  error?: string;
  finishedAt?: number;
  id: string;
  nextRetryAt?: number;
  providerSessionId?: string;
  reason: ScheduledTaskRunReason;
  scheduledFor?: number;
  sessionId: string;
  startedAt: number;
  status: ScheduledTaskRunStatus;
};

export type ScheduledTaskPendingRetry = {
  attempt: number;
  reason: Exclude<ScheduledTaskRunReason, "manual" | "retry">;
  resumeNextRunAt: number | null;
  scheduledFor?: number;
};

export type ScheduledTaskInput = {
  approvalMode?: ApprovalMode;
  cwd?: string | null;
  effort?: AspReasoningEffort;
  enabled: boolean;
  model?: string;
  projectPath: string | null;
  prompt: string;
  providerId: string;
  retryPolicy?: ScheduledTaskRetryPolicy;
  schedule: ScheduledTaskSchedule;
  speed?: AspRunSpeed;
  title: string;
  workspaceId?: string;
};

export type ScheduledTask = Required<
  Pick<ScheduledTaskInput, "approvalMode" | "retryPolicy" | "workspaceId">
> &
  Omit<ScheduledTaskInput, "approvalMode" | "retryPolicy" | "workspaceId"> & {
    createdAt: number;
    failureCount: number;
    id: string;
    lastFinishedAt?: number;
    lastProviderSessionId?: string;
    lastRunAt?: number;
    lastRunError?: string;
    lastRunStatus?: ScheduledTaskRunStatus;
    lastSessionId?: string;
    missedRunCount: number;
    nextRunAt: number | null;
    pendingRetry?: ScheduledTaskPendingRetry;
    runCount: number;
    runHistory: ScheduledTaskRunHistoryEntry[];
    updatedAt: number;
  };

export type ScheduledTaskRunResult = {
  sessionId: string;
};

export type ScheduledTaskEvent =
  | {
      at: number;
      cwd: string;
      session: {
        createdAt: number;
        cwd: string;
        id: string;
        projectPath: string | null;
        providerId: string;
        title: string;
        workspaceId: string;
      };
      sessionId: string;
      task: ScheduledTask;
      taskId: string;
      type: "run_started";
    }
  | {
      at: number;
      canceled?: boolean;
      error?: string;
      providerSessionId?: string;
      sessionId: string;
      success: boolean;
      task?: ScheduledTask;
      taskId: string;
      type: "run_finished";
    }
  | {
      at: number;
      tasks: ScheduledTask[];
      type: "tasks_updated";
    };

export type MicrophonePermissionResult = {
  granted: boolean;
  platform: string;
  previousStatus?: "denied" | "granted" | "not-determined" | "restricted" | "unknown";
  status: "denied" | "granted" | "not-determined" | "restricted" | "unknown";
};

export type TranscriptHydrationInput = {
  cwd: string;
  previousContextUsage?: {
    used: number;
    usedKnown?: boolean;
    size: number;
    source?: string;
    cost?: { amount: number; currency: string } | null;
  };
  providerId: string;
  providerSessionId: string;
  providers?: AspProvider[];
  transcriptPath?: string;
};

export type TranscriptHydrationProjection = {
  blocks: unknown[];
  contextUsage?: {
    used: number;
    usedKnown?: boolean;
    size: number;
    source?: string;
    cost?: { amount: number; currency: string } | null;
  };
  providerSessionId?: string;
  sessionState?: Record<string, unknown>;
  title?: string;
  usage?: { input: number; output: number };
};

export type AgentRuntimeApi = {
  transport: RuntimeTransport;
  features: {
    filePathAccess: boolean;
    nativeDialogs: boolean;
    webview: boolean;
    webContentsView: boolean;
    browserAutomation: boolean;
    browserScreencast?: boolean;
  };
  platform: string;
  versions: { electron?: string; chrome?: string };
  clipboard?: {
    writeText(text: string): Promise<boolean>;
  };
  window?: {
    close(): Promise<boolean>;
    openExternal(url: string): Promise<boolean>;
    openSession(input: { sessionId: string; mode?: "standard" | "compact" }): Promise<boolean>;
    setPinned(pinned: boolean): Promise<DesktopWindowState>;
    state(): Promise<DesktopWindowState>;
    onState(callback: (payload: DesktopWindowState) => void): () => void;
  };
  theme?: {
    state(): Promise<DesktopThemeState | null>;
    setSelection(theme: string): Promise<DesktopThemeState>;
    setAppearance(input: DesktopThemeState): Promise<DesktopThemeState | null>;
    onState(callback: (payload: DesktopThemeState) => void): () => void;
  };
  notifications?: {
    taskCompleted(input: AgentTaskNotificationInput): Promise<boolean>;
    consumeTaskOpens(): Promise<AgentTaskNotificationOpen[]>;
    onTaskOpen(callback: (payload: AgentTaskNotificationOpen) => void): () => void;
  };
  permissions?: {
    microphoneStatus(): Promise<MicrophonePermissionResult>;
    requestMicrophone(): Promise<MicrophonePermissionResult>;
    openMicrophoneSettings(): Promise<boolean>;
  };
  voice?: {
    saveRecording(input: VoiceRecordingSaveInput): Promise<VoiceRecordingSaveResult>;
  };
  runtimeRpc?: {
    getSettings(): Promise<RuntimeRpcSettings>;
    saveSettings(input: RuntimeRpcSettingsInput): Promise<RuntimeRpcSettings>;
  };
  files: {
    getPath(file: File): string;
  };
  providers: {
    list(): Promise<AspProvider[]>;
    save(provider: AspProvider): Promise<AspProvider>;
    remove(id: string): Promise<boolean>;
    test(provider: AspProvider): Promise<ProviderTestResult>;
    capabilities(input: { providerId: string; cwd: string }): Promise<ProviderTestResult>;
    detect(): Promise<DetectedAgentCli[]>;
  };
  workspace: {
    choose(initialPath?: string): Promise<string | null>;
    getDefault(): Promise<string>;
    listDirectories(input?: { path?: string }): Promise<WorkspaceDirectoryListing>;
    privateRoot(): Promise<string>;
    privateSession(input: { sessionId: string; createdAt?: number }): Promise<string>;
  };
  mcpGateway: {
    getSettings(input?: McpGatewayScopeInput): Promise<McpGatewaySettings>;
    refresh(input?: McpGatewayScopeInput): Promise<McpGatewaySettings>;
    removeServer(input: { id: string } & McpGatewayScopeInput): Promise<McpGatewaySettings>;
    saveServer(input: McpGatewayServerConfig & McpGatewayScopeInput): Promise<McpGatewaySettings>;
    setEnabled(input: { enabled: boolean } & McpGatewayScopeInput): Promise<McpGatewaySettings>;
    setLlm(input: McpGatewayLlmSettings & McpGatewayScopeInput): Promise<McpGatewaySettings>;
  };
  browserWorkflows?: {
    generateFromAnnotations(input: {
      browserId?: string;
      description?: string;
      id?: string;
      save?: boolean;
      title?: string;
    }): Promise<BrowserWorkflowDefinition>;
    get(input: { id?: string; toolName?: string }): Promise<BrowserWorkflowDefinition | null>;
    list(): Promise<BrowserWorkflowDefinition[]>;
    remove(input: { id?: string; toolName?: string }): Promise<boolean>;
    save(input: BrowserWorkflowSaveInput): Promise<BrowserWorkflowDefinition>;
  };
  scheduledTasks: {
    list(): Promise<ScheduledTask[]>;
    add(input: ScheduledTaskInput): Promise<ScheduledTask>;
    update(input: { id: string; task: ScheduledTaskInput }): Promise<ScheduledTask>;
    remove(input: { id: string }): Promise<boolean>;
    setEnabled(input: { enabled: boolean; id: string }): Promise<ScheduledTask>;
    runNow(input: { id: string }): Promise<ScheduledTaskRunResult>;
  };
  storage: {
    get(input: { key: string; namespace?: string }): Promise<string | null>;
    set(input: { key: string; namespace?: string; value: string }): Promise<boolean>;
    remove(input: { key: string; namespace?: string }): Promise<boolean>;
    list(input?: { namespace?: string; prefix?: string }): Promise<PersistentStorageRecord[]>;
  };
  sessions: {
    run(input: RunInput): Promise<RunResult>;
    cancel(uiSessionId: string): Promise<boolean>;
    cleanupHandoffFiles(uiSessionId: string): Promise<boolean>;
    list(input: { providerId: string; cwd: string }): Promise<AspProviderSession[]>;
    create(input: { providerId: string; cwd: string; title?: string }): Promise<AspProviderSession>;
    close(input: { providerId: string; providerSessionId: string; cwd: string }): Promise<boolean>;
    messages(input: { providerId: string; providerSessionId: string }): Promise<AspMessageRecord[]>;
    usage(input: {
      providerId: string;
      providerSessionId: string;
    }): Promise<AspTokenUsage | undefined>;
    resume(input: {
      providerId: string;
      providerSessionId: string;
      cwd: string;
    }): Promise<{ session?: AspProviderSession; messages: AspMessageRecord[] }>;
    hydrateTranscript(input: TranscriptHydrationInput): Promise<TranscriptHydrationProjection>;
    delete(input: {
      providerId: string;
      providerSessionId: string;
      transcriptPath?: string;
      cwd: string;
    }): Promise<boolean>;
    invokeExtension(input: AspExtensionInvokeInput): Promise<AspExtensionInvokeResult>;
  };
  terminal: {
    run(input: { id: string; command: string; cwd?: string }): Promise<{ id: string }>;
    exec(input: {
      id: string;
      command: string;
      args?: string[];
      cwd?: string;
    }): Promise<{ id: string }>;
    cancel(id: string): Promise<boolean>;
    create(input: { id: string; cwd?: string }): Promise<{ id: string }>;
    write(input: { id: string; data: string }): Promise<boolean>;
    resize(input: { id: string; cols: number; rows: number }): Promise<boolean>;
    dispose(id: string): Promise<boolean>;
  };
  browser: {
    create(input: {
      id: string;
      url?: string;
      bounds?: BrowserViewBounds;
      title?: string;
    }): Promise<BrowserTargetRecord>;
    register(input: {
      id: string;
      webContentsId: number;
      title?: string;
      url?: string;
    }): Promise<BrowserTargetRecord>;
    unregister(id: string): Promise<boolean>;
    setBounds(input: { id: string; bounds: BrowserViewBounds }): Promise<BrowserTargetRecord>;
    releaseFocus(): Promise<boolean>;
    list(): Promise<BrowserTargetRecord[]>;
    navigate(input: {
      id?: string;
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "none";
      timeoutMs?: number;
    }): Promise<BrowserAutomationResult>;
    reload(input?: {
      id?: string;
      waitUntil?: "load" | "domcontentloaded" | "none";
      timeoutMs?: number;
    }): Promise<BrowserAutomationResult>;
    stop(input?: { id?: string }): Promise<BrowserAutomationResult>;
    goBack(input?: { id?: string }): Promise<BrowserAutomationResult>;
    goForward(input?: { id?: string }): Promise<BrowserAutomationResult>;
    evaluate(input: {
      id?: string;
      expression: string;
      awaitPromise?: boolean;
    }): Promise<BrowserEvaluateResult>;
    click(input: {
      id?: string;
      selector?: string;
      x?: number;
      y?: number;
    }): Promise<BrowserAutomationResult>;
    type(input: { id?: string; selector?: string; text: string }): Promise<BrowserAutomationResult>;
    snapshot(input?: { id?: string }): Promise<BrowserSnapshotResult>;
    screenshot(input?: {
      id?: string;
      format?: "png" | "jpeg";
      quality?: number;
    }): Promise<BrowserScreenshotResult>;
    setAnnotationMode(input: {
      id?: string;
      enabled: boolean;
    }): Promise<{ id: string; enabled: boolean; annotationCount: number }>;
    setWorkflowRecordingMode(input: {
      id?: string;
      enabled: boolean;
    }): Promise<{ id: string; enabled: boolean }>;
    listAnnotations(input?: { id?: string }): Promise<{
      id: string;
      annotations: BrowserAnnotation[];
    }>;
    clearAnnotations(input?: { id?: string }): Promise<{ id: string; annotationCount: number }>;
    addAnnotation(input: {
      id?: string;
      annotationId?: string;
      type?: "element" | "region";
      note: string;
      selector?: string;
      rect?: Partial<BrowserRect>;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }): Promise<{ id: string; annotation: BrowserAnnotation; annotationCount: number }>;
    deleteAnnotation(input: {
      id?: string;
      annotationId: string;
    }): Promise<{ id: string; deleted: boolean; annotationCount: number }>;
    inspectElement(input: {
      id?: string;
      selector?: string;
      x?: number;
      y?: number;
    }): Promise<{ id: string; element: BrowserElementInspection | null }>;
    cdpCommand(input: {
      id?: string;
      method: string;
      params?: Record<string, unknown>;
    }): Promise<{ id: string; method: string; result: unknown }>;
    cdpStartCapture(input?: {
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
    }>;
    cdpEvents(input?: {
      id?: string;
      methods?: string[];
      methodPrefix?: string;
      limit?: number;
      clear?: boolean;
    }): Promise<{ id: string; recording: boolean; events: BrowserCdpEventRecord[] }>;
    cdpStopCapture(input?: { id?: string }): Promise<{ id: string; recording: boolean }>;
    screencastStart(input?: {
      id?: string;
      format?: "png" | "jpeg";
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
    }>;
    screencastAck(input: { id?: string; sessionId: number }): Promise<{
      id: string;
      acknowledged: boolean;
    }>;
    screencastStop(input?: { id?: string }): Promise<{ id: string; running: boolean }>;
    dispatchMouse(input: {
      id?: string;
      type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right" | "back" | "forward";
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }): Promise<BrowserAutomationResult>;
    dispatchKey(input: {
      id?: string;
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key?: string;
      code?: string;
      text?: string;
      unmodifiedText?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      autoRepeat?: boolean;
      isKeypad?: boolean;
      modifiers?: number;
    }): Promise<BrowserAutomationResult>;
    insertText(input: { id?: string; text: string }): Promise<BrowserAutomationResult>;
  };
  interactiveApp?: {
    create(input: {
      id: string;
      bridge?: boolean;
      html?: string;
      url?: string;
      bounds?: BrowserViewBounds;
      bridgeScript?: string;
      title?: string;
      userAgent?: string;
      userStyle?: string;
    }): Promise<InteractiveAppViewRecord>;
    destroy(id: string): Promise<boolean>;
    setBounds(input: { id: string; bounds: BrowserViewBounds }): Promise<InteractiveAppViewRecord>;
    postMessage(input: { id: string; message: unknown }): Promise<boolean>;
    onEvent(callback: (payload: InteractiveAppEvent) => void): () => void;
  };
  ide: {
    tree(input: { root: string }): Promise<IdeFileTreeNode>;
    readFile(input: { root: string; filePath: string }): Promise<IdeFileReadResult>;
    writeFile(input: {
      root: string;
      filePath: string;
      content: string;
    }): Promise<IdeFileReadResult>;
    diagnostics(input: {
      root: string;
      filePath: string;
      content: string;
    }): Promise<IdeDiagnostic[]>;
    workspaceDiagnostics(input: { root: string }): Promise<IdeDiagnostic[]>;
    semanticTokens(input: {
      root: string;
      filePath: string;
      content: string;
    }): Promise<IdeSemanticTokensResult>;
  };
  extensions: {
    list(input?: ExtensionListInput): Promise<AppExtensionRecord[]>;
    audit(input?: ExtensionAuditListInput): Promise<ExtensionAuditRecord[]>;
    chooseInstallSource(): Promise<string | null>;
    chooseUpdateSource(): Promise<string | null>;
    install(input: ExtensionInstallInput): Promise<AppExtensionRecord>;
    marketplace(input?: ExtensionMarketplaceListInput): Promise<ExtensionMarketplaceResult>;
    update(input: ExtensionUpdateInput): Promise<AppExtensionRecord>;
    uninstall(input: string | ExtensionUninstallInput): Promise<boolean>;
    setEnabled(input: ExtensionEnableInput): Promise<AppExtensionRecord>;
    grant(input: ExtensionGrantInput): Promise<AppExtensionRecord>;
    setWorkspaceTrust(input: ExtensionWorkspaceTrustInput): Promise<boolean>;
    workspaceTrusted(input: { workspacePath: string }): Promise<boolean>;
    readAsset(input: ExtensionAssetInput): Promise<ExtensionAssetResult>;
    activate(input: ExtensionActivateInput): Promise<AppExtensionRecord>;
    executeCommand(input: ExtensionCommandInput): Promise<unknown>;
    resolveAgentContributions(
      input: ResolveAgentContributionsInput,
    ): Promise<ResolvedAgentContributions>;
    getConfiguration(input: ExtensionConfigurationInput): Promise<ExtensionConfigurationResult>;
    updateConfiguration(
      input: ExtensionConfigurationUpdateInput,
    ): Promise<ExtensionConfigurationResult>;
  };
  interactions: {
    pending(): Promise<{
      approvals: ApprovalRequestPayload[];
      questions: QuestionRequestPayload[];
    }>;
    respondApproval(input: {
      requestId: string;
      decision: AspApprovalDecision;
      message?: string;
    }): Promise<boolean>;
    respondQuestion(input: { requestId: string; response: AspQuestionResponse }): Promise<boolean>;
  };
  panel: {
    syncState(input: DetailPanelRuntimeState): Promise<DetailPanelRuntimeState>;
    syncIdeState(input: IdePanelRuntimeState): Promise<IdePanelRuntimeState>;
    onCommand(callback: (payload: DetailPanelRuntimeCommand) => void): () => void;
  };
  onSessionEvent(callback: (payload: DesktopSessionEvent) => void): () => void;
  onTerminalEvent(callback: (payload: TerminalRunEvent) => void): () => void;
  onBrowserEvent(callback: (payload: BrowserEvent) => void): () => void;
  onApprovalRequest(callback: (payload: ApprovalRequestPayload) => void): () => void;
  onQuestionRequest(callback: (payload: QuestionRequestPayload) => void): () => void;
  onExtensionEvent(callback: (payload: ExtensionRuntimeEvent) => void): () => void;
  onScheduledTaskEvent(callback: (payload: ScheduledTaskEvent) => void): () => void;
};

export type AgentDesktopApi = AgentRuntimeApi;

export type VoiceRecordingSaveInput = {
  data?: ArrayBuffer | Uint8Array | number[];
  dataBase64?: string;
  extension?: string;
  mime?: string;
};

export type VoiceRecordingSaveResult = {
  mime: string;
  name: string;
  path: string;
  size: number;
};

export type AgentDesktopBridge = Omit<AgentRuntimeApi, "features" | "transport"> &
  Partial<Pick<AgentRuntimeApi, "features" | "transport">>;

type JsonRpcResponse = {
  id?: number | string | null;
  jsonrpc?: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
};

type PendingRequest = {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout?: number;
};

let cachedElectronApi: AgentRuntimeApi | undefined;
let cachedWebSocketApi: AgentRuntimeApi | undefined;
let cachedWebSocketUrl = "";

export function desktopApi(): AgentRuntimeApi | undefined {
  if (window.agentDesktop) {
    cachedElectronApi ??= createElectronRuntimeApi(window.agentDesktop);
    return cachedElectronApi;
  }
  const url = runtimeRpcUrl();
  if (!url) return undefined;
  if (!cachedWebSocketApi || cachedWebSocketUrl !== url) {
    cachedWebSocketUrl = url;
    cachedWebSocketApi = createWebSocketRuntimeApi(url);
  }
  return cachedWebSocketApi;
}

function createElectronRuntimeApi(bridge: AgentDesktopBridge): AgentRuntimeApi {
  return {
    ...bridge,
    interactions: {
      ...bridge.interactions,
      pending: bridge.interactions.pending ?? (async () => ({ approvals: [], questions: [] })),
    },
    panel: bridge.panel ?? {
      syncState: async (input) => input,
      syncIdeState: async (input) => input,
      onCommand: () => () => undefined,
    },
    transport: "electron",
    features: {
      filePathAccess: true,
      nativeDialogs: true,
      webview: false,
      webContentsView: true,
      browserAutomation: true,
      browserScreencast: false,
      ...bridge.features,
    },
    versions: bridge.versions ?? {},
  };
}

function createWebSocketRuntimeApi(url: string): AgentRuntimeApi {
  const rpc = new WebSocketJsonRpcClient(url);
  const call = <T>(method: string, params?: unknown): Promise<T> => rpc.request<T>(method, params);
  return {
    transport: "websocket",
    features: {
      filePathAccess: false,
      nativeDialogs: false,
      webview: false,
      webContentsView: false,
      browserAutomation: false,
      browserScreencast: false,
    },
    platform: "websocket",
    versions: {},
    files: {
      getPath: () => "",
    },
    providers: {
      list: () => call("providers.list"),
      save: (provider) => call("providers.save", provider),
      remove: (id) => call("providers.remove", id),
      test: (provider) => call("providers.test", provider),
      capabilities: (input) => call("providers.capabilities", input),
      detect: () => call("providers.detect"),
    },
    workspace: {
      choose: (initialPath) => openServerWorkspacePicker(call, initialPath),
      getDefault: () => call("workspace.getDefault"),
      listDirectories: (input) => call("workspace.listDirectories", input),
      privateRoot: () => call("workspace.privateRoot"),
      privateSession: (input) => call("workspace.privateSession", input),
    },
    mcpGateway: {
      getSettings: (input) => call("mcpGateway.getSettings", input),
      refresh: (input) => call("mcpGateway.refresh", input),
      removeServer: (input) => call("mcpGateway.removeServer", input),
      saveServer: (input) => call("mcpGateway.saveServer", input),
      setEnabled: (input) => call("mcpGateway.setEnabled", input),
      setLlm: (input) => call("mcpGateway.setLlm", input),
    },
    browserWorkflows: {
      generateFromAnnotations: (input) => call("browserWorkflows.generateFromAnnotations", input),
      get: (input) => call("browserWorkflows.get", input),
      list: () => call("browserWorkflows.list"),
      remove: (input) => call("browserWorkflows.remove", input),
      save: (input) => call("browserWorkflows.save", input),
    },
    scheduledTasks: {
      list: () => call("scheduledTasks.list"),
      add: (input) => call("scheduledTasks.add", input),
      update: (input) => call("scheduledTasks.update", input),
      remove: (input) => call("scheduledTasks.remove", input),
      setEnabled: (input) => call("scheduledTasks.setEnabled", input),
      runNow: (input) => call("scheduledTasks.runNow", input),
    },
    storage: {
      get: (input) => call("storage.get", input),
      set: (input) => call("storage.set", input),
      remove: (input) => call("storage.remove", input),
      list: (input) => call("storage.list", input),
    },
    sessions: {
      run: (input) => call("sessions.run", input),
      cancel: (uiSessionId) => call("sessions.cancel", uiSessionId),
      cleanupHandoffFiles: (uiSessionId) => call("sessions.cleanupHandoffFiles", uiSessionId),
      list: (input) => call("sessions.list", input),
      create: (input) => call("sessions.create", input),
      close: (input) => call("sessions.close", input),
      messages: (input) => call("sessions.messages", input),
      usage: (input) => call("sessions.usage", input),
      resume: (input) => call("sessions.resume", input),
      hydrateTranscript: (input) => call("sessions.hydrateTranscript", input),
      delete: (input) => call("sessions.delete", input),
      invokeExtension: (input) => call("sessions.invokeExtension", input),
    },
    terminal: {
      run: (input) => call("terminal.run", input),
      exec: (input) => call("terminal.exec", input),
      cancel: (id) => call("terminal.cancel", id),
      create: (input) => call("terminal.create", input),
      write: (input) => call("terminal.write", input),
      resize: (input) => call("terminal.resize", input),
      dispose: (id) => call("terminal.dispose", id),
    },
    browser: {
      create: (input) => call("browser.create", input),
      register: (input) => call("browser.register", input),
      unregister: (id) => call("browser.unregister", id),
      setBounds: (input) => call("browser.setBounds", input),
      releaseFocus: () => call("browser.releaseFocus"),
      list: () => call("browser.list"),
      navigate: (input) => call("browser.navigate", input),
      reload: (input) => call("browser.reload", input),
      stop: (input) => call("browser.stop", input),
      goBack: (input) => call("browser.goBack", input),
      goForward: (input) => call("browser.goForward", input),
      evaluate: (input) => call("browser.evaluate", input),
      click: (input) => call("browser.click", input),
      type: (input) => call("browser.type", input),
      snapshot: (input) => call("browser.snapshot", input),
      screenshot: (input) => call("browser.screenshot", input),
      setAnnotationMode: (input) => call("browser.setAnnotationMode", input),
      setWorkflowRecordingMode: (input) => call("browser.setWorkflowRecordingMode", input),
      listAnnotations: (input) => call("browser.listAnnotations", input),
      clearAnnotations: (input) => call("browser.clearAnnotations", input),
      addAnnotation: (input) => call("browser.addAnnotation", input),
      deleteAnnotation: (input) => call("browser.deleteAnnotation", input),
      inspectElement: (input) => call("browser.inspectElement", input),
      cdpCommand: (input) => call("browser.cdpCommand", input),
      cdpStartCapture: (input) => call("browser.cdpStartCapture", input),
      cdpEvents: (input) => call("browser.cdpEvents", input),
      cdpStopCapture: (input) => call("browser.cdpStopCapture", input),
      screencastStart: (input) => call("browser.screencastStart", input),
      screencastAck: (input) => call("browser.screencastAck", input),
      screencastStop: (input) => call("browser.screencastStop", input),
      dispatchMouse: (input) => call("browser.dispatchMouse", input),
      dispatchKey: (input) => call("browser.dispatchKey", input),
      insertText: (input) => call("browser.insertText", input),
    },
    ide: {
      tree: (input) => call("ide.tree", input),
      readFile: (input) => call("ide.readFile", input),
      writeFile: (input) => call("ide.writeFile", input),
      diagnostics: (input) => call("ide.diagnostics", input),
      workspaceDiagnostics: (input) => call("ide.workspaceDiagnostics", input),
      semanticTokens: (input) => call("ide.semanticTokens", input),
    },
    extensions: {
      list: (input) => call("extensions.list", input),
      audit: (input) => call("extensions.audit", input),
      chooseInstallSource: () => openServerWorkspacePicker(call, undefined, "extension"),
      chooseUpdateSource: () => openServerWorkspacePicker(call, undefined, "extensionUpdate"),
      install: (input) => call("extensions.install", input),
      marketplace: (input) => call("extensions.marketplace", input),
      update: (input) => call("extensions.update", input),
      uninstall: (extensionId) => call("extensions.uninstall", extensionId),
      setEnabled: (input) => call("extensions.setEnabled", input),
      grant: (input) => call("extensions.grant", input),
      setWorkspaceTrust: (input) => call("extensions.setWorkspaceTrust", input),
      workspaceTrusted: (input) => call("extensions.workspaceTrusted", input),
      readAsset: (input) => call("extensions.readAsset", input),
      activate: (input) => call("extensions.activate", input),
      executeCommand: (input) => call("extensions.executeCommand", input),
      resolveAgentContributions: (input) => call("extensions.resolveAgent", input),
      getConfiguration: (input) => call("extensions.getConfiguration", input),
      updateConfiguration: (input) => call("extensions.updateConfiguration", input),
    },
    interactions: {
      pending: () => call("interactions.pending"),
      respondApproval: (input) => call("interactions.respondApproval", input),
      respondQuestion: (input) => call("interactions.respondQuestion", input),
    },
    panel: {
      syncState: (input) => call("panel.syncState", input),
      syncIdeState: (input) => call("panel.syncIdeState", input),
      onCommand: (callback) => rpc.subscribe("agui:panel:command", callback),
    },
    onSessionEvent: (callback) => rpc.subscribe("agui:asp:event", callback),
    onTerminalEvent: (callback) => rpc.subscribe("agui:terminal:event", callback),
    onBrowserEvent: (callback) => rpc.subscribe("agui:browser:event", callback),
    onApprovalRequest: (callback) => rpc.subscribe("agui:asp:approval", callback),
    onQuestionRequest: (callback) => rpc.subscribe("agui:asp:question", callback),
    onExtensionEvent: (callback) => rpc.subscribe("agui:extensions:event", callback),
    onScheduledTaskEvent: (callback) => rpc.subscribe("agui:schedule:event", callback),
  };
}

function openServerWorkspacePicker(
  call: <T>(method: string, params?: unknown) => Promise<T>,
  initialPath?: string,
  purpose: "workspace" | "extension" | "extensionUpdate" = "workspace",
): Promise<string | null> {
  return new Promise((resolve) => {
    const isChinese = navigator.language.toLowerCase().startsWith("zh");
    let currentPath = "";
    let disposed = false;

    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[70] grid place-items-center bg-black/55 p-4";
    const panel = document.createElement("div");
    panel.className =
      "ui-popover-surface flex max-h-[min(680px,90vh)] w-full max-w-2xl flex-col rounded-xl text-fg";
    const header = document.createElement("div");
    header.className = "border-b border-border-subtle px-5 py-4";
    const title = document.createElement("div");
    title.className = "text-[15px] font-semibold";
    title.textContent = isChinese
      ? purpose === "extension"
        ? "安装服务器扩展"
        : purpose === "extensionUpdate"
          ? "更新服务器扩展"
          : "打开服务器项目"
      : purpose === "extension"
        ? "Install server extension"
        : purpose === "extensionUpdate"
          ? "Update server extension"
          : "Open server project";
    const subtitle = document.createElement("div");
    subtitle.className = "mt-1 text-[12.5px] text-muted";
    subtitle.textContent = isChinese
      ? purpose === "workspace"
        ? "选择 Node server 上已有的目录。"
        : "选择 Node server 上包含 package.json 的扩展包目录。"
      : purpose === "workspace"
        ? "Choose an existing directory on the Node server."
        : "Choose a server directory containing package.json.";
    header.append(title, subtitle);

    const body = document.createElement("div");
    body.className = "flex min-h-0 flex-1 flex-col gap-3 p-5";
    const roots = document.createElement("div");
    roots.className = "flex flex-wrap gap-2";
    const toolbar = document.createElement("div");
    toolbar.className = "flex items-center gap-2";
    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "ui-button px-2.5 py-1.5 text-[12px]";
    upButton.textContent = isChinese ? "上一级" : "Up";
    const pathLabel = document.createElement("div");
    pathLabel.className =
      "border-border-subtle bg-surface min-w-0 flex-1 truncate rounded-[8px] border px-3 py-1.5 font-mono text-[12px] text-muted";
    toolbar.append(upButton, pathLabel);
    const list = document.createElement("div");
    list.className =
      "border-border-subtle bg-surface/40 min-h-64 overflow-auto rounded-[8px] border p-1";
    body.append(roots, toolbar, list);

    const footer = document.createElement("div");
    footer.className = "flex justify-end gap-2 border-t border-border-subtle px-5 py-4";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "ui-button text-[13px]";
    cancelButton.textContent = isChinese ? "取消" : "Cancel";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "ui-button ui-button-primary text-[13px]";
    openButton.textContent = isChinese
      ? purpose === "extension"
        ? "安装"
        : purpose === "extensionUpdate"
          ? "更新"
          : "打开"
      : purpose === "extension"
        ? "Install"
        : purpose === "extensionUpdate"
          ? "Update"
          : "Open";
    footer.append(cancelButton, openButton);
    panel.append(header, body, footer);
    overlay.append(panel);
    document.body.appendChild(overlay);

    const cleanup = () => {
      disposed = true;
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown);
    };

    const close = (value: string | null) => {
      cleanup();
      resolve(value);
    };

    const renderLoading = () => {
      list.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "px-3 py-8 text-center text-[13px] text-muted";
      loading.textContent = isChinese ? "正在读取目录..." : "Loading directories...";
      list.append(loading);
    };

    const renderError = (message: string) => {
      list.replaceChildren();
      const error = document.createElement("div");
      error.className = "px-3 py-8 text-center text-[13px] text-danger";
      error.textContent = message;
      list.append(error);
    };

    const load = async (path?: string) => {
      renderLoading();
      try {
        const listing = await call<WorkspaceDirectoryListing>("workspace.listDirectories", {
          path,
        });
        if (disposed) return;
        currentPath = listing.path;
        render(listing);
      } catch (error) {
        if (disposed) return;
        renderError(formatClientError(error));
      }
    };

    const render = (listing: WorkspaceDirectoryListing) => {
      currentPath = listing.path;
      pathLabel.textContent = listing.path;
      upButton.disabled = !listing.parentPath;
      openButton.disabled = !listing.path;
      upButton.onclick = () => {
        if (listing.parentPath) void load(listing.parentPath);
      };

      roots.replaceChildren();
      for (const root of listing.roots) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = [
          "ui-button max-w-full justify-start truncate px-2.5 py-1 text-left text-[12px]",
          root.path === listing.path
            ? "border-info bg-info/10 text-info"
            : "border-border text-muted hover:bg-surface-hover hover:text-fg",
        ].join(" ");
        button.title = root.path;
        button.textContent = root.name;
        button.onclick = () => void load(root.path);
        roots.append(button);
      }

      list.replaceChildren();
      if (!listing.entries.length) {
        const empty = document.createElement("div");
        empty.className = "px-3 py-8 text-center text-[13px] text-muted";
        empty.textContent = isChinese ? "没有可打开的子目录。" : "No subdirectories.";
        list.append(empty);
        return;
      }
      for (const entry of listing.entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ui-nav-row w-full px-3 py-2 text-left text-[13px]";
        button.title = entry.path;
        const icon = document.createElement("span");
        icon.className = "shrink-0 text-info";
        icon.textContent = "▸";
        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = entry.name;
        button.append(icon, label);
        button.onclick = () => void load(entry.path);
        list.append(button);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(null);
    };

    cancelButton.onclick = () => close(null);
    openButton.onclick = async () => {
      if (!currentPath) return;
      openButton.disabled = true;
      try {
        close(await call<string | null>("workspace.choose", currentPath));
      } catch (error) {
        openButton.disabled = false;
        void alertDialog({
          title: t("common.actionFailed"),
          description: formatClientError(error),
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    void load(initialPath);
  });
}

function formatClientError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WebSocketJsonRpcClient {
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<string, Set<(payload: never) => void>>();
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("AGUI runtime WebSocket is not connected.");
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = requestTimeoutMs(params);
      const timeout =
        timeoutMs > 0
          ? window.setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out.`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
    const listeners = this.subscriptions.get(channel) ?? new Set();
    listeners.add(callback as (payload: never) => void);
    this.subscriptions.set(channel, listeners);
    void this.connect().catch(() => {
      // Method calls surface connection errors. Subscriptions stay registered for a later reconnect.
    });
    return () => {
      listeners.delete(callback as (payload: never) => void);
      if (listeners.size === 0) this.subscriptions.delete(channel);
    };
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.connectPromise = null;
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("error", () => {
        const error = new Error(`Unable to connect AGUI runtime WebSocket: ${this.url}`);
        this.connectPromise = null;
        reject(error);
      });
      socket.addEventListener("close", () => {
        this.connectPromise = null;
        this.rejectPending(new Error("AGUI runtime WebSocket closed."));
      });
    });
    return this.connectPromise;
  }

  private handleMessage(data: unknown): void {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(String(data)) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return;
    }
    if ("id" in message && message.id != null) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      if (pending.timeout !== undefined) window.clearTimeout(pending.timeout);
      this.pending.delete(Number(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!("method" in message) || typeof message.method !== "string") return;
    const listeners = this.subscriptions.get(message.method);
    listeners?.forEach((listener) => listener(message.params as never));
  }

  private rejectPending(error: Error): void {
    this.pending.forEach((pending) => {
      if (pending.timeout !== undefined) window.clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pending.clear();
  }
}

function requestTimeoutMs(params: unknown): number {
  const timeoutMs =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as { timeoutMs?: unknown }).timeoutMs
      : undefined;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) return timeoutMs;
  return 31 * 60 * 1000;
}

function runtimeRpcUrl(): string {
  const metadataUrl = document
    .querySelector<HTMLMetaElement>('meta[name="agui-rpc-url"]')
    ?.getAttribute("content");
  const envUrl = import.meta.env.VITE_AGUI_RPC_URL as string | undefined;
  const queryUrl = new URLSearchParams(window.location.search).get("aguiRpc") ?? undefined;
  return normalizeRpcUrl(metadataUrl || envUrl || queryUrl || "");
}

function normalizeRpcUrl(url: string): string {
  const value = url.trim();
  if (!value) return "";
  if (value.startsWith("ws://") || value.startsWith("wss://")) return value;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  return value;
}
