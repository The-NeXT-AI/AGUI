import type { ComponentType, ReactNode } from "react";
import type { Disposable } from "./disposable.js";

/**
 * An icon is any component accepting `{ size, className, strokeWidth }` —
 * directly compatible with `lucide-react` icons.
 */
export type IconType = ComponentType<{
  size?: number | string;
  className?: string;
  strokeWidth?: number;
}>;

/* -------------------------------------------------------------------------- */
/* Contribution points (AGUI semantics)                                      */
/*                                                                            */
/* The app shell is an AGUI-style agent app: a switchable session sidebar, a  */
/* threaded conversation, a floating composer, and a right-side detail panel. */
/* VS Code-style view containers are normalized into SidebarPanel and          */
/* DetailPanel registrations before they reach this runtime registry.          */
/* -------------------------------------------------------------------------- */

/** A switchable panel inside the session sidebar (Sessions, Tasks, Settings…). */
export interface SidebarPanel {
  id: string;
  title: string;
  icon: IconType;
  /**
   * Replacing an existing contribution with the same id is rejected unless the
   * caller opts in. Extension manifests should use namespaced ids instead.
   */
  override?: boolean;
  /** Render the panel body. */
  render: () => ReactNode;
  /** Optional actions shown in the panel header. */
  actions?: () => ReactNode;
  order?: number;
}

/**
 * A panel docked to the right of the conversation — the AGUI "detail panel":
 * diffs, tool-call details, file previews, an ephemeral side chat. It mirrors
 * the sidebar panel on the opposite side and stays hidden until a header
 * toggle (or an extension via `openDetailPanel`) reveals it.
 */
export interface DetailPanel {
  id: string;
  title: string;
  icon: IconType;
  override?: boolean;
  /** Whether this panel can have more than one open tab instance. */
  allowMultiple?: boolean;
  /** Keep hidden tab content mounted instead of remounting when selected again. */
  retainContextWhenHidden?: boolean;
  /** Render the panel body. */
  render: (instance?: DetailPanelInstance) => ReactNode;
  /** Optional actions shown in the panel header (next to the title). */
  actions?: (instance?: DetailPanelInstance) => ReactNode;
  order?: number;
}

/** An opened right-side detail panel tab. Multiple tabs may share one panel id. */
export interface DetailPanelInstance {
  id: string;
  panelId: string;
  title?: string;
  iconUrl?: string;
  ordinal: number;
  createdAt: number;
  active?: boolean;
}

/**
 * A renderer for a custom conversation-block `kind`. Built-in kinds
 * (user/assistant/reasoning/plan/terminal/diff) are handled by the chat layer;
 * registering a renderer here adds support for new block types an agent may
 * emit. `block` is opaque so this package stays free of chat-domain types.
 */
export interface BlockRenderer {
  /** Stable contribution id. Omit only for legacy kind-only renderers. */
  id?: string;
  owner?: string;
  override?: boolean;
  /** Built-in or custom chat block kind(s) this renderer can handle. */
  kind?: string | string[];
  /**
   * Renderer/component ids advertised by the block payload, usually through
   * `metadata.renderer`, `metadata.rendererId`, `metadata.component`, or
   * `metadata.componentId`.
   */
  renderer?: string | string[];
  /** MIME type selector for artifact/resource style blocks. Supports `type/*`. */
  mimeType?: string | string[];
  /** Higher priority renderers win when multiple plugins match the same block. */
  priority?: number;
  /** Optional escape hatch for plugin-specific matching. */
  canRender?: (block: unknown) => boolean;
  render: (block: unknown) => ReactNode;
}

/** A control inside the composer toolbar (model picker, attach, custom…). */
export interface ComposerControl {
  id: string;
  align: "left" | "right";
  override?: boolean;
  render: () => ReactNode;
  order?: number;
}

/** A control in the conversation header bar. */
export interface HeaderControl {
  id: string;
  align: "left" | "right";
  override?: boolean;
  render: () => ReactNode;
  order?: number;
}

export type FloatingWidgetPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** A viewport-anchored widget rendered above the shell but below modal/popover layers. */
export interface FloatingWidget {
  id: string;
  title: string;
  position?: FloatingWidgetPosition;
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  override?: boolean;
  render: () => ReactNode;
  order?: number;
}

