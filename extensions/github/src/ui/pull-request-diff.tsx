import "./styles.css";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  aguiCommand,
  githubLanguage,
  numberValue,
  recordValue,
  stringValue,
  useAguiData,
} from "./common";
import { mount } from "./mount";

type Metadata = {
  language: "en" | "zh";
  number: number;
  repository: string;
  title: string;
};

type DiffFile = Record<string, unknown>;
type DiffResult = Record<string, unknown> & { files?: DiffFile[] };

type ViewState =
  | { kind: "state"; message: string; tone?: "error" }
  | { kind: "diff"; metadata: Metadata; result: DiffResult };

function readMetadata(data: unknown): Metadata | null {
  const tree = recordValue(recordValue(data).sessionTree);
  const metadata = recordValue(tree.metadata);
  const provider = stringValue(metadata.provider);
  const kind = stringValue(metadata.kind);
  const repository = stringValue(metadata.repository).trim();
  const number = Number(metadata.number || 0);
  if (provider !== "github" || kind !== "pull_request") return null;
  if (!repository || !Number.isInteger(number) || number <= 0) return null;
  return {
    language: githubLanguage(metadata.language),
    number,
    repository,
    title: stringValue(metadata.title),
  };
}

function languageFromData(data: unknown): "en" | "zh" {
  const tree = recordValue(recordValue(data).sessionTree);
  const metadata = recordValue(tree.metadata);
  return githubLanguage(metadata.language);
}

function copy(metadata: Metadata | null, data?: unknown) {
  const zh = metadata?.language === "zh" || languageFromData(data) === "zh";
  return {
    added: zh ? "新增" : "added",
    changed: zh ? "变更" : "changed",
    copied: zh ? "复制" : "copied",
    deleted: zh ? "删除" : "deleted",
    empty: zh ? "这个 PR 没有可显示的文本修改。" : "This PR has no text diff to show.",
    error: zh ? "加载 PR 修改失败" : "Failed to load PR diff",
    file: zh ? "个文件" : "file",
    files: zh ? "文件" : "files",
    loading: zh ? "正在加载 PR 修改..." : "Loading PR diff...",
    noPatch: zh ? "这个文件没有可显示的文本修改。" : "No text patch is available for this file.",
    notPr: zh
      ? "打开一个 GitHub PR 会话后查看修改。"
      : "Open a GitHub PR session to view its diff.",
    renamed: zh ? "重命名" : "renamed",
    title: zh ? "PR 修改" : "PR diff",
    truncated: zh ? "修改内容已截断。" : "Diff truncated.",
    unknown: zh ? "未知文件" : "Unknown file",
  };
}

function PullRequestDiff() {
  const data = useAguiData();
  const cache = useRef(new Map<string, DiffResult>());
  const activeKey = useRef("");
  const requestId = useRef(0);
  const [view, setView] = useState<ViewState>(() => ({
    kind: "state",
    message: copy(null, window.agui?.data).notPr,
  }));

  useEffect(() => {
    const metadata = readMetadata(data);
    const labels = copy(metadata, data);
    document.documentElement.lang = languageFromData(data);
    if (!metadata) {
      activeKey.current = "";
      setView({ kind: "state", message: labels.notPr });
      return;
    }

    const key = `${metadata.repository}#${metadata.number}`;
    activeKey.current = key;
    const cached = cache.current.get(key);
    if (cached) {
      setView({ kind: "diff", metadata, result: cached });
      return;
    }

    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setView({ kind: "state", message: labels.loading });
    aguiCommand("agui.github.pullRequestDiff", [
      {
        language: metadata.language,
        number: metadata.number,
        repository: metadata.repository,
      },
    ])
      .then((result) => {
        if (currentRequest !== requestId.current || activeKey.current !== key) return;
        const payload = recordValue(result) as DiffResult;
        cache.current.set(key, payload);
        setView({ kind: "diff", metadata, result: payload });
      })
      .catch((error) => {
        if (currentRequest !== requestId.current || activeKey.current !== key) return;
        const message = error instanceof Error ? error.message : String(error);
        setView({ kind: "state", message: `${labels.error}: ${message}`, tone: "error" });
      });
  }, [data]);

  if (view.kind === "state") {
    return (
      <div
        className={`flex h-full items-center justify-center p-6 text-center text-[var(--agui-muted)] ${
          view.tone === "error" ? "text-[#fca5a5]" : ""
        }`}
      >
        {view.message}
      </div>
    );
  }

  return <DiffView metadata={view.metadata} result={view.result} />;
}

