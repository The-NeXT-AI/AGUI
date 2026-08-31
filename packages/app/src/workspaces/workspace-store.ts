import { create } from "zustand";
import { persist } from "zustand/middleware";
import { desktopApi } from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import type { ApprovalMode } from "@/chat/types";
import { useExtensionStore } from "@/extensions/extension-store";
import { productConfig } from "@/product/product-config";
import { createPersistentJsonStorage } from "@/storage/persistent-storage";
import {
  normalizeFontFamilyPreference,
  useUIStore,
  type FontFamilyPreference,
  type RunSpeed,
  type Theme,
} from "@/ui/ui-store";

export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_WORKSPACE_COLOR = "#3b82f6";
export const DEFAULT_WORKSPACE_THEME_COLOR = "default";
const DARK_ACCENT_FOREGROUND = "#171717";
const LIGHT_ACCENT_FOREGROUND = "#ffffff";
const WORKSPACE_COLOR_SEQUENCE = [
  "#3b82f6",
  "#14b8a6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#a855f7",
  "#64748b",
];
const WORKSPACE_THEME_CSS_VARIABLES = [
  "--bg-canvas",
  "--bg-surface",
  "--bg-surface-hover",
  "--bg-surface-active",
  "--bg-elevated",
  "--bg-sidebar",
  "--bg-input",
  "--fg-primary",
  "--fg-secondary",
  "--fg-tertiary",
  "--border-default",
  "--border-subtle",
  "--border-strong",
  "--selection-bg",
  "--code-bg",
  "--inline-code-bg",
  "--scrollbar",
  "--scrollbar-hover",
  "--scrollbar-active",
  "--accent",
  "--accent-fg",
  "--accent-muted",
  "--focus-ring",
  "--shadow-card",
  "--shadow-composer",
  "--shadow-elevated",
  "--shadow-popover",
] as const;
type Rgb = { r: number; g: number; b: number };
type WorkspaceThemeType = "dark" | "light";
const BLACK_RGB: Rgb = { r: 0, g: 0, b: 0 };
const WHITE_RGB: Rgb = { r: 255, g: 255, b: 255 };

export type WorkspaceConfig = {
  id: string;
  name: string;
  color: string;
  projectPath: string | null;
  providerId?: string;
  model?: string;
  effort?: string;
  speed?: RunSpeed;
  approvalMode?: ApprovalMode;
  theme?: Theme;
  font?: FontFamilyPreference;
  codeFont?: FontFamilyPreference;
  disabledMcpServers: string[];
  disabledSkills: string[];
  disabledPrompts: string[];
  selectedPrompts: string[];
  createdAt: number;
  updatedAt: number;
};

type WorkspacePatch = Partial<
  Pick<
    WorkspaceConfig,
    | "name"
    | "color"
    | "projectPath"
    | "providerId"
    | "model"
    | "effort"
    | "speed"
    | "approvalMode"
    | "theme"
    | "font"
    | "codeFont"
    | "disabledMcpServers"
    | "disabledSkills"
    | "disabledPrompts"
    | "selectedPrompts"
  >
>;

type InitializeWorkspaceInput = {
  defaultPath?: string;
};

type AddWorkspaceInput = {
  color?: string;
  name?: string;
  projectPath?: string | null;
  providerId?: string;
  theme?: Theme;
  font?: FontFamilyPreference;
  codeFont?: FontFamilyPreference;
};

export interface WorkspaceStore {
  workspaces: WorkspaceConfig[];
  activeWorkspaceId: string;
  initialized: boolean;
  initialize(input?: InitializeWorkspaceInput): void;
  activeWorkspace(): WorkspaceConfig;
  addWorkspace(input?: AddWorkspaceInput): string;
  chooseAndAddWorkspace(): Promise<string | null>;
  removeWorkspace(id: string): void;
  switchWorkspace(id: string): void;
  selectAdjacentWorkspace(offset: number): void;
  updateWorkspace(id: string, patch: WorkspacePatch): void;
  updateActiveWorkspace(patch: WorkspacePatch): void;
}

