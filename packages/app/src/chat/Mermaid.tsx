import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { t } from "@/lib/i18n";

let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;
const MERMAID_SVG_CACHE_LIMIT = 50;
const mermaidSvgCache = new Map<string, string>();
const pendingMermaidRenders = new Map<string, Promise<string>>();
let mermaidOffscreenContainer: HTMLDivElement | null = null;

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    return module.default;
  });
  return mermaidPromise;
}

/** Map the app theme to a mermaid-compatible theme name. */
function currentTheme(): "dark" | "default" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "default" : "dark";
}

function mermaidCacheKey(theme: "dark" | "default", code: string): string {
  return `${theme}\0${code}`;
}

function rememberMermaidSvg(key: string, svg: string): void {
  mermaidSvgCache.set(key, svg);
  if (mermaidSvgCache.size <= MERMAID_SVG_CACHE_LIMIT) return;
  const oldest = mermaidSvgCache.keys().next().value;
  if (oldest) mermaidSvgCache.delete(oldest);
}

function getMermaidOffscreenContainer(): HTMLElement | undefined {
  if (typeof document === "undefined" || !document.body) return undefined;
  if (mermaidOffscreenContainer && document.body.contains(mermaidOffscreenContainer)) {
    return mermaidOffscreenContainer;
  }

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.width = "1200px";
  container.style.height = "1px";
  container.style.opacity = "0";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  container.style.contain = "layout style paint";
  document.body.appendChild(container);
  mermaidOffscreenContainer = container;
  return container;
}

function renderMermaidSvg(code: string, theme: "dark" | "default"): Promise<string> {
  const cacheKey = mermaidCacheKey(theme, code);
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const pending = pendingMermaidRenders.get(cacheKey);
  if (pending) return pending;

  const render = loadMermaid()
    .then((mermaid) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
      const id = `mmd-${Math.random().toString(36).slice(2)}`;
      return mermaid.render(id, code, getMermaidOffscreenContainer());
    })
    .then(({ svg }) => {
      rememberMermaidSvg(cacheKey, svg);
      return svg;
    })
    .finally(() => {
      pendingMermaidRenders.delete(cacheKey);
    });

  pendingMermaidRenders.set(cacheKey, render);
  return render;
}

/**
 * Renders a ```mermaid fenced block to SVG. Mermaid rendering is async and
 * theme-dependent, so we re-render whenever the diagram source or the active
 * theme (data-theme attribute) changes.
 */
export function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      const theme = currentTheme();
      try {
        const svg = await renderMermaidSvg(code, theme);
        if (cancelled) return;
        setError(null);
        if (ref.current) ref.current.innerHTML = svg;
      } catch (error) {
        if (cancelled) return;
        setError(error instanceof Error ? error.message : String(error));
      }
    };

    void render();

    const observer = new MutationObserver(() => void render());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [code]);

  if (error) {
    return (
      <div className="border-danger/40 bg-danger/10 text-danger my-[14px] flex items-start gap-2 rounded-lg border p-3 text-[12.5px]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{t("mermaid.invalid")}</p>
          <pre className="mt-1 font-mono text-[11px] break-words whitespace-pre-wrap opacity-80">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="border-border-subtle bg-code-bg my-[14px] flex justify-center overflow-x-auto rounded-lg border p-4">
      <div ref={ref} className="mermaid" />
    </div>
  );
}
