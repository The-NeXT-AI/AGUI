import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRegistryStore, useShellStore, type SessionTreeNode } from "@agui/app";
import { useAspStore } from "@/asp/asp-store";
import {
  desktopApi,
  type AppExtensionRecord,
  type ExtensionChatRendererContribution,
  type ExtensionFloatingWidgetContribution,
  type ExtensionStyleContribution,
  type ExtensionSessionTreeNodeContribution,
  type ExtensionSessionTreeSessionContribution,
  type ExtensionToolbarControlContribution,
  type ExtensionViewContribution,
} from "@/asp/desktop-api";
import { Markdown } from "@/chat/Markdown";
import { useChatStore } from "@/chat/chat-store";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import { CompositeDisposable } from "@agui/app";
import { ExtensionView } from "./ExtensionView";
import { ExtensionSurfaceErrorBoundary } from "./ExtensionSurfaceErrorBoundary";
import { ExtensionViewsContainer } from "./ExtensionViewsContainer";
import {
  extensionScopeWorkspaceId,
  readExtensionAsset,
  useExtensionStore,
} from "./extension-store";
import {
  canRegisterExtensionContribution,
  canUseGlobalExtensionContribution,
} from "./extension-broker";
import { evaluateWhen, type ExtensionContextValues } from "./when";
import { ExtensionThemeController } from "./ExtensionThemeController";
import { resolveExtensionIcon, resolveOptionalExtensionIcon } from "./extension-icons";
import { localizedContributionText } from "./extension-localization";
import { useI18nStore, type Lang } from "@/lib/i18n";
import { useActiveSessionExtensionData } from "./extension-session-data";

const BUILTIN_CHAT_KINDS = new Set([
  "user",
  "assistant",
  "reasoning",
  "plan",
  "tool",
  "terminal",
  "diff",
  "image",
  "resource",
  "artifact",
  "raw",
  "error",
]);

const BUILTIN_CHAT_RENDERERS = new Set(["agui.card", "custom-card"]);

const MAX_DYNAMIC_SESSION_TREE_NODES = 500;
const MAX_DYNAMIC_SESSION_TREE_DEPTH = 8;
const MAX_SESSION_TREE_ID_LENGTH = 512;
const MAX_SESSION_TREE_TEXT_LENGTH = 4096;
const MAX_SESSION_TREE_MARKDOWN_LENGTH = 64 * 1024;
const MAX_SESSION_TREE_METADATA_LENGTH = 64 * 1024;

type SessionTreeParseBudget = {
  remainingNodes: number;
};

type SessionTreeSecurityContext = {
  allowAgentContext: boolean;
  loadNodePage?: LoadSessionTreeNodePage;
  nodePages?: Record<string, DynamicSessionTreeNodePage>;
  workspacePath: string;
};

type DynamicSessionTreeNodePage = {
  children: unknown[];
  cursor?: string;
  hasMore: boolean;
  loading?: boolean;
  loadingMore?: boolean;
};

type LoadSessionTreeNodePage = (input: {
  command: string;
  extensionId: string;
  loadInput?: Record<string, unknown>;
  mode: "children" | "more";
  nodeId: string;
}) => Promise<void>;

type ResolvedExtensionSessionTreeNodeContribution = ExtensionSessionTreeNodeContribution & {
  loaded?: boolean;
  onLoadChildren?: () => Promise<void>;
  onLoadMore?: () => Promise<void>;
};

