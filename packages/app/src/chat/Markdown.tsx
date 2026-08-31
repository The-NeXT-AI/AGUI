import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Check, Copy } from "lucide-react";
import { cn } from "@/ui/cn";
import { copyTextToClipboard } from "@/lib/clipboard";
import { t } from "@/lib/i18n";
import { Mermaid } from "./Mermaid";
import { highlightCodeBlock } from "./code-highlight";

export type MarkdownRenderMode = "full" | "streaming" | "deferred";

const CODE_BLOCK_LINE_HEIGHT = 20;
const CODE_BLOCK_MAX_HEIGHT = 512;
const CODE_BLOCK_OVERSCAN_LINES = 8;
const CODE_BLOCK_VERTICAL_PADDING = 16;

/**
 * Streaming-friendly Markdown renderer, styled to match AGUI chat content.
 *
 * Typography values (font-size, line-height, code size, content width) come
 * from overridable tokens in index.css. The heading sizes, list padding, inline
 * code chip, and code block spacing mirror the real app's markdown stylesheet.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  allowRemoteContent = true,
  renderMode = "full",
}: {
  children: string;
  className?: string;
  allowRemoteContent?: boolean;
  renderMode?: MarkdownRenderMode;
}) {
  const heavyRenderingReady = useHeavyMarkdownRendering(children, renderMode);
  return (
    <MarkdownFrame className={className}>
      <MarkdownContent
        allowRemoteContent={allowRemoteContent}
        heavyRenderingReady={heavyRenderingReady}
      >
        {children}
      </MarkdownContent>
    </MarkdownFrame>
  );
});

export function StreamingMarkdown({
  allowRemoteContent = true,
  text,
}: {
  allowRemoteContent?: boolean;
  text: string;
}) {
  const { segments, tail } = useStreamingMarkdownSegments(text);

  return (
    <MarkdownFrame>
      {segments.map((segment) => (
        <MarkdownContent
          key={segment.start}
          allowRemoteContent={allowRemoteContent}
          heavyRenderingReady={false}
        >
          {segment.text}
        </MarkdownContent>
      ))}
      {tail ? <StreamingPlainText>{tail}</StreamingPlainText> : null}
    </MarkdownFrame>
  );
}

function MarkdownFrame({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div
      style={{
        fontSize: "var(--chat-font-size)",
        lineHeight: "var(--chat-line-height)",
      }}
      className={cn(
        "text-fg [overflow-wrap:anywhere]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        // Paragraph block spacing (0.6875rem approx 11px)
        "[&_p]:my-0 [&_p]:mb-[11px] [&_p:last-child]:mb-0",
        // Headings - margin 20px 0 10px, weight 600
        "[&_h1]:mt-5 [&_h1]:mb-2.5 [&_h1]:text-[22px] [&_h1]:leading-[1.25] [&_h1]:font-semibold",
        "[&_h2]:mt-5 [&_h2]:mb-2.5 [&_h2]:text-[18px] [&_h2]:leading-[1.25] [&_h2]:font-semibold",
        "[&_h3]:mt-5 [&_h3]:mb-2.5 [&_h3]:text-[16px] [&_h3]:leading-[1.25] [&_h3]:font-semibold",
        "[&_h4]:mt-5 [&_h4]:mb-2.5 [&_h4]:text-[15px] [&_h4]:leading-[21px] [&_h4]:font-semibold",
        "[&_h5]:mt-5 [&_h5]:mb-2.5 [&_h5]:text-[14px] [&_h5]:font-semibold",
        "[&_h6]:mt-5 [&_h6]:mb-2.5 [&_h6]:text-[14px] [&_h6]:leading-[19px] [&_h6]:font-semibold",
        // Lists - padding-inline-start 1.3125rem (21px), nested disc -> circle -> square
        "[&_ul]:mb-[10px] [&_ul]:list-disc [&_ul]:pl-[21px]",
        "[&_ol]:mb-[10px] [&_ol]:list-decimal [&_ol]:pl-[21px]",
        "[&_li]:list-item [&_li+li]:mt-2",
        // Quote / link / rule
        "[&_blockquote]:border-border [&_blockquote]:text-muted [&_blockquote]:mb-[11px] [&_blockquote]:border-l-2 [&_blockquote]:pl-3",
        "[&_a]:text-info [&_a]:underline [&_a]:underline-offset-2",
        "[&_hr]:border-border-subtle [&_hr]:my-3 [&_hr]:border-t [&_hr]:border-none",
        // Tables
        "[&_table]:border-border [&_table]:mb-[11px] [&_table]:w-full [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:overflow-hidden [&_table]:rounded-md [&_table]:border",
        "[&_th]:border-border [&_th]:border-r [&_th]:border-b [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[12.5px] [&_th]:font-semibold [&_th:last-child]:border-r-0",
        "[&_td]:border-border [&_td]:border-r [&_td]:border-b [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_td]:text-[12.5px] [&_td:last-child]:border-r-0",
        "[&_tbody_tr:last-child_td]:border-b-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

const MarkdownContent = memo(function MarkdownContent({
  allowRemoteContent,
  children,
  heavyRenderingReady,
}: {
  allowRemoteContent: boolean;
  children: string;
  heavyRenderingReady: boolean;
}) {
  const remarkPlugins = useMemo(
    () => (heavyRenderingReady ? [remarkGfm, remarkMath] : [remarkGfm]),
    [heavyRenderingReady],
  );
  const rehypePlugins = useMemo(
    () => (heavyRenderingReady ? [rehypeKatex] : []),
    [heavyRenderingReady],
  );
  const components = useMemo(
    () => ({
      pre: ({ children }: { children?: ReactNode }) => (
        <PreBlock renderDiagrams={heavyRenderingReady}>{children}</PreBlock>
      ),
      code: InlineCode,
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <MarkdownLink href={href} allowRemoteContent={allowRemoteContent}>
          {children}
        </MarkdownLink>
      ),
      img: ({ src, alt }: { src?: string; alt?: string }) =>
        allowRemoteContent && safeMarkdownImage(src) ? <img src={src} alt={alt ?? ""} /> : null,
    }),
    [allowRemoteContent, heavyRenderingReady],
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
});

function StreamingPlainText({ children }: { children: string }) {
  return <div className="whitespace-pre-wrap">{children}</div>;
}

type StreamingMarkdownSegment = {
  start: number;
  text: string;
};

type StreamingMarkdownParserState = {
  fenceChar: string;
  fenceLength: number;
  processedOffset: number;
  segmentStart: number;
  segments: StreamingMarkdownSegment[];
  source: string;
};

function useStreamingMarkdownSegments(text: string): {
  segments: StreamingMarkdownSegment[];
  tail: string;
} {
  const stateRef = useRef<StreamingMarkdownParserState>(emptyStreamingMarkdownParserState());

  return useMemo(() => {
    const previous = stateRef.current;
    const base =
      text.startsWith(previous.source) && previous.processedOffset <= text.length
        ? previous
        : emptyStreamingMarkdownParserState();
    const next = advanceStreamingMarkdownParserState(base, text);
    stateRef.current = next;
    return {
      segments: next.segments,
      tail: text.slice(next.segmentStart),
    };
  }, [text]);
}

function emptyStreamingMarkdownParserState(): StreamingMarkdownParserState {
  return {
    fenceChar: "",
    fenceLength: 0,
    processedOffset: 0,
    segmentStart: 0,
    segments: [],
    source: "",
  };
}

function advanceStreamingMarkdownParserState(
  previous: StreamingMarkdownParserState,
  text: string,
): StreamingMarkdownParserState {
  const segments = previous.segments.slice();
  let fenceChar = previous.fenceChar;
  let fenceLength = previous.fenceLength;
  let offset = previous.processedOffset;
  let segmentStart = previous.segmentStart;

  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) break;

    const lineEnd = newline + 1;
    const lineWithoutNewline = text.slice(offset, newline);
    const fence = /^(?: {0,3})(`{3,}|~{3,})/.exec(lineWithoutNewline);

    if (fence) {
      const marker = fence[1]!;
      if (!fenceChar) {
        fenceChar = marker[0]!;
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        fenceChar = "";
        fenceLength = 0;
        appendStreamingMarkdownSegment(segments, text, segmentStart, lineEnd);
        segmentStart = lineEnd;
      }
    } else if (!fenceChar && lineWithoutNewline.trim() === "") {
      if (lineEnd > segmentStart) {
        appendStreamingMarkdownSegment(segments, text, segmentStart, lineEnd);
        segmentStart = lineEnd;
      }
    }

    offset = lineEnd;
  }

  return {
    fenceChar,
    fenceLength,
    processedOffset: offset,
    segmentStart,
    segments,
    source: text,
  };
}

function appendStreamingMarkdownSegment(
  segments: StreamingMarkdownSegment[],
  source: string,
  start: number,
  end: number,
): void {
  const text = source.slice(start, end);
  if (text.trim()) segments.push({ start, text });
}

function useHeavyMarkdownRendering(children: string, renderMode: MarkdownRenderMode): boolean {
  const [deferredState, setDeferredState] = useState(() => ({
    children,
    ready: false,
  }));

  useEffect(() => {
    if (renderMode !== "deferred") return undefined;

    let active = true;
    setDeferredState({ children, ready: false });
    const cancel = scheduleIdleWork(() => {
      if (!active) return;
      setDeferredState((current) =>
        current.children === children ? { ...current, ready: true } : current,
      );
    });
    return () => {
      active = false;
      cancel();
    };
  }, [children, renderMode]);

  if (renderMode === "full") return true;
  if (renderMode === "streaming") return false;
  return deferredState.children === children && deferredState.ready;
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

function MarkdownLink({
  allowRemoteContent,
  children,
  href,
}: {
  allowRemoteContent: boolean;
  children?: ReactNode;
  href?: string;
}) {
  return (
    <a href={allowRemoteContent ? href : undefined} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function safeMarkdownImage(value: string | Blob | undefined): boolean {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:image/")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

type CodeProps = ComponentPropsWithoutRef<"code"> & { children?: ReactNode };

/** Inline code — mono chip with the AGUI color-mix background, radius 6px. */
function InlineCode({ className, children, ...rest }: CodeProps) {
  return (
    <code
      className={cn(
        "rounded-[6px] bg-[var(--inline-code-bg)] px-[6px] py-px font-mono text-[0.92em]",
        className,
      )}
      {...rest}
    >
      {children}
    </code>
  );
}

