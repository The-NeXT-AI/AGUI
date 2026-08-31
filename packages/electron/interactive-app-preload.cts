const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

function interactiveAppId(): string {
  const prefix = "--agui-interactive-app-id=";
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}

const id = interactiveAppId();
let hostMessageListener: ((message: unknown) => void) | undefined;
const pendingHostMessages: unknown[] = [];

contextBridge.exposeInMainWorld("aguiInteractiveApp", {
  postMessage: (message: unknown) => {
    if (!id) return;
    ipcRenderer.send("agui:interactive-app:message", { id, message });
  },
  onMessage: (listener: unknown) => {
    if (typeof listener !== "function") return () => undefined;
    hostMessageListener = listener as (message: unknown) => void;
    for (const message of pendingHostMessages.splice(0)) hostMessageListener(message);
    return () => {
      if (hostMessageListener === listener) hostMessageListener = undefined;
    };
  },
});

ipcRenderer.on("agui:interactive-app:message", (_event, message: unknown) => {
  if (hostMessageListener) hostMessageListener(message);
  else {
    pendingHostMessages.push(message);
    if (pendingHostMessages.length > 100) pendingHostMessages.shift();
  }
});
