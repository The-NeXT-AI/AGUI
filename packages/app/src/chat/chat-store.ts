import { startTransition } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentDesktopApi, AspConversationFile, AspProvider } from "@/asp/desktop-api";
import { desktopApi } from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { waitForAspRunProjection } from "@/asp/asp-run-projection";
import { uid } from "@/ui/id";
import { useUIStore } from "@/ui/ui-store";
import { extensionScopeWorkspaceId, useExtensionStore } from "@/extensions/extension-store";
import { useWorkspaceStore, withoutWorkspacePreferenceSync } from "@/workspaces/workspace-store";
import { contextUsageForSession } from "./context-usage";
import { buildAgentConversationContext } from "./agent-handoff";
import {
  assignConversationSequences,
  ensureProviderParticipant,
  normalizeAgentOrchestration,
  projectAgentLifecycle as projectAgentLifecycleState,
  providerParticipantId,
  targetPromptForSession,
} from "./agent-orchestration";
import { providerIdForSessionEvent } from "./agent-routing";
import {
  notifyAgentTaskCompleted,
  requestBrowserTaskNotificationPermission,
} from "./task-notifications";
import {
  blockOrder,
  isEmptyReasoningToolBlock,
  isInternalProtocolRawBlock,
  reduceEvent,
} from "./chat-block-reducer";
import {
  createDeferredJsonStorage,
  persistableSession,
  providerSupportsTranscriptHistory,
} from "./chat-persistence";
import {
  buildAdditionalDeveloperInstructions,
  buildAttachments,
  buildPrompt,
  contextUsageEqual,
  failedRunMessage,
  negotiatedRunExtensions,
  numberPayload,
  recordPayload,
  sessionTreeDeveloperInstructions,
  selectedEffort,
  selectedModel,
  selectedSpeed,
  tokenUsageFromAsp,
  truncate,
} from "./chat-run-helpers";
import {
  activeChatWorkspaceId,
  belongsToWorkspace,
  chatWorkspaceId,
  childFolderIds,
  createDraftSession,
  createDraftSessionForProject,
  createImportedSession,
  createMaterializedSession,
  draftForActiveWorkspace,
  folderWouldDescendInto,
  isolateWorkspaceOpenState,
  moveSessionPlacement,
  nextActiveSessionInProject,
  nextFolderOrder,
  normalizeSessionFolderId,
  normalizeSessionProjectKey,
  normalizeSessionProjects,
  normalizeSessionTreeState,
  placementOrderAtEnd,
  placementOrderAtStart,
  projectPathFromProjectKey,
  sessionProjectKey,
  upsertSessionProject,
  workspaceScopedId,
  DEFAULT_SESSION_FOLDER_COLOR,
  DEFAULT_SESSION_FOLDER_ICON,
  SESSION_TREE_ORDER_STEP,
} from "./chat-session-state";
import type {
  ChatStore,
  OpenExtensionSessionInput,
  PendingPrompt,
  ProjectAgentLifecycleInput,
  SessionRuntimePatch,
} from "./chat-store-types";
import {
  actionableProviderSessionId,
  providerSessionIdFromExtensionState,
  transcriptPathFromSession,
} from "./session-metadata";
import type { TranscriptSessionProjection } from "./transcript-projection";
import { boundedMcpAppStatePatch } from "./mcp-app-state";
import type {
  AgentRunSettings,
  AgentHandoffState,
  AgentSessionState,
  Attachment,
  ChatBlock,
  McpAppSessionState,
  QueuedPrompt,
  RetiredAgentSessionState,
  Session,
  SessionEvent,
} from "./types";

export { chatWorkspaceId } from "./chat-session-state";
export type { ChatStore } from "./chat-store-types";

export {
  isEmptyAssistantBlock,
  isEmptyReasoningBlock,
  isEmptyReasoningToolBlock,
  isInternalProtocolRawBlock,
  reduceEvent,
} from "./chat-block-reducer";

const pendingPrompts = new Map<string, PendingPrompt>();
const transcriptHydrations = new Set<string>();
const scheduledTranscriptHydrations = new Set<string>();
const TRANSCRIPT_HYDRATION_TTL_MS = 30_000;
const TRANSCRIPT_HYDRATION_VERSION = 3;

const chatPersistStorage = createDeferredJsonStorage<Partial<ChatStore>>();
const flushChatPersistence = () => chatPersistStorage?.flush();
let workspaceSessionIsolationDisposer: (() => void) | null = null;

export function installWorkspaceSessionIsolation(): () => void {
  if (workspaceSessionIsolationDisposer) return workspaceSessionIsolationDisposer;
  const isolate = () => {
    const workspace = useWorkspaceStore.getState();
    if (!workspace.initialized) return;
    useChatStore.getState().isolateWorkspaceSessions(workspace.activeWorkspaceId);
  };
  const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
    if (
      state.activeWorkspaceId === previous.activeWorkspaceId &&
      state.initialized === previous.initialized
    ) {
      return;
    }
    isolate();
  });
  const persistApi = (
    useChatStore as typeof useChatStore & {
      persist?: {
        onFinishHydration?: (listener: (state: ChatStore) => void) => () => void;
      };
    }
  ).persist;
  const unsubscribeHydration = persistApi?.onFinishHydration?.(() => isolate()) ?? (() => {});
  queueMicrotask(isolate);
  workspaceSessionIsolationDisposer = () => {
    unsubscribeWorkspace();
    unsubscribeHydration();
    workspaceSessionIsolationDisposer = null;
  };
  return workspaceSessionIsolationDisposer;
}

function scheduleActiveSessionTranscriptHydration(
  sessionId: string,
  hydrate: () => Promise<void>,
): void {
  if (scheduledTranscriptHydrations.has(sessionId)) return;
  scheduledTranscriptHydrations.add(sessionId);

  const run = () => {
    scheduledTranscriptHydrations.delete(sessionId);
    if (useChatStore.getState().activeSessionId !== sessionId) return;
    void hydrate();
  };

  if (typeof window === "undefined") {
    run();
    return;
  }

  window.requestAnimationFrame(() => {
    window.setTimeout(run, 0);
  });
}

function sessionNeedsTranscriptHydration(
  session: Session,
  asp: ReturnType<typeof useAspStore.getState>,
): boolean {
  if (session.status === "streaming") return false;
  const providerId = session.providerId || asp.activeProviderId;
  const transcriptPath = transcriptPathFromSession(session);
  const providerSessionId =
    session.providerSessionId || providerSessionIdFromExtensionState(session) || transcriptPath;
  const cwd = session.cwd || asp.workspacePath;
  return Boolean(
    providerId &&
    providerSessionId &&
    cwd &&
    !shouldSkipTranscriptHydration(session, providerSessionId),
  );
}

function setSessionTranscriptLoading(sessionId: string, transcriptLoading: boolean): void {
  useChatStore.setState((state) => {
    const index = state.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1 || state.sessions[index].transcriptLoading === transcriptLoading) return state;
    const sessions = state.sessions.slice();
    sessions[index] = { ...sessions[index], transcriptLoading };
    return { sessions };
  });
}

