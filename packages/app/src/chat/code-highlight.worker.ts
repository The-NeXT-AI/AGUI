import hljs from "highlight.js/lib/common";

type HighlightWorkerRequest = {
  code: string;
  id: number;
  language?: string;
};

type HighlightWorkerResponse = {
  error?: string;
  id: number;
  language?: string;
  lines: string[];
};

self.onmessage = (event: MessageEvent<HighlightWorkerRequest>) => {
  const { code, id, language } = event.data;
  try {
    const normalizedLanguage = language?.trim().toLowerCase();
    const highlightLanguage =
      normalizedLanguage && hljs.getLanguage(normalizedLanguage) ? normalizedLanguage : "plaintext";

    const result = hljs.highlight(code, {
      ignoreIllegals: true,
      language: highlightLanguage,
    });
    postResponse({
      id,
      language: result.language,
      lines: highlightedLinesFromHtml(result.value, code),
    });
  } catch {
    postResponse({
      id,
      language: "plaintext",
      lines: escapeHtmlLines(code),
    });
  }
};

function postResponse(response: HighlightWorkerResponse): void {
  self.postMessage(response);
}

function highlightedLinesFromHtml(html: string, source: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let current = "";
  const tagPattern = /<\/?span\b[^>]*>/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const appendText = (text: string) => {
    let offset = 0;
    while (offset <= text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        current += text.slice(offset);
        return;
      }
      current += text.slice(offset, newline);
      lines.push(`${current}${closingTags(openTags)}`);
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

function closingTags(openTags: string[]): string {
  return "</span>".repeat(openTags.length);
}

function alignLineCount(lines: string[], source: string): string[] {
  const expected = source.split("\n").length;
  if (lines.length === expected) return lines;
  if (lines.length < expected)
    return [...lines, ...Array.from({ length: expected - lines.length }, () => "")];
  return lines.slice(0, expected);
}

function escapeHtmlLines(value: string): string[] {
  return value.split("\n").map(escapeHtml);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
