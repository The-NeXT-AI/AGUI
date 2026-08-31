import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  ExternalLink,
  FileCode2,
  FileText,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Pencil,
  Terminal as TerminalIcon,
  Wrench,
  X,
} from "lucide-react";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { McpAppBlock } from "./McpAppBlock";
import {
  emptyAnsiState,
  parseAnsi,
  parseAnsiWithState,
  type AnsiSegment,
  type AnsiState,
} from "./ansi";
import { useChatStore } from "./chat-store";
import { toast } from "@/ui/toast";
import { t } from "@/lib/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { WorkingDots } from "@/ui/working-dots";
import { ThinkingShimmer } from "@/ui/thinking-shimmer";
import { cn } from "@/ui/cn";
import { useCoarsePointer } from "@/ui/use-coarse-pointer";
import { AgentLogo } from "@/asp/AgentLogo";
import { desktopApi, type AspProvider, type InteractiveAppEvent } from "@/asp/desktop-api";
import { hiddenInteractiveAppViewBounds, interactiveAppViewBounds } from "./mcp-app-bridge";
import type {
  Attachment,
  DiffHunk,
  DiffReview,
  InteractiveAppEmbed,
  ToolLocation,
  ToolStatus,
} from "./types";

export { McpAppBlock } from "./McpAppBlock";

/* Each block is memoized so a streaming delta only re-renders the one block
 * whose content changed, not the whole stream. */

export const UserMessage = memo(function UserMessage({
  id,
  text,
  attachments,
  at,
}: {
  id: string;
  text: string;
  attachments?: Attachment[];
  at?: number;
}) {
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const [copied, setCopied] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const coarsePointer = useCoarsePointer();
  const hasAttachments = !!attachments && attachments.length > 0;
  const sentTime = formatMessageTime(at);
  const toolbarVisible = toolbarOpen || coarsePointer;

  const copyMessage = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(t("message.copyFailed"));
    }
  };

  return (
    <div
      data-chat-message="user"
      className="relative flex flex-col items-end gap-1.5 pb-6"
      onMouseEnter={() => setToolbarOpen(true)}
      onMouseLeave={() => setToolbarOpen(false)}
      onFocusCapture={() => setToolbarOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setToolbarOpen(false);
      }}
    >
      {hasAttachments ? (
        <div className="flex max-w-[92%] flex-wrap justify-end gap-1.5 sm:max-w-[85%]">
          {attachments!.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      ) : null}
      {text ? (
        <p className="bg-surface-hover text-fg max-w-[92%] rounded-2xl rounded-br-sm px-3.5 py-2 text-[14px] leading-6 whitespace-pre-wrap sm:max-w-[85%] sm:text-[13px] sm:leading-normal">
          {text}
        </p>
      ) : null}
      <div
        aria-hidden={!toolbarVisible}
        className={cn(
          "text-subtle absolute inset-x-0 bottom-0 z-10 flex h-5 items-center justify-end gap-2 text-[13px] transition-opacity",
          toolbarVisible ? "visible opacity-100" : "invisible opacity-0",
        )}
      >
        {sentTime ? <span className="tabular-nums">{sentTime}</span> : null}
        <button
          type="button"
          title={copied ? t("common.copied") : t("message.copy")}
          aria-label={copied ? t("common.copied") : t("message.copy")}
          onClick={copyMessage}
          className="hover:bg-surface-hover hover:text-fg flex h-5 w-5 items-center justify-center rounded-md transition-colors"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          title={t("message.edit")}
          aria-label={t("message.edit")}
          onClick={() => editUserMessage(id)}
          className="hover:bg-surface-hover hover:text-fg flex h-5 w-5 items-center justify-center rounded-md transition-colors"
        >
          <Pencil size={14} />
        </button>
      </div>
    </div>
  );
});

