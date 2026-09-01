import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useChatStore } from "@/chat/chat-store";
import {
  desktopApi,
  type BrowserAnnotation,
  type BrowserRect,
  type BrowserViewport,
  type TerminalRunEvent,
} from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { uid } from "@/ui/id";
import { useUIStore, type BrowserSnapshotDraft } from "@/ui/ui-store";
import { useShellStore, type DetailPanelInstance } from "@the-next-ai/agui-app";
import { useT } from "@/lib/i18n";
import { useDetailPanelProjectContext } from "@/shell/detail-panel-project-context";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import {
  BROWSER_HOME_URL,
  BrowserFaviconIcon,
  BrowserHome,
  ToolbarButton,
  browserFaviconUrl,
  browserTitle,
  browserViewBounds,
  hiddenBrowserViewBounds,
  isExternalOpenable,
  normalizeBrowserUrl,
} from "./BrowserPanelParts";

const XTERM_COMPOSITION_SUPPRESS_MS = 180;
const TERMINAL_INPUT_FALLBACK_DELAY_MS = 40;
const FALLBACK_WRITE_DEDUPE_MS = 25;
const TERMINAL_WORKSPACE_CACHE_LIMIT = 6;
const TERMINAL_BACKEND_RELEASE_DELAY_MS = 10 * 60 * 1000;
const TERMINAL_OUTPUT_CACHE_LIMIT = 200_000;
const REMOTE_BROWSER_FRAME_MAX_WIDTH = 1600;
const REMOTE_BROWSER_FRAME_MAX_HEIGHT = 1200;
const REMOTE_BROWSER_FRAME_QUALITY = 72;
const REMOTE_BROWSER_ANNOTATION_DRAG_THRESHOLD = 8;
const REMOTE_BROWSER_SURFACE_WAIT_FRAMES = 12;
const terminalBackendReleaseTimers = new Map<string, number>();
const terminalOutputCache = new Map<string, string>();
let terminalOutputRecorderDispose: (() => void) | null = null;
const TERMINAL_FONT_FAMILY = [
  "Hack Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGS Nerd Font Mono",
  "JetBrainsMono Nerd Font Mono",
  "FiraCode Nerd Font Mono",
  "CaskaydiaCove Nerd Font Mono",
  "SFMono-Regular",
  "Menlo",
  "Monaco",
  "Consolas",
  "Liberation Mono",
  "Courier New",
  "Symbols Nerd Font Mono",
  "monospace",
]
  .map((font) => (font.includes(" ") ? `'${font}'` : font))
  .join(", ");
const emptyCompositionInputSnapshot: CompositionInputSnapshot = {
  selectionEnd: 0,
  selectionStart: 0,
  value: "",
};
type TerminalWorkspaceEntry = {
  cwd: string;
  key: string;
  workspaceId: string;
};

export function TerminalPanel({ instance }: { instance?: DetailPanelInstance }) {
  const projectContext = useDetailPanelProjectContext();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const sessionCwd = useChatStore((state) => {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    return session?.cwd || session?.projectPath || "";
  });
  const workspacePath = useAspStore((state) => state.workspacePath);
  const workspaceId = projectContext?.workspaceId || activeWorkspaceId || "default";
  const cwd = projectContext?.root || sessionCwd || workspacePath || "";
  const activeWorkspaceEntry = useMemo<TerminalWorkspaceEntry>(
    () => ({
      cwd,
      key: terminalWorkspaceKey(workspaceId, cwd),
      workspaceId,
    }),
    [cwd, workspaceId],
  );
  const baseTerminalId = useMemo(() => instance?.id ?? uid("terminal"), [instance?.id]);
  const isActive = instance?.active !== false;
  const [cachedWorkspaces, setCachedWorkspaces] = useState<TerminalWorkspaceEntry[]>(() => [
    activeWorkspaceEntry,
  ]);

  useEffect(() => {
    setCachedWorkspaces((current) => {
      const next = current.filter((item) => item.key !== activeWorkspaceEntry.key);
      next.push(activeWorkspaceEntry);
      return next.slice(-TERMINAL_WORKSPACE_CACHE_LIMIT);
    });
  }, [activeWorkspaceEntry]);

  const renderedWorkspaces = cachedWorkspaces.some(
    (entry) => entry.key === activeWorkspaceEntry.key,
  )
    ? cachedWorkspaces
    : [...cachedWorkspaces, activeWorkspaceEntry].slice(-TERMINAL_WORKSPACE_CACHE_LIMIT);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      {renderedWorkspaces.map((workspace) => {
        const workspaceActive = isActive && workspace.key === activeWorkspaceEntry.key;
        return (
          <div
            key={workspace.key}
            aria-hidden={!workspaceActive}
            className={
              workspaceActive
                ? "absolute inset-0 h-full min-h-0"
                : "pointer-events-none absolute inset-0 h-full min-h-0 opacity-0"
            }
          >
            <TerminalWorkspacePanel
              active={workspaceActive}
              cwd={workspace.cwd}
              terminalId={terminalWorkspaceId(baseTerminalId, workspace.workspaceId, workspace.cwd)}
            />
          </div>
        );
      })}
    </div>
  );
}

