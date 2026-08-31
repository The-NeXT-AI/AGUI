import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { ShieldAlert } from "lucide-react";
import { useExtensionStore } from "./extension-store";
import { sanitizeExtensionCss } from "./extension-css";

const ELEMENT_NAME = "agui-extension-component";

type WebComponentFrameMessage = {
  type?: string;
  command?: string;
  args?: unknown;
  data?: unknown;
  error?: string;
  height?: unknown;
  requestId?: unknown;
  text?: unknown;
};

type WebComponentCommandExecutor = (command: string, args: unknown[]) => unknown | Promise<unknown>;

export function ExtensionWebComponent({
  extensionId,
  html,
  data,
  allowNetwork,
  compact,
  executeCommand,
  className,
}: {
  extensionId: string;
  html: string;
  data?: unknown;
  allowNetwork: boolean;
  compact: boolean;
  executeCommand?: WebComponentCommandExecutor;
  className?: string;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dataRef = useRef(data);
  const executeExtensionCommand = useExtensionStore((state) => state.executeCommand);
  const [error, setError] = useState("");
  const documentHtml = useMemo(
    () => secureWebComponentDocument(html, allowNetwork),
    [allowNetwork, html],
  );
  const componentKey = useMemo(
    () => `${extensionId}:${hashString(html)}:${allowNetwork ? "network" : "local"}`,
    [allowNetwork, extensionId, html],
  );
  dataRef.current = data;

  useEffect(() => {
    defineExtensionElement();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    setError("");
    host.dataset.extensionReady = "false";
    host.dataset.extensionText = "";
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.replaceChildren();

    const style = document.createElement("style");
    style.textContent = `${extensionThemeStyle(":host")}:host{display:block;min-width:0}iframe{display:block;width:100%;border:0;background:transparent;color-scheme:inherit}`;
    const frame = document.createElement("iframe");
    frame.title = `${extensionId} extension component`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("data-extension-id", extensionId);
    frame.setAttribute("data-extension-view", surfaceLabel(html));
    frame.setAttribute("data-extension-isolation", "sandboxed-web-component");
    frame.style.height = compact ? "32px" : "128px";
    frame.style.minHeight = compact ? "32px" : "32px";
    frame.style.width = "100%";
    frame.style.border = "0";
    frame.style.background = "transparent";
    frame.srcdoc = documentHtml;
    frameRef.current = frame;
    root.append(style, frame);

    return () => {
      frameRef.current = null;
      host.dataset.extensionReady = "false";
      root.replaceChildren();
    };
  }, [compact, documentHtml, extensionId, html]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const frame = frameRef.current;
      const host = hostRef.current;
      if (!frame || !host || event.source !== frame.contentWindow) return;
      if (event.origin !== "null") return;
      const message = recordValue(event.data) as WebComponentFrameMessage;
      if (message.type === "agui:web-component-ready") {
        host.dataset.extensionReady = "true";
        postFrameData(frame, dataRef.current);
        return;
      }
      if (message.type === "agui:web-component-text") {
        host.dataset.extensionText = boundedText(String(message.text ?? ""), 4096);
        return;
      }
      if (message.type === "agui:web-component-resize") {
        const height = clampFrameHeight(Number(message.height), compact);
        if (height) frame.style.height = `${height}px`;
        return;
      }
      if (message.type === "agui:web-component-error") {
        host.dataset.extensionReady = "false";
        setError(String(message.error || "Extension component script failed."));
        return;
      }
      if (message.type !== "agui:web-component-command" || typeof message.command !== "string") {
        return;
      }
      const requestId = typeof message.requestId === "string" ? message.requestId : "";
      const args = Array.isArray(message.args) ? message.args : [];
      const commandAllowed = executeCommand
        ? Boolean(message.command)
        : commandInExtensionNamespace(extensionId, message.command);
      if (!commandAllowed) {
        postFrameCommandResult(frame, requestId, undefined, "Extension command is not permitted.");
        return;
      }
      const runCommand =
        executeCommand ??
        ((command: string, nextArgs: unknown[]) =>
          executeExtensionCommand(extensionId, command, nextArgs));
      frame.dataset.extensionCommand = message.command;
      frame.dataset.extensionCommandStatus = "pending";
      void Promise.resolve(runCommand(message.command, args)).then(
        (result) => {
          frame.dataset.extensionCommandStatus = "success";
          postFrameCommandResult(frame, requestId, result);
        },
        (cause) => {
          frame.dataset.extensionCommandStatus = "error";
          postFrameCommandResult(
            frame,
            requestId,
            undefined,
            cause instanceof Error ? cause.message : String(cause),
          );
        },
      );
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [compact, executeCommand, executeExtensionCommand, extensionId]);

  useEffect(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || host?.dataset.extensionReady !== "true") return;
    postFrameData(frame, data);
  }, [data]);

  return (
    <>
      {createExtensionElement({
        ref: hostRef,
        key: componentKey,
        "data-extension-id": extensionId,
        "data-extension-view": surfaceLabel(html),
        className: className ?? (compact ? "block h-8 w-full min-w-20" : "block min-h-32 w-full"),
      })}
      {error ? <ExtensionComponentError message={error} /> : null}
    </>
  );
}