function formatMessageTime(at?: number): string | null {
  if (!at) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === "image" && attachment.url) {
    return (
      <img
        src={attachment.url}
        alt={attachment.name}
        className="border-border-subtle max-h-40 rounded-lg border object-cover"
      />
    );
  }
  return (
    <div className="border-border-subtle bg-surface text-muted flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px]">
      {isBrowserAnnotationsAttachment(attachment) ? (
        <MessageSquare size={13} className="shrink-0" />
      ) : (
        <Paperclip size={13} className="shrink-0" />
      )}
      <span className="max-w-[160px] truncate">{attachment.name}</span>
    </div>
  );
}

function isBrowserAnnotationsAttachment(attachment: Attachment): boolean {
  return (
    attachment.source === "browser_annotations" || attachment.id.startsWith("browser-annotations:")
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  externalPreviewsDefaultExpanded = false,
  text,
  streaming,
}: {
  externalPreviewsDefaultExpanded?: boolean;
  text: string;
  streaming: boolean;
}) {
  const streamedRef = useRef(false);
  if (streaming) streamedRef.current = true;

  const externalLinks = useMemo(
    () => (streaming ? [] : extractExternalPreviewLinks(text)),
    [streaming, text],
  );

  // Waiting for the first token: show the AGUI "working" dots.
  if (streaming && !text) {
    return (
      <div className="py-1.5 text-[14px]">
        <ThinkingShimmer />
      </div>
    );
  }
  return (
    <div data-chat-message="assistant" className="relative">
      {streaming ? (
        <StreamingMarkdown text={text} />
      ) : (
        <Markdown renderMode={streamedRef.current ? "deferred" : "full"}>{text}</Markdown>
      )}
      {externalLinks.length ? (
        <div className="mt-3 space-y-2">
          {externalLinks.map((url) => (
            <ExternalLinkPreview
              key={url}
              defaultExpanded={externalPreviewsDefaultExpanded}
              url={url}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});

function ExternalLinkPreview({ defaultExpanded, url }: { defaultExpanded: boolean; url: string }) {
  const nativeMountRef = useRef<HTMLDivElement>(null);
  const nativeApi = desktopApi()?.interactiveApp;
  const useNativeView = Boolean(nativeApi && desktopApi()?.features.webContentsView);
  const nativeViewId = useRef(`external-link-view-${Math.random().toString(36).slice(2)}`).current;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [error, setError] = useState("");
  const [faviconFailed, setFaviconFailed] = useState(false);
  const title = externalLinkTitle(url);
  const faviconUrl = faviconFailed ? undefined : externalLinkFaviconUrl(url);
  const showPreview = expanded && !error;

  useEffect(() => {
    setExpanded(defaultExpanded);
    setError("");
    setFaviconFailed(false);
  }, [defaultExpanded, url]);

  useEffect(() => {
    if (!expanded || !useNativeView || !nativeApi) return undefined;
    let disposed = false;
    setError("");
    const syncBounds = () => {
      void nativeApi
        .setBounds({
          id: nativeViewId,
          bounds: interactiveAppViewBounds(nativeMountRef.current),
        })
        .catch(() => undefined);
    };
    void nativeApi
      .create({
        id: nativeViewId,
        bridge: false,
        url,
        title,
        bounds: interactiveAppViewBounds(nativeMountRef.current),
        userAgent: externalLinkUserAgent(url),
        userStyle: EXTERNAL_LINK_PREVIEW_USER_STYLE,
      })
      .then(() => {
        if (disposed) return;
        syncBounds();
      })
      .catch((loadError) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    const observer = new ResizeObserver(syncBounds);
    if (nativeMountRef.current) observer.observe(nativeMountRef.current);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    const timer = window.setInterval(syncBounds, 300);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      window.clearInterval(timer);
      void nativeApi.destroy(nativeViewId).catch(() => undefined);
    };
  }, [expanded, nativeApi, nativeViewId, title, url, useNativeView]);

  useEffect(() => {
    if (!expanded || !useNativeView || !nativeApi) return undefined;
    return nativeApi.onEvent((event: InteractiveAppEvent) => {
      if (event.id !== nativeViewId) return;
      if (event.type === "failed") {
        setError(event.error);
        void nativeApi
          .setBounds({ id: nativeViewId, bounds: hiddenInteractiveAppViewBounds() })
          .catch(() => undefined);
        return;
      }
      if (event.type === "gone") {
        setError(`Embedded page process exited (${event.reason}).`);
        void nativeApi
          .setBounds({ id: nativeViewId, bounds: hiddenInteractiveAppViewBounds() })
          .catch(() => undefined);
      }
    });
  }, [expanded, nativeApi, nativeViewId, useNativeView]);

  return (
    <div
      data-external-link-preview
      className="border-border-subtle bg-surface/60 max-w-[760px] overflow-hidden rounded-md border"
    >
      <div className="bg-surface/70 flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[12px]">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-fg flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <ChevronRight
            size={14}
            className={cn("text-subtle shrink-0 transition-transform", expanded && "rotate-90")}
          />
          <span className="bg-surface-hover flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px]">
            {faviconUrl ? (
              <img
                src={faviconUrl}
                alt=""
                className="h-3.5 w-3.5 object-contain"
                onError={() => setFaviconFailed(true)}
              />
            ) : (
              <ExternalLink size={12} className="text-info" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          {error ? (
            <span className="text-danger shrink-0 text-[11px] font-medium">
              {t("preview.failed")}
            </span>
          ) : null}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={url}
          onClick={(event) => event.stopPropagation()}
          className="text-subtle hover:text-info shrink-0 transition-colors"
        >
          <ExternalLink size={13} />
        </a>
      </div>
      {showPreview ? (
        useNativeView ? (
          <div
            ref={nativeMountRef}
            data-external-link-native-view
            className="border-border-subtle block w-full border-t bg-white"
            style={{ height: EXTERNAL_LINK_PREVIEW_HEIGHT }}
          />
        ) : (
          <iframe
            title={title}
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            className="border-border-subtle block w-full border-t bg-white"
            style={{ height: EXTERNAL_LINK_PREVIEW_HEIGHT }}
          />
        )
      ) : null}
      {expanded && error ? (
        <div className="border-border-subtle text-danger border-t px-2.5 py-2 text-[12px] leading-5">
          <span className="font-medium">{t("preview.failed")}</span>{" "}
          <span className="text-danger/80">{compactPreviewError(error)}</span>
        </div>
      ) : null}
    </div>
  );
}

const EXTERNAL_LINK_PREVIEW_HEIGHT = 320;

// Keep empty until a domain has been explicitly approved for embedded previews.
const EXTERNAL_LINK_PREVIEW_HOST_ALLOWLIST: readonly string[] = [];

const EXTERNAL_LINK_PREVIEW_USER_STYLE = `
html {
  scrollbar-color: rgba(90, 90, 90, 0.32) transparent;
  scrollbar-width: thin;
}
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(90, 90, 90, 0.26);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(90, 90, 90, 0.42);
  border: 2px solid transparent;
  background-clip: padding-box;
}
`;

function extractExternalPreviewLinks(text: string): string[] {
  const links = new Set<string>();
  const markdownLinkPattern = /!?\[[^\]]*]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/gi;
  for (const match of text.matchAll(markdownLinkPattern)) {
    addExternalPreviewLink(links, match[1]);
  }
  const plainUrlPattern = /https?:\/\/[^\s<>"']+/gi;
  for (const match of text.matchAll(plainUrlPattern)) {
    addExternalPreviewLink(links, match[0]);
  }
  return [...links];
}

function addExternalPreviewLink(links: Set<string>, value: string | undefined): void {
  const url = normalizeExternalPreviewUrl(value);
  if (url) links.add(url);
}

function normalizeExternalPreviewUrl(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim().replace(/[)\].,，。!?！？]+$/u, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!isExternalPreviewHostAllowed(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function isExternalPreviewHostAllowed(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return EXTERNAL_LINK_PREVIEW_HOST_ALLOWLIST.some((allowedHost) => {
    const normalizedAllowedHost = allowedHost.toLowerCase();
    return (
      normalizedHostname === normalizedAllowedHost ||
      normalizedHostname.endsWith(`.${normalizedAllowedHost}`)
    );
  });
}

function externalLinkTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || "Embedded page";
  } catch {
    return "Embedded page";
  }
}

function externalLinkFaviconUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return new URL("/favicon.ico", parsed).toString();
  } catch {
    return undefined;
  }
}

function externalLinkUserAgent(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.startsWith("m.") || hostname.includes(".mcd.cn")) return MOBILE_SAFARI_USER_AGENT;
  } catch {
    return undefined;
  }
  return undefined;
}

function compactPreviewError(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  if (!text) return "Open the link externally to continue.";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function toolParamPreview(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    return truncateToolParam(toolParamValue(value));
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue != null && toolParamValue(entryValue).trim() !== "")
    .slice(0, 3)
    .map(([key, entryValue]) => `${key}: ${toolParamValue(entryValue)}`);
  if (!entries.length) return null;
  const suffix = Object.keys(value).length > entries.length ? ", ..." : "";
  return truncateToolParam(`${entries.join(", ")}${suffix}`);
}

function toolParamValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).replace(/\s+/g, " ");
  } catch {
    return String(value).replace(/\s+/g, " ").trim();
  }
}

