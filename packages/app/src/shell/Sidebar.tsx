import {
  CalendarClock,
  Check,
  ChevronDown,
  LogOut,
  Palette,
  Plus,
  Puzzle,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useShellStore, useSidebarPanels } from "@the-next-ai/app";
import { useUIStore } from "@/ui/ui-store";
import { useAuthStore } from "@/ui/auth-store";
import { useAspStore } from "@/asp/asp-store";
import { ProjectSwitcher, projectName } from "@/chat/ProjectSwitcher";
import { chatWorkspaceId, useChatStore } from "@/chat/chat-store";
import { useT } from "@/lib/i18n";
import { useProductConfig } from "@/product/product-config";
import { UIRegion } from "@/product/UIRegion";
import { confirmDialog } from "@/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { cn } from "@/ui/cn";
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_THEME_COLOR,
  isDefaultWorkspace,
  useWorkspaceStore,
  type WorkspaceConfig,
} from "@/workspaces/workspace-store";

const HIDDEN_SIDEBAR_PANEL_ACTION_IDS = new Set(["sessions", "agent-tools"]);

/**
 * The session sidebar — AGUI style: a "New session" action on top, the panel
 * body (the conversation list) in the middle, and Settings in a footer.
 * The left sidebar is intentionally dedicated to the session tree.
 */
