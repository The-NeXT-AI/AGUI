export type CodeHighlightResult = {
  language?: string;
  lines: string[];
};

const CODE_HIGHLIGHT_CACHE_MAX_CHARS = 80_000;
const CODE_HIGHLIGHT_CACHE_LIMIT = 100;
const highlightedCodeCache = new Map<string, CodeHighlightResult>();
const pendingHighlights = new Map<string, Promise<CodeHighlightResult>>();
const pendingWorkerRequests = new Map<
  number,
  {
    reject: (error: Error) => void;
    resolve: (result: CodeHighlightResult) => void;
  }
>();

let highlightWorker: Worker | null = null;
let nextRequestId = 1;

type HighlightWorkerResponse = CodeHighlightResult & {
  error?: string;
  id: number;
};

export function highlightCodeBlock(code: string, language: string): Promise<CodeHighlightResult> {
  const key = codeHighlightCacheKey(language, code);
  const cached = highlightedCodeCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingHighlights.get(key);
  if (pending) return pending;

  const request = requestWorkerHighlight(code, language)
    .then((result) => {
      if (shouldCacheHighlightedCode(code)) rememberHighlightedCode(key, result);
      return result;
    })
    .finally(() => {
      pendingHighlights.delete(key);
    });
  pendingHighlights.set(key, request);
  return request;
}

function shouldCacheHighlightedCode(code: string): boolean {
  return code.length <= CODE_HIGHLIGHT_CACHE_MAX_CHARS;
}

function requestWorkerHighlight(code: string, language: string): Promise<CodeHighlightResult> {
  const worker = getHighlightWorker();
  if (!worker) return Promise.reject(new Error("Syntax highlight worker is unavailable."));

  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve, reject) => {
    pendingWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({ code, id, language });
  });
}

function getHighlightWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (highlightWorker) return highlightWorker;

  const worker = new Worker(new URL("./code-highlight.worker.ts", import.meta.url), {
    name: "code-highlight",
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<HighlightWorkerResponse>) => {
    const { error, id, language, lines } = event.data;
    const pending = pendingWorkerRequests.get(id);
    if (!pending) return;
    pendingWorkerRequests.delete(id);
    if (error) {
      pending.reject(new Error(error));
      return;
    }
    pending.resolve({ language, lines });
  };

  worker.onerror = (event) => {
    const error = new Error(event.message || "Syntax highlight worker failed.");
    rejectAllPendingWorkerRequests(error);
    worker.terminate();
    if (highlightWorker === worker) highlightWorker = null;
  };

  highlightWorker = worker;
  return worker;
}

function rememberHighlightedCode(key: string, result: CodeHighlightResult): void {
  highlightedCodeCache.set(key, result);
  if (highlightedCodeCache.size <= CODE_HIGHLIGHT_CACHE_LIMIT) return;
  const oldest = highlightedCodeCache.keys().next().value;
  if (oldest) highlightedCodeCache.delete(oldest);
}

function rejectAllPendingWorkerRequests(error: Error): void {
  for (const pending of pendingWorkerRequests.values()) pending.reject(error);
  pendingWorkerRequests.clear();
}

function codeHighlightCacheKey(language: string, code: string): string {
  return `${language.trim().toLowerCase()}\0${code}`;
}
