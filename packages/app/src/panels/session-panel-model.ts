import type { CSSProperties } from "react";
import {
  Archive,
  BookOpen,
  Bot,
  Briefcase,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  Hash,
  Inbox,
  type LucideIcon,
} from "lucide-react";
import {
  chatWorkspaceId,
  providerSessionIdFromAgentSession,
  useChatStore,
} from "@/chat/chat-store";
import {
  actionableProviderSessionId,
  providerSessionIdFromExtensionState,
  transcriptPathFromSession,
} from "@/chat/session-metadata";
import type { AspProvider, AspProviderSession } from "@/asp/desktop-api";
import type { Session, SessionFolder, SessionPlacement, SessionProject } from "@/chat/types";
import type { TranslateFn } from "@/lib/i18n";

export type SessionListItem = Pick<
  Session,
  | "id"
  | "title"
  | "providerId"
  | "projectPath"
  | "privateSessionPath"
  | "cwd"
  | "createdAt"
  | "status"
  | "connectionState"
  | "providerSessionId"
  | "agentSessions"
  | "retiredAgentSessions"
> & {
  pinnedAt?: number;
  projectKey: string;
  projectLabel: string;
  projectTitle: string;
  transcriptPath?: string;
  treeFolderId: string | null;
  treeOrder: number;
};

export type ImportableProviderSession = AspProviderSession & {
  context?: {
    usedTokens?: number;
    windowTokens?: number;
    autoCompaction?: boolean;
  };
  usage?: {
    contextTokens?: number;
    contextWindowTokens?: number;
    inputCachedTokens: number;
    inputTokens: number;
    outputCachedTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type ImportTarget = {
  folderId: string | null;
  label: string;
  projectKey: string;
  projectPath: string | null;
};

export type ImportAgentGroup = {
  error?: string;
  loading: boolean;
  provider: AspProvider;
  sessions: ImportableProviderSession[];
};

export type ImportState = {
  loading: boolean;
  groups: ImportAgentGroup[];
};

export type FolderDialogState =
  | { mode: "create"; parentId: string | null; projectKey: string; projectPath: string | null }
  | { mode: "edit"; folder: SessionFolder }
  | null;

export type FolderDraft = {
  color: string;
  icon: string;
  name: string;
};

export type FolderTreeNode = SessionFolder & {
  children: FolderTreeNode[];
  sessions: SessionListItem[];
};

export type ProjectTree = {
  folders: FolderTreeNode[];
  sessions: SessionListItem[];
};

export type ProjectGroup = ProjectTree & {
  key: string;
  label: string;
  latestCreatedAt: number;
  projectPath: string | null;
  title: string;
};

export type ProjectActionTarget = Pick<ProjectGroup, "key" | "label" | "projectPath" | "title">;

export type AnchoredMenuState = {
  open: boolean;
  x: number;
  y: number;
};

export type DragTarget =
  | { kind: "folder"; folderId: string | null; projectKey: string }
  | { kind: "root"; folderId: string | null; projectKey: string }
  | {
      folderId: string | null;
      kind: "session";
      position: "before" | "after";
      projectKey: string;
      targetSessionId: string;
    }
  | null;

export type FolderIconOption = {
  icon: LucideIcon;
  id: string;
  label: string;
};

export type FolderColorOption = {
  color: string;
  label: string;
};

export const IMPORT_AGENT_LOAD_TIMEOUT_MS = 10_000;
export const SESSION_DRAG_TYPE = "application/x-agui-session-id";
export const DEFAULT_FOLDER_COLOR = "#3b82f6";
export const DEFAULT_FOLDER_ICON = "folder";

export const FOLDER_ICON_OPTIONS: FolderIconOption[] = [
  { id: "folder", label: "Folder", icon: Folder },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "briefcase", label: "Work", icon: Briefcase },
  { id: "book", label: "Research", icon: BookOpen },
  { id: "code", label: "Code", icon: Code2 },
  { id: "bot", label: "Agent", icon: Bot },
  { id: "file", label: "Document", icon: FileText },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "hash", label: "Topic", icon: Hash },
];

