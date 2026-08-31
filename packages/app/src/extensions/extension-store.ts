import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  desktopApi,
  type AppExtensionPermission,
  type AppExtensionRecord,
  type ExtensionAssetResult,
  type ExtensionRuntimeEvent,
  type ResolvedAgentContributions,
} from "@/asp/desktop-api";
import { createPersistentJsonStorage } from "@/storage/persistent-storage";

const EMPTY_RESOURCES: ResolvedAgentContributions = {
  extensionIds: [],
  mcpServers: [],
  skills: [],
  prompts: [],
  warnings: [],
};

interface ExtensionStore {
  records: AppExtensionRecord[];
  contributionsRevision: number;
  refreshRevision: number;
  initialized: boolean;
  loading: boolean;
  error: string | null;
  workspacePath: string;
  workspaceId: string;
  workspaceTrusted: boolean;
  logs: Array<{
    extensionId?: string;
    message: string;
    workspacePath?: string;
    workspaceId?: string;
    at: number;
  }>;
  disabledMcpServers: string[];
  disabledSkills: string[];
  disabledPrompts: string[];
  selectedPrompts: string[];
  initialize(scope: string | ExtensionWorkspaceScope): Promise<void>;
  refresh(scope?: string | ExtensionWorkspaceScope): Promise<void>;
  setWorkspaceScope(scope: ExtensionWorkspaceScope): Promise<void>;
  chooseAndInstall(): Promise<AppExtensionRecord | null>;
  install(sourcePath: string): Promise<AppExtensionRecord>;
  chooseAndUpdate(extensionId: string): Promise<AppExtensionRecord | null>;
  update(
    extensionId: string,
    input?: { expectedSha256?: string; sourcePath?: string; sourceUrl?: string },
  ): Promise<AppExtensionRecord>;
  uninstall(extensionId: string): Promise<void>;
  grant(extensionId: string, permissions: AppExtensionPermission[]): Promise<void>;
  setEnabled(extensionId: string, enabled: boolean): Promise<void>;
  setWorkspaceTrust(trusted: boolean): Promise<void>;
  activate(extensionId: string, event: string): Promise<void>;
  executeCommand(extensionId: string, command: string, args?: unknown[]): Promise<unknown>;
  setMcpServerEnabled(id: string, enabled: boolean): void;
  setSkillEnabled(id: string, enabled: boolean): void;
  setPromptEnabled(id: string, enabled: boolean): void;
  setPromptSelected(id: string, selected: boolean): void;
  setResourcePreferences(preferences: {
    disabledMcpServers?: string[];
    disabledSkills?: string[];
    disabledPrompts?: string[];
    selectedPrompts?: string[];
  }): void;
  resolveAgentContributions(
    scope: string | ExtensionWorkspaceScope,
  ): Promise<ResolvedAgentContributions>;
}

type ExtensionWorkspaceScope = {
  workspacePath?: string;
  workspaceId?: string;
};

let removeExtensionListener: (() => void) | undefined;
let refreshTimer = 0;
let refreshGeneration = 0;
const ASSET_CACHE_TTL_MS = 5_000;
const assetCache = new Map<string, { expiresAt: number; promise: Promise<ExtensionAssetResult> }>();

