#!/usr/bin/env node

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

const CHUNK_SIZE = Number(process.env.MARKDOWN_BENCH_CHUNK_SIZE ?? 1024);
const CODE_BLOCK_LINE_HEIGHT = 20;
const CODE_BLOCK_MAX_HEIGHT = 512;
const CODE_BLOCK_OVERSCAN_LINES = 8;
const CODE_BLOCK_VERTICAL_PADDING = 16;
const ANSI_CHUNK_SIZE = Number(process.env.MARKDOWN_BENCH_ANSI_CHUNK_SIZE ?? 512);
const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

const streamingProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
const fullBaselineProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  .use(rehypeKatex);
const fullOptimizedMainProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeKatex);

const scenarios = [
  { codeLines: 500, mermaidNodes: 80, name: "medium-code" },
  { codeLines: 2_000, mermaidNodes: 160, name: "large-code" },
];

for (const scenario of scenarios) {
  const markdown = scenarioMarkdown(scenario);
  const code = firstCodeBlock(markdown);
  console.log(`\n# ${scenario.name}`);
  console.log(
    `markdown=${formatNumber(markdown.length)} chars code=${formatNumber(code.length)} chars`,
  );

  const baseline = runBaselineStreaming(markdown);
  const optimized = runOptimizedStreaming(markdown);
  const finalBaseline = measureSync(
    () => fullBaselineProcessor.runSync(fullBaselineProcessor.parse(markdown)),
    scenario.codeLines >= 2_000 ? 3 : 8,
  );
  const finalOptimizedMain = measureSync(
    () => fullOptimizedMainProcessor.runSync(fullOptimizedMainProcessor.parse(markdown)),
    scenario.codeLines >= 2_000 ? 5 : 12,
  );

  console.table([
    {
      metric: "stream baseline total parse",
      parsedChars: formatNumber(baseline.parsedChars),
      parses: baseline.parseCount,
      ms: formatMs(baseline.durationMs),
    },
    {
      metric: "stream optimized total parse",
      parsedChars: formatNumber(optimized.parsedChars),
      parses: optimized.parseCount,
      ms: formatMs(optimized.durationMs),
    },
    {
      metric: "final baseline main parse+highlight",
      parsedChars: formatNumber(markdown.length),
      parses: finalBaseline.iterations,
      ms: `${formatMs(finalBaseline.avgMs)} avg`,
    },
    {
      metric: "final optimized main parse only",
      parsedChars: formatNumber(markdown.length),
      parses: finalOptimizedMain.iterations,
      ms: `${formatMs(finalOptimizedMain.avgMs)} avg`,
    },
  ]);

  const speedup = baseline.durationMs / Math.max(optimized.durationMs, 0.001);
  console.log(`stream parse reduction: ${speedup.toFixed(1)}x`);

  const worker = await createHighlightWorker();
  try {
    const highlighted = await worker.highlight(code, "ts");
    const highlight = await measureAsync(
      () => worker.highlight(code, "ts"),
      scenario.codeLines >= 2_000 ? 3 : 8,
    );
    console.log(`worker highlight+line split round trip: ${formatMs(highlight.avgMs)} avg`);
    console.table(codeRenderBenchmarks(code, highlighted.lines, scenario));
  } finally {
    await worker.close();
  }

  console.table(ansiStreamingBenchmarks(scenario));
}

function runBaselineStreaming(markdown) {
  let text = "";
  let parsedChars = 0;
  let parseCount = 0;
  const start = performance.now();

  for (const chunk of chunks(markdown, CHUNK_SIZE)) {
    text += chunk;
    const stableEnd = baselineStreamingStableMarkdownEnd(text);
    if (stableEnd <= 0) continue;
    const stable = text.slice(0, stableEnd);
    streamingProcessor.runSync(streamingProcessor.parse(stable));
    parsedChars += stable.length;
    parseCount += 1;
  }

  return {
    durationMs: performance.now() - start,
    parsedChars,
    parseCount,
  };
}

function runOptimizedStreaming(markdown) {
  let text = "";
  let state = emptyStreamingMarkdownParserState();
  let parsedSegmentCount = 0;
  let parsedChars = 0;
  let parseCount = 0;
  const start = performance.now();

  for (const chunk of chunks(markdown, CHUNK_SIZE)) {
    text += chunk;
    state = advanceStreamingMarkdownParserState(state, text);
    for (; parsedSegmentCount < state.segments.length; parsedSegmentCount += 1) {
      const segment = state.segments[parsedSegmentCount].text;
      if (!segment.trim()) continue;
      streamingProcessor.runSync(streamingProcessor.parse(segment));
      parsedChars += segment.length;
      parseCount += 1;
    }
  }

  return {
    durationMs: performance.now() - start,
    parsedChars,
    parseCount,
  };
}

