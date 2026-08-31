import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  X,
} from "lucide-react";
import {
  desktopApi,
  type IdeDiagnostic,
  type IdeFileReadResult,
  type IdeFileTreeNode,
} from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { useChatStore } from "@/chat/chat-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/ui/cn";
import { disposeMonacoModel, MonacoCodeEditor } from "./MonacoCodeEditor";
import { useDetailPanelProjectContext } from "@/shell/detail-panel-project-context";

type IdeTab = {
  path: string;
  name: string;
  language: string;
  content: string;
  savedContent: string;
  mtimeMs: number;
  diagnostics: IdeDiagnostic[];
  diagnosticsLoading: boolean;
  error?: string;
};

export function IdePanel() {
  const t = useT();
  const projectContext = useDetailPanelProjectContext();
  const activeSession = useChatStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId),
  );
  const workspacePath = useAspStore((state) => state.workspacePath);
  const root =
    projectContext?.root || activeSession?.cwd || activeSession?.projectPath || workspacePath || "";
  const [tree, setTree] = useState<IdeFileTreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<IdeTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activePath) ?? tabs[0] ?? null,
    [activePath, tabs],
  );
  const diagnostics = activeTab?.diagnostics ?? [];

  const refreshTree = useCallback(async () => {
    const api = desktopApi();
    if (!root || !api?.ide?.tree) {
      setTree(null);
      setTreeError(root ? "IDE runtime is unavailable." : null);
      return;
    }
    setTreeError(null);
    try {
      const nextTree = await api.ide.tree({ root });
      setTree(nextTree);
      setExpanded((current) => new Set([nextTree.path, ...current]));
    } catch (error) {
      setTreeError(String(error instanceof Error ? error.message : error));
    }
  }, [root]);

  useEffect(() => {
    setTabs((items) => {
      items.forEach((tab) => disposeMonacoModel(tab.path));
      return [];
    });
    setActivePath(null);
    setTree(null);
    setExpanded(new Set());
    void refreshTree();
  }, [refreshTree, root]);

  const activeDiagnosticsPath = activeTab?.path ?? "";
  const activeDiagnosticsContent = activeTab?.content ?? "";
  useEffect(() => {
    if (!activeDiagnosticsPath || !root || !isLspSupported(activeDiagnosticsPath)) return undefined;
    let cancelled = false;
    setTabs((items) =>
      items.map((tab) =>
        tab.path === activeDiagnosticsPath ? { ...tab, diagnosticsLoading: true } : tab,
      ),
    );
    const timeout = window.setTimeout(async () => {
      try {
        const nextDiagnostics = await desktopApi()?.ide?.diagnostics({
          root,
          filePath: activeDiagnosticsPath,
          content: activeDiagnosticsContent,
        });
        if (cancelled) return;
        setTabs((items) =>
          items.map((tab) =>
            tab.path === activeDiagnosticsPath
              ? {
                  ...tab,
                  diagnostics: nextDiagnostics ?? [],
                  diagnosticsLoading: false,
                  error: undefined,
                }
              : tab,
          ),
        );
      } catch (error) {
        if (cancelled) return;
        setTabs((items) =>
          items.map((tab) =>
            tab.path === activeDiagnosticsPath
              ? {
                  ...tab,
                  diagnostics: [],
                  diagnosticsLoading: false,
                  error: String(error instanceof Error ? error.message : error),
                }
              : tab,
          ),
        );
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeDiagnosticsContent, activeDiagnosticsPath, root]);

  const openFile = async (node: IdeFileTreeNode) => {
    if (node.type !== "file") return;
    const existing = tabs.find((tab) => tab.path === node.path);
    if (existing) {
      setActivePath(existing.path);
      return;
    }
    try {
      const file = await desktopApi()?.ide?.readFile({ root, filePath: node.path });
      if (!file) throw new Error("IDE runtime is unavailable.");
      setTabs((items) => [...items, toIdeTab(file)]);
      setActivePath(file.path);
    } catch (error) {
      setTreeError(String(error instanceof Error ? error.message : error));
    }
  };

  const closeTab = (pathToClose: string) => {
    disposeMonacoModel(pathToClose);
    setTabs((items) => {
      const index = items.findIndex((tab) => tab.path === pathToClose);
      const next = items.filter((tab) => tab.path !== pathToClose);
      if (activePath === pathToClose) {
        setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null);
      }
      return next;
    });
  };

  const updateTabContent = (pathToUpdate: string, content: string) => {
    setTabs((items) =>
      items.map((tab) => (tab.path === pathToUpdate ? { ...tab, content, error: undefined } : tab)),
    );
  };

  const openFilePath = useCallback(
    async (filePath: string) => {
      if (!filePath) return;
      const existing = tabs.find((tab) => tab.path === filePath);
      if (existing) {
        setActivePath(existing.path);
        return;
      }
      try {
        const file = await desktopApi()?.ide?.readFile({ root, filePath });
        if (!file) throw new Error("IDE runtime is unavailable.");
        setTabs((items) => [...items, toIdeTab(file)]);
        setActivePath(file.path);
      } catch (error) {
        setTreeError(String(error instanceof Error ? error.message : error));
      }
    },
    [root, tabs],
  );

  const saveActive = async (contentOverride?: string) => {
    if (!activeTab) return;
    const content = contentOverride ?? activeTab.content;
    try {
      const saved = await desktopApi()?.ide?.writeFile({
        root,
        filePath: activeTab.path,
        content,
      });
      if (!saved) throw new Error("IDE runtime is unavailable.");
      setTabs((items) =>
        items.map((tab) =>
          tab.path === activeTab.path
            ? {
                ...tab,
                content: saved.content,
                savedContent: saved.content,
                mtimeMs: saved.mtimeMs,
                error: undefined,
              }
            : tab,
        ),
      );
      void refreshTree();
    } catch (error) {
      setTabs((items) =>
        items.map((tab) =>
          tab.path === activeTab.path
            ? { ...tab, error: String(error instanceof Error ? error.message : error) }
            : tab,
        ),
      );
    }
  };

  const toggleDirectory = (pathToToggle: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(pathToToggle)) next.delete(pathToToggle);
      else next.add(pathToToggle);
      return next;
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void desktopApi()
        ?.panel?.syncIdeState({
          activeContent: activeTab?.content,
          activePath: activeTab?.path ?? null,
          root,
          tabs: tabs.map((tab) => ({
            diagnostics: tab.diagnostics,
            diagnosticsLoading: tab.diagnosticsLoading,
            dirty: tab.content !== tab.savedContent,
            error: tab.error,
            language: tab.language,
            mtimeMs: tab.mtimeMs,
            name: tab.name,
            path: tab.path,
          })),
          updatedAt: Date.now(),
        })
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeTab, root, tabs]);

  useEffect(() => {
    const handleCommand = (event: Event) => {
      const command = idePanelCommand(event);
      if (!command || command.type !== "openFile") return;
      if (command.root && root && normalizePath(command.root) !== normalizePath(root)) return;
      void openFilePath(command.filePath);
    };
    window.addEventListener("agui:ide-panel-command", handleCommand);
    return () => window.removeEventListener("agui:ide-panel-command", handleCommand);
  }, [openFilePath, root]);

  return (
    <div className="bg-code-bg text-fg flex h-full min-h-0">
      <aside className="border-border-subtle bg-sidebar flex w-[236px] shrink-0 flex-col border-r">
        <div className="flex h-9 shrink-0 items-center px-3">
          <span className="text-muted min-w-0 flex-1 truncate text-[11px] tracking-[0.04em] uppercase">
            Explorer
          </span>
        </div>

        <button
          type="button"
          disabled={!tree}
          onClick={() => {
            if (tree) toggleDirectory(tree.path);
          }}
          className="border-border-subtle bg-surface/60 text-fg flex h-6 shrink-0 items-center gap-1 border-y px-2 text-left text-[11px] font-semibold uppercase disabled:cursor-default"
        >
          {tree && expanded.has(tree.path) ? (
            <ChevronDown size={13} className="shrink-0" />
          ) : (
            <ChevronRight size={13} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {root ? basename(root) : t("ide.noProject")}
          </span>
        </button>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {!root ? (
            <div className="text-subtle px-3 py-4 text-[12px]">{t("ide.noProjectSelected")}</div>
          ) : treeError ? (
            <div className="text-danger px-3 py-4 text-[12px]">{treeError}</div>
          ) : tree ? (
            expanded.has(tree.path) ? (
              tree.children?.length ? (
                tree.children.map((child) => (
                  <FileTreeNodeView
                    key={child.path}
                    node={child}
                    depth={0}
                    expanded={expanded}
                    activePath={activePath}
                    onToggle={toggleDirectory}
                    onOpen={openFile}
                  />
                ))
              ) : (
                <div className="text-subtle px-3 py-4 text-[12px]">{t("ide.noFiles")}</div>
              )
            ) : null
          ) : (
            <div className="text-subtle px-3 py-4 text-[12px]">{t("common.loading")}</div>
          )}
        </div>
      </aside>

      <section className="bg-code-bg flex min-w-0 flex-1 flex-col">
        <div className="border-border-subtle bg-surface flex h-9 shrink-0 items-center border-b">
          <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
            {tabs.length === 0 ? (
              <span className="text-subtle flex items-center px-3 text-[12px]">
                {t("ide.openFileFromExplorer")}
              </span>
            ) : (
              tabs.map((tab) => {
                const dirty = tab.content !== tab.savedContent;
                const selected = tab.path === activeTab?.path;
                return (
                  <div
                    key={tab.path}
                    role="tab"
                    tabIndex={0}
                    aria-selected={selected}
                    data-ide-tab-dirty={dirty ? "true" : "false"}
                    title={tab.path}
                    onClick={() => setActivePath(tab.path)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setActivePath(tab.path);
                    }}
                    className={cn(
                      "group/file-tab border-border-subtle flex h-9 max-w-[200px] min-w-0 cursor-default items-center gap-1.5 border-r px-2 text-[12px] outline-none",
                      selected
                        ? "border-t-accent bg-code-bg text-fg border-t"
                        : "bg-surface text-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    {fileIcon(tab.language)}
                    <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                      {dirty ? (
                        <span
                          data-ide-tab-dirty-indicator
                          className="bg-fg h-2.5 w-2.5 rounded-full transition-opacity duration-150 group-hover/file-tab:opacity-0"
                        />
                      ) : null}
                      <button
                        type="button"
                        title={`Close ${tab.name}`}
                        aria-label={`Close ${tab.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeTab(tab.path);
                        }}
                        className={cn(
                          "text-subtle hover:bg-surface-active hover:text-fg absolute inset-0 flex items-center justify-center rounded-[3px] opacity-0 transition-opacity duration-150 group-hover/file-tab:opacity-100",
                          dirty && "group-hover/file-tab:opacity-100",
                        )}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {activeTab ? (
          <MonacoCodeEditor
            root={root}
            tab={activeTab}
            diagnostics={diagnostics}
            onChange={updateTabContent}
            onSave={(content) => void saveActive(content)}
          />
        ) : (
          <div className="bg-code-bg text-subtle flex min-h-0 flex-1 items-center justify-center text-[13px]">
            Select a file from Explorer.
          </div>
        )}
      </section>
    </div>
  );
}

function FileTreeNodeView({
  node,
  depth,
  expanded,
  activePath,
  onToggle,
  onOpen,
}: {
  node: IdeFileTreeNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (node: IdeFileTreeNode) => void;
}) {
  const isDirectory = node.type === "directory";
  const isExpanded = expanded.has(node.path);
  const selected = activePath === node.path;
  const Icon = isDirectory ? (isExpanded ? FolderOpen : Folder) : FileText;
  return (
    <div>
      <button
        type="button"
        title={node.path}
        onClick={() => (isDirectory ? onToggle(node.path) : onOpen(node))}
        className={cn(
          "hover:bg-surface-hover hover:text-fg flex h-[22px] w-full min-w-0 items-center gap-1 px-2 text-left text-[12px] transition-colors",
          selected ? "bg-surface-active text-fg" : "text-fg",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown size={13} className="text-subtle shrink-0" />
          ) : (
            <ChevronRight size={13} className="text-subtle shrink-0" />
          )
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <Icon
          size={14}
          className={cn("shrink-0", isDirectory ? "text-warning" : fileIconColor(node.name))}
        />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {isDirectory && isExpanded
        ? node.children?.map((child) => (
            <FileTreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activePath={activePath}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        : null}
    </div>
  );
}

function toIdeTab(file: IdeFileReadResult): IdeTab {
  return {
    path: file.path,
    name: file.name,
    language: file.language,
    content: file.content,
    savedContent: file.content,
    mtimeMs: file.mtimeMs,
    diagnostics: [],
    diagnosticsLoading: false,
  };
}

function isLspSupported(filePath: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(filePath);
}

function fileIcon(language: string) {
  if (language.includes("javascript") || language.includes("typescript")) {
    return <FileCode2 size={14} className="text-info shrink-0" />;
  }
  return <FileText size={14} className="text-muted shrink-0" />;
}

function basename(filePath: string): string {
  return (
    filePath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || filePath
  );
}

function idePanelCommand(
  event: Event,
): { filePath: string; root?: string; type: "openFile" } | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const record = detail as Record<string, unknown>;
  if (record.type !== "openFile" || typeof record.filePath !== "string") return null;
  return {
    filePath: record.filePath,
    root: typeof record.root === "string" ? record.root : undefined,
    type: "openFile",
  };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/[\\/]+$/, "");
}

function fileIconColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") return "text-info";
  if (ext === "json") return "text-warning";
  if (ext === "css" || ext === "scss") return "text-info";
  if (ext === "md" || ext === "mdx") return "text-info";
  return "text-muted";
}