export const useExtensionStore = create<ExtensionStore>()(
  persist(
    (set, get) => ({
      records: [],
      contributionsRevision: 0,
      refreshRevision: 0,
      initialized: false,
      loading: false,
      error: null,
      workspacePath: "",
      workspaceId: "",
      workspaceTrusted: false,
      logs: [],
      disabledMcpServers: [],
      disabledSkills: [],
      disabledPrompts: [],
      selectedPrompts: [],

      initialize: async (scope) => {
        const nextWorkspacePath =
          typeof scope === "string" ? scope : (scope.workspacePath ?? get().workspacePath);
        const nextWorkspaceId =
          typeof scope === "string"
            ? get().workspaceId
            : extensionScopeWorkspaceId(scope.workspaceId ?? get().workspaceId);
        if (
          nextWorkspacePath !== get().workspacePath ||
          nextWorkspaceId !== extensionScopeWorkspaceId(get().workspaceId)
        ) {
          clearExtensionAssetCache();
        }
        if (!removeExtensionListener) {
          removeExtensionListener = desktopApi()?.onExtensionEvent((event) => {
            handleExtensionEvent(event, set, get);
          });
        }
        await get().refresh({ workspacePath: nextWorkspacePath, workspaceId: nextWorkspaceId });
      },

      refresh: async (workspacePath = get().workspacePath) => {
        const scope =
          typeof workspacePath === "string"
            ? {
                workspacePath,
                workspaceId: get().workspaceId,
              }
            : {
                workspacePath: workspacePath.workspacePath ?? get().workspacePath,
                workspaceId: workspacePath.workspaceId ?? get().workspaceId,
              };
        const nextWorkspacePath = scope.workspacePath ?? "";
        const nextWorkspaceId = extensionScopeWorkspaceId(scope.workspaceId ?? "");
        const generation = ++refreshGeneration;
        const api = desktopApi();
        if (!api?.extensions) {
          if (generation !== refreshGeneration) return;
          set((state) => ({
            initialized: true,
            loading: false,
            records: [],
            workspacePath: nextWorkspacePath,
            workspaceId: nextWorkspaceId,
            contributionsRevision: state.contributionsRevision + 1,
          }));
          return;
        }
        set((state) => ({
          loading: true,
          error: null,
          records:
            state.workspaceId === nextWorkspaceId
              ? state.records.filter(
                  (record) =>
                    record.source !== "workspace" || state.workspacePath === nextWorkspacePath,
                )
              : [],
          workspacePath: nextWorkspacePath,
          workspaceId: nextWorkspaceId,
        }));
        try {
          const listInput = {
            workspacePath: nextWorkspacePath,
            workspaceId: nextWorkspaceId,
          };
          const [records, workspaceTrusted] = await Promise.all([
            api.extensions.list(listInput),
            nextWorkspacePath
              ? api.extensions.workspaceTrusted({ workspacePath: nextWorkspacePath })
              : Promise.resolve(false),
          ]);
          if (
            generation !== refreshGeneration ||
            get().workspacePath !== nextWorkspacePath ||
            get().workspaceId !== nextWorkspaceId
          ) {
            return;
          }
          set((state) => {
            const recordsChanged = !extensionRecordsEqual(state.records, records);
            const trustChanged = state.workspaceTrusted !== workspaceTrusted;
            return {
              records: recordsChanged ? records : state.records,
              workspaceTrusted,
              initialized: true,
              loading: false,
              contributionsRevision:
                recordsChanged || trustChanged
                  ? state.contributionsRevision + 1
                  : state.contributionsRevision,
            };
          });
        } catch (error) {
          if (
            generation !== refreshGeneration ||
            get().workspacePath !== nextWorkspacePath ||
            get().workspaceId !== nextWorkspaceId
          ) {
            return;
          }
          set({
            initialized: true,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },

      setWorkspaceScope: async (scope) => {
        await get().refresh(scope);
      },

      chooseAndInstall: async () => {
        const api = requireExtensionApi();
        const sourcePath = await api.chooseInstallSource();
        if (!sourcePath) return null;
        return get().install(sourcePath);
      },

      install: async (sourcePath) => {
        const installed = await requireExtensionApi().install({
          sourcePath,
          workspacePath: get().workspacePath,
          workspaceId: get().workspaceId,
        });
        clearExtensionAssetCache(installed.id);
        await get().refresh();
        return installed;
      },

      chooseAndUpdate: async (extensionId) => {
        const api = requireExtensionApi();
        const sourcePath = await api.chooseUpdateSource();
        if (!sourcePath) return null;
        return get().update(extensionId, { sourcePath });
      },

      update: async (extensionId, input = {}) => {
        const updated = await requireExtensionApi().update({
          extensionId,
          expectedSha256: input.expectedSha256,
          sourcePath: input.sourcePath,
          sourceUrl: input.sourceUrl,
          workspacePath: get().workspacePath,
          workspaceId: get().workspaceId,
        });
        clearExtensionAssetCache(updated.id);
        await get().refresh();
        return updated;
      },

      uninstall: async (extensionId) => {
        const state = get();
        await requireExtensionApi().uninstall({
          extensionId,
          workspacePath: state.workspacePath,
          workspaceId: state.workspaceId,
        });
        clearExtensionAssetCache(extensionId);
        await get().refresh();
      },

      grant: async (extensionId, permissions) => {
        await requireExtensionApi().grant({
          extensionId,
          permissions,
          workspacePath: get().workspacePath,
          workspaceId: get().workspaceId,
        });
        await get().refresh();
      },

      setEnabled: async (extensionId, enabled) => {
        await requireExtensionApi().setEnabled({
          extensionId,
          enabled,
          workspacePath: get().workspacePath,
          workspaceId: get().workspaceId,
        });
        await get().refresh();
      },

      setWorkspaceTrust: async (trusted) => {
        const workspacePath = get().workspacePath;
        if (!workspacePath) throw new Error("Select a workspace before changing trust.");
        await requireExtensionApi().setWorkspaceTrust({
          workspacePath,
          workspaceId: get().workspaceId,
          trusted,
        });
        await get().refresh();
      },

      activate: async (extensionId, event) => {
        await requireExtensionApi().activate({
          extensionId,
          event,
          workspacePath: get().workspacePath,
          workspaceId: get().workspaceId,
        });
      },

      executeCommand: async (extensionId, command, args = []) =>
        requireExtensionApi().executeCommand({
          extensionId,
          command,
          args,
          workspacePath: get().workspacePath,
          workspaceId: get().workspaceId,
        }),

      setMcpServerEnabled: (id, enabled) =>
        set((state) => ({
          disabledMcpServers: enabled
            ? state.disabledMcpServers.filter((item) => item !== id)
            : [...new Set([...state.disabledMcpServers, id])],
        })),

      setSkillEnabled: (id, enabled) =>
        set((state) => ({
          disabledSkills: enabled
            ? state.disabledSkills.filter((item) => item !== id)
            : [...new Set([...state.disabledSkills, id])],
        })),

      setPromptEnabled: (id, enabled) =>
        set((state) => ({
          disabledPrompts: enabled
            ? state.disabledPrompts.filter((item) => item !== id)
            : [...new Set([...state.disabledPrompts, id])],
        })),

      setPromptSelected: (id, selected) =>
        set((state) => ({
          selectedPrompts: selected
            ? [...new Set([...state.selectedPrompts, id])]
            : state.selectedPrompts.filter((item) => item !== id),
        })),

      setResourcePreferences: (preferences) =>
        set((state) => ({
          disabledMcpServers:
            preferences.disabledMcpServers !== undefined
              ? uniqueStrings(preferences.disabledMcpServers)
              : state.disabledMcpServers,
          disabledSkills:
            preferences.disabledSkills !== undefined
              ? uniqueStrings(preferences.disabledSkills)
              : state.disabledSkills,
          disabledPrompts:
            preferences.disabledPrompts !== undefined
              ? uniqueStrings(preferences.disabledPrompts)
              : state.disabledPrompts,
          selectedPrompts:
            preferences.selectedPrompts !== undefined
              ? uniqueStrings(preferences.selectedPrompts)
              : state.selectedPrompts,
        })),

      resolveAgentContributions: async (scope) => {
        const api = desktopApi()?.extensions;
        const state = get();
        const workspacePath =
          typeof scope === "string" ? scope : (scope.workspacePath ?? state.workspacePath);
        const workspaceId =
          typeof scope === "string"
            ? state.workspaceId
            : extensionScopeWorkspaceId(scope.workspaceId ?? state.workspaceId);
        if (!api || !workspacePath) return EMPTY_RESOURCES;
        const resources = await api.resolveAgentContributions({
          workspacePath,
          workspaceId,
        });
        return {
          ...resources,
          mcpServers: resources.mcpServers.filter(
            (item) => !state.disabledMcpServers.includes(item.id),
          ),
          skills: resources.skills.filter((item) => !state.disabledSkills.includes(item.id)),
          prompts: resources.prompts.filter((item) => !state.disabledPrompts.includes(item.id)),
        };
      },
    }),
    {
      name: "agui-extension-preferences",
      storage: createPersistentJsonStorage(),
      partialize: (state) => ({
        disabledMcpServers: state.disabledMcpServers,
        disabledSkills: state.disabledSkills,
        disabledPrompts: state.disabledPrompts,
        selectedPrompts: state.selectedPrompts,
      }),
    },
  ),
);

export async function readExtensionAsset(
  extensionId: string,
  path: string,
  workspaceId = useExtensionStore.getState().workspaceId,
): Promise<ExtensionAssetResult> {
  const state = useExtensionStore.getState();
  const workspacePath = workspaceId === state.workspaceId ? state.workspacePath : undefined;
  const key = `${workspaceId}\0${workspacePath ?? ""}\0${extensionId}\0${path}`;
  const now = Date.now();
  const cached = assetCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = requireExtensionApi().readAsset({
    extensionId,
    path,
    workspacePath,
    workspaceId,
  });
  assetCache.set(key, { expiresAt: now + ASSET_CACHE_TTL_MS, promise });
  void promise.catch(() => {
    if (assetCache.get(key)?.promise === promise) assetCache.delete(key);
  });
  if (assetCache.size > 200) {
    for (const candidate of [...assetCache.keys()].slice(0, assetCache.size - 200))
      assetCache.delete(candidate);
  }
  return promise;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function clearExtensionAssetCache(extensionId?: string): void {
  if (!extensionId) {
    assetCache.clear();
    return;
  }
  for (const key of assetCache.keys()) {
    const [, , cachedExtensionId] = key.split("\0", 4);
    if (cachedExtensionId === extensionId) assetCache.delete(key);
  }
}

function extensionRecordsEqual(left: AppExtensionRecord[], right: AppExtensionRecord[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return false;
  }
  return true;
}

function requireExtensionApi() {
  const api = desktopApi()?.extensions;
  if (!api) throw new Error("Extension management requires the AGUI desktop runtime.");
  return api;
}

function handleExtensionEvent(
  event: ExtensionRuntimeEvent,
  set: (
    partial: Partial<ExtensionStore> | ((state: ExtensionStore) => Partial<ExtensionStore>),
  ) => void,
  get: () => ExtensionStore,
): void {
  if (!eventMatchesScope(event, get())) return;
  if (event.type === "log" && event.message) {
    set((state) => ({
      logs: [
        ...state.logs,
        {
          extensionId: event.extensionId,
          message: event.message!,
          workspacePath: event.workspacePath,
          workspaceId: event.workspaceId,
          at: Date.now(),
        },
      ].slice(-200),
    }));
    return;
  }
  clearExtensionAssetCache(event.extensionId);
  if (event.type === "changed") {
    set((state) => ({ refreshRevision: state.refreshRevision + 1 }));
  }
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void get().refresh(), 80);
}

function eventMatchesScope(event: ExtensionRuntimeEvent, state: ExtensionStore): boolean {
  if (
    event.workspaceId !== undefined &&
    extensionScopeWorkspaceId(event.workspaceId) !== extensionScopeWorkspaceId(state.workspaceId)
  ) {
    return false;
  }
  if (
    event.workspacePath !== undefined &&
    state.workspacePath &&
    event.workspacePath !== state.workspacePath
  ) {
    return false;
  }
  return true;
}

export function extensionScopeWorkspaceId(value: string): string {
  return value === "default" ? "" : value;
}