export interface SessionTreeSession {
  title?: string;
  providerId?: string;
  projectPath?: string | null;
  cwd?: string;
  renderer?: string;
  initialMarkdown?: string;
  developerInstructions?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionTreeNode {
  id: string;
  title: string;
  icon?: IconType;
  kind?: "folder" | "session";
  loaded?: boolean;
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  badge?: string;
  description?: string;
  children?: SessionTreeNode[];
  session?: SessionTreeSession;
  order?: number;
  onLoadChildren?: () => Promise<void>;
  onLoadMore?: () => Promise<void>;
}

export interface SessionTreeRoot extends SessionTreeNode {
  owner?: string;
}

/** A command, invokable from the palette, keybindings, or the API. */
export interface Command {
  id: string;
  title: string;
  override?: boolean;
  category?: string;
  icon?: IconType;
  keybinding?: string;
  hidden?: boolean;
  handler: (...args: unknown[]) => void | Promise<void>;
}

/**
 * ASP run-event projector. Extensions can consume provider-specific ASP events
 * before the built-in chat bridge falls back to its fixed event projection.
 */
export interface AspRunProjector {
  id: string;
  override?: boolean;
  order?: number;
  canProject?: (context: AspRunProjectorContext) => boolean;
  /**
   * Return true when the projector fully handled the event and the built-in
   * projector should not run.
   */
  project: (context: AspRunProjectorContext) => boolean | void;
}

export interface AspRunProjectorContext {
  readonly sessionId: string;
  readonly eventType: string;
  readonly event: unknown;
  getSession(): unknown;
  dispatch(event: unknown): void;
  patchRuntime(patch: Record<string, unknown>): void;
}

/** A tracked CSS registration owned by an extension or product customization. */
export interface StyleRegistration {
  id: string;
  css: string;
  owner?: string;
  media?: string;
  allowNetwork?: boolean;
  override?: boolean;
  order?: number;
}

/* -------------------------------------------------------------------------- */
/* Extension contract                                                          */
/* -------------------------------------------------------------------------- */

/** Handle handed to an extension's `activate`; every method returns a Disposable. */
export interface ExtensionContext {
  readonly extensionId: string;
  registerSidebarPanel(panel: SidebarPanel): Disposable;
  registerDetailPanel(panel: DetailPanel): Disposable;
  registerBlockRenderer(renderer: BlockRenderer): Disposable;
  registerAspRunProjector(projector: AspRunProjector): Disposable;
  registerComposerControl(control: ComposerControl): Disposable;
  registerHeaderControl(control: HeaderControl): Disposable;
  registerFloatingWidget(widget: FloatingWidget): Disposable;
  registerSessionTreeRoot(root: SessionTreeRoot): Disposable;
  registerCommand(command: Command): Disposable;
  registerStyle(style: Omit<StyleRegistration, "owner">): Disposable;
  /** Imperative control over the app shell. */
  readonly shell: ShellAPI;
}

/** A host-loaded extension. */
export interface Extension {
  id: string;
  name: string;
  activate(ctx: ExtensionContext): void | (() => void);
}

/* -------------------------------------------------------------------------- */
/* Shell control API                                                           */
/* -------------------------------------------------------------------------- */

export interface ShellLayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  activePanelId: string | null;
  detailPanelOpen: boolean;
  detailPanelWidth: number;
  activeDetailPanelId: string | null;
  activeDetailPanelTabId: string | null;
  detailPanelTabs: DetailPanelInstance[];
}

export interface ShellAPI {
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  /** Reveal a sidebar panel (and open the sidebar). */
  openSidebarPanel(panelId: string): void;
  toggleDetailPanel(): void;
  setDetailPanelOpen(open: boolean): void;
  /** Reveal a detail panel (and open the detail pane). */
  openDetailPanel(panelId: string, options?: { allowMultiple?: boolean }): void;
  /** Create a new detail panel tab instance. */
  createDetailPanelTab(panelId: string): void;
  closeDetailPanelTab(tabId: string): void;
  setDetailPanelWidth(width: number): void;
  executeCommand(commandId: string, ...args: unknown[]): void;
  subscribe(listener: (state: ShellLayoutState) => void): () => void;
  getState(): ShellLayoutState;
}
