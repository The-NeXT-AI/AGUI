import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktopApi, type DesktopWindowState } from "@/asp/desktop-api";
import { productConfig } from "@/product/product-config";
import App from "./App";
import "./index.css";

const runtimeApi = desktopApi();
const platform = runtimeApi?.platform ?? "web";
document.documentElement.dataset.platform = platform;
document.documentElement.dataset.desktop = runtimeApi?.transport ?? "web";
document.documentElement.dataset.productName = productConfig.app.name;
document.title = productConfig.app.displayName;

const applyWindowState = (state: DesktopWindowState) => {
  document.documentElement.dataset.windowFullscreen = state.isFullScreen ? "true" : "false";
  document.documentElement.dataset.windowMode = state.mode;
  document.documentElement.dataset.windowPinned = state.pinned ? "true" : "false";
};

const initialWindowMode =
  new URLSearchParams(window.location.search).get("windowMode") === "compact"
    ? "compact"
    : "standard";
applyWindowState({ isFullScreen: false, mode: initialWindowMode, pinned: false });

if (runtimeApi?.window) {
  void runtimeApi.window
    .state()
    .then(applyWindowState)
    .catch(() => applyWindowState({ isFullScreen: false, mode: initialWindowMode, pinned: false }));
  void runtimeApi.window.onState(applyWindowState);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