function truncateToolParam(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  return text.length > 96 ? `${text.slice(0, 95)}…` : text;
}

const MOBILE_SAFARI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function ProcessDisclosureHeader({
  expandable = true,
  agentLogo,
  icon,
  label,
  open,
  status,
  onToggle,
}: {
  expandable?: boolean;
  agentLogo?: ReactNode;
  icon: ReactNode;
  label: string;
  open: boolean;
  status?: ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable}
      onClick={onToggle}
      className={cn(
        "text-muted flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left text-[13px] transition-colors",
        expandable ? "hover:text-fg" : "cursor-default",
      )}
    >
      {agentLogo}
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {status ? <span className="shrink-0">{status}</span> : null}
      {expandable ? (
        <ChevronRight
          size={15}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
      ) : null}
    </button>
  );
}

function ToolDisclosureHeader({
  expandable = true,
  agentLogo,
  icon,
  label,
  open,
  params,
  onToggle,
}: {
  expandable?: boolean;
  agentLogo?: ReactNode;
  icon: ReactNode;
  label: string;
  open: boolean;
  params: string | null;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable}
      onClick={onToggle}
      className={cn(
        "group/tool text-muted flex w-full min-w-0 items-center gap-1.5 overflow-hidden py-1.5 text-left text-[13px] transition-colors",
        expandable ? "hover:text-fg" : "cursor-default",
      )}
    >
      {agentLogo}
      {icon}
      <span className="max-w-[40%] shrink-0 truncate">{label}</span>
      {params ? (
        <span
          title={params}
          className="text-subtle max-w-[min(36rem,70%)] min-w-0 truncate text-[13px]"
        >
          {params}
        </span>
      ) : null}
      {expandable ? (
        <ChevronRight
          size={15}
          className={cn(
            "shrink-0 opacity-0 transition-[opacity,transform]",
            open
              ? "rotate-90 opacity-100"
              : "group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100",
          )}
        />
      ) : null}
    </button>
  );
}

