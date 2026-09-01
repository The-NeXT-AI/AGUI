import { useEffect, useMemo } from "react";
import { useDetailPanels, useRegistryStore, useShellStore } from "@the-next-ai/agui-app";
import {
  desktopApi,
  type DetailPanelRuntimeCommand,
  type DetailPanelRuntimeState,
} from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { useChatStore } from "@/chat/chat-store";
import { useWorkspaceStore } from "@/workspaces/workspace-store";

const PANEL_SYNC_DEBOUNCE_MS = 50;

export function PanelRuntimeBridge() {
  const panels = useDetailPanels();
  const detailPanelOpen = useShellStore((state) => state.detailPanelOpen);
  const activeDetailPanelId = useShellStore((state) => state.activeDetailPanelId);
  const activeDetailPanelTabId = useShellStore((state) => state.activeDetailPanelTabId);
  const tabs = useShellStore((state) => state.detailPanelTabs);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspacePath = useAspStore((state) => state.workspacePath);
  const sessionRoot = useChatStore((state) => {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    return session?.cwd || session?.projectPath || "";
  });
  const draftRoot = useChatStore(
    (state) => state.draftSession?.cwd || state.draftSession?.projectPath || "",
  );
  const root = normalizeProjectRoot(sessionRoot || draftRoot || workspacePath || "");

  const payload = useMemo<DetailPanelRuntimeState>(
    () => ({
      activeDetailPanelId,
      activeDetailPanelTabId,
      detailPanelOpen,
      panels: panels.map((panel) => ({
        allowMultiple: panel.allowMultiple,
        id: panel.id,
        order: panel.order,
        title: panel.title,
      })),
      project: {
        root,
        workspaceId: activeWorkspaceId,
      },
      tabs: tabs.map((tab) => ({
        active: tab.id === activeDetailPanelTabId,
        createdAt: tab.createdAt,
        id: tab.id,
        ordinal: tab.ordinal,
        panelId: tab.panelId,
        title: tab.title,
      })),
      updatedAt: Date.now(),
    }),
    [
      activeDetailPanelId,
      activeDetailPanelTabId,
      activeWorkspaceId,
      detailPanelOpen,
      panels,
      root,
      tabs,
    ],
  );

  useEffect(() => {
    const panelApi = desktopApi()?.panel;
    if (!panelApi?.syncState) return undefined;
    const timer = window.setTimeout(() => {
      void panelApi.syncState(payload).catch(() => undefined);
    }, PANEL_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [payload]);

  useEffect(() => {
    const panelApi = desktopApi()?.panel;
    if (!panelApi?.onCommand) return undefined;
    return panelApi.onCommand((payload) => {
      const command = normalizePanelCommand(payload);
      if (!command) return;
      executePanelCommand(command);
    });
  }, []);

  return null;
}

function executePanelCommand(command: DetailPanelRuntimeCommand): void {
  const shell = useShellStore.getState();
  if (command.type === "panel.open") {
    const panel = useRegistryStore
      .getState()
      .detailPanels.find((item) => item.id === command.panelId);
    shell.openDetailPanel(command.panelId, {
      allowMultiple: command.allowMultiple === true && panel?.allowMultiple === true,
    });
    return;
  }
  if (command.type === "panel.selectTab") {
    shell.setActiveDetailPanel(command.tabId);
    return;
  }
  if (command.type === "panel.closeTab") {
    shell.closeDetailPanelTab(command.tabId);
    return;
  }
  if (command.type === "panel.setOpen") {
    shell.setDetailPanelOpen(command.open);
    return;
  }
  if (command.type === "ide.openFile") {
    shell.openDetailPanel("ide", { allowMultiple: false });
    dispatchIdePanelCommand(command.filePath, command.root);
  }
}

function dispatchIdePanelCommand(filePath: string, root?: string): void {
  const dispatch = () => {
    window.dispatchEvent(
      new CustomEvent("agui:ide-panel-command", {
        detail: { filePath, root, type: "openFile" },
      }),
    );
  };
  window.setTimeout(dispatch, 0);
  window.setTimeout(dispatch, 250);
}

function normalizePanelCommand(value: unknown): DetailPanelRuntimeCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "panel.open" && typeof record.panelId === "string") {
    return {
      type: "panel.open",
      panelId: record.panelId,
      allowMultiple: typeof record.allowMultiple === "boolean" ? record.allowMultiple : undefined,
    };
  }
  if (record.type === "panel.selectTab" && typeof record.tabId === "string") {
    return { type: "panel.selectTab", tabId: record.tabId };
  }
  if (record.type === "panel.closeTab" && typeof record.tabId === "string") {
    return { type: "panel.closeTab", tabId: record.tabId };
  }
  if (record.type === "panel.setOpen" && typeof record.open === "boolean") {
    return { type: "panel.setOpen", open: record.open };
  }
  if (record.type === "ide.openFile" && typeof record.filePath === "string") {
    return {
      type: "ide.openFile",
      filePath: record.filePath,
      root: typeof record.root === "string" ? record.root : undefined,
    };
  }
  return null;
}

function normalizeProjectRoot(value: string): string {
  return value.trim().replace(/[\\/]+$/, "");
}
