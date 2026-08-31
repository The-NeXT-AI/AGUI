import type {
  AspConversationContext,
  AspProviderCapabilities,
  AspRunSpeed,
  AspSlashCommand,
} from "@/asp/desktop-api";

/**
 * Streaming event model.
 *
 * A conversation is a stream of {@link SessionEvent}s emitted by an agent
 * backend. The chat store reduces them into a list of {@link ChatBlock}s that
 * the UI renders. This split keeps the wire format (what a real server sends)
 * cleanly separated from the view model (what components paint).
 *
 * The event shapes mirror the AGUI agent protocol — reasoning deltas, plan
 * updates, terminal/diff tool calls — so wiring a real backend later is mostly
 * forwarding its messages into `dispatch`.
 */

export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export type ToolStatus = "running" | "success" | "error";

/** Human review state for a proposed file change (the suggest-mode loop). */
export type DiffReview = "pending" | "accepted" | "rejected";

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** A file or image attached to a user message. */
export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  /** Inline context that should be appended to the model prompt. */
  content?: string;
  source?: "browser_annotations";
  /** data URL for images. */
  url?: string;
  /** Absolute local path exposed by Electron's webUtils bridge. */
  path?: string;
  /** Prior-turn file identity; the runtime replaces this path with a read-only snapshot. */
  handoffFileId?: string;
  mime?: string;
  size?: number;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: Attachment[];
  targetParticipantId?: string;
  targetProviderId?: string;
  workItemId?: string;
  sourceSeq?: number;
  createdAt: number;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ContextUsage {
  used: number;
  usedKnown?: boolean;
  size: number;
  source?: string;
  cost?: { amount: number; currency: string } | null;
}

export interface InteractiveAppEmbed {
  renderer: "mcp-app";
  title?: string;
  html?: string;
  src?: string;
  uri?: string;
  resourceUri?: string;
  server?: string;
  height?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  widgetState?: unknown;
  metadata?: Record<string, unknown>;
}

export interface McpAppModelContext {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  updatedAt: number;
}

export interface McpAppSessionState {
  key: string;
  title?: string;
  server?: string;
  resourceUri?: string;
  documentId?: string;
  widgetState?: unknown;
  modelContext?: McpAppModelContext;
  version: number;
  updatedAt: number;
}

export interface ToolLocation {
  path: string;
  line?: number | null;
}

/** Discriminated wire events produced by an agent backend. */
export type SessionEvent = (
  | { id: string; type: "user_message"; text: string; attachments?: Attachment[]; at: number }
  | { id: string; blockId: string; type: "reasoning_start"; at: number }
  | { id: string; blockId: string; type: "reasoning_delta"; text: string; at: number }
  | { id: string; blockId: string; type: "reasoning_end"; at: number }
  | { id: string; blockId: string; type: "assistant_start"; at: number }
  | { id: string; blockId: string; type: "assistant_delta"; text: string; at: number }
  | { id: string; blockId: string; type: "assistant_end"; at: number }
  | { id: string; blockId: string; type: "plan_update"; todos: Todo[]; at: number }
  | {
      id: string;
      toolId: string;
      type: "tool_start";
      title: string;
      toolKind?: string;
      status: ToolStatus;
      output?: string;
      rawInput?: unknown;
      locations?: ToolLocation[];
      at: number;
    }
  | {
      id: string;
      toolId: string;
      type: "tool_update";
      title?: string;
      status?: ToolStatus;
      output?: string;
      rawOutput?: unknown;
      locations?: ToolLocation[];
      at: number;
    }
  | {
      id: string;
      toolId: string;
      type: "tool_start_terminal";
      terminalId?: string;
      command: string;
      cwd?: string;
      output?: string;
      at: number;
    }
  | {
      id: string;
      toolId: string;
      type: "tool_start_diff";
      path: string;
      hunks: DiffHunk[];
      review?: DiffReview;
      at: number;
    }
  | { id: string; toolId: string; type: "tool_delta"; chunk: string; at: number }
  | { id: string; toolId: string; type: "tool_end"; status: ToolStatus; at: number }
  | { id: string; blockId: string; type: "image"; urls: string[]; prompt?: string; at: number }
  | {
      id: string;
      blockId: string;
      type: "resource";
      title?: string;
      name?: string;
      uri?: string;
      path?: string;
      mimeType?: string;
      content?: string;
      app?: InteractiveAppEmbed;
      metadata?: Record<string, unknown>;
      at: number;
    }
  | {
      id: string;
      blockId: string;
      type: "artifact";
      artifactId?: string;
      title?: string;
      name?: string;
      uri?: string;
      path?: string;
      mimeType?: string;
      content?: string;
      app?: InteractiveAppEmbed;
      metadata?: Record<string, unknown>;
      at: number;
    }
  | {
      id: string;
      blockId: string;
      type: "raw";
      label?: string;
      value: unknown;
      metadata?: Record<string, unknown>;
      at: number;
    }
  | { id: string; type: "turn_complete"; usage?: TokenUsage; at: number }
  | { id: string; type: "error"; message: string; at: number }
) & {
  agentParticipantId?: string;
  agentProviderId?: string;
  order?: number;
  runId?: string;
  workItemId?: string;
};