export function Sidebar() {
  const panels = useSidebarPanels();
  const sessionsPanel = panels.find((panel) => panel.id === "sessions") ?? panels[0];
  const activePanelId = useShellStore((s) => s.activePanelId);
  const openSidebarPanel = useShellStore((s) => s.openSidebarPanel);
  const extensionsOpen = useUIStore((s) => s.extensionsOpen);
  const scheduleOpen = useUIStore((s) => s.scheduleOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [workspaceSettingsId, setWorkspaceSettingsId] = useState<string | null>(null);
  const pointerStartXRef = useRef<number | null>(null);
  const swipeHandledRef = useRef(false);
  const lastWheelSwitchAtRef = useRef(0);
  const t = useT();
  const productConfig = useProductConfig();
  const features = productConfig.features;
  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? sessionsPanel;
  const visiblePanelActions = panels.filter(
    (panel) => !HIDDEN_SIDEBAR_PANEL_ACTION_IDS.has(panel.id),
  );
  const switchSidebarPanel = (panelId: string) => {
    const ui = useUIStore.getState();
    ui.closeExtensions();
    ui.closeSchedule();
    ui.closeSettings();
    openSidebarPanel(panelId);
  };

  const newSession = () => {
    const ui = useUIStore.getState();
    const activeProject = ui.sidebarProjectNavItems[ui.sidebarProjectNavIndex];
    if (sessionsPanel) switchSidebarPanel(sessionsPanel.id);
    const chat = useChatStore.getState();
    chat.startDraftSession();
    chat.setDraftWorkspace(
      activeProject ? activeProject.projectPath : useAspStore.getState().workspacePath || null,
    );
  };
  const openPlugins = () => useUIStore.getState().openExtensions();
  const openScheduledTasks = () => useUIStore.getState().openSchedule();
  const addWorkspace = () => setWorkspaceDialogOpen(true);
  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!targetAllowsWorkspaceSwipe(event.target)) return;
    pointerStartXRef.current = event.clientX;
    swipeHandledRef.current = false;
  };
  const handleSidebarPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = pointerStartXRef.current;
    pointerStartXRef.current = null;
    if (startX === null || !targetAllowsWorkspaceSwipe(event.target)) return;
    const deltaX = event.clientX - startX;
    if (Math.abs(deltaX) < WORKSPACE_SWIPE_THRESHOLD_PX) return;
    if (!switchWorkspaceByOffset(deltaX < 0 ? 1 : -1)) return;
    swipeHandledRef.current = true;
    event.preventDefault();
    event.stopPropagation();
  };
  const handleSidebarWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!targetAllowsWorkspaceSwipe(event.target)) return;
    if (
      Math.abs(event.deltaX) < WORKSPACE_WHEEL_THRESHOLD_PX ||
      Math.abs(event.deltaX) < Math.abs(event.deltaY)
    )
      return;
    const now = Date.now();
    if (now - lastWheelSwitchAtRef.current < WORKSPACE_WHEEL_COOLDOWN_MS) return;
    if (!switchWorkspaceByOffset(event.deltaX > 0 ? 1 : -1)) return;
    lastWheelSwitchAtRef.current = now;
    event.preventDefault();
  };
  return (
    <div
      className="bg-sidebar flex h-full flex-col"
      onPointerDown={handleSidebarPointerDown}
      onPointerUp={handleSidebarPointerUp}
      onPointerCancel={() => {
        pointerStartXRef.current = null;
      }}
      onWheel={handleSidebarWheel}
      onClickCapture={(event) => {
        if (!swipeHandledRef.current) return;
        swipeHandledRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <UIRegion id="sidebar.titlebar">
        <div className="app-titlebar sidebar-app-titlebar electron-drag-region relative h-[var(--titlebar-height)] shrink-0">
          <div aria-hidden className="native-titlebar-click-slot shell-sidebar-native-click-slot" />
          <div
            aria-hidden
            className="native-titlebar-click-slot shell-sidebar-search-native-click-slot"
          />
        </div>
      </UIRegion>

      <UIRegion id="sidebar.projectSwitcher">
        <div className="px-2 pb-1">
          <ProjectSwitcher variant="sidebar" />
        </div>
      </UIRegion>

      {/* Primary menu */}
      <UIRegion id="sidebar.primaryActions">
        <div className="sidebar-primary-actions px-2 pb-1.5">
          <div className="flex flex-col gap-0.5">
            <UIRegion id="sidebar.action.newSession">
              <button type="button" onClick={newSession} className="ui-nav-row flex-1">
                <SquarePen size={15} strokeWidth={1.8} />
                {t("sidebar.newSession")}
              </button>
            </UIRegion>
            {visiblePanelActions.length > 0 ? (
              <UIRegion
                id="sidebar.registeredPanels"
                data={{
                  panels: visiblePanelActions.map((panel) => ({
                    id: panel.id,
                    title: panel.title,
                  })),
                }}
              >
                <div className="flex flex-col gap-0.5">
                  {visiblePanelActions.map((panel) => {
                    const Icon = panel.icon;
                    const active = panel.id === (activePanel?.id ?? sessionsPanel?.id);
                    return (
                      <button
                        key={panel.id}
                        type="button"
                        onClick={() => switchSidebarPanel(panel.id)}
                        aria-current={active ? "page" : undefined}
                        className="ui-nav-row flex-1"
                      >
                        <Icon size={15} strokeWidth={1.8} />
                        <span className="truncate">{panel.title}</span>
                      </button>
                    );
                  })}
                </div>
              </UIRegion>
            ) : null}
            {features.extensionsPage ? (
              <UIRegion id="sidebar.action.extensions">
                <button
                  type="button"
                  onClick={openPlugins}
                  aria-current={extensionsOpen ? "page" : undefined}
                  className="ui-nav-row flex-1"
                >
                  <Puzzle size={15} strokeWidth={1.8} />
                  {t("sidebar.plugins")}
                </button>
              </UIRegion>
            ) : null}
            {features.scheduledTasks ? (
              <UIRegion id="sidebar.action.schedule">
                <button
                  type="button"
                  onClick={openScheduledTasks}
                  aria-current={scheduleOpen ? "page" : undefined}
                  className="ui-nav-row flex-1"
                >
                  <CalendarClock size={15} strokeWidth={1.8} />
                  {t("sidebar.schedule")}
                </button>
              </UIRegion>
            ) : null}
          </div>
        </div>
      </UIRegion>

      {/* Conversation list */}
      <UIRegion id="sidebar.conversationList">
        <div className="min-h-0 flex-1 overflow-hidden">{activePanel?.render()}</div>
      </UIRegion>

      {/* Account */}
      <UIRegion id="sidebar.account">
        <AccountBar />
      </UIRegion>

      {/* Footer */}
      <UIRegion id="sidebar.footer">
        <div className="border-border-subtle flex items-center gap-1 border-t p-2">
          {features.settingsPage ? (
            <UIRegion id="sidebar.footer.settings">
              <button
                type="button"
                data-icon-button="true"
                onClick={() => useUIStore.getState().openSettings()}
                title={t("common.settings")}
                aria-label={t("common.settings")}
                aria-current={settingsOpen ? "page" : undefined}
                className="ui-icon-button shrink-0"
              >
                <Settings size={16} strokeWidth={1.8} />
              </button>
            </UIRegion>
          ) : null}
          <UIRegion id="sidebar.footer.workspaceIndicator">
            <WorkspaceIndicator onOpenManage={() => setWorkspaceManagerOpen(true)} />
          </UIRegion>
          {features.sidebarAddConversation ? (
            <UIRegion id="sidebar.footer.addWorkspace">
              <button
                type="button"
                data-icon-button="true"
                onClick={addWorkspace}
                title={t("sidebar.addWorkspace")}
                aria-label={t("sidebar.addWorkspace")}
                className="ui-icon-button shrink-0"
              >
                <Plus size={17} strokeWidth={1.8} />
              </button>
            </UIRegion>
          ) : null}
        </div>
      </UIRegion>
      <WorkspaceManagerDialog
        open={workspaceManagerOpen}
        onOpenChange={setWorkspaceManagerOpen}
        onCreateWorkspace={() => {
          setWorkspaceManagerOpen(false);
          setWorkspaceDialogOpen(true);
        }}
        onEditWorkspace={(id) => {
          setWorkspaceManagerOpen(false);
          setWorkspaceSettingsId(id);
        }}
      />
      <WorkspaceSettingsDialog
        workspaceId={workspaceSettingsId}
        open={workspaceSettingsId !== null}
        onOpenChange={(open) => {
          if (!open) setWorkspaceSettingsId(null);
        }}
      />
      <CreateWorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} />
    </div>
  );
}