function measureSync(fn, iterations) {
  fn();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) fn();
  return {
    avgMs: (performance.now() - start) / iterations,
    iterations,
  };
}

function measureSyncTotal(fn, iterations) {
  fn();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) fn(index);
  return {
    avgMs: (performance.now() - start) / iterations,
    iterations,
  };
}

async function measureAsync(fn, iterations) {
  await fn();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) await fn();
  return {
    avgMs: (performance.now() - start) / iterations,
    iterations,
  };
}

function codeRenderBenchmarks(code, highlightedLines, scenario) {
  const plainLines = code.split("\n");
  const maxLineLength = plainLines.reduce((max, line) => Math.max(max, line.length), 1);
  const scrollTops = virtualScrollTops(plainLines.length);
  const iterations = scenario.codeLines >= 2_000 ? 12 : 30;
  const fullIterations = scenario.codeLines >= 2_000 ? 4 : 10;
  const fullRender = measureSyncTotal(
    () => renderFullHighlightedCodeBlock(highlightedLines, maxLineLength),
    fullIterations,
  );
  const virtualInitial = measureSyncTotal(
    () => renderVirtualHighlightedCodeBlock(highlightedLines, maxLineLength, 0, plainLines.length),
    iterations,
  );
  const virtualScroll = measureSyncTotal((index) => {
    const scrollTop = scrollTops[index % scrollTops.length];
    return renderVirtualHighlightedCodeBlock(
      highlightedLines,
      maxLineLength,
      scrollTop,
      plainLines.length,
    );
  }, iterations);
  const firstRange = virtualCodeRange(plainLines.length, 0);

  return [
    {
      metric: "code full highlighted React render",
      iterations: fullRender.iterations,
      renderedLines: formatNumber(plainLines.length),
      ms: `${formatMs(fullRender.avgMs)} avg`,
    },
    {
      metric: "code virtual initial React render",
      iterations: virtualInitial.iterations,
      renderedLines: formatNumber(firstRange.end - firstRange.start),
      ms: `${formatMs(virtualInitial.avgMs)} avg`,
    },
    {
      metric: "code virtual scroll React render",
      iterations: virtualScroll.iterations,
      renderedLines: `${formatNumber(firstRange.end - firstRange.start)} per viewport`,
      ms: `${formatMs(virtualScroll.avgMs)} avg`,
    },
  ];
}

function renderFullHighlightedCodeBlock(highlightedLines, maxLineLength) {
  return renderToStaticMarkup(
    React.createElement(
      "pre",
      codePreProps(),
      React.createElement(
        "code",
        {
          className: "block min-w-max px-2 py-2 language-ts hljs",
          style: { minWidth: `${maxLineLength}ch` },
        },
        highlightedLines.map((html, index) =>
          React.createElement("span", {
            className: "block whitespace-pre",
            dangerouslySetInnerHTML: { __html: html },
            key: index,
            style: { height: CODE_BLOCK_LINE_HEIGHT },
          }),
        ),
      ),
    ),
  );
}

function renderVirtualHighlightedCodeBlock(highlightedLines, maxLineLength, scrollTop, lineCount) {
  const range = virtualCodeRange(lineCount, scrollTop);
  const topSpacerHeight = range.start * CODE_BLOCK_LINE_HEIGHT;
  const bottomSpacerHeight = Math.max(0, lineCount - range.end) * CODE_BLOCK_LINE_HEIGHT;
  const children = [];
  if (topSpacerHeight) {
    children.push(
      React.createElement("span", {
        "aria-hidden": "true",
        className: "block",
        key: "top",
        style: { height: topSpacerHeight },
      }),
    );
  }
  for (let lineIndex = range.start; lineIndex < range.end; lineIndex += 1) {
    children.push(
      React.createElement("span", {
        className: "block whitespace-pre",
        dangerouslySetInnerHTML: { __html: highlightedLines[lineIndex] ?? "" },
        key: lineIndex,
        style: { height: CODE_BLOCK_LINE_HEIGHT },
      }),
    );
  }
  if (bottomSpacerHeight) {
    children.push(
      React.createElement("span", {
        "aria-hidden": "true",
        className: "block",
        key: "bottom",
        style: { height: bottomSpacerHeight },
      }),
    );
  }

  return renderToStaticMarkup(
    React.createElement(
      "pre",
      codePreProps(),
      React.createElement(
        "code",
        {
          className: "block min-w-max px-2 py-2 language-ts hljs",
          style: { minWidth: `${maxLineLength}ch` },
        },
        children,
      ),
    ),
  );
}

