import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bug,
  Check,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  GitPullRequest,
  SearchCode,
  Sparkles,
} from "lucide-react";
import { useBlockRenderers, useShellStore } from "@the-next-ai/app";
import type { BlockRenderer } from "@the-next-ai/app";
import { ExtensionSurfaceErrorBoundary } from "@/extensions/ExtensionSurfaceErrorBoundary";
import { useUIStore } from "@/ui/ui-store";
import { useI18nStore, useT } from "@/lib/i18n";
import { ThinkingShimmer } from "@/ui/thinking-shimmer";
import { cn } from "@/ui/cn";
import { toast } from "@/ui/toast";
import { Tip } from "@/ui/tooltip";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCoarsePointer } from "@/ui/use-coarse-pointer";
import { AgentLogo } from "@/asp/AgentLogo";
import { useAspStore } from "@/asp/asp-store";
import type { AspProvider } from "@/asp/desktop-api";
import {
  isEmptyAssistantBlock,
  isEmptyReasoningBlock,
  isEmptyReasoningToolBlock,
  isInternalProtocolRawBlock,
  useChatStore,
} from "./chat-store";
import { FindBar } from "./FindBar";
import {
  AssistantMessage,
  ArtifactBlock,
  DiffBlock,
  ErrorBlock,
  ImageGallery,
  PlanTodoList,
  RawBlock,
  ReasoningBlock,
  ResourceBlock,
  TerminalBlock,
  ToolCallBlock,
  UserMessage,
} from "./blocks";
import type { ChatBlock, Session } from "./types";
import { UIRegion } from "@/product/UIRegion";

// Stable empty array so the selector returns the same reference when there is
// no active session (otherwise useSyncExternalStore loops on a fresh [] each call).
const EMPTY_BLOCKS: ChatBlock[] = [];
const PROCESS_COLLAPSE_UNMOUNT_MS = 220;
const INITIAL_RENDER_BLOCK_BUDGET = 120;
const RENDER_BLOCK_BUDGET_STEP = 120;
const CHAT_STREAM_CACHE_LIMIT = 2;
const LARGE_EXTENSION_CONTEXT_CHAR_LIMIT = 8_000;
const SELECTION_MENU_GAP = 8;
const SELECTION_MENU_VIEWPORT_PADDING = 8;

type ViewportRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type TextSelectionMenuState = {
  anchorRect: ViewportRect;
  id: number;
  text: string;
};

type TextSelectionMenuAction = "add" | "details" | "side-chat";

function renderBudgetCacheKey(sessionId: string, sourceLength: number): string {
  return `${sessionId}:${sourceLength}`;
}

function chatBlockElementId(sessionId: string, blockId: string): string {
  return `block-${sessionId || "draft"}-${blockId}`;
}

function findChatBlockElement(root: HTMLElement, blockId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-chat-block-id="${cssEscape(blockId)}"]`);
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

type AgentSegmentToolbarInfo = {
  at?: number;
  branchBlockId: string;
  branchDisabled: boolean;
  copyBlockIds: string[];
  providerId?: string;
};

type StreamItem =
  | { type: "block"; block: ChatBlock }
  | {
      type: "process";
      id: string;
      blocks: ChatBlock[];
      providerId?: string;
      startedAt?: number;
      endedAt?: number;
    };

type ChatStreamProps = {
  active?: boolean;
  sessionId?: string | null;
};

function isInternalUserMessageTool(block: ChatBlock): boolean {
  return (
    block.kind === "tool" &&
    (block.toolKind === "userMessage" || block.title.trim().toLowerCase() === "user message")
  );
}

function isVisibleChatBlock(block: ChatBlock): boolean {
  return (
    !isInternalUserMessageTool(block) &&
    !isInternalProtocolRawBlock(block) &&
    !isEmptyAssistantBlock(block) &&
    !isEmptyReasoningBlock(block) &&
    !isEmptyReasoningToolBlock(block)
  );
}

function dedupeRepeatedAssistantBlocks(blocks: ChatBlock[]): ChatBlock[] {
  const output: ChatBlock[] = [];
  let turnBlocks: ChatBlock[] = [];

  const flushTurn = () => {
    if (!turnBlocks.length) return;
    output.push(...dedupeRepeatedAssistantBlocksInTurn(turnBlocks));
    turnBlocks = [];
  };

  for (const block of blocks) {
    if (block.kind === "user") {
      flushTurn();
      output.push(block);
      continue;
    }
    turnBlocks.push(block);
  }
  flushTurn();

  return output;
}

function dedupeRepeatedAssistantBlocksInTurn(blocks: ChatBlock[]): ChatBlock[] {
  const lastAssistantIndexByText = new Map<string, number>();
  blocks.forEach((block, index) => {
    const key = assistantDedupeKey(block);
    if (key) lastAssistantIndexByText.set(key, index);
  });
  return blocks.filter((block, index) => {
    const key = assistantDedupeKey(block);
    return !key || lastAssistantIndexByText.get(key) === index;
  });
}

function assistantDedupeKey(block: ChatBlock): string {
  if (block.kind !== "assistant" || block.streaming) return "";
  return block.text.trim().replace(/\s+/g, " ");
}

/** Flatten a block to searchable text for in-conversation find. */
function blockText(block: ChatBlock): string {
  switch (block.kind) {
    case "user":
      return block.text;
    case "assistant":
      return block.text;
    case "reasoning":
      return block.text;
    case "tool":
      return `${block.title}\n${block.output}`;
    case "terminal":
      return `${block.command}\n${block.output}`;
    case "diff":
      return `${block.path}\n${block.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n")}`;
    case "plan":
      return block.todos.map((todo) => todo.content).join("\n");
    case "image":
      return block.prompt ?? "";
    case "resource":
    case "artifact":
      return [
        block.title,
        block.name,
        block.path,
        block.uri,
        block.mimeType,
        block.content,
        block.app?.title,
        block.app?.src,
        formatSearchValue(block.app?.metadata),
        formatSearchValue(block.metadata),
      ]
        .filter(Boolean)
        .join("\n");
    case "raw":
      return [block.label, formatSearchValue(block.value), formatSearchValue(block.metadata)]
        .filter(Boolean)
        .join("\n");
    case "error":
      return block.message;
  }
}

/**
 * The threaded conversation. Reads the active session's blocks itself and
 * renders them. Built-in block kinds are handled inline; a custom kind (or an
 * override) is dispatched to a BlockRenderer registered by an extension.
 *
 * Also hosts the in-conversation find bar (⌘F) and the user-message nav rail.
 */
export function CachedChatStream() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessionsSignature = useChatStore((s) => s.sessions.map((session) => session.id).join("\0"));
  const draftSessionId = useChatStore((s) => s.draftSession?.id ?? "");
  const [cachedSessionIds, setCachedSessionIds] = useState<string[]>(() =>
    activeSessionId ? [activeSessionId] : [],
  );

  useEffect(() => {
    setCachedSessionIds((current) => {
      const existingSessionIds = new Set(
        useChatStore.getState().sessions.map((session) => session.id),
      );
      const retained = current.filter((sessionId) => existingSessionIds.has(sessionId));
      if (!activeSessionId) return retained;

      const next = retained.filter((sessionId) => sessionId !== activeSessionId);
      next.push(activeSessionId);
      return next.slice(-CHAT_STREAM_CACHE_LIMIT);
    });
  }, [activeSessionId, sessionsSignature]);

  const renderedSessionIds =
    activeSessionId && !cachedSessionIds.includes(activeSessionId)
      ? [...cachedSessionIds, activeSessionId].slice(-CHAT_STREAM_CACHE_LIMIT)
      : cachedSessionIds;
  const draftKey = `draft:${draftSessionId || "empty"}`;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {renderedSessionIds.map((sessionId) => {
        const isActive = sessionId === activeSessionId;
        return (
          <div
            key={sessionId}
            aria-hidden={!isActive}
            inert={!isActive}
            className={cn(
              "absolute inset-0 h-full min-h-0 transition-opacity duration-100",
              isActive ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            <ChatStream active={isActive} sessionId={sessionId} />
          </div>
        );
      })}
      {!activeSessionId ? (
        <div key={draftKey} className="absolute inset-0 h-full min-h-0">
          <ChatStream active />
        </div>
      ) : null}
    </div>
  );
}

