import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShellStore } from "@the-next-ai/app";
import { Sidebar } from "./Sidebar";
import { DetailPanel } from "./DetailPanel";
import { Header } from "./Header";
import { Sash } from "./Sash";
import { Composer } from "./Composer";
import { CachedChatStream } from "@/chat/ChatStream";
import { cn } from "@/ui/cn";
import { ShellChromeControls } from "./ShellChromeControls";
import { useUIStore } from "@/ui/ui-store";
import { ExtensionsPage } from "./ExtensionsPage";
import { SchedulePage } from "./SchedulePage";
import { SettingsPage } from "./SettingsPage";
import { useT } from "@/lib/i18n";
import { panesNeedMutualExclusion } from "./pane-layout";
import { useProductConfig } from "@/product/product-config";
import { UIRegion } from "@/product/UIRegion";
import { CompactHeader } from "./CompactHeader";

const MOBILE_SHELL_BREAKPOINT = 640;
const MOBILE_PANE_GUTTER = 24;
const MOBILE_MIN_PANE_WIDTH = 240;

/**
 * The top-level AGUI app shell.
 *
 *   ┌───────────┬───────────────────────┬───────────┐
 *   │           │  Header (title · ctrl) │           │
 *   │  Sidebar  ├───────────────────────┤  Detail   │
 *   │  (list)   │  Thread (messages)     │  Panel    │
 *   │           ├───────────────────────┤  (right)  │
 *   │           │  Composer (input)      │           │
 *   └───────────┴───────────────────────┴───────────┘
 *
 * Each pane stays mounted at its configured width and slides out with a
 * negative margin when closed. During an active drag the transition is disabled
 * so the edge tracks the cursor 1:1.
 */