export function extensionThemeStyle(selector: ":host" | ":root"): string {
  const style = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {
    "--agui-canvas": style.getPropertyValue("--bg-canvas"),
    "--agui-surface": style.getPropertyValue("--bg-surface"),
    "--agui-fg": style.getPropertyValue("--fg-primary"),
    "--agui-muted": style.getPropertyValue("--fg-secondary"),
    "--agui-border": style.getPropertyValue("--border-default"),
    "--agui-accent": style.getPropertyValue("--accent"),
  };
  return `${selector}{${Object.entries(variables)
    .map(([key, value]) => `${key}:${value.trim()}`)
    .join(";")}}`;
}

function createExtensionElement(props: {
  ref: Ref<HTMLElement>;
  key: string;
  className: string;
  "data-extension-id": string;
  "data-extension-view": string;
}): ReactElement {
  return createElement(ELEMENT_NAME, props);
}

function defineExtensionElement(): void {
  if (customElements.get(ELEMENT_NAME)) return;
  customElements.define(ELEMENT_NAME, class extends HTMLElement {});
}

function secureWebComponentDocument(html: string, allowNetwork: boolean): string {
  const nonce = `agui-${Math.random().toString(36).slice(2)}`;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const blocked of parsed.querySelectorAll("base, iframe, object, embed, meta[http-equiv]")) {
    blocked.remove();
  }
  for (const script of parsed.querySelectorAll("script")) {
    script.removeAttribute("nonce");
    if (script.hasAttribute("src")) script.remove();
    else script.setAttribute("nonce", nonce);
  }
  for (const style of parsed.querySelectorAll("style")) {
    style.textContent = sanitizeExtensionCss(style.textContent ?? "", allowNetwork);
  }
  for (const link of parsed.querySelectorAll("link")) {
    if (link.getAttribute("rel")?.toLowerCase() !== "stylesheet") {
      link.remove();
      continue;
    }
    const href = link.getAttribute("href");
    if (!allowNetwork || !safeExternalUrl(href)) link.remove();
  }
  for (const element of parsed.querySelectorAll("[src], [href]")) {
    sanitizeUrlAttribute(element, "src", allowNetwork);
    sanitizeUrlAttribute(element, "href", allowNetwork);
  }
  for (const element of parsed.querySelectorAll("*")) {
    sanitizeElementAttributes(element, allowNetwork);
  }

  const csp = parsed.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'none'",
    `img-src data:${allowNetwork ? " https:" : ""}`,
    `style-src 'unsafe-inline'${allowNetwork ? " https:" : ""}`,
    `font-src data:${allowNetwork ? " https:" : ""}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${allowNetwork ? "https: wss:" : "'none'"}`,
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "navigate-to 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const theme = parsed.createElement("style");
  theme.textContent = `${extensionThemeStyle(":root")}html,body{min-height:100%;margin:0;background:transparent;color:var(--agui-fg);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}`;
  const bridge = parsed.createElement("script");
  bridge.setAttribute("nonce", nonce);
  bridge.textContent = webComponentBridgeScript();
  parsed.head.prepend(bridge);
  parsed.head.prepend(theme);
  parsed.head.prepend(csp);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