function shouldSkipTranscriptHydration(session: Session, providerSessionId: string): boolean {
  if (!session.blocks.length) return false;
  const state = recordPayload(session.extensionState?.session);
  const hydratedAt = numberPayload(state.transcriptHydratedAt);
  if (numberPayload(state.transcriptHydrationVersion) !== TRANSCRIPT_HYDRATION_VERSION)
    return false;
  if (!hydratedAt || Date.now() - hydratedAt > TRANSCRIPT_HYDRATION_TTL_MS) return false;
  const hydratedSessionId = providerSessionIdFromExtensionState(session);
  return !hydratedSessionId || hydratedSessionId === providerSessionId;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      sessionProjects: [],
      sessionFolders: [],
      sessionPlacements: {},
      draftSession: null,
      activeSessionId: null,
      openTabs: [],

      startDraftSession: () => {
        captureActiveAgentRunSettings();
        const draft = createDraftSession();
        set((state) => ({
          draftSession: draft,
          activeSessionId: null,
          openTabs: state.openTabs,
        }));
        return draft.id;
      },

      createSession: (input) => {
        captureActiveAgentRunSettings();
        const session = createMaterializedSession(input);
        set((state) => {
          const projectKey = sessionProjectKey(session);
          const workspaceId = workspaceScopedId(session);
          const folderId = normalizeSessionFolderId(
            input?.folderId,
            state.sessionFolders,
            projectKey,
            workspaceId,
          );
          return {
            sessions: [session, ...state.sessions],
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              session.projectPath,
              Date.now(),
              workspaceScopedId(session),
            ),
            sessionPlacements: {
              ...state.sessionPlacements,
              [session.id]: {
                folderId,
                order: placementOrderAtStart(
                  folderId,
                  projectKey,
                  state.sessions,
                  state.sessionPlacements,
                  workspaceId,
                ),
              },
            },
            draftSession: null,
            activeSessionId: session.id,
            openTabs: state.openTabs.includes(session.id)
              ? state.openTabs
              : [...state.openTabs, session.id],
          };
        });
        applySessionAgentRunSettings(session);
        return session.id;
      },

      importProviderSession: (input) => {
        const workspaceId = chatWorkspaceId(input.workspaceId ?? activeChatWorkspaceId());
        const existing = get().sessions.find(
          (session) =>
            belongsToWorkspace(session, workspaceId) &&
            sessionContainsProviderSession(session, input.providerId, input.providerSession.id),
        );
        if (existing) {
          get().openSession(existing.id);
          return existing.id;
        }
        captureActiveAgentRunSettings();
        const session = createImportedSession(input);
        set((state) => {
          const projectKey = sessionProjectKey(session);
          const sessionWorkspaceId = workspaceScopedId(session);
          const folderId = normalizeSessionFolderId(
            input.folderId,
            state.sessionFolders,
            projectKey,
            sessionWorkspaceId,
          );
          return {
            sessions: [session, ...state.sessions],
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              session.projectPath,
              Date.now(),
              workspaceScopedId(session),
            ),
            sessionPlacements: {
              ...state.sessionPlacements,
              [session.id]: {
                folderId,
                order: placementOrderAtStart(
                  folderId,
                  projectKey,
                  state.sessions,
                  state.sessionPlacements,
                  sessionWorkspaceId,
                ),
              },
            },
            draftSession: null,
            activeSessionId: session.id,
            openTabs: state.openTabs.includes(session.id)
              ? state.openTabs
              : [...state.openTabs, session.id],
          };
        });
        applySessionAgentRunSettings(session);
        void get().hydrateSessionTranscript(session.id);
        return session.id;
      },

      openExtensionSession: (input) => {
        captureActiveAgentRunSettings();
        const extensionId = input.extensionId.trim();
        const nodeId = input.nodeId.trim();
        if (!extensionId || !nodeId) throw new Error("Extension session requires an id.");
        const workspaceId = chatWorkspaceId(input.workspaceId ?? activeChatWorkspaceId());
        const title = input.title.trim() || "Extension session";
        const now = Date.now();
        let openedId = "";
        set((state) => {
          const existing = state.sessions.find(
            (session) =>
              belongsToWorkspace(session, workspaceId) &&
              session.extensionState?.sessionTree?.extensionId === extensionId &&
              session.extensionState.sessionTree.nodeId === nodeId,
          );
          const sessionTree = extensionSessionTreeState(
            input,
            title,
            now,
            existing?.extensionState?.sessionTree?.hideInSessionList ?? true,
          );
          if (existing) {
            openedId = existing.id;
            return {
              draftSession: null,
              activeSessionId: existing.id,
              openTabs: state.openTabs.includes(existing.id)
                ? state.openTabs
                : [...state.openTabs, existing.id],
              sessions: state.sessions.map((session) =>
                session.id === existing.id
                  ? {
                      ...session,
                      archivedAt: undefined,
                      blocks: extensionSessionBlocksWithInitialMarkdown(
                        session,
                        input.initialMarkdown,
                        now,
                        input.renderer,
                        input.metadata,
                      ),
                      extensionState: {
                        ...(session.extensionState ?? {}),
                        sessionTree,
                      },
                    }
                  : session,
              ),
            };
          }

          const session = {
            ...createMaterializedSession(
              {
                cwd: input.cwd,
                projectPath: input.projectPath,
                providerId: input.providerId,
                title,
                workspaceId,
              },
              now,
            ),
            blocks: extensionSessionInitialBlocks(
              input.initialMarkdown,
              now,
              input.renderer,
              input.metadata,
            ),
            extensionState: { sessionTree },
          };
          openedId = session.id;
          return {
            sessions: [session, ...state.sessions],
            draftSession: null,
            activeSessionId: session.id,
            openTabs: state.openTabs.includes(session.id)
              ? state.openTabs
              : [...state.openTabs, session.id],
          };
        });
        const opened = get().sessions.find((session) => session.id === openedId);
        if (opened) applySessionAgentRunSettings(opened);
        return openedId;
      },

      materializeExtensionSession: (input) => {
        const extensionId = input.extensionId.trim();
        const nodeId = input.nodeId.trim();
        if (!extensionId || !nodeId) throw new Error("Extension session requires an id.");
        const workspaceId = chatWorkspaceId(input.workspaceId ?? activeChatWorkspaceId());
        const title = input.title.trim() || "Extension session";
        const now = Date.now();
        let materializedId = "";
        set((state) => {
          const existing = state.sessions.find(
            (session) =>
              belongsToWorkspace(session, workspaceId) &&
              session.extensionState?.sessionTree?.extensionId === extensionId &&
              session.extensionState.sessionTree.nodeId === nodeId,
          );
          const sessionTree = extensionSessionTreeState(input, title, now, false);
          if (existing) {
            materializedId = existing.id;
            return {
              sessions: state.sessions.map((session) =>
                session.id === existing.id
                  ? {
                      ...session,
                      archivedAt: undefined,
                      blocks: extensionSessionBlocksWithInitialMarkdown(
                        session,
                        input.initialMarkdown,
                        now,
                        input.renderer,
                        input.metadata,
                      ),
                      extensionState: {
                        ...(session.extensionState ?? {}),
                        sessionTree,
                      },
                    }
                  : session,
              ),
            };
          }

          const session = {
            ...createMaterializedSession(
              {
                cwd: input.cwd,
                projectPath: input.projectPath,
                providerId: input.providerId,
                title,
                workspaceId,
              },
              now,
            ),
            blocks: extensionSessionInitialBlocks(
              input.initialMarkdown,
              now,
              input.renderer,
              input.metadata,
            ),
            extensionState: { sessionTree },
          };
          materializedId = session.id;
          return {
            sessions: [session, ...state.sessions],
          };
        });
        return materializedId;
      },

      materializeDraftSession: () => {
        const current = get();
        const workspaceId = activeChatWorkspaceId();
        if (
          current.activeSessionId &&
          current.sessions.some(
            (session) =>
              session.id === current.activeSessionId && belongsToWorkspace(session, workspaceId),
          )
        ) {
          return current.activeSessionId;
        }
        const draft = draftForActiveWorkspace(current.draftSession);
        const session = createMaterializedSession(
          {
            providerId: draft.providerId,
            projectPath: draft.projectPath,
            cwd: draft.cwd,
            folderId: draft.folderId,
            workspaceId: draft.workspaceId,
          },
          draft.createdAt,
        );
        set((state) => {
          const projectKey = sessionProjectKey(session);
          const sessionWorkspaceId = workspaceScopedId(session);
          const folderId = normalizeSessionFolderId(
            draft.folderId,
            state.sessionFolders,
            projectKey,
            sessionWorkspaceId,
          );
          return {
            sessions: [session, ...state.sessions],
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              session.projectPath,
              Date.now(),
              workspaceScopedId(session),
            ),
            sessionPlacements: {
              ...state.sessionPlacements,
              [session.id]: {
                folderId,
                order: placementOrderAtStart(
                  folderId,
                  projectKey,
                  state.sessions,
                  state.sessionPlacements,
                  sessionWorkspaceId,
                ),
              },
            },
            draftSession: null,
            activeSessionId: session.id,
            openTabs: state.openTabs.includes(session.id)
              ? state.openTabs
              : [...state.openTabs, session.id],
          };
        });
        return session.id;
      },

      isolateWorkspaceSessions: (workspaceId) => {
        const scopedWorkspaceId = chatWorkspaceId(workspaceId ?? activeChatWorkspaceId());
        set((state) => {
          const isolated = isolateWorkspaceOpenState(state, scopedWorkspaceId);
          if (
            state.activeSessionId === isolated.activeSessionId &&
            state.draftSession === isolated.draftSession &&
            sameStringList(state.openTabs, isolated.openTabs)
          ) {
            return state;
          }
          return {
            activeSessionId: isolated.activeSessionId,
            draftSession: isolated.draftSession,
            openTabs: isolated.openTabs,
          };
        });
        applyActiveSessionRunSettings();
      },

      openSession: (id) => {
        const target = get().sessions.find((session) => session.id === id);
        if (!target || !belongsToWorkspace(target, activeChatWorkspaceId())) return;
        captureActiveAgentRunSettings();
        let shouldHydrate = false;
        set((state) => ({
          draftSession: null,
          activeSessionId: id,
          sessions: (() => {
            const index = state.sessions.findIndex((session) => session.id === id);
            if (index === -1) return state.sessions;
            const session = state.sessions[index];
            const asp = useAspStore.getState();
            shouldHydrate = sessionNeedsTranscriptHydration(session, asp);
            const contextUsage = contextUsageForSession(session, asp.providers);
            if (
              contextUsageEqual(contextUsage, session.contextUsage) &&
              session.transcriptLoading === shouldHydrate
            ) {
              return state.sessions;
            }
            const sessions = state.sessions.slice();
            sessions[index] = { ...session, contextUsage, transcriptLoading: shouldHydrate };
            return sessions;
          })(),
          openTabs: state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id],
        }));
        if (shouldHydrate) {
          scheduleActiveSessionTranscriptHydration(id, () => get().hydrateSessionTranscript(id));
        }
        const opened = get().sessions.find((session) => session.id === id);
        if (opened) applySessionAgentRunSettings(opened);
      },
      closeTab: (id) => {
        captureActiveAgentRunSettings();
        set((state) => {
          const isolated = isolateWorkspaceOpenState(
            {
              ...state,
              activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
              openTabs: state.openTabs.filter((item) => item !== id),
            },
            activeChatWorkspaceId(),
          );
          return {
            openTabs: isolated.openTabs,
            activeSessionId: isolated.activeSessionId,
            draftSession:
              state.activeSessionId === id && isolated.openTabs.length === 0
                ? createDraftSession()
                : state.draftSession,
          };
        });
        applyActiveSessionRunSettings();
      },

      removeSession: (id) => {
        captureActiveAgentRunSettings();
        pendingPrompts.delete(id);
        const api = desktopApi();
        if (api) {
          void api.sessions
            .cancel(id)
            .catch(() => undefined)
            .then(() => api.sessions.cleanupHandoffFiles(id))
            .catch(() => undefined);
        }
        set((state) => {
          const removedSession = state.sessions.find((item) => item.id === id);
          const sessions = state.sessions.filter((item) => item.id !== id);
          const openTabs = state.openTabs.filter((item) => item !== id);
          const { [id]: removedPlacement, ...sessionPlacements } = state.sessionPlacements;
          const nextActiveSessionId =
            state.activeSessionId === id
              ? removedSession
                ? nextActiveSessionInProject(removedSession, sessions, openTabs)
                : null
              : state.activeSessionId;
          const draftFolderId = removedSession
            ? normalizeSessionFolderId(
                removedPlacement?.folderId,
                state.sessionFolders,
                sessionProjectKey(removedSession),
                workspaceScopedId(removedSession),
              )
            : null;
          return {
            sessions,
            sessionPlacements,
            openTabs,
            activeSessionId: nextActiveSessionId,
            draftSession:
              state.activeSessionId === id && !nextActiveSessionId
                ? removedSession
                  ? createDraftSessionForProject(
                      projectPathFromProjectKey(sessionProjectKey(removedSession)),
                      removedSession.providerId,
                      draftFolderId,
                      workspaceScopedId(removedSession),
                    )
                  : createDraftSession()
                : state.draftSession,
          };
        });
        applyActiveSessionRunSettings();
      },

      deleteSession: async (id) => {
        const api = desktopApi();
        if (!api) throw new Error("Session deletion is available in the desktop app.");
        const session = get().sessions.find((item) => item.id === id);
        if (!session) return false;
        const targets = agentSessionDeleteTargets(session);
        if (!targets.length) {
          throw new Error("This session does not have a provider-backed session to delete.");
        }
        const results = await Promise.allSettled(
          targets.map(async (target) => ({
            ...target,
            deleted: await api.sessions.delete({
              providerId: target.providerId,
              providerSessionId: target.providerSessionId,
              transcriptPath: target.transcriptPath,
              cwd: target.cwd || session.cwd || useAspStore.getState().workspacePath,
            }),
          })),
        );
        const deletedKeys = new Set<string>();
        const failures: string[] = [];
        results.forEach((result, index) => {
          const target = targets[index];
          if (result.status === "fulfilled" && result.value.deleted) {
            deletedKeys.add(target.key);
            return;
          }
          const providerName =
            useAspStore.getState().providers.find((provider) => provider.id === target.providerId)
              ?.name ?? target.providerId;
          failures.push(providerName);
        });
        if (failures.length) {
          if (deletedKeys.size) {
            set((state) => ({
              sessions: state.sessions.map((item) =>
                item.id === id ? removeDeletedAgentSessions(item, deletedKeys) : item,
              ),
            }));
          }
          throw new Error(`Could not delete sessions from: ${[...new Set(failures)].join(", ")}.`);
        }
        get().removeSession(id);
        return true;
      },

      renameSession: (id, title) =>
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? { ...session, title } : session,
          ),
        })),

      toggleSessionPinned: (id) =>
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id
              ? { ...session, pinnedAt: session.pinnedAt ? undefined : Date.now() }
              : session,
          ),
        })),

      archiveSession: (id) => {
        captureActiveAgentRunSettings();
        pendingPrompts.delete(id);
        void desktopApi()?.sessions.cancel(id);
        set((state) => {
          const removedSession = state.sessions.find((session) => session.id === id);
          const sessions = state.sessions.map((session) =>
            session.id === id
              ? syncAgentSession(
                  {
                    ...session,
                    archivedAt: session.archivedAt ?? Date.now(),
                    pinnedAt: undefined,
                    status: "idle" as const,
                    activeRunId: undefined,
                    activeRunProviderId: undefined,
                    activeRunRequestId: undefined,
                  },
                  session.activeRunProviderId ?? session.providerId,
                  session.activeRunProviderId ? { status: "failed" } : {},
                )
              : session,
          );
          const openTabs = state.openTabs.filter((item) => item !== id);
          const nextActiveSessionId =
            state.activeSessionId === id
              ? removedSession
                ? nextActiveSessionInProject(removedSession, sessions, openTabs)
                : null
              : state.activeSessionId;
          return {
            sessions,
            openTabs,
            activeSessionId: nextActiveSessionId,
            draftSession:
              state.activeSessionId === id && !nextActiveSessionId
                ? removedSession
                  ? createDraftSessionForProject(
                      projectPathFromProjectKey(sessionProjectKey(removedSession)),
                      removedSession.providerId,
                      normalizeSessionFolderId(
                        state.sessionPlacements[id]?.folderId,
                        state.sessionFolders,
                        sessionProjectKey(removedSession),
                        workspaceScopedId(removedSession),
                      ),
                      workspaceScopedId(removedSession),
                    )
                  : createDraftSession()
                : state.draftSession,
          };
        });
        applyActiveSessionRunSettings();
      },

      unarchiveSession: (id) =>
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? { ...session, archivedAt: undefined } : session,
          ),
        })),

      addSessionProject: (projectPath) =>
        set((state) => ({
          sessionProjects: upsertSessionProject(
            state.sessionProjects,
            projectPath,
            Date.now(),
            activeChatWorkspaceId(),
          ),
        })),

      removeSessionProject: (projectKey) =>
        set((state) => {
          const normalizedKey = normalizeSessionProjectKey(projectKey);
          const workspaceId = activeChatWorkspaceId();
          return {
            sessionProjects: state.sessionProjects.filter(
              (project) =>
                project.key !== normalizedKey || workspaceScopedId(project) !== workspaceId,
            ),
          };
        }),

      createSessionFolder: (input = {}) => {
        const id = uid("folder");
        set((state) => {
          const parent = input.parentId
            ? state.sessionFolders.find((folder) => folder.id === input.parentId)
            : undefined;
          const workspaceId = chatWorkspaceId(
            parent?.workspaceId ?? input.workspaceId ?? activeChatWorkspaceId(),
          );
          const projectKey = parent?.projectKey || input.projectKey || "private";
          const projectPath =
            parent?.projectPath ?? input.projectPath ?? projectPathFromProjectKey(projectKey);
          const parentId = normalizeSessionFolderId(
            input.parentId,
            state.sessionFolders,
            projectKey,
            workspaceId,
          );
          return {
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              projectPath,
              Date.now(),
              workspaceId,
            ),
            sessionFolders: [
              ...state.sessionFolders,
              {
                id,
                workspaceId,
                name: input.name?.trim() || "New folder",
                projectKey,
                projectPath,
                parentId,
                color: input.color || DEFAULT_SESSION_FOLDER_COLOR,
                icon: input.icon || DEFAULT_SESSION_FOLDER_ICON,
                order: nextFolderOrder(parentId, projectKey, state.sessionFolders, workspaceId),
                createdAt: Date.now(),
              },
            ],
          };
        });
        return id;
      },

      updateSessionFolder: (id, patch) =>
        set((state) => {
          const folderById = new Map(state.sessionFolders.map((folder) => [folder.id, folder]));
          const folder = folderById.get(id);
          if (!folder) return state;
          const workspaceId = workspaceScopedId(folder);
          const parentId =
            patch.parentId !== undefined
              ? normalizeSessionFolderId(
                  patch.parentId,
                  state.sessionFolders,
                  folder.projectKey,
                  workspaceId,
                )
              : undefined;
          if (parentId && folderWouldDescendInto(id, parentId, folderById)) return state;
          return {
            sessionFolders: state.sessionFolders.map((folder) =>
              folder.id === id
                ? {
                    ...folder,
                    ...patch,
                    name: patch.name !== undefined ? patch.name.trim() || folder.name : folder.name,
                    parentId: parentId !== undefined ? parentId : folder.parentId,
                    color: patch.color || folder.color,
                    icon: patch.icon || folder.icon,
                  }
                : folder,
            ),
          };
        }),

      deleteSessionFolder: (id) =>
        set((state) => {
          const folder = state.sessionFolders.find((item) => item.id === id);
          if (!folder) return state;
          const workspaceId = workspaceScopedId(folder);
          const removedFolderIds = childFolderIds(id, state.sessionFolders);
          const destinationFolderId =
            folder.parentId && !removedFolderIds.has(folder.parentId) ? folder.parentId : null;
          const remainingFolders = state.sessionFolders.filter(
            (item) => !removedFolderIds.has(item.id),
          );
          const sessionPlacements = { ...state.sessionPlacements };
          let order = placementOrderAtEnd(
            destinationFolderId,
            folder.projectKey,
            state.sessions,
            sessionPlacements,
            workspaceId,
          );
          for (const session of state.sessions) {
            const placement = sessionPlacements[session.id];
            if (
              workspaceScopedId(session) !== workspaceId ||
              sessionProjectKey(session) !== folder.projectKey ||
              !placement?.folderId ||
              !removedFolderIds.has(placement.folderId)
            ) {
              continue;
            }
            sessionPlacements[session.id] = {
              folderId: destinationFolderId,
              order,
            };
            order += SESSION_TREE_ORDER_STEP;
          }
          return {
            sessionFolders: remainingFolders,
            sessionPlacements,
          };
        }),

      moveSessionInTree: (input) =>
        set((state) => ({
          sessionPlacements: moveSessionPlacement(
            state.sessions,
            state.sessionFolders,
            state.sessionPlacements,
            input,
          ),
        })),

      dispatch: (event) => {
        const sessionId = get().activeSessionId;
        if (sessionId) get().dispatchTo(sessionId, event);
      },

      dispatchTo: (sessionId, event) => {
        get().dispatchManyTo(sessionId, [event]);
      },

      dispatchManyTo: (sessionId, events) => {
        if (events.length === 0) return;
        const completedSessions: Session[] = [];
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session;
            let nextSession = session;
            for (const event of events) {
              const eventProviderId = providerIdForSessionEvent(nextSession, event);
              if (!eventProviderId) continue;
              const annotatedBlocks = annotateAgentBlock(
                reduceEvent(nextSession.blocks, event, true),
                event,
                eventProviderId,
                providerSessionIdForAgent(nextSession, eventProviderId),
                nextSession.activeParticipantId ?? providerParticipantId(eventProviderId),
                nextSession.activeWorkItemId,
              );
              const sequenced = assignConversationSequences(
                annotatedBlocks,
                nextSession.conversationRevision,
              );
              const blocks = sequenced.blocks;
              if (event.type === "turn_complete") {
                const usage = event.usage ?? nextSession.usage;
                nextSession = syncAgentSession(
                  {
                    ...nextSession,
                    blocks,
                    conversationRevision: sequenced.revision,
                    usage,
                  },
                  eventProviderId,
                  { usage },
                );
                completedSessions.push(nextSession);
              } else {
                nextSession = {
                  ...nextSession,
                  blocks,
                  conversationRevision: sequenced.revision,
                };
              }
            }
            return nextSession;
          }),
        }));
        if (completedSessions.length) {
          flushChatPersistence();
          for (const completedSession of completedSessions) {
            notifyAgentTaskCompleted({
              sessionId: completedSession.id,
              title: completedSession.title,
            });
          }
        }
      },

      projectAgentLifecycle: (sessionId, input: ProjectAgentLifecycleInput) => {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId ? projectAgentLifecycleState(session, input) : session,
          ),
        }));
      },

      patchRuntime: (sessionId, runtimePatch, providerId) => {
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session;
            const runtimeProviderId =
              providerId ?? session.activeRunProviderId ?? session.providerId;
            const patchActiveSession = runtimeProviderId === session.providerId;
            const definedRuntimePatch = Object.fromEntries(
              Object.entries(runtimePatch).filter(
                ([key, value]) =>
                  value !== undefined && !(key === "contextUsage" && value === null),
              ),
            ) as Omit<SessionRuntimePatch, "contextUsage"> & {
              contextUsage?: Session["contextUsage"];
            };
            if (runtimePatch.contextUsage === null) {
              definedRuntimePatch.contextUsage = undefined;
            }
            const next = patchActiveSession ? { ...session, ...definedRuntimePatch } : session;
            const blocks = runtimePatch.providerSessionId
              ? annotateAgentProviderSessionBlocks(
                  next.blocks,
                  runtimeProviderId,
                  runtimePatch.providerSessionId,
                )
              : next.blocks;
            return syncAgentSession({ ...next, blocks }, runtimeProviderId, {
              providerSessionId: runtimePatch.providerSessionId,
              capabilities: runtimePatch.capabilities,
              availableCommands: runtimePatch.availableCommands,
              contextUsage: runtimePatch.contextUsage,
              usage: runtimePatch.usage,
              extensionState: runtimePatch.extensionState
                ? providerExtensionState(runtimePatch.extensionState)
                : undefined,
            });
          }),
        }));
        if ("usage" in runtimePatch || "contextUsage" in runtimePatch) {
          flushChatPersistence();
        }
      },

      hydrateSessionTranscript: async (id) => {
        let loadingCleared = false;
        const clearLoading = () => {
          if (loadingCleared) return;
          loadingCleared = true;
          setSessionTranscriptLoading(id, false);
        };
        const api = desktopApi();
        if (!api) {
          clearLoading();
          return;
        }
        const current = get();
        const session = current.sessions.find((item) => item.id === id);
        if (!session || session.status === "streaming") {
          clearLoading();
          return;
        }
        const asp = useAspStore.getState();
        const providerId = session.providerId || asp.activeProviderId;
        const sessionTranscriptPath = transcriptPathFromSession(session);
        const providerSessionId =
          session.providerSessionId ||
          providerSessionIdFromExtensionState(session) ||
          sessionTranscriptPath;
        const cwd = session.cwd || asp.workspacePath;
        if (!providerId || !providerSessionId || !cwd) {
          clearLoading();
          return;
        }
        if (shouldSkipTranscriptHydration(session, providerSessionId)) {
          clearLoading();
          return;
        }
        const hydrationKey = `${providerId}:${providerSessionId}`;
        if (transcriptHydrations.has(hydrationKey)) {
          clearLoading();
          return;
        }
        transcriptHydrations.add(hydrationKey);
        setSessionTranscriptLoading(id, true);
        try {
          let provider = asp.providers.find((item) => item.id === providerId);
          if (!providerSupportsTranscriptHistory(provider)) {
            provider =
              (await useAspStore.getState().refreshProviderCapabilities(providerId, cwd)) ??
              provider;
          }
          if (!providerSupportsTranscriptHistory(provider)) return;
          const latest = get().sessions.find((item) => item.id === id);
          if (
            !latest ||
            !sessionMatchesTranscriptHydration(latest, providerId, providerSessionId)
          ) {
            return;
          }
          const transcriptPath = transcriptPathFromSession(latest) || sessionTranscriptPath;
          const projection = (await api.sessions.hydrateTranscript({
            cwd,
            previousContextUsage: latest.contextUsage,
            providerId,
            providerSessionId,
            providers: useAspStore.getState().providers,
            transcriptPath,
          })) as TranscriptSessionProjection;
          if (!projection.blocks.length && !projection.contextUsage && !projection.usage) return;
          const ready = get().sessions.find((item) => item.id === id);
          if (!ready || !sessionMatchesTranscriptHydration(ready, providerId, providerSessionId)) {
            return;
          }
          loadingCleared = true;
          startTransition(() => {
            set((state) => ({
              sessions: state.sessions.map((item) => {
                if (item.id !== id) return item;
                if (!sessionMatchesTranscriptHydration(item, providerId, providerSessionId)) {
                  return item.transcriptLoading ? { ...item, transcriptLoading: false } : item;
                }
                const nextExtensionState = {
                  ...item.extensionState,
                  session: {
                    ...(item.extensionState?.session ?? {}),
                    ...(projection.sessionState ?? {}),
                    transcriptHydratedAt: Date.now(),
                    transcriptHydrationVersion: TRANSCRIPT_HYDRATION_VERSION,
                  },
                };
                const hydratedBlocks = projection.blocks.length
                  ? mergeHydratedAgentBlocks(item, projection.blocks, providerId, providerSessionId)
                  : item.blocks;
                const sequenced = assignConversationSequences(
                  hydratedBlocks,
                  item.conversationRevision,
                );
                return {
                  ...item,
                  title: projection.title || item.title,
                  providerSessionId: projection.providerSessionId || providerSessionId,
                  blocks: sequenced.blocks,
                  conversationRevision: sequenced.revision,
                  usage: projection.usage ?? item.usage,
                  contextUsage: projection.contextUsage ?? item.contextUsage,
                  extensionState: nextExtensionState,
                  transcriptLoading: false,
                };
              }),
            }));
          });
        } catch (error) {
          console.warn("Failed to hydrate session transcript.", error);
          // Transcript hydration is a cache refresh. Keep the persisted view if it fails.
        } finally {
          transcriptHydrations.delete(hydrationKey);
          clearLoading();
        }
      },

      updateMcpAppState: (sessionId, key, patch) => {
        const boundedPatch = boundedMcpAppStatePatch(patch);
        const now = Date.now();
        let updated: McpAppSessionState | undefined;
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session;
            const current = session.mcpAppState?.[key];
            updated = {
              key,
              title: boundedPatch.title ?? current?.title,
              server: boundedPatch.server ?? current?.server,
              resourceUri: boundedPatch.resourceUri ?? current?.resourceUri,
              documentId: boundedPatch.documentId ?? current?.documentId,
              widgetState:
                boundedPatch.widgetState !== undefined
                  ? boundedPatch.widgetState
                  : current?.widgetState,
              modelContext:
                boundedPatch.modelContext === null
                  ? undefined
                  : boundedPatch.modelContext !== undefined
                    ? { ...boundedPatch.modelContext, updatedAt: now }
                    : current?.modelContext,
              version: (current?.version ?? 0) + 1,
              updatedAt: now,
            };
            return {
              ...session,
              mcpAppState: {
                ...(session.mcpAppState ?? {}),
                [key]: updated,
              },
            };
          }),
        }));
        return updated;
      },

      setDraftProvider: (providerId) =>
        set((state) => ({
          draftSession: {
            ...draftForActiveWorkspace(state.draftSession),
            providerId,
          },
          activeSessionId: null,
        })),

      setDraftSessionFolder: (folderId) =>
        set((state) => {
          const draft = draftForActiveWorkspace(state.draftSession);
          const projectKey = sessionProjectKey(draft);
          return {
            draftSession: {
              ...draft,
              folderId: normalizeSessionFolderId(
                folderId,
                state.sessionFolders,
                projectKey,
                workspaceScopedId(draft),
              ),
            },
            activeSessionId: null,
          };
        }),

      setDraftWorkspace: (projectPath) =>
        set((state) => {
          const draft = draftForActiveWorkspace(state.draftSession);
          return {
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              projectPath,
              Date.now(),
              workspaceScopedId(draft),
            ),
            draftSession: {
              ...draft,
              projectPath,
              cwd: projectPath ?? "",
              folderId: normalizeSessionFolderId(
                draft.folderId,
                state.sessionFolders,
                sessionProjectKey({ ...draft, projectPath, cwd: projectPath ?? "" }),
                workspaceScopedId(draft),
              ),
            },
            activeSessionId: null,
          };
        }),

      setSessionProvider: (sessionId, providerId) => {
        const currentRunSettings = currentAgentRunSettings();
        set((state) => {
          if (state.draftSession?.id === sessionId) {
            return { draftSession: { ...state.draftSession, providerId } };
          }
          return {
            sessions: state.sessions.map((session) =>
              session.id === sessionId
                ? switchSessionProvider(session, providerId, currentRunSettings)
                : session,
            ),
          };
        });
        const switched = get().sessions.find((session) => session.id === sessionId);
        if (get().activeSessionId === sessionId && switched?.providerId === providerId) {
          applySessionAgentRunSettings(switched);
        }
      },

      restoreSessionRunSettings: (sessionId) => {
        const state = get();
        if (state.activeSessionId !== sessionId) return;
        const session = state.sessions.find((item) => item.id === sessionId);
        if (session) applySessionAgentRunSettings(session);
      },

      setSessionWorkspace: (sessionId, cwd) =>
        set((state) => {
          if (state.draftSession?.id === sessionId) {
            return {
              sessionProjects: upsertSessionProject(
                state.sessionProjects,
                cwd,
                Date.now(),
                workspaceScopedId(state.draftSession),
              ),
              draftSession: {
                ...state.draftSession,
                projectPath: cwd || null,
                cwd: cwd || "",
              },
            };
          }
          return {
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              cwd,
              Date.now(),
              workspaceScopedId(state.sessions.find((session) => session.id === sessionId)),
            ),
            sessions: state.sessions.map((session) =>
              session.id === sessionId && !session.providerSessionId
                ? {
                    ...session,
                    projectPath: cwd || null,
                    privateSessionPath: undefined,
                    cwd: cwd || "",
                  }
                : session,
            ),
          };
        }),

      send: async (text, attachments, options) => {
        const trimmed = text.trim();
        if (!trimmed && (!attachments || attachments.length === 0)) return;
        requestBrowserTaskNotificationPermission();
        let sessionId = get().activeSessionId;
        const workspaceId = activeChatWorkspaceId();
        if (
          !sessionId ||
          !get().sessions.some(
            (session) => session.id === sessionId && belongsToWorkspace(session, workspaceId),
          )
        ) {
          sessionId = get().materializeDraftSession();
        }

        const currentSession = get().sessions.find((session) => session.id === sessionId);
        if (!currentSession) return;
        const pending = preparePendingPrompt(currentSession, {
          attachments,
          text: trimmed,
        });
        if (isSessionRunning(currentSession) && !options?.editBlockId) {
          enqueuePrompt(sessionId, pending);
          return;
        }

        if (options?.editBlockId) {
          set((state) => ({
            sessions: state.sessions.map((session) => {
              if (session.id !== sessionId) return session;
              const index = session.blocks.findIndex((block) => block.id === options.editBlockId);
              if (index < 0 || session.blocks[index]?.kind !== "user") return session;
              return resetAgentThreadsForFork(session, session.blocks.slice(0, index), "edit");
            }),
          }));
        }

        await startDesktopPrompt(sessionId, pending, trimmed);
      },

      runTurn: async (prompt) => {
        const sessionId = get().activeSessionId;
        if (!sessionId) return;
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session || !belongsToWorkspace(session, activeChatWorkspaceId())) return;
        requestBrowserTaskNotificationPermission();
        await startDesktopPrompt(sessionId, preparePendingPrompt(session, { text: prompt }));
      },

      removeQueuedPrompt: (sessionId, promptId) => {
        const at = Date.now();
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session;
            const prompt = session.queuedPrompts?.find((item) => item.id === promptId);
            const workItemId = prompt?.workItemId;
            const workItem = workItemId ? session.workItems?.[workItemId] : undefined;
            return {
              ...session,
              queuedPrompts: (session.queuedPrompts ?? []).filter(
                (queued) => queued.id !== promptId,
              ),
              workItems:
                workItemId && workItem
                  ? {
                      ...(session.workItems ?? {}),
                      [workItemId]: {
                        ...workItem,
                        status: "cancelled" as const,
                        updatedAt: at,
                      },
                    }
                  : session.workItems,
            };
          }),
        }));
      },

      steerQueuedPrompt: async (sessionId, promptId) => {
        const session = get().sessions.find((item) => item.id === sessionId);
        const prompt = session?.queuedPrompts?.find((item) => item.id === promptId);
        if (!session || !prompt) return;
        const pending = preparePendingPrompt(session, prompt);
        if (!isSessionRunning(session)) {
          get().removeQueuedPrompt(sessionId, promptId);
          await startDesktopPrompt(sessionId, pending, prompt.text);
          return;
        }
        if (
          pending.targetProviderId !== (session.activeRunProviderId ?? session.providerId) ||
          pending.targetParticipantId !==
            (session.activeParticipantId ?? providerParticipantId(session.providerId))
        ) {
          return;
        }

        const api = desktopApi();
        if (!api) {
          get().dispatchTo(sessionId, {
            id: uid("e"),
            type: "error",
            message: "ASP agents are available in the Electron desktop app. Run `pnpm dev`.",
            at: Date.now(),
          });
          return;
        }

        try {
          const providerSessionId = actionableProviderSessionId(
            providerSessionIdForAgent(session, session.activeRunProviderId ?? session.providerId) ??
              session.providerSessionId ??
              providerSessionIdFromExtensionState(session),
          );
          await api.sessions.invokeExtension({
            uiSessionId: sessionId,
            extension: "asp.ext.run-control",
            method: "steer",
            runId: session.activeRunId,
            providerSessionId: providerSessionId || undefined,
            payload: {
              message: buildPrompt(prompt.text, prompt.attachments, session.mcpAppState),
            },
          });
          get().removeQueuedPrompt(sessionId, promptId);
          get().dispatchTo(sessionId, {
            id: uid("e"),
            type: "user_message",
            text: prompt.text,
            attachments: prompt.attachments,
            agentParticipantId: pending.targetParticipantId,
            agentProviderId: pending.targetProviderId,
            workItemId: pending.workItemId,
            at: Date.now(),
          });
        } catch (error) {
          get().dispatchTo(sessionId, {
            id: uid("e"),
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          });
        }
      },

      ensureScheduledTaskSession: (input) => {
        const sessionId = input.sessionId.trim();
        if (!sessionId) return;
        if (get().sessions.some((session) => session.id === sessionId)) return;
        const session = createMaterializedSession(
          {
            cwd: input.cwd,
            id: sessionId,
            projectPath: input.projectPath,
            providerId: input.providerId,
            title: input.title.trim() || "Scheduled task",
            workspaceId: input.workspaceId,
          },
          input.createdAt ?? Date.now(),
        );
        set((state) => {
          const projectKey = sessionProjectKey(session);
          const workspaceId = workspaceScopedId(session);
          return {
            sessions: [session, ...state.sessions],
            sessionProjects: upsertSessionProject(
              state.sessionProjects,
              session.projectPath,
              Date.now(),
              workspaceScopedId(session),
            ),
            sessionPlacements: {
              ...state.sessionPlacements,
              [session.id]: {
                folderId: null,
                order: placementOrderAtStart(
                  null,
                  projectKey,
                  state.sessions,
                  state.sessionPlacements,
                  workspaceId,
                ),
              },
            },
          };
        });
      },

      stop: () => {
        const sessionId = get().activeSessionId;
        if (sessionId) void desktopApi()?.sessions.cancel(sessionId);
      },

      reviewDiff: (toolId, review) =>
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== state.activeSessionId) return session;
            return {
              ...session,
              blocks: session.blocks.map((block) =>
                block.id === toolId && block.kind === "diff" ? { ...block, review } : block,
              ),
            };
          }),
        })),

      editUserMessage: (blockId) => {
        const state = get();
        const sessionId = state.activeSessionId;
        if (!sessionId) return;
        const session = state.sessions.find((item) => item.id === sessionId);
        const index = session?.blocks.findIndex((block) => block.id === blockId) ?? -1;
        if (!session || index < 0) return;
        const block = session.blocks[index];
        if (block?.kind !== "user") return;
        useUIStore.getState().setMessageEditDraft({
          attachments: block.attachments,
          blockId,
          sessionId,
          text: block.text,
        });
      },

      branchFromBlock: (blockId) => {
        const state = get();
        const sessionId = state.activeSessionId;
        if (!sessionId) return;
        const session = state.sessions.find((item) => item.id === sessionId);
        const index = session?.blocks.findIndex((block) => block.id === blockId) ?? -1;
        if (!session || index < 0) return;

        const branchedSession: Session = {
          ...session,
          id: uid("s"),
          title: `${session.title || "New session"} branch`,
          blocks: session.blocks.slice(0, index + 1).map((block) => {
            if (block.kind === "assistant" || block.kind === "reasoning") {
              return { ...block, streaming: false };
            }
            if (block.kind === "terminal") {
              return { ...block, streaming: false };
            }
            return block;
          }),
          status: "idle",
          providerSessionId: undefined,
          activeRunId: undefined,
          activeRunProviderId: undefined,
          activeRunRequestId: undefined,
          activeParticipantId: providerParticipantId(session.providerId),
          activeWorkItemId: undefined,
          activeHandoffId: undefined,
          agentSessions: {
            [session.providerId]: {
              status: "never_used",
              runSettings:
                session.agentSessions?.[session.providerId]?.runSettings ??
                currentAgentRunSettings(),
            },
          },
          agentParticipants: {
            [providerParticipantId(session.providerId)]: {
              id: providerParticipantId(session.providerId),
              providerId: session.providerId,
              role: "primary",
              kind: "provider",
              status: "idle",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
          workItems: {},
          agentRuns: {},
          handoffs: [],
          retiredAgentSessions: undefined,
          connectionState: "disconnected",
          connectionMessage: undefined,
          usage: undefined,
          contextUsage: undefined,
          capabilities: undefined,
          availableCommands: undefined,
          extensionState: sharedExtensionState(session.extensionState),
          pinnedAt: undefined,
          archivedAt: undefined,
          createdAt: Date.now(),
        };

        set((current) => {
          const projectKey = sessionProjectKey(branchedSession);
          const workspaceId = workspaceScopedId(branchedSession);
          const folderId = normalizeSessionFolderId(
            current.sessionPlacements[session.id]?.folderId,
            current.sessionFolders,
            projectKey,
            workspaceId,
          );
          return {
            sessions: [branchedSession, ...current.sessions],
            sessionProjects: upsertSessionProject(
              current.sessionProjects,
              branchedSession.projectPath,
              Date.now(),
              workspaceScopedId(branchedSession),
            ),
            sessionPlacements: {
              ...current.sessionPlacements,
              [branchedSession.id]: {
                folderId,
                order: placementOrderAtStart(
                  folderId,
                  projectKey,
                  current.sessions,
                  current.sessionPlacements,
                  workspaceId,
                ),
              },
            },
            draftSession: null,
            activeSessionId: branchedSession.id,
            openTabs: current.openTabs.includes(branchedSession.id)
              ? current.openTabs
              : [...current.openTabs, branchedSession.id],
          };
        });
      },

      regenerateAt: (blockId) => {
        const state = get();
        const sessionId = state.activeSessionId;
        if (!sessionId) return;
        const session = state.sessions.find((item) => item.id === sessionId);
        const index = session?.blocks.findIndex((block) => block.id === blockId) ?? -1;
        if (!session || index < 0) return;
        let prompt = "";
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          const block = session.blocks[cursor];
          if (block?.kind === "user") {
            prompt = block.text;
            break;
          }
        }
        set((current) => ({
          sessions: current.sessions.map((item) =>
            item.id === sessionId
              ? resetAgentThreadsForFork(item, item.blocks.slice(0, index), "regenerate")
              : item,
          ),
        }));
        void get().runTurn(prompt);
      },
    }),
    {
      name: "agui-asp-sessions",
      storage: chatPersistStorage,
      partialize: (state) => {
        const openState = useWorkspaceStore.getState().initialized
          ? isolateWorkspaceOpenState(state, activeChatWorkspaceId())
          : normalizePersistedOpenState(state.sessions, state.activeSessionId, state.openTabs);
        return {
          sessions: state.sessions.map((session) =>
            persistableSession(session, useAspStore.getState().providers),
          ),
          sessionProjects: state.sessionProjects,
          sessionFolders: state.sessionFolders,
          sessionPlacements: state.sessionPlacements,
          activeSessionId: openState.activeSessionId,
          openTabs: openState.openTabs,
        };
      },
      merge: (persisted, current) => {
        const saved = persisted as Partial<ChatStore>;
        const restoredSessions = (saved.sessions ?? []).map((session) => {
          const restored = {
            ...session,
            workspaceId: workspaceScopedId(session),
            projectPath:
              session.projectPath !== undefined
                ? session.projectPath
                : session.privateSessionPath
                  ? null
                  : session.cwd || null,
            cwd: session.cwd || session.projectPath || session.privateSessionPath || "",
            status: "idle" as const,
            connectionState: "disconnected" as const,
            connectionMessage: undefined,
            transcriptLoading: undefined,
            activeRunId: undefined,
            activeRunProviderId: undefined,
            activeRunRequestId: undefined,
            activeWorkItemId: undefined,
            activeHandoffId: undefined,
            agentParticipants: session.agentParticipants
              ? Object.fromEntries(
                  Object.entries(session.agentParticipants).map(([id, participant]) => [
                    id,
                    participant.status === "running"
                      ? { ...participant, status: "failed" as const, updatedAt: Date.now() }
                      : participant,
                  ]),
                )
              : undefined,
            workItems: session.workItems
              ? Object.fromEntries(
                  Object.entries(session.workItems).map(([id, workItem]) => [
                    id,
                    workItem.status === "running"
                      ? { ...workItem, status: "failed" as const, updatedAt: Date.now() }
                      : workItem,
                  ]),
                )
              : undefined,
            agentRuns: session.agentRuns
              ? Object.fromEntries(
                  Object.entries(session.agentRuns).map(([id, run]) => [
                    id,
                    run.status === "running" || run.status === "queued"
                      ? { ...run, status: "failed" as const, finishedAt: Date.now() }
                      : run,
                  ]),
                )
              : undefined,
            handoffs: session.handoffs?.map((handoff) =>
              handoff.status === "queued" || handoff.status === "delivered"
                ? { ...handoff, status: "failed" as const, finishedAt: Date.now() }
                : handoff,
            ),
            agentSessions: session.agentSessions
              ? Object.fromEntries(
                  Object.entries(session.agentSessions).map(([providerId, route]) => [
                    providerId,
                    route.status === "running" ? { ...route, status: "failed" as const } : route,
                  ]),
                )
              : undefined,
            blocks: session.blocks
              .filter(
                (block) => !isInternalProtocolRawBlock(block) && !isEmptyReasoningToolBlock(block),
              )
              .map((block) =>
                block.kind === "assistant" || block.kind === "reasoning"
                  ? { ...block, streaming: false }
                  : block.kind === "terminal"
                    ? { ...block, streaming: false }
                    : block,
              ),
          };
          const normalized = normalizeAgentOrchestration(restored);
          return {
            ...normalized,
            queuedPrompts: restored.queuedPrompts?.map((prompt) => ({
              ...targetPromptForSession(normalized, prompt, {
                promptId: prompt.id,
                workItemId: prompt.workItemId || `queued-work:${prompt.id}`,
              }),
              createdAt: prompt.createdAt,
            })),
            contextUsage: contextUsageForSession(normalized, useAspStore.getState().providers),
          };
        });
        const normalizedTree = normalizeSessionTreeState(
          restoredSessions,
          saved.sessionFolders,
          saved.sessionPlacements,
        );
        const restoredOpenState = normalizePersistedOpenState(
          restoredSessions,
          saved.activeSessionId ?? null,
          saved.openTabs ?? [],
        );
        return {
          ...current,
          ...saved,
          draftSession: null,
          sessions: restoredSessions,
          sessionProjects: normalizeSessionProjects(saved.sessionProjects),
          sessionFolders: normalizedTree.folders,
          sessionPlacements: normalizedTree.placements,
          activeSessionId: restoredOpenState.activeSessionId,
          openTabs: restoredOpenState.openTabs,
        };
      },
    },
  ),
);

