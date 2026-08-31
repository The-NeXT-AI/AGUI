import { create } from "zustand";
import type {
  AspRunProjector,
  BlockRenderer,
  Command,
  ComposerControl,
  DetailPanel,
  FloatingWidget,
  HeaderControl,
  SessionTreeRoot,
  SidebarPanel,
  StyleRegistration,
} from "./types.js";
import { disposable } from "./disposable.js";

const registrationTokens = new WeakMap<object, string>();
let registrationSequence = 0;

/** The contribution registry, mutated by extensions, read by the shell. */
export interface RegistryStore {
  sidebarPanels: SidebarPanel[];
  detailPanels: DetailPanel[];
  blockRenderers: BlockRenderer[];
  aspRunProjectors: AspRunProjector[];
  composerControls: ComposerControl[];
  headerControls: HeaderControl[];
  floatingWidgets: FloatingWidget[];
  sessionTreeRoots: SessionTreeRoot[];
  commands: Record<string, Command>;
  styles: StyleRegistration[];

  registerSidebarPanel: (panel: SidebarPanel) => ReturnType<typeof disposable>;
  registerDetailPanel: (panel: DetailPanel) => ReturnType<typeof disposable>;
  registerBlockRenderer: (renderer: BlockRenderer) => ReturnType<typeof disposable>;
  registerAspRunProjector: (projector: AspRunProjector) => ReturnType<typeof disposable>;
  registerComposerControl: (control: ComposerControl) => ReturnType<typeof disposable>;
  registerHeaderControl: (control: HeaderControl) => ReturnType<typeof disposable>;
  registerFloatingWidget: (widget: FloatingWidget) => ReturnType<typeof disposable>;
  registerSessionTreeRoot: (root: SessionTreeRoot) => ReturnType<typeof disposable>;
  registerCommand: (command: Command) => ReturnType<typeof disposable>;
  registerStyle: (style: StyleRegistration) => ReturnType<typeof disposable>;
  reset: () => void;
}

export const useRegistryStore = create<RegistryStore>()((set) => ({
  sidebarPanels: [],
  detailPanels: [],
  blockRenderers: [],
  aspRunProjectors: [],
  composerControls: [],
  headerControls: [],
  floatingWidgets: [],
  sessionTreeRoots: [],
  commands: {},
  styles: [],

  registerSidebarPanel: (panel) => {
    const token = stamp(panel);
    set((s) => ({ sidebarPanels: registerOrdered(s.sidebarPanels, panel, "sidebar panel") }));
    return disposable(() =>
      set((s) => ({ sidebarPanels: removeRegistration(s.sidebarPanels, panel.id, token) })),
    );
  },

  registerDetailPanel: (panel) => {
    const token = stamp(panel);
    set((s) => ({ detailPanels: registerOrdered(s.detailPanels, panel, "detail panel") }));
    return disposable(() =>
      set((s) => ({ detailPanels: removeRegistration(s.detailPanels, panel.id, token) })),
    );
  },

  registerBlockRenderer: (renderer) => {
    const token = stamp(renderer);
    const key = blockRendererKey(renderer);
    set((s) => ({
      blockRenderers: registerByKey(
        s.blockRenderers,
        renderer,
        key,
        blockRendererKey,
        "block renderer",
      ),
    }));
    return disposable(() =>
      set((s) => ({
        blockRenderers: removeRegistrationByKey(s.blockRenderers, key, token, blockRendererKey),
      })),
    );
  },

  registerAspRunProjector: (projector) => {
    const token = stamp(projector);
    set((s) => ({
      aspRunProjectors: registerOrdered(s.aspRunProjectors, projector, "ASP run projector"),
    }));
    return disposable(() =>
      set((s) => ({
        aspRunProjectors: removeRegistration(s.aspRunProjectors, projector.id, token),
      })),
    );
  },

  registerComposerControl: (control) => {
    const token = stamp(control);
    set((s) => ({
      composerControls: registerOrdered(s.composerControls, control, "composer control"),
    }));
    return disposable(() =>
      set((s) => ({ composerControls: removeRegistration(s.composerControls, control.id, token) })),
    );
  },

  registerHeaderControl: (control) => {
    const token = stamp(control);
    set((s) => ({ headerControls: registerOrdered(s.headerControls, control, "header control") }));
    return disposable(() =>
      set((s) => ({ headerControls: removeRegistration(s.headerControls, control.id, token) })),
    );
  },

  registerFloatingWidget: (widget) => {
    const token = stamp(widget);
    set((s) => ({
      floatingWidgets: registerOrdered(s.floatingWidgets, widget, "floating widget"),
    }));
    return disposable(() =>
      set((s) => ({ floatingWidgets: removeRegistration(s.floatingWidgets, widget.id, token) })),
    );
  },

  registerSessionTreeRoot: (root) => {
    const token = stamp(root);
    set((s) => ({
      sessionTreeRoots: registerOrdered(s.sessionTreeRoots, root, "session tree root"),
    }));
    return disposable(() =>
      set((s) => ({ sessionTreeRoots: removeRegistration(s.sessionTreeRoots, root.id, token) })),
    );
  },

  registerCommand: (command) => {
    const token = stamp(command);
    set((s) => {
      if (!command.override && s.commands[command.id]) {
        warnDuplicate("command", command.id);
        return { commands: s.commands };
      }
      return { commands: { ...s.commands, [command.id]: command } };
    });
    return disposable(() =>
      set((s) => {
        if (!hasRegistration(s.commands[command.id], token)) return { commands: s.commands };
        const { [command.id]: _removed, ...rest } = s.commands;
        return { commands: rest };
      }),
    );
  },

  registerStyle: (style) => {
    const token = stamp(style);
    set((s) => ({ styles: registerOrdered(s.styles, style, "style") }));
    return disposable(() =>
      set((s) => ({ styles: removeRegistration(s.styles, style.id, token) })),
    );
  },

  reset: () =>
    set({
      sidebarPanels: [],
      detailPanels: [],
      blockRenderers: [],
      aspRunProjectors: [],
      composerControls: [],
      headerControls: [],
      floatingWidgets: [],
      sessionTreeRoots: [],
      commands: {},
      styles: [],
    }),
}));