export function ExtensionRuntimeHost() {
  const workspacePath = useAspStore((state) => state.workspacePath);
  const activeWorkspace = useWorkspaceStore((state) => state.activeWorkspace());
  const extensionWorkspacePath = activeWorkspace.projectPath ?? workspacePath;
  const extensionWorkspaceId = extensionScopeWorkspaceId(activeWorkspace.id);
  const activeProviderId = useAspStore((state) => state.activeProviderId);
  const sessionProviderId = useChatStore(
    (state) => state.sessions.find((item) => item.id === state.activeSessionId)?.providerId,
  );
  const sessionStreaming = useChatStore(
    (state) =>
      state.sessions.find((item) => item.id === state.activeSessionId)?.status === "streaming",
  );
  const detailPanelVisible = useShellStore((state) => state.detailPanelOpen);
  const records = useExtensionStore((state) => state.records);
  const initialize = useExtensionStore((state) => state.initialize);
  const workspaceTrusted = useExtensionStore((state) => state.workspaceTrusted);
  const contributionsRevision = useExtensionStore((state) => state.contributionsRevision);
  const refreshRevision = useExtensionStore((state) => state.refreshRevision);
  const activate = useExtensionStore((state) => state.activate);
  const executeCommand = useExtensionStore((state) => state.executeCommand);
  const lang = useI18nStore((state) => state.lang);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const [dynamicSessionTreeResults, setDynamicSessionTreeResults] = useState<
    Record<string, unknown>
  >({});
  const [dynamicSessionTreeNodePages, setDynamicSessionTreeNodePages] = useState<
    Record<string, DynamicSessionTreeNodePage>
  >({});
  const dynamicSessionTreeNodePagesRef = useRef(dynamicSessionTreeNodePages);
  dynamicSessionTreeNodePagesRef.current = dynamicSessionTreeNodePages;
  const [loadingSessionTreeRoots, setLoadingSessionTreeRoots] = useState<Record<string, boolean>>(
    {},
  );

  useEffect(() => {
    void initialize({
      workspacePath: extensionWorkspacePath,
      workspaceId: extensionWorkspaceId,
    });
  }, [extensionWorkspaceId, extensionWorkspacePath, initialize]);

  const context = useMemo<ExtensionContextValues>(
    () => ({
      workspaceTrusted,
      agentProvider: sessionProviderId || activeProviderId,
      sessionStreaming,
      detailPanelVisible,
      platform: document.documentElement.dataset.platform || "web",
      runtimeTransport: document.documentElement.dataset.desktop || "web",
    }),
    [activeProviderId, detailPanelVisible, sessionProviderId, sessionStreaming, workspaceTrusted],
  );

  const sessionTreeCommandTargets = useMemo(
    () =>
      records.flatMap((record) => {
        if (!record.enabled || record.state === "blocked" || record.state === "disabled") {
          return [];
        }
        if (!canUseGlobalExtensionContribution(record)) return [];
        if (!record.grantedPermissions.includes("ui.sessionTree")) return [];
        return (record.manifest.contributes?.sessionTree ?? [])
          .filter((root) => root.command && evaluateWhen(root.when, context))
          .map((root) => ({ record, root }));
      }),
    [context, records],
  );
  const sessionTreeCommandTargetsRef = useRef(sessionTreeCommandTargets);
  sessionTreeCommandTargetsRef.current = sessionTreeCommandTargets;
  const sessionTreeCommandTargetsKey = useMemo(
    () =>
      JSON.stringify({
        refreshRevision,
        targets: sessionTreeCommandTargets.map(({ record, root }) => ({
          command: root.command || "",
          extensionId: record.id,
          extensionPath: record.extensionPath,
          rootId: root.id,
          source: record.source,
          version: record.manifest.version,
          when: root.when || "",
        })),
      }),
    [refreshRevision, sessionTreeCommandTargets],
  );

  const loadSessionTreeNodePage = useCallback<LoadSessionTreeNodePage>(
    async ({ command, extensionId, loadInput, mode, nodeId }) => {
      const key = sessionTreeNodeStateKey(extensionId, nodeId);
      const current = dynamicSessionTreeNodePagesRef.current[key];
      if (mode === "children" && (current?.loading || current?.children.length)) return;
      if (mode === "more" && (!current?.hasMore || current.loadingMore)) return;
      const cursor = mode === "more" ? current?.cursor : undefined;
      const loadedCount = mode === "more" ? (current?.children.length ?? 0) : 0;
      setDynamicSessionTreeNodePages((state) => ({
        ...state,
        [key]: {
          children: mode === "more" ? (state[key]?.children ?? []) : [],
          cursor: mode === "more" ? state[key]?.cursor : undefined,
          hasMore: mode === "more" ? Boolean(state[key]?.hasMore) : false,
          loading: mode === "children",
          loadingMore: mode === "more",
        },
      }));
      try {
        const result = await executeCommand(extensionId, command, [
          { cursor, input: loadInput ?? {}, language: lang, loadedCount, nodeId },
        ]);
        const page = sessionTreeCommandPage(result);
        setDynamicSessionTreeNodePages((state) => {
          const previous = state[key];
          const children =
            mode === "more" ? [...(previous?.children ?? []), ...page.children] : page.children;
          return {
            ...state,
            [key]: {
              children,
              cursor: page.cursor,
              hasMore: page.hasMore,
            },
          };
        });
      } catch (error) {
        const message = boundedTextValue(
          error instanceof Error ? error.message : String(error),
          MAX_SESSION_TREE_TEXT_LENGTH,
        );
        console.warn(
          `Extension session tree node load failed for ${extensionId}:${nodeId}`,
          message,
        );
        setDynamicSessionTreeNodePages((state) => {
          const previous = state[key];
          return {
            ...state,
            [key]: {
              children:
                previous?.children.length || mode === "more"
                  ? (previous?.children ?? [])
                  : [
                      {
                        id: `${nodeId}.loadError`,
                        title: lang === "zh" ? "加载失败" : "Load failed",
                        icon: "alert-triangle",
                        kind: "folder",
                        badge: lang === "zh" ? "错误" : "error",
                        description: message,
                        order: -1,
                      },
                    ],
              cursor: previous?.cursor,
              hasMore: mode === "more" ? Boolean(previous?.hasMore) : false,
            },
          };
        });
      }
    },
    [executeCommand, lang],
  );

  useEffect(() => {
    const targets = sessionTreeCommandTargetsRef.current;
    if (!targets.length) {
      setDynamicSessionTreeResults((current) => (Object.keys(current).length ? {} : current));
      setDynamicSessionTreeNodePages((current) => (Object.keys(current).length ? {} : current));
      setLoadingSessionTreeRoots((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    setDynamicSessionTreeNodePages((current) => (Object.keys(current).length ? {} : current));
    const loadingRoots = Object.fromEntries(
      targets.map(({ record, root }) => [sessionTreeRootKey(record.id, root.id), true]),
    );
    setLoadingSessionTreeRoots((current) =>
      shallowRecordEqual(current, loadingRoots) ? current : loadingRoots,
    );
    let cancelled = false;
    void Promise.all(
      targets.map(async ({ record, root }) => {
        const key = sessionTreeRootKey(record.id, root.id);
        try {
          const result = await executeCommand(record.id, root.command || "", [
            { language: lang, rootId: root.id },
          ]);
          return [key, result] as const;
        } catch (error) {
          const message = boundedTextValue(
            error instanceof Error ? error.message : String(error),
            MAX_SESSION_TREE_TEXT_LENGTH,
          );
          console.warn(
            `Extension session tree command failed for ${record.id}:${root.id}`,
            message,
          );
          return [
            key,
            [
              {
                id: `${root.id}.commandError`,
                title: lang === "zh" ? "扩展会话树加载失败" : "Extension tree failed",
                icon: "alert-triangle",
                kind: "folder",
                badge: lang === "zh" ? "错误" : "error",
                description: message,
                order: -1,
              },
            ],
          ] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries);
      const nextKey = JSON.stringify(next);
      setDynamicSessionTreeResults((current) =>
        JSON.stringify(current) === nextKey ? current : next,
      );
      setLoadingSessionTreeRoots((current) => {
        const nextLoading = { ...current };
        let changed = false;
        for (const key of Object.keys(next)) {
          if (!nextLoading[key]) continue;
          delete nextLoading[key];
          changed = true;
        }
        return changed ? nextLoading : current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [executeCommand, lang, sessionTreeCommandTargetsKey]);

  const startupKey = useMemo(
    () =>
      JSON.stringify(
        records.flatMap((record) =>
          record.enabled &&
          record.state !== "blocked" &&
          record.manifest.activationEvents?.includes("onStartupFinished")
            ? [record.id]
            : [],
        ),
      ),
    [records],
  );

  useEffect(() => {
    const composite = new CompositeDisposable();
    const registry = useRegistryStore.getState();
    for (const record of recordsRef.current) {
      if (!record.enabled || record.state === "blocked" || record.state === "disabled") continue;
      const contributions = record.manifest.contributes;
      for (const container of contributions?.viewsContainers?.activitybar ?? []) {
        if (!evaluateWhen(container.when, context)) continue;
        const localizedContainer = {
          ...container,
          title: localizedContributionText(
            record.manifest,
            lang,
            container.id,
            "title",
            container.title,
          ),
        };
        const views = localizedViewsForContainer(record, lang, container.id).filter((view) =>
          canRegisterExtensionContribution(record, view, "sidebar"),
        );
        if (views.length === 0) continue;
        composite.add(
          registry.registerSidebarPanel({
            id: container.id,
            title: localizedContainer.title,
            icon: resolveExtensionIcon(record.id, container.icon),
            order: container.order,
            render: () => (
              <ExtensionSurfaceErrorBoundary
                extensionId={record.id}
                contributionId={container.id}
                surface="sidebar"
                resetKey={`${record.id}:${container.id}:${contributionsRevision}`}
              >
                <ExtensionViewsContainer
                  extensionId={record.id}
                  container={localizedContainer}
                  views={views}
                  menus={contributions?.menus}
                  context={context}
                  surface="sidebar"
                  allowNetwork={record.grantedPermissions.includes("network")}
                />
              </ExtensionSurfaceErrorBoundary>
            ),
          }),
        );
      }
      for (const container of contributions?.viewsContainers?.panel ?? []) {
        if (!evaluateWhen(container.when, context)) continue;
        const localizedContainer = {
          ...container,
          title: localizedContributionText(
            record.manifest,
            lang,
            container.id,
            "title",
            container.title,
          ),
        };
        const views = localizedViewsForContainer(record, lang, container.id).filter((view) =>
          canRegisterExtensionContribution(record, view, "detail-panel"),
        );
        if (views.length === 0) continue;
        composite.add(
          registry.registerDetailPanel({
            id: container.id,
            title: localizedContainer.title,
            icon: resolveExtensionIcon(record.id, container.icon),
            allowMultiple: container.allowMultiple,
            retainContextWhenHidden: container.retainContextWhenHidden,
            order: container.order,
            render: () => (
              <ExtensionSurfaceErrorBoundary
                extensionId={record.id}
                contributionId={container.id}
                surface="detail-panel"
                resetKey={`${record.id}:${container.id}:${contributionsRevision}`}
              >
                <ExtensionDetailViewsContainer
                  extensionId={record.id}
                  container={localizedContainer}
                  views={views}
                  menus={contributions?.menus}
                  context={context}
                  surface="detail-panel"
                  allowNetwork={record.grantedPermissions.includes("network")}
                />
              </ExtensionSurfaceErrorBoundary>
            ),
          }),
        );
      }
      for (const control of contributions?.composerControls ?? []) {
        if (!evaluateWhen(control.when, context)) continue;
        if (!canRegisterExtensionContribution(record, control, "composer")) continue;
        const localizedControl = {
          ...control,
          title: localizedContributionText(
            record.manifest,
            lang,
            control.id,
            "title",
            control.title,
          ),
        };
        composite.add(
          registry.registerComposerControl({
            id: control.id,
            align: control.align,
            order: control.order,
            render: () => (
              <ExtensionSurfaceErrorBoundary
                extensionId={record.id}
                contributionId={control.id}
                surface="composer"
                resetKey={`${record.id}:${control.id}:${contributionsRevision}`}
              >
                <div className="max-w-64 min-w-0">
                  <ExtensionSessionContextView
                    record={record}
                    contribution={localizedControl}
                    surface="composer"
                    executeExtensionCommand={executeCommand}
                  />
                </div>
              </ExtensionSurfaceErrorBoundary>
            ),
          }),
        );
      }
      for (const control of contributions?.headerControls ?? []) {
        if (!evaluateWhen(control.when, context)) continue;
        if (!canRegisterExtensionContribution(record, control, "header")) continue;
        const localizedControl = {
          ...control,
          title: localizedContributionText(
            record.manifest,
            lang,
            control.id,
            "title",
            control.title,
          ),
        };
        composite.add(
          registry.registerHeaderControl({
            id: control.id,
            align: control.align,
            order: control.order,
            render: () => (
              <ExtensionSurfaceErrorBoundary
                extensionId={record.id}
                contributionId={control.id}
                surface="header"
                resetKey={`${record.id}:${control.id}:${contributionsRevision}`}
              >
                <div className="max-w-64 min-w-0">
                  <ExtensionView
                    extensionId={record.id}
                    contribution={localizedControl}
                    surface="header"
                    allowNetwork={record.grantedPermissions.includes("network")}
                  />
                </div>
              </ExtensionSurfaceErrorBoundary>
            ),
          }),
        );
      }
      for (const widget of contributions?.floatingWidgets ?? []) {
        if (!canUseGlobalExtensionContribution(record)) continue;
        if (!evaluateWhen(widget.when, context)) continue;
        if (!canRegisterExtensionContribution(record, widget, "floating-widget")) continue;
        const localizedWidget = {
          ...widget,
          title: localizedContributionText(record.manifest, lang, widget.id, "title", widget.title),
        };
        composite.add(
          registry.registerFloatingWidget({
            id: widget.id,
            title: localizedWidget.title,
            position: widget.position,
            width: widget.width,
            height: widget.height,
            minWidth: widget.minWidth,
            maxWidth: widget.maxWidth,
            minHeight: widget.minHeight,
            maxHeight: widget.maxHeight,
            order: widget.order,
            render: () => (
              <ExtensionSurfaceErrorBoundary
                extensionId={record.id}
                contributionId={widget.id}
                surface="floating-widget"
                resetKey={`${record.id}:${widget.id}:${contributionsRevision}`}
              >
                <ExtensionFloatingWidgetView
                  record={record}
                  contribution={localizedWidget}
                  executeExtensionCommand={executeCommand}
                />
              </ExtensionSurfaceErrorBoundary>
            ),
          }),
        );
      }
      for (const renderer of contributions?.chatRenderers ?? []) {
        if (!evaluateWhen(renderer.when, context)) continue;
        if (!canRegisterExtensionContribution(record, renderer, "chat")) continue;
        const canOverrideBuiltins = record.grantedPermissions.includes("ui.overrideBuiltins");
        const kinds = safeChatKinds(renderer.kind, canOverrideBuiltins);
        const rendererSelectors = safeChatRenderers(renderer.renderer, canOverrideBuiltins);
        if (renderer.kind && kinds.length === 0) continue;
        if (renderer.renderer && rendererSelectors.length === 0) continue;
        composite.add(
          registry.registerBlockRenderer({
            id: renderer.id,
            owner: record.id,
            kind: kinds.length ? kinds : undefined,
            renderer: rendererSelectors.length ? rendererSelectors : undefined,
            mimeType: renderer.mimeType,
            priority: renderer.priority,
            override: canOverrideBuiltins,
            render: (block) => (
              <ExtensionSurfaceErrorBoundary
                extensionId={record.id}
                contributionId={renderer.id}
                surface="chat"
                resetKey={`${record.id}:${renderer.id}:${contributionsRevision}`}
              >
                <ExtensionChatRenderer
                  block={block}
                  executeCommand={executeCommand}
                  record={record}
                  renderer={renderer}
                />
              </ExtensionSurfaceErrorBoundary>
            ),
          }),
        );
      }
      for (const style of contributions?.styles ?? []) {
        if (!canUseGlobalExtensionContribution(record)) continue;
        if (!evaluateWhen(style.when, context)) continue;
        if (!record.grantedPermissions.includes("ui.styles")) continue;
        registerExtensionStyle(composite, record, style);
      }
      for (const root of contributions?.sessionTree ?? []) {
        if (!canUseGlobalExtensionContribution(record)) continue;
        if (!evaluateWhen(root.when, context)) continue;
        if (!record.grantedPermissions.includes("ui.sessionTree")) continue;
        const treeKey = sessionTreeRootKey(record.id, root.id);
        const dynamicResult = dynamicSessionTreeResults[treeKey];
        const dynamicChildren =
          dynamicResult === undefined
            ? undefined
            : sessionTreeCommandNodes(dynamicResult, record.id, {
                allowAgentContext: record.grantedPermissions.includes("agent.sessionContext"),
                loadNodePage: loadSessionTreeNodePage,
                nodePages: dynamicSessionTreeNodePages,
                workspacePath: extensionWorkspacePath,
              });
        const loading = Boolean(loadingSessionTreeRoots[treeKey]) && !dynamicChildren?.length;
        composite.add(
          registry.registerSessionTreeRoot({
            id: root.id,
            title: localizedContributionText(record.manifest, lang, root.id, "title", root.title),
            icon: resolveExtensionIcon(record.id, root.icon),
            owner: record.id,
            order: root.order,
            loading,
            children: extensionSessionTreeNodes(
              record,
              lang,
              loading ? root.children : (dynamicChildren ?? root.children),
              extensionWorkspacePath,
            ),
          }),
        );
      }
      for (const command of contributions?.commands ?? []) {
        if (!canUseGlobalExtensionContribution(record)) continue;
        if (!evaluateWhen(command.when, context)) continue;
        const commandId = commandContributionId(command);
        if (!commandId) continue;
        composite.add(
          registry.registerCommand({
            id: commandId,
            title: localizedContributionText(
              record.manifest,
              lang,
              commandId,
              "title",
              command.title,
            ),
            category:
              localizedContributionText(
                record.manifest,
                lang,
                commandId,
                "category",
                command.category,
              ) || undefined,
            keybinding: command.keybinding,
            icon: resolveOptionalExtensionIcon(record.id, command.icon),
            hidden: command.hidden,
            handler: async (...args) => {
              await executeCommand(record.id, commandId, args);
            },
          }),
        );
      }
    }
    return () => composite.dispose();
  }, [
    context,
    contributionsRevision,
    dynamicSessionTreeResults,
    dynamicSessionTreeNodePages,
    executeCommand,
    extensionWorkspacePath,
    lang,
    loadSessionTreeNodePage,
    loadingSessionTreeRoots,
  ]);

  useEffect(() => {
    if (!recordsRef.current.length) return;
    const timer = window.setTimeout(() => {
      for (const record of recordsRef.current) {
        if (
          record.enabled &&
          record.state !== "blocked" &&
          (record.source !== "workspace" || record.workspaceTrusted) &&
          record.manifest.activationEvents?.includes("onStartupFinished")
        ) {
          void activate(record.id, "onStartupFinished");
        }
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activate, startupKey]);

  return <ExtensionThemeController />;
}

function ExtensionSessionContextView({
  contribution,
  executeExtensionCommand,
  record,
  surface,
}: {
  contribution: ExtensionToolbarControlContribution;
  executeExtensionCommand?: (
    extensionId: string,
    command: string,
    args?: unknown[],
  ) => Promise<unknown>;
  record: AppExtensionRecord;
  surface: "composer";
}) {
  const data = useActiveSessionExtensionData();
  return (
    <ExtensionView
      extensionId={record.id}
      contribution={contribution}
      surface={surface}
      allowNetwork={record.grantedPermissions.includes("network")}
      data={data}
      executeCommand={
        executeExtensionCommand
          ? (command: string, args: unknown[]) =>
              executeExtensionViewCommand(record.id, command, args, executeExtensionCommand)
          : undefined
      }
    />
  );
}

function ExtensionDetailViewsContainer(props: Parameters<typeof ExtensionViewsContainer>[0]) {
  const data = useActiveSessionExtensionData();
  return <ExtensionViewsContainer {...props} data={data} />;
}

function ExtensionFloatingWidgetView({
  contribution,
  executeExtensionCommand,
  record,
}: {
  contribution: ExtensionFloatingWidgetContribution;
  executeExtensionCommand?: (
    extensionId: string,
    command: string,
    args?: unknown[],
  ) => Promise<unknown>;
  record: AppExtensionRecord;
}) {
  const data = useActiveSessionExtensionData();
  return (
    <ExtensionView
      extensionId={record.id}
      contribution={contribution}
      surface="floating-widget"
      allowNetwork={record.grantedPermissions.includes("network")}
      data={data}
      className="block h-full w-full overflow-hidden"
      executeCommand={
        executeExtensionCommand
          ? (command: string, args: unknown[]) =>
              executeExtensionViewCommand(record.id, command, args, executeExtensionCommand)
          : undefined
      }
    />
  );
}

function ExtensionChatRenderer({
  block,
  executeCommand,
  record,
  renderer,
}: {
  block: unknown;
  executeCommand: (extensionId: string, command: string, args?: unknown[]) => Promise<unknown>;
  record: AppExtensionRecord;
  renderer: ExtensionChatRendererContribution;
}) {
  const markdown = extensionMarkdownSupplement(block);
  return (
    <>
      <ExtensionView
        extensionId={record.id}
        contribution={renderer}
        data={block}
        surface="chat"
        allowNetwork={record.grantedPermissions.includes("network")}
        executeCommand={(command: string, args: unknown[]) =>
          executeExtensionViewCommand(record.id, command, args, executeCommand)
        }
      />
      {markdown ? (
        <div className="mt-4 max-w-[980px]">
          {markdown.title ? (
            <div className="text-fg mb-2 text-[14px] font-semibold">{markdown.title}</div>
          ) : null}
          <Markdown>{markdown.content}</Markdown>
        </div>
      ) : null}
    </>
  );
}

function extensionMarkdownSupplement(block: unknown): { title?: string; content: string } | null {
  const record = objectRecord(block);
  const metadata = objectRecord(record.metadata);
  const markdown = metadata.markdown;
  if (typeof markdown === "string") {
    const content = markdown.trim();
    return content ? { content } : null;
  }
  const markdownRecord = objectRecord(markdown);
  const content = stringValue(markdownRecord.content || markdownRecord.body).trim();
  if (!content) return null;
  const title = stringValue(markdownRecord.title).trim();
  return title ? { title, content } : { content };
}

function safeChatKinds(
  selector: string | string[] | undefined,
  canOverrideBuiltins: boolean,
): string[] {
  const values = typeof selector === "string" ? [selector] : (selector ?? []);
  return canOverrideBuiltins ? values : values.filter((kind) => !BUILTIN_CHAT_KINDS.has(kind));
}

function safeChatRenderers(
  selector: string | string[] | undefined,
  canOverrideBuiltins: boolean,
): string[] {
  const values = typeof selector === "string" ? [selector] : (selector ?? []);
  return canOverrideBuiltins
    ? values
    : values.filter((renderer) => !BUILTIN_CHAT_RENDERERS.has(renderer));
}

function viewsForContainer(
  views: Record<string, ExtensionViewContribution[]> | undefined,
  containerId: string,
): ExtensionViewContribution[] {
  return views?.[containerId] ?? [];
}

function localizedViewsForContainer(
  record: AppExtensionRecord,
  lang: Lang,
  containerId: string,
): ExtensionViewContribution[] {
  return viewsForContainer(record.manifest.contributes?.views, containerId).map((view) => ({
    ...view,
    name: localizedContributionText(record.manifest, lang, view.id, "name", view.name),
  }));
}

function commandContributionId(command: { id?: string; command?: string }): string {
  return command.id || command.command || "";
}

function extensionSessionTreeNodes(
  record: AppExtensionRecord,
  lang: Lang,
  nodes: ResolvedExtensionSessionTreeNodeContribution[] | undefined,
  workspacePath: string,
): SessionTreeNode[] {
  return (nodes ?? []).map((node) => {
    const session = sanitizeSessionTreeSession(
      node.session,
      record.grantedPermissions.includes("agent.sessionContext"),
      workspacePath,
    );
    return {
      id: node.id,
      title: localizedContributionText(record.manifest, lang, node.id, "title", node.title),
      icon: resolveOptionalExtensionIcon(record.id, node.icon),
      kind: node.kind,
      loaded: node.loaded,
      loading: node.loading,
      loadingMore: node.loadingMore,
      hasMore: node.hasMore,
      badge: localizedContributionText(record.manifest, lang, node.id, "badge", node.badge),
      description: localizedContributionText(
        record.manifest,
        lang,
        node.id,
        "description",
        node.description,
      ),
      order: node.order,
      onLoadChildren: node.onLoadChildren,
      onLoadMore: node.onLoadMore,
      session: session
        ? {
            ...session,
            title: localizedContributionText(
              record.manifest,
              lang,
              node.id,
              "title",
              session.title || node.title,
            ),
            initialMarkdown: localizedContributionText(
              record.manifest,
              lang,
              node.id,
              "initialMarkdown",
              session.initialMarkdown,
            ),
            developerInstructions: localizedContributionText(
              record.manifest,
              lang,
              node.id,
              "developerInstructions",
              session.developerInstructions,
            ),
          }
        : undefined,
      children: extensionSessionTreeNodes(record, lang, node.children, workspacePath),
    };
  });
}

function sessionTreeRootKey(extensionId: string, rootId: string): string {
  return `${extensionId}:${rootId}`;
}

function shallowRecordEqual(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function sessionTreeCommandNodes(
  value: unknown,
  extensionId: string,
  security: SessionTreeSecurityContext,
  depth = 0,
  budget: SessionTreeParseBudget = { remainingNodes: MAX_DYNAMIC_SESSION_TREE_NODES },
): ResolvedExtensionSessionTreeNodeContribution[] {
  if (budget.remainingNodes <= 0 || depth > MAX_DYNAMIC_SESSION_TREE_DEPTH) return [];
  const record = objectRecord(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record.children)
      ? record.children
      : [];
  const nodes: ResolvedExtensionSessionTreeNodeContribution[] = [];
  for (const item of source) {
    if (budget.remainingNodes <= 0) break;
    budget.remainingNodes -= 1;
    const node = sessionTreeCommandNode(item, extensionId, security, depth, budget);
    if (node) nodes.push(node);
  }
  return nodes;
}

function sessionTreeCommandNode(
  value: unknown,
  extensionId: string,
  security: SessionTreeSecurityContext,
  depth: number,
  budget: SessionTreeParseBudget,
): ResolvedExtensionSessionTreeNodeContribution | null {
  const record = objectRecord(value);
  const id = stringWithin(record.id, MAX_SESSION_TREE_ID_LENGTH);
  const title = boundedStringValue(record.title, MAX_SESSION_TREE_TEXT_LENGTH);
  if (!isExtensionScopedId(extensionId, id) || !title) return null;
  const node: ResolvedExtensionSessionTreeNodeContribution = { id, title };
  const icon = sessionTreeIcon(record.icon);
  if (icon) node.icon = icon;
  const kind = stringValue(record.kind);
  if (kind === "folder" || kind === "session") node.kind = kind;
  const page = security.nodePages?.[sessionTreeNodeStateKey(extensionId, id)];
  if (page) node.loaded = true;
  const loadInput = boundedJsonRecord(record.loadInput, MAX_SESSION_TREE_METADATA_LENGTH);
  const loadChildrenCommand = extensionScopedCommand(extensionId, record.loadChildrenCommand);
  const loadMoreCommand = extensionScopedCommand(extensionId, record.loadMoreCommand);
  if (record.loading === true || page?.loading) node.loading = true;
  if (record.loadingMore === true || page?.loadingMore) node.loadingMore = true;
  const cursor = page?.cursor ?? stringWithin(record.cursor, MAX_SESSION_TREE_TEXT_LENGTH);
  const hasMore = page ? page.hasMore : record.hasMore === true || Boolean(cursor);
  if (hasMore) node.hasMore = true;
  if (loadChildrenCommand && security.loadNodePage) {
    node.onLoadChildren = () =>
      security.loadNodePage?.({
        command: loadChildrenCommand,
        extensionId,
        loadInput,
        mode: "children",
        nodeId: id,
      }) ?? Promise.resolve();
  }
  if (loadMoreCommand && security.loadNodePage) {
    node.onLoadMore = () =>
      security.loadNodePage?.({
        command: loadMoreCommand,
        extensionId,
        loadInput,
        mode: "more",
        nodeId: id,
      }) ?? Promise.resolve();
  }
  const badge = boundedStringValue(record.badge, MAX_SESSION_TREE_TEXT_LENGTH);
  if (badge) node.badge = badge;
  const description = boundedStringValue(record.description, MAX_SESSION_TREE_TEXT_LENGTH);
  if (description) node.description = description;
  if (typeof record.order === "number" && Number.isFinite(record.order)) node.order = record.order;
  const children = sessionTreeCommandNodes(
    page ? page.children : record.children,
    extensionId,
    security,
    depth + 1,
    budget,
  );
  if (children.length) node.children = children;
  const session = sessionTreeSession(record.session, security);
  if (session) node.session = session;
  return node;
}

function sessionTreeCommandPage(value: unknown): DynamicSessionTreeNodePage {
  const record = objectRecord(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record.children)
      ? record.children
      : [];
  const cursor = stringWithin(record.cursor ?? record.nextCursor, MAX_SESSION_TREE_TEXT_LENGTH);
  return {
    children: source,
    cursor: cursor || undefined,
    hasMore: record.hasMore === true || Boolean(cursor),
  };
}

function extensionScopedCommand(extensionId: string, value: unknown): string {
  const command = stringWithin(value, MAX_SESSION_TREE_ID_LENGTH);
  return isExtensionScopedId(extensionId, command) ? command : "";
}

function sessionTreeNodeStateKey(extensionId: string, nodeId: string): string {
  return `${extensionId}:${nodeId}`;
}

function sessionTreeSession(
  value: unknown,
  security: SessionTreeSecurityContext,
): ExtensionSessionTreeNodeContribution["session"] | undefined {
  const record = objectRecord(value);
  if (!Object.keys(record).length) return undefined;
  const session: NonNullable<ExtensionSessionTreeNodeContribution["session"]> = {};
  const title = boundedStringValue(record.title, MAX_SESSION_TREE_TEXT_LENGTH);
  if (title) session.title = title;
  if (security.allowAgentContext) {
    const providerId = stringWithin(record.providerId, MAX_SESSION_TREE_ID_LENGTH);
    if (providerId) session.providerId = providerId;
    if (record.projectPath === null) session.projectPath = null;
    else {
      const projectPath = allowedSessionTreeWorkspacePath(
        stringWithin(record.projectPath, MAX_SESSION_TREE_TEXT_LENGTH),
        security.workspacePath,
      );
      if (projectPath) session.projectPath = projectPath;
    }
    const cwd = allowedSessionTreeWorkspacePath(
      stringWithin(record.cwd, MAX_SESSION_TREE_TEXT_LENGTH),
      security.workspacePath,
    );
    if (cwd) session.cwd = cwd;
  }
  const initialMarkdown = boundedStringValue(
    record.initialMarkdown,
    MAX_SESSION_TREE_MARKDOWN_LENGTH,
  );
  if (initialMarkdown) session.initialMarkdown = initialMarkdown;
  const renderer = stringWithin(record.renderer, MAX_SESSION_TREE_ID_LENGTH);
  if (renderer) session.renderer = renderer;
  if (security.allowAgentContext) {
    const developerInstructions = boundedStringValue(
      record.developerInstructions,
      MAX_SESSION_TREE_MARKDOWN_LENGTH,
    );
    if (developerInstructions) session.developerInstructions = developerInstructions;
  }
  const metadata = boundedJsonRecord(record.metadata, MAX_SESSION_TREE_METADATA_LENGTH);
  if (metadata) session.metadata = metadata;
  return session;
}

function sanitizeSessionTreeSession(
  value: ExtensionSessionTreeSessionContribution | undefined,
  allowAgentContext: boolean,
  workspacePath: string,
): ExtensionSessionTreeSessionContribution | undefined {
  if (!value) return undefined;
  const session: ExtensionSessionTreeSessionContribution = {
    title: value.title,
    renderer: value.renderer,
    initialMarkdown: value.initialMarkdown,
    metadata: value.metadata,
  };
  if (!allowAgentContext) return session;
  session.providerId = value.providerId;
  session.developerInstructions = value.developerInstructions;
  if (value.projectPath === null) session.projectPath = null;
  else {
    const projectPath = allowedSessionTreeWorkspacePath(value.projectPath, workspacePath);
    if (projectPath) session.projectPath = projectPath;
  }
  const cwd = allowedSessionTreeWorkspacePath(value.cwd, workspacePath);
  if (cwd) session.cwd = cwd;
  return session;
}

function allowedSessionTreeWorkspacePath(value: string | undefined, workspacePath: string): string {
  const candidate = normalizedComparablePath(value);
  const workspace = normalizedComparablePath(workspacePath);
  return candidate && workspace && candidate === workspace ? workspacePath.trim() : "";
}

function normalizedComparablePath(value: string | undefined): string {
  const normalized = (value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

async function executeExtensionViewCommand(
  extensionId: string,
  command: string,
  args: unknown[],
  executeCommand: (extensionId: string, command: string, args?: unknown[]) => Promise<unknown>,
): Promise<unknown> {
  if (command === "agui.host.openExternal") {
    const url = safeExtensionExternalUrl(args[0]);
    if (!url) throw new Error("Only https URLs can be opened from extension views.");
    const opened = await desktopApi()?.window?.openExternal?.(url);
    if (opened) return true;
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }
  if (command === "agui.host.openDetailPanel") {
    const panelId = stringValue(args[0]);
    if (!isExtensionScopedId(extensionId, panelId)) {
      throw new Error("Extension views can only open their own detail panels.");
    }
    const panel = useRegistryStore.getState().detailPanels.find((item) => item.id === panelId);
    if (!panel) throw new Error(`Extension detail panel is not available: ${panelId}`);
    useShellStore.getState().openDetailPanel(panelId, { allowMultiple: panel.allowMultiple });
    return true;
  }
  if (command.startsWith(`${extensionId}.`) || command.startsWith(`${extensionId}/`)) {
    return executeCommand(extensionId, command, args);
  }
  throw new Error("Extension views can only call host view APIs or this extension.");
}

function safeExtensionExternalUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringWithin(value: unknown, maxLength: number): string {
  const text = stringValue(value);
  return text.length <= maxLength ? text : "";
}

function boundedStringValue(value: unknown, maxLength: number): string {
  const text = stringValue(value);
  return boundedTextValue(text, maxLength);
}

function boundedTextValue(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isExtensionScopedId(extensionId: string, id: string): boolean {
  return Boolean(id && (id.startsWith(`${extensionId}.`) || id.startsWith(`${extensionId}/`)));
}

function sessionTreeIcon(value: unknown): ExtensionSessionTreeNodeContribution["icon"] | undefined {
  const icon = stringWithin(value, MAX_SESSION_TREE_TEXT_LENGTH);
  if (icon) return icon;
  const record = objectRecord(value);
  const contribution: { light?: string; dark?: string; path?: string } = {};
  const light = stringWithin(record.light, MAX_SESSION_TREE_TEXT_LENGTH);
  const dark = stringWithin(record.dark, MAX_SESSION_TREE_TEXT_LENGTH);
  const iconPath = stringWithin(record.path, MAX_SESSION_TREE_TEXT_LENGTH);
  if (light) contribution.light = light;
  if (dark) contribution.dark = dark;
  if (iconPath) contribution.path = iconPath;
  return Object.keys(contribution).length ? contribution : undefined;
}

function boundedJsonRecord(value: unknown, maxLength: number): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > maxLength) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function registerExtensionStyle(
  composite: CompositeDisposable,
  record: AppExtensionRecord,
  style: ExtensionStyleContribution,
): void {
  void readExtensionAsset(record.id, style.path).then(
    (asset) => {
      if (asset.encoding !== "utf8") throw new Error("Extension style assets must be CSS text.");
      composite.add(
        useRegistryStore.getState().registerStyle({
          id: style.id,
          owner: record.id,
          css: asset.data,
          media: style.media,
          order: style.order,
          allowNetwork: record.grantedPermissions.includes("network"),
        }),
      );
    },
    (error) => {
      console.warn(
        `Extension style failed to load: ${record.id}:${style.id}`,
        error instanceof Error ? error.message : error,
      );
    },
  );
}
