import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  Code2,
  FileSearch,
  GitBranch,
  Globe,
  MessageSquare,
  Loader2,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal as TerminalIcon,
  TestTube2,
  Zap,
} from "lucide-react";
import type { Extension } from "@agui/app";
import { useShellStore } from "@agui/app";
import { useChatStore } from "@/chat/chat-store";
import { selectAgentHandoff } from "@/chat/agent-handoff";
import {
  supportedReasoningEffortsForModel,
  supportedSpeedsForModel,
} from "@/chat/chat-run-helpers";
import { useUIStore } from "@/ui/ui-store";
import { useI18nStore, useT } from "@/lib/i18n";
import { cn } from "@/ui/cn";
import { toast } from "@/ui/toast";
import type { ApprovalMode, Session } from "@/chat/types";
import type { AspModel, AspProvider, AspRunSpeed } from "@/asp/desktop-api";
import { APPROVAL_MODES, approvalModeLabelKeyForAgent } from "@/asp/agent-approval-modes";
import { AgentLogo } from "@/asp/AgentLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import { SessionsPanel } from "@/panels/SessionsPanel";
import { useAspStore } from "@/asp/asp-store";

const LazyTerminalPanel = lazy(() =>
  import("@/panels/TerminalBrowserPanels").then((module) => ({ default: module.TerminalPanel })),
);
const LazyBrowserPanel = lazy(() =>
  import("@/panels/TerminalBrowserPanels").then((module) => ({ default: module.BrowserPanel })),
);
const LazyIdePanel = lazy(() =>
  import("@/panels/IdePanel").then((module) => ({ default: module.IdePanel })),
);
const LazySourceControlPanel = lazy(() =>
  import("@/panels/EcosystemPanels").then((module) => ({
    default: module.SourceControlPanel,
  })),
);
const LazyWorkspaceSearchPanel = lazy(() =>
  import("@/panels/EcosystemPanels").then((module) => ({
    default: module.WorkspaceSearchPanel,
  })),
);
const LazyTasksTestsPanel = lazy(() =>
  import("@/panels/EcosystemPanels").then((module) => ({ default: module.TasksTestsPanel })),
);
const LazyPreviewHubPanel = lazy(() =>
  import("@/panels/EcosystemPanels").then((module) => ({ default: module.PreviewHubPanel })),
);
const LazyAgentControlPanel = lazy(() =>
  import("@/panels/EcosystemPanels").then((module) => ({
    default: module.AgentControlPanel,
  })),
);
const LazyMcpPanel = lazy(() =>
  import("@/panels/McpPanel").then((module) => ({ default: module.McpPanel })),
);

/** First-party features deliberately use the same disposable registry contract
 * exposed to app extensions. Keeping each feature independently activated makes
 * contribution ownership visible and prevents the built-in Core from becoming
 * a second, privileged plugin system. */