/** Code block - margin-block 14px, radius lg, code-bg, padding 8px, line-height 20px. */
function PreBlock({ children, renderDiagrams }: { children?: ReactNode; renderDiagrams: boolean }) {
  const code = Children.toArray(children).find(isValidElement<CodeProps>);
  const codeProps = code?.props ?? {};
  const className: string = codeProps.className ?? "";
  const lang = /language-([^\s]+)/.exec(className)?.[1];
  const text = toText(codeProps.children);

  // ```mermaid blocks render to a diagram instead of a code card.
  if (lang === "mermaid" && renderDiagrams) {
    return <Mermaid code={text} />;
  }

  return (
    <div className="border-border-subtle bg-code-bg my-[14px] overflow-hidden rounded-lg border">
      <div className="border-border-subtle flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-subtle text-[11px] tracking-wide uppercase">{lang ?? "text"}</span>
        <CopyButton text={text} />
      </div>
      <VirtualizedCodeBlock className={className} language={lang ?? "plaintext"} text={text} />
    </div>
  );
}

function VirtualizedCodeBlock({
  className,
  language,
  text,
}: {
  className: string;
  language: string;
  text: string;
}) {
  const highlighted = useHighlightedCode(text, language);
  const plainLines = useMemo(() => splitCodeLines(text), [text]);
  const maxLineLength = useMemo(
    () => plainLines.reduce((max, line) => Math.max(max, line.length), 1),
    [plainLines],
  );
  const { end, handleScroll, scrollRef, start } = useVirtualCodeViewport(plainLines.length);
  const visibleLineIndexes = useMemo(
    () => Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index),
    [end, start],
  );
  const topSpacerHeight = start * CODE_BLOCK_LINE_HEIGHT;
  const bottomSpacerHeight = Math.max(0, plainLines.length - end) * CODE_BLOCK_LINE_HEIGHT;

  return (
    <pre
      ref={scrollRef}
      onScroll={handleScroll}
      style={{
        fontSize: "var(--chat-code-font-size)",
        lineHeight: `${CODE_BLOCK_LINE_HEIGHT}px`,
        maxHeight: CODE_BLOCK_MAX_HEIGHT,
      }}
      className="overflow-auto font-mono whitespace-pre"
    >
      <code
        className={cn("block min-w-max px-2 py-2", className, highlighted && "hljs")}
        style={{ minWidth: `${maxLineLength}ch` }}
      >
        {topSpacerHeight ? (
          <span aria-hidden="true" className="block" style={{ height: topSpacerHeight }} />
        ) : null}
        {visibleLineIndexes.map((lineIndex) => (
          <VirtualizedCodeLine
            key={lineIndex}
            html={highlighted?.lines[lineIndex]}
            text={plainLines[lineIndex] ?? ""}
          />
        ))}
        {bottomSpacerHeight ? (
          <span aria-hidden="true" className="block" style={{ height: bottomSpacerHeight }} />
        ) : null}
      </code>
    </pre>
  );
}