function TerminalWorkspacePanel({
  active,
  cwd,
  terminalId,
}: {
  active: boolean;
  cwd: string;
  terminalId: string;
}) {
  const t = useT();
  const isActive = active;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const readyRef = useRef(false);
  const pendingInputRef = useRef("");
  const lastXtermInputAtRef = useRef(0);
  const lastXtermInputRef = useRef({ data: "", at: 0 });
  const recentXtermInputsRef = useRef<Array<{ data: string; at: number }>>([]);
  const lastKeyboardInputAtRef = useRef(0);
  const lastNativeTextInputAtRef = useRef(0);
  const lastFallbackWriteRef = useRef({ data: "", at: 0, eventAt: 0 });
  const isComposingInputRef = useRef(false);
  const compositionCommitPendingRef = useRef(false);
  const compositionStartSnapshotRef = useRef<CompositionInputSnapshot>(
    emptyCompositionInputSnapshot,
  );
  const compositionCommitTextRef = useRef("");
  const suppressXtermInputUntilRef = useRef(0);

  const writeTerminalData = useCallback(
    (data: string) => {
      if (!data) return;
      if (!readyRef.current) {
        pendingInputRef.current = `${pendingInputRef.current}${data}`.slice(-8192);
        return;
      }
      void desktopApi()?.terminal?.write?.({ id: terminalId, data });
    },
    [terminalId],
  );

  const hideNativeBrowserSurfaces = useCallback(() => {
    const browserApi = desktopApi()?.browser;
    void browserApi?.releaseFocus?.().catch(() => undefined);
    void browserApi
      ?.list?.()
      .then((targets) => {
        for (const target of targets ?? []) {
          void browserApi
            .setBounds?.({
              id: target.id,
              bounds: hiddenBrowserViewBounds(),
            })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, []);

  const focusTerminalInput = useCallback(() => {
    const terminal = terminalRef.current;
    const mount = mountRef.current;
    if (!isActive || !terminal || !mount) return;
    terminal.focus();
    window.requestAnimationFrame(() => {
      const helper = terminalImeHelper(mount);
      prepareTerminalImeHelper(helper);
      syncTerminalImeHelperGeometry(mount);
      helper?.focus({ preventScroll: true });
    });
  }, [isActive]);

  const flushPendingInput = useCallback(() => {
    if (!pendingInputRef.current) return;
    const data = pendingInputRef.current;
    pendingInputRef.current = "";
    void desktopApi()?.terminal?.write?.({ id: terminalId, data });
  }, [terminalId]);

  const resizeTerminalToPanel = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    const mount = mountRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    void desktopApi()?.terminal?.resize?.({
      id: terminalId,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    syncTerminalImeHelperGeometry(mount);
  }, [terminalId]);

  const commitNativeTextInputFallback = useCallback(
    (
      data: string,
      eventAt = performance.now(),
      onWrite?: () => void,
      options?: { skipXtermDedupe?: boolean },
    ) => {
      const normalized = normalizeTerminalTextInput(data);
      if (!normalized) return;
      const now = performance.now();
      const lastXtermInput = lastXtermInputRef.current;
      if (
        options?.skipXtermDedupe !== true &&
        ((lastXtermInput.data === normalized && Math.abs(lastXtermInput.at - eventAt) < 120) ||
          hasRecentTerminalInput(recentXtermInputsRef.current, normalized, eventAt, 160))
      )
        return;
      const lastFallback = lastFallbackWriteRef.current;
      if (
        lastFallback.data === normalized &&
        Math.abs(lastFallback.eventAt - eventAt) < 8 &&
        now - lastFallback.at < FALLBACK_WRITE_DEDUPE_MS
      )
        return;
      lastNativeTextInputAtRef.current = eventAt;
      lastFallbackWriteRef.current = { data: normalized, at: now, eventAt };
      onWrite?.();
      writeTerminalData(normalized);
    },
    [writeTerminalData],
  );

  const scheduleNativeTextInputFallback = useCallback(
    (
      data: string,
      options?: {
        delayMs?: number;
        eventAt?: number;
        onWrite?: () => void;
        skipIfXtermInput?: boolean;
      },
    ) => {
      const normalized = normalizeTerminalTextInput(data);
      if (!normalized) return;
      const eventAt = options?.eventAt ?? performance.now();
      window.setTimeout(() => {
        const lastXtermInput = lastXtermInputRef.current;
        if (
          options?.skipIfXtermInput !== false &&
          ((lastXtermInput.data === normalized && Math.abs(lastXtermInput.at - eventAt) < 120) ||
            hasRecentTerminalInput(recentXtermInputsRef.current, normalized, eventAt, 160))
        )
          return;
        commitNativeTextInputFallback(normalized, eventAt, options?.onWrite);
      }, options?.delayMs ?? TERMINAL_INPUT_FALLBACK_DELAY_MS);
    },
    [commitNativeTextInputFallback],
  );

  const scheduleTerminalInputFallback = useCallback(
    (
      data: string,
      options?: {
        delayMs?: number;
        eventAt?: number;
        skipIfNativeTextInput?: boolean;
      },
    ) => {
      const normalized = normalizeTerminalTextInput(data);
      if (!normalized) return;
      const eventAt = options?.eventAt ?? performance.now();
      window.setTimeout(
        () => {
          const lastXtermInput = lastXtermInputRef.current;
          if (
            (lastXtermInput.data === normalized && Math.abs(lastXtermInput.at - eventAt) < 120) ||
            hasRecentTerminalInput(recentXtermInputsRef.current, normalized, eventAt, 160)
          )
            return;
          if (
            options?.skipIfNativeTextInput !== false &&
            lastNativeTextInputAtRef.current > eventAt &&
            lastNativeTextInputAtRef.current - eventAt < 120
          )
            return;
          commitNativeTextInputFallback(normalized, eventAt);
        },
        options?.delayMs ?? terminalKeyFallbackDelayMs(normalized),
      );
    },
    [commitNativeTextInputFallback],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    ensureTerminalOutputRecorder();
    const terminal = new XTerm({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.22,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: currentTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    const cachedOutput = terminalOutputCache.get(terminalId);
    if (cachedOutput) terminal.write(cachedOutput);
    prepareTerminalImeHelper(terminalImeHelper(mount));
    syncTerminalImeHelperGeometry(mount);

    const dataDisposable = terminal.onData((data) => {
      const at = performance.now();
      if (
        shouldSuppressXtermInput(
          isComposingInputRef.current,
          suppressXtermInputUntilRef.current,
          at,
        )
      )
        return;
      lastXtermInputAtRef.current = at;
      const normalized = normalizeTerminalTextInput(data);
      lastXtermInputRef.current = { data: normalized, at };
      recentXtermInputsRef.current = [
        ...recentXtermInputsRef.current,
        { data: normalized, at },
      ].slice(-96);
      writeTerminalData(data);
    });
    const renderDisposable = terminal.onRender(() => syncTerminalImeHelperGeometry(mount));
    const cursorDisposable = terminal.onCursorMove(() => syncTerminalImeHelperGeometry(mount));
    const resizeObserver = new ResizeObserver(resizeTerminalToPanel);
    resizeObserver.observe(mount);
    window.requestAnimationFrame(resizeTerminalToPanel);

    return () => {
      dataDisposable.dispose();
      renderDisposable.dispose();
      cursorDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [resizeTerminalToPanel, terminalId, writeTerminalData]);

  useEffect(() => {
    const mount = mountRef.current;
    const helper = terminalImeHelper(mount);
    if (!mount || !helper) return undefined;
    prepareTerminalImeHelper(helper);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isComposingKeyEvent(event, isComposingInputRef.current)) return;
      const data = terminalKeyData(event);
      if (!data) return;
      const eventAt = performance.now();
      lastKeyboardInputAtRef.current = eventAt;
      scheduleTerminalInputFallback(data, {
        eventAt,
        skipIfNativeTextInput: isPlainPrintableKeyEvent(event),
      });
    };
    const handleKeyPress = (event: KeyboardEvent) => {
      if (isComposingKeyEvent(event, isComposingInputRef.current)) return;
      const data = terminalKeyPressData(event);
      if (!data) return;
      const eventAt = performance.now();
      lastKeyboardInputAtRef.current = eventAt;
      scheduleTerminalInputFallback(data, {
        delayMs: 36,
        eventAt,
        skipIfNativeTextInput: true,
      });
    };
    const handleBeforeInput = (event: InputEvent) => {
      if (isCompositionInputEvent(event, isComposingInputRef.current)) return;
      if (typeof event.data !== "string" || !event.data) return;
      const eventAt = performance.now();
      scheduleNativeTextInputFallback(event.data, {
        delayMs: 24,
        eventAt,
        onWrite: () => clearTerminalImeHelper(helper),
      });
    };
    const handleTextInput = (event: Event) => {
      if (isComposingInputRef.current) return;
      const data = terminalTextEventData(event);
      if (!data) return;
      scheduleNativeTextInputFallback(data, {
        delayMs: 24,
        eventAt: performance.now(),
        onWrite: () => clearTerminalImeHelper(helper),
      });
    };
    const handleInput = () => {
      if (isComposingInputRef.current) return;
      if (compositionCommitPendingRef.current) {
        const text = resolveComposedTerminalInput(
          "",
          "",
          compositionStartSnapshotRef.current,
          helper,
        );
        if (text) compositionCommitTextRef.current = text;
        return;
      }
      clearTerminalImeHelper(helper);
    };
    const handleCompositionStart = () => {
      isComposingInputRef.current = true;
      suppressXtermInputUntilRef.current = Number.POSITIVE_INFINITY;
      compositionStartSnapshotRef.current = readCompositionInputSnapshot(helper);
      compositionCommitTextRef.current = "";
      prepareTerminalImeHelper(helper);
      syncTerminalImeHelperGeometry(mount);
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      const eventAt = performance.now();
      const eventData = typeof event.data === "string" ? event.data : "";
      compositionCommitTextRef.current = eventData;
      compositionCommitPendingRef.current = true;
      isComposingInputRef.current = false;
      suppressXtermInputUntilRef.current = eventAt + XTERM_COMPOSITION_SUPPRESS_MS;
      window.setTimeout(() => {
        const nextHelper = terminalImeHelper(mount);
        const text = resolveComposedTerminalInput(
          eventData,
          compositionCommitTextRef.current,
          compositionStartSnapshotRef.current,
          nextHelper,
        );
        commitNativeTextInputFallback(text, eventAt, () => {
          clearTerminalImeHelper(nextHelper);
          syncTerminalImeHelperGeometry(mount);
        });
        compositionStartSnapshotRef.current = emptyCompositionInputSnapshot;
        compositionCommitTextRef.current = "";
        compositionCommitPendingRef.current = false;
      }, 0);
    };
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      scheduleNativeTextInputFallback(text, {
        delayMs: 24,
        eventAt: performance.now(),
        onWrite: () => clearTerminalImeHelper(helper),
      });
    };
    helper.addEventListener("keydown", handleKeyDown);
    helper.addEventListener("keypress", handleKeyPress);
    helper.addEventListener("beforeinput", handleBeforeInput);
    helper.addEventListener("textInput", handleTextInput);
    helper.addEventListener("input", handleInput);
    helper.addEventListener("compositionstart", handleCompositionStart);
    helper.addEventListener("compositionend", handleCompositionEnd);
    helper.addEventListener("paste", handlePaste);
    return () => {
      helper.removeEventListener("keydown", handleKeyDown);
      helper.removeEventListener("keypress", handleKeyPress);
      helper.removeEventListener("beforeinput", handleBeforeInput);
      helper.removeEventListener("textInput", handleTextInput);
      helper.removeEventListener("input", handleInput);
      helper.removeEventListener("compositionstart", handleCompositionStart);
      helper.removeEventListener("compositionend", handleCompositionEnd);
      helper.removeEventListener("paste", handlePaste);
    };
  }, [
    commitNativeTextInputFallback,
    scheduleNativeTextInputFallback,
    scheduleTerminalInputFallback,
  ]);

  useEffect(() => {
    if (!isActive) return undefined;
    hideNativeBrowserSurfaces();
    resizeTerminalToPanel();
    focusTerminalInput();
    const timer = window.setTimeout(() => {
      resizeTerminalToPanel();
      focusTerminalInput();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [focusTerminalInput, hideNativeBrowserSurfaces, isActive, resizeTerminalToPanel]);

  useEffect(() => {
    if (!isActive) return undefined;
    const shouldRouteEvent = (target: HTMLElement | null) => {
      const insideTerminal = Boolean(target && mountRef.current?.contains(target));
      if (!insideTerminal && isInteractiveKeyboardTarget(target))
        return { route: false, insideTerminal };
      return { route: true, insideTerminal };
    };
    const shouldPreventDefault = (target: HTMLElement | null, insideTerminal: boolean) =>
      !insideTerminal &&
      (!target || target === document.body || target === document.documentElement);
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const { route, insideTerminal } = shouldRouteEvent(target);
      if (!route || insideTerminal || isComposingKeyEvent(event, isComposingInputRef.current))
        return;
      const data = terminalKeyData(event);
      if (!data) return;
      const eventAt = performance.now();
      lastKeyboardInputAtRef.current = eventAt;
      commitNativeTextInputFallback(data, eventAt, undefined, { skipXtermDedupe: true });
      if (shouldPreventDefault(target, insideTerminal)) {
        event.preventDefault();
      }
    };
    const handleGlobalKeyPress = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const { route, insideTerminal } = shouldRouteEvent(target);
      if (!route || insideTerminal || isComposingKeyEvent(event, isComposingInputRef.current))
        return;
      const data = terminalKeyPressData(event);
      if (!data) return;
      const eventAt = performance.now();
      if (eventAt - lastKeyboardInputAtRef.current < 80) return;
      lastKeyboardInputAtRef.current = eventAt;
      scheduleTerminalInputFallback(data, {
        delayMs: 36,
        eventAt,
        skipIfNativeTextInput: true,
      });
      if (shouldPreventDefault(target, insideTerminal)) {
        event.preventDefault();
      }
    };
    const handleGlobalBeforeInput = (event: InputEvent) => {
      const target = event.target as HTMLElement | null;
      const { route, insideTerminal } = shouldRouteEvent(target);
      if (isCompositionInputEvent(event, isComposingInputRef.current)) return;
      if (!route || insideTerminal || typeof event.data !== "string" || !event.data) return;
      if (performance.now() - lastKeyboardInputAtRef.current < 80) return;
      scheduleNativeTextInputFallback(event.data, { delayMs: 24, eventAt: performance.now() });
      if (shouldPreventDefault(target, insideTerminal)) {
        event.preventDefault();
      }
    };
    const handleGlobalTextInput = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const { route, insideTerminal } = shouldRouteEvent(target);
      if (!route || insideTerminal || isComposingInputRef.current) return;
      const data = terminalTextEventData(event);
      if (!data) return;
      if (performance.now() - lastKeyboardInputAtRef.current < 80) return;
      scheduleNativeTextInputFallback(data, { delayMs: 24, eventAt: performance.now() });
      if (shouldPreventDefault(target, insideTerminal)) {
        event.preventDefault();
      }
    };
    const handleGlobalInput = (event: Event) => {
      if (isComposingInputRef.current) return;
      const target = event.target as HTMLTextAreaElement | HTMLInputElement | HTMLElement | null;
      const { route, insideTerminal } = shouldRouteEvent(
        target instanceof HTMLElement ? target : null,
      );
      if (
        !route ||
        insideTerminal ||
        !target ||
        !("value" in target) ||
        typeof target.value !== "string" ||
        !target.value
      ) {
        return;
      }
      const text = target.value;
      commitNativeTextInputFallback(text, performance.now(), () => {
        if (target.value === text) target.value = "";
      });
    };
    const handleGlobalPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      const { route, insideTerminal } = shouldRouteEvent(target);
      if (!route || insideTerminal) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      scheduleNativeTextInputFallback(text, { delayMs: 24, eventAt: performance.now() });
      if (shouldPreventDefault(target, insideTerminal)) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", handleGlobalKeyDown, true);
    document.addEventListener("keypress", handleGlobalKeyPress, true);
    document.addEventListener("beforeinput", handleGlobalBeforeInput, true);
    document.addEventListener("textInput", handleGlobalTextInput, true);
    document.addEventListener("input", handleGlobalInput, true);
    document.addEventListener("paste", handleGlobalPaste, true);
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, true);
      document.removeEventListener("keypress", handleGlobalKeyPress, true);
      document.removeEventListener("beforeinput", handleGlobalBeforeInput, true);
      document.removeEventListener("textInput", handleGlobalTextInput, true);
      document.removeEventListener("input", handleGlobalInput, true);
      document.removeEventListener("paste", handleGlobalPaste, true);
    };
  }, [
    commitNativeTextInputFallback,
    isActive,
    scheduleNativeTextInputFallback,
    scheduleTerminalInputFallback,
  ]);

  useEffect(() => {
    const api = desktopApi();
    if (!api?.onTerminalEvent) return undefined;
    return api.onTerminalEvent((event) => {
      if (!isTerminalRunEvent(event) || event.id !== terminalId) return;
      if (event.type === "ready") {
        readyRef.current = true;
        flushPendingInput();
        resizeTerminalToPanel();
        focusTerminalInput();
        return;
      }
      if (event.type === "stdout" || event.type === "stderr") {
        terminalRef.current?.write(event.chunk);
        return;
      }
      if (event.type === "exit") {
        readyRef.current = false;
        terminalRef.current?.write(terminalExitMessage(event));
      }
    });
  }, [flushPendingInput, focusTerminalInput, resizeTerminalToPanel, terminalId]);

  useEffect(() => {
    if (!isActive) return undefined;
    const api = desktopApi();
    retainBackendTerminal(terminalId);
    readyRef.current = false;
    pendingInputRef.current = "";
    if (!api?.terminal?.create) {
      terminalRef.current?.write(`${t("terminal.runtimeUnavailable")}\r\n`);
      return undefined;
    }
    void api.terminal
      .create({ id: terminalId, cwd })
      .then(() => {
        readyRef.current = true;
        flushPendingInput();
        resizeTerminalToPanel();
        focusTerminalInput();
      })
      .catch((error) => {
        terminalRef.current?.write(`${String(error instanceof Error ? error.message : error)}\r\n`);
      });
    return () => {
      releaseBackendTerminal(terminalId);
    };
  }, [cwd, flushPendingInput, focusTerminalInput, isActive, resizeTerminalToPanel, t, terminalId]);

  return (
    <div
      ref={mountRef}
      tabIndex={0}
      aria-label={t("detailPanel.terminal")}
      className="side-panel-plugin-interactive bg-code-bg h-full min-h-0 p-2 [&_.xterm]:h-full [&_.xterm-screen]:!bg-transparent [&_.xterm-viewport]:!bg-transparent"
      data-terminal-panel-root
      onClick={focusTerminalInput}
      onFocus={focusTerminalInput}
      onPointerDownCapture={() => {
        window.requestAnimationFrame(focusTerminalInput);
      }}
      onPointerUp={focusTerminalInput}
    />
  );
}

type CompositionInputSnapshot = {
  selectionEnd: number;
  selectionStart: number;
  value: string;
};

type TerminalKeyEventLike = {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey: boolean;
  which?: number;
};

function terminalWorkspaceId(baseId: string, workspaceId: string, cwd: string): string {
  return `${baseId}:${terminalWorkspaceKey(workspaceId, cwd)}`;
}

function terminalWorkspaceKey(workspaceId: string, cwd: string): string {
  return `workspace:${hashString(workspaceId || "__default")}:cwd:${hashString(cwd || "__default")}`;
}

function retainBackendTerminal(id: string): void {
  const timer = terminalBackendReleaseTimers.get(id);
  if (!timer) return;
  window.clearTimeout(timer);
  terminalBackendReleaseTimers.delete(id);
}

function releaseBackendTerminal(id: string): void {
  const existing = terminalBackendReleaseTimers.get(id);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    terminalBackendReleaseTimers.delete(id);
    terminalOutputCache.delete(id);
    void desktopApi()?.terminal?.dispose?.(id);
  }, TERMINAL_BACKEND_RELEASE_DELAY_MS);
  terminalBackendReleaseTimers.set(id, timer);
}

function ensureTerminalOutputRecorder(): void {
  if (terminalOutputRecorderDispose) return;
  const api = desktopApi();
  if (!api?.onTerminalEvent) return;
  terminalOutputRecorderDispose = api.onTerminalEvent((event) => {
    if (!isTerminalRunEvent(event)) return;
    if (event.type === "stdout" || event.type === "stderr") {
      appendTerminalOutputCache(event.id, event.chunk);
      return;
    }
    if (event.type === "exit") {
      appendTerminalOutputCache(event.id, terminalExitMessage(event));
    }
  });
}

function appendTerminalOutputCache(id: string, chunk: string): void {
  if (!chunk) return;
  const current = terminalOutputCache.get(id) ?? "";
  const next = `${current}${chunk}`;
  terminalOutputCache.set(
    id,
    next.length > TERMINAL_OUTPUT_CACHE_LIMIT ? next.slice(-TERMINAL_OUTPUT_CACHE_LIMIT) : next,
  );
}

function terminalExitMessage(event: Extract<TerminalRunEvent, { type: "exit" }>): string {
  return `\r\n[terminal exited with code ${event.code ?? "unknown"}]\r\n`;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isComposingKeyEvent(event: TerminalKeyEventLike, composing: boolean): boolean {
  return composing || event.isComposing === true || event.keyCode === 229 || event.which === 229;
}

function isPlainPrintableKeyEvent(event: TerminalKeyEventLike): boolean {
  return !event.metaKey && !event.altKey && !event.ctrlKey && event.key.length === 1;
}

function terminalKeyData(event: TerminalKeyEventLike): string {
  if (event.metaKey || event.altKey) return "";
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Delete":
      return "\x1b[3~";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    default:
      return event.key.length === 1 ? event.key : "";
  }
}