function DiffView({ metadata, result }: { metadata: Metadata; result: DiffResult }) {
  const labels = copy(metadata);
  const files = Array.isArray(result.files) ? result.files.map(recordValue) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 gap-2 border-b border-[color-mix(in_srgb,var(--agui-border)_70%,transparent)] px-3 py-2.5">
        <div className="min-w-0">
          <strong className="block overflow-hidden text-[13px] font-bold text-ellipsis whitespace-nowrap">
            {labels.title} #{metadata.number}
          </strong>
          <span className="mt-0.5 block overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-[var(--agui-muted)]">
            {metadata.repository}
            {metadata.title ? ` - ${metadata.title}` : ""}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Pill>{fileCountLabel(numberValue(result.fileCount), labels)}</Pill>
          <Pill tone="add">+{sum(files, "additions")}</Pill>
          <Pill tone="del">-{sum(files, "deletions")}</Pill>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-2.5">
        {files.length ? (
          <>
            {files.map((file, index) => (
              <DiffFileView
                key={`${stringValue(file.filename)}:${index}`}
                file={file}
                labels={labels}
              />
            ))}
            {result.truncated ? <Notice>{labels.truncated}</Notice> : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[var(--agui-muted)]">
            {labels.empty}
          </div>
        )}
      </main>
    </div>
  );
}

function Pill({ children, tone }: { children: ReactNode; tone?: "add" | "del" }) {
  const toneClass = tone === "add" ? "text-[#86efac]" : tone === "del" ? "text-[#fca5a5]" : "";
  return (
    <span
      className={`rounded-full border border-[color-mix(in_srgb,var(--agui-border)_74%,transparent)] px-[7px] text-[11px] leading-[18px] whitespace-nowrap text-[var(--agui-muted)] ${toneClass}`}
    >
      {children}
    </span>
  );
}

function DiffFileView({ file, labels }: { file: DiffFile; labels: ReturnType<typeof copy> }) {
  const patch = stringValue(file.patch);
  return (
    <details
      className="mb-2.5 overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--agui-border)_70%,transparent)] bg-[color-mix(in_srgb,var(--agui-surface)_92%,transparent)]"
      open
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <span
          className="min-w-0 flex-1 overflow-hidden font-mono text-ellipsis whitespace-nowrap"
          title={stringValue(file.filename)}
        >
          {stringValue(file.filename) || labels.unknown}
        </span>
        <span className="shrink-0 text-[var(--agui-muted)] lowercase">
          {fileStatusLabel(stringValue(file.status), labels)}
        </span>
        <span className="shrink-0 text-[#86efac]">+{numberValue(file.additions)}</span>
        <span className="shrink-0 text-[#fca5a5]">-{numberValue(file.deletions)}</span>
      </summary>

      {patch ? (
        <pre className="m-0 overflow-auto border-t border-[color-mix(in_srgb,var(--agui-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--agui-canvas)_88%,transparent)] py-2">
          <code className="block min-w-max font-mono text-[11px] leading-[18px]">
            {patch.split("\n").map((line, index) => (
              <span
                key={index}
                className={`block min-h-[18px] px-2.5 whitespace-pre ${lineClass(line)}`}
              >
                {line}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <Notice>{labels.noPatch}</Notice>
      )}
      {file.truncated ? <Notice>{labels.truncated}</Notice> : null}
    </details>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <div className="border-t border-[color-mix(in_srgb,var(--agui-border)_60%,transparent)] px-2.5 py-2 text-[var(--agui-muted)]">
      {children}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) {
    return "bg-[color-mix(in_srgb,var(--agui-accent)_14%,transparent)] text-[#bfdbfe]";
  }
  if (line.startsWith("+")) {
    return "bg-[color-mix(in_srgb,#22c55e_16%,transparent)] text-[#bbf7d0]";
  }
  if (line.startsWith("-")) {
    return "bg-[color-mix(in_srgb,#ef4444_16%,transparent)] text-[#fecaca]";
  }
  return "";
}

function sum(files: DiffFile[], key: string): number {
  return files.reduce((total, file) => total + numberValue(file[key]), 0);
}

function fileCountLabel(count: number, labels: ReturnType<typeof copy>): string {
  if (labels.file === "个文件") return `${count} ${labels.file}`;
  return `${count} ${count === 1 ? labels.file : labels.files}`;
}

function fileStatusLabel(status: string, labels: ReturnType<typeof copy>): string {
  return (
    {
      added: labels.added,
      changed: labels.changed,
      copied: labels.copied,
      modified: labels.changed,
      removed: labels.deleted,
      renamed: labels.renamed,
    }[status] || status
  );
}

mount(<PullRequestDiff />);