let applyingWorkspace = false;
let suppressingWorkspacePreferenceSync = 0;
let dispatchingWorkspaceTheme = false;
let syncDisposer: (() => void) | null = null;
let fallbackDefaultWorkspace: WorkspaceConfig | null = null;

/** Apply transient, session-scoped UI preferences without overwriting workspace defaults. */
export function withoutWorkspacePreferenceSync<T>(apply: () => T): T {
  suppressingWorkspacePreferenceSync += 1;
  try {
    return apply();
  } finally {
    suppressingWorkspacePreferenceSync -= 1;
  }
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,
      initialized: false,

      initialize: (input = {}) => {
        const workspaces = normalizeWorkspaceList(get().workspaces, input.defaultPath);
        const activeWorkspaceId = workspaces.some((item) => item.id === get().activeWorkspaceId)
          ? get().activeWorkspaceId
          : DEFAULT_WORKSPACE_ID;
        set({ activeWorkspaceId, initialized: true, workspaces });
        applyWorkspacePreferences(workspaceById(workspaces, activeWorkspaceId) ?? workspaces[0]);
      },

      activeWorkspace: () => activeWorkspaceFromState(get()),

      addWorkspace: (input = {}) => {
        const workspaces = normalizeWorkspaceList(get().workspaces);
        const projectPath = normalizeProjectPath(input.projectPath ?? "");
        const now = Date.now();
        const snapshot = currentPreferenceSnapshot();
        const workspace: WorkspaceConfig = {
          ...snapshot,
          id: workspaceId(),
          name: input.name?.trim() || defaultWorkspaceName(projectPath, workspaces.length),
          color: normalizeWorkspaceColor(input.color) || workspaceColorForIndex(workspaces.length),
          projectPath: projectPath || null,
          providerId: input.providerId?.trim() || snapshot.providerId,
          theme: input.theme || snapshot.theme,
          font:
            input.font !== undefined ? normalizeFontFamilyPreference(input.font) : snapshot.font,
          codeFont:
            input.codeFont !== undefined
              ? normalizeFontFamilyPreference(input.codeFont)
              : snapshot.codeFont,
          createdAt: now,
          updatedAt: now,
        };
        set({
          activeWorkspaceId: workspace.id,
          initialized: true,
          workspaces: [...workspaces, workspace],
        });
        applyWorkspacePreferences(workspace);
        return workspace.id;
      },

      chooseAndAddWorkspace: async () => {
        const api = desktopApi();
        if (!api) return null;
        const current = activeWorkspaceFromState(get());
        const selected = await api.workspace.choose(
          current.projectPath || useAspStore.getState().workspacePath || undefined,
        );
        if (!selected) return null;
        return get().addWorkspace({ projectPath: selected });
      },

      removeWorkspace: (id) => {
        const targetId = id.trim();
        if (!targetId || targetId === DEFAULT_WORKSPACE_ID) return;
        let nextWorkspace: WorkspaceConfig | undefined;
        set((state) => {
          const workspaces = normalizeWorkspaceList(state.workspaces);
          if (!workspaceById(workspaces, targetId)) return { workspaces };
          const remaining = workspaces.filter((workspace) => workspace.id !== targetId);
          const activeWorkspaceId = remaining.some(
            (workspace) => workspace.id === state.activeWorkspaceId,
          )
            ? state.activeWorkspaceId
            : DEFAULT_WORKSPACE_ID;
          nextWorkspace =
            activeWorkspaceId !== state.activeWorkspaceId
              ? (workspaceById(remaining, activeWorkspaceId) ?? remaining[0])
              : undefined;
          return {
            activeWorkspaceId,
            initialized: true,
            workspaces: remaining,
          };
        });
        if (nextWorkspace) applyWorkspacePreferences(nextWorkspace);
      },

      switchWorkspace: (id) => {
        const workspaces = normalizeWorkspaceList(get().workspaces);
        const workspace = workspaceById(workspaces, id);
        if (!workspace) return;
        set({ activeWorkspaceId: workspace.id, initialized: true, workspaces });
        applyWorkspacePreferences(workspace);
      },

      selectAdjacentWorkspace: (offset) => {
        const workspaces = normalizeWorkspaceList(get().workspaces);
        if (workspaces.length <= 1) return;
        const currentIndex = Math.max(
          0,
          workspaces.findIndex((item) => item.id === get().activeWorkspaceId),
        );
        const nextIndex = (currentIndex + offset + workspaces.length) % workspaces.length;
        get().switchWorkspace(workspaces[nextIndex].id);
      },

      updateWorkspace: (id, patch) => {
        const targetId = id.trim();
        let updatedActive: WorkspaceConfig | undefined;
        set((state) => {
          const workspaces = normalizeWorkspaceList(state.workspaces);
          const target = workspaceById(workspaces, targetId);
          if (!target) return { workspaces };
          const updated = normalizeWorkspace(
            {
              ...target,
              ...patch,
              color:
                patch.color !== undefined
                  ? normalizeWorkspaceColor(patch.color) || target.color
                  : target.color,
              projectPath:
                patch.projectPath !== undefined
                  ? normalizeProjectPath(patch.projectPath ?? "") || null
                  : target.projectPath,
              disabledMcpServers:
                patch.disabledMcpServers !== undefined
                  ? uniqueStrings(patch.disabledMcpServers)
                  : target.disabledMcpServers,
              disabledSkills:
                patch.disabledSkills !== undefined
                  ? uniqueStrings(patch.disabledSkills)
                  : target.disabledSkills,
              disabledPrompts:
                patch.disabledPrompts !== undefined
                  ? uniqueStrings(patch.disabledPrompts)
                  : target.disabledPrompts,
              selectedPrompts:
                patch.selectedPrompts !== undefined
                  ? uniqueStrings(patch.selectedPrompts)
                  : target.selectedPrompts,
              updatedAt: Date.now(),
            },
            undefined,
          );
          if (!updated) return { workspaces };
          if (targetId === state.activeWorkspaceId) updatedActive = updated;
          return {
            workspaces: workspaces.map((workspace) =>
              workspace.id === target.id ? updated : workspace,
            ),
          };
        });
        if (updatedActive) applyWorkspacePreferences(updatedActive);
      },

      updateActiveWorkspace: (patch) => {
        set((state) => {
          if (!state.initialized || applyingWorkspace) return state;
          const workspaces = normalizeWorkspaceList(state.workspaces);
          const active = workspaceById(workspaces, state.activeWorkspaceId);
          if (!active) return { workspaces };
          const updated =
            normalizeWorkspace(
              {
                ...active,
                ...patch,
                color:
                  patch.color !== undefined
                    ? normalizeWorkspaceColor(patch.color) || active.color
                    : active.color,
                projectPath:
                  patch.projectPath !== undefined
                    ? normalizeProjectPath(patch.projectPath ?? "") || null
                    : active.projectPath,
                disabledMcpServers:
                  patch.disabledMcpServers !== undefined
                    ? uniqueStrings(patch.disabledMcpServers)
                    : active.disabledMcpServers,
                disabledSkills:
                  patch.disabledSkills !== undefined
                    ? uniqueStrings(patch.disabledSkills)
                    : active.disabledSkills,
                disabledPrompts:
                  patch.disabledPrompts !== undefined
                    ? uniqueStrings(patch.disabledPrompts)
                    : active.disabledPrompts,
                selectedPrompts:
                  patch.selectedPrompts !== undefined
                    ? uniqueStrings(patch.selectedPrompts)
                    : active.selectedPrompts,
                updatedAt: Date.now(),
              },
              undefined,
            ) ?? active;
          return {
            workspaces: workspaces.map((workspace) =>
              workspace.id === active.id ? updated : workspace,
            ),
          };
        });
      },
    }),
    {
      name: "agui-workspaces",
      storage: createPersistentJsonStorage(),
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        workspaces: state.workspaces,
      }),
      version: 1,
    },
  ),
);