function VirtualizedCodeLine({ html, text }: { html?: string; text: string }) {
  return (
    <span className="block whitespace-pre" style={{ height: CODE_BLOCK_LINE_HEIGHT }}>
      {html === undefined ? text : <span dangerouslySetInnerHTML={{ __html: html }} />}
    </span>
  );
}

function useVirtualCodeViewport(lineCount: number): {
  end: number;
  handleScroll: () => void;
  scrollRef: RefObject<HTMLPreElement | null>;
  start: number;
} {
  const scrollRef = useRef<HTMLPreElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({
    height: CODE_BLOCK_MAX_HEIGHT,
    scrollTop: 0,
  });

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = {
      height: element.clientHeight || CODE_BLOCK_MAX_HEIGHT,
      scrollTop: element.scrollTop,
    };
    setViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  }, []);

  const handleScroll = useCallback(() => {
    if (typeof window === "undefined") {
      updateViewport();
      return;
    }
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateViewport();
    });
  }, [updateViewport]);

  useEffect(() => {
    updateViewport();
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return () => cancelVirtualCodeViewportFrame(scrollFrameRef);
    }
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelVirtualCodeViewportFrame(scrollFrameRef);
    };
  }, [lineCount, updateViewport]);

  const scrollTop = Math.max(0, viewport.scrollTop - CODE_BLOCK_VERTICAL_PADDING / 2);
  const start = Math.max(
    0,
    Math.floor(scrollTop / CODE_BLOCK_LINE_HEIGHT) - CODE_BLOCK_OVERSCAN_LINES,
  );
  const visibleLineCount =
    Math.ceil(viewport.height / CODE_BLOCK_LINE_HEIGHT) + CODE_BLOCK_OVERSCAN_LINES * 2 + 2;
  const end = Math.min(lineCount, start + visibleLineCount);

  return {
    end,
    handleScroll,
    scrollRef,
    start,
  };
}