/**
 * Rendered view model. One reduced block == one self-contained UI card in the
 * stream. `streaming` flags blocks still receiving deltas (shows a caret).
 */
export type ChatBlock = (
  | { id: string; kind: "user"; text: string; attachments?: Attachment[]; at?: number }
  | { id: string; kind: "reasoning"; text: string; streaming: boolean }
  | {
      id: string;
      kind: "assistant";
      text: string;
      streaming: boolean;
      at?: number;
      metadata?: Record<string, unknown>;
    }
  | { id: string; kind: "plan"; todos: Todo[] }
  | {
      id: string;
      kind: "tool";
      title: string;
      toolKind?: string;
      output: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: ToolLocation[];
      status: ToolStatus;
    }
  | {
      id: string;
      kind: "terminal";
      terminalId?: string;
      command: string;
      cwd?: string;
      output: string;
      status: ToolStatus;
      streaming: boolean;
    }
  | {
      id: string;
      kind: "diff";
      path: string;
      hunks: DiffHunk[];
      status: ToolStatus;
      review: DiffReview;
    }
  | { id: string; kind: "image"; urls: string[]; prompt?: string }
  | {
      id: string;
      kind: "resource";
      title?: string;
      name?: string;
      uri?: string;
      path?: string;
      mimeType?: string;
      content?: string;
      app?: InteractiveAppEmbed;
      metadata?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "artifact";
      artifactId?: string;
      title?: string;
      name?: string;
      uri?: string;
      path?: string;
      mimeType?: string;
      content?: string;
      app?: InteractiveAppEmbed;
      metadata?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "raw";
      label?: string;
      value: unknown;
      metadata?: Record<string, unknown>;
    }
  | { id: string; kind: "error"; message: string }
) & {
  agentParticipantId?: string;
  agentProviderId?: string;
  agentProviderSessionId?: string;
  conversationSeq?: number;
  order?: number;
  runId?: string;
  workItemId?: string;
};

export type SessionStatus = "idle" | "streaming";
export type SessionConnectionState =
  "disconnected" | "connecting" | "ready" | "running" | "idle" | "closed" | "error";

export interface SessionExtensionState {
  agents?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  session?: Record<string, unknown>;
  sessionTree?: {
    extensionId: string;
    rootId?: string;
    nodeId: string;
    title?: string;
    developerInstructions?: string;
    metadata?: Record<string, unknown>;
    hideInSessionList?: boolean;
    updatedAt: number;
  };
  events?: Array<{
    extension: string;
    event: string;
    payload?: unknown;
    at: number;
  }>;
}

/** Provider-local state retained while another Agent is active in the shared conversation. */
export type AgentSessionStatus = "never_used" | "running" | "synced" | "failed";

export interface AgentRunSettings {
  approvalMode: ApprovalMode;
  effort: string;
  model: string;
  speed: AspRunSpeed;
}

export interface AgentSessionState {
  status?: AgentSessionStatus;
  providerSessionId?: string;
  capabilities?: AspProviderCapabilities;
  availableCommands?: AspSlashCommand[];
  contextUsage?: ContextUsage;
  usage?: TokenUsage;
  /** Full provider-local extension state. `sessionState` remains for persisted legacy data. */
  extensionState?: SessionExtensionState;
  sessionState?: Record<string, unknown>;
  /** Workspace used to create this backend thread, retained for later deletion. */
  cwd?: string;
  /** Last shared user/assistant block that this Agent has already seen. */
  lastSyncedBlockId?: string;
  /** Monotonic conversation cursor acknowledged by this Agent. */
  seenThroughSeq?: number;
  lastUsedAt?: number;
  runSettings?: AgentRunSettings;
}

