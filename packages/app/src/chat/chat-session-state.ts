import type { AspProviderSession, AspTokenUsage } from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { uid } from "@/ui/id";
import { DEFAULT_WORKSPACE_ID, useWorkspaceStore } from "@/workspaces/workspace-store";
import { contextUsageForSession } from "./context-usage";
import { providerParticipantId } from "./agent-orchestration";
import { tokenUsageFromAsp } from "./chat-run-helpers";
import type {
  DraftSession,
  Session,
  SessionFolder,
  SessionPlacement,
  SessionProject,
} from "./types";

export const SESSION_TREE_ORDER_STEP = 1000;
export const DEFAULT_SESSION_FOLDER_COLOR = "#3b82f6";
export const DEFAULT_SESSION_FOLDER_ICON = "folder";

export type CreateSessionInput = Partial<
  Pick<Session, "id" | "providerId" | "projectPath" | "cwd" | "title">
> & {
  folderId?: string | null;
  workspaceId?: string;
};

export type ImportProviderSessionInput = {
  folderId?: string | null;
  projectPath?: string | null;
  providerId: string;
  workspaceId?: string;
  providerSession: AspProviderSession & {
    context?: {
      usedTokens?: number;
      windowTokens?: number;
      autoCompaction?: boolean;
    };
    usage?: AspTokenUsage;
  };
};

export type MoveSessionInTreeInput = {
  folderId: string | null;
  position?: "before" | "after" | "end";
  sessionId: string;
  targetSessionId?: string;
};

export type WorkspaceScopedValue = {
  workspaceId?: string | null;
};

export type SessionOpenState = {
  sessions: Session[];
  draftSession: DraftSession | null;
  activeSessionId: string | null;
  openTabs: string[];
};

export function chatWorkspaceId(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_WORKSPACE_ID;
}

export function activeChatWorkspaceId(): string {
  return chatWorkspaceId(useWorkspaceStore.getState().activeWorkspaceId);
}

export function workspaceScopedId(value: WorkspaceScopedValue | undefined): string {
  return chatWorkspaceId(value?.workspaceId);
}

export function belongsToWorkspace(
  value: WorkspaceScopedValue | undefined,
  workspaceId: string,
): boolean {
  return workspaceScopedId(value) === chatWorkspaceId(workspaceId);
}

export function draftForActiveWorkspace(draft: DraftSession | null | undefined): DraftSession {
  const workspaceId = activeChatWorkspaceId();
  return draft && belongsToWorkspace(draft, workspaceId) ? draft : createDraftSession();
}

export function isolateWorkspaceOpenState(
  state: SessionOpenState,
  workspaceId = activeChatWorkspaceId(),
): Pick<SessionOpenState, "activeSessionId" | "draftSession" | "openTabs"> {
  const scopedWorkspaceId = chatWorkspaceId(workspaceId);
  const openableSessionIds = new Set(
    state.sessions
      .filter((session) => !session.archivedAt && belongsToWorkspace(session, scopedWorkspaceId))
      .map((session) => session.id),
  );
  const openTabs = state.openTabs.filter((id) => openableSessionIds.has(id));
  const activeSessionId =
    state.activeSessionId && openableSessionIds.has(state.activeSessionId)
      ? state.activeSessionId
      : (openTabs[openTabs.length - 1] ?? null);
  const draftSession =
    state.draftSession && belongsToWorkspace(state.draftSession, scopedWorkspaceId)
      ? state.draftSession
      : null;
  return { activeSessionId, draftSession, openTabs };
}

export function createDraftSession(): DraftSession {
  const preferences = useAspStore.getState();
  const workspaceId = activeChatWorkspaceId();
  const projectPath = preferences.workspacePath || null;
  return {
    id: uid("draft"),
    workspaceId,
    providerId: preferences.activeProviderId || "codex",
    folderId: null,
    projectPath,
    cwd: projectPath ?? "",
    createdAt: Date.now(),
  };
}

