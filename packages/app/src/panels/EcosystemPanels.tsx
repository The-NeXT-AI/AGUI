import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileSearch,
  GitBranch,
  Play,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { useShellStore } from "@the-next-ai/agui-app";
import { desktopApi, type IdeDiagnostic, type TerminalRunEvent } from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { useChatStore } from "@/chat/chat-store";
import { contextUsageForSession } from "@/chat/context-usage";
import { Markdown } from "@/chat/Markdown";
import { useExtensionStore } from "@/extensions/extension-store";
import { uid } from "@/ui/id";
import { cn } from "@/ui/cn";
import { useDetailPanelProjectContext } from "@/shell/detail-panel-project-context";

type CommandState = {
  running: boolean;
  output: string;
  error: string;
  exitCode: number | null;
};

function useWorkspaceRoot(): string {
  const projectContext = useDetailPanelProjectContext();
  const workspacePath = useAspStore((state) => state.workspacePath);
  const sessionCwd = useChatStore((state) => {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    return session?.cwd || session?.projectPath || "";
  });
  return projectContext?.root || sessionCwd || workspacePath || "";
}

function useExecutableRunner() {
  const id = useRef(uid("builtin-task"));
  const [state, setState] = useState<CommandState>({
    running: false,
    output: "",
    error: "",
    exitCode: null,
  });
  useEffect(
    () =>
      desktopApi()?.onTerminalEvent((event) => {
        if (!isTerminalEvent(event) || event.id !== id.current) return;
        if (event.type === "stdout" || event.type === "stderr") {
          setState((current) => ({
            ...current,
            output: `${current.output}${event.chunk}`.slice(-256 * 1024),
          }));
          return;
        }
        if (event.type === "exit") {
          setState((current) => ({
            ...current,
            running: false,
            exitCode: event.code,
            error:
              event.status === "error"
                ? event.message || `Process exited with code ${event.code ?? "unknown"}.`
                : "",
          }));
        }
      }),
    [],
  );
  const run = useCallback(async (command: string, args: string[], cwd: string) => {
    const api = desktopApi()?.terminal;
    if (!api) throw new Error("Desktop process execution is unavailable.");
    await api.cancel(id.current).catch(() => false);
    setState({ running: true, output: "", error: "", exitCode: null });
    try {
      await api.exec({ id: id.current, command, args, cwd });
    } catch (error) {
      setState({
        running: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        exitCode: null,
      });
    }
  }, []);
  const cancel = useCallback(() => void desktopApi()?.terminal.cancel(id.current), []);
  return { ...state, run, cancel };
}

export function SourceControlPanel() {
  const root = useWorkspaceRoot();
  const runner = useExecutableRunner();
  const runCommand = runner.run;
  const [mode, setMode] = useState<"status" | "diff" | "history">("status");
  const execute = useCallback(
    (next: typeof mode) => {
      setMode(next);
      const args =
        next === "status"
          ? ["status", "--short", "--branch"]
          : next === "diff"
            ? ["diff", "--no-ext-diff", "--stat", "--patch"]
            : ["log", "--oneline", "--decorate", "-n", "50"];
      if (root) void runCommand("git", args, root);
    },
    [root, runCommand],
  );
  useEffect(() => {
    if (root) execute("status");
  }, [execute, root]);
  return (
    <PanelFrame
      title="Source Control"
      subtitle={root || "No workspace selected"}
      icon={GitBranch}
      actions={
        <button
          type="button"
          title="Refresh source control"
          onClick={() => execute(mode)}
          className="icon-button"
        >
          <RefreshCw size={13} />
        </button>
      }
    >
      <Segmented
        value={mode}
        options={["status", "diff", "history"]}
        onChange={(value) => execute(value as typeof mode)}
      />
      <CommandOutput runner={runner} empty="No source-control output." />
    </PanelFrame>
  );
}