export const FOLDER_COLORS: FolderColorOption[] = [
  { color: "#3b82f6", label: "Blue" },
  { color: "#14b8a6", label: "Teal" },
  { color: "#22c55e", label: "Green" },
  { color: "#eab308", label: "Yellow" },
  { color: "#f97316", label: "Orange" },
  { color: "#ef4444", label: "Red" },
  { color: "#a855f7", label: "Violet" },
  { color: "#64748b", label: "Slate" },
];

export function selectSessionListItems(
  sessions: Session[],
  placements: Record<string, SessionPlacement>,
  t: TranslateFn,
  workspaceId: string,
  options: { includeHiddenExtensionTree?: boolean } = {},
): SessionListItem[] {
  const placementFallback = new Map(sessions.map((session, index) => [session.id, index * 1000]));
  return sessions
    .filter(
      (session) =>
        !session.archivedAt &&
        (options.includeHiddenExtensionTree ||
          !session.extensionState?.sessionTree?.hideInSessionList) &&
        chatWorkspaceId(session.workspaceId) === workspaceId,
    )
    .map((session) => {
      const placement = placements[session.id];
      const project = sessionProject(session, t);
      const providerSessionId =
        session.providerSessionId || providerSessionIdFromExtensionState(session);
      return {
        id: session.id,
        title: session.title,
        providerId: session.providerId,
        projectPath: session.projectPath,
        privateSessionPath: session.privateSessionPath,
        cwd: session.cwd,
        providerSessionId: actionableProviderSessionId(providerSessionId),
        agentSessions: session.agentSessions,
        retiredAgentSessions: session.retiredAgentSessions,
        transcriptPath: transcriptPathFromSession(session) || undefined,
        createdAt: session.createdAt,
        pinnedAt: session.pinnedAt,
        status: session.status,
        connectionState: session.connectionState,
        projectKey: project.key,
        projectLabel: project.label,
        projectTitle: project.title,
        treeFolderId: placement?.folderId ?? null,
        treeOrder: placement?.order ?? placementFallback.get(session.id) ?? 0,
      };
    });
}

export function buildProjectGroups(
  sessions: SessionListItem[],
  folders: SessionFolder[],
  projects: SessionProject[],
  placements: Record<string, SessionPlacement>,
  workspacePath: string,
  t: TranslateFn,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const ensureProject = (project: {
    key: string;
    label: string;
    projectPath: string | null;
    title: string;
  }): ProjectGroup => {
    const existing = groups.get(project.key);
    if (existing) return existing;
    const group: ProjectGroup = {
      ...project,
      folders: [],
      latestCreatedAt: 0,
      sessions: [],
    };
    groups.set(project.key, group);
    return group;
  };

  for (const project of projects) {
    const projectPath = normalizePath(
      project.projectPath || projectPathFromProjectKey(project.key) || "",
    );
    if (!projectPath) continue;
    const group = ensureProject({
      key: `project:${projectPath}`,
      label: project.label || projectName(projectPath),
      projectPath,
      title: projectPath,
    });
    group.latestCreatedAt = Math.max(group.latestCreatedAt, project.createdAt);
  }

  for (const session of sessions) {
    const group = ensureProject({
      key: session.projectKey,
      label: session.projectLabel,
      projectPath: sessionProjectPath(session),
      title: session.projectTitle,
    });
    group.latestCreatedAt = Math.max(group.latestCreatedAt, session.createdAt);
  }

  for (const folder of folders) {
    ensureProject(projectFromFolder(folder, t));
  }

  const normalizedWorkspacePath = normalizePath(workspacePath.trim());
  if (normalizedWorkspacePath) {
    ensureProject({
      key: `project:${normalizedWorkspacePath}`,
      label: projectName(normalizedWorkspacePath),
      projectPath: normalizedWorkspacePath,
      title: normalizedWorkspacePath,
    });
  }

  for (const group of groups.values()) {
    buildProjectTree(group, folders, sessions, placements);
  }

  return [...groups.values()];
}

