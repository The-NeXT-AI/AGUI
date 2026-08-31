import { create } from "zustand";
import type { ApprovalMode, Attachment } from "@/chat/types";
import type { BrowserAnnotation } from "@/asp/desktop-api";
import { productConfig } from "@/product/product-config";

export type Theme = string;
export type ResolvedTheme = "dark" | "light";
export type RunSpeed = "default" | "fast";
export type FontFamilyPreference = string;
export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, ui-sans-serif, sans-serif';
export const DEFAULT_CODE_FONT_STACK =
  'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, Consolas, monospace';
const LEGACY_FONT_OPTIONS: Record<string, FontFamilyPreference> = {
  default: "",
  system: SYSTEM_FONT_STACK,
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: DEFAULT_CODE_FONT_STACK,
};
export type SidebarProjectNavItem = {
  key: string;
  label: string;
  projectPath: string | null;
  title: string;
};
export type SidebarSessionAction = "new" | "import" | "newFolder" | "newProject";
export type SidebarSessionActionRequest = {
  action: SidebarSessionAction;
  id: number;
};
export type ScheduleTaskDraftRequest = {
  id: number;
  providerId?: string;
  projectPath?: string | null;
  prompt?: string;
  title?: string;
  workspaceId?: string;
};
export type SettingsSection = "general" | "remote-access" | "agents" | "mcp-gateway" | "about";
export type MessageEditDraft = {
  attachments?: Attachment[];
  blockId: string;
  sessionId: string;
  text: string;
};
export type ComposerInsertMode = "append" | "replace";
export type ComposerInsertRequest = {
  id: number;
  mode?: ComposerInsertMode;
  text: string;
};
export type BrowserAnnotationsDraft = {
  annotations: BrowserAnnotation[];
  browserId: string;
  snapshots?: BrowserSnapshotDraft[];
  title: string;
  updatedAt: number;
  url: string;
};

export type BrowserSnapshotDraft = {
  id: string;
  createdAt: number;
  html?: string;
  mimeType?: "image/png" | "image/jpeg";
  screenshotDataUrl?: string;
  text: string;
  title: string;
  url: string;
};

interface UIStore {
  theme: Theme;
  font: FontFamilyPreference;
  codeFont: FontFamilyPreference;
  approvalMode: ApprovalMode;
  model: string;
  effort: string;
  speed: RunSpeed;
  paletteOpen: boolean;
  extensionsOpen: boolean;
  scheduleOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  sidebarProjectNavItems: SidebarProjectNavItem[];
  sidebarProjectNavIndex: number;
  sidebarSessionActionRequest: SidebarSessionActionRequest | null;
  scheduleTaskDraftRequest: ScheduleTaskDraftRequest | null;
  findOpen: boolean;
  findQuery: string;
  setTheme: (theme: Theme) => void;
  setFont: (font: FontFamilyPreference) => void;
  setCodeFont: (font: FontFamilyPreference) => void;
  toggleTheme: () => void;
  setApprovalMode: (mode: ApprovalMode) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  setSpeed: (speed: RunSpeed) => void;
  openPalette: () => void;
  closePalette: () => void;
  openExtensions: () => void;
  closeExtensions: () => void;
  openSchedule: () => void;
  closeSchedule: () => void;
  openSettings: (section?: SettingsSection) => void;
  setSettingsSection: (section: SettingsSection) => void;
  closeSettings: () => void;
  setSidebarProjectNavItems: (items: SidebarProjectNavItem[]) => void;
  setSidebarProjectNavIndex: (index: number) => void;
  requestSidebarSessionAction: (action: SidebarSessionAction) => void;
  requestScheduleTaskDraft: (input?: Omit<ScheduleTaskDraftRequest, "id">) => void;
  setFindOpen: (open: boolean) => void;
  setFindQuery: (query: string) => void;
  /** When set, the composer loads this text (edit-and-resend flow), then clears it. */
  editDraft: string | null;
  setEditDraft: (text: string | null) => void;
  composerInsertRequest: ComposerInsertRequest | null;
  requestComposerInsert: (input: Omit<ComposerInsertRequest, "id">) => void;
  clearComposerInsertRequest: () => void;
  browserAnnotationsDraft: BrowserAnnotationsDraft | null;
  setBrowserAnnotationsDraft: (draft: BrowserAnnotationsDraft) => void;
  clearBrowserAnnotationsDraft: (browserId?: string) => void;
  messageEditDraft: MessageEditDraft | null;
  setMessageEditDraft: (draft: MessageEditDraft | null) => void;
  searchChatsOpen: boolean;
  setSearchChatsOpen: (open: boolean) => void;
}