type WorkspaceDraft = {
  color: string;
  name: string;
  providerId: string;
};

const WORKSPACE_COLOR_OPTIONS = [
  { color: DEFAULT_WORKSPACE_THEME_COLOR, label: "Default" },
  { color: "#3b82f6", label: "Blue" },
  { color: "#14b8a6", label: "Teal" },
  { color: "#22c55e", label: "Green" },
  { color: "#eab308", label: "Yellow" },
  { color: "#f97316", label: "Orange" },
  { color: "#ef4444", label: "Red" },
  { color: "#a855f7", label: "Violet" },
  { color: "#64748b", label: "Slate" },
];

function WorkspaceColorField({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  const t = useT();
  const customColorSelected = isCustomWorkspaceColor(color);

  return (
    <WorkspaceFormField label={t("workspace.color")}>
      <div className="flex flex-wrap gap-2">
        {WORKSPACE_COLOR_OPTIONS.map((option) => (
          <button
            key={option.color}
            type="button"
            title={option.label}
            aria-label={option.label}
            aria-pressed={color === option.color}
            onClick={() => onChange(option.color)}
            className={cn("h-8 w-8 rounded-md border transition-[border-color,box-shadow]", {
              "border-fg shadow-[0_0_0_2px_color-mix(in_srgb,var(--fg-primary)_18%,transparent)]":
                color === option.color,
              "border-border hover:border-border-strong": color !== option.color,
            })}
            style={workspaceColorPreviewStyle(option.color)}
          />
        ))}
        <label
          title={t("workspace.customColor")}
          className={cn(
            "relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-md border transition-[border-color,box-shadow] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]",
            customColorSelected
              ? "border-fg shadow-[0_0_0_2px_color-mix(in_srgb,var(--fg-primary)_18%,transparent)]"
              : "border-border hover:border-border-strong",
          )}
          style={workspaceCustomColorPreviewStyle(color)}
        >
          <Palette
            aria-hidden="true"
            size={15}
            className={cn("drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]", {
              "text-white": customColorSelected,
              "text-fg": !customColorSelected,
            })}
          />
          <input
            type="color"
            aria-label={t("workspace.customColor")}
            value={workspaceColorPickerValue(color)}
            onChange={(event) => onChange(event.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      </div>
    </WorkspaceFormField>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const providers = useAspStore((state) => state.providers);
  const activeProviderId = useAspStore((state) => state.activeProviderId);
  const defaultColor = WORKSPACE_COLOR_OPTIONS[0].color;
  const [draft, setDraft] = useState<WorkspaceDraft>({
    color: defaultColor,
    name: "",
    providerId: activeProviderId,
  });
  const [error, setError] = useState("");
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const selectedProviderId = enabledProviders.some((provider) => provider.id === draft.providerId)
    ? draft.providerId
    : "";

  useEffect(() => {
    if (!open) return;
    setDraft({
      color: defaultColor,
      name: "",
      providerId: activeProviderId,
    });
    setError("");
  }, [activeProviderId, defaultColor, open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setError(t("workspace.nameRequired"));
      return;
    }
    useWorkspaceStore.getState().addWorkspace({
      color: draft.color,
      name,
      projectPath: null,
      providerId: selectedProviderId || undefined,
    });
    syncSidebarProjectToWorkspace(useWorkspaceStore.getState().activeWorkspace());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspace.createTitle")}</DialogTitle>
          <DialogDescription>{t("workspace.createDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="mt-5 grid gap-4">
          <WorkspaceFormField label={t("workspace.name")}>
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
                if (error) setError("");
              }}
              placeholder={t("workspace.namePlaceholder")}
              className="ui-field text-[13.5px]"
            />
          </WorkspaceFormField>

          <WorkspaceColorField
            color={draft.color}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
          />

          <WorkspaceFormField label={t("workspace.defaultAgent")}>
            <div className="relative">
              <select
                value={selectedProviderId}
                disabled={enabledProviders.length === 0}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, providerId: event.target.value }))
                }
                className="ui-field appearance-none pr-8 text-[13.5px] disabled:opacity-60"
              >
                {enabledProviders.length === 0 ? (
                  <option value="">{t("settings.agents.noAgents")}</option>
                ) : null}
                {enabledProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={15}
                className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
              />
            </div>
          </WorkspaceFormField>

          {error ? <div className="text-danger text-[12px]">{error}</div> : null}

          <DialogFooter className="mt-1">
            <button type="button" onClick={() => onOpenChange(false)} className="ui-button">
              {t("common.cancel")}
            </button>
            <button type="submit" className="ui-button ui-button-primary">
              {t("common.create")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceManagerDialog({
  open,
  onCreateWorkspace,
  onEditWorkspace,
  onOpenChange,
}: {
  open: boolean;
  onCreateWorkspace: () => void;
  onEditWorkspace: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const providers = useAspStore((state) => state.providers);
  const normalizedWorkspaces = workspaces.length ? workspaces : [FALLBACK_WORKSPACE];

  const switchWorkspace = (workspace: WorkspaceConfig) => {
    useWorkspaceStore.getState().switchWorkspace(workspace.id);
    syncSidebarProjectToWorkspace(workspace);
    onOpenChange(false);
  };

  const deleteWorkspace = async (workspace: WorkspaceConfig) => {
    if (isDefaultWorkspace(workspace)) return;
    const label = workspaceDisplayLabel(workspace, t);
    const confirmed = await confirmDialog({
      title: t("workspace.deleteTitle"),
      description: t("workspace.deleteConfirm", { name: label }),
      confirmLabel: t("common.delete"),
      tone: "danger",
    });
    if (!confirmed) return;
    moveChatItemsToWorkspace(workspace.id, DEFAULT_WORKSPACE_ID);
    useWorkspaceStore.getState().removeWorkspace(workspace.id);
    syncSidebarProjectToWorkspace(useWorkspaceStore.getState().activeWorkspace());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspace.manageTitle")}</DialogTitle>
          <DialogDescription>{t("workspace.manageDescription")}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 flex max-h-[min(28rem,70vh)] flex-col gap-2 overflow-auto">
          {normalizedWorkspaces.map((workspace) => {
            const active = chatWorkspaceId(workspace.id) === chatWorkspaceId(activeWorkspaceId);
            const canDelete = !isDefaultWorkspace(workspace);
            const providerName = workspace.providerId
              ? providers.find((provider) => provider.id === workspace.providerId)?.name
              : undefined;
            return (
              <div
                key={workspace.id}
                className={cn(
                  "border-border-subtle flex min-w-0 items-center gap-2 rounded-md border px-2 py-2",
                  active && "bg-surface",
                )}
              >
                <button
                  type="button"
                  onClick={() => switchWorkspace(workspace)}
                  aria-current={active ? "page" : undefined}
                  className="hover:bg-surface-hover flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                    style={workspaceColorPreviewStyle(workspace.color || FALLBACK_WORKSPACE.color)}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-fg flex items-center gap-1.5 text-[13px] font-medium">
                      <span className="truncate">{workspaceDisplayLabel(workspace, t)}</span>
                      {active ? (
                        <Check size={13} className="text-success shrink-0" aria-hidden />
                      ) : null}
                    </span>
                    <span className="text-subtle mt-0.5 block truncate text-[11.5px]">
                      {workspaceSubtitle(workspace, providerName, t)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  data-icon-button="true"
                  onClick={() => onEditWorkspace(workspace.id)}
                  title={t("workspace.settings")}
                  aria-label={t("workspace.settings")}
                  className="ui-icon-button h-8 w-8 shrink-0 rounded-md"
                >
                  <Settings size={14} />
                </button>
                <button
                  type="button"
                  data-icon-button="true"
                  disabled={!canDelete}
                  onClick={() => void deleteWorkspace(workspace)}
                  title={
                    canDelete ? t("workspace.delete") : t("workspace.deleteDefaultUnavailable")
                  }
                  aria-label={
                    canDelete ? t("workspace.delete") : t("workspace.deleteDefaultUnavailable")
                  }
                  className="ui-icon-button hover:text-danger h-8 w-8 shrink-0 rounded-md disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onCreateWorkspace();
            }}
            className="ui-button"
          >
            <Plus size={14} />
            {t("sidebar.addWorkspace")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceSettingsDialog({
  open,
  workspaceId,
  onOpenChange,
}: {
  open: boolean;
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((item) => item.id === workspaceId),
  );
  const providers = useAspStore((state) => state.providers);
  const defaultColor = WORKSPACE_COLOR_OPTIONS[0].color;
  const [draft, setDraft] = useState<WorkspaceDraft>({
    color: defaultColor,
    name: "",
    providerId: "",
  });
  const [error, setError] = useState("");
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const defaultWorkspace = workspace ? isDefaultWorkspace(workspace) : false;
  const selectedProviderId = enabledProviders.some((provider) => provider.id === draft.providerId)
    ? draft.providerId
    : "";

  useEffect(() => {
    if (!open || !workspace) return;
    setDraft({
      color: workspace.color || defaultColor,
      name: workspace.name,
      providerId: workspace.providerId || "",
    });
    setError("");
  }, [defaultColor, open, workspace]);

  if (!workspace) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = defaultWorkspace ? workspace.name : draft.name.trim();
    if (!defaultWorkspace && !name) {
      setError(t("workspace.nameRequired"));
      return;
    }
    useWorkspaceStore.getState().updateWorkspace(workspace.id, {
      color: draft.color,
      name,
      providerId: selectedProviderId || undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspace.settingsTitle")}</DialogTitle>
          <DialogDescription>{t("workspace.settingsDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="mt-5 grid gap-4">
          <WorkspaceFormField label={t("workspace.name")}>
            <input
              autoFocus={!defaultWorkspace}
              disabled={defaultWorkspace}
              value={defaultWorkspace ? t("workspace.default") : draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
                if (error) setError("");
              }}
              placeholder={t("workspace.namePlaceholder")}
              className="ui-field text-[13.5px] disabled:opacity-60"
            />
          </WorkspaceFormField>

          <WorkspaceColorField
            color={draft.color}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
          />

          <WorkspaceFormField label={t("workspace.defaultAgent")}>
            <div className="relative">
              <select
                value={selectedProviderId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, providerId: event.target.value }))
                }
                className="ui-field appearance-none pr-8 text-[13.5px]"
              >
                <option value="">{t("runSettings.noAgent")}</option>
                {enabledProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={15}
                className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
              />
            </div>
          </WorkspaceFormField>

          {error ? <div className="text-danger text-[12px]">{error}</div> : null}

          <DialogFooter className="mt-1">
            <button type="button" onClick={() => onOpenChange(false)} className="ui-button">
              {t("common.cancel")}
            </button>
            <button type="submit" className="ui-button ui-button-primary">
              {t("common.save")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceFormField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-muted text-[12px] font-medium">{label}</span>
      {children}
    </label>
  );
}

function WorkspaceIndicator({ onOpenManage }: { onOpenManage: () => void }) {
  const t = useT();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
      state.workspaces[0],
  );
  const pointerStartXRef = useRef<number | null>(null);
  const swipeHandledRef = useRef(false);
  const lastWheelSwitchAtRef = useRef(0);
  const displayWorkspace = activeWorkspace ?? FALLBACK_WORKSPACE;
  const normalizedWorkspaces = workspaces.length ? workspaces : [displayWorkspace];
  const activeIndex = Math.max(
    0,
    normalizedWorkspaces.findIndex((workspace) => workspace.id === activeWorkspaceId),
  );
  const canSwitch = normalizedWorkspaces.length > 1;
  const label = workspaceDisplayLabel(displayWorkspace, t);

  const switchByOffset = (offset: number) => {
    switchWorkspaceByOffset(offset);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const startX = pointerStartXRef.current;
    pointerStartXRef.current = null;
    if (startX === null || !canSwitch) return;
    const deltaX = event.clientX - startX;
    if (Math.abs(deltaX) < WORKSPACE_SWIPE_THRESHOLD_PX) return;
    swipeHandledRef.current = true;
    switchByOffset(deltaX < 0 ? 1 : -1);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLButtonElement>) => {
    if (
      !canSwitch ||
      Math.abs(event.deltaX) < WORKSPACE_WHEEL_THRESHOLD_PX ||
      Math.abs(event.deltaX) < Math.abs(event.deltaY)
    )
      return;
    const now = Date.now();
    if (now - lastWheelSwitchAtRef.current < WORKSPACE_WHEEL_COOLDOWN_MS) return;
    lastWheelSwitchAtRef.current = now;
    event.preventDefault();
    switchByOffset(event.deltaX > 0 ? 1 : -1);
  };

  return (
    <button
      type="button"
      title={t("workspace.manageIndicator", {
        current: String(activeIndex + 1),
        total: String(normalizedWorkspaces.length),
        workspace: label,
      })}
      aria-label={t("workspace.manageIndicator", {
        current: String(activeIndex + 1),
        total: String(normalizedWorkspaces.length),
        workspace: label,
      })}
      onPointerDown={(event) => {
        pointerStartXRef.current = event.clientX;
        swipeHandledRef.current = false;
      }}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pointerStartXRef.current = null;
      }}
      onWheel={handleWheel}
      onClick={(event) => {
        if (swipeHandledRef.current) {
          event.preventDefault();
          event.stopPropagation();
          swipeHandledRef.current = false;
          return;
        }
        onOpenManage();
      }}
      className="text-muted hover:bg-surface-hover hover:text-fg flex h-8 min-w-0 flex-1 touch-pan-y items-center justify-center rounded-md px-2 transition-colors outline-none focus:outline-none focus-visible:outline-none"
    >
      <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
        {normalizedWorkspaces.map((workspace, index) => (
          <span
            key={workspace.id}
            className={cn(
              "rounded-full transition-[background-color,opacity,transform]",
              index === activeIndex ? "h-2 w-2 opacity-100" : "h-1.5 w-1.5 opacity-45",
            )}
            style={workspaceIndicatorColorStyle(workspace.color || FALLBACK_WORKSPACE.color)}
          />
        ))}
      </span>
    </button>
  );
}

const FALLBACK_WORKSPACE: WorkspaceConfig = {
  id: "default",
  name: "Default workspace",
  color: DEFAULT_WORKSPACE_THEME_COLOR,
  projectPath: null,
  disabledMcpServers: [],
  disabledSkills: [],
  disabledPrompts: [],
  selectedPrompts: [],
  createdAt: 0,
  updatedAt: 0,
};

const DEFAULT_WORKSPACE_PREVIEW_BACKGROUND =
  "linear-gradient(135deg, #ffffff 0%, #ffffff 56%, #f5f6f8 56%, #f5f6f8 100%)";
const DEFAULT_WORKSPACE_INDICATOR_COLOR = "#8d9096";
const CUSTOM_WORKSPACE_COLOR_PREVIEW_BACKGROUND =
  "conic-gradient(from 90deg, #ef4444, #f97316, #eab308, #22c55e, #14b8a6, #3b82f6, #a855f7, #ef4444)";

function workspaceColorPreviewStyle(color: string): CSSProperties {
  return color === DEFAULT_WORKSPACE_THEME_COLOR
    ? { background: DEFAULT_WORKSPACE_PREVIEW_BACKGROUND }
    : { backgroundColor: color };
}

function workspaceIndicatorColorStyle(color: string): CSSProperties {
  return {
    backgroundColor:
      color === DEFAULT_WORKSPACE_THEME_COLOR ? DEFAULT_WORKSPACE_INDICATOR_COLOR : color,
  };
}

function workspaceCustomColorPreviewStyle(color: string): CSSProperties {
  return isCustomWorkspaceColor(color)
    ? { backgroundColor: color }
    : { background: CUSTOM_WORKSPACE_COLOR_PREVIEW_BACKGROUND };
}

function workspaceColorPickerValue(color: string): string {
  return isHexWorkspaceColor(color) ? color : "#3b82f6";
}

function isCustomWorkspaceColor(color: string): boolean {
  if (!isHexWorkspaceColor(color)) return false;
  const normalized = color.toLowerCase();
  return !WORKSPACE_COLOR_OPTIONS.some((option) => option.color.toLowerCase() === normalized);
}

function isHexWorkspaceColor(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

const WORKSPACE_SWIPE_THRESHOLD_PX = 36;
const WORKSPACE_WHEEL_THRESHOLD_PX = 24;
const WORKSPACE_WHEEL_COOLDOWN_MS = 450;
const WORKSPACE_SWIPE_EXCLUDED_TARGETS = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='menuitem']",
  "[data-sidebar-tree-item='true']",
  "[data-no-workspace-swipe='true']",
  ".electron-drag-region",
].join(",");

function workspaceDisplayLabel(workspace: WorkspaceConfig, t: ReturnType<typeof useT>): string {
  if (isDefaultWorkspace(workspace)) return t("workspace.default");
  return (
    workspace.name || (workspace.projectPath ? projectName(workspace.projectPath) : "Workspace")
  );
}

function workspaceSubtitle(
  workspace: WorkspaceConfig,
  providerName: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  return [workspace.projectPath || t("common.noProject"), providerName].filter(Boolean).join(" · ");
}

function switchWorkspaceByOffset(offset: number): boolean {
  const store = useWorkspaceStore.getState();
  const workspaces = store.workspaces;
  if (workspaces.length <= 1) return false;
  const activeIndex = Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.id === store.activeWorkspaceId),
  );
  const next = workspaces[(activeIndex + offset + workspaces.length) % workspaces.length];
  if (!next) return false;
  store.switchWorkspace(next.id);
  syncSidebarProjectToWorkspace(next);
  return true;
}

function moveChatItemsToWorkspace(sourceWorkspaceId: string, targetWorkspaceId: string): void {
  const sourceId = chatWorkspaceId(sourceWorkspaceId);
  const targetId = chatWorkspaceId(targetWorkspaceId);
  if (sourceId === targetId) return;
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      chatWorkspaceId(session.workspaceId) === sourceId
        ? { ...session, workspaceId: targetId }
        : session,
    ),
    sessionProjects: mergeSessionProjects(
      state.sessionProjects.map((project) =>
        chatWorkspaceId(project.workspaceId) === sourceId
          ? { ...project, workspaceId: targetId }
          : project,
      ),
    ),
    sessionFolders: state.sessionFolders.map((folder) =>
      chatWorkspaceId(folder.workspaceId) === sourceId
        ? { ...folder, workspaceId: targetId }
        : folder,
    ),
    draftSession:
      state.draftSession && chatWorkspaceId(state.draftSession.workspaceId) === sourceId
        ? { ...state.draftSession, workspaceId: targetId }
        : state.draftSession,
  }));
}

function mergeSessionProjects(
  projects: ReturnType<typeof useChatStore.getState>["sessionProjects"],
): ReturnType<typeof useChatStore.getState>["sessionProjects"] {
  const merged = new Map<string, (typeof projects)[number]>();
  for (const project of projects) {
    const key = `${chatWorkspaceId(project.workspaceId)}:${project.key}`;
    const existing = merged.get(key);
    if (!existing || project.createdAt < existing.createdAt) merged.set(key, project);
  }
  return [...merged.values()];
}

function targetAllowsWorkspaceSwipe(target: EventTarget): boolean {
  return target instanceof Element && !target.closest(WORKSPACE_SWIPE_EXCLUDED_TARGETS);
}

function syncSidebarProjectToWorkspace(workspace: WorkspaceConfig): void {
  const projectPath = workspace.projectPath;
  const projectKey = projectPath ? `project:${normalizeProjectPath(projectPath)}` : "private";
  const selectProject = () => {
    const ui = useUIStore.getState();
    const chat = useChatStore.getState();
    const index = ui.sidebarProjectNavItems.findIndex((item) => item.key === projectKey);
    if (index >= 0) ui.setSidebarProjectNavIndex(index);
    const activeSession = chat.sessions.find((session) => session.id === chat.activeSessionId);
    if (
      activeSession &&
      chatWorkspaceId(activeSession.workspaceId) !== chatWorkspaceId(workspace.id)
    ) {
      chat.startDraftSession();
    }
    if (!useChatStore.getState().activeSessionId) {
      useChatStore.getState().setDraftWorkspace(projectPath ?? null);
    }
  };
  selectProject();
  window.requestAnimationFrame(selectProject);
}

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/[\\/]+$/, "");
}

/** Account bar — shown only once signed in. */
function AccountBar() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const t = useT();

  if (!user) return null;

  return (
    <div className="border-border-subtle flex items-center gap-2 border-t px-2 py-1.5">
      <div className="bg-accent text-accent-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold">
        {user.name.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-fg truncate text-[13px]">{user.name}</div>
        <div className="text-subtle truncate text-[11px]">{user.plan}</div>
      </div>
      <button
        type="button"
        title={t("auth.signOut")}
        aria-label={t("auth.signOut")}
        onClick={signOut}
        className="ui-icon-button h-7 w-7 rounded-md"
      >
        <LogOut size={15} />
      </button>
    </div>
  );
}
