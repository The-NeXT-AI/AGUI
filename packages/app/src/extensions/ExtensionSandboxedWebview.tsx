import { useEffect, useMemo, useRef } from "react";
import { backendExtensionHost } from "./extension-backend-host";
import { extensionThemeStyle } from "./ExtensionWebComponent";

export function ExtensionSandboxedWebview({
  extensionId,
  html,
  data,
  allowNetwork,
  compact,
}: {
  extensionId: string;
  html: string;
  data?: unknown;
  allowNetwork: boolean;
  compact: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dataRef = useRef(data);
  const documentHtml = useMemo(
    () => secureWebviewDocument(html, allowNetwork),
    [allowNetwork, html],
  );
  dataRef.current = data;

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== "null") return;
      const message = recordValue(event.data);
      if (message.type === "agui:ready") {
        frameRef.current.dataset.extensionReady = "true";
        frameRef.current.contentWindow?.postMessage(
          { type: "agui:data", data: dataRef.current ?? null },
          "*",
        );
        return;
      }
      if (message.type !== "agui:command" || typeof message.command !== "string") return;
      const requestId = typeof message.requestId === "string" ? message.requestId : "";
      if (!commandInExtensionNamespace(extensionId, message.command)) {
        frameRef.current.contentWindow?.postMessage(
          {
            type: "agui:command-result",
            requestId,
            error: "Extension command is not permitted.",
          },
          "*",
        );
        return;
      }
      frameRef.current.dataset.extensionCommand = message.command;
      frameRef.current.dataset.extensionCommandStatus = "pending";
      void backendExtensionHost
        .executeCommand(
          extensionId,
          message.command,
          Array.isArray(message.args) ? message.args : [],
        )
        .then(
          (result) => {
            if (frameRef.current) frameRef.current.dataset.extensionCommandStatus = "success";
            frameRef.current?.contentWindow?.postMessage(
              { type: "agui:command-result", requestId, result },
              "*",
            );
          },
          (cause) => {
            if (frameRef.current) frameRef.current.dataset.extensionCommandStatus = "error";
            frameRef.current?.contentWindow?.postMessage(
              {
                type: "agui:command-result",
                requestId,
                error: cause instanceof Error ? cause.message : String(cause),
              },
              "*",
            );
          },
        );
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [extensionId]);

  useEffect(() => {
    if (frameRef.current?.dataset.extensionReady !== "true") return;
    frameRef.current.contentWindow?.postMessage({ type: "agui:data", data: data ?? null }, "*");
  }, [data]);

  useEffect(() => {
    if (frameRef.current) frameRef.current.dataset.extensionReady = "false";
  }, [documentHtml]);

  return (
    <iframe
      ref={frameRef}
      title={`${extensionId} extension view`}
      data-extension-id={extensionId}
      data-extension-view={surfaceLabel(html)}
      data-extension-isolation="sandboxed-webview"
      sandbox="allow-scripts"
      srcDoc={documentHtml}
      className={
        compact
          ? "h-8 w-full min-w-20 border-0 bg-transparent"
          : "h-full min-h-32 w-full border-0 bg-transparent"
      }
    />
  );
}

function secureWebviewDocument(html: string, allowNetwork: boolean): string {
  const nonce = `agui-${Math.random().toString(36).slice(2)}`;
  const themeStyle = extensionThemeStyle(":root");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const script of parsed.querySelectorAll("script")) {
    script.removeAttribute("nonce");
    // Extension-owned inline code is allowed. Remote code is always denied so
    // a package cannot silently change after it has been reviewed and granted.
    if (!script.hasAttribute("src")) script.setAttribute("nonce", nonce);
  }
  const csp = parsed.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'none'",
    `img-src data:${allowNetwork ? " https:" : ""}`,
    `style-src 'unsafe-inline'${allowNetwork ? " https:" : ""}`,
    "font-src data:",
    `script-src 'nonce-${nonce}'`,
    `connect-src ${allowNetwork ? "https: wss:" : "'none'"}`,
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "navigate-to 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const style = parsed.createElement("style");
  style.textContent = `${themeStyle}html,body{height:100%;margin:0;background:transparent;color:var(--agui-fg);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}`;
  const bridge = parsed.createElement("script");
  bridge.setAttribute("nonce", nonce);
  bridge.textContent = `
    window.agui={data:null,command:function(command,args){
      var requestId=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2));
      parent.postMessage({type:'agui:command',requestId:requestId,command:command,args:Array.isArray(args)?args:[]},'*');
      return new Promise(function(resolve,reject){
        var timer=setTimeout(function(){window.removeEventListener('message',listener);reject(new Error('Extension command timed out'))},60000);
        function listener(event){
          if(event.source!==parent)return;
          var value=event.data||{};
          if(value.type!=='agui:command-result'||value.requestId!==requestId)return;
          clearTimeout(timer);window.removeEventListener('message',listener);
          value.error?reject(new Error(value.error)):resolve(value.result)
        }
        window.addEventListener('message',listener)
      })
    }};
    window.addEventListener('message',function(event){
      if(event.source!==parent)return;
      var value=event.data||{};
      if(value.type!=='agui:data')return;
      window.agui.data=value.data;
      window.dispatchEvent(new CustomEvent('agui:data',{detail:value.data}))
    });
    parent.postMessage({type:'agui:ready'},'*');
  `;
  parsed.head.prepend(bridge);
  parsed.head.prepend(style);
  parsed.head.prepend(csp);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

function surfaceLabel(html: string): string {
  const match = html.match(/<meta\s+name=["']agui-extension-view["']\s+content=["']([^"']+)["']/i);
  return match?.[1] || "webview";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandInExtensionNamespace(extensionId: string, command: string): boolean {
  return Boolean(
    command && (command.startsWith(`${extensionId}.`) || command.startsWith(`${extensionId}/`)),
  );
}