export function ChatStream({ active = true, sessionId }: ChatStreamProps = {}) {
  const activeSession = useChatStore((s) =>
    s.sessions.find((x) => x.id === (sessionId ?? s.activeSessionId)),
  );
  const transcriptLoading = Boolean(activeSession?.transcriptLoading);
  const activeSessionId = activeSession?.id ?? "";
  const hydrateSessionTranscript = useChatStore((s) => s.hydrateSessionTranscript);
  const sessionBlocks = activeSession?.blocks ?? EMPTY_BLOCKS;
  const showTranscriptSkeleton = transcriptLoading && sessionBlocks.length === 0;
  const extensionContextBlock = useMemo(
    () => extensionSessionContextBlock(activeSession, sessionBlocks),
    [activeSession, sessionBlocks],
  );
  const sessionThreadBlocks = useMemo(
    () =>
      extensionContextBlock
        ? sessionBlocks.filter((block) => block.id !== extensionContextBlock.id)
        : sessionBlocks,
    [extensionContextBlock, sessionBlocks],
  );
  const rawBlocks = showTranscriptSkeleton ? EMPTY_BLOCKS : sessionThreadBlocks;
  const [renderBudget, setRenderBudget] = useState({
    budget: INITIAL_RENDER_BLOCK_BUDGET,
    sessionId: "",
    sourceLength: 0,
  });
  const renderBudgetCacheRef = useRef(new Map<string, number>());
  const currentBudgetCacheKey = renderBudgetCacheKey(activeSessionId, rawBlocks.length);
  const cachedRenderBudget = renderBudgetCacheRef.current.get(currentBudgetCacheKey);
  const budgetIsCurrent =
    renderBudget.sessionId === activeSessionId && renderBudget.sourceLength === rawBlocks.length;
  const blockBudget =
    rawBlocks.length <= INITIAL_RENDER_BLOCK_BUDGET
      ? rawBlocks.length
      : budgetIsCurrent
        ? Math.min(renderBudget.budget, rawBlocks.length)
        : Math.min(cachedRenderBudget ?? INITIAL_RENDER_BLOCK_BUDGET, rawBlocks.length);
  const blocks = useMemo(
    () =>
      rawBlocks.length > blockBudget ? rawBlocks.slice(rawBlocks.length - blockBudget) : rawBlocks,
    [blockBudget, rawBlocks],
  );
  const streaming = activeSession?.status === "streaming";
  const renderers = useBlockRenderers();
  const visibleBlocks = useMemo(() => blocks.filter(isVisibleChatBlock), [blocks]);
  const displayBlocks = useMemo(
    () => dedupeRepeatedAssistantBlocks(visibleBlocks),
    [visibleBlocks],
  );
  const allVisibleBlocks = useMemo(() => rawBlocks.filter(isVisibleChatBlock), [rawBlocks]);
  const agentToolbarByBlockId = useMemo(
    () => buildAgentToolbarByBlockId(displayBlocks),
    [displayBlocks],
  );
  const latestAssistantBlockId = useMemo(
    () => latestAssistantBlockIdInActiveAgentSegment(displayBlocks),
    [displayBlocks],
  );
  const emptyLanding =
    !showTranscriptSkeleton && displayBlocks.length === 0 && !extensionContextBlock;
  const hasActiveStream = displayBlocks.some((b) => "streaming" in b && b.streaming);
  const streamItems = useMemo(
    () => buildStreamItems(displayBlocks, streaming),
    [displayBlocks, streaming],
  );

  const findOpen = useUIStore((s) => active && s.findOpen);
  const findQuery = useUIStore((s) => (active ? s.findQuery : ""));
  const setFindOpen = useUIStore((s) => s.setFindOpen);
  const t = useT();

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const forceBottomScrollRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const sessionScrollFrameRef = useRef<number | null>(null);
  const scrollMeasureFrameRef = useRef<number | null>(null);
  const textSelectionMenuIdRef = useRef(0);
  const textSelectionPointerActiveRef = useRef(false);
  const [textSelectionMenu, setTextSelectionMenu] = useState<TextSelectionMenuState | null>(null);
  const [expandedProcessIds, setExpandedProcessIds] = useState<Set<string>>(() => new Set());

  const updateTextSelectionMenu = useCallback(() => {
    const next = textSelectionMenuState(scrollRef.current, ++textSelectionMenuIdRef.current);
    setTextSelectionMenu(next);
  }, []);

  const scheduleTextSelectionMenuUpdate = useCallback(() => {
    window.setTimeout(updateTextSelectionMenu, 0);
  }, [updateTextSelectionMenu]);

  const insertSelectedText = useCallback(
    (action: TextSelectionMenuAction) => {
      const selectedText = textSelectionMenu?.text.trim();
      if (!selectedText) return;
      const prompt =
        action === "details"
          ? selectionPrompt(t("selectionMenu.moreDetailsPrompt"), selectedText)
          : action === "side-chat"
            ? selectionPrompt(t("selectionMenu.sideChatPrompt"), selectedText)
            : selectionPrompt(t("selectionMenu.selectedTextLabel"), selectedText);
      useUIStore.getState().requestComposerInsert({ mode: "append", text: prompt });
      if (action === "side-chat") useShellStore.getState().setDetailPanelOpen(true);
      window.getSelection()?.removeAllRanges();
      setTextSelectionMenu(null);
    },
    [textSelectionMenu?.text, t],
  );

  useEffect(() => {
    if (!active || !activeSessionId) return;
    void hydrateSessionTranscript(activeSessionId);
  }, [active, activeSessionId, hydrateSessionTranscript]);

  useEffect(() => {
    if (!active) return undefined;
    const onSelectionChange = () => {
      if (textSelectionPointerActiveRef.current) return;
      scheduleTextSelectionMenuUpdate();
    };
    const onPointerEnd = () => {
      if (!textSelectionPointerActiveRef.current) return;
      textSelectionPointerActiveRef.current = false;
      scheduleTextSelectionMenuUpdate();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTextSelectionMenu(null);
    };
    const hide = () => setTextSelectionMenu(null);

    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", hide);
    };
  }, [active, scheduleTextSelectionMenuUpdate]);

  useEffect(() => {
    if (showTranscriptSkeleton) return undefined;
    const sourceLength = rawBlocks.length;
    const cacheKey = renderBudgetCacheKey(activeSessionId, sourceLength);
    const initialBudget = Math.min(
      sourceLength,
      Math.max(renderBudgetCacheRef.current.get(cacheKey) ?? 0, INITIAL_RENDER_BLOCK_BUDGET),
    );
    setRenderBudget((current) => {
      if (
        current.sessionId === activeSessionId &&
        current.sourceLength === sourceLength &&
        current.budget === initialBudget
      ) {
        return current;
      }
      return { budget: initialBudget, sessionId: activeSessionId, sourceLength };
    });
    if (sourceLength <= INITIAL_RENDER_BLOCK_BUDGET) return undefined;

    let canceled = false;
    let currentBudget = initialBudget;
    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;

    const cancelScheduled = () => {
      if (idleHandle !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) globalThis.clearTimeout(timeoutHandle);
      idleHandle = null;
      timeoutHandle = null;
    };

    const scheduleNext = () => {
      const run = () => {
        idleHandle = null;
        timeoutHandle = null;
        if (canceled) return;
        currentBudget = Math.min(sourceLength, currentBudget + RENDER_BLOCK_BUDGET_STEP);
        renderBudgetCacheRef.current.set(cacheKey, currentBudget);
        setRenderBudget((current) => {
          if (current.sessionId !== activeSessionId || current.sourceLength !== sourceLength) {
            return current;
          }
          return { ...current, budget: Math.max(current.budget, currentBudget) };
        });
        if (currentBudget < sourceLength) scheduleNext();
      };

      if ("requestIdleCallback" in window) {
        idleHandle = window.requestIdleCallback(run, { timeout: 250 });
      } else {
        timeoutHandle = globalThis.setTimeout(run, 32);
      }
    };

    scheduleNext();
    return () => {
      canceled = true;
      cancelScheduled();
    };
  }, [activeSessionId, rawBlocks.length, showTranscriptSkeleton]);

  /* ----- find matches ----- */
  const q = findQuery.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [] as string[];
    return displayBlocks.filter((b) => blockText(b).toLowerCase().includes(q)).map((b) => b.id);
  }, [displayBlocks, q]);
  const [matchIndex, setMatchIndex] = useState(0);
  useEffect(() => setMatchIndex(0), [q]);
  const currentMatchId = matches[matchIndex] ?? null;

  const ensureBlockRendered = useCallback(
    (id: string) => {
      const index = rawBlocks.findIndex((block) => block.id === id);
      if (index === -1) return;
      const requiredBudget = rawBlocks.length - index;
      if (requiredBudget <= blockBudget) return;
      renderBudgetCacheRef.current.set(
        renderBudgetCacheKey(activeSessionId, rawBlocks.length),
        requiredBudget,
      );
      setRenderBudget((current) => {
        const currentBudget =
          current.sessionId === activeSessionId && current.sourceLength === rawBlocks.length
            ? current.budget
            : blockBudget;
        return {
          budget: Math.min(rawBlocks.length, Math.max(currentBudget, requiredBudget)),
          sessionId: activeSessionId,
          sourceLength: rawBlocks.length,
        };
      });
    },
    [activeSessionId, blockBudget, rawBlocks],
  );

  const scrollToBlock = useCallback((id: string) => {
    const root = scrollRef.current;
    if (!root) return;
    findChatBlockElement(root, id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const jumpToBlock = useCallback(
    (id: string) => {
      forceBottomScrollRef.current = false;
      stickRef.current = false;
      ensureBlockRendered(id);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => scrollToBlock(id));
      });
    },
    [ensureBlockRendered, scrollToBlock],
  );
  useEffect(() => {
    if (!currentMatchId) return;
    const frame = window.requestAnimationFrame(() => jumpToBlock(currentMatchId));
    return () => window.cancelAnimationFrame(frame);
  }, [currentMatchId, jumpToBlock]);

  const nextMatch = () => {
    if (matches.length === 0) return;
    const i = (matchIndex + 1) % matches.length;
    setMatchIndex(i);
    jumpToBlock(matches[i]);
  };
  const prevMatch = () => {
    if (matches.length === 0) return;
    const i = (matchIndex - 1 + matches.length) % matches.length;
    setMatchIndex(i);
    jumpToBlock(matches[i]);
  };

  /* ----- user-message nav rail ----- */
  const userNavItems = useMemo(
    () =>
      allVisibleBlocks
        .filter((block): block is Extract<ChatBlock, { kind: "user" }> => block.kind === "user")
        .map((block, index) => ({
          id: block.id,
          label: userMessageNavLabel(block, index),
        })),
    [allVisibleBlocks],
  );
  const userBlockIds = useMemo(() => userNavItems.map((item) => item.id), [userNavItems]);
  const [activeNavId, setActiveNavId] = useState<string | null>(null);
  const navRailRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceBottomScrollRef.current) {
      stickRef.current = true;
    } else {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }
    if (userBlockIds.length === 0) return;
    const top = el.getBoundingClientRect().top;
    let current: string | null = null;
    for (const id of userBlockIds) {
      const node = findChatBlockElement(el, id);
      if (node && node.getBoundingClientRect().top - top < 100) current = id;
    }
    setActiveNavId(current);
  }, [userBlockIds]);

  const onScroll = useCallback(() => {
    setTextSelectionMenu(null);
    if (scrollMeasureFrameRef.current !== null) return;
    scrollMeasureFrameRef.current = window.requestAnimationFrame(() => {
      scrollMeasureFrameRef.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);

  useEffect(
    () => () => {
      if (scrollMeasureFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollMeasureFrameRef.current);
        scrollMeasureFrameRef.current = null;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    forceBottomScrollRef.current = true;
    stickRef.current = true;
    setActiveNavId(null);
    if (sessionScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(sessionScrollFrameRef.current);
    }
    scrollToBottom();
    sessionScrollFrameRef.current = window.requestAnimationFrame(() => {
      sessionScrollFrameRef.current = null;
      scrollToBottom();
    });
    return () => {
      if (sessionScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(sessionScrollFrameRef.current);
        sessionScrollFrameRef.current = null;
      }
    };
  }, [activeSessionId, transcriptLoading]);

  useLayoutEffect(() => {
    if (!forceBottomScrollRef.current) return;
    scrollToBottom();
    if (blockBudget < rawBlocks.length || showTranscriptSkeleton) return;
    if (sessionScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(sessionScrollFrameRef.current);
    }
    sessionScrollFrameRef.current = window.requestAnimationFrame(() => {
      sessionScrollFrameRef.current = null;
      scrollToBottom();
      forceBottomScrollRef.current = false;
    });
  }, [blockBudget, rawBlocks.length, showTranscriptSkeleton]);

  useEffect(() => {
    const container = navRailRef.current;
    if (!container || !activeNavId) return;
    const active = container.querySelector<HTMLElement>("[data-user-nav-active='true']");
    if (!active) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - activeRect.top + 8;
    } else if (activeRect.bottom > containerRect.bottom) {
      container.scrollTop += activeRect.bottom - containerRect.bottom + 8;
    }
  }, [activeNavId]);

  useEffect(() => {
    if (!stickRef.current && !forceBottomScrollRef.current) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if ((stickRef.current || forceBottomScrollRef.current) && scrollRef.current) {
        scrollToBottom();
      }
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [blocks]);

  const toggleProcess = (id: string) => {
    setExpandedProcessIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {findOpen ? (
        <UIRegion id="chat.findBar" data={{ count: matches.length, current: matchIndex }}>
          <FindBar
            count={matches.length}
            current={matchIndex}
            onPrev={prevMatch}
            onNext={nextMatch}
            onClose={() => setFindOpen(false)}
          />
        </UIRegion>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <UIRegion
          id="chat.scrollRoot"
          data={{ activeSessionId, blockCount: rawBlocks.length, streaming }}
        >
          <div
            ref={scrollRef}
            data-chat-scroll-root
            onScroll={onScroll}
            onPointerDownCapture={() => {
              textSelectionPointerActiveRef.current = true;
              setTextSelectionMenu(null);
            }}
            onPointerUpCapture={() => {
              textSelectionPointerActiveRef.current = false;
              scheduleTextSelectionMenuUpdate();
            }}
            onKeyUp={scheduleTextSelectionMenuUpdate}
            className={cn(
              "mobile-shell-scroll h-full min-h-0",
              emptyLanding || showTranscriptSkeleton ? "overflow-hidden" : "overflow-auto",
            )}
          >
            <UIRegion
              id="chat.thread"
              data={{ activeSessionId, blockCount: rawBlocks.length, streaming }}
            >
              <div
                className={cn(
                  "mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2.5 px-3 sm:gap-3 sm:px-4",
                  emptyLanding
                    ? "h-full py-0"
                    : showTranscriptSkeleton
                      ? "h-full py-0"
                      : "py-5 sm:py-8",
                )}
              >
                {showTranscriptSkeleton ? (
                  <UIRegion id="chat.loading">
                    <SessionLoadingSkeleton />
                  </UIRegion>
                ) : null}
                {emptyLanding ? (
                  <UIRegion id="chat.emptyLanding">
                    <NewSessionLanding />
                  </UIRegion>
                ) : null}
                {extensionContextBlock ? (
                  <UIRegion
                    id="chat.extensionContext"
                    data={{
                      activeSessionId,
                      blockId: extensionContextBlock.id,
                      title: activeSession?.extensionState?.sessionTree?.title,
                    }}
                  >
                    <ExtensionSessionContextPanel
                      block={extensionContextBlock}
                      session={activeSession}
                      sessionId={activeSessionId}
                      renderers={renderers}
                    />
                  </UIRegion>
                ) : null}
                {activeSession && sessionHasAgentCoordination(activeSession) ? (
                  <UIRegion
                    id="chat.handoffs"
                    data={{ count: activeSession.handoffs?.length ?? 0 }}
                  >
                    <HandoffTimeline session={activeSession} />
                  </UIRegion>
                ) : null}
                <UIRegion id="chat.blocks" data={{ count: streamItems.length }}>
                  {streamItems.map((item, index) => {
                    const showAgentIdentity = shouldShowStreamItemAgentIdentity(streamItems, index);
                    if (item.type === "process") {
                      const forceOpen = currentMatchId
                        ? item.blocks.some((block) => block.id === currentMatchId)
                        : false;
                      return (
                        <AgentProcessSection
                          key={item.id}
                          process={item}
                          sessionId={activeSessionId}
                          open={forceOpen || expandedProcessIds.has(item.id)}
                          onToggle={() => toggleProcess(item.id)}
                          currentMatchId={currentMatchId}
                          latestAssistantBlockId={latestAssistantBlockId}
                          renderers={renderers}
                          agentToolbarByBlockId={agentToolbarByBlockId}
                          showAgentIdentity={showAgentIdentity}
                        />
                      );
                    }
                    return (
                      <ChatBlockFrame
                        key={item.block.id}
                        block={item.block}
                        sessionId={activeSessionId}
                        currentMatchId={currentMatchId}
                        latestAssistantBlockId={latestAssistantBlockId}
                        renderers={renderers}
                        agentToolbarByBlockId={agentToolbarByBlockId}
                        showAgentIdentity={showAgentIdentity}
                      />
                    );
                  })}
                </UIRegion>
                {streaming && !hasActiveStream ? (
                  <UIRegion id="chat.thinking">
                    <div className="py-1.5 text-[14px]">
                      <ThinkingShimmer />
                    </div>
                  </UIRegion>
                ) : null}
              </div>
            </UIRegion>
          </div>
        </UIRegion>

        {/* User-message navigation rail */}
        {userNavItems.length > 1 ? (
          <UIRegion id="chat.userNavRail" data={{ items: userNavItems }}>
            <div
              ref={navRailRef}
              className="no-scrollbar pointer-events-auto absolute top-1/2 right-5 z-10 hidden max-h-[min(36rem,calc(100%_-_3rem))] -translate-y-1/2 flex-col items-center gap-1.5 overflow-y-auto overscroll-contain px-2 py-1 sm:flex"
            >
              {userNavItems.map((item) => (
                <Tip
                  key={item.id}
                  label={
                    <span className="block max-w-72 break-words whitespace-pre-wrap">
                      {item.label}
                    </span>
                  }
                  side="left"
                  closeOnClick={false}
                >
                  <button
                    type="button"
                    aria-label={`Jump to message: ${item.label}`}
                    onClick={() => jumpToBlock(item.id)}
                    data-user-nav-active={activeNavId === item.id ? "true" : undefined}
                    className={cn(
                      "pointer-events-auto h-2 w-2 rounded-full transition-colors",
                      activeNavId === item.id ? "bg-info" : "bg-muted/40 hover:bg-muted",
                    )}
                  />
                </Tip>
              ))}
            </div>
          </UIRegion>
        ) : null}

        {textSelectionMenu ? (
          <UIRegion id="chat.selectionMenu" data={{ textLength: textSelectionMenu.text.length }}>
            <TextSelectionMenu
              key={textSelectionMenu.id}
              menu={textSelectionMenu}
              onAction={insertSelectedText}
            />
          </UIRegion>
        ) : null}
      </div>
    </div>
  );
}

function TextSelectionMenu({
  menu,
  onAction,
}: {
  menu: TextSelectionMenuState;
  onAction: (action: TextSelectionMenuAction) => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const menuRect = node.getBoundingClientRect();
    const left = clamp(
      menu.anchorRect.left + menu.anchorRect.width / 2 - menuRect.width / 2,
      SELECTION_MENU_VIEWPORT_PADDING,
      window.innerWidth - menuRect.width - SELECTION_MENU_VIEWPORT_PADDING,
    );
    let top = menu.anchorRect.top - menuRect.height - SELECTION_MENU_GAP;
    if (top < SELECTION_MENU_VIEWPORT_PADDING) {
      top = menu.anchorRect.bottom + SELECTION_MENU_GAP;
    }
    top = clamp(
      top,
      SELECTION_MENU_VIEWPORT_PADDING,
      window.innerHeight - menuRect.height - SELECTION_MENU_VIEWPORT_PADDING,
    );
    setPosition({ left, top });
  }, [menu.anchorRect.bottom, menu.anchorRect.left, menu.anchorRect.top, menu.anchorRect.width]);

  return (
    <div
      ref={menuRef}
      role="toolbar"
      aria-label={t("selectionMenu.label")}
      onPointerDown={(event) => event.preventDefault()}
      className={cn(
        "ui-popover-surface fixed z-[70] flex max-w-[calc(100vw-16px)] overflow-x-auto rounded-lg p-0 backdrop-blur",
        !position && "invisible",
      )}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
      }}
    >
      <TextSelectionMenuButton onClick={() => onAction("add")}>
        {t("selectionMenu.addToConversation")}
      </TextSelectionMenuButton>
      <TextSelectionMenuButton onClick={() => onAction("details")}>
        {t("selectionMenu.moreDetails")}
      </TextSelectionMenuButton>
      <TextSelectionMenuButton onClick={() => onAction("side-chat")}>
        {t("selectionMenu.askSideChat")}
      </TextSelectionMenuButton>
    </div>
  );
}

function TextSelectionMenuButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-border-subtle text-fg hover:bg-surface-hover h-9 shrink-0 border-r px-3 text-[13px] font-medium whitespace-nowrap transition-colors last:border-r-0"
    >
      {children}
    </button>
  );
}