export function createDraftSessionForProject(
  projectPath: string | null,
  providerId?: string,
  folderId?: string | null,
  workspaceId = activeChatWorkspaceId(),
): DraftSession {
  const normalizedProjectPath = projectPath ? normalizeProjectPath(projectPath) : null;
  return {
    ...createDraftSession(),
    workspaceId: chatWorkspaceId(workspaceId),
    providerId: providerId || useAspStore.getState().activeProviderId || "codex",
    folderId: folderId ?? null,
    projectPath: normalizedProjectPath,
    cwd: normalizedProjectPath ?? "",
  };
}

export function createMaterializedSession(
  input: CreateSessionInput = {},
  createdAt = Date.now(),
): Session {
  const preferences = useAspStore.getState();
  const workspaceId = chatWorkspaceId(input.workspaceId ?? activeChatWorkspaceId());
  const projectPath =
    input.projectPath !== undefined ? input.projectPath : preferences.workspacePath || null;
  const cwd = input.cwd !== undefined ? input.cwd : (projectPath ?? "");
  const providerId = input.providerId || preferences.activeProviderId || "codex";
  const participantId = providerParticipantId(providerId);
  return {
    id: input.id || uid("s"),
    workspaceId,
    title: input.title || "New session",
    blocks: [],
    status: "idle",
    connectionState: "disconnected",
    providerId,
    activeParticipantId: participantId,
    conversationRevision: 0,
    agentParticipants: {
      [participantId]: {
        id: participantId,
        providerId,
        role: "primary",
        kind: "provider",
        status: "idle",
        createdAt,
        updatedAt: createdAt,
      },
    },
    workItems: {},
    agentRuns: {},
    handoffs: [],
    projectPath,
    cwd,
    createdAt,
  };
}

export function createImportedSession(input: ImportProviderSessionInput): Session {
  const providerSession = input.providerSession;
  const workspaceId = chatWorkspaceId(input.workspaceId ?? activeChatWorkspaceId());
  const projectPath =
    input.projectPath !== undefined
      ? input.projectPath
      : (providerSession.projectPath ?? providerSession.cwd ?? null);
  const cwd = providerSession.cwd || projectPath || "";
  const usage = tokenUsageFromAsp(providerSession.usage);
  const extensionSessionState = {
    providerSessionId: providerSession.id,
    title: providerSession.title,
    cwd,
    model: providerSession.model,
    context: providerSession.context,
    usage: providerSession.usage,
    metadata: providerSession.metadata,
  };
  const createdAt = providerSession.createdAt ?? Date.now();
  const participantId = providerParticipantId(input.providerId);
  const session: Session = {
    id: uid("s"),
    workspaceId,
    title: providerSession.title || "Imported session",
    blocks: [],
    status: "idle",
    connectionState: "disconnected",
    providerId: input.providerId,
    activeParticipantId: participantId,
    projectPath,
    cwd,
    providerSessionId: providerSession.id,
    conversationRevision: 0,
    agentParticipants: {
      [participantId]: {
        id: participantId,
        providerId: input.providerId,
        role: "primary",
        kind: "provider",
        backendSessionId: providerSession.id,
        status: "idle",
        createdAt,
        updatedAt: createdAt,
      },
    },
    workItems: {},
    agentRuns: {},
    handoffs: [],
    usage,
    extensionState: { session: extensionSessionState },
    createdAt,
  };
  return {
    ...session,
    contextUsage: contextUsageForSession(session, useAspStore.getState().providers),
  };
}

export function normalizeSessionFolderId(
  folderId: string | null | undefined,
  folders: SessionFolder[],
  projectKey?: string,
  workspaceId?: string,
): string | null {
  const folder = folderId ? folders.find((item) => item.id === folderId) : undefined;
  if (!folder) return null;
  if (projectKey !== undefined && folder.projectKey !== projectKey) return null;
  if (workspaceId !== undefined && workspaceScopedId(folder) !== chatWorkspaceId(workspaceId)) {
    return null;
  }
  return folder.id;
}

