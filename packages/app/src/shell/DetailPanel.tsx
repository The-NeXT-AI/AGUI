import { useEffect, useMemo, useState } from "react";
import {
  useDetailPanels,
  useShellStore,
  type DetailPanel as DetailPanelContribution,
  type DetailPanelInstance,
  type IconType,
} from "@the-next-ai/agui-app";
import { Plus, X } from "lucide-react";
import { cn } from "@/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useT, type TranslateFn } from "@/lib/i18n";
import { UIRegion } from "@/product/UIRegion";
import { useAspStore } from "@/asp/asp-store";
import { useChatStore } from "@/chat/chat-store";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import {
  DetailPanelProjectProvider,
  useDetailPanelProjectContext,
  type DetailPanelProjectContextValue,
} from "./detail-panel-project-context";

const DETAIL_PANEL_PROJECT_CACHE_LIMIT = 6;

function useActiveDetailPanelProject(): DetailPanelProjectContextValue {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspacePath = useAspStore((state) => state.workspacePath);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const sessionRoot = useChatStore((state) => {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    return session?.cwd || session?.projectPath || "";
  });
  const draftRoot = useChatStore(
    (state) => state.draftSession?.cwd || state.draftSession?.projectPath || "",
  );
  const root = normalizeProjectRoot(sessionRoot || draftRoot || workspacePath || "");
  const key = `workspace:${activeWorkspaceId}:${root ? `project:${root}` : "private"}`;
  return useMemo(
    () => ({
      activeSessionId,
      key,
      root,
      workspaceId: activeWorkspaceId,
    }),
    [activeSessionId, activeWorkspaceId, key, root],
  );
}

/**
 * The right-hand detail panel — the AGUI "detail panel" docked beside the
 * conversation. Extensions register panels (diffs, tool-call details, file
 * previews, an ephemeral side chat); the pane stays hidden until revealed from
 * the header. It mirrors the left sidebar on the opposite side, adding a close
 * affordance and tab switching when more than one panel is contributed.
 */
export function DetailPanel() {
  const activeProject = useActiveDetailPanelProject();
  const [cachedProjects, setCachedProjects] = useState<DetailPanelProjectContextValue[]>(() => [
    activeProject,
  ]);

  useEffect(() => {
    setCachedProjects((current) => {
      const retained = current.filter((project) => project.key !== activeProject.key);
      return [...retained, activeProject].slice(-DETAIL_PANEL_PROJECT_CACHE_LIMIT);
    });
  }, [activeProject]);

  const renderedProjects = cachedProjects.some((project) => project.key === activeProject.key)
    ? cachedProjects
    : [...cachedProjects, activeProject].slice(-DETAIL_PANEL_PROJECT_CACHE_LIMIT);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      {renderedProjects.map((project) => {
        const active = project.key === activeProject.key;
        return (
          <div
            key={project.key}
            aria-hidden={!active}
            className={
              active
                ? "absolute inset-0 h-full min-h-0"
                : "pointer-events-none absolute inset-0 h-full min-h-0 opacity-0"
            }
          >
            <DetailPanelProjectProvider value={project}>
              <DetailPanelContent active={active} />
            </DetailPanelProjectProvider>
          </div>
        );
      })}
    </div>
  );
}