export const ReasoningBlock = memo(function ReasoningBlock({
  agentProvider,
  agentProviderId,
  text,
  streaming,
}: {
  agentProvider?: AspProvider;
  agentProviderId?: string;
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <div>
      <ProcessDisclosureHeader
        agentLogo={
          agentProviderId ? (
            <AgentLogo provider={agentProvider} compact className="h-4 w-4" />
          ) : undefined
        }
        icon={<Brain size={14} className="shrink-0" />}
        label="Reasoning"
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      <CollapsibleRegion open={open} lazy={!streaming}>
        <div className="text-subtle px-6 py-2 text-[12px] leading-5">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </CollapsibleRegion>
    </div>
  );
});

function CollapsibleRegion({
  open,
  children,
  lazy = false,
}: {
  open: boolean;
  children: ReactNode;
  lazy?: boolean;
}) {
  const shouldRender = !lazy || open;
  return (
    <div
      aria-hidden={!open}
      data-collapsible-region
      data-open={open ? "true" : "false"}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{shouldRender ? children : null}</div>
    </div>
  );
}

export const PlanTodoList = memo(function PlanTodoList({
  todos,
}: {
  todos: { content: string; status: string }[];
}) {
  return (
    <div className="border-border-subtle bg-surface/60 rounded-md border">
      <div className="text-muted flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium">
        <ListTodo size={13} />
        Plan
      </div>
      <ul className="border-border-subtle border-t px-3 py-1.5">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2 py-0.5 text-[13px]">
            <TodoIcon status={todo.status} />
            <span className={cn(todo.status === "completed" && "text-subtle line-through")}>
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});

function TodoIcon({ status }: { status: string }) {
  if (status === "completed")
    return <CheckCircle2 size={15} className="text-success mt-0.5 shrink-0" />;
  if (status === "in_progress") return <WorkingDots className="text-fg mt-1 shrink-0" />;
  return <Circle size={15} className="text-subtle mt-0.5 shrink-0" />;
}

export const TerminalBlock = memo(function TerminalBlock({
  command,
  cwd,
  output,
  status,
}: {
  command: string;
  cwd?: string;
  output: string;
  status: ToolStatus;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="font-mono">
      <ProcessDisclosureHeader
        icon={<TerminalIcon size={14} className="text-info shrink-0" />}
        label={command}
        open={open}
        status={<ToolStatusDot status={status} />}
        onToggle={() => setOpen((value) => !value)}
      />
      {cwd && open ? <div className="text-subtle px-6 pt-2 text-[11px]">{cwd}</div> : null}
      {open ? (
        <pre className="bg-code-bg mt-2 ml-6 max-h-80 overflow-auto rounded-md px-3 py-2 text-[12px] leading-relaxed">
          <TerminalOutput output={output} running={status === "running"} />
        </pre>
      ) : null}
    </div>
  );
});

function TerminalOutput({ output, running }: { output: string; running: boolean }) {
  const streaming = useStreamingAnsiSegments(output);
  const finalSegments = useDeferredAnsiSegments(output, !running);
  const segments = finalSegments ?? streaming.segments;
  const tailSegments = finalSegments ? [] : streaming.tailSegments;

  if (!output) return <span className="text-subtle">…</span>;
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i} className={seg.cls}>
          {seg.text}
        </span>
      ))}
      {tailSegments.map((seg, i) => (
        <span key={`tail-${i}`} className={seg.cls}>
          {seg.text}
        </span>
      ))}
    </>
  );
}