function codePreProps() {
  return {
    className: "overflow-auto font-mono whitespace-pre",
    style: {
      fontSize: "var(--chat-code-font-size)",
      lineHeight: `${CODE_BLOCK_LINE_HEIGHT}px`,
      maxHeight: CODE_BLOCK_MAX_HEIGHT,
    },
  };
}

function virtualCodeRange(lineCount, rawScrollTop) {
  const scrollTop = Math.max(0, rawScrollTop - CODE_BLOCK_VERTICAL_PADDING / 2);
  const start = Math.max(
    0,
    Math.floor(scrollTop / CODE_BLOCK_LINE_HEIGHT) - CODE_BLOCK_OVERSCAN_LINES,
  );
  const visibleLineCount =
    Math.ceil(CODE_BLOCK_MAX_HEIGHT / CODE_BLOCK_LINE_HEIGHT) + CODE_BLOCK_OVERSCAN_LINES * 2 + 2;
  return {
    end: Math.min(lineCount, start + visibleLineCount),
    start,
  };
}

function virtualScrollTops(lineCount) {
  const maxScrollTop = Math.max(0, lineCount * CODE_BLOCK_LINE_HEIGHT - CODE_BLOCK_MAX_HEIGHT);
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxScrollTop * ratio));
}

function ansiStreamingBenchmarks(scenario) {
  const output = scenarioAnsiOutput(scenario);
  const baseline = runBaselineAnsiStreaming(output);
  const optimized = runOptimizedAnsiStreaming(output);
  const parsedCharReduction = baseline.parsedChars / Math.max(optimized.parsedChars, 1);
  const durationRatio = baseline.durationMs / Math.max(optimized.durationMs, 0.001);

  return [
    {
      metric: "ansi stream baseline total parse",
      parsedChars: formatNumber(baseline.parsedChars),
      parses: baseline.parseCount,
      segments: formatNumber(baseline.segmentCount),
      ms: formatMs(baseline.durationMs),
    },
    {
      metric: "ansi stream optimized stable+tail parse",
      parsedChars: formatNumber(optimized.parsedChars),
      parses: optimized.parseCount,
      segments: formatNumber(optimized.segmentCount),
      ms: formatMs(optimized.durationMs),
    },
    {
      metric: "ansi parsed-char reduction",
      parsedChars: `${parsedCharReduction.toFixed(1)}x`,
      parses: "",
      segments: "",
      ms: "",
    },
    {
      metric: "ansi duration ratio",
      parsedChars: `${durationRatio.toFixed(1)}x`,
      parses: "",
      segments: "",
      ms: "",
    },
  ];
}

function runBaselineAnsiStreaming(output) {
  let text = "";
  let parsedChars = 0;
  let parseCount = 0;
  let segmentCount = 0;
  const start = performance.now();

  for (const chunk of chunks(output, ANSI_CHUNK_SIZE)) {
    text += chunk;
    const segments = parseAnsi(text);
    parsedChars += text.length;
    parseCount += 1;
    segmentCount += segments.length;
  }

  return {
    durationMs: performance.now() - start,
    parsedChars,
    parseCount,
    segmentCount,
  };
}

