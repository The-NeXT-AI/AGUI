/**
 * `@the-next-ai/agui-app` — the public surface downstream extensions code against.
 */
export type {
  AspRunProjector,
  AspRunProjectorContext,
  BlockRenderer,
  Command,
  ComposerControl,
  DetailPanel,
  DetailPanelInstance,
  Extension,
  ExtensionContext,
  FloatingWidget,
  FloatingWidgetPosition,
  HeaderControl,
  IconType,
  ShellAPI,
  ShellLayoutState,
  SessionTreeNode,
  SessionTreeRoot,
  SessionTreeSession,
  SidebarPanel,
  StyleRegistration,
} from "./types.js";

export { CompositeDisposable, disposable } from "./disposable.js";
export type { Disposable } from "./disposable.js";

export { ExtensionHost } from "./ExtensionHost.js";

// Stores — components read contributions/layout from these.
export { useRegistryStore } from "./registry-store.js";
export { useShellStore } from "./shell-store.js";

// Convenience selector hooks.
import { useRegistryStore } from "./registry-store.js";

export const useSidebarPanels = () => useRegistryStore((s) => s.sidebarPanels);
export const useDetailPanels = () => useRegistryStore((s) => s.detailPanels);
export const useBlockRenderers = () => useRegistryStore((s) => s.blockRenderers);
export const useAspRunProjectors = () => useRegistryStore((s) => s.aspRunProjectors);
export const useComposerControls = () => useRegistryStore((s) => s.composerControls);
export const useHeaderControls = () => useRegistryStore((s) => s.headerControls);
export const useFloatingWidgets = () => useRegistryStore((s) => s.floatingWidgets);
export const useSessionTreeRoots = () => useRegistryStore((s) => s.sessionTreeRoots);
export const useCommands = () => useRegistryStore((s) => s.commands);
export const useStyles = () => useRegistryStore((s) => s.styles);