function extensionSessionInitialBlocks(
  markdown: string | undefined,
  at: number,
  renderer?: string,
  metadata?: Record<string, unknown>,
): ChatBlock[] {
  const text = markdown?.trim();
  if (!text) return [];
  const blockMetadata = {
    ...(metadata ?? {}),
    extensionSessionContext: true,
    ...(renderer ? { renderer } : {}),
  };
  return [
    {
      id: uid("b"),
      kind: "assistant",
      text,
      streaming: false,
      at,
      metadata: blockMetadata,
    },
  ];
}

function extensionSessionBlocksWithInitialMarkdown(
  session: Session,
  markdown: string | undefined,
  at: number,
  renderer?: string,
  metadata?: Record<string, unknown>,
): ChatBlock[] {
  const nextBlocks = extensionSessionInitialBlocks(markdown, at, renderer, metadata);
  if (!nextBlocks.length) return session.blocks;
  if (canRefreshExtensionInitialBlocks(session.blocks)) return nextBlocks;
  return extensionSessionContextBlock(session)
    ? session.blocks
    : [nextBlocks[0], ...session.blocks];
}

function canRefreshExtensionInitialBlocks(blocks: ChatBlock[]): boolean {
  if (blocks.length === 0) return true;
  return blocks.length === 1 && blocks[0].kind === "assistant" && !blocks[0].streaming;
}