function runOptimizedAnsiStreaming(output) {
  let text = "";
  let cachedSegments = [];
  let cachedState = emptyAnsiState();
  let cachedStable = "";
  let parsedChars = 0;
  let parseCount = 0;
  let segmentCount = 0;
  const start = performance.now();

  for (const chunk of chunks(output, ANSI_CHUNK_SIZE)) {
    text += chunk;
    const stableEnd = terminalStableOutputEnd(text);
    const stable = text.slice(0, stableEnd);
    const tail = text.slice(stableEnd);
    let segments = cachedSegments;

    if (stable !== cachedStable) {
      const incremental = stable.length >= cachedStable.length;
      const parsed = incremental
        ? parseAnsiWithState(stable.slice(cachedStable.length), cachedState)
        : parseAnsiWithState(stable);
      parsedChars += incremental ? stable.length - cachedStable.length : stable.length;
      parseCount += 1;
      segments = incremental
        ? appendAnsiSegments(cachedSegments, parsed.segments)
        : parsed.segments;
      cachedSegments = segments;
      cachedState = parsed.state;
      cachedStable = stable;
    }

    if (tail) {
      const parsedTail = parseAnsiWithState(tail, cachedState);
      parsedChars += tail.length;
      parseCount += 1;
      segmentCount += segments.length + parsedTail.segments.length;
    } else {
      segmentCount += segments.length;
    }
  }

  return {
    durationMs: performance.now() - start,
    parsedChars,
    parseCount,
    segmentCount,
  };
}

function baselineStreamingStableMarkdownEnd(text) {
  let offset = 0;
  let lastSafeEnd = 0;
  let fenceChar = "";
  let fenceLength = 0;

  while (offset < text.length) {
    const nextNewline = text.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline + 1;
    const line = text.slice(offset, lineEnd);
    const lineWithoutNewline = line.endsWith("\n") ? line.slice(0, -1) : line;
    const fence = /^(?: {0,3})(`{3,}|~{3,})/.exec(lineWithoutNewline);

    if (fence) {
      const marker = fence[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        fenceChar = "";
        fenceLength = 0;
        lastSafeEnd = lineEnd;
      }
    } else if (!fenceChar && line.endsWith("\n") && lineWithoutNewline.trim() === "") {
      lastSafeEnd = lineEnd;
    }

    offset = lineEnd;
  }

  return lastSafeEnd;
}

function emptyStreamingMarkdownParserState() {
  return {
    fenceChar: "",
    fenceLength: 0,
    processedOffset: 0,
    segmentStart: 0,
    segments: [],
    source: "",
  };
}

function advanceStreamingMarkdownParserState(previous, text) {
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
      const marker = fence[1];
      if (!fenceChar) {
        fenceChar = marker[0];
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

function appendStreamingMarkdownSegment(segments, source, start, end) {
  const text = source.slice(start, end);
  if (text.trim()) segments.push({ start, text });
}

function parseAnsi(input) {
  return parseAnsiWithState(input).segments;
}

function parseAnsiWithState(input, initialState = emptyAnsiState()) {
  if (!input.includes("\x1b[")) {
    return {
      segments: input ? [{ cls: ansiClassName(initialState), text: input }] : [],
      state: initialState,
    };
  }

  const segments = [];
  let { bg, bold, dim, fg } = initialState;
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0;
  let match;

  const flush = (text) => {
    if (!text) return;
    segments.push({ cls: ansiClassName({ bg, bold, dim, fg }), text });
  };

  const apply = (code) => {
    if (code === 0) {
      bold = false;
      dim = false;
      fg = "";
      bg = "";
    } else if (code === 1) bold = true;
    else if (code === 2) dim = true;
    else if (code === 22) {
      bold = false;
      dim = false;
    } else if (code >= 30 && code <= 37) fg = ANSI_NAMES[code - 30];
    else if (code >= 40 && code <= 47) bg = ANSI_NAMES[code - 40];
    else if (code >= 90 && code <= 97) fg = `bright-${ANSI_NAMES[code - 90]}`;
    else if (code >= 100 && code <= 107) bg = `bright-${ANSI_NAMES[code - 100]}`;
    else if (code === 39) fg = "";
    else if (code === 49) bg = "";
  };

  while ((match = re.exec(input)) !== null) {
    flush(input.slice(last, match.index));
    last = match.index + match[0].length;
    const params = match[1] || "0";
    for (const raw of params.split(";")) apply(Number(raw));
  }
  flush(input.slice(last));
  return { segments, state: { bg, bold, dim, fg } };
}

function emptyAnsiState() {
  return { bg: "", bold: false, dim: false, fg: "" };
}

function ansiClassName({ bg, bold, dim, fg }) {
  return [
    bold && "font-semibold",
    dim && "opacity-60",
    fg && `text-ansi-${fg}`,
    bg && `bg-ansi-${bg}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function terminalStableOutputEnd(output) {
  const newline = output.lastIndexOf("\n");
  return newline === -1 ? 0 : newline + 1;
}

function appendAnsiSegments(existing, next) {
  if (!existing.length) return next;
  if (!next.length) return existing;
  const last = existing[existing.length - 1];
  const first = next[0];
  if (last.cls === first.cls) {
    existing[existing.length - 1] = { cls: last.cls, text: last.text + first.text };
    existing.push(...next.slice(1));
    return existing;
  }
  existing.push(...next);
  return existing;
}

async function createHighlightWorker() {
  const require = createRequire(import.meta.url);
  const highlightJsUrl = pathToFileURL(require.resolve("highlight.js/lib/common")).href;
  const worker = new Worker(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        import hljs from ${JSON.stringify(highlightJsUrl)};

        parentPort.on("message", ({ code, id, language }) => {
          try {
            const result = hljs.highlight(code, { ignoreIllegals: true, language });
            parentPort.postMessage({ id, lines: highlightedLinesFromHtml(result.value, code) });
          } catch (error) {
            parentPort.postMessage({
              error: error instanceof Error ? error.message : String(error),
              id,
              lines: escapeHtmlLines(code),
            });
          }
        });

        function highlightedLinesFromHtml(html, source) {
          const lines = [];
          const openTags = [];
          let current = "";
          const tagPattern = /<\\/?span\\b[^>]*>/g;
          let last = 0;
          let match;

          const appendText = (text) => {
            let offset = 0;
            while (offset <= text.length) {
              const newline = text.indexOf("\\n", offset);
              if (newline === -1) {
                current += text.slice(offset);
                return;
              }
              current += text.slice(offset, newline);
              lines.push(current + closingTags(openTags));
              current = openTags.join("");
              offset = newline + 1;
            }
          };

          while ((match = tagPattern.exec(html)) !== null) {
            appendText(html.slice(last, match.index));
            const tag = match[0];
            current += tag;
            if (tag.startsWith("</")) openTags.pop();
            else openTags.push(tag);
            last = tagPattern.lastIndex;
          }

          appendText(html.slice(last));
          if (openTags.length) current += closingTags(openTags);
          lines.push(current);
          return alignLineCount(lines, source);
        }

        function closingTags(openTags) {
          return "</span>".repeat(openTags.length);
        }

        function alignLineCount(lines, source) {
          const expected = source.split("\\n").length;
          if (lines.length === expected) return lines;
          if (lines.length < expected) {
            return [...lines, ...Array.from({ length: expected - lines.length }, () => "")];
          }
          return lines.slice(0, expected);
        }

        function escapeHtmlLines(value) {
          return value.split("\\n").map(escapeHtml);
        }

        function escapeHtml(value) {
          return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        }
      `)}`,
    ),
    { type: "module" },
  );

  let nextId = 1;
  const pending = new Map();
  worker.on("message", (message) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve({ lineCount: message.lines.length, lines: message.lines });
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  return {
    close: () => worker.terminate(),
    highlight: (code, language) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { reject, resolve });
        worker.postMessage({ code, id, language });
      }),
  };
}