/** Insert/replace keeping ascending `order` (undefined order sorts last, stable). */
function ordered<T extends { order?: number; id: string }>(list: T[], item: T): T[] {
  const next = [...list.filter((x) => x.id !== item.id), item];
  next.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  return next;
}

function registerOrdered<T extends { order?: number; id: string; override?: boolean }>(
  list: T[],
  item: T,
  kind: string,
): T[] {
  if (!item.override && list.some((entry) => entry.id === item.id)) {
    warnDuplicate(kind, item.id);
    return list;
  }
  return ordered(list, item);
}

function registerByKey<T extends object & { override?: boolean }>(
  list: T[],
  item: T,
  key: string,
  keyOf: (item: T) => string,
  kind: string,
): T[] {
  if (!item.override && list.some((entry) => keyOf(entry) === key)) {
    warnDuplicate(kind, key);
    return list;
  }
  return [...list.filter((entry) => keyOf(entry) !== key), item];
}

function removeRegistration<T extends object & { id: string }>(
  list: T[],
  id: string,
  token: string,
): T[] {
  return list.filter((item) => item.id !== id || !hasRegistration(item, token));
}

function removeRegistrationByKey<T extends object>(
  list: T[],
  key: string,
  token: string,
  keyOf: (item: T) => string,
): T[] {
  return list.filter((item) => keyOf(item) !== key || !hasRegistration(item, token));
}

function stamp<T extends object>(item: T): string {
  const token = `registry:${++registrationSequence}`;
  registrationTokens.set(item, token);
  return token;
}

function hasRegistration(item: object | undefined, token: string): boolean {
  return Boolean(item && registrationTokens.get(item) === token);
}

function warnDuplicate(kind: string, id: string): void {
  console.warn(`Duplicate ${kind} contribution skipped: ${id}. Use override: true to replace it.`);
}

function blockRendererKey(renderer: BlockRenderer): string {
  return (
    [renderer.id, renderer.kind, renderer.renderer, renderer.mimeType]
      .flat()
      .filter(Boolean)
      .join(":") || String(renderer.render)
  );
}