function terminalKeyPressData(event: KeyboardEvent): string {
  if (event.metaKey || event.altKey || event.ctrlKey) return "";
  if (event.key.length === 1) return event.key;
  const charCode = event.charCode || event.which || 0;
  return charCode >= 32 ? String.fromCharCode(charCode) : "";
}

function terminalTextEventData(event: Event): string {
  const data = (event as Event & { data?: unknown }).data;
  return typeof data === "string" ? data : "";
}

function hasRecentTerminalInput(
  inputs: Array<{ data: string; at: number }>,
  data: string,
  eventAt: number,
  thresholdMs: number,
): boolean {
  return inputs.some((input) => input.data === data && Math.abs(input.at - eventAt) < thresholdMs);
}

function terminalKeyFallbackDelayMs(data: string): number {
  return data.length === 1 && data >= " " ? 45 : 18;
}

function normalizeTerminalTextInput(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function isCompositionInputEvent(event: InputEvent, composing: boolean): boolean {
  return composing || event.isComposing || event.inputType === "insertCompositionText";
}

function terminalImeHelper(mount: HTMLElement | null): HTMLTextAreaElement | null {
  return mount?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ?? null;
}

function readCompositionInputSnapshot(input: HTMLTextAreaElement | null): CompositionInputSnapshot {
  if (!input) return emptyCompositionInputSnapshot;
  return {
    selectionEnd: input.selectionEnd ?? input.value.length,
    selectionStart: input.selectionStart ?? input.value.length,
    value: input.value,
  };
}

function readCompositionInputValue(input: HTMLTextAreaElement | null): string {
  return input?.value ?? "";
}

function resolveComposedTerminalInput(
  eventData: string,
  committedData: string,
  startSnapshot: CompositionInputSnapshot,
  input: HTMLTextAreaElement | null,
): string {
  if (eventData) return eventData;
  if (committedData) return committedData;
  return insertedTextFromCompositionValue(startSnapshot, readCompositionInputValue(input));
}

function insertedTextFromCompositionValue(
  startSnapshot: CompositionInputSnapshot,
  currentValue: string,
): string {
  if (!currentValue || currentValue === startSnapshot.value) return "";
  const start = clampNumber(startSnapshot.selectionStart, 0, startSnapshot.value.length);
  const end = clampNumber(startSnapshot.selectionEnd, start, startSnapshot.value.length);
  const prefix = startSnapshot.value.slice(0, start);
  const suffix = startSnapshot.value.slice(end);
  if (
    currentValue.length >= prefix.length + suffix.length &&
    currentValue.startsWith(prefix) &&
    currentValue.endsWith(suffix)
  ) {
    return currentValue.slice(prefix.length, currentValue.length - suffix.length);
  }
  return currentValue;
}

function clearTerminalImeHelper(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.value = "";
  try {
    input.setSelectionRange(0, 0);
  } catch {
    // Electron can reject selection changes while an IME is committing text.
  }
}

function shouldSuppressXtermInput(
  isComposing: boolean,
  suppressUntil: number,
  at: number,
): boolean {
  return isComposing || at < suppressUntil;
}

function prepareTerminalImeHelper(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "text");
  input.style.position = "absolute";
  input.style.left = "0px";
  input.style.top = "0px";
  input.style.width = "8px";
  input.style.height = "18px";
  input.style.minWidth = "1px";
  input.style.minHeight = "1px";
  input.style.opacity = "0.01";
  input.style.color = "transparent";
  input.style.caretColor = "transparent";
  input.style.background = "transparent";
  input.style.border = "0";
  input.style.margin = "0";
  input.style.outline = "0";
  input.style.overflow = "hidden";
  input.style.padding = "0";
  input.style.pointerEvents = "none";
  input.style.resize = "none";
  input.style.zIndex = "5";
}

function syncTerminalImeHelperGeometry(mount: HTMLElement | null): void {
  const helper = terminalImeHelper(mount);
  if (!mount || !helper) return;
  prepareTerminalImeHelper(helper);
  const terminalElement = helper.closest<HTMLElement>(".xterm") ?? mount;
  const cursor = mount.querySelector<HTMLElement>(".xterm-cursor");
  const terminalRect = terminalElement.getBoundingClientRect();
  const cursorRect = cursor?.getBoundingClientRect();
  const computed = getComputedStyle(terminalElement);
  const fontSize = parseFloat(computed.fontSize) || 12;
  const fallbackHeight = Math.max(16, Math.ceil(fontSize * 1.22));
  const width = Math.max(2, Math.ceil(cursorRect?.width || fontSize * 0.65));
  const height = Math.max(12, Math.ceil(cursorRect?.height || fallbackHeight));
  const rawLeft = cursorRect ? cursorRect.left - terminalRect.left : 0;
  const rawTop = cursorRect ? cursorRect.top - terminalRect.top : 0;
  const maxLeft = Math.max(0, terminalElement.clientWidth - width);
  const maxTop = Math.max(0, terminalElement.clientHeight - height);
  helper.style.left = `${clampNumber(rawLeft, 0, maxLeft)}px`;
  helper.style.top = `${clampNumber(rawTop, 0, maxTop)}px`;
  helper.style.width = `${width}px`;
  helper.style.height = `${height}px`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isInteractiveKeyboardTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest(
      "input, textarea, select, button, a[href], [role='button'], [role='tab'], [contenteditable='true']",
    ),
  );
}

function browserPanelErrorMessage(
  error: unknown,
  fallback: string,
  missingAnnotationHandlerFallback?: string,
): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.trim();
  if (!message) return fallback;
  if (
    missingAnnotationHandlerFallback &&
    message.includes("No handler registered for 'agui:browser:set-annotation-mode'")
  ) {
    return missingAnnotationHandlerFallback;
  }
  const ipcMessage = message.match(/^Error invoking remote method '[^']+':(?: Error:)?\s*(.*)$/s);
  return ipcMessage?.[1]?.trim() || message;
}

function annotationStatusClassName(
  status: string,
  readyLabel: string,
  error: string | null,
): string {
  if (status === readyLabel) return "border-success/30 bg-success/10 text-success";
  if (error && status === error) return "border-danger/30 bg-danger/10 text-danger";
  return "border-warning/30 bg-warning/10 text-warning";
}

function browserAnnotationsSignature(
  annotations: BrowserAnnotation[],
  snapshots: BrowserSnapshotDraft[],
  url: string,
  title: string,
): string {
  return JSON.stringify({
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      note: annotation.note,
      rect: annotation.rect,
      selector: annotation.selector,
      styles: annotation.styles,
      text: annotation.text,
      type: annotation.type,
    })),
    snapshots: snapshots.map((snapshot) => ({
      createdAt: snapshot.createdAt,
      id: snapshot.id,
      mimeType: snapshot.mimeType,
      text: snapshot.text,
      title: snapshot.title,
      url: snapshot.url,
    })),
    title,
    url,
  });
}

function browserAnnotationIdentity(annotation: BrowserAnnotation): string {
  return annotation.id || `${annotation.createdAt}:${annotation.note}:${annotation.selector ?? ""}`;
}

function browserAnnotationIdentitySet(annotations: BrowserAnnotation[]): Set<string> {
  return new Set(annotations.map(browserAnnotationIdentity));
}

function hasNewBrowserAnnotation(annotations: BrowserAnnotation[], baseline: Set<string>): boolean {
  return annotations.some((annotation) => !baseline.has(browserAnnotationIdentity(annotation)));
}

function browserAnnotationsEqual(left: BrowserAnnotation[], right: BrowserAnnotation[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (annotation, index) =>
      browserAnnotationIdentity(annotation) === browserAnnotationIdentity(right[index]),
  );
}

function browserSnapshotsEqual(
  left: BrowserSnapshotDraft[],
  right: BrowserSnapshotDraft[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (snapshot, index) =>
      snapshot.id === right[index]?.id && snapshot.createdAt === right[index]?.createdAt,
  );
}

type RemoteBrowserFrame = {
  dataUrl: string;
  metadata: Record<string, unknown>;
  mimeType: "image/jpeg" | "image/png";
  sessionId: number;
  timestamp: number;
};

type BrowserAnnotationToolAction = "snapshot" | "undo" | "clear";

type RemoteBrowserPoint = {
  x: number;
  y: number;
};

type RemoteBrowserSelection = {
  current: RemoteBrowserPoint;
  start: RemoteBrowserPoint;
};

type RemoteBrowserBounds = ReturnType<typeof browserViewBounds>;

type RemoteBrowserAnnotationTarget =
  | { type: "element"; selector?: string; x: number; y: number }
  | { type: "region"; rect: BrowserRect };

type RemoteBrowserAnnotationEditorState = {
  anchor: RemoteBrowserPoint;
  id: string;
  target: RemoteBrowserAnnotationTarget;
};

function currentTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const readColor = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: readColor("--terminal-background", readColor("--code-bg", "#0b0f14")),
    black: readColor("--ansi-black", "#111827"),
    blue: readColor("--ansi-blue", "#58a6ff"),
    brightBlack: readColor("--ansi-bright-black", "#6b7280"),
    brightBlue: readColor("--ansi-bright-blue", "#8ab4f8"),
    brightCyan: readColor("--ansi-bright-cyan", "#7dd3fc"),
    brightGreen: readColor("--ansi-bright-green", "#86efac"),
    brightMagenta: readColor("--ansi-bright-magenta", "#d8b4fe"),
    brightRed: readColor("--ansi-bright-red", "#fca5a5"),
    brightWhite: readColor("--ansi-bright-white", "#f8fafc"),
    brightYellow: readColor("--ansi-bright-yellow", "#fde68a"),
    cursor: readColor("--terminal-cursor", readColor("--accent", "#9ccfd8")),
    cyan: readColor("--ansi-cyan", "#22d3ee"),
    foreground: readColor("--terminal-foreground", readColor("--fg-primary", "#e5e7eb")),
    green: readColor("--ansi-green", "#22c55e"),
    magenta: readColor("--ansi-magenta", "#c084fc"),
    red: readColor("--ansi-red", "#ef4444"),
    selectionBackground: readColor("--terminal-selection", "rgba(148, 163, 184, 0.35)"),
    white: readColor("--ansi-white", "#e5e7eb"),
    yellow: readColor("--ansi-yellow", "#eab308"),
  };
}