export const builtinExtensions: Extension[] = [
  {
    id: "agui.sessions",
    name: "Sessions",
    activate: (ctx) =>
      void ctx.registerSidebarPanel({
        id: "sessions",
        title: "Sessions",
        icon: MessageSquare,
        render: () => <SessionsPanel />,
        order: 1,
      }),
  },
  {
    id: "agui.terminal",
    name: "Terminal",
    activate: (ctx) =>
      void ctx.registerDetailPanel({
        id: "terminal",
        title: "Terminal",
        icon: TerminalIcon,
        allowMultiple: true,
        render: (instance) => (
          <DeferredPanel>
            <LazyTerminalPanel instance={instance} />
          </DeferredPanel>
        ),
        order: 1,
      }),
  },
  {
    id: "agui.browser",
    name: "Browser",
    activate: (ctx) =>
      void ctx.registerDetailPanel({
        id: "browser",
        title: "Browser",
        icon: Globe,
        allowMultiple: true,
        retainContextWhenHidden: true,
        render: (instance) => (
          <DeferredPanel>
            <LazyBrowserPanel instance={instance} />
          </DeferredPanel>
        ),
        order: 2,
      }),
  },
  {
    id: "agui.ide",
    name: "IDE",
    activate: (ctx) =>
      void ctx.registerDetailPanel({
        id: "ide",
        title: "IDE",
        icon: Code2,
        allowMultiple: true,
        render: () => (
          <DeferredPanel>
            <LazyIdePanel />
          </DeferredPanel>
        ),
        order: 3,
      }),
  },
  {
    id: "agui.tasks-tests",
    name: "Workspace Ecosystem",
    activate: (ctx) => {
      ctx.registerDetailPanel({
        id: "source-control",
        title: "Source Control",
        icon: GitBranch,
        render: () => (
          <DeferredPanel>
            <LazySourceControlPanel />
          </DeferredPanel>
        ),
        order: 4,
      });
      ctx.registerDetailPanel({
        id: "workspace-search",
        title: "Workspace Search",
        icon: FileSearch,
        render: () => (
          <DeferredPanel>
            <LazyWorkspaceSearchPanel />
          </DeferredPanel>
        ),
        order: 5,
      });
      ctx.registerDetailPanel({
        id: "tasks-tests",
        title: "Tasks & Tests",
        icon: TestTube2,
        render: () => (
          <DeferredPanel>
            <LazyTasksTestsPanel />
          </DeferredPanel>
        ),
        order: 6,
      });
      ctx.registerDetailPanel({
        id: "preview",
        title: "Preview",
        icon: Search,
        render: () => (
          <DeferredPanel>
            <LazyPreviewHubPanel />
          </DeferredPanel>
        ),
        order: 7,
      });
      ctx.registerDetailPanel({
        id: "agent-control",
        title: "Agent Control",
        icon: Bot,
        render: () => (
          <DeferredPanel>
            <LazyAgentControlPanel />
          </DeferredPanel>
        ),
        order: 8,
      });
      ctx.registerDetailPanel({
        id: "agent-tools",
        title: "Agent Tools",
        icon: Zap,
        render: () => (
          <DeferredPanel>
            <LazyMcpPanel />
          </DeferredPanel>
        ),
        order: 9,
      });
    },
  },
  {
    id: "agui.renderers",
    name: "Core Renderers",
    activate: (ctx) =>
      void ctx.registerBlockRenderer({
        id: "agui.card-renderer",
        kind: ["raw", "resource", "artifact"],
        renderer: ["agui.card", "custom-card"],
        priority: 10,
        render: (block) => <CustomCardRenderer block={block} />,
      }),
  },
  {
    id: "agui.composer",
    name: "Composer Controls",
    activate: (ctx) => {
      ctx.registerComposerControl({
        id: "run-settings",
        align: "left",
        render: () => <RunSettingsPicker />,
      });
      ctx.registerComposerControl({
        id: "approval",
        align: "left",
        render: () => <ApprovalModePicker />,
      });
    },
  },
  {
    id: "agui.commands",
    name: "Core Commands",
    activate: (ctx) => {
      ctx.registerCommand({
        id: "chat.newSession",
        title: "New Chat",
        icon: Plus,
        handler: () => {
          const ui = useUIStore.getState();
          ui.closeExtensions();
          ui.closeSchedule();
          useChatStore.getState().startDraftSession();
          useShellStore.getState().openSidebarPanel("sessions");
        },
      });
      ctx.registerCommand({
        id: "agentTools.open",
        title: "Open Agent Tools",
        category: "Agent",
        icon: Zap,
        handler: () => {
          const ui = useUIStore.getState();
          ui.closeExtensions();
          ui.closeSchedule();
          ui.closeSettings();
          useShellStore.getState().openDetailPanel("agent-tools");
        },
      });
      ctx.registerCommand({
        id: "sidebar.toggle",
        title: "Toggle Sidebar",
        keybinding: "⌘B",
        handler: () => useShellStore.getState().toggleSidebar(),
      });
      ctx.registerCommand({
        id: "detailPanel.toggle",
        title: "Toggle Detail Panel",
        keybinding: "⌘J",
        handler: () => useShellStore.getState().toggleDetailPanel(),
      });
      ctx.registerCommand({
        id: "sidePanel.terminal",
        title: "Open Terminal",
        category: "Side Panel",
        icon: TerminalIcon,
        handler: () => useShellStore.getState().createDetailPanelTab("terminal"),
      });
      ctx.registerCommand({
        id: "sidePanel.browser",
        title: "Open Browser",
        category: "Side Panel",
        icon: Globe,
        handler: () => useShellStore.getState().createDetailPanelTab("browser"),
      });
      ctx.registerCommand({
        id: "sidePanel.ide",
        title: "Open IDE",
        category: "Side Panel",
        icon: Code2,
        handler: () => useShellStore.getState().createDetailPanelTab("ide"),
      });
      for (const command of [
        ["sidePanel.sourceControl", "Open Source Control", "source-control"],
        ["sidePanel.workspaceSearch", "Open Workspace Search", "workspace-search"],
        ["sidePanel.tasksTests", "Open Tasks & Tests", "tasks-tests"],
        ["sidePanel.preview", "Open Preview", "preview"],
        ["sidePanel.agentControl", "Open Agent Control", "agent-control"],
      ] as const) {
        ctx.registerCommand({
          id: command[0],
          title: command[1],
          category: "Side Panel",
          handler: () => useShellStore.getState().openDetailPanel(command[2]),
        });
      }
      ctx.registerCommand({
        id: "find.toggle",
        title: "Find in Conversation",
        keybinding: "⌘F",
        handler: () => {
          const s = useUIStore.getState();
          s.setFindOpen(!s.findOpen);
        },
      });
      ctx.registerCommand({
        id: "searchChats",
        title: "Search Chats",
        icon: Search,
        handler: () => useUIStore.getState().setSearchChatsOpen(true),
      });
      ctx.registerCommand({
        id: "settings.open",
        title: "Open Settings",
        icon: SettingsIcon,
        keybinding: "⌘,",
        handler: () => useUIStore.getState().openSettings(),
      });
      ctx.registerCommand({
        id: "theme.toggle",
        title: "Toggle Theme",
        handler: () => useUIStore.getState().toggleTheme(),
      });
      ctx.registerCommand({
        id: "commandPalette.open",
        title: "Command Palette",
        keybinding: "⌘K",
        hidden: true,
        handler: () => useUIStore.getState().openPalette(),
      });
    },
  },
];