export function activeWorkspaceFromState(
  state: Pick<WorkspaceStore, "workspaces" | "activeWorkspaceId">,
): WorkspaceConfig {
  const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
  return (
    workspaceById(workspaces, state.activeWorkspaceId) ??
    workspaceById(workspaces, DEFAULT_WORKSPACE_ID) ??
    getFallbackDefaultWorkspace()
  );
}

export function isDefaultWorkspace(workspace: WorkspaceConfig): boolean {
  return workspace.id === DEFAULT_WORKSPACE_ID;
}

export function installWorkspacePreferenceSync(): () => void {
  if (syncDisposer) return syncDisposer;
  const updateActive = (patch: WorkspacePatch) => {
    if (applyingWorkspace || suppressingWorkspacePreferenceSync > 0) return;
    const store = useWorkspaceStore.getState();
    if (!store.initialized) return;
    store.updateActiveWorkspace(patch);
  };

  const unsubAsp = useAspStore.subscribe((state, previous) => {
    const patch: WorkspacePatch = {};
    if (state.activeProviderId !== previous.activeProviderId) {
      patch.providerId = state.activeProviderId || undefined;
    }
    if (state.workspacePath !== previous.workspacePath) {
      patch.projectPath = normalizeProjectPath(state.workspacePath) || null;
    }
    if (Object.keys(patch).length) updateActive(patch);
  });
  const unsubUi = useUIStore.subscribe((state, previous) => {
    const patch: WorkspacePatch = {};
    if (state.theme !== previous.theme) patch.theme = state.theme;
    if (state.font !== previous.font) patch.font = state.font;
    if (state.codeFont !== previous.codeFont) patch.codeFont = state.codeFont;
    if (state.approvalMode !== previous.approvalMode) patch.approvalMode = state.approvalMode;
    if (state.model !== previous.model) patch.model = state.model;
    if (state.effort !== previous.effort) patch.effort = state.effort;
    if (state.speed !== previous.speed) patch.speed = state.speed;
    if (Object.keys(patch).length) updateActive(patch);
  });
  const unsubExtensions = useExtensionStore.subscribe((state, previous) => {
    const patch: WorkspacePatch = {};
    if (!sameStringList(state.disabledMcpServers, previous.disabledMcpServers)) {
      patch.disabledMcpServers = state.disabledMcpServers;
    }
    if (!sameStringList(state.disabledSkills, previous.disabledSkills)) {
      patch.disabledSkills = state.disabledSkills;
    }
    if (!sameStringList(state.disabledPrompts, previous.disabledPrompts)) {
      patch.disabledPrompts = state.disabledPrompts;
    }
    if (!sameStringList(state.selectedPrompts, previous.selectedPrompts)) {
      patch.selectedPrompts = state.selectedPrompts;
    }
    if (Object.keys(patch).length) updateActive(patch);
  });

  const applyActiveWorkspaceTheme = (event: Event) => {
    if (isWorkspaceThemeEvent(event)) return;
    const themeType = baseThemeEventType(event);
    if (!themeType) return;
    applyWorkspaceTheme(activeWorkspaceFromState(useWorkspaceStore.getState()), themeType);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("agui-theme-changed", applyActiveWorkspaceTheme);
  }

  syncDisposer = () => {
    unsubAsp();
    unsubUi();
    unsubExtensions();
    if (typeof window !== "undefined") {
      window.removeEventListener("agui-theme-changed", applyActiveWorkspaceTheme);
    }
    syncDisposer = null;
  };
  return syncDisposer;
}