function webComponentBridgeScript(): string {
  return `
(() => {
  const root = document;
  const pending = new Map();
  function hostElement() {
    return document.body || document.documentElement || document;
  }
  function send(message) {
    parent.postMessage(message, "*");
  }
  function requestId() {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  }
  function textSnapshot() {
    return (document.body && document.body.textContent ? document.body.textContent : "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 4096);
  }
  function syncText() {
    send({ type: "agui:web-component-text", text: textSnapshot() });
  }
  function syncHeight() {
    const height = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    send({ type: "agui:web-component-resize", height });
  }
  function sync() {
    syncText();
    syncHeight();
  }
  function dispatchData(data) {
    window.agui.data = data;
    window.dispatchEvent(new CustomEvent("agui:data", { detail: data }));
    root.dispatchEvent(new CustomEvent("agui:data", { detail: data }));
    hostElement().dispatchEvent(new CustomEvent("agui:data", { detail: data }));
    sync();
  }
  window.agui = {
    data: null,
    command(command, args) {
      const id = requestId();
      send({
        type: "agui:web-component-command",
        requestId: id,
        command,
        args: Array.isArray(args) ? args : [],
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Extension command timed out"));
        }, 60000);
        pending.set(id, { resolve, reject, timer });
      });
    },
  };
  Object.defineProperty(window, "root", { configurable: true, value: root });
  Object.defineProperty(window, "host", { configurable: true, get: hostElement });
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const value = event.data || {};
    if (value.type === "agui:web-component-data") {
      dispatchData(value.data);
      return;
    }
    if (value.type !== "agui:web-component-command-result") return;
    const pendingRequest = pending.get(value.requestId);
    if (!pendingRequest) return;
    pending.delete(value.requestId);
    clearTimeout(pendingRequest.timer);
    value.error ? pendingRequest.reject(new Error(value.error)) : pendingRequest.resolve(value.result);
  });
  window.addEventListener("error", (event) => {
    send({ type: "agui:web-component-error", error: event.message || "Extension component error" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    send({ type: "agui:web-component-error", error: reason && reason.message ? reason.message : String(reason) });
  });
  const ready = () => {
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    if ("ResizeObserver" in window && document.body) {
      new ResizeObserver(syncHeight).observe(document.body);
    }
    sync();
    send({ type: "agui:web-component-ready" });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else setTimeout(ready, 0);
})();
`;
}

function sanitizeElementAttributes(element: Element, allowNetwork: boolean): void {
  for (const attribute of Array.from(element.attributes)) {
    if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
  }
  const style = element.getAttribute("style");
  if (style !== null) element.setAttribute("style", sanitizeExtensionCss(style, allowNetwork));
}

function sanitizeUrlAttribute(
  element: Element,
  attribute: "href" | "src",
  allowNetwork: boolean,
): void {
  const value = element.getAttribute(attribute);
  if (!value) return;
  if (value.startsWith("#") || value.startsWith("data:image/")) return;
  if (allowNetwork && safeExternalUrl(value)) return;
  element.removeAttribute(attribute);
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function postFrameData(frame: HTMLIFrameElement, data: unknown): void {
  frame.contentWindow?.postMessage({ type: "agui:web-component-data", data: data ?? null }, "*");
}

function postFrameCommandResult(
  frame: HTMLIFrameElement,
  requestId: string,
  result?: unknown,
  error?: string,
): void {
  frame.contentWindow?.postMessage(
    { type: "agui:web-component-command-result", requestId, result, error },
    "*",
  );
}

function commandInExtensionNamespace(extensionId: string, command: string): boolean {
  return Boolean(
    command && (command.startsWith(`${extensionId}.`) || command.startsWith(`${extensionId}/`)),
  );
}

function clampFrameHeight(value: number, compact: boolean): number {
  if (compact) return 32;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1200, Math.max(32, Math.ceil(value)));
}

function surfaceLabel(html: string): string {
  const match = html.match(/<meta\s+name=["']agui-extension-view["']\s+content=["']([^"']+)["']/i);
  return match?.[1] || "web-component";
}

function ExtensionComponentError({ message }: { message: string }) {
  return (
    <div className="border-danger/30 bg-danger/5 text-danger mt-2 flex min-h-10 items-start gap-2 rounded-md border p-2 text-[12px]">
      <ShieldAlert size={14} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