export function WorkspaceSearchPanel() {
  const root = useWorkspaceRoot();
  const runner = useExecutableRunner();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"search" | "problems">("search");
  const [problems, setProblems] = useState<IdeDiagnostic[]>([]);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [problemsError, setProblemsError] = useState("");
  const search = () => {
    if (!root || !query.trim()) return;
    void runner.run(
      "rg",
      [
        "--line-number",
        "--column",
        "--no-heading",
        "--color",
        "never",
        "--hidden",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.git/**",
        "--glob",
        "!dist/**",
        "--",
        query.trim(),
        ".",
      ],
      root,
    );
  };
  const loadProblems = useCallback(async () => {
    if (!root) return;
    const api = desktopApi();
    if (!api) {
      setProblemsError("Workspace diagnostics are unavailable.");
      return;
    }
    setProblemsLoading(true);
    setProblemsError("");
    try {
      setProblems(await api.ide.workspaceDiagnostics({ root }));
    } catch (error) {
      setProblemsError(error instanceof Error ? error.message : String(error));
    } finally {
      setProblemsLoading(false);
    }
  }, [root]);
  const switchMode = (next: string) => {
    const value = next as typeof mode;
    setMode(value);
    if (value === "problems") void loadProblems();
  };
  return (
    <PanelFrame
      title="Search & Problems"
      subtitle={root || "No workspace selected"}
      icon={Search}
      actions={
        mode === "problems" ? (
          <button
            type="button"
            title="Refresh diagnostics"
            disabled={problemsLoading || !root}
            onClick={() => void loadProblems()}
            className="icon-button"
          >
            <RefreshCw size={13} className={problemsLoading ? "animate-spin" : ""} />
          </button>
        ) : undefined
      }
    >
      <Segmented value={mode} options={["search", "problems"]} onChange={switchMode} />
      {mode === "search" ? (
        <>
          <div className="flex gap-1.5">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") search();
              }}
              placeholder="Search files safely with ripgrep"
              className="ui-field min-w-0 flex-1 py-1.5 text-[12px]"
            />
            <button
              type="button"
              disabled={!query.trim() || !root || runner.running}
              onClick={search}
              className="ui-button ui-button-primary"
            >
              <Search size={12} /> Search
            </button>
          </div>
          <CommandOutput runner={runner} empty="Enter a query to search the workspace." />
        </>
      ) : (
        <ProblemsList
          loading={problemsLoading}
          error={problemsError}
          problems={problems}
          root={root}
        />
      )}
    </PanelFrame>
  );
}

export function TasksTestsPanel() {
  const root = useWorkspaceRoot();
  const runner = useExecutableRunner();
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const [packageManager, setPackageManager] = useState<"pnpm" | "npm" | "yarn" | "bun">("npm");
  useEffect(() => {
    let canceled = false;
    setScripts({});
    setLoadError("");
    if (!root) return;
    const api = desktopApi();
    if (!api) {
      setLoadError("Workspace task discovery is unavailable.");
      return;
    }
    void Promise.all([
      api.ide.readFile({ root, filePath: `${root}/package.json` }),
      api.ide.tree({ root }),
    ])
      .then(([file, tree]) => {
        if (canceled) return;
        const parsed = JSON.parse(file.content) as {
          scripts?: Record<string, unknown>;
          packageManager?: string;
        };
        setScripts(
          Object.fromEntries(
            Object.entries(parsed.scripts ?? {}).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string" &&
                /^[a-zA-Z0-9_.:][a-zA-Z0-9_.:-]{0,99}$/.test(entry[0]),
            ),
          ),
        );
        const names = new Set((tree.children ?? []).map((item) => item.name));
        const declared = parsed.packageManager?.split("@")[0];
        setPackageManager(
          declared === "pnpm" || declared === "npm" || declared === "yarn" || declared === "bun"
            ? declared
            : names.has("pnpm-lock.yaml")
              ? "pnpm"
              : names.has("yarn.lock")
                ? "yarn"
                : names.has("bun.lock") || names.has("bun.lockb")
                  ? "bun"
                  : "npm",
        );
      })
      .catch((error) => {
        if (!canceled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      canceled = true;
    };
  }, [root]);
  return (
    <PanelFrame
      title="Tasks & Tests"
      subtitle={`Workspace package scripts · ${packageManager}`}
      icon={Play}
    >
      {loadError ? <InlineError>{loadError}</InlineError> : null}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {Object.entries(scripts).map(([name, command]) => (
          <button
            key={name}
            type="button"
            disabled={runner.running}
            onClick={() => void runner.run(packageManager, ["run", name], root)}
            className="border-border-subtle bg-surface/50 hover:bg-surface-hover flex min-w-0 items-center gap-2 rounded-lg border p-2 text-left disabled:opacity-50"
          >
            <Play size={12} className="text-success shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="text-fg block text-[12px] font-medium">{name}</span>
              <span className="text-subtle block truncate font-mono text-[10px]">{command}</span>
            </span>
          </button>
        ))}
      </div>
      {!loadError && !Object.keys(scripts).length ? (
        <p className="text-subtle text-[12px]">No package scripts discovered.</p>
      ) : null}
      <CommandOutput runner={runner} empty="Run a task to see its output." />
    </PanelFrame>
  );
}

export function PreviewHubPanel() {
  const root = useWorkspaceRoot();
  const [mode, setMode] = useState<"markdown" | "web">("markdown");
  const [filePath, setFilePath] = useState("README.md");
  const [markdown, setMarkdown] = useState("");
  const [url, setUrl] = useState("http://localhost:3000");
  const [error, setError] = useState("");
  const loadMarkdown = useCallback(async () => {
    if (!root) return;
    setError("");
    try {
      const relative = filePath.replace(/^[/\\]+/, "");
      const file = await desktopApi()?.ide.readFile({ root, filePath: `${root}/${relative}` });
      if (!file) throw new Error("Preview runtime is unavailable.");
      setMarkdown(file.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [filePath, root]);
  useEffect(() => {
    if (root && mode === "markdown") void loadMarkdown();
  }, [loadMarkdown, mode, root]);
  return (
    <PanelFrame title="Preview" subtitle="Markdown and local web applications" icon={FileSearch}>
      <Segmented
        value={mode}
        options={["markdown", "web"]}
        onChange={(value) => setMode(value as typeof mode)}
      />
      {mode === "markdown" ? (
        <>
          <div className="flex gap-1.5">
            <input
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadMarkdown();
              }}
              className="ui-field min-w-0 flex-1 py-1.5 text-[12px]"
            />
            <button
              type="button"
              onClick={() => void loadMarkdown()}
              className="ui-button ui-button-primary"
            >
              Open
            </button>
          </div>
          {error ? (
            <InlineError>{error}</InlineError>
          ) : (
            <div className="border-border-subtle bg-surface/40 min-h-0 flex-1 overflow-auto rounded-lg border p-3">
              <Markdown allowRemoteContent={false}>{markdown}</Markdown>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex gap-1.5">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="ui-field min-w-0 flex-1 py-1.5 text-[12px]"
            />
          </div>
          <iframe
            src={safePreviewUrl(url)}
            title="Workspace web preview"
            sandbox="allow-scripts allow-forms"
            className="border-border-subtle min-h-0 flex-1 rounded-lg border bg-white"
          />
        </>
      )}
    </PanelFrame>
  );
}

export function AgentControlPanel() {
  const session = useChatStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const providers = useAspStore((state) => state.providers);
  const activeProviderId = useAspStore((state) => state.activeProviderId);
  const sessionProviderId = session?.providerId;
  const sessionStatus = session?.status;
  const contextUsage = useMemo(
    () => (session ? contextUsageForSession(session, providers) : undefined),
    [providers, session],
  );
  const provider = providers.find((item) => item.id === (sessionProviderId || activeProviderId));
  const records = useExtensionStore((state) => state.records);
  const activeExtensions = records.filter((record) => record.enabled && record.state !== "blocked");
  const contextValue = contextUsage
    ? `${contextUsage.usedKnown === false ? "Unknown" : contextUsage.used.toLocaleString()} / ${contextUsage.size.toLocaleString()}`
    : "Not reported";
  return (
    <PanelFrame
      title="Agent Control Center"
      subtitle="Runtime, context and extension state"
      icon={Bot}
    >
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Agent" value={provider?.name || "Not selected"} />
        <Metric label="Run state" value={sessionStatus || "idle"} />
        <Metric
          label="Model"
          value={provider?.models?.find((model) => model.isDefault)?.displayName || "Default"}
        />
        <Metric label="Context" value={contextValue} />
      </div>
      <section>
        <h3 className="section-title">Enabled extensions</h3>
        <div className="flex flex-col gap-1">
          {activeExtensions.map((record) => (
            <div
              key={record.id}
              className="bg-surface/50 flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]"
            >
              <CheckCircle2 size={11} className="text-success" />
              <span className="text-fg min-w-0 flex-1 truncate">
                {record.manifest.displayName || record.id}
              </span>
              <span className="text-subtle">{record.state}</span>
            </div>
          ))}
        </div>
      </section>
      <button
        type="button"
        onClick={() => useShellStore.getState().openDetailPanel("agent-tools")}
        className="ui-button ui-button-primary self-start"
      >
        Manage MCP, Skills & Prompts
      </button>
    </PanelFrame>
  );
}

function PanelFrame({
  title,
  subtitle,
  icon: Icon,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  icon: typeof Bot;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <header className="flex items-start gap-2">
        <Icon size={15} className="text-info mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="text-fg text-[13px] font-semibold">{title}</h2>
          <p className="text-subtle truncate text-[10px]" title={subtitle}>
            {subtitle}
          </p>
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange(value: string): void;
}) {
  return (
    <div className="bg-surface/60 flex rounded-lg p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[10px] capitalize",
            value === option ? "bg-surface-hover text-fg" : "text-subtle hover:text-fg",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function CommandOutput({
  runner,
  empty,
}: {
  runner: ReturnType<typeof useExecutableRunner>;
  empty: string;
}) {
  return (
    <div className="border-border-subtle bg-code-bg relative min-h-0 flex-1 overflow-auto rounded-lg border p-2">
      {runner.running ? (
        <button
          type="button"
          onClick={runner.cancel}
          className="bg-surface text-warning absolute top-2 right-2 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px]"
        >
          <Square size={9} /> Stop
        </button>
      ) : null}
      {runner.error ? <InlineError>{runner.error}</InlineError> : null}
      <pre className="text-muted font-mono text-[11px] leading-5 break-words whitespace-pre-wrap">
        {runner.output || (runner.running ? "Running…" : empty)}
      </pre>
    </div>
  );
}

function ProblemsList({
  loading,
  error,
  problems,
  root,
}: {
  loading: boolean;
  error: string;
  problems: IdeDiagnostic[];
  root: string;
}) {
  if (error) return <InlineError>{error}</InlineError>;
  if (loading)
    return (
      <div className="text-subtle flex min-h-0 flex-1 items-center justify-center text-[11px]">
        <RefreshCw size={12} className="mr-1.5 animate-spin" /> Analyzing workspace…
      </div>
    );
  if (!problems.length)
    return (
      <div className="border-border-subtle bg-surface/30 text-subtle flex min-h-0 flex-1 items-center justify-center rounded-lg border text-[11px]">
        <CheckCircle2 size={13} className="text-success mr-1.5" /> No TypeScript or JavaScript
        problems found.
      </div>
    );
  return (
    <div className="border-border-subtle bg-surface/30 min-h-0 flex-1 overflow-auto rounded-lg border">
      {problems.map((problem, index) => {
        const relative = problem.filePath.startsWith(root)
          ? problem.filePath.slice(root.length).replace(/^[/\\]/, "")
          : problem.filePath;
        return (
          <div
            key={`${problem.filePath}:${problem.start}:${index}`}
            className="border-border-subtle flex gap-2 border-b p-2 last:border-b-0"
          >
            <AlertTriangle
              size={12}
              className={cn(
                "mt-0.5 shrink-0",
                problem.severity === "error" ? "text-danger" : "text-warning",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-fg text-[11px] leading-4">{problem.message}</p>
              <p
                className="text-subtle mt-0.5 truncate font-mono text-[9px]"
                title={problem.filePath}
              >
                {relative}:{problem.line}:{problem.column} · {problem.source}
                {problem.code ? ` ${problem.code}` : ""}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-danger/30 bg-danger/5 text-danger mb-2 flex items-start gap-1.5 rounded-md border p-2 text-[11px]">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border-subtle bg-surface/40 rounded-lg border p-2">
      <div className="text-subtle text-[9px] tracking-wide uppercase">{label}</div>
      <div className="text-fg mt-0.5 truncate text-[11px] font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

function safePreviewUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : "about:blank";
  } catch {
    return "about:blank";
  }
}

function isTerminalEvent(value: unknown): value is TerminalRunEvent {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as TerminalRunEvent).id === "string" &&
    typeof (value as TerminalRunEvent).type === "string",
  );
}