function applyTheme(theme: Theme) {
  if (theme === "dark" || theme === "light") {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-theme-id", theme);
  } else if (theme === "system") {
    document.documentElement.setAttribute("data-theme", systemTheme());
    document.documentElement.setAttribute("data-theme-id", "system");
  }
}

function applyFont(font: FontFamilyPreference) {
  if (typeof document === "undefined") return;
  const normalized = normalizeFontFamilyPreference(font);
  const root = document.documentElement;
  if (!normalized) {
    delete root.dataset.font;
    root.style.removeProperty("--app-font-sans");
    return;
  }
  root.dataset.font = "custom";
  root.style.setProperty("--app-font-sans", normalized);
}

function applyCodeFont(font: FontFamilyPreference) {
  if (typeof document === "undefined") return;
  const normalized = normalizeFontFamilyPreference(font);
  const root = document.documentElement;
  if (!normalized) {
    delete root.dataset.codeFont;
    root.style.removeProperty("--app-font-mono");
    return;
  }
  root.dataset.codeFont = "custom";
  root.style.setProperty("--app-font-mono", normalized);
}

export function normalizeFontFamilyPreference(value: unknown): FontFamilyPreference {
  const font = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (Object.prototype.hasOwnProperty.call(LEGACY_FONT_OPTIONS, font)) {
    return LEGACY_FONT_OPTIONS[font] ?? "";
  }
  if (!font || font.length > 256) return "";
  if (/[\u0000-\u001f\u007f;{}<>\\]/.test(font)) return "";
  if (/(?:url|var|calc|env)\s*\(/i.test(font)) return "";
  return font;
}

function updateThemeWithTransition(apply: () => void): void {
  const viewTransition = (document as DocumentWithViewTransition).startViewTransition;
  if (!viewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
    return;
  }
  viewTransition.call(document, apply);
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function effectiveTheme(theme: Theme): ResolvedTheme {
  if (theme === "light") return "light";
  if (theme === "system") return systemTheme();
  return "dark";
}

function sidebarProjectNavItemsEqual(
  left: SidebarProjectNavItem[],
  right: SidebarProjectNavItem[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      item.key === other?.key &&
      item.label === other.label &&
      item.projectPath === other.projectPath &&
      item.title === other.title
    );
  });
}

/**
 * Cross-cutting UI preferences shared by the composer, status bar, and command
 * palette. Theme flips the `data-theme` attribute so the CSS tokens re-resolve.
 */