export function normalizeSessionTreeState(
  sessions: Session[],
  folders: SessionFolder[] | undefined,
  placements: Record<string, SessionPlacement> | undefined,
): {
  folders: SessionFolder[];
  placements: Record<string, SessionPlacement>;
} {
  const folderById = new Map((folders ?? []).map((folder) => [folder.id, folder]));
  const normalizedFolders = (folders ?? []).map((folder, index) => {
    const projectKey = folder.projectKey || "private";
    const workspaceId = workspaceScopedId(folder);
    const parentId =
      folder.parentId &&
      (folderById.get(folder.parentId)?.projectKey || "private") === projectKey &&
      workspaceScopedId(folderById.get(folder.parentId)) === workspaceId &&
      !folderWouldDescendInto(folder.id, folder.parentId, folderById)
        ? folder.parentId
        : null;
    return {
      ...folder,
      workspaceId,
      projectKey,
      projectPath: folder.projectPath ?? projectPathFromProjectKey(projectKey),
      parentId,
      color: folder.color || DEFAULT_SESSION_FOLDER_COLOR,
      icon: folder.icon || DEFAULT_SESSION_FOLDER_ICON,
      order: Number.isFinite(folder.order) ? folder.order : index * SESSION_TREE_ORDER_STEP,
      createdAt: Number.isFinite(folder.createdAt) ? folder.createdAt : Date.now(),
    };
  });
  const normalizedFolderIds = new Set(normalizedFolders.map((folder) => folder.id));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const normalizedPlacements: Record<string, SessionPlacement> = {};
  sessions.forEach((session, index) => {
    const placement = placements?.[session.id];
    const folder = placement?.folderId ? folderById.get(placement.folderId) : undefined;
    const projectKey = sessionProjectKey(session);
    const workspaceId = workspaceScopedId(session);
    normalizedPlacements[session.id] = {
      folderId:
        folder &&
        normalizedFolderIds.has(folder.id) &&
        (folder.projectKey || "private") === projectKey &&
        workspaceScopedId(folder) === workspaceId
          ? folder.id
          : null,
      order:
        placement && Number.isFinite(placement.order)
          ? placement.order
          : index * SESSION_TREE_ORDER_STEP,
    };
  });
  for (const [sessionId, placement] of Object.entries(placements ?? {})) {
    if (!sessionIds.has(sessionId)) continue;
    const session = sessions.find((item) => item.id === sessionId);
    const folder = placement.folderId ? folderById.get(placement.folderId) : undefined;
    const projectKey = session ? sessionProjectKey(session) : "";
    const workspaceId = workspaceScopedId(session);
    normalizedPlacements[sessionId] = {
      folderId:
        folder &&
        normalizedFolderIds.has(folder.id) &&
        (folder.projectKey || "private") === projectKey &&
        workspaceScopedId(folder) === workspaceId
          ? folder.id
          : null,
      order: Number.isFinite(placement.order)
        ? placement.order
        : (normalizedPlacements[sessionId]?.order ?? 0),
    };
  }
  return { folders: normalizedFolders, placements: normalizedPlacements };
}

export function sessionProjectKey(session: {
  cwd?: string;
  privateSessionPath?: string;
  projectPath?: string | null;
}): string {
  const rawProjectPath =
    session.projectPath !== undefined
      ? session.projectPath
      : session.privateSessionPath
        ? null
        : session.cwd || null;
  const projectPath = rawProjectPath ? normalizeProjectPath(rawProjectPath) : rawProjectPath;
  return projectPath ? `project:${projectPath}` : "private";
}

export function nextActiveSessionInProject(
  removedSession: Session,
  sessions: Session[],
  openTabs: string[],
): string | null {
  const projectKey = sessionProjectKey(removedSession);
  const workspaceId = workspaceScopedId(removedSession);
  const visibleSessions = sessions.filter((session) => !session.archivedAt);
  const visibleById = new Map(visibleSessions.map((session) => [session.id, session]));
  for (let index = openTabs.length - 1; index >= 0; index -= 1) {
    const candidate = visibleById.get(openTabs[index] ?? "");
    if (
      candidate &&
      sessionProjectKey(candidate) === projectKey &&
      workspaceScopedId(candidate) === workspaceId
    ) {
      return candidate.id;
    }
  }
  return (
    visibleSessions.find(
      (session) =>
        sessionProjectKey(session) === projectKey && workspaceScopedId(session) === workspaceId,
    )?.id ?? null
  );
}