function scenarioMarkdown({ codeLines, mermaidNodes }) {
  return [
    "# Streaming Markdown Benchmark\n\n",
    ...Array.from(
      { length: 24 },
      (_, index) =>
        `Paragraph ${index} with **bold text**, \`inline code\`, and [a link](https://example.com/${index}).\n\n`,
    ),
    "```ts\n",
    ...Array.from(
      { length: codeLines },
      (_, index) =>
        `export function fn${index}(input: string): string { return input.trim().toUpperCase() + "${index}"; }\n`,
    ),
    "```\n\n",
    "```mermaid\nflowchart TD\n",
    ...Array.from(
      { length: mermaidNodes },
      (_, index) => `  A${index}[node ${index}] --> A${index + 1}[node ${index + 1}]\n`,
    ),
    "```\n\n",
    "| column | value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n",
    "Final paragraph after code and diagram.\n",
  ].join("");
}

function scenarioAnsiOutput({ codeLines }) {
  const colorCodes = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];
  const lines = [];
  for (let index = 0; index < codeLines; index += 1) {
    const color = colorCodes[index % colorCodes.length];
    const prefix = index % 8 === 0 ? `\x1b[1;${color}m` : "";
    const suffix = index % 8 === 7 ? "\x1b[0m" : "";
    lines.push(
      `${prefix}task ${index}: streamed terminal output keeps active ANSI state across the current line${suffix}\n`,
    );
  }
  return lines.join("");
}

function firstCodeBlock(markdown) {
  return /```ts\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? "";
}

function* chunks(text, size) {
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}