export function buildProjectTree(
  group: ProjectGroup,
  folders: SessionFolder[],
  sessions: SessionListItem[],
  placements: Record<string, SessionPlacement>,
): void {
  const groupFolders = folders.filter((folder) => (folder.projectKey || "private") === group.key);
  const nodes = new Map<string, FolderTreeNode>();
  for (const folder of groupFolders) {
    nodes.set(folder.id, { ...folder, children: [], sessions: [] });
  }
  for (const folder of groupFolders) {
    const node = nodes.get(folder.id);
    if (!node) continue;
    const parent = folder.parentId ? nodes.get(folder.parentId) : undefined;
    if (parent && !folderWouldDescendInto(folder.id, parent.id, nodes)) parent.children.push(node);
    else group.folders.push(node);
  }
  for (const session of sessions.filter((item) => item.projectKey === group.key)) {
    const placement = placements[session.id];
    const folderId =
      placement?.folderId && nodes.has(placement.folderId) ? placement.folderId : null;
    const item = {
      ...session,
      treeFolderId: folderId,
      treeOrder: placement?.order ?? session.treeOrder,
    };
    if (folderId) nodes.get(folderId)?.sessions.push(item);
    else group.sessions.push(item);
  }
  sortSessionTree(group.folders, group.sessions);
}

export function projectHasSession(project: ProjectGroup, sessionId: string): boolean {
  return (
    project.sessions.some((session) => session.id === sessionId) ||
    project.folders.some((folder) => folderTreeHasSession(folder, sessionId))
  );
}

export function folderTreeHasSession(folder: FolderTreeNode, sessionId: string): boolean {
  return (
    folder.sessions.some((session) => session.id === sessionId) ||
    folder.children.some((child) => folderTreeHasSession(child, sessionId))
  );
}

export function projectDefaultSessionId(
  project: ProjectGroup,
  rememberedSessions: Map<string, string>,
): string | null {
  const rememberedId = rememberedSessions.get(project.key);
  if (rememberedId && projectHasSession(project, rememberedId)) return rememberedId;
  return firstProjectSession(project)?.id ?? null;
}

export function firstProjectSession(project: ProjectGroup): SessionListItem | null {
  for (const folder of project.folders) {
    const session = firstFolderSession(folder);
    if (session) return session;
  }
  return project.sessions[0] ?? null;
}

export function firstFolderSession(folder: FolderTreeNode): SessionListItem | null {
  if (folder.sessions[0]) return folder.sessions[0];
  for (const child of folder.children) {
    const session = firstFolderSession(child);
    if (session) return session;
  }
  return null;
}

export function sortSessionTree(folders: FolderTreeNode[], sessions: SessionListItem[]): void {
  folders.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  sessions.sort((a, b) => {
    if (a.pinnedAt || b.pinnedAt) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    return a.treeOrder - b.treeOrder || b.createdAt - a.createdAt;
  });
  for (const folder of folders) {
    sortSessionTree(folder.children, folder.sessions);
  }
}

export function folderWouldDescendInto(
  folderId: string,
  candidateParentId: string,
  nodes: Map<string, { parentId: string | null }>,
): boolean {
  let cursor: string | null = candidateParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === folderId || seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = nodes.get(cursor)?.parentId ?? null;
  }
  return false;
}

export function folderIcon(icon: string, collapsed: boolean): LucideIcon {
  if (icon === DEFAULT_FOLDER_ICON) return collapsed ? Folder : FolderOpen;
  return FOLDER_ICON_OPTIONS.find((option) => option.id === icon)?.icon ?? Folder;
}

export function folderRowStyle(color: string, active: boolean): CSSProperties {
  const folderColor = color || DEFAULT_FOLDER_COLOR;
  return {
    backgroundColor: alpha(folderColor, active ? 0.22 : 0.12),
  };
}