function extensionSessionTreeState(
  input: OpenExtensionSessionInput,
  title: string,
  updatedAt: number,
  hideInSessionList: boolean,
): NonNullable<Session["extensionState"]>["sessionTree"] {
  return {
    extensionId: input.extensionId.trim(),
    rootId: input.rootId,
    nodeId: input.nodeId.trim(),
    title,
    developerInstructions: input.developerInstructions,
    metadata: input.metadata,
    hideInSessionList,
    updatedAt,
  };
}

function mergeExtensionSessionContextBlocks(session: Session, transcriptBlocks: ChatBlock[]) {
  const contextBlock = extensionSessionContextBlock(session);
  if (!contextBlock) return transcriptBlocks;
  const transcriptIds = new Set(transcriptBlocks.map((block) => block.id));
  return transcriptIds.has(contextBlock.id)
    ? transcriptBlocks
    : [contextBlock, ...transcriptBlocks];
}

function mergeHydratedAgentBlocks(
  session: Session,
  transcriptBlocks: ChatBlock[],
  providerId: string,
  providerSessionId: string,
): ChatBlock[] {
  const incoming = mergeExtensionSessionContextBlocks(
    session,
    annotateAgentBlocks(transcriptBlocks, providerId, providerSessionId),
  );
  if (!sessionHasMultipleAgents(session)) return incoming;

  const merged = [...session.blocks];
  const matched = new Set<number>();
  for (const block of incoming) {
    const index = merged.findIndex(
      (candidate, candidateIndex) =>
        !matched.has(candidateIndex) && hydratedBlockMatches(candidate, block, providerId),
    );
    if (index < 0) {
      merged.push(block);
      continue;
    }
    matched.add(index);
    merged[index] = {
      ...block,
      conversationSeq: merged[index].conversationSeq,
      workItemId: merged[index].workItemId ?? block.workItemId,
      runId: merged[index].runId ?? block.runId,
    };
  }
  return merged;
}

