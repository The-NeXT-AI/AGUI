import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  Download,
  FileText,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import { useSessionTreeRoots, type SessionTreeNode, type SessionTreeRoot } from "@the-next-ai/app";
import {
  agentSessionDeleteKey,
  agentSessionIsProviderBacked,
  chatWorkspaceId,
  useChatStore,
} from "@/chat/chat-store";
import { useAspStore } from "@/asp/asp-store";
import { desktopApi, type AspProvider } from "@/asp/desktop-api";
import { AgentLogo } from "@/asp/AgentLogo";
import { cn } from "@/ui/cn";
import { confirmDialog } from "@/ui/confirm-dialog";
import { useUIStore } from "@/ui/ui-store";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { AgentSessionState, SessionFolder } from "@/chat/types";
import { useT } from "@/lib/i18n";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import { ImportAgentSection } from "./ImportAgentSection";
import { ProjectSessionItems } from "./ProjectSessionItems";
import { DropZone } from "./SessionDropZone";
import {
  DEFAULT_FOLDER_COLOR,
  DEFAULT_FOLDER_ICON,
  FOLDER_COLORS,
  FOLDER_ICON_OPTIONS,
  IMPORT_AGENT_LOAD_TIMEOUT_MS,
  SESSION_DRAG_TYPE,
  alpha,
  buildProjectGroups,
  errorMessage,
  folderIcon,
  folderRowStyle,
  importedProviderSessionIds,
  importProvidersForDialog,
  normalizePath,
  projectDefaultSessionId,
  projectHasSession,
  providerCanDeleteSessions,
  providerCanImportSessions,
  replaceImportAgentGroup,
  selectSessionListItems,
  sessionInProgress,
  sessionMatchesProject,
  withImportTimeout,
  type AnchoredMenuState,
  type DragTarget,
  type FolderDialogState,
  type FolderDraft,
  type FolderTreeNode,
  type ImportAgentGroup,
  type ImportState,
  type ImportTarget,
  type ImportableProviderSession,
  type ProjectActionTarget,
  type ProjectGroup,
  type SessionListItem,
} from "./session-panel-model";