function useStreamingAnsiSegments(output: string): {
  segments: AnsiSegment[];
  tailSegments: AnsiSegment[];
} {
  const stableEnd = terminalStableOutputEnd(output);
  const stable = output.slice(0, stableEnd);
  const tail = output.slice(stableEnd);
  const cacheRef = useRef<{
    segments: AnsiSegment[];
    state: AnsiState;
    text: string;
  }>({ segments: [], state: emptyAnsiState(), text: "" });

  const segments = useMemo(() => {
    const cached = cacheRef.current;
    if (stable === cached.text) return cached.segments;

    const incremental = stable.length >= cached.text.length;
    const parsed = incremental
      ? parseAnsiWithState(stable.slice(cached.text.length), cached.state)
      : parseAnsiWithState(stable);
    const segments = incremental
      ? appendAnsiSegments(cached.segments, parsed.segments)
      : parsed.segments;

    cacheRef.current = { segments, state: parsed.state, text: stable };
    return segments;
  }, [stable]);

  const tailSegments = useMemo(
    () => (tail ? parseAnsiWithState(tail, cacheRef.current.state).segments : []),
    [tail],
  );

  return { segments, tailSegments };
}

function useDeferredAnsiSegments(output: string, enabled: boolean): AnsiSegment[] | null {
  const [state, setState] = useState<{ output: string; segments: AnsiSegment[] | null }>(() => ({
    output,
    segments: null,
  }));

  useEffect(() => {
    if (!enabled || !output) return undefined;
    let active = true;
    setState({ output, segments: null });
    const cancel = scheduleIdleWork(() => {
      const segments = parseAnsi(output);
      if (active) setState({ output, segments });
    });
    return () => {
      active = false;
      cancel();
    };
  }, [enabled, output]);

  return enabled && state.output === output ? state.segments : null;
}