function cancelVirtualCodeViewportFrame(scrollFrameRef: MutableRefObject<number | null>): void {
  if (typeof window === "undefined" || scrollFrameRef.current === null) return;
  window.cancelAnimationFrame(scrollFrameRef.current);
  scrollFrameRef.current = null;
}

function useHighlightedCode(
  text: string,
  language: string,
): { language?: string; lines: string[] } | null {
  const [state, setState] = useState<{
    key: string;
    result: { language?: string; lines: string[] } | null;
  }>(() => ({
    key: codeHighlightStateKey(language, text),
    result: null,
  }));
  const key = codeHighlightStateKey(language, text);

  useEffect(() => {
    let active = true;
    setState({ key, result: null });
    void highlightCodeBlock(text, language)
      .then((result) => {
        if (active) setState({ key, result });
      })
      .catch(() => {
        if (active) setState({ key, result: null });
      });
    return () => {
      active = false;
    };
  }, [key, language, text]);

  return state.key === key ? state.result : null;
}

function codeHighlightStateKey(language: string, text: string): string {
  return `${language}\0${text}`;
}

function splitCodeLines(text: string): string[] {
  return text.split("\n");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await copyTextToClipboard(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      aria-label={copied ? t("common.copied") : t("code.copy")}
      className="text-subtle hover:text-fg inline-flex h-6 w-6 items-center justify-center rounded transition-colors"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function toText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : isValidElement(child)
          ? toText((child.props as { children?: ReactNode }).children)
          : "",
    )
    .join("");
}