function applyWorkspacePreferences(workspace: WorkspaceConfig | undefined): void {
  if (!workspace) return;
  applyingWorkspace = true;
  try {
    const asp = useAspStore.getState();
    const providerId = workspace.providerId;
    if (workspace.projectPath !== undefined) asp.setWorkspacePath(workspace.projectPath ?? "");
    if (
      providerId &&
      providerId !== asp.activeProviderId &&
      asp.providers.some((provider) => provider.id === providerId)
    ) {
      asp.setActiveProvider(providerId);
    }

    const ui = useUIStore.getState();
    if (workspace.theme && workspace.theme !== ui.theme) ui.setTheme(workspace.theme);
    if (workspace.font !== undefined && workspace.font !== ui.font) ui.setFont(workspace.font);
    if (workspace.codeFont !== undefined && workspace.codeFont !== ui.codeFont) {
      ui.setCodeFont(workspace.codeFont);
    }
    if (workspace.approvalMode && workspace.approvalMode !== ui.approvalMode) {
      ui.setApprovalMode(workspace.approvalMode);
    }
    if (workspace.model !== undefined && workspace.model !== ui.model) ui.setModel(workspace.model);
    if (workspace.effort !== undefined && workspace.effort !== ui.effort) {
      ui.setEffort(workspace.effort);
    }
    if (workspace.speed && workspace.speed !== ui.speed) ui.setSpeed(workspace.speed);

    useExtensionStore.getState().setResourcePreferences({
      disabledMcpServers: workspace.disabledMcpServers,
      disabledSkills: workspace.disabledSkills,
      disabledPrompts: workspace.disabledPrompts,
      selectedPrompts: workspace.selectedPrompts,
    });
    void useExtensionStore.getState().setWorkspaceScope({
      workspacePath: workspace.projectPath ?? "",
      workspaceId: workspace.id,
    });
    applyWorkspaceTheme(workspace);
  } finally {
    applyingWorkspace = false;
  }
}