export function AppShell() {
  const compactWindow = document.documentElement.dataset.windowMode === "compact";
  const sidebarOpen = useShellStore((s) => s.sidebarOpen);
  const sidebarWidth = useShellStore((s) => s.sidebarWidth);
  const setSidebarWidth = useShellStore((s) => s.setSidebarWidth);
  const setSidebarOpen = useShellStore((s) => s.setSidebarOpen);
  const detailPanelOpen = useShellStore((s) => s.detailPanelOpen);
  const detailPanelWidth = useShellStore((s) => s.detailPanelWidth);
  const setDetailPanelOpen = useShellStore((s) => s.setDetailPanelOpen);
  const setDetailPanelWidth = useShellStore((s) => s.setDetailPanelWidth);
  const extensionsOpen = useUIStore((s) => s.extensionsOpen);
  const scheduleOpen = useUIStore((s) => s.scheduleOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const t = useT();
  const productConfig = useProductConfig();
  const { sidebar, detailPanel, minimumMainWidth } = productConfig.layout;
  const [draggingLeft, setDraggingLeft] = useState(false);
  const [draggingRight, setDraggingRight] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  const mobileShellInitializedRef = useRef(false);
  const previousPaneOpenRef = useRef({ detailPanelOpen, sidebarOpen });

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isMobileShell = viewportWidth < MOBILE_SHELL_BREAKPOINT;

  useLayoutEffect(() => {
    if (!isMobileShell) {
      mobileShellInitializedRef.current = false;
      return;
    }
    if (mobileShellInitializedRef.current) return;
    mobileShellInitializedRef.current = true;
    setSidebarOpen(false);
    setDetailPanelOpen(false);
  }, [isMobileShell, setDetailPanelOpen, setSidebarOpen]);

  useEffect(() => {
    const previous = previousPaneOpenRef.current;
    previousPaneOpenRef.current = { detailPanelOpen, sidebarOpen };
    if (
      sidebarOpen &&
      detailPanelOpen &&
      panesNeedMutualExclusion(viewportWidth, sidebarWidth, detailPanelWidth, minimumMainWidth)
    ) {
      const sidebarJustOpened = !previous.sidebarOpen;
      const detailPanelJustOpened = !previous.detailPanelOpen;
      if (sidebarJustOpened && !detailPanelJustOpened) {
        setDetailPanelOpen(false);
      } else {
        setSidebarOpen(false);
      }
    }
  }, [
    detailPanelOpen,
    detailPanelWidth,
    minimumMainWidth,
    setDetailPanelOpen,
    setSidebarOpen,
    sidebarOpen,
    sidebarWidth,
    viewportWidth,
  ]);

  const sidebarOverlayMode = isMobileShell || viewportWidth < sidebarWidth + minimumMainWidth;
  const sidebarOverlayOpen = sidebarOpen && sidebarOverlayMode;
  const renderedSidebarWidth =
    sidebarOverlayMode && isMobileShell
      ? mobilePaneWidth(viewportWidth, sidebarWidth, sidebar.minWidth)
      : sidebarWidth;
  const inlineSidebarWidth = sidebarOpen && !sidebarOverlayMode ? sidebarWidth : 0;
  const detailPanelOverlayMode =
    isMobileShell || viewportWidth < inlineSidebarWidth + detailPanelWidth + minimumMainWidth + 6;
  const detailPanelOverlayOpen = detailPanelOpen && detailPanelOverlayMode;
  const renderedDetailPanelWidth = detailPanelOverlayMode
    ? isMobileShell
      ? mobilePaneWidth(viewportWidth, detailPanelWidth, detailPanel.minWidth)
      : Math.min(detailPanelWidth, Math.max(detailPanel.minWidth, viewportWidth - minimumMainWidth))
    : detailPanelWidth;
  const overlayOpen = sidebarOverlayOpen || detailPanelOverlayOpen;
  const dimmingOverlayOpen = sidebarOverlayOpen || (detailPanelOverlayOpen && isMobileShell);
  const activeMobileOverlay = isMobileShell
    ? detailPanelOverlayOpen
      ? "detail"
      : sidebarOverlayOpen
        ? "sidebar"
        : undefined
    : undefined;

  useEffect(() => {
    if (!overlayOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sidebarOverlayOpen) setSidebarOpen(false);
      if (detailPanelOverlayOpen) setDetailPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailPanelOverlayOpen, overlayOpen, setDetailPanelOpen, setSidebarOpen, sidebarOverlayOpen]);

  const closeOverlayPanels = () => {
    if (sidebarOverlayOpen) setSidebarOpen(false);
    if (detailPanelOverlayOpen) setDetailPanelOpen(false);
  };

  if (compactWindow) {
    return (
      <div className="compact-window-shell relative flex h-full overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col">
          <UIRegion id="shell.compactHeader">
            <CompactHeader />
          </UIRegion>
          <UIRegion id="shell.chat">
            <CachedChatStream />
          </UIRegion>
          <UIRegion id="shell.composer">
            <Composer />
          </UIRegion>
        </main>
      </div>
    );
  }

  if (productConfig.features.settingsPage && settingsOpen) {
    return (
      <div className="relative flex h-full overflow-hidden">
        <main className="bg-canvas flex min-w-0 flex-1 flex-col">
          <UIRegion id="page.settings">
            <SettingsPage />
          </UIRegion>
        </main>
      </div>
    );
  }

  return (
    <div
      data-mobile-shell={isMobileShell ? "true" : undefined}
      data-active-mobile-overlay={activeMobileOverlay}
      className={cn("relative flex h-full overflow-hidden", isMobileShell && "is-mobile-shell")}
    >
      <UIRegion id="shell.chromeControls">
        <ShellChromeControls />
      </UIRegion>

      {/* Left sidebar */}
      <UIRegion id="shell.sidebar">
        <aside
          aria-hidden={!sidebarOpen}
          style={{
            width: renderedSidebarWidth,
            marginLeft: sidebarOverlayMode ? undefined : sidebarOpen ? 0 : -renderedSidebarWidth,
            transform: sidebarOverlayMode
              ? `translateX(${sidebarOpen ? 0 : -renderedSidebarWidth}px)`
              : undefined,
          }}
          className={cn(
            "min-w-0 shrink-0 overflow-hidden ease-[cubic-bezier(0.4,0,0.2,1)]",
            sidebarOverlayMode && "absolute inset-y-0 left-0 z-30",
            sidebarOverlayOpen && "shadow-2xl",
            !sidebarOpen && "pointer-events-none opacity-0",
            !draggingLeft &&
              pageVisible &&
              (sidebarOverlayMode
                ? "transition-[opacity,transform] duration-300"
                : "transition-[margin-left,opacity] duration-300"),
          )}
        >
          {/* Fixed-width inner so content isn't squished during the width tween */}
          <div
            style={{ width: renderedSidebarWidth }}
            className="border-border-subtle bg-sidebar h-full border-r"
          >
            <Sidebar />
          </div>
        </aside>
      </UIRegion>
      <UIRegion id="shell.sidebarSash">
        <Sash
          orientation="vertical"
          ariaLabel={t("layout.resizeSidebar")}
          value={sidebarWidth}
          min={sidebar.minWidth}
          max={sidebar.maxWidth}
          onDrag={(delta) => setSidebarWidth(sidebarWidth + delta)}
          onDragStart={() => setDraggingLeft(true)}
          onDragEnd={() => setDraggingLeft(false)}
          style={
            sidebarOverlayMode
              ? { bottom: 0, left: renderedSidebarWidth - 1, position: "absolute", top: 0 }
              : undefined
          }
          className={cn(
            "transition-opacity duration-300",
            isMobileShell && "hidden",
            sidebarOverlayMode && "z-40",
            !sidebarOpen && "pointer-events-none w-0 opacity-0",
          )}
        />
      </UIRegion>

      {dimmingOverlayOpen ? (
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={closeOverlayPanels}
          className="absolute inset-0 z-[25] cursor-default bg-black/35 backdrop-blur-[1px] transition-opacity"
        />
      ) : null}

      <UIRegion id="shell.main">
        <main
          style={{
            paddingRight: detailPanelOverlayOpen && !isMobileShell ? renderedDetailPanelWidth : 0,
          }}
          className="bg-canvas flex min-w-0 flex-1 flex-col transition-[padding-right] duration-300"
        >
          {productConfig.features.extensionsPage && extensionsOpen ? (
            <UIRegion id="page.extensions">
              <ExtensionsPage />
            </UIRegion>
          ) : productConfig.features.scheduledTasks && scheduleOpen ? (
            <UIRegion id="page.schedule">
              <SchedulePage />
            </UIRegion>
          ) : (
            <UIRegion id="shell.conversation">
              <UIRegion id="shell.header">
                <Header />
              </UIRegion>
              <UIRegion id="shell.chat">
                <CachedChatStream />
              </UIRegion>
              <UIRegion id="shell.composer">
                <Composer />
              </UIRegion>
            </UIRegion>
          )}
        </main>
      </UIRegion>

      {/* Right detail panel */}
      <UIRegion id="shell.detailPanelSash">
        <Sash
          orientation="vertical"
          ariaLabel={t("layout.resizeDetailPanel")}
          value={renderedDetailPanelWidth}
          min={detailPanel.minWidth}
          max={detailPanel.maxWidth}
          valuePerDrag={-1}
          onDrag={(delta) => setDetailPanelWidth(detailPanelWidth - delta)}
          onDragStart={() => setDraggingRight(true)}
          onDragEnd={() => setDraggingRight(false)}
          style={
            detailPanelOverlayMode
              ? { bottom: 0, position: "absolute", right: renderedDetailPanelWidth - 1, top: 0 }
              : undefined
          }
          className={cn(
            "transition-opacity duration-300",
            isMobileShell && "hidden",
            detailPanelOverlayMode && "z-40",
            !detailPanelOpen && "pointer-events-none w-0 opacity-0",
          )}
        />
      </UIRegion>
      <UIRegion id="shell.detailPanel">
        <aside
          aria-hidden={!detailPanelOpen}
          style={{
            width: renderedDetailPanelWidth,
            marginRight: detailPanelOverlayMode
              ? undefined
              : detailPanelOpen
                ? 0
                : -renderedDetailPanelWidth,
            transform: detailPanelOverlayMode
              ? `translateX(${detailPanelOpen ? 0 : renderedDetailPanelWidth}px)`
              : undefined,
          }}
          className={cn(
            "min-w-0 shrink-0 overflow-hidden ease-[cubic-bezier(0.4,0,0.2,1)]",
            detailPanelOverlayMode && "absolute inset-y-0 right-0 z-30",
            detailPanelOverlayOpen && "shadow-2xl",
            !detailPanelOpen && "pointer-events-none opacity-0",
            !draggingRight &&
              pageVisible &&
              (detailPanelOverlayMode
                ? "transition-[opacity,transform] duration-300"
                : "transition-[margin-right,opacity] duration-300"),
          )}
        >
          <div
            style={{ width: renderedDetailPanelWidth }}
            className="border-border-subtle bg-sidebar h-full border-l"
          >
            <DetailPanel />
          </div>
        </aside>
      </UIRegion>
    </div>
  );
}

function mobilePaneWidth(viewportWidth: number, configuredWidth: number, configuredMin: number) {
  const available = Math.max(
    MOBILE_MIN_PANE_WIDTH,
    viewportWidth - Math.min(MOBILE_PANE_GUTTER, Math.max(0, viewportWidth - 1)),
  );
  return Math.min(Math.max(configuredWidth, configuredMin), available);
}
