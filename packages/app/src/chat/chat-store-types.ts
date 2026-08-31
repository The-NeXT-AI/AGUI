import type { AspProviderCapabilities, AspSlashCommand } from "@/asp/desktop-api";
import type {
  CreateSessionInput,
  ImportProviderSessionInput,
  MoveSessionInTreeInput,
} from "./chat-session-state";
import type {
  Attachment,
  ContextUsage,
  DiffReview,
  DraftSession,
  McpAppModelContext,
  McpAppSessionState,
  Session,
  SessionConnectionState,
  SessionEvent,
  SessionFolder,
  SessionPlacement,
  SessionProject,
  TokenUsage,
} from "./types";

export type SessionRuntimePatch = {
  title?: string;
  providerSessionId?: string;
  capabilities?: AspProviderCapabilities;
  availableCommands?: AspSlashCommand[];
  contextUsage?: ContextUsage | null;
  usage?: TokenUsage;
  extensionState?: Session["extensionState"];
  connectionState?: SessionConnectionState;
  connectionMessage?: string;
};

export type SendOptions = {
  editBlockId?: string;
};

export type PendingPrompt = {
  id: string;
  text: string;
  attachments?: Attachment[];
  targetParticipantId: string;
  targetProviderId: string;
  workItemId: string;
  sourceSeq: number;
};

export type ProjectAgentLifecycleInput = {
  at: number;
  event: string;
  payload?: unknown;
  providerId?: string;
  runId?: string;
};

export type McpAppStatePatch = {
  documentId?: string;
  modelContext?: Omit<McpAppModelContext, "updatedAt"> | null;
  resourceUri?: string;
  server?: string;
  title?: string;
  widgetState?: unknown;
};

export type EnsureScheduledTaskSessionInput = {
  createdAt?: number;
  cwd: string;
  projectPath: string | null;
  providerId: string;
  sessionId: string;
  title: string;
  workspaceId?: string;
};

export type CreateSessionFolderInput = {
  color?: string;
  icon?: string;
  name?: string;
  parentId?: string | null;
  projectKey?: string;
  projectPath?: string | null;
  workspaceId?: string;
};

export type UpdateSessionFolderInput = Partial<
  Pick<SessionFolder, "color" | "icon" | "name" | "parentId">
>;

export type OpenExtensionSessionInput = {
  extensionId: string;
  rootId?: string;
  nodeId: string;
  title: string;
  providerId?: string;
  projectPath?: string | null;
  cwd?: string;
  renderer?: string;
  initialMarkdown?: string;
  developerInstructions?: string;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
};

export interface ChatStore {
  sessions: Session[];
  sessionProjects: SessionProject[];
  sessionFolders: SessionFolder[];
  sessionPlacements: Record<string, SessionPlacement>;
  draftSession: DraftSession | null;
  activeSessionId: string | null;
  openTabs: string[];
  startDraftSession: () => string;
  createSession: (input?: CreateSessionInput) => string;
  importProviderSession: (input: ImportProviderSessionInput) => string;
  openExtensionSession: (input: OpenExtensionSessionInput) => string;
  materializeExtensionSession: (input: OpenExtensionSessionInput) => string;
  materializeDraftSession: () => string;
  isolateWorkspaceSessions: (workspaceId?: string) => void;
  openSession: (id: string) => void;
  closeTab: (id: string) => void;
  removeSession: (id: string) => void;
  deleteSession: (id: string) => Promise<boolean>;
  renameSession: (id: string, title: string) => void;
  toggleSessionPinned: (id: string) => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  addSessionProject: (projectPath: string) => void;
  removeSessionProject: (projectKey: string) => void;
  createSessionFolder: (input?: CreateSessionFolderInput) => string;
  updateSessionFolder: (id: string, patch: UpdateSessionFolderInput) => void;
  deleteSessionFolder: (id: string) => void;
  moveSessionInTree: (input: MoveSessionInTreeInput) => void;
  hydrateSessionTranscript: (id: string) => Promise<void>;
  dispatch: (event: SessionEvent) => void;
  dispatchTo: (sessionId: string, event: SessionEvent) => void;
  dispatchManyTo: (sessionId: string, events: SessionEvent[]) => void;
  patchRuntime: (sessionId: string, patch: SessionRuntimePatch, providerId?: string) => void;
  projectAgentLifecycle: (sessionId: string, input: ProjectAgentLifecycleInput) => void;
  updateMcpAppState: (
    sessionId: string,
    key: string,
    patch: McpAppStatePatch,
  ) => McpAppSessionState | undefined;
  setDraftProvider: (providerId: string) => void;
  setDraftSessionFolder: (folderId: string | null) => void;
  setDraftWorkspace: (projectPath: string | null) => void;
  setSessionProvider: (sessionId: string, providerId: string) => void;
  restoreSessionRunSettings: (sessionId: string) => void;
  setSessionWorkspace: (sessionId: string, cwd: string) => void;
  reviewDiff: (toolId: string, review: DiffReview) => void;
  send: (text: string, attachments?: Attachment[], options?: SendOptions) => Promise<void>;
  runTurn: (prompt: string) => Promise<void>;
  removeQueuedPrompt: (sessionId: string, promptId: string) => void;
  steerQueuedPrompt: (sessionId: string, promptId: string) => Promise<void>;
  ensureScheduledTaskSession: (input: EnsureScheduledTaskSessionInput) => void;
  stop: () => void;
  editUserMessage: (blockId: string) => void;
  branchFromBlock: (blockId: string) => void;
  regenerateAt: (blockId: string) => void;
}