function hydratedBlockMatches(
  existing: ChatBlock,
  incoming: ChatBlock,
  providerId: string,
): boolean {
  if (existing.id === incoming.id) return true;
  if (existing.kind !== incoming.kind) return false;
  if (existing.kind === "user" && incoming.kind === "user") {
    return existing.text.trim() === incoming.text.trim();
  }
  if (existing.agentProviderId !== providerId) return false;
  if (existing.kind === "assistant" && incoming.kind === "assistant") {
    return existing.text.trim() === incoming.text.trim();
  }
  if (existing.kind === "tool" && incoming.kind === "tool") {
    return existing.title === incoming.title && existing.output === incoming.output;
  }
  if (existing.kind === "terminal" && incoming.kind === "terminal") {
    return existing.command === incoming.command && existing.output === incoming.output;
  }
  if (existing.kind === "diff" && incoming.kind === "diff") return existing.path === incoming.path;
  return false;
}

function extensionSessionContextBlock(
  session: Session,
): Extract<ChatBlock, { kind: "assistant" }> | null {
  if (!session.extensionState?.sessionTree) return null;
  const first = session.blocks[0];
  if (!first || first.kind !== "assistant" || first.streaming) return null;
  if (first.metadata?.extensionSessionContext === true) return first;
  if (first.metadata?.renderer) return first;
  return first.agentProviderId ? null : first;
}

function switchSessionProvider(
  session: Session,
  providerId: string,
  currentRunSettings: AgentRunSettings,
): Session {
  if (session.status === "streaming" || session.providerId === providerId) return session;
  const currentAgentSession = agentSessionStateFromSession(session);
  const agentSessions = {
    ...(session.agentSessions ?? {}),
    [session.providerId]: {
      ...currentAgentSession,
      runSettings: currentRunSettings,
    },
  };
  const nextAgentSession =
    agentSessions[providerId] ?? defaultAgentSessionState(providerId, currentRunSettings);
  agentSessions[providerId] = nextAgentSession;
  const switched: Session = {
    ...session,
    providerId,
    activeParticipantId: providerParticipantId(providerId),
    agentSessions,
    providerSessionId: nextAgentSession
      ? providerSessionIdFromAgentSession(nextAgentSession) || undefined
      : undefined,
    capabilities: nextAgentSession?.capabilities,
    availableCommands: nextAgentSession?.availableCommands,
    contextUsage: nextAgentSession?.contextUsage,
    usage: nextAgentSession?.usage,
    transcriptLoading: undefined,
    connectionState: "disconnected",
    connectionMessage: undefined,
    extensionState: extensionStateForAgent(session.extensionState, nextAgentSession),
  };
  return ensureProviderParticipant(switched, providerId);
}

function agentSessionStateFromSession(session: Session): AgentSessionState {
  const existing = session.agentSessions?.[session.providerId];
  return {
    ...existing,
    status:
      existing?.status ??
      (session.providerSessionId || existing?.providerSessionId ? "synced" : "never_used"),
    providerSessionId: session.providerSessionId,
    capabilities: session.capabilities,
    availableCommands: session.availableCommands,
    contextUsage: session.contextUsage,
    usage: session.usage,
    extensionState: providerExtensionState(session.extensionState),
    sessionState: existing?.sessionState,
    cwd: session.cwd,
    lastSyncedBlockId:
      existing?.lastSyncedBlockId ??
      (session.providerSessionId && !existing
        ? lastSharedConversationBlockId(session.blocks)
        : undefined),
  };
}

function defaultAgentSessionState(
  providerId: string,
  fallback: AgentRunSettings,
): AgentSessionState {
  const provider = useAspStore.getState().providers.find((item) => item.id === providerId);
  const model = selectedModel(provider?.models, "") ?? "";
  return {
    status: "never_used",
    runSettings: {
      approvalMode: fallback.approvalMode,
      model,
      effort: selectedEffort(provider?.models, provider?.capabilities, model, "") ?? "",
      speed: selectedSpeed(provider?.models, provider?.capabilities, model, "default"),
    },
  };
}

function currentAgentRunSettings(): AgentRunSettings {
  const ui = useUIStore.getState();
  return {
    approvalMode: ui.approvalMode,
    effort: ui.effort,
    model: ui.model,
    speed: ui.speed,
  };
}

function applyAgentRunSettings(settings: AgentRunSettings | undefined): void {
  if (!settings) return;
  withoutWorkspacePreferenceSync(() => {
    const ui = useUIStore.getState();
    if (ui.approvalMode !== settings.approvalMode) ui.setApprovalMode(settings.approvalMode);
    if (ui.model !== settings.model) ui.setModel(settings.model);
    if (ui.effort !== settings.effort) ui.setEffort(settings.effort);
    if (ui.speed !== settings.speed) ui.setSpeed(settings.speed);
  });
}

function sessionAgentRunSettings(session: Session): AgentRunSettings {
  const route = session.agentSessions?.[session.providerId];
  const fallback = defaultAgentSessionState(session.providerId, currentAgentRunSettings())
    .runSettings as AgentRunSettings;
  const sessionState = route
    ? agentSessionExtensionSession(route)
    : recordPayload(session.extensionState?.session);
  const sessionModel = typeof sessionState.model === "string" ? sessionState.model : "";
  const requested = route?.runSettings ?? {
    ...fallback,
    model: sessionModel || fallback.model,
  };
  const provider = useAspStore.getState().providers.find((item) => item.id === session.providerId);
  const model = selectedModel(provider?.models, requested.model) ?? requested.model;
  return {
    approvalMode: requested.approvalMode,
    model,
    effort: selectedEffort(provider?.models, provider?.capabilities, model, requested.effort) ?? "",
    speed: selectedSpeed(provider?.models, provider?.capabilities, model, requested.speed),
  };
}

function applySessionAgentRunSettings(session: Session): void {
  applyAgentRunSettings(sessionAgentRunSettings(session));
}

function patchAgentSession(
  sessionId: string,
  providerId: string,
  patch: Partial<AgentSessionState>,
): void {
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const route = {
        ...(session.agentSessions?.[providerId] ??
          (session.providerId === providerId
            ? agentSessionStateFromSession(session)
            : { status: "never_used" as const })),
        ...patch,
      };
      return syncProviderParticipantState(
        {
          ...session,
          agentSessions: {
            ...(session.agentSessions ?? {}),
            [providerId]: route,
          },
        },
        providerId,
        route,
      );
    }),
  }));
}