export function projectPathFromProjectKey(projectKey: string): string | null {
  return projectKey.startsWith("project:") ? projectKey.slice("project:".length) : null;
}

export function normalizeProjectPath(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

export function normalizeSessionProjectKey(projectKeyOrPath: string): string {
  const trimmed = projectKeyOrPath.trim();
  const projectPath = trimmed.startsWith("project:") ? trimmed.slice("project:".length) : trimmed;
  const normalized = normalizeProjectPath(projectPath);
  return normalized ? `project:${normalized}` : "private";
}

export function projectName(projectPath: string): string {
  return (
    projectPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || projectPath
  );
}

export function sessionProjectRecord(
  projectPath: string | null | undefined,
  createdAt = Date.now(),
  workspaceId = activeChatWorkspaceId(),
): SessionProject | null {
  const normalized = normalizeProjectPath((projectPath ?? "").trim());
  if (!normalized) return null;
  return {
    key: `project:${normalized}`,
    workspaceId: chatWorkspaceId(workspaceId),
    label: projectName(normalized),
    projectPath: normalized,
    createdAt,
  };
}

export function normalizeSessionProjects(projects: SessionProject[] | undefined): SessionProject[] {
  const byKey = new Map<string, SessionProject>();
  for (const project of projects ?? []) {
    const projectPath = project.projectPath || projectPathFromProjectKey(project.key);
    const normalized = sessionProjectRecord(
      projectPath,
      project.createdAt,
      workspaceScopedId(project),
    );
    if (!normalized) continue;
    const scopedKey = `${workspaceScopedId(normalized)}:${normalized.key}`;
    const existing = byKey.get(scopedKey);
    byKey.set(scopedKey, {
      ...normalized,
      label: project.label?.trim() || normalized.label,
      createdAt: Math.max(existing?.createdAt ?? 0, normalized.createdAt),
    });
  }
  return [...byKey.values()];
}

export function upsertSessionProject(
  projects: SessionProject[],
  projectPath: string | null | undefined,
  createdAt = Date.now(),
  workspaceId = activeChatWorkspaceId(),
): SessionProject[] {
  const record = sessionProjectRecord(projectPath, createdAt, workspaceId);
  if (!record) return projects;
  const recordWorkspaceId = workspaceScopedId(record);
  const existing = projects.find(
    (project) => project.key === record.key && workspaceScopedId(project) === recordWorkspaceId,
  );
  if (!existing) return normalizeSessionProjects([...projects, record]);
  return normalizeSessionProjects(
    projects.map((project) =>
      project.key === record.key && workspaceScopedId(project) === recordWorkspaceId
        ? {
            ...project,
            workspaceId: recordWorkspaceId,
            label: record.label,
            projectPath: record.projectPath,
            createdAt: project.createdAt,
          }
        : project,
    ),
  );
}

export function folderWouldDescendInto(
  folderId: string,
  candidateParentId: string | null | undefined,
  folderById: Map<string, SessionFolder>,
): boolean {
  let cursor = candidateParentId ?? null;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === folderId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = folderById.get(cursor)?.parentId ?? null;
  }
  return false;
}

export function nextFolderOrder(
  parentId: string | null,
  projectKey: string,
  folders: SessionFolder[],
  workspaceId: string,
): number {
  const orders = folders
    .filter(
      (folder) =>
        folder.parentId === parentId &&
        (folder.projectKey || "private") === projectKey &&
        workspaceScopedId(folder) === chatWorkspaceId(workspaceId),
    )
    .map((folder) => folder.order)
    .filter(Number.isFinite);
  return (orders.length ? Math.max(...orders) : 0) + SESSION_TREE_ORDER_STEP;
}