export type AgentParticipantRole = "primary" | "subagent" | "mode" | "task";
export type AgentParticipantStatus =
  "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentParticipant {
  id: string;
  providerId: string;
  profileId?: string;
  name?: string;
  role: AgentParticipantRole;
  kind: "provider" | "runtime-subagent";
  parentParticipantId?: string;
  parentRunId?: string;
  backendSessionId?: string;
  status: AgentParticipantStatus;
  createdAt: number;
  updatedAt: number;
}

export type WorkItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentWorkItem {
  id: string;
  objective: string;
  ownerParticipantId: string;
  parentWorkItemId?: string;
  status: WorkItemStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunState {
  id: string;
  providerRunId?: string;
  providerId: string;
  participantId: string;
  workItemId: string;
  handoffId?: string;
  parentRunId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: number;
  finishedAt?: number;
}

export interface AgentHandoffState {
  id: string;
  workItemId: string;
  fromParticipantId?: string;
  toParticipantId: string;
  targetProviderId: string;
  sourceSeq: number;
  highWatermarkSeq: number;
  contextDigest: string;
  context: AspConversationContext;
  status: "queued" | "delivered" | "acknowledged" | "completed" | "failed" | "cancelled";
  runId?: string;
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  finishedAt?: number;
}

export interface RetiredAgentSessionState extends AgentSessionState {
  providerId: string;
  reason: "edit" | "regenerate";
  retiredAt: number;
}

export interface Session {
  id: string;
  workspaceId?: string;
  title: string;
  blocks: ChatBlock[];
  status: SessionStatus;
  connectionState: SessionConnectionState;
  connectionMessage?: string;
  transcriptLoading?: boolean;
  /** Ephemeral route lock for the run currently using this UI session. */
  activeRunId?: string;
  activeRunProviderId?: string;
  activeRunRequestId?: string;
  activeParticipantId?: string;
  activeWorkItemId?: string;
  activeHandoffId?: string;
  providerId: string;
  /** User-selected project folder. Null means the session uses AGUI private storage. */
  projectPath?: string | null;
  /** Private AGUI directory used when no project folder is selected. */
  privateSessionPath?: string;
  cwd: string;
  additionalDirectories?: string[];
  providerSessionId?: string;
  queuedPrompts?: QueuedPrompt[];
  /** Monotonic local ordering for persisted conversation and orchestration events. */
  conversationRevision?: number;
  agentParticipants?: Record<string, AgentParticipant>;
  workItems?: Record<string, AgentWorkItem>;
  agentRuns?: Record<string, AgentRunState>;
  handoffs?: AgentHandoffState[];
  /** Independent backend threads keyed by provider id for a multi-Agent conversation. */
  agentSessions?: Record<string, AgentSessionState>;
  /** Detached backend threads kept so deleting the app session can clean them up later. */
  retiredAgentSessions?: RetiredAgentSessionState[];
  capabilities?: AspProviderCapabilities;
  availableCommands?: AspSlashCommand[];
  contextUsage?: ContextUsage;
  extensionState?: SessionExtensionState;
  mcpAppState?: Record<string, McpAppSessionState>;
  /** Aggregated token usage from the latest completed turn. */
  usage?: TokenUsage;
  /** Timestamp when the user pinned this session. Pinned sessions stay above regular sessions. */
  pinnedAt?: number;
  /** Timestamp when the user archived this session. Archived sessions are hidden from the main list. */
  archivedAt?: number;
  createdAt: number;
}

export interface SessionProject {
  key: string;
  workspaceId?: string;
  label: string;
  projectPath: string;
  createdAt: number;
}

export interface SessionFolder {
  id: string;
  workspaceId?: string;
  name: string;
  projectKey: string;
  projectPath: string | null;
  parentId: string | null;
  color: string;
  icon: string;
  order: number;
  createdAt: number;
}

export interface SessionPlacement {
  folderId: string | null;
  order: number;
}

export interface DraftSession {
  id: string;
  workspaceId?: string;
  providerId: string;
  folderId?: string | null;
  /** User-selected project folder. Null means the first turn uses AGUI private storage. */
  projectPath: string | null;
  cwd: string;
  createdAt: number;
}