function textSelectionMenuState(
  root: HTMLElement | null,
  id: number,
): TextSelectionMenuState | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  if (
    !rangeEndpointInside(root, range.startContainer) ||
    !rangeEndpointInside(root, range.endContainer)
  ) {
    return null;
  }

  const rect = usableRangeRect(range);
  if (!rect) return null;
  return {
    anchorRect: viewportRect(rect),
    id,
    text,
  };
}

function rangeEndpointInside(root: HTMLElement, node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element && root.contains(element));
}

function usableRangeRect(range: Range): DOMRect | null {
  const bounding = range.getBoundingClientRect();
  if (usableRect(bounding)) return bounding;
  for (const rect of Array.from(range.getClientRects())) {
    if (usableRect(rect)) return rect;
  }
  return null;
}

function usableRect(rect: DOMRect | DOMRectReadOnly): boolean {
  return rect.width > 0 || rect.height > 0;
}

function viewportRect(rect: DOMRect | DOMRectReadOnly): ViewportRect {
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  };
}

function selectionPrompt(label: string, text: string): string {
  return `${label}\n\n${quoteSelectedText(text)}`;
}

function quoteSelectedText(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function ChatBlockFrame({
  block,
  sessionId,
  currentMatchId,
  latestAssistantBlockId,
  renderers,
  agentToolbarByBlockId,
  showAgentIdentity = true,
}: {
  block: ChatBlock;
  sessionId: string;
  currentMatchId: string | null;
  latestAssistantBlockId?: string;
  renderers: BlockRenderer[];
  agentToolbarByBlockId: Map<string, AgentSegmentToolbarInfo>;
  showAgentIdentity?: boolean;
}) {
  const blockData = { block };
  return (
    <UIRegion id="chat.block" data={blockData}>
      <UIRegion id={`chat.block.${block.kind}`} data={blockData}>
        <div
          id={chatBlockElementId(sessionId, block.id)}
          data-chat-block-id={block.id}
          className={cn(
            "group animate-fade-in scroll-mt-20",
            currentMatchId === block.id && "ring-info/50 rounded-lg ring-2",
          )}
        >
          {showAgentIdentity && shouldShowBlockAgentIdentity(block) ? (
            <AgentIdentity providerId={block.agentProviderId} />
          ) : null}
          <BlockView
            block={block}
            sessionId={sessionId}
            externalPreviewsDefaultExpanded={block.id === latestAssistantBlockId}
            renderers={renderers}
            showInlineAgentIdentity={showAgentIdentity}
          />
          {agentToolbarByBlockId.has(block.id) ? (
            <AgentSegmentToolbar toolbar={agentToolbarByBlockId.get(block.id)!} />
          ) : null}
        </div>
      </UIRegion>
    </UIRegion>
  );
}

function AgentProcessSection({
  process,
  sessionId,
  open,
  onToggle,
  currentMatchId,
  latestAssistantBlockId,
  renderers,
  agentToolbarByBlockId,
  showAgentIdentity,
}: {
  process: Extract<StreamItem, { type: "process" }>;
  sessionId: string;
  open: boolean;
  onToggle: () => void;
  currentMatchId: string | null;
  latestAssistantBlockId?: string;
  renderers: BlockRenderer[];
  agentToolbarByBlockId: Map<string, AgentSegmentToolbarInfo>;
  showAgentIdentity: boolean;
}) {
  const lang = useI18nStore((s) => s.lang);
  const provider = useAspStore((state) =>
    process.providerId ? state.providers.find((item) => item.id === process.providerId) : undefined,
  );
  const [renderContent, setRenderContent] = useState(open);
  const label = agentProcessLabel(process.startedAt, process.endedAt, lang);

  useEffect(() => {
    if (open) {
      setRenderContent(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setRenderContent(false), PROCESS_COLLAPSE_UNMOUNT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <UIRegion
      id="chat.agentProcess"
      data={{
        id: process.id,
        startedAt: process.startedAt,
        endedAt: process.endedAt,
        blockCount: process.blocks.length,
        open,
      }}
    >
      <div className="animate-fade-in">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="border-border-subtle text-muted hover:text-fg flex w-full items-center gap-1.5 border-b py-2 text-left text-[13px] transition-colors outline-none focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
        >
          {showAgentIdentity && process.providerId ? (
            <AgentLogo provider={provider} compact className="h-4 w-4" />
          ) : null}
          <span>{label}</span>
          <ChevronRight
            size={15}
            className={cn("shrink-0 transition-transform", open && "rotate-90")}
          />
        </button>
        <div
          aria-hidden={!open}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {renderContent ? (
              <div className="flex flex-col gap-1 pt-1.5">
                {process.blocks.map((block) => (
                  <ChatBlockFrame
                    key={block.id}
                    block={block}
                    sessionId={sessionId}
                    currentMatchId={currentMatchId}
                    latestAssistantBlockId={latestAssistantBlockId}
                    renderers={renderers}
                    agentToolbarByBlockId={agentToolbarByBlockId}
                    showAgentIdentity={false}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </UIRegion>
  );
}

function buildStreamItems(blocks: ChatBlock[], sessionStreaming: boolean): StreamItem[] {
  const items: StreamItem[] = [];
  let userBlock: Extract<ChatBlock, { kind: "user" }> | undefined;
  let agentBlocks: ChatBlock[] = [];

  const flushTurn = (tail: boolean) => {
    if (userBlock) items.push({ type: "block", block: userBlock });
    items.push(...agentSegmentItems(agentBlocks, sessionStreaming && tail, userBlock));
    userBlock = undefined;
    agentBlocks = [];
  };

  for (const block of blocks) {
    if (block.kind === "user") {
      flushTurn(false);
      userBlock = block;
    } else if (userBlock) {
      agentBlocks.push(block);
    } else {
      items.push({ type: "block", block });
    }
  }
  flushTurn(true);

  return items;
}

function shouldShowStreamItemAgentIdentity(items: StreamItem[], index: number): boolean {
  const item = items[index];
  if (!item || (item.type === "block" && item.block.kind === "user")) return false;
  const providerId = streamItemIdentityProviderId(item);
  if (!providerId) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = items[cursor];
    if (previous.type === "block" && previous.block.kind === "user") return true;
    const previousProviderId = streamItemIdentityProviderId(previous);
    if (!previousProviderId) continue;
    return previousProviderId !== providerId;
  }
  return true;
}

function streamItemIdentityProviderId(item: StreamItem): string | undefined {
  return item.type === "process" ? item.providerId : blockIdentityProviderId(item.block);
}

function blockIdentityProviderId(block: ChatBlock): string | undefined {
  if (block.kind === "user") return undefined;
  if (block.kind === "assistant") return assistantProviderId(block);
  return block.agentProviderId;
}

function agentSegmentItems(
  blocks: ChatBlock[],
  tailStreaming: boolean,
  userBlock?: ChatBlock,
): StreamItem[] {
  if (!blocks.length) return [];
  const firstLiveIndex = blocks.findIndex(isLiveBlock);
  const stableBlocks = firstLiveIndex === -1 ? blocks : blocks.slice(0, firstLiveIndex);
  const liveBlocks = firstLiveIndex === -1 ? [] : blocks.slice(firstLiveIndex);
  return [
    ...completedAgentSegmentItems(stableBlocks, userBlock, !tailStreaming && !liveBlocks.length),
    ...liveBlocks.map((block) => ({ type: "block" as const, block })),
  ];
}

function completedAgentSegmentItems(
  blocks: ChatBlock[],
  userBlock: ChatBlock | undefined,
  preserveFinalAssistant: boolean,
): StreamItem[] {
  if (!blocks.length) return [];
  const processBlockIndex = blocks.findIndex((block) => block.kind !== "assistant");
  if (processBlockIndex === -1) return blocks.map((block) => ({ type: "block", block }));

  const lastAssistantIndex = findLastBlockIndex(blocks, (block) => block.kind === "assistant");
  const lastProcessIndex = findLastBlockIndex(blocks, (block) => block.kind !== "assistant");
  const finalAssistantIndex =
    preserveFinalAssistant && lastAssistantIndex > lastProcessIndex ? lastAssistantIndex : -1;
  const processBlocks =
    finalAssistantIndex === -1
      ? blocks
      : blocks.filter((_, index) => index !== finalAssistantIndex);
  const finalAssistant =
    finalAssistantIndex === -1
      ? undefined
      : (blocks[finalAssistantIndex] as Extract<ChatBlock, { kind: "assistant" }>);
  const processTailBlock = processBlocks[processBlocks.length - 1];

  return [
    {
      type: "process" as const,
      id: `${(finalAssistant ?? processTailBlock).id}:process`,
      blocks: processBlocks,
      providerId:
        (finalAssistant ? assistantProviderId(finalAssistant) : undefined) ??
        processBlocks.find((block) => block.agentProviderId)?.agentProviderId ??
        processBlocks
          .filter(
            (block): block is Extract<ChatBlock, { kind: "assistant" }> =>
              block.kind === "assistant",
          )
          .map(assistantProviderId)
          .find(Boolean),
      startedAt: blockTimestamp(userBlock) ?? blockTimestamp(blocks[0]),
      endedAt: blockTimestamp(finalAssistant) ?? blockTimestamp(processTailBlock),
    },
    ...(finalAssistant ? [{ type: "block" as const, block: finalAssistant }] : []),
  ];
}

function findLastBlockIndex(blocks: ChatBlock[], predicate: (block: ChatBlock) => boolean): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (predicate(blocks[index])) return index;
  }
  return -1;
}

function isLiveBlock(block: ChatBlock): boolean {
  return (
    ("streaming" in block && block.streaming) || ("status" in block && block.status === "running")
  );
}

function blockTimestamp(block: ChatBlock | undefined): number | undefined {
  if (!block) return undefined;
  const at = "at" in block ? block.at : undefined;
  if (typeof at === "number" && Number.isFinite(at)) return at;
  return typeof block.order === "number" && Number.isFinite(block.order) ? block.order : undefined;
}

function agentProcessLabel(
  startedAt: number | undefined,
  endedAt: number | undefined,
  lang: string,
): string {
  const duration = formatElapsedDuration(startedAt, endedAt, lang);
  if (duration) return lang === "zh" ? `工作了 ${duration}` : `Worked for ${duration}`;
  return lang === "zh" ? "Agent 过程" : "Agent process";
}

function formatElapsedDuration(
  startedAt: number | undefined,
  endedAt: number | undefined,
  lang: string,
): string | null {
  if (
    typeof startedAt !== "number" ||
    typeof endedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt < startedAt
  ) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (lang === "zh") {
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
    return `${seconds}秒`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function userMessageNavLabel(block: Extract<ChatBlock, { kind: "user" }>, index: number): string {
  const text = block.text.trim().replace(/\s+/g, " ");
  if (text) return truncateNavLabel(text);
  const attachmentNames = block.attachments?.map((attachment) => attachment.name).filter(Boolean);
  if (attachmentNames?.length) return truncateNavLabel(attachmentNames.join(", "));
  return `Message ${index + 1}`;
}

function truncateNavLabel(value: string): string {
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

function extensionSessionContextBlock(
  session: Session | undefined,
  blocks: ChatBlock[],
): Extract<ChatBlock, { kind: "assistant" }> | null {
  if (!session?.extensionState?.sessionTree) return null;
  const first = blocks[0];
  if (!first || first.kind !== "assistant" || first.streaming) return null;
  const metadata = first.metadata ?? {};
  if (metadata.extensionSessionContext === true) return first;
  if (blockRendererIds(first).length > 0) return first;
  return first.agentProviderId ? null : first;
}

function ExtensionSessionContextPanel({
  block,
  session,
  sessionId,
  renderers,
}: {
  block: Extract<ChatBlock, { kind: "assistant" }>;
  session: Session | undefined;
  sessionId: string;
  renderers: ReturnType<typeof useBlockRenderers>;
}) {
  const lang = useI18nStore((s) => s.lang);
  const defaultOpen = block.text.length <= LARGE_EXTENSION_CONTEXT_CHAR_LIMIT;
  const [open, setOpen] = useState(defaultOpen);
  const label = extensionSessionContextLabel(block, lang);
  const title = session?.extensionState?.sessionTree?.title?.trim();

  useEffect(() => {
    setOpen(defaultOpen);
  }, [block.id, defaultOpen]);

  return (
    <div className="bg-canvas/95 sticky top-0 z-20 -mx-1 py-2 backdrop-blur">
      <div className="border-border-subtle bg-surface/90 overflow-hidden rounded-[8px] border shadow-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="hover:bg-surface-hover/60 flex h-10 w-full min-w-0 items-center gap-2 px-3 text-left transition-colors"
        >
          <ChevronRight
            size={15}
            className={cn("text-subtle shrink-0 transition-transform", open && "rotate-90")}
          />
          <FileText size={15} className="text-info shrink-0" />
          <span className="text-fg shrink-0 text-[13px] font-medium">{label}</span>
          {title ? <span className="text-subtle min-w-0 truncate text-[12px]">{title}</span> : null}
        </button>
        <div
          aria-hidden={!open}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-border-subtle max-h-[min(42vh,34rem)] overflow-auto border-t px-3 py-3">
              {open ? (
                <BlockView
                  block={block}
                  sessionId={sessionId}
                  externalPreviewsDefaultExpanded={false}
                  renderers={renderers}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function extensionSessionContextLabel(
  block: Extract<ChatBlock, { kind: "assistant" }>,
  lang: string,
) {
  const metadata = recordValue(block.metadata);
  const provider = typeof metadata.provider === "string" ? metadata.provider.toLowerCase() : "";
  const type = typeof metadata.type === "string" ? metadata.type.toLowerCase() : "";
  if (provider === "github") {
    if (type === "pull_request") return "GitHub PR";
    if (type === "issue") return lang === "zh" ? "GitHub Issue" : "GitHub issue";
    return lang === "zh" ? "GitHub 上下文" : "GitHub context";
  }
  return lang === "zh" ? "会话上下文" : "Session context";
}

function SessionLoadingSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-5 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div className="flex animate-pulse flex-col gap-4">
          <div className="bg-surface h-16 rounded-lg" />
          <div className="border-border-subtle flex flex-col gap-2 rounded-lg border p-4">
            <div className="bg-surface-hover h-3 w-2/3 rounded-full" />
            <div className="bg-surface-hover h-3 w-5/6 rounded-full" />
            <div className="bg-surface-hover h-3 w-1/2 rounded-full" />
          </div>
          <div className="border-border-subtle flex flex-col gap-2 rounded-lg border p-4">
            <div className="bg-surface-hover h-3 w-3/4 rounded-full" />
            <div className="bg-surface-hover h-3 w-4/6 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function NewSessionLanding() {
  const lang = useI18nStore((s) => s.lang);
  const t = useT();
  const starters =
    lang === "zh"
      ? [
          {
            title: "探索并理解代码",
            prompt: "帮我探索并理解这个项目的代码结构和关键模块。",
            icon: SearchCode,
            className: "text-info",
          },
          {
            title: "构建新功能、应用或工具",
            prompt: "帮我基于当前项目构建一个新功能。",
            icon: Sparkles,
            className: "text-accent",
          },
          {
            title: "审查代码并提出修改建议",
            prompt: "请审查当前项目代码，并提出需要修改的问题。",
            icon: GitPullRequest,
            className: "text-success",
          },
          {
            title: "修复问题和失败",
            prompt: "帮我定位并修复当前项目里的问题或失败测试。",
            icon: Bug,
            className: "text-warning",
          },
        ]
      : [
          {
            title: "Explore and understand code",
            prompt: "Help me explore this project's structure and key modules.",
            icon: SearchCode,
            className: "text-info",
          },
          {
            title: "Build a feature, app, or tool",
            prompt: "Help me build a new feature in the current project.",
            icon: Sparkles,
            className: "text-accent",
          },
          {
            title: "Review code and suggest changes",
            prompt: "Review the current project and suggest changes I should make.",
            icon: GitPullRequest,
            className: "text-success",
          },
          {
            title: "Fix issues and failures",
            prompt: "Help me find and fix bugs or failing tests in this project.",
            icon: Bug,
            className: "text-warning",
          },
        ];

  return (
    <div className="flex h-full min-h-[360px] w-full flex-col items-center text-center sm:min-h-[420px]">
      <div className="flex w-full shrink-0 basis-[40%] items-end justify-center pb-4 sm:basis-[46%] sm:pb-6">
        <h1 className="text-fg max-w-3xl text-[23px] leading-tight font-semibold text-balance sm:text-[25px]">
          {t("thread.empty.title")}
        </h1>
      </div>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-2 px-2 sm:grid-cols-2 sm:gap-2.5 sm:px-0 lg:grid-cols-4">
        {starters.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.title}
              type="button"
              onClick={() => useUIStore.getState().setEditDraft(item.prompt)}
              className="ui-soft-card ui-soft-card-interactive group flex min-h-[72px] items-center gap-3 rounded-[8px] px-3 py-3 text-left transition-[background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 sm:min-h-[92px] sm:flex-col sm:items-start sm:justify-between sm:p-3.5"
            >
              <span className="bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px]">
                <Icon size={17} strokeWidth={1.9} className={cn(item.className)} />
              </span>
              <span className="text-fg min-w-0 text-[13px] leading-5 font-medium text-pretty">
                {item.title}
              </span>
            </button>
          );
        })}
      </div>
      <div aria-hidden className="min-h-6 flex-1" />
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  sessionId,
  externalPreviewsDefaultExpanded,
  renderers,
  showInlineAgentIdentity = true,
}: {
  block: ChatBlock;
  sessionId: string;
  externalPreviewsDefaultExpanded: boolean;
  renderers: ReturnType<typeof useBlockRenderers>;
  showInlineAgentIdentity?: boolean;
}) {
  const agentProviderId = showInlineAgentIdentity ? inlineAgentProviderId(block) : undefined;
  const agentProvider = useAspStore((state) =>
    agentProviderId ? state.providers.find((item) => item.id === agentProviderId) : undefined,
  );
  const custom = selectBlockRenderer(block, renderers);
  if (custom) {
    return (
      <ExtensionSurfaceErrorBoundary
        extensionId={custom.owner ?? custom.id ?? "unknown"}
        contributionId={custom.id ?? block.kind}
        surface="chat"
        resetKey={`${custom.id ?? ""}:${block.id}`}
      >
        <CustomBlockRenderer renderer={custom} block={block} />
      </ExtensionSurfaceErrorBoundary>
    );
  }
  const content: ReactNode = renderBuiltin(block, {
    agentProvider,
    agentProviderId,
    externalPreviewsDefaultExpanded,
    sessionId,
  });
  return <>{content}</>;
});

function CustomBlockRenderer({ renderer, block }: { renderer: BlockRenderer; block: ChatBlock }) {
  return <>{renderer.render(block)}</>;
}

function latestAssistantBlockIdInActiveAgentSegment(blocks: ChatBlock[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === "user") return undefined;
    if (block.kind === "assistant") return block.id;
  }
  return undefined;
}

function buildAgentToolbarByBlockId(blocks: ChatBlock[]): Map<string, AgentSegmentToolbarInfo> {
  const output = new Map<string, AgentSegmentToolbarInfo>();
  let segmentAssistantBlocks: Array<Extract<ChatBlock, { kind: "assistant" }>> = [];

  const flushSegment = () => {
    if (segmentAssistantBlocks.length > 0) {
      const last = segmentAssistantBlocks[segmentAssistantBlocks.length - 1];
      output.set(last.id, {
        at: last.at,
        branchBlockId: last.id,
        branchDisabled: last.streaming,
        copyBlockIds: segmentAssistantBlocks.map((block) => block.id),
        providerId: assistantProviderId(last),
      });
    }
    segmentAssistantBlocks = [];
  };

  for (const block of blocks) {
    if (block.kind === "user") {
      flushSegment();
      continue;
    }
    if (block.kind === "assistant") segmentAssistantBlocks.push(block);
  }
  flushSegment();

  return output;
}

function AgentSegmentToolbar({ toolbar }: { toolbar: AgentSegmentToolbarInfo }) {
  const t = useT();
  const branchFromBlock = useChatStore((s) => s.branchFromBlock);
  const provider = useAspStore((state) =>
    toolbar.providerId ? state.providers.find((item) => item.id === toolbar.providerId) : undefined,
  );
  const [copied, setCopied] = useState(false);
  const coarsePointer = useCoarsePointer();
  const sentTime = formatToolbarTime(toolbar.at);

  const copySegment = async () => {
    try {
      const state = useChatStore.getState();
      const session = state.sessions.find((item) => item.id === state.activeSessionId);
      const copyIds = new Set(toolbar.copyBlockIds);
      const copyText = (session?.blocks ?? [])
        .filter(
          (block): block is Extract<ChatBlock, { kind: "assistant" }> =>
            block.kind === "assistant" && copyIds.has(block.id),
        )
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n\n");
      if (!copyText) return;
      await copyTextToClipboard(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(t("message.copyFailed"));
    }
  };

  return (
    <div
      className={cn(
        "text-subtle mt-1 flex h-5 items-center gap-2 text-[13px] transition-opacity",
        coarsePointer
          ? "opacity-100"
          : "invisible opacity-0 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100",
      )}
    >
      {toolbar.providerId ? <AgentLogo provider={provider} compact className="h-4 w-4" /> : null}
      {sentTime ? <span className="tabular-nums">{sentTime}</span> : null}
      <button
        type="button"
        title={copied ? t("common.copied") : t("message.copyAgentMessages")}
        aria-label={copied ? t("common.copied") : t("message.copyAgentMessages")}
        onClick={copySegment}
        className="hover:bg-surface-hover hover:text-fg flex h-5 w-5 items-center justify-center rounded-md transition-colors"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <button
        type="button"
        title={t("message.branchFromHere")}
        aria-label={t("message.branchFromHere")}
        disabled={toolbar.branchDisabled}
        onClick={() => branchFromBlock(toolbar.branchBlockId)}
        className="hover:bg-surface-hover hover:text-fg flex h-5 w-5 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        <GitBranch size={14} />
      </button>
    </div>
  );
}

function formatToolbarTime(at?: number): string | null {
  if (!at) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

function selectBlockRenderer(
  block: ChatBlock,
  renderers: BlockRenderer[],
): BlockRenderer | undefined {
  return [...renderers]
    .filter((renderer) => blockRendererMatches(renderer, block))
    .sort((a, b) => rendererRank(b, block) - rendererRank(a, block))[0];
}

function blockRendererMatches(renderer: BlockRenderer, block: ChatBlock): boolean {
  const hasSelector = Boolean(
    renderer.kind || renderer.renderer || renderer.mimeType || renderer.canRender,
  );
  if (!hasSelector) return false;
  const kindOk = !renderer.kind || selectorIncludes(renderer.kind, block.kind);
  const rendererSelector = renderer.renderer;
  const rendererOk =
    !rendererSelector ||
    blockRendererIds(block).some((id) => selectorIncludes(rendererSelector, id));
  const mimeOk =
    !renderer.mimeType ||
    ("mimeType" in block &&
      typeof block.mimeType === "string" &&
      mimeMatches(renderer.mimeType, block.mimeType));
  const predicateOk = renderer.canRender ? renderer.canRender(block) : true;
  return kindOk && rendererOk && Boolean(mimeOk) && predicateOk;
}

function rendererRank(renderer: BlockRenderer, block: ChatBlock): number {
  let rank = renderer.priority ?? 0;
  if (renderer.canRender) rank += 1;
  if (renderer.kind) rank += 2;
  if (renderer.mimeType && "mimeType" in block && block.mimeType) rank += 4;
  if (renderer.renderer && blockRendererIds(block).length) rank += 8;
  return rank;
}

function assistantProviderId(block: Extract<ChatBlock, { kind: "assistant" }>): string | undefined {
  const value = block.agentProviderId ?? block.metadata?.agentProviderId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasInlineAgentIdentity(block: ChatBlock): boolean {
  return block.kind === "reasoning" || block.kind === "tool";
}

function shouldShowBlockAgentIdentity(block: ChatBlock): boolean {
  if (block.kind === "user" || block.kind === "assistant") return false;
  return !hasInlineAgentIdentity(block);
}

function inlineAgentProviderId(block: ChatBlock): string | undefined {
  if (!hasInlineAgentIdentity(block)) return undefined;
  return block.agentProviderId;
}

function AgentIdentity({ providerId }: { providerId: string | undefined }) {
  const provider = useAspStore((state) =>
    providerId ? state.providers.find((item) => item.id === providerId) : undefined,
  );
  if (!providerId) return null;
  return (
    <div className="text-muted mb-1.5 flex items-center">
      <AgentLogo provider={provider} compact className="h-3.5 w-3.5" />
    </div>
  );
}

function selectorIncludes(selector: string | string[], value: string): boolean {
  return (Array.isArray(selector) ? selector : [selector]).includes(value);
}

function mimeMatches(selector: string | string[], value: string): boolean {
  const lower = value.toLowerCase();
  return (Array.isArray(selector) ? selector : [selector]).some((item) => {
    const candidate = item.toLowerCase();
    if (candidate === lower) return true;
    if (candidate.endsWith("/*")) return lower.startsWith(candidate.slice(0, -1));
    return false;
  });
}

function blockRendererIds(block: ChatBlock): string[] {
  const metadata = "metadata" in block ? recordValue(block.metadata) : {};
  const app = "app" in block ? recordValue(block.app) : {};
  const appMetadata = recordValue(app.metadata);
  const ids = [
    metadata.renderer,
    metadata.rendererId,
    metadata.renderer_id,
    metadata.component,
    metadata.componentId,
    metadata.component_id,
    recordValue(metadata.ui).renderer,
    recordValue(metadata.ui).component,
    recordValue(metadata.widget).renderer,
    recordValue(metadata.widget).component,
    app.renderer,
    appMetadata.renderer,
    appMetadata.component,
  ];
  return ids
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function renderBuiltin(
  block: ChatBlock,
  options: {
    agentProvider?: AspProvider;
    agentProviderId?: string;
    externalPreviewsDefaultExpanded: boolean;
    sessionId: string;
  },
): ReactNode {
  switch (block.kind) {
    case "user":
      return (
        <UserMessage
          id={block.id}
          text={block.text}
          attachments={block.attachments}
          at={block.at}
        />
      );
    case "assistant":
      return (
        <AssistantMessage
          externalPreviewsDefaultExpanded={options.externalPreviewsDefaultExpanded}
          text={block.text}
          streaming={block.streaming}
        />
      );
    case "reasoning":
      return (
        <ReasoningBlock
          agentProvider={options.agentProvider}
          agentProviderId={options.agentProviderId}
          text={block.text}
          streaming={block.streaming}
        />
      );
    case "plan":
      return <PlanTodoList todos={block.todos} />;
    case "tool":
      return (
        <ToolCallBlock
          agentProvider={options.agentProvider}
          agentProviderId={options.agentProviderId}
          title={block.title}
          toolKind={block.toolKind}
          output={block.output}
          rawInput={block.rawInput}
          rawOutput={block.rawOutput}
          locations={block.locations}
          status={block.status}
        />
      );
    case "terminal":
      return (
        <TerminalBlock
          command={block.command}
          cwd={block.cwd}
          output={block.output}
          status={block.status}
        />
      );
    case "diff":
      return (
        <DiffBlock
          id={block.id}
          path={block.path}
          hunks={block.hunks}
          status={block.status}
          review={block.review}
        />
      );
    case "image":
      return <ImageGallery urls={block.urls} prompt={block.prompt} />;
    case "resource":
      return (
        <ResourceBlock
          title={block.title}
          name={block.name}
          uri={block.uri}
          path={block.path}
          mimeType={block.mimeType}
          content={block.content}
          app={block.app}
          sessionId={options.sessionId}
          agentProviderId={block.agentProviderId}
          providerSessionId={block.agentProviderSessionId}
        />
      );
    case "artifact":
      return (
        <ArtifactBlock
          artifactId={block.artifactId}
          title={block.title}
          name={block.name}
          uri={block.uri}
          path={block.path}
          mimeType={block.mimeType}
          content={block.content}
          app={block.app}
          sessionId={options.sessionId}
          agentProviderId={block.agentProviderId}
          providerSessionId={block.agentProviderSessionId}
        />
      );
    case "raw":
      return <RawBlock label={block.label} value={block.value} />;
    case "error":
      return <ErrorBlock message={block.message} />;
    default:
      return null;
  }
}

function HandoffTimeline({ session }: { session: Session }) {
  const lang = useI18nStore((state) => state.lang);
  const providers = useAspStore((state) => state.providers);
  const handoffs = session.handoffs?.slice(-3) ?? [];
  const subagents = Object.values(session.agentParticipants ?? {})
    .filter((participant) => participant.kind === "runtime-subagent")
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-3);
  if (!handoffs.length && !subagents.length) return null;
  const participantName = (participantId: string | undefined, fallback: string) => {
    if (!participantId) return fallback;
    const participant = session.agentParticipants?.[participantId];
    return (
      participant?.name ||
      providers.find((provider) => provider.id === participant?.providerId)?.name ||
      participant?.profileId ||
      fallback
    );
  };
  return (
    <div className="border-border/70 bg-surface/60 mb-1 rounded-xl border px-3 py-2.5">
      <div className="text-muted mb-2 text-[11px] font-medium tracking-wide uppercase">
        {lang === "zh" ? "Agent 交接" : "Agent handoffs"}
      </div>
      <div className="flex flex-col gap-2">
        {handoffs.map((handoff) => {
          const target = session.agentParticipants?.[handoff.toParticipantId];
          const targetProvider = providers.find(
            (provider) => provider.id === (target?.providerId ?? handoff.targetProviderId),
          );
          const itemCount =
            handoff.context.messages.length + (handoff.context.artifacts?.length ?? 0);
          return (
            <div key={handoff.id} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="text-muted min-w-0 truncate">
                {participantName(
                  handoff.fromParticipantId,
                  lang === "zh" ? "共享上下文" : "Shared context",
                )}
              </span>
              <ChevronRight size={13} className="text-subtle shrink-0" />
              <span className="text-fg flex min-w-0 items-center gap-1.5 font-medium">
                <AgentLogo provider={targetProvider} compact className="h-3.5 w-3.5" />
                <span className="truncate">
                  {participantName(
                    handoff.toParticipantId,
                    targetProvider?.name ?? handoff.targetProviderId,
                  )}
                </span>
              </span>
              <span className="text-subtle ml-auto shrink-0">
                {handoffStatusLabel(handoff.status, lang)} · {itemCount}
                {handoff.context.omitted ? ` +${handoff.context.omitted.itemCount}` : ""}
              </span>
            </div>
          );
        })}
        {subagents.map((participant) => {
          const provider = providers.find((item) => item.id === participant.providerId);
          return (
            <div key={participant.id} className="flex min-w-0 items-center gap-2 text-[12px]">
              <AgentLogo provider={provider} compact className="h-3.5 w-3.5" />
              <span className="text-fg min-w-0 truncate font-medium">
                {participant.name || participant.profileId || "Subagent"}
              </span>
              <span className="text-muted">{lang === "zh" ? "子 Agent" : "Subagent"}</span>
              <span className="text-subtle ml-auto shrink-0">
                {handoffStatusLabel(participant.status, lang)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sessionHasAgentCoordination(session: Session): boolean {
  return Boolean(
    session.handoffs?.length ||
    Object.values(session.agentParticipants ?? {}).some(
      (participant) => participant.kind === "runtime-subagent",
    ),
  );
}

function handoffStatusLabel(status: string, lang: string): string {
  const zh: Record<string, string> = {
    idle: "空闲",
    queued: "待发送",
    running: "运行中",
    delivered: "已发送",
    acknowledged: "已确认",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const en: Record<string, string> = {
    idle: "Idle",
    queued: "Queued",
    running: "Running",
    delivered: "Delivered",
    acknowledged: "Acknowledged",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return (lang === "zh" ? zh : en)[status] ?? status;
}

function formatSearchValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
