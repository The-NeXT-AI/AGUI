import { useEffect, useRef, type ReactNode } from "react";
import type { Extension, ExtensionContext, ShellAPI, ShellLayoutState } from "./types.js";
import { CompositeDisposable, disposable } from "./disposable.js";
import { ExtensionStyleHost } from "./ExtensionStyleHost.js";
import { useRegistryStore } from "./registry-store.js";
import { useShellStore } from "./shell-store.js";

/**
 * Mount once near the root. Activates every extension (registering sidebar
 * panels, composer controls, commands, …) and tears them down on unmount.
 *
 * Activation runs in an effect so it is safe under React StrictMode. Child
 * effects run before parent effects, so the registry is populated before the
 * app's own effect runs.
 */
export function ExtensionHost({
  extensions,
  children,
}: {
  extensions: Extension[];
  children: ReactNode;
}) {
  const extensionsRef = useRef(extensions);
  useEffect(() => {
    const composite = new CompositeDisposable();
    const shell = createShellAPI();
    for (const ext of extensionsRef.current) {
      const cleanup = ext.activate(createExtensionContext(ext.id, shell, composite));
      if (cleanup) composite.add(disposable(cleanup));
    }
    return () => {
      composite.dispose();
      useRegistryStore.getState().reset();
    };
  }, []);

  return (
    <>
      <ExtensionStyleHost />
      {children}
    </>
  );
}

function createShellAPI(): ShellAPI {
  let layoutState = toLayoutState(useShellStore.getState());

  return {
    toggleSidebar: () => useShellStore.getState().toggleSidebar(),
    setSidebarOpen: (open) => useShellStore.getState().setSidebarOpen(open),
    openSidebarPanel: (panelId) => useShellStore.getState().openSidebarPanel(panelId),
    toggleDetailPanel: () => useShellStore.getState().toggleDetailPanel(),
    setDetailPanelOpen: (open) => useShellStore.getState().setDetailPanelOpen(open),
    openDetailPanel: (panelId) => {
      const panel = useRegistryStore.getState().detailPanels.find((item) => item.id === panelId);
      useShellStore.getState().openDetailPanel(panelId, {
        allowMultiple: panel?.allowMultiple,
      });
    },
    createDetailPanelTab: (panelId) => useShellStore.getState().createDetailPanelTab(panelId),
    closeDetailPanelTab: (tabId) => useShellStore.getState().closeDetailPanelTab(tabId),
    setDetailPanelWidth: (width) => useShellStore.getState().setDetailPanelWidth(width),
    executeCommand: (commandId, ...args) => {
      useRegistryStore.getState().commands[commandId]?.handler(...args);
    },
    subscribe: (listener) =>
      useShellStore.subscribe((state) => {
        const next = toLayoutState(state);
        if (sameLayoutState(layoutState, next)) return;
        layoutState = next;
        listener(layoutState);
      }),
    getState: () => {
      const next = toLayoutState(useShellStore.getState());
      if (!sameLayoutState(layoutState, next)) layoutState = next;
      return layoutState;
    },
  };
}

function toLayoutState(s: ReturnType<typeof useShellStore.getState>): ShellLayoutState {
  return {
    sidebarOpen: s.sidebarOpen,
    sidebarWidth: s.sidebarWidth,
    activePanelId: s.activePanelId,
    detailPanelOpen: s.detailPanelOpen,
    detailPanelWidth: s.detailPanelWidth,
    activeDetailPanelId: s.activeDetailPanelId,
    activeDetailPanelTabId: s.activeDetailPanelTabId,
    detailPanelTabs: s.detailPanelTabs,
  };
}

function sameLayoutState(a: ShellLayoutState, b: ShellLayoutState): boolean {
  return (
    a.sidebarOpen === b.sidebarOpen &&
    a.sidebarWidth === b.sidebarWidth &&
    a.activePanelId === b.activePanelId &&
    a.detailPanelOpen === b.detailPanelOpen &&
    a.detailPanelWidth === b.detailPanelWidth &&
    a.activeDetailPanelId === b.activeDetailPanelId &&
    a.activeDetailPanelTabId === b.activeDetailPanelTabId &&
    a.detailPanelTabs === b.detailPanelTabs
  );
}

function createExtensionContext(
  extensionId: string,
  shell: ShellAPI,
  composite: CompositeDisposable,
): ExtensionContext {
  const registry = useRegistryStore.getState();
  const register = <D extends { dispose(): void }>(d: D): D => {
    composite.add(d);
    return d;
  };
  return {
    extensionId,
    shell,
    registerSidebarPanel: (panel) => register(registry.registerSidebarPanel(panel)),
    registerDetailPanel: (panel) => register(registry.registerDetailPanel(panel)),
    registerBlockRenderer: (renderer) => register(registry.registerBlockRenderer(renderer)),
    registerAspRunProjector: (projector) => register(registry.registerAspRunProjector(projector)),
    registerComposerControl: (control) => register(registry.registerComposerControl(control)),
    registerHeaderControl: (control) => register(registry.registerHeaderControl(control)),
    registerFloatingWidget: (widget) => register(registry.registerFloatingWidget(widget)),
    registerSessionTreeRoot: (root) => register(registry.registerSessionTreeRoot(root)),
    registerCommand: (command) => register(registry.registerCommand(command)),
    registerStyle: (style) => register(registry.registerStyle({ ...style, owner: extensionId })),
  };
}