export function placementOrderAtStart(
  folderId: string | null,
  projectKey: string,
  sessions: Session[],
  placements: Record<string, SessionPlacement>,
  workspaceId: string,
): number {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const orders = Object.entries(placements)
    .filter(([sessionId, placement]) => {
      const session = sessionById.get(sessionId);
      return Boolean(
        session &&
        placement.folderId === folderId &&
        sessionProjectKey(session) === projectKey &&
        workspaceScopedId(session) === chatWorkspaceId(workspaceId),
      );
    })
    .map(([, placement]) => placement.order)
    .filter(Number.isFinite);
  return (orders.length ? Math.min(...orders) : SESSION_TREE_ORDER_STEP) - SESSION_TREE_ORDER_STEP;
}

export function placementOrderAtEnd(
  folderId: string | null,
  projectKey: string,
  sessions: Session[],
  placements: Record<string, SessionPlacement>,
  workspaceId: string,
): number {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const orders = Object.entries(placements)
    .filter(([sessionId, placement]) => {
      const session = sessionById.get(sessionId);
      return Boolean(
        session &&
        placement.folderId === folderId &&
        sessionProjectKey(session) === projectKey &&
        workspaceScopedId(session) === chatWorkspaceId(workspaceId),
      );
    })
    .map(([, placement]) => placement.order)
    .filter(Number.isFinite);
  return (orders.length ? Math.max(...orders) : 0) + SESSION_TREE_ORDER_STEP;
}

export function childFolderIds(folderId: string, folders: SessionFolder[]): Set<string> {
  const ids = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function moveSessionPlacement(
  sessions: Session[],
  folders: SessionFolder[],
  placements: Record<string, SessionPlacement>,
  input: MoveSessionInTreeInput,
): Record<string, SessionPlacement> {
  const movingSession = sessions.find((session) => session.id === input.sessionId);
  if (!movingSession) return placements;
  if (input.targetSessionId === input.sessionId) return placements;

  const movingProjectKey = sessionProjectKey(movingSession);
  const movingWorkspaceId = workspaceScopedId(movingSession);
  const targetSession = input.targetSessionId
    ? sessions.find((session) => session.id === input.targetSessionId)
    : undefined;
  if (
    targetSession &&
    (sessionProjectKey(targetSession) !== movingProjectKey ||
      workspaceScopedId(targetSession) !== movingWorkspaceId)
  ) {
    return placements;
  }

  const destinationFolderId = normalizeSessionFolderId(
    input.folderId,
    folders,
    movingProjectKey,
    movingWorkspaceId,
  );
  const normalized = normalizeSessionTreeState(sessions, folders, placements).placements;
  const sourceFolderId = normalized[input.sessionId]?.folderId ?? null;
  const affectedFolderIds = new Set([sourceFolderId, destinationFolderId]);
  const next = { ...normalized };

  for (const folderId of affectedFolderIds) {
    const ordered = sessions
      .filter((session) => session.id !== input.sessionId)
      .filter(
        (session) =>
          sessionProjectKey(session) === movingProjectKey &&
          workspaceScopedId(session) === movingWorkspaceId,
      )
      .filter((session) => (normalized[session.id]?.folderId ?? null) === folderId)
      .sort((a, b) => {
        const left = normalized[a.id]?.order ?? 0;
        const right = normalized[b.id]?.order ?? 0;
        return left === right ? b.createdAt - a.createdAt : left - right;
      })
      .map((session) => session.id);

    if (folderId === destinationFolderId) {
      let index = ordered.length;
      if (input.targetSessionId) {
        const targetIndex = ordered.indexOf(input.targetSessionId);
        if (targetIndex >= 0) {
          index = input.position === "after" ? targetIndex + 1 : targetIndex;
        }
      } else if (input.position !== "end") {
        index = 0;
      }
      ordered.splice(index, 0, input.sessionId);
    }

    ordered.forEach((sessionId, index) => {
      next[sessionId] = {
        folderId,
        order: (index + 1) * SESSION_TREE_ORDER_STEP,
      };
    });
  }

  return next;
}