function applyWorkspaceTheme(workspace: WorkspaceConfig, themeType?: WorkspaceThemeType): void {
  if (typeof document === "undefined") return;
  const resolvedTheme = themeType ?? resolveWorkspaceThemeType(workspace.theme);
  const root = document.documentElement;
  const themeId = `workspace:${workspace.id}`;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeId = themeId;
  root.style.colorScheme = resolvedTheme;
  const usesDefaultThemeColor = isDefaultWorkspaceThemeColor(workspace.color);
  root.dataset.workspaceThemeColor = usesDefaultThemeColor ? "default" : "custom";
  if (usesDefaultThemeColor) {
    clearWorkspaceThemeVariables(root);
    dispatchWorkspaceThemeChanged(themeId, resolvedTheme);
    return;
  }
  const color = safeWorkspaceColor(workspace.color) || DEFAULT_WORKSPACE_COLOR;
  const rgb = hexToRgb(color);
  if (!rgb) return;
  const foreground = accentForeground(rgb);
  const mutedTarget = foreground === LIGHT_ACCENT_FOREGROUND ? BLACK_RGB : WHITE_RGB;
  const muted = rgbToHex(mixRgb(rgb, mutedTarget, 0.14));
  if (resolvedTheme === "dark") {
    root.style.setProperty("--bg-canvas", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.82)));
    root.style.setProperty("--bg-surface", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.75)));
    root.style.setProperty("--bg-surface-hover", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.68)));
    root.style.setProperty("--bg-surface-active", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.6)));
    root.style.setProperty("--bg-elevated", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.78)));
    root.style.setProperty("--bg-sidebar", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.9)));
    root.style.setProperty("--bg-input", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.76)));
    root.style.setProperty("--fg-primary", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.92)));
    root.style.setProperty("--fg-secondary", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.72)));
    root.style.setProperty("--fg-tertiary", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.54)));
    root.style.setProperty("--border-default", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.58)));
    root.style.setProperty("--border-subtle", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.74)));
    root.style.setProperty("--border-strong", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.34)));
    root.style.setProperty("--selection-bg", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.34)`);
    root.style.setProperty("--code-bg", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.88)));
    root.style.setProperty("--inline-code-bg", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)`);
    root.style.setProperty("--scrollbar", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.34)`);
    root.style.setProperty("--scrollbar-hover", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.48)`);
    root.style.setProperty("--scrollbar-active", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.62)`);
  } else {
    root.style.setProperty("--bg-canvas", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.96)));
    root.style.setProperty("--bg-surface", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.91)));
    root.style.setProperty("--bg-surface-hover", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.84)));
    root.style.setProperty("--bg-surface-active", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.76)));
    root.style.setProperty("--bg-elevated", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.98)));
    root.style.setProperty("--bg-sidebar", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.88)));
    root.style.setProperty("--bg-input", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.98)));
    root.style.setProperty("--fg-primary", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.86)));
    root.style.setProperty("--fg-secondary", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.62)));
    root.style.setProperty("--fg-tertiary", rgbToHex(mixRgb(rgb, BLACK_RGB, 0.42)));
    root.style.setProperty("--border-default", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.68)));
    root.style.setProperty("--border-subtle", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.84)));
    root.style.setProperty("--border-strong", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.46)));
    root.style.setProperty("--selection-bg", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)`);
    root.style.setProperty("--code-bg", rgbToHex(mixRgb(rgb, WHITE_RGB, 0.93)));
    root.style.setProperty("--inline-code-bg", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`);
    root.style.setProperty("--scrollbar", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.24)`);
    root.style.setProperty("--scrollbar-hover", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.36)`);
    root.style.setProperty("--scrollbar-active", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.48)`);
  }
  root.style.setProperty("--accent", color);
  root.style.setProperty("--accent-fg", foreground);
  root.style.setProperty("--accent-muted", muted);
  root.style.setProperty("--focus-ring", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.68)`);
  root.style.setProperty(
    "--shadow-card",
    `0 1px 1px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.05), 0 10px 28px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`,
  );
  root.style.setProperty(
    "--shadow-composer",
    resolvedTheme === "dark"
      ? `0 1px 1px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.045), 0 8px 24px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.085)`
      : `0 1px 1px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.04), 0 8px 22px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.07)`,
  );
  root.style.setProperty(
    "--shadow-elevated",
    `0 1px 2px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.06), 0 18px 48px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
  );
  root.style.setProperty(
    "--shadow-popover",
    `0 1px 2px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08), 0 18px 56px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`,
  );
  dispatchWorkspaceThemeChanged(themeId, resolvedTheme);
}