export const useUIStore = create<UIStore>()((set, get) => ({
  theme: productConfig.defaults.theme,
  font: "",
  codeFont: "",
  approvalMode: productConfig.defaults.approvalMode,
  model: productConfig.defaults.model,
  effort: productConfig.defaults.effort,
  speed: productConfig.defaults.speed,
  paletteOpen: false,
  extensionsOpen: false,
  scheduleOpen: false,
  settingsOpen: false,
  settingsSection: "general",
  sidebarProjectNavItems: [],
  sidebarProjectNavIndex: 0,
  sidebarSessionActionRequest: null,
  scheduleTaskDraftRequest: null,
  findOpen: false,
  findQuery: "",
  editDraft: null,
  composerInsertRequest: null,
  browserAnnotationsDraft: null,
  messageEditDraft: null,
  searchChatsOpen: false,

  setTheme: (theme) =>
    updateThemeWithTransition(() => {
      applyTheme(theme);
      set({ theme });
    }),
  setFont: (font) => {
    const normalized = normalizeFontFamilyPreference(font);
    applyFont(normalized);
    set({ font: normalized });
  },
  setCodeFont: (codeFont) => {
    const normalized = normalizeFontFamilyPreference(codeFont);
    applyCodeFont(normalized);
    set({ codeFont: normalized });
  },
  toggleTheme: () => {
    const next: Theme = effectiveTheme(get().theme) === "dark" ? "light" : "dark";
    updateThemeWithTransition(() => {
      applyTheme(next);
      set({ theme: next });
    });
  },
  setApprovalMode: (approvalMode) => set({ approvalMode }),
  setModel: (model) => set({ model }),
  setEffort: (effort) => set({ effort }),
  setSpeed: (speed) => set({ speed }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openExtensions: () =>
    productConfig.features.extensionsPage
      ? set({ extensionsOpen: true, scheduleOpen: false, settingsOpen: false })
      : undefined,
  closeExtensions: () => set({ extensionsOpen: false }),
  openSchedule: () =>
    productConfig.features.scheduledTasks
      ? set({ extensionsOpen: false, scheduleOpen: true, settingsOpen: false })
      : undefined,
  closeSchedule: () => set({ scheduleOpen: false }),
  openSettings: (settingsSection = "general") =>
    productConfig.features.settingsPage
      ? set({
          extensionsOpen: false,
          scheduleOpen: false,
          settingsOpen: true,
          settingsSection,
        })
      : undefined,
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  closeSettings: () => set({ settingsOpen: false }),
  setSidebarProjectNavItems: (sidebarProjectNavItems) =>
    set((state) => {
      const sidebarProjectNavIndex =
        sidebarProjectNavItems.length === 0
          ? 0
          : Math.min(state.sidebarProjectNavIndex, sidebarProjectNavItems.length - 1);
      if (
        state.sidebarProjectNavIndex === sidebarProjectNavIndex &&
        sidebarProjectNavItemsEqual(state.sidebarProjectNavItems, sidebarProjectNavItems)
      ) {
        return state;
      }
      return {
        sidebarProjectNavItems,
        sidebarProjectNavIndex,
      };
    }),
  setSidebarProjectNavIndex: (sidebarProjectNavIndex) =>
    set((state) => {
      const nextIndex =
        state.sidebarProjectNavItems.length === 0
          ? 0
          : Math.max(0, Math.min(sidebarProjectNavIndex, state.sidebarProjectNavItems.length - 1));
      return state.sidebarProjectNavIndex === nextIndex
        ? state
        : { sidebarProjectNavIndex: nextIndex };
    }),
  requestSidebarSessionAction: (action) =>
    set((state) => ({
      sidebarSessionActionRequest: {
        action,
        id: (state.sidebarSessionActionRequest?.id ?? 0) + 1,
      },
    })),
  requestScheduleTaskDraft: (input = {}) =>
    set((state) => ({
      scheduleTaskDraftRequest: {
        ...input,
        id: (state.scheduleTaskDraftRequest?.id ?? 0) + 1,
      },
    })),
  setFindOpen: (findOpen) => set({ findOpen }),
  setFindQuery: (findQuery) => set({ findQuery }),
  setEditDraft: (editDraft) => set({ editDraft }),
  requestComposerInsert: (input) =>
    set((state) => ({
      composerInsertRequest: {
        ...input,
        id: (state.composerInsertRequest?.id ?? 0) + 1,
      },
    })),
  clearComposerInsertRequest: () => set({ composerInsertRequest: null }),
  setBrowserAnnotationsDraft: (browserAnnotationsDraft) => set({ browserAnnotationsDraft }),
  clearBrowserAnnotationsDraft: (browserId) =>
    set((state) => {
      if (!state.browserAnnotationsDraft) return state;
      if (browserId && state.browserAnnotationsDraft.browserId !== browserId) return state;
      return { browserAnnotationsDraft: null };
    }),
  setMessageEditDraft: (messageEditDraft) => set({ messageEditDraft }),
  setSearchChatsOpen: (searchChatsOpen) => set({ searchChatsOpen }),
}));

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};