function DeferredPanel({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="text-subtle flex h-full items-center justify-center">
          <Loader2 size={15} className="animate-spin" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function CustomCardRenderer({ block }: { block: unknown }) {
  const t = useT();
  const source = objectValue(block);
  const metadata = objectValue(source.metadata);
  const value = objectValue(source.value);
  const title =
    stringValue(metadata.title) ||
    stringValue(value.title) ||
    stringValue(source.title) ||
    stringValue(source.label) ||
    t("plugin.customComponent");
  const body =
    stringValue(metadata.body) ||
    stringValue(value.body) ||
    stringValue(value.text) ||
    stringValue(source.content) ||
    formatCustomValue(source.value);
  const accent = stringValue(metadata.accent) || "info";

  return (
    <div
      data-plugin-chat-renderer="agui.card"
      className="border-border-subtle bg-surface/60 overflow-hidden rounded-md border"
    >
      <div className="border-border-subtle flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-[12px]">
        <Code2 size={13} className={cn("shrink-0", accentClass(accent))} />
        <span className="bg-surface-hover text-subtle rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
          {t("plugin.badge")}
        </span>
        <span className="text-fg min-w-0 flex-1 truncate font-medium">{title}</span>
      </div>
      <div className="text-muted px-3 py-2 text-[13px] leading-6">{body}</div>
    </div>
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatCustomValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function accentClass(accent: string): string {
  if (accent === "success") return "text-success";
  if (accent === "warning") return "text-warning";
  if (accent === "danger") return "text-danger";
  if (accent === "accent") return "text-accent";
  return "text-info";
}

/* -------------------------------------------------------------------------- */
/* Composer controls                                                           */
/* -------------------------------------------------------------------------- */

const COMPOSER_DROPDOWN_TRIGGER_CLASS =
  "flex shrink-0 items-center whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-muted transition-colors outline-none hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:outline-none data-[state=open]:bg-surface-active data-[state=open]:text-fg";

function RunSettingsPicker() {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const allProviders = useAspStore((state) => state.providers);
  const providers = allProviders.filter((provider) => provider.enabled);
  const preferredProvider = useAspStore((state) => state.activeProviderId);
  const setPreferredProvider = useAspStore((state) => state.setActiveProvider);
  const refreshProviderCapabilities = useAspStore((state) => state.refreshProviderCapabilities);
  const checkProviderAvailability = useAspStore((state) => state.checkProviderAvailability);
  const [checkingProviderId, setCheckingProviderId] = useState("");
  const [loadingModelKeys, setLoadingModelKeys] = useState<Set<string>>(() => new Set());
  const providerCheckRequestRef = useRef(0);
  const modelRefreshAttempts = useRef(new Set<string>());
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const draftProviderId = useChatStore((state) => state.draftSession?.providerId);
  const activeSession = useChatStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const sessionProviderId = activeSession?.providerId;
  const sessionStreaming = activeSession?.status === "streaming";
  const sessionAgentIds = useChatStore((state) => {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    if (!session) return "";
    const ids = Object.entries(session.agentSessions ?? {})
      .filter(([, route]) => route.status !== "never_used" || route.providerSessionId)
      .map(([providerId]) => providerId);
    if (session.blocks.some((block) => block.agentProviderId === session.providerId)) {
      ids.push(session.providerId);
    }
    return [...new Set(ids)].sort().join("\0");
  });
  const usedProviderIds = new Set(sessionAgentIds ? sessionAgentIds.split("\0") : []);
  const providerId = sessionProviderId || draftProviderId || preferredProvider;
  const provider = providers.find((item) => item.id === providerId);
  const projectPath = composerProjectPathForAgentSwitch();
  const capabilityCwd = composerCapabilityCwdForAgentSwitch();
  const model = useUIStore((state) => state.model);
  const setModel = useUIStore((state) => state.setModel);
  const effort = useUIStore((state) => state.effort);
  const setEffort = useUIStore((state) => state.setEffort);
  const speed = useUIStore((state) => state.speed);
  const setSpeed = useUIStore((state) => state.setSpeed);
  const modelRefreshKey = provider ? `${provider.id}\0${capabilityCwd ?? ""}` : "";
  const modelListLoading = Boolean(modelRefreshKey && loadingModelKeys.has(modelRefreshKey));
  const models = (provider?.models ?? []).filter((item) => !item.hidden);
  const selectedModel =
    models.find((item) => item.model === model) ??
    models.find((item) => item.isDefault) ??
    models[0];
  const efforts = optionList<string>(
    supportedReasoningEffortsForModel(
      provider?.models,
      provider?.capabilities,
      selectedModel?.model,
    ),
  );
  const selectedEffort = efforts.includes(effort)
    ? effort
    : selectedModel?.defaultReasoningEffort || efforts[0];
  const speeds = optionList(
    supportedSpeedsForModel(provider?.models, provider?.capabilities, selectedModel?.model),
  );
  const selectedSpeed = speeds.includes(speed) ? speed : (speeds[0] ?? "default");

  useEffect(() => {
    if (!provider || provider.capabilities?.models === false) return;
    const visibleModels = (provider.models ?? []).filter((item) => !item.hidden);
    if (visibleModels.length && !isClaudeCodeRunProvider(provider)) return;
    const refreshKey = `${provider.id}\0${capabilityCwd ?? ""}`;
    if (modelRefreshAttempts.current.has(refreshKey)) return;
    modelRefreshAttempts.current.add(refreshKey);
    setLoadingModelKeys((current) => {
      const next = new Set(current);
      next.add(refreshKey);
      return next;
    });
    refreshProviderCapabilities(provider.id, capabilityCwd ?? "")
      .catch(() => undefined)
      .finally(() => {
        setLoadingModelKeys((current) => {
          if (!current.has(refreshKey)) return current;
          const next = new Set(current);
          next.delete(refreshKey);
          return next;
        });
      });
  }, [
    capabilityCwd,
    projectPath,
    provider,
    provider?.capabilities?.models,
    provider?.id,
    provider?.models?.length,
    refreshProviderCapabilities,
  ]);

  const selectProvider = (nextId: string) => {
    void selectProviderIfAvailable(nextId);
  };

  const applyProviderSelection = (nextId: string): boolean => {
    const latestChat = useChatStore.getState();
    const latestSessionId = activeSessionId || latestChat.activeSessionId;
    if (latestSessionId && latestChat.sessions.some((item) => item.id === latestSessionId)) {
      const session = latestChat.sessions.find((item) => item.id === latestSessionId);
      if (session?.status === "streaming") return false;
      latestChat.setSessionProvider(latestSessionId, nextId);
      setPreferredProvider(nextId);
      return true;
    }

    setPreferredProvider(nextId);
    latestChat.setDraftWorkspace(composerProjectPathForAgentSwitch());
    latestChat.setDraftProvider(nextId);
    return true;
  };

  const selectProviderIfAvailable = async (nextId: string) => {
    if (!nextId || nextId === providerId) return;
    const candidate = allProviders.find((item) => item.id === nextId);
    if (!candidate?.enabled) return;
    const chat = useChatStore.getState();
    const sessionId = activeSessionId || chat.activeSessionId;
    if (sessionId && chat.sessions.some((item) => item.id === sessionId)) {
      const session = chat.sessions.find((item) => item.id === sessionId);
      if (session?.status === "streaming") return;
    }

    const requestId = providerCheckRequestRef.current + 1;
    providerCheckRequestRef.current = requestId;
    setCheckingProviderId(nextId);
    try {
      const available = await checkProviderAvailability(nextId, capabilityCwd ?? "");
      if (providerCheckRequestRef.current !== requestId) return;
      if (!available) {
        toast.error(candidate.name, t("common.unavailable"));
        return;
      }
      applyProviderSelection(nextId);
    } finally {
      setCheckingProviderId((current) =>
        providerCheckRequestRef.current === requestId && current === nextId ? "" : current,
      );
    }
  };

  const selectModel = (nextModel: string) => {
    setModel(nextModel);
    const next = models.find((item) => item.model === nextModel);
    const nextEfforts = optionList<string>(
      supportedReasoningEffortsForModel(provider?.models, provider?.capabilities, next?.model),
    );
    if (nextEfforts.length && !nextEfforts.includes(effort)) {
      setEffort(next?.defaultReasoningEffort || nextEfforts[0]);
    } else if (!nextEfforts.length && effort) {
      setEffort("");
    }
    const nextSpeeds = optionList(
      supportedSpeedsForModel(provider?.models, provider?.capabilities, next?.model),
    );
    if (nextSpeeds.length && !nextSpeeds.includes(speed)) {
      setSpeed(nextSpeeds[0]);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("runSettings.title")}
          aria-label={t("runSettings.title")}
          className={`${COMPOSER_DROPDOWN_TRIGGER_CLASS} gap-1.5`}
        >
          <AgentLogo provider={provider} compact />
          {selectedSpeed === "fast" ? (
            <Zap size={14} className="text-fg shrink-0" fill="currentColor" />
          ) : null}
          {selectedModel ? (
            <span className="text-fg max-w-24 truncate">{compactModelName(selectedModel)}</span>
          ) : null}
          {selectedEffort ? (
            <span className="text-muted max-w-16 truncate">
              {effortLabel(selectedEffort, lang)}
            </span>
          ) : null}
          <ChevronDown size={14} className="text-subtle shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel>{t("runSettings.title")}</DropdownMenuLabel>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">{t("runSettings.agent")}</span>
            <span className="text-subtle flex max-w-36 min-w-0 items-center gap-2">
              <AgentLogo provider={provider} compact />
              <span className="truncate">{provider?.name ?? t("runSettings.noAgent")}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            <div className="text-fg px-2 pt-1.5 pb-2 text-[12px] font-medium">
              {t("runSettings.agent")}
            </div>
            {providers.length ? (
              <DropdownMenuRadioGroup value={providerId} onValueChange={selectProvider}>
                {providers.map((item) => {
                  const estimate = estimateAgentHandoff(activeSession, item.id);
                  const checking = checkingProviderId === item.id;
                  return (
                    <DropdownMenuRadioItem
                      key={item.id}
                      value={item.id}
                      disabled={(sessionStreaming && item.id !== providerId) || checking}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <AgentLogo provider={item} />
                        <div className="min-w-0 truncate">{item.name}</div>
                      </div>
                      <div className="ml-2 flex shrink-0 flex-col items-end text-[10px] leading-4">
                        {checking ? (
                          <Loader2 size={13} className="text-subtle animate-spin" />
                        ) : usedProviderIds.has(item.id) ? (
                          <span className="text-subtle">{t("runSettings.usedInConversation")}</span>
                        ) : null}
                        {estimate ? (
                          <span
                            className="text-warning"
                            title={t("runSettings.handoffEstimateTitle")}
                          >
                            {t("runSettings.handoffEstimate", {
                              count: estimate.messageCount,
                              tokens: compactTokenCount(estimate.approxTokens),
                            })}
                          </span>
                        ) : null}
                      </div>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            ) : (
              <DropdownMenuItem disabled>{t("runSettings.noAgentsConfigured")}</DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {modelListLoading ? (
          <DropdownMenuItem disabled>
            <span className="flex-1">{t("runSettings.model")}</span>
            <span className="text-subtle flex max-w-36 min-w-0 items-center gap-2">
              <Loader2 size={13} className="shrink-0 animate-spin" />
              <span className="truncate">{t("common.loading")}</span>
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex-1">{t("runSettings.model")}</span>
              <span className="text-subtle max-w-36 truncate">
                {selectedModel ? compactModelName(selectedModel) : "-"}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80">
              <DropdownMenuLabel>{t("runSettings.model")}</DropdownMenuLabel>
              {models.length ? (
                <DropdownMenuRadioGroup
                  value={selectedModel?.model ?? ""}
                  onValueChange={selectModel}
                >
                  {models.map((item) => (
                    <DropdownMenuRadioItem key={item.id || item.model} value={item.model}>
                      <div className="min-w-0 truncate">{modelDisplayName(item)}</div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              ) : (
                <DropdownMenuItem disabled>{t("runSettings.noModelsAvailable")}</DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">{t("runSettings.reasoning")}</span>
            <span className="text-subtle max-w-36 truncate">
              {selectedEffort ? effortLabel(selectedEffort, lang) : "-"}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuLabel>{t("runSettings.reasoning")}</DropdownMenuLabel>
            {efforts.length ? (
              <DropdownMenuRadioGroup value={selectedEffort ?? ""} onValueChange={setEffort}>
                {efforts.map((item) => (
                  <DropdownMenuRadioItem key={item} value={item}>
                    {effortLabel(item, lang)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            ) : (
              <DropdownMenuItem disabled>{t("runSettings.reasoningUnavailable")}</DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">{t("runSettings.speed")}</span>
            <span className="text-subtle max-w-36 truncate">{speedLabel(selectedSpeed, lang)}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            <DropdownMenuLabel>{t("runSettings.speed")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selectedSpeed}
              onValueChange={(value) => setSpeed(value as AspRunSpeed)}
            >
              {speeds.map((item) => (
                <DropdownMenuRadioItem key={item} value={item}>
                  <span className="flex items-center gap-2">
                    {item === "fast" ? <Zap size={14} fill="currentColor" /> : null}
                    {speedLabel(item, lang)}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            if (models[0])
              selectModel(models.find((item) => item.isDefault)?.model ?? models[0].model);
            if (efforts[0]) setEffort(selectedModel?.defaultReasoningEffort || efforts[0]);
            else setEffort("");
            setSpeed(speeds.includes("default") ? "default" : (speeds[0] ?? "default"));
          }}
        >
          {t("runSettings.resetDefaults")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function estimateAgentHandoff(
  session: Session | undefined,
  providerId: string,
): { messageCount: number; approxTokens: number } | null {
  if (!session) return null;
  const selection = selectAgentHandoff(session, providerId, { excludeLastUser: false });
  if (!selection) return null;
  return {
    messageCount: selection.entries.length + selection.artifacts.length,
    approxTokens: Math.max(1, Math.ceil(selection.serialized.length / 3)),
  };
}

function compactTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

function composerProjectPathForAgentSwitch(): string | null {
  const chat = useChatStore.getState();
  const ui = useUIStore.getState();
  const activeSession = chat.activeSessionId
    ? chat.sessions.find((item) => item.id === chat.activeSessionId)
    : undefined;
  if (activeSession) return sessionProjectPath(activeSession);
  if (chat.draftSession) return chat.draftSession.projectPath ?? null;
  const activeNavProject = ui.sidebarProjectNavItems[ui.sidebarProjectNavIndex];
  if (activeNavProject) return activeNavProject.projectPath;
  return useAspStore.getState().workspacePath || null;
}

function composerCapabilityCwdForAgentSwitch(): string | null {
  const chat = useChatStore.getState();
  const asp = useAspStore.getState();
  const ui = useUIStore.getState();
  const activeNavProject = ui.sidebarProjectNavItems[ui.sidebarProjectNavIndex];
  if (activeNavProject?.projectPath) return activeNavProject.projectPath;
  if (!chat.activeSessionId && chat.draftSession?.projectPath) return chat.draftSession.projectPath;
  const activeSession = chat.activeSessionId
    ? chat.sessions.find((item) => item.id === chat.activeSessionId)
    : undefined;
  return (
    activeSession?.cwd ||
    (activeSession ? sessionProjectPath(activeSession) : null) ||
    asp.workspacePath ||
    asp.privateSessionsRoot ||
    null
  );
}

function sessionProjectPath(session: {
  cwd?: string;
  privateSessionPath?: string;
  projectPath?: string | null;
}): string | null {
  if (session.projectPath !== undefined) return session.projectPath;
  if (session.privateSessionPath) return null;
  return session.cwd || null;
}

function ApprovalModePicker() {
  const mode = useUIStore((s) => s.approvalMode);
  const setMode = useUIStore((s) => s.setApprovalMode);
  const agents = useAspStore((state) => state.providers);
  const preferredAgentId = useAspStore((state) => state.activeProviderId);
  const draftAgentId = useChatStore((state) => state.draftSession?.providerId);
  const sessionAgentId = useChatStore(
    (state) => state.sessions.find((item) => item.id === state.activeSessionId)?.providerId,
  );
  const selectedAgentId = sessionAgentId || draftAgentId || preferredAgentId;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("settings.general.permissions")}
          aria-label={t("settings.general.permissions")}
          className={`${COMPOSER_DROPDOWN_TRIGGER_CLASS} gap-1.5`}
        >
          <ShieldCheck size={14} />
          <span>{t(approvalModeLabelKeyForAgent(mode, selectedAgent))}</span>
          <ChevronDown size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-52">
        <DropdownMenuLabel>{t("settings.general.permissions")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as ApprovalMode)}
        >
          {APPROVAL_MODES.map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              {t(approvalModeLabelKeyForAgent(item, selectedAgent))}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function modelDisplayName(model: AspModel): string {
  return model.displayName || model.model;
}

function isClaudeCodeRunProvider(provider: AspProvider): boolean {
  return [provider.capabilities?.runtimeAdapter, provider.capabilities?.wireProtocol]
    .map((value) => String(value ?? "").toLowerCase())
    .some((value) => value === "claude-code-stream-json" || value === "claude-code");
}

function compactModelName(model: AspModel): string {
  const label = modelDisplayName(model);
  const tail = label.split("/").pop() ?? label;
  return tail
    .replace(/^gpt(?=[-\s])/i, "GPT")
    .replace(/^codex-/i, "")
    .replace(/-codex$/i, "")
    .replace(/-/g, " ");
}

function effortLabel(value: string, lang: "en" | "zh"): string {
  const labels: Record<string, { en: string; zh: string }> = {
    none: { en: "None", zh: "无" },
    minimal: { en: "Minimal", zh: "最小" },
    low: { en: "Low", zh: "低" },
    medium: { en: "Medium", zh: "中" },
    high: { en: "High", zh: "高" },
    xhigh: { en: "Very high", zh: "极高" },
    max: { en: "Max", zh: "最大" },
  };
  return labels[value]?.[lang] ?? value;
}

function speedLabel(value: AspRunSpeed, lang: "en" | "zh"): string {
  if (value === "fast") return lang === "zh" ? "快速" : "Fast";
  return lang === "zh" ? "默认" : "Default";
}

function optionList<T extends string>(items: readonly T[] | undefined): T[] {
  return [...new Set(items ?? [])];
}