function dispatchWorkspaceThemeChanged(id: string, type: WorkspaceThemeType): void {
  if (typeof window === "undefined" || dispatchingWorkspaceTheme) return;
  dispatchingWorkspaceTheme = true;
  try {
    window.__AGUI_CURRENT_THEME__ = { id, type, definition: undefined };
    window.dispatchEvent(
      new CustomEvent("agui-theme-changed", {
        detail: { definition: undefined, id, type, workspaceTheme: true },
      }),
    );
  } finally {
    dispatchingWorkspaceTheme = false;
  }
}

function isWorkspaceThemeEvent(event: Event): boolean {
  return Boolean(
    (event as CustomEvent<{ workspaceTheme?: boolean }>).detail?.workspaceTheme ||
    dispatchingWorkspaceTheme,
  );
}

function baseThemeEventType(event: Event): WorkspaceThemeType | undefined {
  const detail = (event as CustomEvent<{ id?: unknown; type?: unknown }>).detail;
  const id = detail?.id;
  if (id !== "dark" && id !== "light" && id !== "system") return undefined;
  const type = detail?.type;
  return type === "dark" || type === "light" ? type : undefined;
}

function resolveWorkspaceThemeType(theme: Theme | undefined): WorkspaceThemeType {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  if (theme === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  if (typeof document !== "undefined") {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") return current;
  }
  return "dark";
}

function normalizeWorkspaceList(
  values: WorkspaceConfig[] | undefined,
  defaultPath?: string,
): WorkspaceConfig[] {
  const normalized = (Array.isArray(values) ? values : [])
    .map((workspace) => normalizeWorkspace(workspace, defaultPath))
    .filter((workspace): workspace is WorkspaceConfig => Boolean(workspace));
  if (!normalized.some((workspace) => workspace.id === DEFAULT_WORKSPACE_ID)) {
    normalized.unshift(createDefaultWorkspace(defaultPath));
  }
  return normalized.map((workspace) =>
    workspace.id === DEFAULT_WORKSPACE_ID && defaultPath && !workspace.projectPath
      ? { ...workspace, projectPath: normalizeProjectPath(defaultPath) || null }
      : workspace,
  );
}

function normalizeWorkspace(
  value: Partial<WorkspaceConfig> | undefined,
  defaultPath?: string,
): WorkspaceConfig | null {
  if (!value || typeof value !== "object") return null;
  const now = Date.now();
  const id = value.id?.trim() || (value.id === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE_ID : "");
  if (!id) return null;
  const projectPath =
    value.projectPath !== undefined
      ? normalizeProjectPath(value.projectPath ?? "") || null
      : id === DEFAULT_WORKSPACE_ID
        ? normalizeProjectPath(defaultPath ?? "") || null
        : null;
  return {
    id,
    name: value.name?.trim() || (id === DEFAULT_WORKSPACE_ID ? "Default workspace" : "Workspace"),
    color:
      normalizeWorkspaceColor(value.color) ||
      (id === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE_THEME_COLOR : DEFAULT_WORKSPACE_COLOR),
    projectPath,
    providerId: value.providerId?.trim() || undefined,
    model: value.model ?? productConfig.defaults.model,
    effort: value.effort ?? productConfig.defaults.effort,
    speed: isRunSpeed(value.speed) ? value.speed : productConfig.defaults.speed,
    approvalMode: isApprovalMode(value.approvalMode)
      ? value.approvalMode
      : productConfig.defaults.approvalMode,
    theme: value.theme ?? productConfig.defaults.theme,
    font: normalizeFontFamilyPreference(value.font),
    codeFont: normalizeFontFamilyPreference(value.codeFont),
    disabledMcpServers: uniqueStrings(value.disabledMcpServers ?? []),
    disabledSkills: uniqueStrings(value.disabledSkills ?? []),
    disabledPrompts: uniqueStrings(value.disabledPrompts ?? []),
    selectedPrompts: uniqueStrings(value.selectedPrompts ?? []),
    createdAt: finiteNumber(value.createdAt) || now,
    updatedAt: finiteNumber(value.updatedAt) || finiteNumber(value.createdAt) || now,
  };
}

function createDefaultWorkspace(defaultPath?: string): WorkspaceConfig {
  const now = Date.now();
  return {
    ...currentPreferenceSnapshot(),
    id: DEFAULT_WORKSPACE_ID,
    name: "Default workspace",
    color: DEFAULT_WORKSPACE_THEME_COLOR,
    projectPath: normalizeProjectPath(defaultPath ?? "") || null,
    createdAt: now,
    updatedAt: now,
  };
}

function getFallbackDefaultWorkspace(): WorkspaceConfig {
  fallbackDefaultWorkspace ??= {
    id: DEFAULT_WORKSPACE_ID,
    name: "Default workspace",
    color: DEFAULT_WORKSPACE_THEME_COLOR,
    projectPath: null,
    providerId: undefined,
    model: productConfig.defaults.model,
    effort: productConfig.defaults.effort,
    speed: productConfig.defaults.speed,
    approvalMode: productConfig.defaults.approvalMode,
    theme: productConfig.defaults.theme,
    font: "",
    codeFont: "",
    disabledMcpServers: [],
    disabledSkills: [],
    disabledPrompts: [],
    selectedPrompts: [],
    createdAt: 0,
    updatedAt: 0,
  };
  return fallbackDefaultWorkspace;
}

function currentPreferenceSnapshot(): Pick<
  WorkspaceConfig,
  | "providerId"
  | "model"
  | "effort"
  | "speed"
  | "approvalMode"
  | "theme"
  | "font"
  | "codeFont"
  | "disabledMcpServers"
  | "disabledSkills"
  | "disabledPrompts"
  | "selectedPrompts"
> {
  const asp = useAspStore.getState();
  const ui = useUIStore.getState();
  const extensions = useExtensionStore.getState();
  return {
    providerId: asp.activeProviderId || undefined,
    model: ui.model,
    effort: ui.effort,
    speed: ui.speed,
    approvalMode: ui.approvalMode,
    theme: ui.theme,
    font: ui.font,
    codeFont: ui.codeFont,
    disabledMcpServers: [...extensions.disabledMcpServers],
    disabledSkills: [...extensions.disabledSkills],
    disabledPrompts: [...extensions.disabledPrompts],
    selectedPrompts: [...extensions.selectedPrompts],
  };
}

function workspaceById(
  workspaces: WorkspaceConfig[],
  id: string | undefined,
): WorkspaceConfig | undefined {
  return workspaces.find((workspace) => workspace.id === id);
}

function workspaceId(): string {
  return `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultWorkspaceName(projectPath: string, count: number): string {
  return projectPath ? basename(projectPath) : `Workspace ${count + 1}`;
}

function basename(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop()
      ?.trim() || value
  );
}

function normalizeProjectPath(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/[\\/]+$/, "");
}

function hexToRgb(color: string): Rgb | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function accentForeground(rgb: Rgb): string {
  return contrastRatio(rgb, BLACK_RGB) >= contrastRatio(rgb, WHITE_RGB)
    ? DARK_ACCENT_FOREGROUND
    : LIGHT_ACCENT_FOREGROUND;
}

function contrastRatio(left: Rgb, right: Rgb): number {
  const light = relativeLuminance(left);
  const dark = relativeLuminance(right);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * linearChannel(rgb.r) + 0.7152 * linearChannel(rgb.g) + 0.0722 * linearChannel(rgb.b)
  );
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function mixRgb(base: Rgb, target: Rgb, amount: number): Rgb {
  const mix = (left: number, right: number) => Math.round(left * (1 - amount) + right * amount);
  return {
    r: mix(base.r, target.r),
    g: mix(base.g, target.g),
    b: mix(base.b, target.b),
  };
}

function rgbToHex(rgb: Rgb): string {
  return `#${hexChannel(rgb.r)}${hexChannel(rgb.g)}${hexChannel(rgb.b)}`;
}

function hexChannel(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function workspaceColorForIndex(index: number): string {
  return (
    WORKSPACE_COLOR_SEQUENCE[index % WORKSPACE_COLOR_SEQUENCE.length] ?? DEFAULT_WORKSPACE_COLOR
  );
}

function normalizeWorkspaceColor(value: unknown): string | undefined {
  if (isDefaultWorkspaceThemeColor(value)) return DEFAULT_WORKSPACE_THEME_COLOR;
  const color = safeWorkspaceColor(value);
  return color?.toLowerCase() === "#ffffff" ? DEFAULT_WORKSPACE_THEME_COLOR : color;
}

function isDefaultWorkspaceThemeColor(value: unknown): boolean {
  return value === DEFAULT_WORKSPACE_THEME_COLOR;
}

function safeWorkspaceColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined;
}

function clearWorkspaceThemeVariables(root: HTMLElement): void {
  for (const property of WORKSPACE_THEME_CSS_VARIABLES) root.style.removeProperty(property);
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "suggest" || value === "auto-edit" || value === "full-auto";
}

function isRunSpeed(value: unknown): value is RunSpeed {
  return value === "default" || value === "fast";
}