export function alpha(hex: string, opacity: number): string {
  const normalized = hex.trim();
  if (!/^#[\da-f]{6}$/i.test(normalized)) return `rgba(59, 130, 246, ${opacity})`;
  const value = Number.parseInt(normalized.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function sessionInProgress(session: SessionListItem): boolean {
  return (
    session.status === "streaming" ||
    session.connectionState === "connecting" ||
    session.connectionState === "running"
  );
}

export function sessionProject(
  session: {
    cwd?: string;
    privateSessionPath?: string;
    projectPath?: string | null;
  },
  t: TranslateFn,
): {
  key: string;
  label: string;
  projectPath: string | null;
  title: string;
} {
  const projectPath = sessionProjectPath(session);
  if (!projectPath) {
    return {
      key: "private",
      label: t("sessions.noProject"),
      projectPath: null,
      title: session.privateSessionPath || t("sessions.privateSessions"),
    };
  }
  return {
    key: `project:${projectPath}`,
    label: projectName(projectPath),
    projectPath,
    title: projectPath,
  };
}

export function sessionProjectPath(session: {
  cwd?: string;
  privateSessionPath?: string;
  projectPath?: string | null;
}): string | null {
  const rawProjectPath =
    session.projectPath !== undefined
      ? session.projectPath
      : session.privateSessionPath
        ? null
        : session.cwd || null;
  return rawProjectPath ? normalizePath(rawProjectPath) : null;
}

export function projectFromFolder(
  folder: SessionFolder,
  t: TranslateFn,
): {
  key: string;
  label: string;
  projectPath: string | null;
  title: string;
} {
  const key = folder.projectKey || "private";
  const projectPath = folder.projectPath ?? projectPathFromProjectKey(key);
  if (!projectPath) {
    return {
      key,
      label: t("sessions.noProject"),
      projectPath: null,
      title: t("sessions.privateSessions"),
    };
  }
  return {
    key,
    label: projectName(projectPath),
    projectPath,
    title: projectPath,
  };
}

export function projectPathFromProjectKey(projectKey: string): string | null {
  return projectKey.startsWith("project:") ? projectKey.slice("project:".length) : null;
}

export function importProvidersForDialog(
  providers: AspProvider[],
  activeProviderId: string,
): AspProvider[] {
  const enabled = providers.filter((provider) => provider.enabled !== false);
  const active = enabled.find((provider) => provider.id === activeProviderId);
  const preferredHistory = enabled.filter(providerCanImportSessions);
  const candidates = [active, ...preferredHistory, ...enabled].filter(
    (provider): provider is AspProvider => Boolean(provider),
  );
  return [...new Map(candidates.map((provider) => [provider.id, provider])).values()];
}

export function replaceImportAgentGroup(
  groups: ImportAgentGroup[],
  providerId: string,
  nextGroup: ImportAgentGroup,
): ImportAgentGroup[] {
  return groups.map((group) => (group.provider.id === providerId ? nextGroup : group));
}

export function withImportTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function providerCanImportSessions(provider: AspProvider | undefined): boolean {
  const capabilities = provider?.capabilities;
  const adapter = String(capabilities?.runtimeAdapter ?? "").toLowerCase();
  return Boolean(
    provider &&
    (capabilities?.sessions ||
      capabilities?.sessionHistory ||
      capabilities?.resumeSession ||
      adapter === "codex-app-server" ||
      adapter === "opencode-server" ||
      adapter === "opencode-http-sse"),
  );
}

export function providerCanDeleteSessions(provider: AspProvider | undefined): boolean {
  const capabilities = provider?.capabilities;
  const adapter = String(capabilities?.runtimeAdapter ?? "").toLowerCase();
  return Boolean(
    provider &&
    (capabilities?.deleteSession ||
      adapter === "codex-app-server" ||
      adapter === "claude-code-stream-json" ||
      adapter === "grok-agent-stdio" ||
      adapter === "grok-cli" ||
      adapter === "kimi-acp-stdio" ||
      adapter === "kimi-cli" ||
      adapter === "opencode-server" ||
      adapter === "opencode-http-sse"),
  );
}

export function importedProviderSessionIds(providerId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of useChatStore.getState().sessions) {
    if (session.providerId === providerId) {
      const id = session.providerSessionId || providerSessionIdFromExtensionState(session);
      if (id) ids.add(id);
    }
    const activeRoute = session.agentSessions?.[providerId];
    const activeId = activeRoute ? providerSessionIdFromAgentSession(activeRoute) : "";
    if (activeId) ids.add(activeId);
    for (const route of session.retiredAgentSessions ?? []) {
      if (route.providerId !== providerId) continue;
      const retiredId = providerSessionIdFromAgentSession(route);
      if (retiredId) ids.add(retiredId);
    }
  }
  return ids;
}

export function sessionMatchesProject(
  session: AspProviderSession,
  projectPath: string | null,
): boolean {
  const sessionPath = normalizePath(session.projectPath || session.cwd || "");
  if (!projectPath) return !sessionPath;
  return sessionPath === normalizePath(projectPath);
}

export function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

export function projectName(projectPath: string): string {
  return (
    projectPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || projectPath
  );
}