function resetAgentThreadsForFork(
  session: Session,
  blocks: ChatBlock[],
  reason: RetiredAgentSessionState["reason"],
): Session {
  const activeRoutes: Record<string, AgentSessionState> = {
    ...(session.agentSessions ?? {}),
    [session.providerId]: agentSessionStateFromSession(session),
  };
  const retiredAt = Date.now();
  const newlyRetired = Object.entries(activeRoutes)
    .filter(([, route]) => agentSessionIsProviderBacked(route))
    .map(([providerId, route]): RetiredAgentSessionState => ({
      ...route,
      providerId,
      reason,
      retiredAt,
    }));
  const retiredByKey = new Map<string, RetiredAgentSessionState>();
  for (const route of [...(session.retiredAgentSessions ?? []), ...newlyRetired]) {
    retiredByKey.set(agentSessionDeleteKey(route.providerId, route), route);
  }
  const agentSessions = Object.fromEntries(
    Object.entries(activeRoutes).map(([providerId, route]) => [
      providerId,
      {
        status: "never_used" as const,
        runSettings: route.runSettings,
      },
    ]),
  );
  const maxSeq = Math.max(0, ...blocks.map((block) => block.conversationSeq ?? 0));
  const handoffs = (session.handoffs ?? []).filter((handoff) => handoff.highWatermarkSeq <= maxSeq);
  const retainedWorkItemIds = new Set(
    blocks.map((block) => block.workItemId).filter((id): id is string => Boolean(id)),
  );
  for (const handoff of handoffs) retainedWorkItemIds.add(handoff.workItemId);
  return {
    ...session,
    blocks,
    status: "idle",
    providerSessionId: undefined,
    agentSessions,
    activeRunId: undefined,
    activeRunProviderId: undefined,
    activeRunRequestId: undefined,
    activeWorkItemId: undefined,
    activeHandoffId: undefined,
    agentParticipants: Object.fromEntries(
      Object.entries(session.agentParticipants ?? {})
        .filter(([, participant]) => participant.kind === "provider")
        .map(([id, participant]) => [
          id,
          {
            ...participant,
            backendSessionId: undefined,
            status: "idle" as const,
            updatedAt: retiredAt,
          },
        ]),
    ),
    workItems: Object.fromEntries(
      Object.entries(session.workItems ?? {}).filter(([id]) => retainedWorkItemIds.has(id)),
    ),
    agentRuns: Object.fromEntries(
      Object.entries(session.agentRuns ?? {}).filter(([, run]) =>
        retainedWorkItemIds.has(run.workItemId),
      ),
    ),
    handoffs,
    retiredAgentSessions: [...retiredByKey.values()],
    capabilities: undefined,
    availableCommands: undefined,
    contextUsage: undefined,
    usage: undefined,
    connectionState: "disconnected",
    connectionMessage: undefined,
    extensionState: sharedExtensionState(session.extensionState),
  };
}

type AgentSessionDeleteTarget = {
  cwd?: string;
  key: string;
  providerId: string;
  providerSessionId: string;
  transcriptPath?: string;
};

function agentSessionDeleteTargets(session: Session): AgentSessionDeleteTarget[] {
  const routes: Array<{ providerId: string; route: AgentSessionState }> = [
    ...Object.entries(session.agentSessions ?? {}).map(([providerId, route]) => ({
      providerId,
      route,
    })),
    { providerId: session.providerId, route: agentSessionStateFromSession(session) },
    ...(session.retiredAgentSessions ?? []).map((route) => ({
      providerId: route.providerId,
      route,
    })),
  ];
  const targets = new Map<string, AgentSessionDeleteTarget>();
  for (const { providerId, route } of routes) {
    const rawProviderSessionId = providerSessionIdFromAgentSession(route);
    const providerSessionId = actionableProviderSessionId(rawProviderSessionId);
    const transcriptPath = transcriptPathFromAgentSession(route);
    if (!providerId || (!providerSessionId && !transcriptPath)) continue;
    const key = agentSessionDeleteKey(providerId, route);
    targets.set(key, {
      key,
      cwd: route.cwd,
      providerId,
      providerSessionId: providerSessionId || rawProviderSessionId || "transcript",
      transcriptPath: transcriptPath || undefined,
    });
  }
  return [...targets.values()];
}

export function agentSessionIsProviderBacked(route: AgentSessionState): boolean {
  return Boolean(
    actionableProviderSessionId(providerSessionIdFromAgentSession(route)) ||
    transcriptPathFromAgentSession(route),
  );
}

export function providerSessionIdFromAgentSession(route: AgentSessionState): string {
  const state = agentSessionExtensionSession(route);
  return (
    route.providerSessionId?.trim() ||
    stringRecordValue(state.providerSessionId) ||
    stringRecordValue(state.provider_session_id) ||
    stringRecordValue(state.sessionId) ||
    stringRecordValue(state.session_id) ||
    stringRecordValue(state.threadId) ||
    stringRecordValue(state.thread_id)
  );
}

export function transcriptPathFromAgentSession(route: AgentSessionState): string {
  const state = agentSessionExtensionSession(route);
  const metadata = recordPayload(state.metadata);
  return (
    stringRecordValue(state.transcriptPath) ||
    stringRecordValue(state.transcript_path) ||
    stringRecordValue(metadata.transcriptPath) ||
    stringRecordValue(metadata.transcript_path) ||
    stringRecordValue(metadata.path)
  );
}

function stringRecordValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizePersistedOpenState(
  sessions: Session[],
  activeSessionId: string | null,
  openTabs: string[],
): Pick<ChatStore, "activeSessionId" | "openTabs"> {
  const openableSessionIds = new Set(
    sessions.filter((session) => !session.archivedAt).map((session) => session.id),
  );
  const normalizedOpenTabs = openTabs.filter((id) => openableSessionIds.has(id));
  return {
    activeSessionId:
      activeSessionId && openableSessionIds.has(activeSessionId)
        ? activeSessionId
        : (normalizedOpenTabs[normalizedOpenTabs.length - 1] ?? null),
    openTabs: normalizedOpenTabs,
  };
}

export function agentSessionDeleteKey(providerId: string, route: AgentSessionState): string {
  const providerSessionId = actionableProviderSessionId(providerSessionIdFromAgentSession(route));
  return providerSessionId
    ? `${providerId}\0id:${providerSessionId}`
    : `${providerId}\0path:${transcriptPathFromAgentSession(route)}`;
}

function removeDeletedAgentSessions(session: Session, deletedKeys: Set<string>): Session {
  const agentSessions = Object.fromEntries(
    Object.entries(session.agentSessions ?? {}).filter(
      ([providerId, route]) => !deletedKeys.has(agentSessionDeleteKey(providerId, route)),
    ),
  );
  const retiredAgentSessions = (session.retiredAgentSessions ?? []).filter(
    (route) => !deletedKeys.has(agentSessionDeleteKey(route.providerId, route)),
  );
  const activeRoute = agentSessionStateFromSession(session);
  const activeDeleted = deletedKeys.has(agentSessionDeleteKey(session.providerId, activeRoute));
  if (!activeDeleted) {
    return { ...session, agentSessions, retiredAgentSessions };
  }
  const nextEntry = Object.entries(agentSessions)[0];
  const nextProviderId = nextEntry?.[0] ?? session.providerId;
  const nextRoute = nextEntry?.[1];
  return {
    ...session,
    providerId: nextProviderId,
    providerSessionId: nextRoute
      ? providerSessionIdFromAgentSession(nextRoute) || undefined
      : undefined,
    agentSessions,
    retiredAgentSessions,
    capabilities: nextRoute?.capabilities,
    availableCommands: nextRoute?.availableCommands,
    contextUsage: nextRoute?.contextUsage,
    usage: nextRoute?.usage,
    connectionState: "disconnected",
    connectionMessage: undefined,
    extensionState: extensionStateForAgent(session.extensionState, nextRoute),
  };
}

type AgentSessionPatch = Partial<Omit<AgentSessionState, "contextUsage">> & {
  contextUsage?: AgentSessionState["contextUsage"] | null;
};

function syncAgentSession(
  session: Session,
  providerId: string,
  patch: AgentSessionPatch = {},
): Session {
  if (!providerId) return session;
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) => value !== undefined && !(key === "contextUsage" && value === null),
    ),
  ) as Partial<AgentSessionState>;
  if (patch.contextUsage === null) {
    definedPatch.contextUsage = undefined;
  }
  const existing =
    session.agentSessions?.[providerId] ??
    (session.providerId === providerId
      ? agentSessionStateFromSession(session)
      : { status: "never_used" as const });
  const route = {
    ...existing,
    ...definedPatch,
  };
  return syncProviderParticipantState(
    {
      ...session,
      agentSessions: {
        ...(session.agentSessions ?? {}),
        [providerId]: route,
      },
    },
    providerId,
    route,
  );
}

function syncProviderParticipantState(
  session: Session,
  providerId: string,
  route: AgentSessionState,
): Session {
  const participantId = providerParticipantId(providerId);
  const current = session.agentParticipants?.[participantId];
  const at = Date.now();
  const status =
    route.status === "running"
      ? ("running" as const)
      : route.status === "failed"
        ? ("failed" as const)
        : ("idle" as const);
  return {
    ...session,
    agentParticipants: {
      ...(session.agentParticipants ?? {}),
      [participantId]: {
        id: participantId,
        providerId,
        role: "primary",
        kind: "provider",
        createdAt: current?.createdAt ?? session.createdAt,
        ...current,
        ...(providerSessionIdFromAgentSession(route)
          ? { backendSessionId: providerSessionIdFromAgentSession(route) }
          : {}),
        status,
        updatedAt: at,
      },
    },
  };
}

function annotateAgentProviderSessionBlocks(
  blocks: ChatBlock[],
  providerId: string,
  providerSessionId: string,
): ChatBlock[] {
  if (!providerId || !providerSessionId) return blocks;
  let changed = false;
  const next = blocks.map((block) => {
    if (
      block.kind === "user" ||
      block.agentProviderId !== providerId ||
      block.agentProviderSessionId
    ) {
      return block;
    }
    changed = true;
    return { ...block, agentProviderSessionId: providerSessionId };
  });
  return changed ? next : blocks;
}

function captureActiveAgentRunSettings(): void {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  if (!session || session.status === "streaming") return;
  patchAgentSession(session.id, session.providerId, { runSettings: currentAgentRunSettings() });
}

function applyActiveSessionRunSettings(): void {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  if (session) applySessionAgentRunSettings(session);
}

function prepareSessionHandoff(
  sessionId: string,
  providerId: string,
  pending: PendingPrompt,
  providers: AspProvider[],
) {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  const candidate = buildAgentConversationContext(session, providerId, {
    handoffId: uid("handoff"),
    workItemId: pending.workItemId,
    toParticipantId: pending.targetParticipantId,
    objective: pending.text,
    providerNames,
  });
  if (!candidate) return null;
  const reusable = [...(session.handoffs ?? [])]
    .reverse()
    .find(
      (handoff) =>
        handoff.workItemId === pending.workItemId &&
        handoff.toParticipantId === pending.targetParticipantId &&
        handoff.contextDigest === candidate.digest &&
        (handoff.status === "failed" || handoff.status === "cancelled"),
    );
  const context = reusable ? { ...candidate, handoffId: reusable.id } : candidate;
  const at = Date.now();
  const handoff: AgentHandoffState = {
    id: context.handoffId,
    workItemId: pending.workItemId,
    fromParticipantId: context.fromParticipantId,
    toParticipantId: pending.targetParticipantId,
    targetProviderId: providerId,
    sourceSeq: context.sourceSeq,
    highWatermarkSeq: context.highWatermarkSeq,
    contextDigest: context.digest,
    context,
    status: "queued",
    createdAt: reusable?.createdAt ?? at,
  };
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((item) => {
      if (item.id !== sessionId) return item;
      const handoffs = reusable
        ? (item.handoffs ?? []).map((entry) => (entry.id === reusable.id ? handoff : entry))
        : [...(item.handoffs ?? []), handoff].slice(-100);
      const requestId = item.activeRunRequestId;
      return {
        ...item,
        activeHandoffId: handoff.id,
        handoffs,
        agentRuns: requestId
          ? {
              ...(item.agentRuns ?? {}),
              [requestId]: {
                ...(item.agentRuns?.[requestId] ?? {
                  id: requestId,
                  providerId,
                  participantId: pending.targetParticipantId,
                  workItemId: pending.workItemId,
                  status: "queued" as const,
                }),
                handoffId: handoff.id,
              },
            }
          : item.agentRuns,
      };
    }),
  }));
  return context;
}

function failUnstartedWork(sessionId: string, pending: PendingPrompt): void {
  const at = Date.now();
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const participant = session.agentParticipants?.[pending.targetParticipantId];
      return {
        ...session,
        activeWorkItemId: undefined,
        workItems: {
          ...(session.workItems ?? {}),
          [pending.workItemId]: {
            ...(session.workItems?.[pending.workItemId] ?? {
              id: pending.workItemId,
              objective: pending.text,
              ownerParticipantId: pending.targetParticipantId,
              createdAt: at,
            }),
            status: "failed" as const,
            updatedAt: at,
          },
        },
        agentParticipants: participant
          ? {
              ...(session.agentParticipants ?? {}),
              [pending.targetParticipantId]: {
                ...participant,
                status: "failed" as const,
                updatedAt: at,
              },
            }
          : session.agentParticipants,
      };
    }),
  }));
}

function markActiveHandoffDelivered(sessionId: string, requestId: string): void {
  const at = Date.now();
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && session.activeRunRequestId === requestId
        ? {
            ...session,
            handoffs: session.handoffs?.map((handoff) =>
              handoff.id === session.activeHandoffId
                ? { ...handoff, status: "delivered" as const, deliveredAt: at }
                : handoff,
            ),
          }
        : session,
    ),
  }));
}

