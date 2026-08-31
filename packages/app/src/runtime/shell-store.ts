import { create } from "zustand";
import { clampDetailPanelWidth, clampSidebarWidth, productConfig } from "@/product/product-config";
import type { DetailPanelInstance, ShellLayoutState } from "./types.js";

/**
 * Layout state for the AGUI app shell — the session sidebar on the left and
 * the detail panel docked to the right of the conversation.
 */
export interface ShellStore extends ShellLayoutState {
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  openSidebarPanel: (panelId: string) => void;
  setSidebarWidth: (width: number) => void;
  setActivePanel: (panelId: string) => void;
  toggleDetailPanel: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  openDetailPanel: (panelId: string, options?: { allowMultiple?: boolean }) => void;
  createDetailPanelTab: (panelId: string) => void;
  closeDetailPanelTab: (tabId: string) => void;
  setDetailPanelTabTitle: (tabId: string, title: string | undefined) => void;
  setDetailPanelTabIconUrl: (tabId: string, iconUrl: string | undefined) => void;
  setNativeBrowserOverlayOpen: (open: boolean) => void;
  setDetailPanelWidth: (width: number) => void;
  setActiveDetailPanel: (tabId: string) => void;
  detailPanelTabsInitialized: boolean;
  nativeBrowserOverlayOpen: boolean;
}

export const useShellStore = create<ShellStore>()((set) => ({
  sidebarOpen: productConfig.layout.sidebar.defaultOpen,
  sidebarWidth: productConfig.layout.sidebar.defaultWidth,
  activePanelId: null,
  detailPanelOpen: productConfig.layout.detailPanel.defaultOpen,
  detailPanelWidth: productConfig.layout.detailPanel.defaultWidth,
  activeDetailPanelId: null,
  activeDetailPanelTabId: null,
  detailPanelTabs: [],
  detailPanelTabsInitialized: false,
  nativeBrowserOverlayOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  openSidebarPanel: (panelId) => set({ activePanelId: panelId, sidebarOpen: true }),
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  setActivePanel: (panelId) => set({ activePanelId: panelId }),

  toggleDetailPanel: () => set((s) => ({ detailPanelOpen: !s.detailPanelOpen })),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  openDetailPanel: (panelId, options) =>
    set((s) => {
      const existing = options?.allowMultiple
        ? undefined
        : s.detailPanelTabs.find((tab) => tab.panelId === panelId);
      const activeTab = existing ?? createDetailPanelTab(panelId, s.detailPanelTabs);
      return {
        detailPanelTabs: existing ? s.detailPanelTabs : [...s.detailPanelTabs, activeTab],
        detailPanelTabsInitialized: true,
        activeDetailPanelId: activeTab.panelId,
        activeDetailPanelTabId: activeTab.id,
        detailPanelOpen: true,
      };
    }),
  createDetailPanelTab: (panelId) =>
    set((s) => {
      const tab = createDetailPanelTab(panelId, s.detailPanelTabs);
      return {
        detailPanelTabs: [...s.detailPanelTabs, tab],
        detailPanelTabsInitialized: true,
        activeDetailPanelId: panelId,
        activeDetailPanelTabId: tab.id,
        detailPanelOpen: true,
      };
    }),
  closeDetailPanelTab: (tabId) =>
    set((s) => {
      const index = s.detailPanelTabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return {};
      const nextTabs = s.detailPanelTabs.filter((tab) => tab.id !== tabId);
      const closingActive = s.activeDetailPanelTabId === tabId;
      const nextActive = closingActive
        ? (nextTabs[Math.min(index, nextTabs.length - 1)] ?? null)
        : (nextTabs.find((tab) => tab.id === s.activeDetailPanelTabId) ?? null);
      return {
        detailPanelTabs: nextTabs,
        detailPanelTabsInitialized: true,
        activeDetailPanelId: nextActive?.panelId ?? null,
        activeDetailPanelTabId: nextActive?.id ?? null,
        detailPanelOpen: s.detailPanelOpen,
      };
    }),
  setDetailPanelTabTitle: (tabId, title) =>
    set((s) => {
      const nextTitle = normalizeTabTitle(title);
      const tab = s.detailPanelTabs.find((item) => item.id === tabId);
      if (!tab || tab.title === nextTitle) return {};
      return {
        detailPanelTabs: s.detailPanelTabs.map((item) =>
          item.id === tabId ? { ...item, title: nextTitle } : item,
        ),
      };
    }),
  setDetailPanelTabIconUrl: (tabId, iconUrl) =>
    set((s) => {
      const nextIconUrl = normalizeTabIconUrl(iconUrl);
      const tab = s.detailPanelTabs.find((item) => item.id === tabId);
      if (!tab || tab.iconUrl === nextIconUrl) return {};
      return {
        detailPanelTabs: s.detailPanelTabs.map((item) =>
          item.id === tabId ? { ...item, iconUrl: nextIconUrl } : item,
        ),
      };
    }),
  setNativeBrowserOverlayOpen: (open) => set({ nativeBrowserOverlayOpen: open }),
  setDetailPanelWidth: (width) => set({ detailPanelWidth: clampDetailPanelWidth(width) }),
  setActiveDetailPanel: (tabId) =>
    set((s) => {
      const tab = s.detailPanelTabs.find((item) => item.id === tabId);
      if (!tab) return {};
      return {
        activeDetailPanelId: tab.panelId,
        activeDetailPanelTabId: tab.id,
        detailPanelOpen: true,
      };
    }),
}));

function normalizeTabTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/[\r\n\t\0]+/g, " ").trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}

function normalizeTabIconUrl(iconUrl: string | undefined): string | undefined {
  const normalized = iconUrl?.replace(/[\r\n\t\0]+/g, "").trim();
  return normalized ? normalized.slice(0, 50_000) : undefined;
}

function createDetailPanelTab(panelId: string, tabs: DetailPanelInstance[]): DetailPanelInstance {
  const ordinal =
    tabs
      .filter((tab) => tab.panelId === panelId)
      .reduce((max, tab) => Math.max(max, tab.ordinal), 0) + 1;
  return {
    id: `${panelId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    panelId,
    ordinal,
    createdAt: Date.now(),
  };
}