function DetailPanelContent({ active: projectActive }: { active: boolean }) {
  const t = useT();
  const panels = useDetailPanels();
  const detailPanelOpen = useShellStore((s) => s.detailPanelOpen);
  const tabs = useShellStore((s) => s.detailPanelTabs);
  const tabsInitialized = useShellStore((s) => s.detailPanelTabsInitialized);
  const activeTabId = useShellStore((s) => s.activeDetailPanelTabId);
  const setActiveDetailPanel = useShellStore((s) => s.setActiveDetailPanel);
  const createDetailPanelTab = useShellStore((s) => s.createDetailPanelTab);
  const closeDetailPanelTab = useShellStore((s) => s.closeDetailPanelTab);
  const setNativeBrowserOverlayOpen = useShellStore((s) => s.setNativeBrowserOverlayOpen);
  const project = useDetailPanelProjectContext();
  const idPrefix = project ? `detail-panel-${encodeURIComponent(project.key)}` : "detail-panel";
  const panelById = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);
  const visibleTabs = tabs.filter((tab) => panelById.has(tab.panelId));
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? visibleTabs[0] ?? null;
  const active = activeTab ? (panelById.get(activeTab.panelId) ?? null) : null;
  const availablePanels = panels.filter(
    (panel) => panel.allowMultiple || !visibleTabs.some((tab) => tab.panelId === panel.id),
  );

  useEffect(() => {
    if (
      !projectActive ||
      !detailPanelOpen ||
      tabsInitialized ||
      visibleTabs.length > 0 ||
      panels.length === 0
    ) {
      return;
    }
    createDetailPanelTab(panels[0].id);
  }, [
    createDetailPanelTab,
    detailPanelOpen,
    panels,
    projectActive,
    tabsInitialized,
    visibleTabs.length,
  ]);

  useEffect(() => () => setNativeBrowserOverlayOpen(false), [setNativeBrowserOverlayOpen]);

  if (panels.length === 0) {
    return (
      <div className="bg-sidebar flex h-full flex-col">
        <div className="app-titlebar electron-drag-region border-border-subtle relative h-[var(--titlebar-height)] shrink-0 border-b">
          <div
            aria-hidden
            className="native-titlebar-click-slot shell-detail-panel-native-click-slot"
          />
        </div>
        <UIRegion id="detailPanel.noRegisteredTools">
          <div className="text-subtle flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[13px]">
            {t("detailPanel.noRegisteredTools")}
          </div>
        </UIRegion>
      </div>
    );
  }

  return (
    <div className="bg-sidebar flex h-full flex-col">
      <div className="app-titlebar app-titlebar-right-drawer-inset electron-drag-region border-border-subtle relative flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b pl-2">
        <div
          aria-hidden
          className="native-titlebar-click-slot shell-detail-panel-native-click-slot"
        />
        <UIRegion id="detailPanel.tabs" data={{ count: visibleTabs.length }}>
          <div
            role="tablist"
            aria-label={t("detailPanel.tabsLabel")}
            className="side-panel-plugin-interactive no-scrollbar relative z-10 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            {visibleTabs.map((tab) => {
              const panel = panelById.get(tab.panelId);
              if (!panel) return null;
              const Icon = panel.icon;
              const isActive = tab.id === activeTab?.id;
              const tabTitle = detailTabTitle(panel, tab, visibleTabs, t);
              const tabElementId = `${idPrefix}-tab-${encodeURIComponent(tab.id)}`;
              const tabPanelElementId = `${idPrefix}-content-${encodeURIComponent(tab.id)}`;
              const moveFocus = (nextIndex: number) => {
                const nextTab = visibleTabs[nextIndex];
                if (!nextTab) return;
                setActiveDetailPanel(nextTab.id);
                requestAnimationFrame(() => {
                  document
                    .getElementById(`${idPrefix}-tab-${encodeURIComponent(nextTab.id)}`)
                    ?.focus();
                });
              };
              return (
                <UIRegion
                  key={tab.id}
                  id="detailPanel.tab"
                  data={{ tab, panel: { id: panel.id, title: panel.title }, active: isActive }}
                >
                  <div
                    className={cn(
                      "side-panel-plugin-interactive group/tab flex h-8 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-md py-0 pr-1 pl-2 text-[13px] transition-colors outline-none",
                      isActive
                        ? "bg-surface-hover text-fg"
                        : "text-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    <button
                      id={tabElementId}
                      type="button"
                      role="tab"
                      tabIndex={isActive ? 0 : -1}
                      aria-selected={isActive}
                      aria-controls={tabPanelElementId}
                      data-side-panel-tab={tab.id}
                      data-side-panel-plugin={panel.id}
                      title={tabTitle}
                      onClick={() => setActiveDetailPanel(tab.id)}
                      onKeyDown={(event) => {
                        const index = visibleTabs.findIndex((item) => item.id === tab.id);
                        if (event.key === "ArrowRight") {
                          event.preventDefault();
                          moveFocus((index + 1) % visibleTabs.length);
                        } else if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          moveFocus((index - 1 + visibleTabs.length) % visibleTabs.length);
                        } else if (event.key === "Home") {
                          event.preventDefault();
                          moveFocus(0);
                        } else if (event.key === "End") {
                          event.preventDefault();
                          moveFocus(visibleTabs.length - 1);
                        }
                      }}
                      className="flex h-full min-w-0 items-center gap-1.5 outline-none"
                    >
                      <DetailPanelTabIcon iconUrl={tab.iconUrl} fallback={Icon} />
                      <span className="max-w-28 truncate">{tabTitle}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t("detailPanel.close", { title: tabTitle })}
                      title={t("detailPanel.close", { title: tabTitle })}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        closeDetailPanelTab(tab.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        closeDetailPanelTab(tab.id);
                      }}
                      className="text-subtle hover:bg-surface-active hover:text-fg ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </UIRegion>
              );
            })}
          </div>
        </UIRegion>

        <div className="side-panel-plugin-interactive relative z-10 ml-auto flex shrink-0 items-center gap-1">
          {projectActive
            ? active?.actions?.(activeTab ? { ...activeTab, active: true } : undefined)
            : null}
          <UIRegion
            id="detailPanel.addMenu"
            data={{
              availablePanels: availablePanels.map((panel) => ({
                id: panel.id,
                title: panel.title,
              })),
            }}
          >
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) setNativeBrowserOverlayOpen(true);
              }}
              onOpenChangeComplete={(open) => setNativeBrowserOverlayOpen(open)}
            >
              <DropdownMenuTrigger
                title={t("detailPanel.open")}
                aria-label={t("detailPanel.open")}
                className="side-panel-plugin-interactive text-muted hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-active data-[state=open]:text-fg flex h-8 w-8 items-center justify-center rounded-md transition-colors"
              >
                <Plus size={15} />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" className="w-48">
                {availablePanels.length === 0 ? (
                  <DropdownMenuItem disabled>{t("detailPanel.noTools")}</DropdownMenuItem>
                ) : (
                  availablePanels.map((panel) => {
                    const Icon = panel.icon;
                    return (
                      <DropdownMenuItem
                        key={panel.id}
                        onSelect={() => createDetailPanelTab(panel.id)}
                      >
                        <Icon size={14} className="text-subtle shrink-0" />
                        <span className="truncate">{localizedPanelTitle(panel, t)}</span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </UIRegion>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {active ? null : (
          <UIRegion id="detailPanel.empty">
            <div className="text-subtle flex h-full items-center justify-center p-6 text-center text-[13px]">
              {t("detailPanel.empty")}
            </div>
          </UIRegion>
        )}
        {visibleTabs.map((tab) => {
          const panel = panelById.get(tab.panelId);
          if (!panel) return null;
          const isActive = projectActive && tab.id === activeTab?.id;
          if (!isActive && !panel.retainContextWhenHidden) return null;
          const instance = { ...tab, active: isActive };
          return (
            <div
              key={tab.id}
              id={`${idPrefix}-content-${encodeURIComponent(tab.id)}`}
              role="tabpanel"
              aria-labelledby={`${idPrefix}-tab-${encodeURIComponent(tab.id)}`}
              data-app-shell-tab-panel-controller="right"
              data-tab-id={tab.id}
              data-panel-id={panel.id}
              hidden={!isActive}
              className={cn("absolute inset-0 min-h-0 overflow-hidden", !isActive && "hidden")}
            >
              <UIRegion
                id="detailPanel.content"
                data={{ tab, panel: { id: panel.id, title: panel.title }, active: isActive }}
              >
                {panel.render(instance)}
              </UIRegion>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailPanelTabIcon({ iconUrl, fallback: Icon }: { iconUrl?: string; fallback: IconType }) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        data-detail-panel-tab-icon="favicon"
        className="h-[15px] w-[15px] shrink-0 rounded-[2px] object-contain"
        onError={() => setFailedUrl(iconUrl)}
      />
    );
  }
  return <Icon size={15} strokeWidth={1.8} className="shrink-0" />;
}

function detailTabTitle(
  panel: DetailPanelContribution,
  tab: DetailPanelInstance,
  tabs: DetailPanelInstance[],
  t: TranslateFn,
): string {
  if (tab.title) return tab.title;
  const panelTitle = localizedPanelTitle(panel, t);
  const samePanelCount = tabs.filter((item) => item.panelId === tab.panelId).length;
  if (!panel.allowMultiple || samePanelCount <= 1) return panelTitle;
  return `${panelTitle} ${tab.ordinal}`;
}

function localizedPanelTitle(panel: DetailPanelContribution, t: TranslateFn): string {
  if (panel.id === "terminal") return t("detailPanel.terminal");
  if (panel.id === "browser") return t("detailPanel.browser");
  if (panel.id === "ide") return t("detailPanel.ide");
  if (panel.id === "tasks-tests") return t("detailPanel.tasksTests");
  return panel.title;
}

function normalizeProjectRoot(value: string): string {
  return value.trim().replace(/[\\/]+$/, "");
}