function completeSessionOrchestration(
  sessionId: string,
  requestId: string,
  providerId: string,
  result: { success: boolean; canceled?: boolean },
): void {
  const at = Date.now();
  const status = result.canceled
    ? ("cancelled" as const)
    : result.success
      ? ("completed" as const)
      : ("failed" as const);
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== sessionId || session.activeRunRequestId !== requestId) return session;
      const workItemId = session.activeWorkItemId;
      const participantId = session.activeParticipantId ?? providerParticipantId(providerId);
      const participant = session.agentParticipants?.[participantId];
      return {
        ...session,
        agentParticipants: participant
          ? {
              ...(session.agentParticipants ?? {}),
              [participantId]: {
                ...participant,
                status: result.success ? ("idle" as const) : status,
                updatedAt: at,
              },
            }
          : session.agentParticipants,
        workItems: workItemId
          ? {
              ...(session.workItems ?? {}),
              [workItemId]: {
                ...(session.workItems?.[workItemId] ?? {
                  id: workItemId,
                  objective: "",
                  ownerParticipantId: participantId,
                  createdAt: at,
                }),
                status,
                updatedAt: at,
              },
            }
          : session.workItems,
        agentRuns: {
          ...(session.agentRuns ?? {}),
          [requestId]: {
            ...(session.agentRuns?.[requestId] ?? {
              id: requestId,
              providerId,
              participantId,
              workItemId: workItemId ?? requestId,
            }),
            status,
            finishedAt: at,
          },
        },
        handoffs: session.handoffs?.map((handoff) =>
          handoff.id === session.activeHandoffId ? { ...handoff, status, finishedAt: at } : handoff,
        ),
      };
    }),
  }));
}

function beginSessionRun(
  sessionId: string,
  requestId: string,
  providerId: string,
  prompt: PendingPrompt,
): void {
  const at = Date.now();
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...ensureProviderParticipant(session, providerId, at),
            activeRunId: undefined,
            activeRunProviderId: providerId,
            activeRunRequestId: requestId,
            activeParticipantId: prompt.targetParticipantId,
            activeWorkItemId: prompt.workItemId,
            activeHandoffId: undefined,
            agentRuns: {
              ...(session.agentRuns ?? {}),
              [requestId]: {
                id: requestId,
                providerId,
                participantId: prompt.targetParticipantId,
                workItemId: prompt.workItemId,
                status: "queued" as const,
              },
            },
          }
        : session,
    ),
  }));
}

export function bindSessionRun(
  sessionId: string,
  runId: string,
  providerId: string,
  requestId?: string,
): void {
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (
        session.id !== sessionId ||
        session.activeRunProviderId !== providerId ||
        (requestId && session.activeRunRequestId !== requestId)
      ) {
        return session;
      }
      const at = Date.now();
      const runKey = session.activeRunRequestId;
      const handoffs = session.handoffs?.map((handoff) =>
        handoff.id === session.activeHandoffId
          ? {
              ...handoff,
              status: "acknowledged" as const,
              runId,
              acknowledgedAt: at,
            }
          : handoff,
      );
      const participantId = session.activeParticipantId ?? providerParticipantId(providerId);
      const participant = session.agentParticipants?.[participantId];
      const next: Session = {
        ...session,
        activeRunId: runId,
        handoffs,
        agentParticipants: {
          ...(session.agentParticipants ?? {}),
          ...(participant
            ? {
                [participantId]: {
                  ...participant,
                  status: "running" as const,
                  updatedAt: at,
                },
              }
            : {}),
        },
        agentRuns: runKey
          ? {
              ...(session.agentRuns ?? {}),
              [runKey]: {
                ...(session.agentRuns?.[runKey] ?? {
                  id: runKey,
                  providerId,
                  participantId,
                  workItemId: session.activeWorkItemId ?? runKey,
                }),
                providerRunId: runId,
                status: "running" as const,
                startedAt: at,
              },
            }
          : session.agentRuns,
      };
      return next;
    }),
  }));
}

export function sessionRunProviderId(sessionId: string): string | undefined {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  return session?.activeRunProviderId ?? session?.providerId;
}

function sessionRunRequestIsCurrent(
  sessionId: string,
  requestId: string,
  providerId: string,
): boolean {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  return Boolean(
    session &&
    session.activeRunRequestId === requestId &&
    session.activeRunProviderId === providerId,
  );
}

function finishSessionRun(sessionId: string, requestId: string): void {
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && session.activeRunRequestId === requestId
        ? {
            ...session,
            status: "idle" as const,
            activeRunId: undefined,
            activeRunProviderId: undefined,
            activeRunRequestId: undefined,
            activeWorkItemId: undefined,
            activeHandoffId: undefined,
          }
        : session,
    ),
  }));
  flushChatPersistence();
}

function isSessionRunning(session: Session | undefined): boolean {
  return Boolean(
    session &&
    (session.status === "streaming" ||
      session.activeRunId ||
      session.activeRunRequestId ||
      pendingPrompts.has(session.id)),
  );
}

function normalizedPromptAttachments(
  attachments: QueuedPrompt["attachments"],
): QueuedPrompt["attachments"] {
  return attachments?.length ? attachments.map((attachment) => ({ ...attachment })) : undefined;
}

function mergeRunAttachments(
  current: Attachment[] | undefined,
  handoffFiles: AspConversationFile[] | undefined,
): Attachment[] | undefined {
  const merged = [...(current ?? [])];
  const paths = new Set(
    merged
      .map((attachment) => attachment.path?.replaceAll("\\", "/").toLowerCase())
      .filter(Boolean),
  );
  for (const file of handoffFiles ?? []) {
    if (!file.sourcePath) continue;
    const key = file.sourcePath.replaceAll("\\", "/").toLowerCase();
    if (paths.has(key)) continue;
    paths.add(key);
    merged.push({
      id: file.id,
      kind: "file",
      name: file.name,
      handoffFileId: file.id,
      mime: file.mimeType,
      path: file.sourcePath,
      size: file.size,
    });
  }
  return merged.length ? merged : undefined;
}

function preparePendingPrompt(
  session: Session,
  prompt: Pick<QueuedPrompt, "attachments" | "text"> & Partial<QueuedPrompt>,
): PendingPrompt {
  return targetPromptForSession(session, prompt, {
    promptId: uid("prompt"),
    workItemId: uid("work"),
  });
}

function enqueuePrompt(sessionId: string, prompt: PendingPrompt): void {
  const createdAt = Date.now();
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            workItems: {
              ...(session.workItems ?? {}),
              [prompt.workItemId]: {
                id: prompt.workItemId,
                objective: prompt.text,
                ownerParticipantId: prompt.targetParticipantId,
                status: "queued" as const,
                createdAt,
                updatedAt: createdAt,
              },
            },
            queuedPrompts: [
              ...(session.queuedPrompts ?? []),
              {
                id: prompt.id,
                text: prompt.text,
                attachments: normalizedPromptAttachments(prompt.attachments),
                targetParticipantId: prompt.targetParticipantId,
                targetProviderId: prompt.targetProviderId,
                workItemId: prompt.workItemId,
                sourceSeq: prompt.sourceSeq,
                createdAt,
              },
            ],
          }
        : session,
    ),
  }));
}

async function startDesktopPrompt(
  sessionId: string,
  prompt: PendingPrompt,
  titleSource?: string,
): Promise<void> {
  const current = useChatStore.getState().sessions.find((session) => session.id === sessionId);
  if (!current) return;
  if (current.providerId !== prompt.targetProviderId) {
    useChatStore.getState().setSessionProvider(sessionId, prompt.targetProviderId);
  }
  const startedAt = Date.now();
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const withParticipant = ensureProviderParticipant(
        { ...session, activeParticipantId: prompt.targetParticipantId },
        prompt.targetProviderId,
        startedAt,
      );
      return {
        ...withParticipant,
        activeParticipantId: prompt.targetParticipantId,
        activeWorkItemId: prompt.workItemId,
        workItems: {
          ...(withParticipant.workItems ?? {}),
          [prompt.workItemId]: {
            id: prompt.workItemId,
            objective: prompt.text,
            ownerParticipantId: prompt.targetParticipantId,
            status: "running" as const,
            createdAt: withParticipant.workItems?.[prompt.workItemId]?.createdAt ?? startedAt,
            updatedAt: startedAt,
          },
        },
      };
    }),
  }));
  const attachments = normalizedPromptAttachments(prompt.attachments);
  useChatStore.getState().dispatchTo(sessionId, {
    id: prompt.id,
    type: "user_message",
    text: prompt.text,
    attachments,
    agentParticipantId: prompt.targetParticipantId,
    agentProviderId: prompt.targetProviderId,
    workItemId: prompt.workItemId,
    at: startedAt,
  });
  markStreaming(sessionId, titleSource);
  pendingPrompts.set(sessionId, { ...prompt, attachments });
  await runDesktopPrompt(sessionId);
}

function scheduleQueuedPromptDrain(sessionId: string): void {
  queueMicrotask(() => {
    void drainQueuedPrompt(sessionId);
  });
}

async function drainQueuedPrompt(sessionId: string): Promise<void> {
  if (pendingPrompts.has(sessionId)) return;
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session || isSessionRunning(session)) return;
  const prompt = session.queuedPrompts?.[0];
  if (!prompt) return;
  useChatStore.getState().removeQueuedPrompt(sessionId, prompt.id);
  await startDesktopPrompt(sessionId, preparePendingPrompt(session, prompt), prompt.text);
}

function agentSessionExtensionSession(route: AgentSessionState): Record<string, unknown> {
  return route.extensionState?.session ?? route.sessionState ?? {};
}

function providerSessionIdForAgent(session: Session, providerId: string): string | undefined {
  if (providerId === session.providerId && session.providerSessionId) {
    return session.providerSessionId;
  }
  const route = session.agentSessions?.[providerId];
  return route ? providerSessionIdFromAgentSession(route) || undefined : undefined;
}

function sessionContainsProviderSession(
  session: Session,
  providerId: string,
  providerSessionId: string,
): boolean {
  if (
    session.providerId === providerId &&
    (session.providerSessionId === providerSessionId ||
      providerSessionIdFromExtensionState(session) === providerSessionId)
  ) {
    return true;
  }
  const activeRoute = session.agentSessions?.[providerId];
  if (activeRoute && providerSessionIdFromAgentSession(activeRoute) === providerSessionId) {
    return true;
  }
  return (session.retiredAgentSessions ?? []).some(
    (route) =>
      route.providerId === providerId &&
      providerSessionIdFromAgentSession(route) === providerSessionId,
  );
}

function providerExtensionState(
  extensionState: Session["extensionState"],
): Session["extensionState"] {
  if (!extensionState) return undefined;
  const { sessionTree: _sessionTree, ...providerState } = extensionState;
  return Object.keys(providerState).length ? providerState : undefined;
}

function sharedExtensionState(
  extensionState: Session["extensionState"],
): Session["extensionState"] {
  return extensionState?.sessionTree ? { sessionTree: extensionState.sessionTree } : undefined;
}

function extensionStateForAgent(
  current: Session["extensionState"],
  route: AgentSessionState | undefined,
): Session["extensionState"] {
  const shared = sharedExtensionState(current);
  const provider =
    route?.extensionState ?? (route?.sessionState ? { session: route.sessionState } : undefined);
  if (!shared && !provider) return undefined;
  return { ...(shared ?? {}), ...(provider ?? {}) };
}

function sessionHasMultipleAgents(session: Session): boolean {
  const usedProviderIds = new Set<string>();
  if (session.providerSessionId) usedProviderIds.add(session.providerId);
  for (const block of session.blocks) {
    if (block.agentProviderId) usedProviderIds.add(block.agentProviderId);
  }
  for (const [providerId, route] of Object.entries(session.agentSessions ?? {})) {
    if (route.status !== "never_used" || agentSessionIsProviderBacked(route)) {
      usedProviderIds.add(providerId);
    }
  }
  return usedProviderIds.size > 1;
}

function sessionMatchesTranscriptHydration(
  session: Session,
  providerId: string,
  providerSessionId: string,
): boolean {
  if (session.status === "streaming") return false;
  if (session.providerId !== providerId) return false;
  const currentProviderSessionId =
    session.providerSessionId ||
    providerSessionIdFromExtensionState(session) ||
    transcriptPathFromSession(session);
  return currentProviderSessionId === providerSessionId;
}