/** Sidebar panel: a user-managed multi-level session tree. */
export function SessionsPanel() {
  const t = useT();
  const activeWorkspaceId = useWorkspaceStore((s) => chatWorkspaceId(s.activeWorkspaceId));
  const allSessions = useChatStore((s) => s.sessions);
  const allSessionProjects = useChatStore((s) => s.sessionProjects);
  const allFolders = useChatStore((s) => s.sessionFolders);
  const placements = useChatStore((s) => s.sessionPlacements);
  const extensionTreeRoots = useSessionTreeRoots();
  const sessions = useMemo(
    () => selectSessionListItems(allSessions, placements, t, activeWorkspaceId),
    [activeWorkspaceId, allSessions, placements, t],
  );
  const draggableSessions = useMemo(
    () =>
      selectSessionListItems(allSessions, placements, t, activeWorkspaceId, {
        includeHiddenExtensionTree: true,
      }),
    [activeWorkspaceId, allSessions, placements, t],
  );
  const draggableSessionById = useMemo(
    () => new Map(draggableSessions.map((session) => [session.id, session])),
    [draggableSessions],
  );
  const sessionProjects = useMemo(
    () =>
      allSessionProjects.filter(
        (project) => chatWorkspaceId(project.workspaceId) === activeWorkspaceId,
      ),
    [activeWorkspaceId, allSessionProjects],
  );
  const folders = useMemo(
    () => allFolders.filter((folder) => chatWorkspaceId(folder.workspaceId) === activeWorkspaceId),
    [activeWorkspaceId, allFolders],
  );
  const activeId = useChatStore((s) => s.activeSessionId);
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId),
  );
  const openSession = useChatStore((s) => s.openSession);
  const openExtensionSession = useChatStore((s) => s.openExtensionSession);
  const materializeExtensionSession = useChatStore((s) => s.materializeExtensionSession);
  const removeSession = useChatStore((s) => s.removeSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const importProviderSession = useChatStore((s) => s.importProviderSession);
  const startDraftSession = useChatStore((s) => s.startDraftSession);
  const setDraftSessionFolder = useChatStore((s) => s.setDraftSessionFolder);
  const setDraftWorkspace = useChatStore((s) => s.setDraftWorkspace);
  const addSessionProject = useChatStore((s) => s.addSessionProject);
  const createSessionFolder = useChatStore((s) => s.createSessionFolder);
  const updateSessionFolder = useChatStore((s) => s.updateSessionFolder);
  const deleteSessionFolder = useChatStore((s) => s.deleteSessionFolder);
  const moveSessionInTree = useChatStore((s) => s.moveSessionInTree);
  const providers = useAspStore((s) => s.providers);
  const workspacePath = useAspStore((s) => s.workspacePath);
  const chooseWorkspace = useAspStore((s) => s.chooseWorkspace);
  const closeExtensions = useUIStore((s) => s.closeExtensions);
  const closeSchedule = useUIStore((s) => s.closeSchedule);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const setSidebarProjectNavItems = useUIStore((s) => s.setSidebarProjectNavItems);
  const activeProjectIndex = useUIStore((s) => s.sidebarProjectNavIndex);
  const setActiveProjectIndex = useUIStore((s) => s.setSidebarProjectNavIndex);
  const sidebarSessionActionRequest = useUIStore((s) => s.sidebarSessionActionRequest);

  const projectGroups = useMemo(
    () => buildProjectGroups(sessions, folders, sessionProjects, placements, workspacePath, t),
    [folders, placements, sessionProjects, sessions, workspacePath, t],
  );
  const sortedExtensionTreeRoots = useMemo(
    () => sortExtensionTreeRoots(extensionTreeRoots),
    [extensionTreeRoots],
  );
  const extensionSessionByNode = useMemo(() => {
    const map = new Map<string, (typeof allSessions)[number]>();
    for (const session of allSessions) {
      const context = session.extensionState?.sessionTree;
      if (!context || session.archivedAt) continue;
      if (chatWorkspaceId(session.workspaceId) !== activeWorkspaceId) continue;
      map.set(extensionSessionKey(context.extensionId, context.nodeId), session);
    }
    return map;
  }, [activeWorkspaceId, allSessions]);
  const activeExtensionContext = activeSession?.extensionState?.sessionTree;
  const activeProjectKey = projectGroups[activeProjectIndex]?.key ?? null;
  const activeProjectGroup =
    projectGroups[Math.min(activeProjectIndex, Math.max(projectGroups.length - 1, 0))];
  const activeProject: ProjectActionTarget = activeProjectGroup ?? {
    key: "private",
    label: t("sessions.noProject"),
    projectPath: null,
    title: t("sessions.privateSessions"),
  };
  const previousActiveIdRef = useRef(activeId);
  const previousActiveProjectKeyRef = useRef(activeProjectKey);
  const projectNavFromActiveSessionRef = useRef<string | null>(null);
  const lastActiveSessionByProjectRef = useRef<Map<string, string>>(new Map());
  const initialWorkspaceProjectSyncRef = useRef(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SessionListItem | null>(null);
  const [deleteAction, setDeleteAction] = useState<"delete" | "remove" | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  const [importState, setImportState] = useState<ImportState>({
    groups: [],
    loading: false,
  });
  const [expandedImportAgents, setExpandedImportAgents] = useState<Set<string>>(() => new Set());
  const [folderDialog, setFolderDialog] = useState<FolderDialogState>(null);
  const [folderDraft, setFolderDraft] = useState<FolderDraft>(() => ({
    color: DEFAULT_FOLDER_COLOR,
    icon: DEFAULT_FOLDER_ICON,
    name: "",
  }));
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [blankContextMenu, setBlankContextMenu] = useState<AnchoredMenuState>({
    open: false,
    x: 0,
    y: 0,
  });
  const [sessionContextMenu, setSessionContextMenu] = useState<
    AnchoredMenuState & {
      session: SessionListItem | null;
    }
  >({
    open: false,
    session: null,
    x: 0,
    y: 0,
  });
  const [folderContextMenu, setFolderContextMenu] = useState<
    AnchoredMenuState & {
      folder: SessionFolder | null;
      projectKey: string;
      projectLabel: string;
      projectPath: string | null;
    }
  >({
    folder: null,
    open: false,
    projectKey: "private",
    projectLabel: "",
    projectPath: null,
    x: 0,
    y: 0,
  });

  useEffect(() => {
    setSidebarProjectNavItems(
      projectGroups.map((project) => ({
        key: project.key,
        label: project.label,
        projectPath: project.projectPath,
        title: project.title,
      })),
    );
  }, [projectGroups, setSidebarProjectNavItems]);

  useEffect(() => {
    if (projectGroups.length === 0) setActiveProjectIndex(0);
    else if (activeProjectIndex >= projectGroups.length)
      setActiveProjectIndex(projectGroups.length - 1);
  }, [activeProjectIndex, projectGroups.length, setActiveProjectIndex]);

  useEffect(() => {
    if (initialWorkspaceProjectSyncRef.current || activeId) return;
    const normalizedWorkspacePath = normalizePath(workspacePath.trim());
    if (!normalizedWorkspacePath) return;
    const index = projectGroups.findIndex(
      (project) => normalizePath(project.projectPath ?? "") === normalizedWorkspacePath,
    );
    if (index < 0) return;
    initialWorkspaceProjectSyncRef.current = true;
    if (index !== activeProjectIndex) setActiveProjectIndex(index);
  }, [activeId, activeProjectIndex, projectGroups, setActiveProjectIndex, workspacePath]);

  useEffect(() => {
    if (!activeId) return;
    const index = projectGroups.findIndex((project) => projectHasSession(project, activeId));
    if (index < 0) return;
    const projectKey = projectGroups[index]?.key ?? null;
    if (projectKey) lastActiveSessionByProjectRef.current.set(projectKey, activeId);

    const projectNavChanged = previousActiveProjectKeyRef.current !== activeProjectKey;
    const activeSessionChanged = previousActiveIdRef.current !== activeId;
    if (projectNavChanged && !activeSessionChanged && projectKey !== activeProjectKey) return;
    if (index === activeProjectIndex) return;

    projectNavFromActiveSessionRef.current = projectKey;
    setActiveProjectIndex(index);
  }, [activeId, activeProjectIndex, activeProjectKey, projectGroups, setActiveProjectIndex]);

  useEffect(() => {
    const project = projectGroups[activeProjectIndex];
    if (!project) return;
    if (previousActiveProjectKeyRef.current === project.key) return;
    if (projectNavFromActiveSessionRef.current === project.key) {
      projectNavFromActiveSessionRef.current = null;
      return;
    }
    if (activeId && projectHasSession(project, activeId)) return;

    closeExtensions();
    closeSchedule();
    closeSettings();
    const sessionId = projectDefaultSessionId(project, lastActiveSessionByProjectRef.current);
    if (sessionId) {
      openSession(sessionId);
      return;
    }
    startDraftSession();
    setDraftWorkspace(project.projectPath);
    setDraftSessionFolder(null);
  }, [
    activeId,
    activeProjectIndex,
    closeExtensions,
    closeSchedule,
    closeSettings,
    openSession,
    projectGroups,
    setDraftSessionFolder,
    setDraftWorkspace,
    startDraftSession,
  ]);

  useEffect(() => {
    previousActiveIdRef.current = activeId;
    previousActiveProjectKeyRef.current = activeProjectKey;
  }, [activeId, activeProjectKey]);

  const startEdit = (s: SessionListItem) => {
    setEditingId(s.id);
    setDraft(s.title);
  };
  const commit = () => {
    if (editingId) {
      const trimmed = draft.trim();
      if (trimmed) renameSession(editingId, trimmed);
    }
    setEditingId(null);
  };
  const closeAllOverlays = () => {
    closeExtensions();
    closeSchedule();
    closeSettings();
  };
  const closeDeleteDialog = () => {
    setPendingDelete(null);
    setDeleteAction(null);
    setDeleteError("");
  };
  const removeFromList = () => {
    if (!pendingDelete) return;
    setDeleteAction("remove");
    if (editingId === pendingDelete.id) setEditingId(null);
    removeSession(pendingDelete.id);
    closeDeleteDialog();
  };
  const deleteBackedSession = async () => {
    if (!pendingDelete || deleteAction) return;
    setDeleteAction("delete");
    setDeleteError("");
    try {
      if (editingId === pendingDelete.id) setEditingId(null);
      await deleteSession(pendingDelete.id);
      closeDeleteDialog();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
      setDeleteAction(null);
    }
  };
  const pendingDeleteProviderIds = pendingDelete ? backedProviderIds(pendingDelete) : [];
  const pendingDeleteThreadCount = pendingDelete ? backedThreadCount(pendingDelete) : 0;
  const unsupportedDeleteProviders = pendingDeleteProviderIds.filter(
    (providerId) =>
      !providerCanDeleteSessions(providers.find((provider) => provider.id === providerId)),
  );
  const canDeleteBackedSession = Boolean(
    pendingDeleteProviderIds.length > 0 && unsupportedDeleteProviders.length === 0,
  );
  const deleteBackedSessionDisabledReason =
    pendingDelete && pendingDeleteProviderIds.length === 0
      ? t("sessions.delete.noProviderBacked")
      : pendingDelete && unsupportedDeleteProviders.length
        ? t("sessions.delete.agentsUnsupported", {
            agents: unsupportedDeleteProviders
              .map(
                (providerId) =>
                  providers.find((provider) => provider.id === providerId)?.name ?? providerId,
              )
              .join(", "),
          })
        : undefined;
  const toggleFolder = (id: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const startTreeDraft = (folderId: string | null, projectPath: string | null) => {
    closeAllOverlays();
    startDraftSession();
    setDraftWorkspace(projectPath);
    setDraftSessionFolder(folderId);
  };
  const openImportDialog = (
    folderId: string | null,
    projectKey: string,
    projectPath: string | null,
    label: string,
  ) => {
    setImportTarget({
      folderId,
      label,
      projectKey,
      projectPath,
    });
  };
  const hasImportProviders = providers.some((provider) => provider.enabled !== false);
  const closeContextMenus = () => {
    setBlankContextMenu((current) => ({ ...current, open: false }));
    setSessionContextMenu((current) => ({ ...current, open: false }));
    setFolderContextMenu((current) => ({ ...current, open: false }));
  };
  const startActiveProjectDraft = () => {
    closeContextMenus();
    startTreeDraft(null, activeProject.projectPath);
  };
  const openActiveProjectImportDialog = () => {
    closeContextMenus();
    openImportDialog(null, activeProject.key, activeProject.projectPath, activeProject.label);
  };
  const openActiveProjectFolderDialog = () => {
    closeContextMenus();
    openCreateFolderDialog(null, activeProject.key, activeProject.projectPath);
  };
  const chooseNewProject = async () => {
    closeContextMenus();
    closeAllOverlays();
    const selected = await chooseWorkspace();
    if (selected) {
      addSessionProject(selected);
      const projectKey = `project:${normalizePath(selected)}`;
      window.requestAnimationFrame(() => {
        const index = useUIStore
          .getState()
          .sidebarProjectNavItems.findIndex((item) => item.key === projectKey);
        if (index >= 0) useUIStore.getState().setSidebarProjectNavIndex(index);
      });
    }
  };
  const handleBlankContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      target.closest(
        "a,button,input,textarea,select,[role='button'],[role='menuitem'],[data-sidebar-tree-item='true']",
      )
    ) {
      return;
    }
    event.preventDefault();
    setSessionContextMenu((current) => ({ ...current, open: false }));
    setFolderContextMenu((current) => ({ ...current, open: false }));
    setBlankContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
    });
  };
  const handleSessionContextMenu = (event: MouseEvent<HTMLElement>, session: SessionListItem) => {
    event.preventDefault();
    event.stopPropagation();
    setBlankContextMenu((current) => ({ ...current, open: false }));
    setFolderContextMenu((current) => ({ ...current, open: false }));
    setSessionContextMenu({
      open: true,
      session,
      x: event.clientX,
      y: event.clientY,
    });
  };
  const handleFolderContextMenu = (
    event: MouseEvent<HTMLElement>,
    folder: SessionFolder,
    project: ProjectGroup,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setBlankContextMenu((current) => ({ ...current, open: false }));
    setSessionContextMenu((current) => ({ ...current, open: false }));
    setFolderContextMenu({
      folder,
      open: true,
      projectKey: project.key,
      projectLabel: project.label,
      projectPath: project.projectPath,
      x: event.clientX,
      y: event.clientY,
    });
  };
  const startSessionContextRename = () => {
    const session = sessionContextMenu.session;
    if (!session) return;
    closeContextMenus();
    startEdit(session);
  };
  const startSessionContextDelete = () => {
    const session = sessionContextMenu.session;
    if (!session) return;
    closeContextMenus();
    setPendingDelete(session);
  };
  const importSession = (providerId: string, providerSession: ImportableProviderSession) => {
    if (!importTarget) return;
    importProviderSession({
      folderId: importTarget.folderId,
      providerId,
      projectPath: importTarget.projectPath,
      providerSession,
    });
    setImportTarget(null);
  };

  const sidebarActionHandlersRef = useRef({
    chooseNewProject,
    openActiveProjectFolderDialog,
    openActiveProjectImportDialog,
    startActiveProjectDraft,
  });
  sidebarActionHandlersRef.current = {
    chooseNewProject,
    openActiveProjectFolderDialog,
    openActiveProjectImportDialog,
    startActiveProjectDraft,
  };

  useEffect(() => {
    if (!sidebarSessionActionRequest) return;
    const handlers = sidebarActionHandlersRef.current;
    switch (sidebarSessionActionRequest.action) {
      case "new":
        handlers.startActiveProjectDraft();
        break;
      case "import":
        handlers.openActiveProjectImportDialog();
        break;
      case "newFolder":
        handlers.openActiveProjectFolderDialog();
        break;
      case "newProject":
        void handlers.chooseNewProject();
        break;
    }
  }, [sidebarSessionActionRequest]);

  const openCreateFolderDialog = (
    parentId: string | null,
    projectKey: string,
    projectPath: string | null,
  ) => {
    setFolderDraft({
      color: DEFAULT_FOLDER_COLOR,
      icon: DEFAULT_FOLDER_ICON,
      name: "",
    });
    setFolderDialog({ mode: "create", parentId, projectKey, projectPath });
  };
  const openEditFolderDialog = (folder: SessionFolder) => {
    setFolderDraft({
      color: folder.color || DEFAULT_FOLDER_COLOR,
      icon: folder.icon || DEFAULT_FOLDER_ICON,
      name: folder.name,
    });
    setFolderDialog({ mode: "edit", folder });
  };
  const saveFolderDialog = () => {
    if (!folderDialog) return;
    const name = folderDraft.name.trim() || t("sessions.folder.untitled");
    if (folderDialog.mode === "create") {
      const parentId = folderDialog.parentId;
      const id = createSessionFolder({
        color: folderDraft.color,
        icon: folderDraft.icon,
        name,
        parentId,
        projectKey: folderDialog.projectKey,
        projectPath: folderDialog.projectPath,
      });
      if (parentId) {
        setCollapsedFolders((current) => {
          const next = new Set(current);
          next.delete(parentId);
          return next;
        });
      }
      setFolderDialog(null);
      setCollapsedFolders((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      return;
    }
    updateSessionFolder(folderDialog.folder.id, {
      color: folderDraft.color,
      icon: folderDraft.icon,
      name,
    });
    setFolderDialog(null);
  };
  const confirmDeleteFolder = async (folder: SessionFolder) => {
    const confirmed = await confirmDialog({
      title: t("sessions.folder.deleteTitle"),
      description: t("sessions.folder.deleteConfirm", { name: folder.name }),
      confirmLabel: t("common.delete"),
      tone: "danger",
    });
    if (!confirmed) return;
    deleteSessionFolder(folder.id);
    setCollapsedFolders((current) => {
      const next = new Set(current);
      next.delete(folder.id);
      return next;
    });
  };
  const clearDrag = () => {
    setDraggingSessionId(null);
    setDragTarget(null);
  };
  const draggedSessionIdFromEvent = (event: DragEvent): string => {
    return event.dataTransfer.getData(SESSION_DRAG_TYPE) || draggingSessionId || "";
  };
  const draggableSessionFromState = (sessionId: string): SessionListItem | undefined => {
    const cached = draggableSessionById.get(sessionId);
    if (cached) return cached;
    const state = useChatStore.getState();
    return selectSessionListItems(state.sessions, state.sessionPlacements, t, activeWorkspaceId, {
      includeHiddenExtensionTree: true,
    }).find((session) => session.id === sessionId);
  };
  const canDropSessionInProject = (sessionId: string, projectKey: string): boolean => {
    return draggableSessionFromState(sessionId)?.projectKey === projectKey;
  };
  const handleSessionDragStart = (event: DragEvent<HTMLElement>, sessionId: string) => {
    setDraggingSessionId(sessionId);
    setDragTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
  };
  const handleFolderDragOver = (
    event: DragEvent<HTMLElement>,
    folderId: string | null,
    projectKey: string,
  ) => {
    const sessionId = draggedSessionIdFromEvent(event);
    if (!sessionId || !canDropSessionInProject(sessionId, projectKey)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragTarget({ kind: "folder", folderId, projectKey });
  };
  const handleFolderDrop = (
    event: DragEvent<HTMLElement>,
    folderId: string | null,
    projectKey: string,
  ) => {
    const sessionId = draggedSessionIdFromEvent(event);
    if (!sessionId || !canDropSessionInProject(sessionId, projectKey)) return;
    event.preventDefault();
    event.stopPropagation();
    moveSessionInTree({ sessionId, folderId, position: "end" });
    if (folderId) {
      setCollapsedFolders((current) => {
        const next = new Set(current);
        next.delete(folderId);
        return next;
      });
    }
    clearDrag();
  };
  const handleSessionDragOver = (
    event: DragEvent<HTMLElement>,
    targetSessionId: string,
    folderId: string | null,
    projectKey: string,
  ) => {
    const sessionId = draggedSessionIdFromEvent(event);
    if (
      !sessionId ||
      sessionId === targetSessionId ||
      !canDropSessionInProject(sessionId, projectKey)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
    setDragTarget({ kind: "session", folderId, projectKey, targetSessionId, position });
  };
  const handleSessionDrop = (
    event: DragEvent<HTMLElement>,
    targetSessionId: string,
    folderId: string | null,
    projectKey: string,
  ) => {
    const sessionId = draggedSessionIdFromEvent(event);
    if (
      !sessionId ||
      sessionId === targetSessionId ||
      !canDropSessionInProject(sessionId, projectKey)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const position =
      dragTarget?.kind === "session" && dragTarget.targetSessionId === targetSessionId
        ? dragTarget.position
        : "before";
    moveSessionInTree({ sessionId, folderId, targetSessionId, position });
    clearDrag();
  };
  const handleDropZoneDragOver = (
    event: DragEvent<HTMLElement>,
    folderId: string | null,
    projectKey: string,
  ) => {
    const sessionId = draggedSessionIdFromEvent(event);
    if (!sessionId || !canDropSessionInProject(sessionId, projectKey)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragTarget({ kind: "root", folderId, projectKey });
  };
  const handleDropZoneDrop = (
    event: DragEvent<HTMLElement>,
    folderId: string | null,
    projectKey: string,
  ) => {
    const sessionId = draggedSessionIdFromEvent(event);
    if (!sessionId || !canDropSessionInProject(sessionId, projectKey)) return;
    event.preventDefault();
    event.stopPropagation();
    moveSessionInTree({ sessionId, folderId, position: "end" });
    clearDrag();
  };
  const dragEventStartedOnTreeItem = (event: DragEvent<HTMLElement>): boolean => {
    const target = event.target;
    return target instanceof Element && Boolean(target.closest("[data-sidebar-tree-item='true']"));
  };
  const handleProjectRootDragOver = (event: DragEvent<HTMLElement>, projectKey: string) => {
    if (dragEventStartedOnTreeItem(event)) return;
    handleFolderDragOver(event, null, projectKey);
  };
  const handleProjectRootDrop = (event: DragEvent<HTMLElement>, projectKey: string) => {
    if (dragEventStartedOnTreeItem(event)) return;
    handleFolderDrop(event, null, projectKey);
  };

  useEffect(() => {
    if (!importTarget) return;
    let cancelled = false;
    const api = desktopApi();
    const aspState = useAspStore.getState();
    const importProviders = importProvidersForDialog(aspState.providers, aspState.activeProviderId);
    const cwd = importTarget.projectPath || aspState.workspacePath;
    const targetProjectPath = importTarget.projectPath;
    setExpandedImportAgents(new Set(importProviders.slice(0, 1).map((provider) => provider.id)));
    setImportState({
      groups: importProviders.map((provider) => ({
        loading: true,
        provider,
        sessions: [],
      })),
      loading: true,
    });
    if (importProviders.length === 0) {
      setImportState({ groups: [], loading: false });
      return;
    }
    if (!api) {
      setImportState({
        groups: importProviders.map((provider) => ({
          error: t("sessions.import.desktopOnly"),
          loading: false,
          provider,
          sessions: [],
        })),
        loading: false,
      });
      return;
    }
    for (const provider of importProviders) {
      void (async () => {
        let nextGroup: ImportAgentGroup;
        const refreshProviderCapabilities = useAspStore.getState().refreshProviderCapabilities;
        const refreshed = await withImportTimeout(
          refreshProviderCapabilities(provider.id, cwd).catch(() => provider),
          IMPORT_AGENT_LOAD_TIMEOUT_MS,
          t("sessions.import.timeout", {
            action: t("sessions.import.checkingSupport"),
            name: provider.name,
          }),
        ).catch(() => provider);
        const candidate = refreshed ?? provider;
        if (!providerCanImportSessions(candidate)) {
          nextGroup = {
            error: t("sessions.import.unsupported"),
            loading: false,
            provider: candidate,
            sessions: [],
          };
        } else {
          try {
            const providerSessions = await withImportTimeout(
              api.sessions.list({
                providerId: candidate.id,
                cwd,
              }),
              IMPORT_AGENT_LOAD_TIMEOUT_MS,
              t("sessions.import.timeout", {
                action: t("sessions.import.loadingSessions"),
                name: candidate.name,
              }),
            );
            const existing = importedProviderSessionIds(candidate.id);
            const sessions = providerSessions
              .filter((session) => sessionMatchesProject(session, targetProjectPath))
              .filter((session) => !existing.has(session.id))
              .sort(
                (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
              );
            nextGroup = {
              loading: false,
              provider: candidate,
              sessions,
            };
          } catch (error) {
            nextGroup = {
              error: errorMessage(error),
              loading: false,
              provider: candidate,
              sessions: [],
            };
          }
        }
        if (cancelled) return;
        setImportState((current) => {
          const groups = replaceImportAgentGroup(current.groups, provider.id, nextGroup);
          return {
            groups,
            loading: groups.some((group) => group.loading),
          };
        });
        if (nextGroup.sessions.length || nextGroup.error) {
          setExpandedImportAgents((current) =>
            current.size ? current : new Set([nextGroup.provider.id]),
          );
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [importTarget, t]);

  const extensionSessionInput = (root: SessionTreeRoot, node: SessionTreeNode) => ({
    extensionId: root.owner || root.id,
    rootId: root.id,
    nodeId: node.id,
    title: node.session?.title || node.title,
    providerId: node.session?.providerId,
    projectPath: node.session?.projectPath,
    cwd: node.session?.cwd,
    renderer: node.session?.renderer,
    initialMarkdown: node.session?.initialMarkdown,
    developerInstructions: node.session?.developerInstructions,
    metadata: node.session?.metadata,
  });

  const openExtensionTreeNode = (root: SessionTreeRoot, node: SessionTreeNode) => {
    if (!node.session) return;
    closeAllOverlays();
    openExtensionSession(extensionSessionInput(root, node));
  };
  const materializeExtensionTreeNode = (root: SessionTreeRoot, node: SessionTreeNode) => {
    if (!node.session) return "";
    return materializeExtensionSession(extensionSessionInput(root, node));
  };
  const handleExtensionSessionDragStart = (
    event: DragEvent<HTMLElement>,
    root: SessionTreeRoot,
    node: SessionTreeNode,
  ) => {
    const sessionId = materializeExtensionTreeNode(root, node);
    if (!sessionId) return;
    handleSessionDragStart(event, sessionId);
  };

  const renderExtensionTreeNode = (
    root: SessionTreeRoot,
    node: SessionTreeNode,
    depth: number,
  ): ReactNode => {
    const children = node.children ?? [];
    const isFolder = node.kind === "folder" || children.length > 0 || !node.session;
    const collapsedKey = extensionCollapsedKey(node.id);
    const collapsed = collapsedFolders.has(collapsedKey);
    const rowIndent = depth * 10;
    const Icon = node.icon ?? (isFolder ? folderIcon(DEFAULT_FOLDER_ICON, collapsed) : FileText);
    const extensionId = root.owner || root.id;
    const backingSession = extensionSessionByNode.get(extensionSessionKey(extensionId, node.id));
    const backingSessionItem = backingSession
      ? draggableSessionById.get(backingSession.id)
      : undefined;
    const active =
      activeExtensionContext?.extensionId === extensionId &&
      activeExtensionContext.nodeId === node.id;
    const inProgress =
      backingSession?.status === "streaming" ||
      backingSession?.connectionState === "connecting" ||
      backingSession?.connectionState === "running";

    if (isFolder) {
      const handleFolderClick = () => {
        if (collapsed && !children.length && !node.loading) {
          void node.onLoadChildren?.();
        }
        toggleFolder(collapsedKey);
      };
      return (
        <div key={node.id}>
          <div style={{ paddingLeft: rowIndent }}>
            <div
              data-sidebar-tree-item="true"
              className="group/extension-folder text-muted hover:text-fg bg-surface/45 flex w-full items-center gap-1 rounded-md transition-[background-color,color]"
            >
              <button
                type="button"
                onClick={handleFolderClick}
                title={node.description || node.title}
                aria-expanded={!collapsed}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[12.5px] font-medium"
              >
                <ChevronRight
                  size={13}
                  className={cn(
                    "text-subtle shrink-0 transition-transform",
                    !collapsed && "rotate-90",
                  )}
                />
                <span className="text-subtle flex h-5 w-5 shrink-0 items-center justify-center">
                  <Icon size={14} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1 truncate">{node.title}</span>
                {node.badge ? (
                  <span className="text-subtle bg-surface-hover rounded px-1.5 py-0.5 text-[10px] leading-none">
                    {node.badge}
                  </span>
                ) : null}
              </button>
            </div>
          </div>
          {!collapsed &&
          (children.length > 0 || node.loading || node.hasMore || node.onLoadChildren) ? (
            <ProjectSessionItems collapsed={false}>
              <div className="relative mt-1 pl-1.5">
                <div
                  aria-hidden
                  className="bg-border-subtle pointer-events-none absolute top-0 bottom-0 w-0.5 rounded-full"
                  style={{ left: rowIndent + 12 }}
                />
                <div className="flex flex-col gap-1">
                  <ExtensionTreeLoadChildrenOnOpen childrenLength={children.length} node={node} />
                  {children.length > 0 ? (
                    children.map((child) => renderExtensionTreeNode(root, child, depth + 1))
                  ) : node.loading || (node.onLoadChildren && !node.loaded) ? (
                    <ExtensionTreeLoadingSkeleton depth={depth + 1} />
                  ) : null}
                  {node.loadingMore ? <ExtensionTreeLoadingRow depth={depth + 1} /> : null}
                  {node.hasMore && !node.loading ? (
                    <ExtensionTreeLoadMoreSentinel node={node} depth={depth + 1} />
                  ) : null}
                </div>
              </div>
            </ProjectSessionItems>
          ) : null}
        </div>
      );
    }

    return (
      <div
        key={node.id}
        data-sidebar-tree-item="true"
        draggable={Boolean(node.session)}
        onDragStart={(event) => handleExtensionSessionDragStart(event, root, node)}
        onDragEnd={clearDrag}
        onContextMenu={(event) => {
          if (!backingSessionItem) return;
          event.preventDefault();
          event.stopPropagation();
          setPendingDelete(backingSessionItem);
        }}
        style={{
          marginLeft: rowIndent,
          width: rowIndent ? `calc(100% - ${rowIndent}px)` : undefined,
        }}
        className={cn(
          "group relative flex w-full items-center rounded-[8px] border border-transparent text-[13.5px] transition-[background-color,border-color,color,opacity]",
          active ? "bg-surface text-fg" : "text-muted hover:bg-surface-hover hover:text-fg",
          backingSession && draggingSessionId === backingSession.id && "opacity-45",
        )}
      >
        <button
          type="button"
          draggable={Boolean(node.session)}
          title={node.description || node.title}
          aria-current={active ? "page" : undefined}
          onDragStart={(event) => {
            event.stopPropagation();
            handleExtensionSessionDragStart(event, root, node);
          }}
          onDragEnd={(event) => {
            event.stopPropagation();
            clearDrag();
          }}
          onClick={() => openExtensionTreeNode(root, node)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left",
            backingSession && draggingSessionId === backingSession.id && "cursor-grabbing",
          )}
        >
          <Icon size={14} strokeWidth={1.8} className="text-subtle shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          {node.badge ? (
            <span className="text-subtle bg-surface-hover rounded px-1.5 py-0.5 text-[10px] leading-none">
              {node.badge}
            </span>
          ) : null}
          {inProgress ? (
            <span
              title={t("sidebar.running")}
              aria-label={t("sidebar.running")}
              className="text-info ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            >
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            </span>
          ) : null}
        </button>
        {backingSessionItem ? (
          <button
            type="button"
            data-icon-button="true"
            title={t("sidebar.delete")}
            aria-label={t("sidebar.delete")}
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete(backingSessionItem);
            }}
            className="ui-icon-button hover:bg-surface-active hover:text-danger mr-0.5 hidden h-7 w-7 shrink-0 rounded-md group-focus-within:flex group-hover:flex"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    );
  };

  const renderBranch = (
    branchFolders: FolderTreeNode[],
    branchSessions: SessionListItem[],
    project: ProjectGroup,
    parentId: string | null,
    depth: number,
  ): ReactNode => (
    <div className="flex flex-col gap-1">
      {branchFolders.map((folder) => {
        const collapsed = collapsedFolders.has(folder.id);
        const folderIsDropTarget =
          dragTarget?.kind === "folder" &&
          dragTarget.folderId === folder.id &&
          dragTarget.projectKey === project.key;
        const FolderIcon = folderIcon(folder.icon, collapsed);
        const folderStyle = folderRowStyle(folder.color, folderIsDropTarget);
        const hasChildItems = folder.children.length > 0 || folder.sessions.length > 0;
        return (
          <div key={folder.id}>
            <div
              onDragOver={(event) => handleFolderDragOver(event, folder.id, project.key)}
              onDrop={(event) => handleFolderDrop(event, folder.id, project.key)}
              style={{ paddingLeft: depth * 10 }}
            >
              <div
                data-sidebar-tree-item="true"
                onContextMenu={(event) => handleFolderContextMenu(event, folder, project)}
                style={folderStyle}
                className={cn(
                  "group/folder text-muted hover:text-fg flex w-full items-center gap-1 rounded-md transition-[box-shadow,color]",
                  folderIsDropTarget && "ring-info ring-1",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleFolder(folder.id)}
                  title={folder.name}
                  aria-expanded={!collapsed}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[12.5px] font-medium"
                >
                  <ChevronRight
                    size={13}
                    className={cn(
                      "text-subtle shrink-0 transition-transform",
                      !collapsed && "rotate-90",
                    )}
                  />
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center"
                    style={{ color: folder.color }}
                  >
                    <FolderIcon size={14} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      data-icon-button="true"
                      title={t("sidebar.folderActions")}
                      aria-label={t("sidebar.folderActions")}
                      onClick={(event) => event.stopPropagation()}
                      className="text-subtle hover:bg-surface-active hover:text-fg data-[state=open]:bg-surface-active data-[state=open]:text-fg mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-[opacity,background-color,color] group-hover/folder:opacity-100 focus-visible:opacity-100"
                    >
                      <MoreHorizontal size={14} strokeWidth={1.8} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="end" className="w-52">
                    <DropdownMenuItem
                      onSelect={() => startTreeDraft(folder.id, project.projectPath)}
                    >
                      <Plus size={14} className="text-subtle shrink-0" />
                      <span>{t("sidebar.newSession")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!hasImportProviders}
                      onSelect={() =>
                        openImportDialog(folder.id, project.key, project.projectPath, project.label)
                      }
                    >
                      <Download size={14} className="text-subtle shrink-0" />
                      <span>{t("sidebar.importCliSession")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        openCreateFolderDialog(folder.id, project.key, project.projectPath)
                      }
                    >
                      <FolderPlus size={14} className="text-subtle shrink-0" />
                      <span>{t("sidebar.newSubfolder")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openEditFolderDialog(folder)}>
                      <Pencil size={14} className="text-subtle shrink-0" />
                      <span>{t("sidebar.editFolder")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void confirmDeleteFolder(folder)}>
                      <Trash2 size={14} className="text-danger shrink-0" />
                      <span>{t("sidebar.deleteFolder")}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {!collapsed && (hasChildItems || draggingSessionId) ? (
              <ProjectSessionItems collapsed={false}>
                <div className="relative mt-1 pl-1.5">
                  <div
                    aria-hidden
                    className="pointer-events-none absolute top-0 bottom-0 w-0.5 rounded-full"
                    style={{
                      backgroundColor: alpha(folder.color, 0.45),
                      left: depth * 10 + 12,
                    }}
                  />
                  {renderBranch(folder.children, folder.sessions, project, folder.id, depth + 1)}
                </div>
              </ProjectSessionItems>
            ) : null}
          </div>
        );
      })}
      {branchSessions.map((session) => renderSessionRow(session, parentId, project.key, depth))}
      <DropZone
        active={
          dragTarget?.kind === "root" &&
          dragTarget.folderId === parentId &&
          dragTarget.projectKey === project.key
        }
        depth={depth}
        onDragOver={(event) => handleDropZoneDragOver(event, parentId, project.key)}
        onDrop={(event) => handleDropZoneDrop(event, parentId, project.key)}
        visible={Boolean(draggingSessionId)}
      />
    </div>
  );

  const renderSessionRow = (
    session: SessionListItem,
    folderId: string | null,
    projectKey: string,
    depth: number,
  ): ReactNode => {
    const editing = editingId === session.id;
    const sessionProviders = visibleSessionProviders(session, providers);
    const inProgress = sessionInProgress(session);
    const dropBefore =
      dragTarget?.kind === "session" &&
      dragTarget.targetSessionId === session.id &&
      dragTarget.projectKey === projectKey &&
      dragTarget.position === "before";
    const dropAfter =
      dragTarget?.kind === "session" &&
      dragTarget.targetSessionId === session.id &&
      dragTarget.projectKey === projectKey &&
      dragTarget.position === "after";
    const rowIndent = depth * 10;
    return (
      <div
        key={session.id}
        data-sidebar-tree-item="true"
        draggable={!editing}
        onDragStart={(event) => handleSessionDragStart(event, session.id)}
        onDragEnd={clearDrag}
        onDragOver={(event) => handleSessionDragOver(event, session.id, folderId, projectKey)}
        onDrop={(event) => handleSessionDrop(event, session.id, folderId, projectKey)}
        onContextMenu={(event) => handleSessionContextMenu(event, session)}
        style={{
          marginLeft: rowIndent,
          width: rowIndent ? `calc(100% - ${rowIndent}px)` : undefined,
        }}
        className={cn(
          "group relative flex w-full items-center rounded-[8px] border border-transparent text-[13.5px] transition-[background-color,border-color,color,opacity]",
          session.id === activeId
            ? "bg-surface text-fg"
            : "text-muted hover:bg-surface-hover hover:text-fg",
          draggingSessionId === session.id && "opacity-45",
          dropBefore && "border-t-info",
          dropAfter && "border-b-info",
        )}
      >
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
            <SessionAgentLogos providers={sessionProviders} />
            <input
              autoFocus
              value={draft}
              aria-label={t("sidebar.rename")}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingId(null);
                }
              }}
              className="border-border-strong bg-surface text-fg min-w-0 flex-1 rounded border px-1 text-[13.5px]"
            />
          </div>
        ) : (
          <button
            type="button"
            draggable
            title={session.title}
            aria-current={session.id === activeId ? "page" : undefined}
            onDragStart={(event) => {
              event.stopPropagation();
              handleSessionDragStart(event, session.id);
            }}
            onDragEnd={(event) => {
              event.stopPropagation();
              clearDrag();
            }}
            onClick={() => {
              closeAllOverlays();
              openSession(session.id);
            }}
            onDoubleClick={() => {
              startEdit(session);
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left",
              draggingSessionId === session.id && "cursor-grabbing",
            )}
          >
            <SessionAgentLogos providers={sessionProviders} />
            <span className="min-w-0 truncate">{session.title}</span>
            {session.pinnedAt ? (
              <Pin size={12} className="text-subtle shrink-0" strokeWidth={1.9} />
            ) : null}
            {inProgress ? (
              <span
                title={t("sidebar.running")}
                aria-label={t("sidebar.running")}
                className="text-info ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center"
              >
                <LoaderCircle size={12} className="animate-spin" aria-hidden />
              </span>
            ) : null}
          </button>
        )}
        {!editing ? (
          <>
            <button
              type="button"
              data-icon-button="true"
              title={t("sidebar.rename")}
              aria-label={t("sidebar.rename")}
              onClick={(e) => {
                e.stopPropagation();
                startEdit(session);
              }}
              className="ui-icon-button hover:bg-surface-active mr-0.5 hidden h-7 w-7 shrink-0 rounded-md group-focus-within:flex group-hover:flex"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              data-icon-button="true"
              title={t("sidebar.delete")}
              aria-label={t("sidebar.delete")}
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(session);
              }}
              className="ui-icon-button hover:bg-surface-active hover:text-danger mr-0.5 hidden h-7 w-7 shrink-0 rounded-md group-focus-within:flex group-hover:flex"
            >
              <Trash2 size={14} />
            </button>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div
        onContextMenu={handleBlankContextMenu}
        className="flex h-full min-h-0 flex-col overflow-hidden px-2 pb-1"
      >
        {projectGroups.length === 0 && sortedExtensionTreeRoots.length === 0 ? (
          <p className="text-subtle px-2 py-6 text-center text-[13px]">{t("session.empty")}</p>
        ) : (
          <section aria-label={activeProject.label} className="flex min-h-0 flex-1 flex-col pr-1">
            <div className="min-h-0 flex-1 overflow-y-auto pt-1 pr-1">
              <div
                onDragOver={(event) => handleProjectRootDragOver(event, activeProject.key)}
                onDrop={(event) => handleProjectRootDrop(event, activeProject.key)}
                className={cn(
                  "min-h-full rounded-lg transition-colors",
                  dragTarget?.kind === "folder" &&
                    dragTarget.folderId === null &&
                    dragTarget.projectKey === activeProject.key &&
                    "bg-info/5",
                )}
              >
                {sortedExtensionTreeRoots.length > 0 ? (
                  <div className="mb-2 flex flex-col gap-1">
                    {sortedExtensionTreeRoots.map((root) => renderExtensionTreeNode(root, root, 0))}
                  </div>
                ) : null}
                {activeProjectGroup &&
                (activeProjectGroup.folders.length > 0 ||
                  activeProjectGroup.sessions.length > 0) ? (
                  renderBranch(
                    activeProjectGroup.folders,
                    activeProjectGroup.sessions,
                    activeProjectGroup,
                    null,
                    0,
                  )
                ) : projectGroups.length > 0 ? (
                  <p className="text-subtle px-2 py-8 text-center text-[13px]">
                    {t("session.empty")}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </div>
      <DropdownMenu
        open={blankContextMenu.open}
        onOpenChange={(open) =>
          setBlankContextMenu((current) => (current.open === open ? current : { ...current, open }))
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-icon-button="true"
            aria-hidden
            tabIndex={-1}
            style={{ left: blankContextMenu.x, top: blankContextMenu.y }}
            className="pointer-events-none fixed h-px w-px opacity-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-52">
          <DropdownMenuItem onSelect={startActiveProjectDraft}>
            <Plus size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.newSession")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openActiveProjectFolderDialog}>
            <FolderPlus size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.newFolder")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasImportProviders} onSelect={openActiveProjectImportDialog}>
            <Download size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.importCliSession")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu
        open={sessionContextMenu.open}
        onOpenChange={(open) =>
          setSessionContextMenu((current) =>
            current.open === open ? current : { ...current, open },
          )
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-icon-button="true"
            aria-hidden
            tabIndex={-1}
            style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
            className="pointer-events-none fixed h-px w-px opacity-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-44">
          <DropdownMenuItem onSelect={startSessionContextRename}>
            <Pencil size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.rename")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={startSessionContextDelete}>
            <Trash2 size={14} className="text-danger shrink-0" />
            <span>{t("sidebar.delete")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu
        open={folderContextMenu.open}
        onOpenChange={(open) =>
          setFolderContextMenu((current) =>
            current.open === open ? current : { ...current, open },
          )
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-icon-button="true"
            aria-hidden
            tabIndex={-1}
            style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
            className="pointer-events-none fixed h-px w-px opacity-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-52">
          <DropdownMenuItem
            disabled={!folderContextMenu.folder}
            onSelect={() => {
              const folder = folderContextMenu.folder;
              if (!folder) return;
              startTreeDraft(folder.id, folderContextMenu.projectPath);
            }}
          >
            <Plus size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.newSession")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!folderContextMenu.folder || !hasImportProviders}
            onSelect={() => {
              const folder = folderContextMenu.folder;
              if (!folder) return;
              openImportDialog(
                folder.id,
                folderContextMenu.projectKey,
                folderContextMenu.projectPath,
                folderContextMenu.projectLabel,
              );
            }}
          >
            <Download size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.importCliSession")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!folderContextMenu.folder}
            onSelect={() => {
              const folder = folderContextMenu.folder;
              if (!folder) return;
              openCreateFolderDialog(
                folder.id,
                folderContextMenu.projectKey,
                folderContextMenu.projectPath,
              );
            }}
          >
            <FolderPlus size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.newSubfolder")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!folderContextMenu.folder}
            onSelect={() => {
              const folder = folderContextMenu.folder;
              if (folder) openEditFolderDialog(folder);
            }}
          >
            <Pencil size={14} className="text-subtle shrink-0" />
            <span>{t("sidebar.editFolder")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!folderContextMenu.folder}
            onSelect={() => {
              const folder = folderContextMenu.folder;
              if (folder) void confirmDeleteFolder(folder);
            }}
          >
            <Trash2 size={14} className="text-danger shrink-0" />
            <span>{t("sidebar.deleteFolder")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={Boolean(folderDialog)}
        onOpenChange={(open) => {
          if (!open) setFolderDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.mode === "edit"
                ? t("sessions.folder.editTitle")
                : t("sessions.folder.createTitle")}
            </DialogTitle>
            <DialogDescription>{t("sessions.folder.description")}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="text-muted mb-1 block text-[12px] font-medium">
                {t("sessions.folder.name")}
              </span>
              <input
                autoFocus
                value={folderDraft.name}
                onChange={(event) =>
                  setFolderDraft((current) => ({ ...current, name: event.target.value }))
                }
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveFolderDialog();
                  }
                }}
                className="ui-field text-[13.5px]"
              />
            </label>
            <div>
              <div className="text-muted mb-2 flex items-center gap-1.5 text-[12px] font-medium">
                <Palette size={13} />
                {t("sessions.folder.background")}
              </div>
              <div className="grid grid-cols-8 gap-2">
                {FOLDER_COLORS.map((option) => (
                  <button
                    key={option.color}
                    type="button"
                    title={option.label}
                    aria-label={option.label}
                    onClick={() =>
                      setFolderDraft((current) => ({ ...current, color: option.color }))
                    }
                    className={cn(
                      "h-7 rounded-md border transition-transform hover:scale-105",
                      folderDraft.color === option.color ? "border-fg" : "border-border",
                    )}
                    style={{ backgroundColor: option.color }}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="text-muted mb-2 text-[12px] font-medium">
                {t("sessions.folder.icon")}
              </div>
              <div className="grid grid-cols-9 gap-2">
                {FOLDER_ICON_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      data-icon-button="true"
                      title={option.label}
                      aria-label={option.label}
                      onClick={() => setFolderDraft((current) => ({ ...current, icon: option.id }))}
                      className={cn(
                        "text-muted hover:bg-surface-hover hover:text-fg flex h-8 items-center justify-center rounded-md border transition-colors",
                        folderDraft.icon === option.id
                          ? "border-border-strong bg-surface-active text-fg"
                          : "border-border",
                      )}
                    >
                      <Icon size={15} />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose className="ui-button text-[13px]">{t("common.cancel")}</DialogClose>
            <button
              type="button"
              onClick={saveFolderDialog}
              className="ui-button ui-button-primary text-[13px]"
            >
              {folderDialog?.mode === "edit" ? t("common.save") : t("common.create")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sessions.delete.title")}</DialogTitle>
            <DialogDescription>
              {pendingDeleteThreadCount > 1
                ? t("sessions.delete.descriptionMulti", {
                    count: pendingDeleteThreadCount,
                    title: pendingDelete?.title ?? t("sessions.delete.thisSession"),
                  })
                : t("sessions.delete.description", {
                    title: pendingDelete?.title ?? t("sessions.delete.thisSession"),
                  })}
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <div className="border-danger/40 bg-danger/10 text-danger rounded-md border px-3 py-2 text-[12.5px] leading-5">
              {deleteError}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose disabled={deleteAction !== null} className="ui-button text-[13px]">
              {t("common.cancel")}
            </DialogClose>
            <button
              type="button"
              disabled={deleteAction !== null}
              onClick={removeFromList}
              className="ui-button text-[13px]"
            >
              {deleteAction === "remove"
                ? t("common.removing")
                : t("sessions.delete.removeFromList")}
            </button>
            <button
              type="button"
              disabled={!canDeleteBackedSession || deleteAction !== null}
              onClick={deleteBackedSession}
              title={canDeleteBackedSession ? undefined : deleteBackedSessionDisabledReason}
              className="ui-button ui-button-danger-primary text-[13px]"
            >
              {deleteAction === "delete"
                ? t("common.deleting")
                : pendingDeleteThreadCount > 1
                  ? t("sessions.delete.deleteAgentThreads", {
                      count: pendingDeleteThreadCount,
                    })
                  : t("sessions.delete.deleteSession")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(importTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setImportTarget(null);
            setImportState({ groups: [], loading: false });
            setExpandedImportAgents(new Set());
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("sessions.import.title")}</DialogTitle>
            <DialogDescription>
              {t("sessions.import.description", {
                project: importTarget?.label ?? t("sessions.delete.thisSession"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 max-h-[min(28rem,60vh)] overflow-y-auto pr-1">
            {importState.loading && importState.groups.length === 0 ? (
              <div className="border-border-subtle bg-surface text-muted flex items-center gap-2 rounded-md border px-3 py-3 text-[13px]">
                <LoaderCircle size={14} className="text-info animate-spin" />
                {t("common.loadingSessions")}
              </div>
            ) : importState.groups.length === 0 ? (
              <div className="border-border-subtle bg-surface text-muted rounded-md border px-3 py-3 text-[13px]">
                {t("sessions.import.noAgents")}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {importState.groups.map((group) => {
                  const open = expandedImportAgents.has(group.provider.id);
                  return (
                    <ImportAgentSection
                      key={group.provider.id}
                      group={group}
                      open={open}
                      onImport={(session) => importSession(group.provider.id, session)}
                      onToggle={() => {
                        setExpandedImportAgents((current) => {
                          const next = new Set(current);
                          if (next.has(group.provider.id)) next.delete(group.provider.id);
                          else next.add(group.provider.id);
                          return next;
                        });
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function visibleSessionProviders(
  session: SessionListItem,
  providers: AspProvider[],
): AspProvider[] {
  const ids = new Set<string>();
  if (session.providerId) ids.add(session.providerId);
  for (const [providerId, route] of Object.entries(session.agentSessions ?? {})) {
    if (route.status !== "never_used" || route.providerSessionId) ids.add(providerId);
  }
  return [...ids]
    .map((providerId) => providers.find((provider) => provider.id === providerId))
    .filter((provider): provider is AspProvider => Boolean(provider));
}

function backedProviderIds(session: SessionListItem): string[] {
  const ids = new Set<string>();
  if (session.providerSessionId || session.transcriptPath) ids.add(session.providerId);
  for (const [providerId, route] of Object.entries(session.agentSessions ?? {})) {
    if (agentSessionIsProviderBacked(route)) ids.add(providerId);
  }
  for (const route of session.retiredAgentSessions ?? []) {
    if (agentSessionIsProviderBacked(route)) ids.add(route.providerId);
  }
  return [...ids];
}

function backedThreadCount(session: SessionListItem): number {
  const keys = new Set<string>();
  const add = (providerId: string, route: AgentSessionState) => {
    if (!agentSessionIsProviderBacked(route)) return;
    keys.add(agentSessionDeleteKey(providerId, route));
  };
  for (const [providerId, route] of Object.entries(session.agentSessions ?? {})) {
    add(providerId, route);
  }
  for (const route of session.retiredAgentSessions ?? []) add(route.providerId, route);
  if (session.providerSessionId || session.transcriptPath) {
    add(session.providerId, {
      providerSessionId: session.providerSessionId,
      extensionState: session.transcriptPath
        ? { session: { transcriptPath: session.transcriptPath } }
        : undefined,
    });
  }
  return keys.size;
}

function SessionAgentLogos({ providers }: { providers: AspProvider[] }) {
  const visible = providers.slice(0, 3);
  if (!visible.length) {
    return <AgentLogo compact className="border-canvas h-4 w-4 border" />;
  }
  return (
    <span
      className="flex shrink-0 items-center -space-x-1"
      aria-label={providers.map((item) => item.name).join(", ")}
    >
      {visible.map((provider) => (
        <AgentLogo
          key={provider.id}
          provider={provider}
          compact
          className="border-canvas h-4 w-4 border"
        />
      ))}
      {providers.length > visible.length ? (
        <span className="border-canvas bg-surface-hover text-subtle flex h-4 min-w-4 items-center justify-center rounded-full border px-0.5 text-[8px]">
          +{providers.length - visible.length}
        </span>
      ) : null}
    </span>
  );
}

function ExtensionTreeLoadChildrenOnOpen({
  childrenLength,
  node,
}: {
  childrenLength: number;
  node: SessionTreeNode;
}) {
  useEffect(() => {
    if (childrenLength > 0 || node.loaded || node.loading || !node.onLoadChildren) return;
    void node.onLoadChildren();
  }, [childrenLength, node]);
  return null;
}

function ExtensionTreeLoadMoreSentinel({ depth, node }: { depth: number; node: SessionTreeNode }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!node.hasMore || node.loadingMore || !node.onLoadMore) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      void node.onLoadMore();
      return;
    }
    let requested = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (requested || !entries.some((entry) => entry.isIntersecting)) return;
        requested = true;
        void node.onLoadMore?.();
      },
      { root: null, rootMargin: "160px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [node]);

  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        marginLeft: depth * 10,
        width: depth ? `calc(100% - ${depth * 10}px)` : undefined,
      }}
      className="h-2 w-full"
    />
  );
}

function ExtensionTreeLoadingRow({ depth }: { depth: number }) {
  const t = useT();
  return (
    <div
      aria-label={t("common.loading")}
      style={{
        marginLeft: depth * 10,
        width: depth ? `calc(100% - ${depth * 10}px)` : undefined,
      }}
      className="flex h-[34px] w-full animate-pulse items-center gap-2 rounded-md px-2 py-1.5"
    >
      <span className="border-border bg-surface-hover h-3.5 w-3.5 shrink-0 rounded-full border" />
      <span className="bg-surface-hover h-3 w-2/5 rounded-full" />
      <span className="bg-surface-hover ml-auto h-5 w-11 shrink-0 rounded" />
    </div>
  );
}

function ExtensionTreeLoadingSkeleton({ depth }: { depth: number }) {
  const t = useT();
  const rows = [
    { depth, icon: "square", titleWidth: "64%" },
    { depth: depth + 1, icon: "circle", titleWidth: "34%" },
    { depth: depth + 2, icon: "circle", titleWidth: "58%" },
    { depth: depth + 2, icon: "circle", titleWidth: "48%" },
    { depth: depth + 2, icon: "circle", titleWidth: "62%" },
    { depth: depth + 2, icon: "circle", titleWidth: "44%" },
  ] as const;

  return (
    <div aria-label={t("common.loading")} className="relative flex animate-pulse flex-col gap-1">
      <div
        aria-hidden
        className="bg-border-subtle pointer-events-none absolute bottom-0 w-0.5 rounded-full"
        style={{ top: 38, left: depth * 10 + 12 }}
      />
      <div
        aria-hidden
        className="bg-border-subtle pointer-events-none absolute bottom-0 w-0.5 rounded-full"
        style={{ top: 72, left: (depth + 1) * 10 + 12 }}
      />
      {rows.map((row, index) => (
        <div
          key={index}
          aria-hidden
          style={{
            marginLeft: row.depth * 10,
            width: row.depth ? `calc(100% - ${row.depth * 10}px)` : undefined,
          }}
          className="flex h-[34px] w-full items-center gap-2 rounded-md px-2 py-1.5"
        >
          {row.icon === "square" ? (
            <span className="bg-surface-hover h-5 w-5 shrink-0 rounded-[5px]" />
          ) : (
            <span className="border-border bg-surface-hover h-3.5 w-3.5 shrink-0 rounded-full border" />
          )}
          <span className="bg-surface-hover h-3 rounded-full" style={{ width: row.titleWidth }} />
          <span className="bg-surface-hover ml-auto h-5 w-11 shrink-0 rounded" />
        </div>
      ))}
    </div>
  );
}

function sortExtensionTreeRoots(roots: SessionTreeRoot[]): SessionTreeRoot[] {
  return [...roots].sort(extensionTreeSort).map((root) => ({
    ...root,
    children: sortExtensionTreeNodes(root.children),
  }));
}

function sortExtensionTreeNodes(nodes: SessionTreeNode[] | undefined): SessionTreeNode[] {
  return [...(nodes ?? [])].sort(extensionTreeSort).map((node) => ({
    ...node,
    children: sortExtensionTreeNodes(node.children),
  }));
}

function extensionTreeSort(
  left: Pick<SessionTreeNode, "order" | "title">,
  right: Pick<SessionTreeNode, "order" | "title">,
): number {
  return (
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
    left.title.localeCompare(right.title)
  );
}

function extensionCollapsedKey(nodeId: string): string {
  return `extension:${nodeId}`;
}

function extensionSessionKey(extensionId: string, nodeId: string): string {
  return `${extensionId}\0${nodeId}`;
}