function terminalStableOutputEnd(output: string): number {
  const newline = output.lastIndexOf("\n");
  return newline === -1 ? 0 : newline + 1;
}

function appendAnsiSegments(existing: AnsiSegment[], next: AnsiSegment[]): AnsiSegment[] {
  if (!existing.length) return next;
  if (!next.length) return existing;
  const last = existing[existing.length - 1]!;
  const first = next[0]!;
  if (last.cls === first.cls) {
    existing[existing.length - 1] = { cls: last.cls, text: last.text + first.text };
    existing.push(...next.slice(1));
    return existing;
  }
  existing.push(...next);
  return existing;
}

function scheduleIdleWork(callback: () => void): () => void {
  if (typeof window === "undefined") {
    const handle = setTimeout(callback, 0);
    return () => clearTimeout(handle);
  }
  if ("requestIdleCallback" in window) {
    const handle = window.requestIdleCallback(callback, { timeout: 300 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 16);
  return () => clearTimeout(handle);
}

export const ToolCallBlock = memo(function ToolCallBlock({
  agentProvider,
  agentProviderId,
  title,
  toolKind,
  output,
  rawInput,
  rawOutput,
  locations,
  status,
}: {
  agentProvider?: AspProvider;
  agentProviderId?: string;
  title: string;
  toolKind?: string;
  output: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: ToolLocation[];
  status: ToolStatus;
}) {
  const isReasoningTool = isReasoningToolBlock(title, toolKind);
  const activeReasoningTool = isReasoningTool && status === "running";
  const [open, setOpen] = useState(activeReasoningTool);
  const hasDetails = Boolean(output || rawOutput != null || rawInput != null || locations?.length);
  const expandable = hasDetails || isReasoningTool;
  const params = !isReasoningTool ? toolParamPreview(rawInput) : null;

  useEffect(() => {
    if (activeReasoningTool) setOpen(true);
  }, [activeReasoningTool]);

  return (
    <div>
      <ToolDisclosureHeader
        expandable={expandable}
        agentLogo={
          agentProviderId ? (
            <AgentLogo provider={agentProvider} compact className="h-4 w-4" />
          ) : undefined
        }
        icon={
          isReasoningTool ? (
            <Brain size={14} className="text-info shrink-0" />
          ) : (
            <Wrench size={14} className="text-info shrink-0" />
          )
        }
        label={isReasoningTool ? "Reasoning" : "Tool"}
        open={open}
        params={params}
        onToggle={() => expandable && setOpen((value) => !value)}
      />
      <CollapsibleRegion open={open && expandable} lazy={isReasoningTool && !activeReasoningTool}>
        <div className="px-6 py-2">
          {locations?.length ? (
            <div className="mb-2 flex flex-col gap-0.5">
              {locations.map((location) => (
                <span
                  key={`${location.path}:${location.line ?? ""}`}
                  className="text-info truncate font-mono text-[11px]"
                >
                  {location.path}
                  {location.line ? `:${location.line}` : ""}
                </span>
              ))}
            </div>
          ) : null}
          {output ? (
            <pre className="bg-code-bg text-muted max-h-64 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          ) : null}
          {!output && (rawOutput != null || rawInput != null) ? (
            <pre className="bg-code-bg text-muted max-h-64 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
              {formatToolValue(rawOutput ?? rawInput)}
            </pre>
          ) : null}
        </div>
      </CollapsibleRegion>
    </div>
  );
});

function isReasoningToolBlock(title: string, toolKind?: string): boolean {
  const kind = toolKind?.trim().toLowerCase();
  const name = title.trim().toLowerCase();
  return kind === "reasoning" || kind === "thinking" || name === "reasoning";
}

export const DiffBlock = memo(function DiffBlock({
  id,
  path,
  hunks,
  status,
  review,
}: {
  id: string;
  path: string;
  hunks: DiffHunk[];
  status: ToolStatus;
  review: DiffReview;
}) {
  const reviewDiff = useChatStore((s) => s.reviewDiff);
  const decide = (decision: DiffReview) => {
    reviewDiff(id, decision);
    if (decision === "accepted") toast.success(t("diff.accepted"));
    else toast.info(t("diff.rejected"));
  };

  return (
    <div
      className={cn(
        "border-border-subtle bg-code-bg overflow-hidden rounded-md border",
        review === "rejected" && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[12px]">
        <FileCode2 size={13} className="text-info" />
        <span className="text-fg truncate">{path}</span>
        <div className="ml-auto flex items-center gap-2">
          {review === "pending" ? (
            <div className="flex items-center gap-1 font-sans">
              <button
                type="button"
                onClick={() => decide("rejected")}
                className="ui-button ui-button-danger min-h-6 px-2 py-0.5 text-[11px]"
              >
                <X size={11} />
                {t("diff.reject")}
              </button>
              <button
                type="button"
                onClick={() => decide("accepted")}
                className="ui-button border-success/40 bg-success/15 text-success hover:border-success/50 hover:bg-success/25 hover:text-success min-h-6 px-2 py-0.5 text-[11px]"
              >
                <Check size={11} />
                {t("diff.accept")}
              </button>
            </div>
          ) : (
            <ReviewBadge review={review} />
          )}
          <ToolStatusDot status={status} />
        </div>
      </div>
      <pre className="border-border-subtle overflow-auto border-t font-mono text-[12px] leading-relaxed">
        {hunks.map((hunk, hi) =>
          hunk.lines.map((line, li) => (
            <div
              key={`${hi}-${li}`}
              className={cn(
                "px-3",
                line.type === "add" && "bg-success/10 text-success",
                line.type === "del" && "bg-danger/10 text-danger",
                line.type === "ctx" && "text-muted",
              )}
            >
              <span className="mr-2 opacity-50 select-none">
                {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
              </span>
              {line.text}
            </div>
          )),
        )}
      </pre>
    </div>
  );
});

function ReviewBadge({ review }: { review: DiffReview }) {
  if (review === "accepted")
    return (
      <span className="text-success flex items-center gap-1 font-sans text-[11px]">
        <Check size={12} />
        {t("diff.accept")}
      </span>
    );
  return (
    <span className="text-danger flex items-center gap-1 font-sans text-[11px]">
      <X size={12} />
      {t("diff.reject")}
    </span>
  );
}

type ReferenceBlockProps = {
  artifactId?: string;
  title?: string;
  name?: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  app?: InteractiveAppEmbed;
  sessionId?: string;
  agentProviderId?: string;
  providerSessionId?: string;
};

export const ResourceBlock = memo(function ResourceBlock(props: ReferenceBlockProps) {
  return (
    <ReferenceBlock
      {...props}
      icon={<FileText size={13} className="text-info shrink-0" />}
      label="Resource"
    />
  );
});

export const ArtifactBlock = memo(function ArtifactBlock(props: ReferenceBlockProps) {
  return (
    <ReferenceBlock
      {...props}
      icon={<Archive size={13} className="text-info shrink-0" />}
      label="Artifact"
    />
  );
});

function ReferenceBlock({
  artifactId,
  title,
  name,
  uri,
  path,
  mimeType,
  content,
  app,
  sessionId,
  agentProviderId,
  providerSessionId,
  icon,
  label,
}: ReferenceBlockProps & { icon: ReactNode; label: string }) {
  if (app) {
    return (
      <McpAppBlock
        app={app}
        artifactId={artifactId}
        title={title}
        name={name}
        uri={uri}
        path={path}
        mimeType={mimeType}
        icon={icon}
        label={label}
        sessionId={sessionId}
        agentProviderId={agentProviderId}
        providerSessionId={providerSessionId}
      />
    );
  }

  const heading = title || name || path || uri || artifactId || label;
  return (
    <div className="border-border-subtle bg-surface/60 overflow-hidden rounded-md border">
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-[12px]">
        {icon}
        <span className="text-fg min-w-0 flex-1 truncate font-medium">{heading}</span>
        {mimeType ? (
          <span className="bg-surface-hover text-subtle rounded px-1.5 py-0.5 font-mono text-[10px]">
            {mimeType}
          </span>
        ) : null}
        {uri ? (
          <a
            href={uri}
            target="_blank"
            rel="noreferrer"
            title={uri}
            className="text-subtle hover:text-info shrink-0 transition-colors"
          >
            <ExternalLink size={13} />
          </a>
        ) : null}
      </div>
      {path || artifactId ? (
        <div className="border-border-subtle text-subtle border-t px-3 py-1.5 font-mono text-[11px]">
          <span className="block truncate">{path || artifactId}</span>
        </div>
      ) : null}
      {content ? (
        <div className="border-border-subtle border-t px-3 py-2 text-[13px] leading-6">
          <Markdown>{content}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

export const RawBlock = memo(function RawBlock({
  label,
  value,
}: {
  label?: string;
  value: unknown;
}) {
  return (
    <div className="border-border-subtle bg-code-bg overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <FileCode2 size={13} className="text-info shrink-0" />
        <span className="text-fg min-w-0 flex-1 truncate font-medium">
          {label || "Raw payload"}
        </span>
      </div>
      <pre className="border-border-subtle text-muted max-h-64 overflow-auto border-t px-3 py-2 font-mono text-[12px] leading-relaxed">
        {formatToolValue(value)}
      </pre>
    </div>
  );
});

export const ErrorBlock = memo(function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="border-danger/40 bg-danger/10 text-danger flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
});

export const ImageGallery = memo(function ImageGallery({
  urls,
  prompt,
}: {
  urls: string[];
  prompt?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div>
      {prompt ? <p className="text-subtle mb-2 text-[12px]">{prompt}</p> : null}
      <div className={cn("grid gap-2", urls.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {urls.map((url, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(url)}
            className="border-border-subtle overflow-hidden rounded-lg border"
          >
            <img
              src={url}
              alt={`Generated ${i + 1}`}
              className="w-full transition-transform hover:scale-[1.03]"
            />
          </button>
        ))}
      </div>
      {active ? <Lightbox url={active} onClose={() => setActive(null)} /> : null}
    </div>
  );
});

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-8"
      onClick={onClose}
    >
      <img src={url} alt="Expanded" className="max-h-full max-w-full rounded-lg" />
    </div>
  );
}

function ToolStatusDot({ status }: { status: ToolStatus }) {
  if (status === "running") {
    return <LoaderCircle size={14} className="text-subtle shrink-0 animate-spin" />;
  }
  if (status === "success") return <Check size={14} className="text-success" />;
  return <AlertTriangle size={13} className="text-danger" />;
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