function annotateAgentBlock(
  blocks: ChatBlock[],
  event: SessionEvent,
  providerId: string,
  providerSessionId?: string,
  participantId?: string,
  workItemId?: string,
): ChatBlock[] {
  const blockId = agentBlockIdForEvent(event);
  if (!providerId || !blockId) return blocks;
  const target = blocks.find((block) => block.id === blockId);
  if (!target) return blocks;
  const runId = event.runId;
  if (
    target.agentProviderId === providerId &&
    target.agentParticipantId === participantId &&
    target.workItemId === workItemId &&
    target.runId === runId
  ) {
    return blocks;
  }
  return blocks.map((block) =>
    block.id === blockId
      ? {
          ...block,
          agentProviderId: providerId,
          ...(participantId ? { agentParticipantId: participantId } : {}),
          ...(providerSessionId ? { agentProviderSessionId: providerSessionId } : {}),
          ...(runId ? { runId } : {}),
          ...(workItemId ? { workItemId } : {}),
          ...(block.kind === "assistant"
            ? { metadata: { ...(block.metadata ?? {}), agentProviderId: providerId } }
            : {}),
        }
      : block,
  );
}

function annotateAgentBlocks(
  blocks: ChatBlock[],
  providerId: string,
  providerSessionId?: string,
): ChatBlock[] {
  if (!providerId) return blocks;
  const participantId = providerParticipantId(providerId);
  return blocks.map((block) =>
    block.kind !== "user" &&
    (block.agentProviderId !== providerId || block.agentParticipantId !== participantId)
      ? {
          ...block,
          agentParticipantId: participantId,
          agentProviderId: providerId,
          ...(providerSessionId ? { agentProviderSessionId: providerSessionId } : {}),
          ...(block.kind === "assistant"
            ? { metadata: { ...(block.metadata ?? {}), agentProviderId: providerId } }
            : {}),
        }
      : block,
  );
}

function agentBlockIdForEvent(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "reasoning_start":
    case "reasoning_delta":
    case "reasoning_end":
    case "assistant_start":
    case "assistant_delta":
    case "assistant_end":
    case "plan_update":
    case "image":
    case "resource":
    case "artifact":
    case "raw":
      return event.blockId;
    case "tool_start":
    case "tool_update":
    case "tool_start_terminal":
    case "tool_start_diff":
    case "tool_delta":
    case "tool_end":
      return event.toolId;
    case "error":
      return event.id;
    case "user_message":
    case "turn_complete":
      return undefined;
  }
}

function lastSharedConversationBlockId(blocks: ChatBlock[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === "user" || block.kind === "assistant") return block.id;
  }
  return undefined;
}

async function runDesktopPrompt(sessionId: string): Promise<void> {
  const api = desktopApi();
  const store = useChatStore.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  const pending = pendingPrompts.get(sessionId);
  if (!session || !pending) return;
  if (!api) {
    store.dispatchTo(sessionId, {
      id: uid("e"),
      type: "error",
      message: "ASP agents are available in the Electron desktop app. Run `pnpm dev`.",
      at: Date.now(),
    });
    pendingPrompts.delete(sessionId);
    failUnstartedWork(sessionId, pending);
    markIdle(sessionId);
    return;
  }

  const preferences = useAspStore.getState();
  const workspaceState = useWorkspaceStore.getState();
  const activeWorkspace = workspaceState.activeWorkspace();
  const workspaceProviderId =
    activeWorkspace.providerId &&
    preferences.providers.some((provider) => provider.id === activeWorkspace.providerId)
      ? activeWorkspace.providerId
      : undefined;
  const providerId =
    pending.targetProviderId ||
    session.providerId ||
    workspaceProviderId ||
    preferences.activeProviderId;
  if (!providerId) {
    store.dispatchTo(sessionId, {
      id: uid("e"),
      type: "error",
      message: "Choose an ASP agent before sending a prompt.",
      at: Date.now(),
    });
    pendingPrompts.delete(sessionId);
    failUnstartedWork(sessionId, pending);
    markIdle(sessionId);
    return;
  }

  const runRequestId = uid("run");
  beginSessionRun(sessionId, runRequestId, providerId, pending);
  let shouldDrainQueue = false;

  try {
    const resolved = await resolveSessionWorkspace(
      session,
      activeWorkspace.projectPath || preferences.workspacePath,
      api,
    );
    const cwd = resolved.cwd;
    let provider = preferences.providers.find((item) => item.id === providerId);
    provider =
      (await useAspStore.getState().refreshProviderCapabilities(providerId, cwd)) ?? provider;
    const capabilities = provider?.capabilities;
    const extensions = negotiatedRunExtensions(capabilities);
    const extensionState = useExtensionStore.getState();
    await Promise.all(
      extensionState.records
        .filter(
          (record) =>
            record.enabled &&
            record.state !== "blocked" &&
            record.manifest.activationEvents?.includes("onAgentRun"),
        )
        .map((record) => extensionState.activate(record.id, "onAgentRun")),
    );
    const resolvedAgentResources = await api.extensions.resolveAgentContributions({
      workspacePath: cwd,
      workspaceId: extensionScopeWorkspaceId(activeWorkspace.id),
    });
    const resourcePreferences = useExtensionStore.getState();
    const disabledMcpServers = workspaceState.initialized
      ? activeWorkspace.disabledMcpServers
      : resourcePreferences.disabledMcpServers;
    const disabledSkills = workspaceState.initialized
      ? activeWorkspace.disabledSkills
      : resourcePreferences.disabledSkills;
    const disabledPrompts = workspaceState.initialized
      ? activeWorkspace.disabledPrompts
      : resourcePreferences.disabledPrompts;
    const selectedPrompts = workspaceState.initialized
      ? activeWorkspace.selectedPrompts
      : resourcePreferences.selectedPrompts;
    const agentResources = {
      ...resolvedAgentResources,
      mcpServers: resolvedAgentResources.mcpServers.filter(
        (item) => !disabledMcpServers.includes(item.id),
      ),
      skills: resolvedAgentResources.skills.filter((item) => !disabledSkills.includes(item.id)),
      prompts: resolvedAgentResources.prompts.filter((item) =>
        item.autoInclude ? !disabledPrompts.includes(item.id) : selectedPrompts.includes(item.id),
      ),
    };
    const ui = useUIStore.getState();
    const model = selectedModel(provider?.models, ui.model);
    const latestSession =
      useChatStore.getState().sessions.find((item) => item.id === sessionId) ?? session;
    const conversationContext = prepareSessionHandoff(
      sessionId,
      providerId,
      pending,
      useAspStore.getState().providers,
    );
    const effectiveAttachments = mergeRunAttachments(
      pending.attachments,
      conversationContext?.files,
    );
    const additionalDeveloperInstructions = buildAdditionalDeveloperInstructions(
      agentResources.prompts,
      sessionTreeDeveloperInstructions(latestSession),
    );
    patchAgentSession(sessionId, providerId, {
      status: "running",
      runSettings: currentAgentRunSettings(),
    });
    useChatStore.getState().patchRuntime(sessionId, {
      capabilities,
      availableCommands: capabilities?.slashCommands,
      connectionState: "connecting",
    });
    const runStartedAt = Date.now();
    markActiveHandoffDelivered(sessionId, runRequestId);
    const result = await api.sessions.run({
      uiSessionId: sessionId,
      clientRequestId: runRequestId,
      providerId,
      cwd,
      providerSessionId: providerSessionIdForAgent(latestSession, providerId),
      prompt: buildPrompt(pending.text, pending.attachments, latestSession.mcpAppState),
      conversationContext: conversationContext ?? undefined,
      attachments: buildAttachments(effectiveAttachments),
      approvalMode: ui.approvalMode,
      model,
      effort: selectedEffort(provider?.models, capabilities, model, ui.effort),
      speed: selectedSpeed(provider?.models, capabilities, model, ui.speed),
      extensions,
      additionalDeveloperInstructions,
      ...(agentResources.mcpServers.length
        ? {
            mcpServers: agentResources.mcpServers.map((server) => ({
              id: server.id,
              name: server.name,
              command: server.command,
              args: server.args,
              env: server.env,
              headers: server.headers,
              type: server.type,
              url: server.url,
              metadata: server.metadata,
            })),
          }
        : {}),
      ...(agentResources.skills.length
        ? {
            skills: agentResources.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              path: skill.path,
              manifestPath: skill.manifestPath,
              sourceExtensionId: skill.extensionId,
              metadata: { hasScripts: skill.hasScripts },
            })),
          }
        : {}),
      ...(agentResources.extensionIds.length
        ? { enabledAppExtensions: agentResources.extensionIds }
        : {}),
    });
    await waitForAspRunProjection(sessionId, result.runId);
    if (!sessionRunRequestIsCurrent(sessionId, runRequestId, providerId)) return;
    bindSessionRun(sessionId, result.runId, providerId, runRequestId);
    if (result.success === false && !result.canceled) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!sessionHasErrorBlockSince(sessionId, runStartedAt)) {
        useChatStore.getState().dispatchTo(sessionId, {
          id: uid("e"),
          type: "error",
          message: failedRunMessage(provider?.name ?? "ASP provider", result),
          at: Date.now(),
        });
      }
    }
    useChatStore.getState().patchRuntime(
      sessionId,
      {
        providerSessionId: result.providerSessionId,
        connectionState: "ready",
        ...(result.usage ? { usage: tokenUsageFromAsp(result.usage) } : {}),
      },
      providerId,
    );
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === sessionId && item.activeRunRequestId === runRequestId
          ? {
              ...item,
              cwd,
              projectPath: resolved.projectPath,
              privateSessionPath: resolved.privateSessionPath,
            }
          : item,
      ),
    }));
    const completedSession = useChatStore.getState().sessions.find((item) => item.id === sessionId);
    completeSessionOrchestration(sessionId, runRequestId, providerId, result);
    patchAgentSession(sessionId, providerId, {
      status: result.success && !result.canceled ? "synced" : "failed",
      cwd,
      ...(result.success && !result.canceled
        ? {
            seenThroughSeq: completedSession?.conversationRevision,
            lastSyncedBlockId: completedSession
              ? lastSharedConversationBlockId(completedSession.blocks)
              : undefined,
            lastUsedAt: Date.now(),
          }
        : {}),
    });
    finishSessionRun(sessionId, runRequestId);
    shouldDrainQueue = true;
    const finishedSession = useChatStore.getState().sessions.find((item) => item.id === sessionId);
    if (finishedSession) {
      void useChatStore.getState().hydrateSessionTranscript(sessionId);
    }
    if (resolved.projectPath) {
      useChatStore.setState((state) => ({
        sessionProjects: upsertSessionProject(
          state.sessionProjects,
          resolved.projectPath,
          Date.now(),
          workspaceScopedId(session),
        ),
      }));
    }
  } catch (error) {
    if (sessionRunRequestIsCurrent(sessionId, runRequestId, providerId)) {
      completeSessionOrchestration(sessionId, runRequestId, providerId, { success: false });
      patchAgentSession(sessionId, providerId, { status: "failed" });
      useChatStore.getState().dispatchTo(sessionId, {
        id: uid("e"),
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
      useChatStore.getState().patchRuntime(sessionId, { connectionState: "ready" }, providerId);
      finishSessionRun(sessionId, runRequestId);
      shouldDrainQueue = true;
    }
  } finally {
    if (pendingPrompts.get(sessionId) === pending) pendingPrompts.delete(sessionId);
    if (shouldDrainQueue) scheduleQueuedPromptDrain(sessionId);
  }
}

function sessionHasErrorBlockSince(sessionId: string, at: number): boolean {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId);
  return (
    session?.blocks.some((block) => block.kind === "error" && (blockOrder(block) ?? 0) >= at) ??
    false
  );
}

async function resolveSessionWorkspace(
  session: Session,
  defaultProjectPath: string,
  api: AgentDesktopApi,
): Promise<{ cwd: string; projectPath: string | null; privateSessionPath?: string }> {
  const legacyProjectPath =
    session.projectPath === undefined && !session.privateSessionPath
      ? session.cwd || defaultProjectPath || null
      : undefined;
  const projectPath = session.projectPath !== undefined ? session.projectPath : legacyProjectPath;
  if (projectPath) {
    return { cwd: projectPath, projectPath, privateSessionPath: undefined };
  }
  const existingPrivatePath =
    session.privateSessionPath ||
    (session.projectPath === null && session.cwd ? session.cwd : undefined);
  const privateSessionPath =
    existingPrivatePath ||
    (await api.workspace.privateSession({
      sessionId: session.id,
      createdAt: session.createdAt,
    }));
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((item) =>
      item.id === session.id
        ? {
            ...item,
            cwd: privateSessionPath,
            projectPath: null,
            privateSessionPath,
          }
        : item,
    ),
  }));
  return { cwd: privateSessionPath, projectPath: null, privateSessionPath };
}

function markStreaming(sessionId: string, titleSource?: string): void {
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            status: "streaming" as const,
            title:
              titleSource && session.blocks.length <= 1 ? truncate(titleSource) : session.title,
          }
        : session,
    ),
  }));
}

function markIdle(sessionId: string): void {
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            status: "idle" as const,
            activeRunId: undefined,
            activeRunProviderId: undefined,
            activeRunRequestId: undefined,
          }
        : session,
    ),
  }));
  flushChatPersistence();
}