export function BrowserPanel({ instance }: { instance?: DetailPanelInstance }) {
  const t = useT();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const remoteSurfaceRef = useRef<HTMLDivElement | null>(null);
  const browserId = useMemo(() => instance?.id ?? uid("browser"), [instance?.id]);
  const isActive = instance?.active !== false;
  const [url, setUrl] = useState(BROWSER_HOME_URL);
  const [address, setAddress] = useState("");
  const [title, setTitle] = useState(() => t("browser.newTab"));
  const [faviconUrl, setFaviconUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [automationReady, setAutomationReady] = useState(false);
  const [annotationToolsEnabled, setAnnotationToolsEnabled] = useState(false);
  const [annotationToolbarExpanded, setAnnotationToolbarExpanded] = useState(false);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationCount, setAnnotationCount] = useState(0);
  const [annotationStatus, setAnnotationStatus] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [history, setHistory] = useState<string[]>([BROWSER_HOME_URL]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [remoteFrame, setRemoteFrame] = useState<RemoteBrowserFrame | null>(null);
  const [remoteAnnotations, setRemoteAnnotations] = useState<BrowserAnnotation[]>([]);
  const [browserSnapshots, setBrowserSnapshots] = useState<BrowserSnapshotDraft[]>([]);
  const [remoteSelection, setRemoteSelection] = useState<RemoteBrowserSelection | null>(null);
  const [remoteAnnotationEditor, setRemoteAnnotationEditor] =
    useState<RemoteBrowserAnnotationEditorState | null>(null);
  const [remoteAnnotationSaving, setRemoteAnnotationSaving] = useState(false);
  const nativeBrowserCreatedRef = useRef(false);
  const remoteBrowserCreatedRef = useRef(false);
  const remoteBrowserReadyPromiseRef = useRef<Promise<void> | null>(null);
  const remotePointerDownRef = useRef<RemoteBrowserPoint | null>(null);
  const remoteAnnotationEditorRef = useRef<RemoteBrowserAnnotationEditorState | null>(null);
  const remoteScreencastSizeRef = useRef("");
  const annotationRequestRef = useRef(0);
  const annotationDraftSignatureRef = useRef("");
  const annotationModeRef = useRef(false);
  const annotationOneShotActiveRef = useRef(false);
  const annotationOneShotBaselineIdsRef = useRef(new Set<string>());
  const browserAnnotationsRef = useRef<BrowserAnnotation[]>([]);
  const browserSnapshotsRef = useRef<BrowserSnapshotDraft[]>([]);
  const browserToolActionRefs = useRef<Record<BrowserAnnotationToolAction, (() => void) | null>>({
    clear: null,
    snapshot: null,
    undo: null,
  });
  const urlRef = useRef(url);
  const titleRef = useRef(title);
  const browserSurfaceVisibleRef = useRef(false);
  const browserUnavailableLabelRef = useRef(t("browser.unavailable"));
  const canUseNativeBrowser = desktopApi()?.features.webContentsView === true;
  const browserApi = desktopApi()?.browser;
  const canUseRemoteBrowser =
    !canUseNativeBrowser &&
    desktopApi()?.transport === "websocket" &&
    typeof browserApi?.screencastStart === "function" &&
    typeof browserApi?.screencastAck === "function" &&
    typeof browserApi?.dispatchMouse === "function";
  const canUseBrowserAutomation = canUseNativeBrowser || canUseRemoteBrowser;
  const annotationRuntimeAvailable =
    typeof browserApi?.setAnnotationMode === "function" &&
    typeof browserApi?.listAnnotations === "function";
  const canUseInjectedAnnotationToolbar =
    canUseNativeBrowser || (canUseRemoteBrowser && typeof browserApi?.evaluate === "function");
  const hasNativeBrowserSurface = canUseNativeBrowser && url !== BROWSER_HOME_URL;
  const hasRemoteBrowserSurface = canUseRemoteBrowser && url !== BROWSER_HOME_URL;
  const setDetailPanelTabTitle = useShellStore((state) => state.setDetailPanelTabTitle);
  const setDetailPanelTabIconUrl = useShellStore((state) => state.setDetailPanelTabIconUrl);
  const nativeBrowserOverlayOpen = useShellStore((state) => state.nativeBrowserOverlayOpen);
  const browserAnnotationsDraft = useUIStore((state) => state.browserAnnotationsDraft);
  const browserSurfaceVisible = isActive && !nativeBrowserOverlayOpen;

  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    annotationModeRef.current = annotationMode;
  }, [annotationMode]);

  useEffect(() => {
    remoteAnnotationEditorRef.current = remoteAnnotationEditor;
  }, [remoteAnnotationEditor]);

  useEffect(() => {
    browserSurfaceVisibleRef.current = browserSurfaceVisible;
  }, [browserSurfaceVisible]);

  useEffect(() => {
    browserUnavailableLabelRef.current = t("browser.unavailable");
  }, [t]);

  useEffect(() => {
    if (url === BROWSER_HOME_URL) setTitle(t("browser.newTab"));
  }, [t, url]);

  useEffect(() => {
    if (!instance?.id || !isActive) return;
    setDetailPanelTabTitle(instance.id, title || t("detailPanel.browser"));
  }, [instance?.id, isActive, setDetailPanelTabTitle, t, title]);

  useEffect(() => {
    if (!instance?.id || !isActive) return;
    setDetailPanelTabIconUrl(instance.id, faviconUrl);
  }, [faviconUrl, instance?.id, isActive, setDetailPanelTabIconUrl]);

  const applyTargetState = useCallback(
    (target: {
      url: string;
      title: string;
      faviconUrl?: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }) => {
      const current = target.url || BROWSER_HOME_URL;
      setUrl(current);
      setAddress(current === BROWSER_HOME_URL ? "" : current);
      setTitle(target.title || browserTitle(current, t("browser.newTab")));
      setFaviconUrl(browserFaviconUrl(current, target.faviconUrl));
      setLoading(target.loading);
      setCanGoBack(target.canGoBack);
      setCanGoForward(target.canGoForward);
    },
    [t],
  );

  const publishBrowserContext = useCallback(
    (annotations: BrowserAnnotation[], snapshots: BrowserSnapshotDraft[]) => {
      const currentUrl = urlRef.current;
      const currentTitle = titleRef.current;
      const signature =
        annotations.length || snapshots.length
          ? browserAnnotationsSignature(annotations, snapshots, currentUrl, currentTitle)
          : "";
      if (annotationDraftSignatureRef.current === signature) return;
      annotationDraftSignatureRef.current = signature;
      const ui = useUIStore.getState();
      if (!annotations.length && !snapshots.length) {
        ui.clearBrowserAnnotationsDraft(browserId);
        return;
      }
      ui.setBrowserAnnotationsDraft({
        annotations,
        browserId,
        snapshots,
        title: currentTitle,
        updatedAt: Date.now(),
        url: currentUrl,
      });
    },
    [browserId],
  );

  const completeOneShotAnnotation = useCallback(() => {
    if (!annotationOneShotActiveRef.current) return;
    annotationOneShotActiveRef.current = false;
    annotationOneShotBaselineIdsRef.current = new Set<string>();
    annotationRequestRef.current += 1;
    setAnnotationMode(false);
    setAnnotationToolbarExpanded(false);
    setAnnotationStatus(t("browser.annotationAdded"));
    setRemoteAnnotationEditor(null);
    setRemoteSelection(null);
    void desktopApi()
      ?.browser?.setAnnotationMode?.({ id: browserId, enabled: false })
      .catch(() => undefined);
  }, [browserId, t]);

  const applyRemoteAnnotations = useCallback(
    (annotations: BrowserAnnotation[]) => {
      setAnnotationCount(annotations.length);
      setRemoteAnnotations(annotations);
      browserAnnotationsRef.current = annotations;
      publishBrowserContext(annotations, browserSnapshotsRef.current);
      if (
        annotationModeRef.current &&
        annotationOneShotActiveRef.current &&
        hasNewBrowserAnnotation(annotations, annotationOneShotBaselineIdsRef.current)
      ) {
        completeOneShotAnnotation();
      }
    },
    [completeOneShotAnnotation, publishBrowserContext],
  );

  const updateBrowserSnapshots = useCallback(
    (snapshots: BrowserSnapshotDraft[]) => {
      browserSnapshotsRef.current = snapshots;
      setBrowserSnapshots(snapshots);
      publishBrowserContext(browserAnnotationsRef.current, snapshots);
    },
    [publishBrowserContext],
  );

  useEffect(() => {
    if (!browserAnnotationsDraft) {
      if (browserSnapshotsRef.current.length) {
        browserSnapshotsRef.current = [];
        setBrowserSnapshots([]);
      }
      if (browserAnnotationsRef.current.length) {
        browserAnnotationsRef.current = [];
        setRemoteAnnotations([]);
        setAnnotationCount(0);
      }
      return;
    }
    if (browserAnnotationsDraft.browserId !== browserId) return;
    const draftSnapshots = browserAnnotationsDraft.snapshots ?? [];
    if (!browserSnapshotsEqual(draftSnapshots, browserSnapshotsRef.current)) {
      browserSnapshotsRef.current = draftSnapshots;
      setBrowserSnapshots(draftSnapshots);
    }
    if (
      !browserAnnotationsEqual(browserAnnotationsDraft.annotations, browserAnnotationsRef.current)
    ) {
      browserAnnotationsRef.current = browserAnnotationsDraft.annotations;
      setRemoteAnnotations(browserAnnotationsDraft.annotations);
      setAnnotationCount(browserAnnotationsDraft.annotations.length);
    }
  }, [browserAnnotationsDraft, browserId]);

  useEffect(() => {
    if (url !== BROWSER_HOME_URL) return;
    if (remoteBrowserCreatedRef.current) {
      remoteBrowserCreatedRef.current = false;
      remoteScreencastSizeRef.current = "";
      void desktopApi()
        ?.browser?.screencastStop?.({ id: browserId })
        .catch(() => undefined);
      void desktopApi()
        ?.browser?.unregister?.(browserId)
        .catch(() => undefined);
    }
    setAnnotationToolsEnabled(false);
    setAnnotationToolbarExpanded(false);
    setAnnotationMode(false);
    annotationOneShotActiveRef.current = false;
    annotationOneShotBaselineIdsRef.current = new Set<string>();
    setAnnotationCount(0);
    setAnnotationStatus(null);
    setRemoteFrame(null);
    setRemoteAnnotations([]);
    browserAnnotationsRef.current = [];
    browserSnapshotsRef.current = [];
    setBrowserSnapshots([]);
    setRemoteSelection(null);
    setRemoteAnnotationEditor(null);
    setRemoteAnnotationSaving(false);
    publishBrowserContext([], []);
  }, [browserId, publishBrowserContext, url]);

  useEffect(() => {
    if (annotationMode || !automationReady || url === BROWSER_HOME_URL) return;
    void desktopApi()
      ?.browser?.setAnnotationMode?.({ id: browserId, enabled: false })
      .catch(() => undefined);
  }, [annotationMode, automationReady, browserId, url]);

  useEffect(() => {
    if (!hasNativeBrowserSurface) return undefined;
    if (!nativeBrowserCreatedRef.current) {
      nativeBrowserCreatedRef.current = true;
      const initialUrl = urlRef.current;
      void desktopApi()
        ?.browser?.create({
          id: browserId,
          url: initialUrl,
          title: titleRef.current,
          bounds: browserSurfaceVisibleRef.current
            ? browserViewBounds(mountRef.current)
            : hiddenBrowserViewBounds(),
        })
        .then((target) => {
          setAutomationReady(true);
          if (target.url !== BROWSER_HOME_URL || initialUrl === BROWSER_HOME_URL) {
            applyTargetState(target);
          }
        })
        .catch((creationError) => {
          nativeBrowserCreatedRef.current = false;
          setAutomationReady(false);
          setError(
            creationError instanceof Error
              ? creationError.message
              : browserUnavailableLabelRef.current,
          );
        });
    }
    return () => {
      nativeBrowserCreatedRef.current = false;
      setAutomationReady(false);
      void desktopApi()?.browser?.unregister?.(browserId);
    };
  }, [applyTargetState, browserId, hasNativeBrowserSurface]);

  useEffect(() => {
    if (!hasNativeBrowserSurface || !nativeBrowserCreatedRef.current) return undefined;
    const syncBounds = () => {
      void desktopApi()
        ?.browser?.setBounds?.({
          id: browserId,
          bounds: browserSurfaceVisible
            ? browserViewBounds(mountRef.current)
            : hiddenBrowserViewBounds(),
        })
        .catch(() => undefined);
    };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    if (mountRef.current) observer.observe(mountRef.current);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    const timer = window.setInterval(syncBounds, 300);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      window.clearInterval(timer);
      void desktopApi()
        ?.browser?.setBounds?.({
          id: browserId,
          bounds: { x: 0, y: 0, width: 0, height: 0, visible: false },
        })
        .catch(() => undefined);
    };
  }, [browserId, browserSurfaceVisible, hasNativeBrowserSurface]);

  useEffect(() => {
    const api = desktopApi();
    if (!api?.onBrowserEvent) return undefined;
    return api.onBrowserEvent((event) => {
      if (!event || event.id !== browserId) return;
      if (event.type === "screencastFrame") {
        void desktopApi()
          ?.browser?.screencastAck?.({ id: browserId, sessionId: event.sessionId })
          .catch(() => undefined);
        setRemoteFrame({
          dataUrl: `data:${event.mimeType};base64,${event.data}`,
          metadata: event.metadata,
          mimeType: event.mimeType,
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        });
        setLoading(false);
        setAutomationReady(true);
        return;
      }
      if (event.type === "annotationsUpdated") {
        applyRemoteAnnotations(event.annotations);
        return;
      }
      if (event.type === "annotationTool") {
        browserToolActionRefs.current[event.action]?.();
        return;
      }
      if (event.type === "updated") {
        if (event.target.url === BROWSER_HOME_URL && urlRef.current !== BROWSER_HOME_URL) {
          return;
        }
        setError(null);
        setAutomationReady(true);
        applyTargetState(event.target);
        return;
      }
      if (event.type === "failed") {
        setError(event.error);
        setLoading(false);
        if (
          event.target &&
          (event.target.url !== BROWSER_HOME_URL || urlRef.current === BROWSER_HOME_URL)
        ) {
          applyTargetState(event.target);
        }
        return;
      }
      if (event.type === "destroyed") {
        setAutomationReady(false);
      }
    });
  }, [applyRemoteAnnotations, applyTargetState, browserId]);

  const ensureNativeBrowserTarget = useCallback(async () => {
    if (!canUseNativeBrowser || urlRef.current === BROWSER_HOME_URL) {
      throw new Error(browserUnavailableLabelRef.current);
    }
    const api = desktopApi()?.browser;
    if (!api?.create) throw new Error(browserUnavailableLabelRef.current);
    const bounds = browserSurfaceVisibleRef.current
      ? browserViewBounds(mountRef.current)
      : hiddenBrowserViewBounds();
    const requestedUrl = urlRef.current;
    try {
      if (nativeBrowserCreatedRef.current && api.list) {
        const targets = await api.list().catch(() => []);
        const current = targets.find((target) => target.id === browserId);
        if (current) {
          await api.setBounds?.({ id: browserId, bounds }).catch(() => undefined);
          if (current.url === BROWSER_HOME_URL && requestedUrl !== BROWSER_HOME_URL) {
            const navigated = await api.navigate?.({
              id: browserId,
              url: requestedUrl,
              waitUntil: "none",
            });
            if (navigated) {
              applyTargetState({
                url: navigated.url,
                title: navigated.title,
                faviconUrl: navigated.faviconUrl,
                loading: current.loading,
                canGoBack: current.canGoBack,
                canGoForward: current.canGoForward,
              });
            }
          }
          setAutomationReady(true);
          return;
        }
      }
      nativeBrowserCreatedRef.current = true;
      const target = await api.create({
        id: browserId,
        url: requestedUrl,
        title: titleRef.current,
        bounds,
      });
      setAutomationReady(true);
      if (target.url !== BROWSER_HOME_URL || requestedUrl === BROWSER_HOME_URL) {
        applyTargetState(target);
      }
    } catch (creationError) {
      nativeBrowserCreatedRef.current = false;
      setAutomationReady(false);
      throw creationError;
    }
  }, [applyTargetState, browserId, canUseNativeBrowser]);

  const ensureRemoteBrowserTarget = useCallback(
    (requestedUrlInput?: string) => {
      if (remoteBrowserReadyPromiseRef.current) return remoteBrowserReadyPromiseRef.current;
      const requestedUrl = requestedUrlInput || urlRef.current;
      const promise = (async () => {
        if (!canUseRemoteBrowser || requestedUrl === BROWSER_HOME_URL) {
          throw new Error(browserUnavailableLabelRef.current);
        }
        const api = desktopApi()?.browser;
        if (!api?.create || !api.screencastStart) {
          throw new Error(browserUnavailableLabelRef.current);
        }
        const bounds = await waitForRemoteBrowserSurfaceBounds(remoteSurfaceRef);
        const screencastInput = remoteBrowserScreencastInputFromBounds(bounds);
        try {
          if (api.list) {
            const targets = await api.list().catch(() => []);
            const current = targets.find((target) => target.id === browserId);
            if (current) {
              remoteBrowserCreatedRef.current = true;
              await api.setBounds?.({ id: browserId, bounds }).catch(() => undefined);
              let nextTarget = current;
              if (!sameBrowserUrl(current.url, requestedUrl)) {
                const navigated = await api.navigate?.({
                  id: browserId,
                  url: requestedUrl,
                  waitUntil: "none",
                });
                if (navigated) {
                  nextTarget = {
                    ...current,
                    faviconUrl: navigated.faviconUrl,
                    loading: false,
                    title: navigated.title,
                    url: navigated.url,
                  };
                }
              }
              await api.screencastStart({ id: browserId, ...screencastInput });
              remoteScreencastSizeRef.current = remoteBrowserScreencastSizeKey(bounds);
              setAutomationReady(true);
              applyTargetState(nextTarget);
              return;
            }
          }
          remoteBrowserCreatedRef.current = true;
          const target = await api.create({
            id: browserId,
            url: requestedUrl,
            title: titleRef.current,
            bounds,
          });
          await api.screencastStart({ id: browserId, ...screencastInput });
          remoteScreencastSizeRef.current = remoteBrowserScreencastSizeKey(bounds);
          setAutomationReady(true);
          applyTargetState(target);
        } catch (creationError) {
          remoteBrowserCreatedRef.current = false;
          setAutomationReady(false);
          setRemoteFrame(null);
          throw creationError;
        }
      })();
      remoteBrowserReadyPromiseRef.current = promise;
      return promise.finally(() => {
        if (remoteBrowserReadyPromiseRef.current === promise) {
          remoteBrowserReadyPromiseRef.current = null;
        }
      });
    },
    [applyTargetState, browserId, canUseRemoteBrowser],
  );

  useEffect(() => {
    if (!hasRemoteBrowserSurface) return undefined;
    void ensureRemoteBrowserTarget().catch((creationError) => {
      setError(
        creationError instanceof Error ? creationError.message : browserUnavailableLabelRef.current,
      );
    });
    return undefined;
  }, [ensureRemoteBrowserTarget, hasRemoteBrowserSurface]);

  useEffect(
    () => () => {
      if (!remoteBrowserCreatedRef.current) return;
      remoteBrowserCreatedRef.current = false;
      remoteScreencastSizeRef.current = "";
      const api = desktopApi()?.browser;
      void api?.screencastStop?.({ id: browserId }).catch(() => undefined);
      void api?.unregister?.(browserId).catch(() => undefined);
    },
    [browserId],
  );

  useEffect(() => {
    if (!hasRemoteBrowserSurface || !remoteBrowserCreatedRef.current) return undefined;
    if (!isActive) {
      void desktopApi()
        ?.browser?.screencastStop?.({ id: browserId })
        .catch(() => undefined);
      return undefined;
    }
    void ensureRemoteBrowserTarget().catch((creationError) => {
      setError(
        creationError instanceof Error ? creationError.message : browserUnavailableLabelRef.current,
      );
    });
    return () => {
      setAutomationReady(false);
      setRemoteSelection(null);
      setRemoteAnnotationEditor(null);
      setRemoteAnnotationSaving(false);
      void desktopApi()
        ?.browser?.screencastStop?.({ id: browserId })
        .catch(() => undefined);
    };
  }, [browserId, ensureRemoteBrowserTarget, hasRemoteBrowserSurface, isActive]);

  useEffect(() => {
    if (!hasRemoteBrowserSurface || !isActive) return undefined;
    const syncBounds = () => {
      const bounds = browserViewBounds(remoteSurfaceRef.current);
      if (!bounds.visible || bounds.width <= 0 || bounds.height <= 0) return;
      const api = desktopApi()?.browser;
      const screencastSizeKey = remoteBrowserScreencastSizeKey(bounds);
      const setBoundsPromise = api?.setBounds?.({ id: browserId, bounds });
      if (!setBoundsPromise) return;
      void setBoundsPromise
        .then(() => {
          if (remoteScreencastSizeRef.current === screencastSizeKey) return;
          remoteScreencastSizeRef.current = screencastSizeKey;
          void api
            ?.screencastStart?.({
              id: browserId,
              ...remoteBrowserScreencastInputFromBounds(bounds),
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
    };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    if (remoteSurfaceRef.current) observer.observe(remoteSurfaceRef.current);
    window.addEventListener("resize", syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [browserId, hasRemoteBrowserSurface, isActive]);

  useEffect(() => {
    if (!annotationMode || !automationReady || url === BROWSER_HOME_URL) return undefined;
    const api = desktopApi()?.browser;
    if (!api?.setAnnotationMode || !api.listAnnotations) {
      setAnnotationMode(false);
      setAnnotationStatus(t("browser.annotationUnavailableRestart"));
      setError(t("browser.annotationUnavailableRestart"));
      return undefined;
    }
    let disposed = false;
    const refreshAnnotations = () => {
      void api
        .listAnnotations({ id: browserId })
        .then((result) => {
          if (disposed) return;
          applyRemoteAnnotations(result.annotations);
        })
        .catch(() => undefined);
    };
    void api
      .setAnnotationMode({ id: browserId, enabled: true })
      .then((result) => {
        if (disposed) return;
        setAnnotationCount(result.annotationCount);
        setAnnotationStatus(t("browser.annotationReady"));
      })
      .catch((annotationError) => {
        if (disposed) return;
        const message = browserPanelErrorMessage(
          annotationError,
          t("browser.annotationError"),
          t("browser.annotationUnavailableRestart"),
        );
        setAnnotationMode(false);
        setAnnotationStatus(message);
        setError(message);
      });
    const timer = window.setInterval(refreshAnnotations, 900);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void api.setAnnotationMode({ id: browserId, enabled: false }).catch(() => undefined);
    };
  }, [annotationMode, applyRemoteAnnotations, automationReady, browserId, t, url]);

  const navigate = (input: string, replace = false) => {
    const next = normalizeBrowserUrl(input);
    if (!next) {
      setError(t("browser.unsupportedUrl"));
      return;
    }
    setError(null);
    setUrl(next);
    setAddress(next === BROWSER_HOME_URL ? "" : next);
    setTitle(browserTitle(next, t("browser.newTab")));
    setFaviconUrl(browserFaviconUrl(next));
    if (canUseBrowserAutomation && next !== BROWSER_HOME_URL) {
      const api = desktopApi();
      const browserCreated = canUseNativeBrowser
        ? nativeBrowserCreatedRef.current
        : remoteBrowserCreatedRef.current;
      if (browserCreated) {
        void api?.browser
          ?.navigate({ id: browserId, url: next, waitUntil: "none" })
          .then((target) => {
            if (!target) return;
            if (target.url === BROWSER_HOME_URL && next !== BROWSER_HOME_URL) return;
            setUrl(target.url);
            setAddress(target.url === BROWSER_HOME_URL ? "" : target.url);
            setTitle(target.title || browserTitle(target.url, t("browser.newTab")));
            setFaviconUrl(browserFaviconUrl(target.url, target.faviconUrl));
          })
          .catch((navigationError) => {
            setAutomationReady(false);
            setError(
              navigationError instanceof Error
                ? navigationError.message
                : t("browser.navigateError"),
            );
          });
      } else if (canUseNativeBrowser) {
        nativeBrowserCreatedRef.current = true;
        void api?.browser
          ?.create({
            id: browserId,
            url: next,
            title: browserTitle(next, t("browser.newTab")),
            bounds: browserSurfaceVisible
              ? browserViewBounds(mountRef.current)
              : hiddenBrowserViewBounds(),
          })
          .then(() => {
            nativeBrowserCreatedRef.current = true;
            setAutomationReady(true);
          })
          .catch((creationError) => {
            nativeBrowserCreatedRef.current = false;
            setAutomationReady(false);
            setError(
              creationError instanceof Error ? creationError.message : t("browser.unavailable"),
            );
          });
      } else {
        setLoading(true);
        void ensureRemoteBrowserTarget(next)
          .then(() => {
            remoteBrowserCreatedRef.current = true;
            setAutomationReady(true);
          })
          .catch((creationError) => {
            remoteBrowserCreatedRef.current = false;
            setAutomationReady(false);
            setLoading(false);
            setError(
              creationError instanceof Error ? creationError.message : t("browser.unavailable"),
            );
          });
      }
    } else {
      setHistory((items) => {
        const base = replace ? items.slice(0, historyIndex) : items.slice(0, historyIndex + 1);
        const nextItems = [...base, next];
        setHistoryIndex(nextItems.length - 1);
        setCanGoBack(nextItems.length > 1);
        setCanGoForward(false);
        return nextItems;
      });
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const submittedAddress =
      event.currentTarget instanceof HTMLFormElement
        ? event.currentTarget.querySelector("input")?.value
        : null;
    navigate(submittedAddress || address);
  };

  const goBack = () => {
    const browserCreated = canUseNativeBrowser
      ? nativeBrowserCreatedRef.current
      : remoteBrowserCreatedRef.current;
    if (canUseBrowserAutomation && browserCreated) {
      void desktopApi()
        ?.browser?.goBack?.({ id: browserId })
        .then((target) => {
          setUrl(target.url);
          setAddress(target.url === BROWSER_HOME_URL ? "" : target.url);
          setTitle(target.title || browserTitle(target.url, t("browser.newTab")));
          setFaviconUrl(browserFaviconUrl(target.url, target.faviconUrl));
        });
      return;
    }
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    const next = history[nextIndex] ?? BROWSER_HOME_URL;
    setUrl(next);
    setAddress(next === BROWSER_HOME_URL ? "" : next);
    setFaviconUrl(browserFaviconUrl(next));
    setCanGoBack(nextIndex > 0);
    setCanGoForward(true);
  };

  const goForward = () => {
    const browserCreated = canUseNativeBrowser
      ? nativeBrowserCreatedRef.current
      : remoteBrowserCreatedRef.current;
    if (canUseBrowserAutomation && browserCreated) {
      void desktopApi()
        ?.browser?.goForward?.({ id: browserId })
        .then((target) => {
          setUrl(target.url);
          setAddress(target.url === BROWSER_HOME_URL ? "" : target.url);
          setTitle(target.title || browserTitle(target.url, t("browser.newTab")));
          setFaviconUrl(browserFaviconUrl(target.url, target.faviconUrl));
        });
      return;
    }
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    const next = history[nextIndex] ?? BROWSER_HOME_URL;
    setUrl(next);
    setAddress(next === BROWSER_HOME_URL ? "" : next);
    setFaviconUrl(browserFaviconUrl(next));
    setCanGoBack(true);
    setCanGoForward(nextIndex < history.length - 1);
  };

  const reload = () => {
    if (loading) {
      void desktopApi()?.browser?.stop?.({ id: browserId });
      setLoading(false);
      return;
    }
    const browserCreated = canUseNativeBrowser
      ? nativeBrowserCreatedRef.current
      : remoteBrowserCreatedRef.current;
    if (canUseBrowserAutomation && browserCreated) {
      void desktopApi()?.browser?.reload?.({ id: browserId, waitUntil: "none" });
    }
    if (!canUseBrowserAutomation && url !== BROWSER_HOME_URL) {
      setUrl((value) => value);
    }
  };

  const ensureCurrentBrowserTarget = useCallback(
    () => (canUseNativeBrowser ? ensureNativeBrowserTarget() : ensureRemoteBrowserTarget()),
    [canUseNativeBrowser, ensureNativeBrowserTarget, ensureRemoteBrowserTarget],
  );

  const captureBrowserSnapshot = useCallback(() => {
    if (!canUseBrowserAutomation || urlRef.current === BROWSER_HOME_URL) return;
    const api = desktopApi()?.browser;
    if (!api?.snapshot || !api.screenshot) return;
    setAnnotationStatus(t("browser.annotationStarting"));
    void ensureCurrentBrowserTarget()
      .then(async () => {
        const [snapshot, screenshot] = await Promise.all([
          api.snapshot({ id: browserId }),
          api.screenshot({ id: browserId, format: "jpeg", quality: 72 }).catch(() => null),
        ]);
        const nextSnapshot: BrowserSnapshotDraft = {
          id: uid("browser-snapshot"),
          createdAt: Date.now(),
          html: snapshot.html,
          mimeType: screenshot?.mimeType,
          screenshotDataUrl: screenshot
            ? `data:${screenshot.mimeType};base64,${screenshot.data}`
            : undefined,
          text: snapshot.text,
          title: snapshot.title,
          url: snapshot.url,
        };
        updateBrowserSnapshots([...browserSnapshotsRef.current, nextSnapshot].slice(-12));
        setAnnotationToolbarExpanded(false);
        setAnnotationStatus(t("browser.snapshotCaptured"));
        setError(null);
      })
      .catch((snapshotError) => {
        const message =
          snapshotError instanceof Error ? snapshotError.message : t("browser.annotationError");
        setAnnotationStatus(message);
        setError(message);
      });
  }, [browserId, canUseBrowserAutomation, ensureCurrentBrowserTarget, t, updateBrowserSnapshots]);

  const undoBrowserContext = useCallback(() => {
    const annotations = browserAnnotationsRef.current;
    const snapshots = browserSnapshotsRef.current;
    const lastAnnotation = annotations.reduce<BrowserAnnotation | null>(
      (latest, annotation) =>
        !latest || annotation.createdAt > latest.createdAt ? annotation : latest,
      null,
    );
    const lastSnapshot = snapshots.reduce<BrowserSnapshotDraft | null>(
      (latest, snapshot) => (!latest || snapshot.createdAt > latest.createdAt ? snapshot : latest),
      null,
    );
    if (!lastAnnotation && !lastSnapshot) return;
    if (lastSnapshot && (!lastAnnotation || lastSnapshot.createdAt >= lastAnnotation.createdAt)) {
      updateBrowserSnapshots(snapshots.filter((snapshot) => snapshot.id !== lastSnapshot.id));
      setAnnotationToolbarExpanded(false);
      return;
    }
    if (!lastAnnotation) return;
    const api = desktopApi()?.browser;
    if (!api?.deleteAnnotation) return;
    void api
      .deleteAnnotation({ id: browserId, annotationId: lastAnnotation.id })
      .then(async (result) => {
        const fallbackAnnotations = browserAnnotationsRef.current.filter(
          (annotation) => annotation.id !== lastAnnotation.id,
        );
        if (!result.deleted) {
          applyRemoteAnnotations(fallbackAnnotations);
          setAnnotationToolbarExpanded(false);
          return;
        }
        const listed = await api.listAnnotations?.({ id: browserId }).catch(() => null);
        applyRemoteAnnotations(listed?.annotations ?? fallbackAnnotations);
        setAnnotationToolbarExpanded(false);
      })
      .catch((annotationError) => {
        const message =
          annotationError instanceof Error ? annotationError.message : t("browser.annotationError");
        setAnnotationStatus(message);
        setError(message);
      });
  }, [applyRemoteAnnotations, browserId, t, updateBrowserSnapshots]);

  const clearBrowserContext = useCallback(() => {
    const api = desktopApi()?.browser;
    updateBrowserSnapshots([]);
    if (!api?.clearAnnotations) {
      applyRemoteAnnotations([]);
      setAnnotationToolbarExpanded(false);
      setAnnotationStatus(t("browser.browserContextCleared"));
      return;
    }
    void api
      .clearAnnotations({ id: browserId })
      .then(async () => {
        const listed = await api.listAnnotations?.({ id: browserId }).catch(() => null);
        applyRemoteAnnotations(listed?.annotations ?? []);
        setAnnotationToolbarExpanded(false);
        setAnnotationStatus(t("browser.browserContextCleared"));
      })
      .catch((annotationError) => {
        const message =
          annotationError instanceof Error ? annotationError.message : t("browser.annotationError");
        setAnnotationStatus(message);
        setError(message);
      });
  }, [applyRemoteAnnotations, browserId, t, updateBrowserSnapshots]);

  useEffect(() => {
    browserToolActionRefs.current = {
      clear: clearBrowserContext,
      snapshot: captureBrowserSnapshot,
      undo: undoBrowserContext,
    };
  }, [captureBrowserSnapshot, clearBrowserContext, undoBrowserContext]);

  const setInjectedAnnotationToolbarVisible = useCallback(
    async (visible: boolean, options?: { syncAnnotations?: boolean }) => {
      if (!canUseInjectedAnnotationToolbar) return;
      const api = desktopApi()?.browser;
      if (!api?.evaluate || !api.listAnnotations) throw new Error(t("browser.annotationError"));
      await ensureCurrentBrowserTarget();
      await api.listAnnotations({ id: browserId });
      await api.evaluate({
        id: browserId,
        awaitPromise: true,
        expression: `(() => {
          const controller = window.__aguiBrowserAnnotations;
          if (!controller?.setToolbarVisible) throw new Error("Annotation toolbar is unavailable.");
          return controller.setToolbarVisible(${visible ? "true" : "false"});
        })()`,
      });
      if (options?.syncAnnotations === false) return;
      const listed = await api.listAnnotations({ id: browserId }).catch(() => null);
      if (listed) applyRemoteAnnotations(listed.annotations);
    },
    [
      applyRemoteAnnotations,
      browserId,
      canUseInjectedAnnotationToolbar,
      ensureCurrentBrowserTarget,
      t,
    ],
  );

  const stopOneShotAnnotation = useCallback(
    (status: string | null = null) => {
      annotationOneShotActiveRef.current = false;
      annotationOneShotBaselineIdsRef.current = new Set<string>();
      annotationRequestRef.current += 1;
      setAnnotationMode(false);
      setAnnotationStatus(status);
      setRemoteAnnotationEditor(null);
      setRemoteAnnotationSaving(false);
      setRemoteSelection(null);
      void desktopApi()
        ?.browser?.setAnnotationMode?.({ id: browserId, enabled: false })
        .catch(() => undefined);
    },
    [browserId],
  );

  useEffect(() => {
    if (
      !annotationToolsEnabled ||
      !automationReady ||
      !canUseInjectedAnnotationToolbar ||
      url === BROWSER_HOME_URL
    )
      return;
    void setInjectedAnnotationToolbarVisible(true, { syncAnnotations: false }).catch(
      (annotationError) => {
        const message = browserPanelErrorMessage(
          annotationError,
          t("browser.annotationError"),
          t("browser.annotationUnavailableRestart"),
        );
        setAnnotationToolsEnabled(false);
        setAnnotationToolbarExpanded(false);
        stopOneShotAnnotation(message);
        setError(message);
      },
    );
  }, [
    annotationToolsEnabled,
    automationReady,
    canUseInjectedAnnotationToolbar,
    setInjectedAnnotationToolbarVisible,
    stopOneShotAnnotation,
    t,
    url,
  ]);

  const toggleAnnotationTools = () => {
    const api = desktopApi()?.browser;
    if (
      !canUseBrowserAutomation ||
      url === BROWSER_HOME_URL ||
      !api?.setAnnotationMode ||
      !api.listAnnotations ||
      (canUseInjectedAnnotationToolbar && !api.evaluate)
    ) {
      setAnnotationMode(false);
      setAnnotationToolsEnabled(false);
      setAnnotationToolbarExpanded(false);
      setAnnotationStatus(t("browser.annotationUnavailableRestart"));
      setError(t("browser.annotationUnavailableRestart"));
      return;
    }
    const next = !annotationToolsEnabled;
    setAnnotationToolsEnabled(next);
    setAnnotationToolbarExpanded(false);
    setAnnotationStatus(null);
    if (!next) {
      stopOneShotAnnotation(null);
    }
    if (!canUseInjectedAnnotationToolbar) return;
    void setInjectedAnnotationToolbarVisible(next).catch((annotationError) => {
      if (!next) return;
      const message = browserPanelErrorMessage(
        annotationError,
        t("browser.annotationError"),
        t("browser.annotationUnavailableRestart"),
      );
      setAnnotationToolsEnabled(false);
      setAnnotationToolbarExpanded(false);
      stopOneShotAnnotation(message);
      setError(message);
    });
  };

  const startOneShotAnnotation = () => {
    if (canUseInjectedAnnotationToolbar) return;
    if (!annotationToolsEnabled || !canUseBrowserAutomation || url === BROWSER_HOME_URL) return;
    const api = desktopApi()?.browser;
    if (!api?.setAnnotationMode || !api.listAnnotations) {
      setAnnotationMode(false);
      setAnnotationStatus(t("browser.annotationUnavailableRestart"));
      setError(t("browser.annotationUnavailableRestart"));
      return;
    }
    if (annotationMode) {
      stopOneShotAnnotation(null);
      setAnnotationToolbarExpanded(false);
      return;
    }
    const requestId = annotationRequestRef.current + 1;
    annotationRequestRef.current = requestId;
    annotationOneShotBaselineIdsRef.current = browserAnnotationIdentitySet(remoteAnnotations);
    annotationOneShotActiveRef.current = true;
    setAnnotationStatus(t("browser.annotationStarting"));
    const timeout = window.setTimeout(() => {
      if (annotationRequestRef.current !== requestId) return;
      annotationRequestRef.current = requestId + 1;
      annotationOneShotActiveRef.current = false;
      annotationOneShotBaselineIdsRef.current = new Set<string>();
      setAnnotationStatus(t("browser.annotationTimeout"));
      setError(t("browser.annotationTimeout"));
    }, 3000);
    const ensureTarget = canUseNativeBrowser
      ? ensureNativeBrowserTarget
      : ensureRemoteBrowserTarget;
    void ensureTarget()
      .then(async () => {
        const listed = await api.listAnnotations({ id: browserId }).catch(() => null);
        if (!listed) return;
        annotationOneShotBaselineIdsRef.current = browserAnnotationIdentitySet(listed.annotations);
        applyRemoteAnnotations(listed.annotations);
      })
      .then(() => api.setAnnotationMode({ id: browserId, enabled: true }))
      .then((result) => {
        if (annotationRequestRef.current !== requestId) return;
        window.clearTimeout(timeout);
        setError(null);
        setAnnotationMode(result.enabled);
        annotationOneShotActiveRef.current = result.enabled;
        if (!result.enabled) {
          annotationOneShotBaselineIdsRef.current = new Set<string>();
        }
        setAnnotationCount(result.annotationCount);
        setAnnotationStatus(result.enabled ? t("browser.annotationReady") : null);
      })
      .catch((annotationError) => {
        if (annotationRequestRef.current !== requestId) return;
        window.clearTimeout(timeout);
        const message = browserPanelErrorMessage(
          annotationError,
          t("browser.annotationError"),
          t("browser.annotationUnavailableRestart"),
        );
        setAnnotationMode(false);
        annotationOneShotActiveRef.current = false;
        annotationOneShotBaselineIdsRef.current = new Set<string>();
        setAnnotationStatus(message);
        setError(message);
      });
  };

  const openRemoteAnnotationEditor = useCallback(
    (start: RemoteBrowserPoint, current: RemoteBrowserPoint) => {
      const api = desktopApi()?.browser;
      const selection = remoteBrowserRectFromPoints(start, current);
      const isRegion = remoteBrowserIsRegionSelection(selection);
      const editorId = uid("remote-annotation-editor");
      setRemoteSelection({ start, current: isRegion ? current : start });
      setRemoteAnnotationSaving(false);
      setRemoteAnnotationEditor({
        anchor: current,
        id: editorId,
        target: isRegion
          ? { type: "region", rect: selection }
          : { type: "element", x: start.x, y: start.y },
      });
      if (isRegion || !api?.inspectElement) return;
      void api
        .inspectElement({ id: browserId, x: start.x, y: start.y })
        .then((result) => {
          const element = result.element;
          if (!element || remoteAnnotationEditorRef.current?.id !== editorId) return;
          setRemoteAnnotationEditor((editor) => {
            if (!editor || editor.id !== editorId || editor.target.type !== "element")
              return editor;
            return {
              ...editor,
              target: {
                ...editor.target,
                selector: element.selector || editor.target.selector,
              },
            };
          });
          if (element.rect) {
            setRemoteSelection(remoteBrowserSelectionFromPageRect(element.rect, element.viewport));
          }
        })
        .catch(() => undefined);
    },
    [browserId],
  );

  const closeRemoteAnnotationEditor = useCallback(() => {
    setRemoteAnnotationEditor(null);
    setRemoteAnnotationSaving(false);
    setRemoteSelection(null);
    if (!annotationModeRef.current && !annotationOneShotActiveRef.current) return;
    annotationOneShotActiveRef.current = false;
    annotationOneShotBaselineIdsRef.current = new Set<string>();
    annotationRequestRef.current += 1;
    setAnnotationMode(false);
    setAnnotationToolbarExpanded(false);
    setAnnotationStatus(null);
    void desktopApi()
      ?.browser?.setAnnotationMode?.({ id: browserId, enabled: false })
      .catch(() => undefined);
  }, [browserId]);

  const saveRemoteAnnotation = useCallback(
    (noteInput: string) => {
      const editor = remoteAnnotationEditorRef.current;
      const api = desktopApi()?.browser;
      const note = noteInput.trim();
      if (!editor || !api?.addAnnotation || !note) return;
      const input =
        editor.target.type === "region"
          ? { id: browserId, note, type: "region" as const, rect: editor.target.rect }
          : {
              id: browserId,
              note,
              type: "element" as const,
              selector: editor.target.selector,
              x: editor.target.x,
              y: editor.target.y,
            };
      setRemoteAnnotationSaving(true);
      void api
        .addAnnotation(input)
        .then(async (result) => {
          const listed = await api.listAnnotations?.({ id: browserId }).catch(() => null);
          applyRemoteAnnotations(
            listed?.annotations ?? [
              ...remoteAnnotations.filter((annotation) => annotation.id !== result.annotation.id),
              result.annotation,
            ],
          );
          setRemoteAnnotationEditor(null);
          setRemoteSelection(null);
        })
        .catch((annotationError) => {
          setError(
            annotationError instanceof Error
              ? annotationError.message
              : t("browser.annotationError"),
          );
        })
        .finally(() => {
          setRemoteAnnotationSaving(false);
        });
    },
    [applyRemoteAnnotations, browserId, remoteAnnotations, t],
  );

  const removeRemoteAnnotation = useCallback(
    (annotationId: string) => {
      const api = desktopApi()?.browser;
      if (!api?.deleteAnnotation) return;
      void api
        .deleteAnnotation({ id: browserId, annotationId })
        .then(async () => {
          const listed = await api.listAnnotations?.({ id: browserId }).catch(() => null);
          applyRemoteAnnotations(
            listed?.annotations ??
              remoteAnnotations.filter((annotation) => annotation.id !== annotationId),
          );
        })
        .catch((annotationError) => {
          setError(
            annotationError instanceof Error
              ? annotationError.message
              : t("browser.annotationError"),
          );
        });
    },
    [applyRemoteAnnotations, browserId, remoteAnnotations, t],
  );

  const handleRemotePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || !remoteFrame) return;
      const point = remoteBrowserPointFromEvent(event, remoteSurfaceRef.current, remoteFrame);
      if (!point) return;
      event.preventDefault();
      remoteSurfaceRef.current?.focus({ preventScroll: true });
      if (annotationMode && remoteAnnotationEditorRef.current) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail for synthetic or already-cancelled events.
      }
      remotePointerDownRef.current = point;
      if (annotationMode) {
        setRemoteSelection({ start: point, current: point });
        return;
      }
      void desktopApi()
        ?.browser?.dispatchMouse?.({
          id: browserId,
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        })
        .catch(() => undefined);
    },
    [annotationMode, browserId, canUseRemoteBrowser, remoteFrame],
  );

  const handleRemotePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || !remoteFrame || !remotePointerDownRef.current) return;
      const point = remoteBrowserPointFromEvent(event, remoteSurfaceRef.current, remoteFrame);
      if (!point) return;
      event.preventDefault();
      if (annotationMode) {
        setRemoteSelection((selection) =>
          selection ? { ...selection, current: point } : { start: point, current: point },
        );
        return;
      }
      void desktopApi()
        ?.browser?.dispatchMouse?.({
          id: browserId,
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        })
        .catch(() => undefined);
    },
    [annotationMode, browserId, canUseRemoteBrowser, remoteFrame],
  );

  const handleRemotePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || !remoteFrame) return;
      const start = remotePointerDownRef.current;
      remotePointerDownRef.current = null;
      if (!start) return;
      const point =
        remoteBrowserPointFromEvent(event, remoteSurfaceRef.current, remoteFrame) ?? start;
      event.preventDefault();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
      if (annotationMode) {
        openRemoteAnnotationEditor(start, point);
        return;
      }
      void desktopApi()
        ?.browser?.dispatchMouse?.({
          id: browserId,
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => undefined);
    },
    [annotationMode, browserId, canUseRemoteBrowser, openRemoteAnnotationEditor, remoteFrame],
  );

  const handleRemoteWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || !remoteFrame) return;
      const point = remoteBrowserPointFromEvent(event, remoteSurfaceRef.current, remoteFrame);
      if (!point) return;
      event.preventDefault();
      void desktopApi()
        ?.browser?.dispatchMouse?.({
          id: browserId,
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          button: "none",
          buttons: 0,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        })
        .catch(() => undefined);
    },
    [browserId, canUseRemoteBrowser, remoteFrame],
  );

  const handleRemoteKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || annotationMode) return;
      const input = remoteBrowserKeyDownInput(event);
      if (!input) return;
      event.preventDefault();
      if ("insertText" in input) {
        void desktopApi()
          ?.browser?.insertText?.({ id: browserId, text: input.insertText })
          .catch(() => undefined);
        return;
      }
      void desktopApi()
        ?.browser?.dispatchKey?.({ id: browserId, ...input })
        .catch(() => undefined);
    },
    [annotationMode, browserId, canUseRemoteBrowser],
  );

  const handleRemoteKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || annotationMode) return;
      const input = remoteBrowserKeyUpInput(event);
      if (!input) return;
      event.preventDefault();
      void desktopApi()
        ?.browser?.dispatchKey?.({ id: browserId, ...input })
        .catch(() => undefined);
    },
    [annotationMode, browserId, canUseRemoteBrowser],
  );

  const handleRemotePaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!canUseRemoteBrowser || annotationMode) return;
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      void desktopApi()
        ?.browser?.insertText?.({ id: browserId, text })
        .catch(() => undefined);
    },
    [annotationMode, browserId, canUseRemoteBrowser],
  );

  const openExternal = () => {
    if (!isExternalOpenable(url)) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const annotationAvailable =
    canUseBrowserAutomation && annotationRuntimeAvailable && url !== BROWSER_HOME_URL;
  const browserContextCount = annotationCount + browserSnapshots.length;
  const annotationToolsLabel = !annotationRuntimeAvailable
    ? t("browser.annotationUnavailableRestart")
    : browserContextCount
      ? t("browser.annotationToolsWithCount", { count: browserContextCount })
      : t("browser.annotationTools");
  const annotationActionLabel = !annotationRuntimeAvailable
    ? t("browser.annotationUnavailableRestart")
    : annotationCount
      ? t("browser.annotationModeWithCount", { count: annotationCount })
      : t("browser.annotationMode");
  const visibleAnnotationStatus =
    annotationStatus && error === annotationStatus ? annotationStatus : null;
  const showBrowserAnnotationToolbar =
    annotationToolsEnabled &&
    !canUseNativeBrowser &&
    !canUseInjectedAnnotationToolbar &&
    url !== BROWSER_HOME_URL;

  return (
    <div
      className="bg-canvas flex h-full min-h-0 flex-col"
      data-browser-id={browserId}
      data-browser-automation={
        automationReady
          ? "ready"
          : !canUseBrowserAutomation
            ? "unavailable"
            : url === BROWSER_HOME_URL
              ? "idle"
              : "registering"
      }
    >
      <div className="border-border-subtle flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <ToolbarButton label={t("browser.back")} disabled={!canGoBack} onClick={goBack}>
          <ArrowLeft size={14} />
        </ToolbarButton>
        <ToolbarButton label={t("browser.forward")} disabled={!canGoForward} onClick={goForward}>
          <ArrowRight size={14} />
        </ToolbarButton>
        <ToolbarButton label={loading ? t("browser.stop") : t("browser.reload")} onClick={reload}>
          {loading ? <X size={14} /> : <RefreshCw size={14} />}
        </ToolbarButton>
        <ToolbarButton
          label={annotationToolsLabel}
          active={annotationToolsEnabled}
          disabled={!annotationAvailable}
          onClick={toggleAnnotationTools}
        >
          <span className="relative flex h-4 w-4 items-center justify-center">
            <MessageSquare size={14} />
            {browserContextCount ? (
              <span className="bg-accent text-accent-fg absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] leading-none">
                {browserContextCount > 9 ? "9+" : browserContextCount}
              </span>
            ) : null}
          </span>
        </ToolbarButton>
        <form onSubmit={submit} className="min-w-0 flex-1">
          <div className="bg-surface flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2">
            {loading ? (
              <Loader2 size={13} className="text-subtle shrink-0 animate-spin" />
            ) : (
              <BrowserFaviconIcon iconUrl={faviconUrl} />
            )}
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              aria-label={t("browser.address")}
              placeholder={t("browser.address")}
              className="text-fg placeholder:text-subtle min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              spellCheck={false}
            />
          </div>
        </form>
        <ToolbarButton
          label={t("browser.openExternally")}
          disabled={!isExternalOpenable(url)}
          onClick={openExternal}
        >
          <ExternalLink size={14} />
        </ToolbarButton>
      </div>
      {visibleAnnotationStatus ? (
        <div
          className={`shrink-0 border-b px-2 py-1 text-[11px] leading-4 break-words ${annotationStatusClassName(
            visibleAnnotationStatus,
            t("browser.annotationReady"),
            error,
          )}`}
          title={visibleAnnotationStatus}
        >
          {visibleAnnotationStatus}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {url === BROWSER_HOME_URL ? (
          <BrowserHome />
        ) : canUseNativeBrowser ? (
          <div ref={mountRef} className="h-full w-full bg-white" data-browser-native-view />
        ) : hasRemoteBrowserSurface ? (
          <RemoteBrowserSurface
            annotations={canUseInjectedAnnotationToolbar ? [] : remoteAnnotations}
            annotationEditor={canUseInjectedAnnotationToolbar ? null : remoteAnnotationEditor}
            annotationMode={!canUseInjectedAnnotationToolbar && annotationMode}
            annotationPrompt={t("browser.annotationPrompt")}
            cancelLabel={t("common.cancel")}
            frame={remoteFrame}
            onKeyDown={handleRemoteKeyDown}
            onKeyUp={handleRemoteKeyUp}
            onPaste={handleRemotePaste}
            onPointerDown={handleRemotePointerDown}
            onPointerMove={handleRemotePointerMove}
            onPointerUp={handleRemotePointerUp}
            onRemoveAnnotation={removeRemoteAnnotation}
            onSaveAnnotation={saveRemoteAnnotation}
            onCancelAnnotation={closeRemoteAnnotationEditor}
            onWheel={handleRemoteWheel}
            removeAnnotationLabel={(index) =>
              t("browser.removeAnnotationLabel", { index: index + 1 })
            }
            removeAnnotationTitle={t("browser.removeAnnotation")}
            saveLabel={t("common.save")}
            savingAnnotation={remoteAnnotationSaving}
            selection={canUseInjectedAnnotationToolbar ? null : remoteSelection}
            surfaceRef={remoteSurfaceRef}
            title={title}
          />
        ) : (
          <iframe
            src={url}
            title={title}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        )}
        {error ? (
          <div className="border-danger/30 bg-danger/10 text-danger absolute inset-x-3 top-3 rounded-md border px-3 py-2 text-[12px]">
            {error}
          </div>
        ) : null}
        {showBrowserAnnotationToolbar ? (
          <BrowserAnnotationToolbar
            active={annotationMode}
            annotationCount={annotationCount}
            canMutateContext={browserContextCount > 0}
            clearLabel={t("browser.clearBrowserContext")}
            collapsedLabel={t("browser.annotationToolbarExpand")}
            collapseLabel={t("browser.annotationToolbarCollapse")}
            disabled={!annotationAvailable}
            expanded={annotationToolbarExpanded}
            onAnnotate={startOneShotAnnotation}
            onClear={clearBrowserContext}
            onExpandedChange={setAnnotationToolbarExpanded}
            onSnapshot={captureBrowserSnapshot}
            onUndo={undoBrowserContext}
            snapshotLabel={t("browser.snapshotPage")}
            toolLabel={annotationActionLabel}
            undoLabel={t("browser.undoBrowserContext")}
          />
        ) : null}
      </div>
    </div>
  );
}

function BrowserAnnotationToolbar({
  active,
  annotationCount,
  canMutateContext,
  clearLabel,
  collapsedLabel,
  collapseLabel,
  disabled,
  expanded,
  onAnnotate,
  onClear,
  onExpandedChange,
  onSnapshot,
  onUndo,
  snapshotLabel,
  toolLabel,
  undoLabel,
}: {
  active: boolean;
  annotationCount: number;
  canMutateContext: boolean;
  clearLabel: string;
  collapsedLabel: string;
  collapseLabel: string;
  disabled: boolean;
  expanded: boolean;
  onAnnotate: () => void;
  onClear: () => void;
  onExpandedChange: (expanded: boolean) => void;
  onSnapshot: () => void;
  onUndo: () => void;
  snapshotLabel: string;
  toolLabel: string;
  undoLabel: string;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
      {!expanded ? (
        <button
          type="button"
          aria-label={collapsedLabel}
          onClick={() => onExpandedChange(true)}
          className="pointer-events-auto flex h-10 min-w-10 items-center justify-center rounded-full border border-white/10 bg-[#15171d] px-3 text-white shadow-[0_14px_34px_rgba(0,0,0,.28)] transition hover:border-white/16 hover:bg-[#191b22] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
        >
          <ChevronUp size={16} />
        </button>
      ) : (
        <div className="pointer-events-auto flex h-10 items-center gap-1 rounded-full border border-white/10 bg-[#15171d] px-1.5 text-white shadow-[0_14px_34px_rgba(0,0,0,.28)]">
          <button
            type="button"
            aria-label={collapseLabel}
            onClick={() => onExpandedChange(false)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/[.07] hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          >
            <ChevronDown size={15} />
          </button>
          <div className="h-5 w-px bg-white/12" />
          <button
            type="button"
            aria-label={snapshotLabel}
            disabled={disabled}
            onClick={onSnapshot}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/82 transition hover:bg-white/[.07] hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Camera size={15} />
          </button>
          <button
            type="button"
            aria-label={toolLabel}
            aria-pressed={active}
            disabled={disabled}
            onClick={onAnnotate}
            className={`relative flex h-8 w-8 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 ${
              active
                ? "bg-[#4f7cff] text-white"
                : "text-white/82 hover:bg-white/[.07] hover:text-white"
            }`}
          >
            <Pencil size={15} />
            {annotationCount ? (
              <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#4f7cff] px-0.5 text-[9px] leading-none text-white shadow-sm">
                {annotationCount > 9 ? "9+" : annotationCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            aria-label={undoLabel}
            disabled={disabled || !canMutateContext}
            onClick={onUndo}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/[.07] hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            aria-label={clearLabel}
            disabled={disabled || !canMutateContext}
            onClick={onClear}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/[.07] hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function RemoteBrowserSurface({
  annotations,
  annotationEditor,
  annotationMode,
  annotationPrompt,
  cancelLabel,
  frame,
  onCancelAnnotation,
  onKeyDown,
  onKeyUp,
  onPaste,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemoveAnnotation,
  onSaveAnnotation,
  onWheel,
  removeAnnotationLabel,
  removeAnnotationTitle,
  saveLabel,
  savingAnnotation,
  selection,
  surfaceRef,
  title,
}: {
  annotations: BrowserAnnotation[];
  annotationEditor: RemoteBrowserAnnotationEditorState | null;
  annotationMode: boolean;
  annotationPrompt: string;
  cancelLabel: string;
  frame: RemoteBrowserFrame | null;
  onCancelAnnotation: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRemoveAnnotation: (annotationId: string) => void;
  onSaveAnnotation: (note: string) => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  removeAnnotationLabel: (index: number) => string;
  removeAnnotationTitle: string;
  saveLabel: string;
  savingAnnotation: boolean;
  selection: RemoteBrowserSelection | null;
  surfaceRef: RefObject<HTMLDivElement | null>;
  title: string;
}) {
  return (
    <div
      ref={surfaceRef}
      role="application"
      tabIndex={0}
      className={`relative h-full w-full overflow-hidden bg-white outline-none ${
        annotationMode ? "cursor-crosshair" : "cursor-default"
      }`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      {frame ? (
        <img
          src={frame.dataUrl}
          alt={title}
          draggable={false}
          className="h-full w-full object-fill select-none"
        />
      ) : (
        <div className="text-muted flex h-full w-full items-center justify-center gap-2 text-[12px]">
          <Loader2 size={14} className="animate-spin" />
        </div>
      )}
      {annotations.map((annotation, index) => {
        const style = remoteBrowserAnnotationStyle(annotation);
        if (!style) return null;
        return (
          <div
            key={annotation.id || index}
            className="pointer-events-none absolute border-2 border-[#2f6fed] bg-[#2f6fed]/10"
            style={style}
          >
            <span className="absolute -top-5 left-0 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#2f6fed] px-1 text-[11px] leading-none font-semibold text-white">
              {index + 1}
            </span>
            <button
              type="button"
              className="pointer-events-auto absolute -top-2.5 -right-2.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/90 bg-[#ef4444] p-0 text-[14px] leading-none font-bold text-white shadow-[0_5px_16px_rgba(15,23,42,.25)] outline-none hover:bg-[#dc2626] focus-visible:ring-2 focus-visible:ring-white"
              title={removeAnnotationTitle}
              aria-label={removeAnnotationLabel(index)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemoveAnnotation(annotation.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      {selection ? (
        <div
          className="pointer-events-none absolute border-2 border-[#2f6fed] bg-[#2f6fed]/10"
          style={remoteBrowserSelectionStyle(selection, frame)}
        />
      ) : null}
      {annotationEditor ? (
        <RemoteBrowserAnnotationEditor
          editor={annotationEditor}
          frame={frame}
          placeholder={annotationPrompt}
          cancelLabel={cancelLabel}
          saveLabel={saveLabel}
          saving={savingAnnotation}
          onCancel={onCancelAnnotation}
          onSave={onSaveAnnotation}
        />
      ) : null}
    </div>
  );
}

function RemoteBrowserAnnotationEditor({
  cancelLabel,
  editor,
  frame,
  onCancel,
  onSave,
  placeholder,
  saveLabel,
  saving,
}: {
  cancelLabel: string;
  editor: RemoteBrowserAnnotationEditorState;
  frame: RemoteBrowserFrame | null;
  onCancel: () => void;
  onSave: (note: string) => void;
  placeholder: string;
  saveLabel: string;
  saving: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    setNote("");
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [editor.id]);

  const save = () => {
    if (!note.trim()) {
      textareaRef.current?.focus();
      return;
    }
    onSave(note);
  };

  return (
    <div
      className="absolute z-20 w-[260px] rounded-lg border border-[rgba(15,23,42,.18)] bg-white p-2.5 text-[12px] leading-[1.4] text-[#0f172a] shadow-[0_16px_38px_rgba(15,23,42,.22)]"
      style={remoteBrowserAnnotationEditorStyle(editor.anchor, frame)}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <textarea
        ref={textareaRef}
        value={note}
        placeholder={placeholder}
        disabled={saving}
        onChange={(event) => setNote(event.target.value)}
        className="block h-[84px] w-full resize-y rounded-md border border-[rgba(15,23,42,.20)] bg-white p-2 text-[12px] leading-[1.4] text-[#0f172a] outline-none focus:border-[#2563eb] focus:shadow-[0_0_0_2px_rgba(37,99,235,.18)] disabled:opacity-70"
        style={{
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="cursor-pointer rounded-md border border-[rgba(15,23,42,.16)] bg-[#f8fafc] px-[9px] py-[7px] text-[12px] leading-none font-medium text-[#0f172a] disabled:cursor-default disabled:opacity-60"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="cursor-pointer rounded-md border border-[#2563eb] bg-[#2563eb] px-[9px] py-[7px] text-[12px] leading-none font-medium text-white disabled:cursor-default disabled:opacity-70"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

function remoteBrowserScreencastInputFromBounds(
  bounds: Pick<RemoteBrowserBounds, "height" | "width">,
): {
  everyNthFrame: number;
  format: "jpeg";
  maxHeight: number;
  maxWidth: number;
  quality: number;
} {
  const width = bounds.width || 1280;
  const height = bounds.height || 900;
  const density = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  return {
    everyNthFrame: 1,
    format: "jpeg",
    maxHeight: Math.max(1, Math.min(REMOTE_BROWSER_FRAME_MAX_HEIGHT, Math.round(height * density))),
    maxWidth: Math.max(1, Math.min(REMOTE_BROWSER_FRAME_MAX_WIDTH, Math.round(width * density))),
    quality: REMOTE_BROWSER_FRAME_QUALITY,
  };
}

function remoteBrowserScreencastSizeKey(
  bounds: Pick<RemoteBrowserBounds, "height" | "width">,
): string {
  const input = remoteBrowserScreencastInputFromBounds(bounds);
  return `${input.maxWidth}x${input.maxHeight}:${input.quality}`;
}

async function waitForRemoteBrowserSurfaceBounds(
  surfaceRef: RefObject<HTMLElement | null>,
): Promise<RemoteBrowserBounds> {
  for (let index = 0; index < REMOTE_BROWSER_SURFACE_WAIT_FRAMES; index += 1) {
    const bounds = browserViewBounds(surfaceRef.current);
    if (remoteBrowserBoundsUsable(bounds)) return bounds;
    await nextAnimationFrame();
  }
  const bounds = browserViewBounds(surfaceRef.current);
  if (remoteBrowserBoundsUsable(bounds)) return bounds;
  return {
    ...bounds,
    height: bounds.height > 0 ? bounds.height : 900,
    width: bounds.width > 0 ? bounds.width : 1280,
  };
}

function remoteBrowserBoundsUsable(bounds: RemoteBrowserBounds): boolean {
  return bounds.visible && bounds.width > 1 && bounds.height > 1;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function remoteBrowserPointFromEvent(
  event: { clientX: number; clientY: number },
  surface: HTMLElement | null,
  frame: RemoteBrowserFrame,
): RemoteBrowserPoint | null {
  if (!surface) return null;
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const viewport = remoteBrowserFrameViewport(frame, rect);
  const x = ((event.clientX - rect.left) / rect.width) * viewport.width;
  const y = ((event.clientY - rect.top) / rect.height) * viewport.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(viewport.width, x)),
    y: Math.max(0, Math.min(viewport.height, y)),
  };
}

function remoteBrowserFrameViewport(
  frame: RemoteBrowserFrame | null,
  fallback?: { width: number; height: number },
): { width: number; height: number } {
  const metadata = browserRecordValue(frame?.metadata);
  const width = browserNumberField(metadata, "deviceWidth");
  const height = browserNumberField(metadata, "deviceHeight");
  return {
    width: Number.isFinite(width) && width > 0 ? width : Math.max(1, fallback?.width ?? 1280),
    height: Number.isFinite(height) && height > 0 ? height : Math.max(1, fallback?.height ?? 900),
  };
}

function remoteBrowserRectFromPoints(
  start: RemoteBrowserPoint,
  current: RemoteBrowserPoint,
): BrowserRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

function remoteBrowserIsRegionSelection(rect: BrowserRect): boolean {
  return (
    rect.width >= REMOTE_BROWSER_ANNOTATION_DRAG_THRESHOLD &&
    rect.height >= REMOTE_BROWSER_ANNOTATION_DRAG_THRESHOLD
  );
}

function remoteBrowserSelectionFromPageRect(
  rect: BrowserRect,
  viewport: BrowserViewport,
): RemoteBrowserSelection {
  const start = {
    x: Math.max(0, rect.x - viewport.scrollX),
    y: Math.max(0, rect.y - viewport.scrollY),
  };
  return {
    current: {
      x: start.x + Math.max(1, rect.width),
      y: start.y + Math.max(1, rect.height),
    },
    start,
  };
}

function remoteBrowserSelectionStyle(
  selection: RemoteBrowserSelection,
  frame: RemoteBrowserFrame | null,
): CSSProperties | undefined {
  const viewport = remoteBrowserFrameViewport(frame);
  const rect = remoteBrowserRectFromPoints(selection.start, selection.current);
  return remoteBrowserViewportRectStyle(rect, {
    height: viewport.height,
    scrollX: 0,
    scrollY: 0,
    width: viewport.width,
  });
}

function remoteBrowserAnnotationStyle(annotation: BrowserAnnotation): CSSProperties | undefined {
  return remoteBrowserViewportRectStyle(annotation.rect, annotation.viewport);
}

function remoteBrowserAnnotationEditorStyle(
  point: RemoteBrowserPoint,
  frame: RemoteBrowserFrame | null,
): CSSProperties {
  const viewport = remoteBrowserFrameViewport(frame);
  const left = viewport.width > 0 ? (point.x / viewport.width) * 100 : 0;
  const top = viewport.height > 0 ? (point.y / viewport.height) * 100 : 0;
  return {
    left: `clamp(8px, calc(${left}% + 10px), calc(100% - 276px))`,
    top: `clamp(8px, calc(${top}% + 10px), calc(100% - 150px))`,
  };
}

function remoteBrowserViewportRectStyle(
  rect: BrowserRect,
  viewport: Pick<BrowserViewport, "height" | "scrollX" | "scrollY" | "width">,
): CSSProperties | undefined {
  if (viewport.width <= 0 || viewport.height <= 0) return undefined;
  const left = ((rect.x - viewport.scrollX) / viewport.width) * 100;
  const top = ((rect.y - viewport.scrollY) / viewport.height) * 100;
  const width = (Math.max(1, rect.width) / viewport.width) * 100;
  const height = (Math.max(1, rect.height) / viewport.height) * 100;
  if (![left, top, width, height].every(Number.isFinite)) return undefined;
  return {
    height: `${height}%`,
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
  };
}

type RemoteBrowserKeyDispatchInput = {
  autoRepeat?: boolean;
  code?: string;
  key?: string;
  modifiers?: number;
  nativeVirtualKeyCode?: number;
  text?: string;
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
};

type RemoteBrowserKeyInput = RemoteBrowserKeyDispatchInput | { insertText: string };

function remoteBrowserKeyDownInput(
  event: ReactKeyboardEvent<HTMLDivElement>,
): RemoteBrowserKeyInput | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    const special = remoteBrowserSpecialKey(event);
    return special ? remoteBrowserDispatchKeyInput(event, "keyDown", special) : null;
  }
  if (event.key.length === 1) return { insertText: event.key };
  const special = remoteBrowserSpecialKey(event);
  return special ? remoteBrowserDispatchKeyInput(event, "keyDown", special) : null;
}

function remoteBrowserKeyUpInput(
  event: ReactKeyboardEvent<HTMLDivElement>,
): RemoteBrowserKeyDispatchInput | null {
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const special = remoteBrowserSpecialKey(event);
  return special ? remoteBrowserDispatchKeyInput(event, "keyUp", special) : null;
}

function remoteBrowserDispatchKeyInput(
  event: ReactKeyboardEvent<HTMLDivElement>,
  type: "keyDown" | "keyUp",
  special: { key: string; code?: string; keyCode: number; text?: string },
): RemoteBrowserKeyDispatchInput {
  return {
    autoRepeat: event.repeat,
    code: event.code || special.code,
    key: special.key,
    modifiers: remoteBrowserEventModifiers(event),
    nativeVirtualKeyCode: special.keyCode,
    text: type === "keyDown" ? special.text : undefined,
    type,
    unmodifiedText: type === "keyDown" ? special.text : undefined,
    windowsVirtualKeyCode: special.keyCode,
  };
}

function remoteBrowserSpecialKey(
  event: ReactKeyboardEvent<HTMLDivElement>,
): { key: string; code?: string; keyCode: number; text?: string } | undefined {
  switch (event.key) {
    case "Backspace":
      return { key: "Backspace", code: "Backspace", keyCode: 8 };
    case "Tab":
      return { key: "Tab", code: "Tab", keyCode: 9, text: "\t" };
    case "Enter":
      return { key: "Enter", code: event.code || "Enter", keyCode: 13, text: "\r" };
    case "Escape":
      return { key: "Escape", code: "Escape", keyCode: 27 };
    case "ArrowLeft":
      return { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 };
    case "ArrowUp":
      return { key: "ArrowUp", code: "ArrowUp", keyCode: 38 };
    case "ArrowRight":
      return { key: "ArrowRight", code: "ArrowRight", keyCode: 39 };
    case "ArrowDown":
      return { key: "ArrowDown", code: "ArrowDown", keyCode: 40 };
    case "Delete":
      return { key: "Delete", code: "Delete", keyCode: 46 };
    case "Home":
      return { key: "Home", code: "Home", keyCode: 36 };
    case "End":
      return { key: "End", code: "End", keyCode: 35 };
    case "PageUp":
      return { key: "PageUp", code: "PageUp", keyCode: 33 };
    case "PageDown":
      return { key: "PageDown", code: "PageDown", keyCode: 34 };
    default:
      return undefined;
  }
}

function remoteBrowserEventModifiers(event: ReactKeyboardEvent<HTMLDivElement>): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function sameBrowserUrl(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function browserRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function browserNumberField(value: unknown, key: string): number {
  const field = browserRecordValue(value)[key];
  return typeof field === "number" ? field : Number.NaN;
}

export function isTerminalRunEvent(value: unknown): value is TerminalRunEvent {
  return typeof value === "object" && value !== null && "id" in value && "type" in value;
}
