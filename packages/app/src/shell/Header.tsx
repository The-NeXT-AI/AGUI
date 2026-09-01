import { useEffect, useRef, useState, type FormEvent } from "react";
import { useHeaderControls, useShellStore } from "@the-next-ai/app";
import {
  Archive,
  CalendarClock,
  Copy,
  ExternalLink,
  GitBranch,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  PictureInPicture2,
  Pin,
  PinOff,
} from "lucide-react";
import { useChatStore } from "@/chat/chat-store";
import type { ChatBlock, Session } from "@/chat/types";
import { desktopApi } from "@/asp/desktop-api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useT, type TranslateFn } from "@/lib/i18n";
import { useUIStore } from "@/ui/ui-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/ui/cn";
import { toast } from "@/ui/toast";
import { UIRegion } from "@/product/UIRegion";

/**
 * The slim conversation header: sidebar toggle on the left, the active session
 * title, and header controls contributed by extensions on either side.
 */
export function Header() {
  const sidebarOpen = useShellStore((s) => s.sidebarOpen);
  const detailPanelOpen = useShellStore((s) => s.detailPanelOpen);
  const controls = useHeaderControls();
  const session = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));

  const left = controls.filter((c) => c.align === "left");
  const right = controls.filter((c) => c.align === "right");

  return (
    <header
      className={cn(
        "app-titlebar app-titlebar-right-drawer-inset electron-drag-region relative flex h-[var(--titlebar-height)] shrink-0 items-center gap-1 pl-2",
        !sidebarOpen && "macos-window-controls-inset",
      )}
    >
      {!sidebarOpen ? (
        <>
          <div aria-hidden className="native-titlebar-click-slot shell-sidebar-native-click-slot" />
          <div
            aria-hidden
            className="native-titlebar-click-slot shell-sidebar-search-native-click-slot"
          />
        </>
      ) : null}
      {!detailPanelOpen ? (
        <div
          aria-hidden
          className="native-titlebar-click-slot shell-detail-panel-native-click-slot"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {!sidebarOpen ? <div aria-hidden className="h-8 w-[96px] shrink-0 sm:w-[76px]" /> : null}
        <UIRegion id="header.leftControls">
          {left.map((c) => (
            <div key={c.id} className="flex items-center">
              {c.render()}
            </div>
          ))}
        </UIRegion>
        {session ? (
          <UIRegion id="header.sessionTitle" data={sessionRegionData(session)}>
            <div className="ml-1 flex min-w-0 items-center gap-0.5">
              <span className="text-muted pointer-events-none max-w-[calc(100vw-190px)] min-w-0 truncate text-[13px] font-medium sm:max-w-[min(34rem,65vw)]">
                {session.title}
              </span>
              <SessionTitleMenu session={session} />
            </div>
          </UIRegion>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <UIRegion id="header.rightControls">
          {right.map((c) => (
            <div key={c.id} className="flex items-center">
              {c.render()}
            </div>
          ))}
        </UIRegion>
      </div>
    </header>
  );
}

function SessionTitleMenu({ session }: { session: Session }) {
  const t = useT();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const branchDisabled = session.status === "streaming" || session.blocks.length === 0;
  const pinned = Boolean(session.pinnedAt);
  const archived = Boolean(session.archivedAt);
  const agentSessionId = agentSessionIdFromSession(session);

  const togglePinned = () => {
    useChatStore.getState().toggleSessionPinned(session.id);
    toast.success(pinned ? t("sessionMenu.unpinSuccess") : t("sessionMenu.pinSuccess"));
  };

  const openRename = () => {
    setRenameDraft(session.title);
    setRenameOpen(true);
  };

  const submitRename = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = renameDraft.trim();
    if (!trimmed) return;
    if (trimmed !== session.title) useChatStore.getState().renameSession(session.id, trimmed);
    setRenameOpen(false);
  };

  const openSideChat = () => {
    useShellStore.getState().setDetailPanelOpen(true);
  };

  const archive = () => {
    if (archived) {
      useChatStore.getState().unarchiveSession(session.id);
      toast.success(t("sessionMenu.unarchiveSuccess"));
    } else {
      useChatStore.getState().archiveSession(session.id);
      toast.success(t("sessionMenu.archiveSuccess"));
    }
  };

  const copyTitle = () => {
    void copyMenuText(
      session.title,
      t("sessionMenu.copyTitleSuccess"),
      t("sessionMenu.copyFailed"),
    );
  };

  const copySessionId = () => {
    if (!agentSessionId) {
      toast.error(t("sessionMenu.copySessionIdUnavailable"));
      return;
    }
    void copyMenuText(
      agentSessionId,
      t("sessionMenu.copySessionIdSuccess"),
      t("sessionMenu.copyFailed"),
    );
  };

  const copyConversation = () => {
    const text = formatSessionForClipboard(session);
    void copyMenuText(text, t("sessionMenu.copyConversationSuccess"), t("sessionMenu.copyFailed"));
  };

  const createBranch = () => {
    const latest = session.blocks[session.blocks.length - 1];
    if (!latest) return;
    useChatStore.getState().branchFromBlock(latest.id);
    toast.success(t("sessionMenu.branchCreated"));
  };

  const addScheduledTask = () => {
    const ui = useUIStore.getState();
    ui.closeExtensions();
    ui.closeSettings();
    ui.openSchedule();
    ui.requestScheduleTaskDraft({
      providerId: session.providerId,
      projectPath: session.projectPath ?? null,
      prompt: scheduledPromptFromSession(session),
      title: session.title,
      workspaceId: session.workspaceId,
    });
  };

  const openInNewWindow = () => {
    void openSessionWindow(session.id, "standard", t);
  };

  const openInCompactWindow = () => {
    void openSessionWindow(session.id, "compact", t);
  };

  useEffect(() => {
    if (!renameOpen) return;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renameOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.altKey && !event.shiftKey && key === "p") {
        event.preventDefault();
        togglePinned();
      } else if (event.altKey && !event.shiftKey && key === "r") {
        event.preventDefault();
        openRename();
      } else if (!event.altKey && event.shiftKey && key === "a") {
        event.preventDefault();
        archive();
      } else if (event.altKey && !event.shiftKey && key === "s") {
        event.preventDefault();
        openSideChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <UIRegion id="header.sessionMenu" data={sessionRegionData(session)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-icon-button="true"
            title={t("sessionMenu.more")}
            aria-label={t("sessionMenu.more")}
            className="ui-icon-button data-[state=open]:bg-surface-active data-[state=open]:text-fg h-8 w-8 shrink-0 sm:h-6 sm:w-6 sm:rounded-[7px]"
          >
            <MoreHorizontal size={16} strokeWidth={1.9} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-64">
          <UIRegion id="header.sessionMenu.pin" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={togglePinned}>
              {pinned ? (
                <PinOff size={15} className="text-subtle shrink-0" />
              ) : (
                <Pin size={15} className="text-subtle shrink-0" />
              )}
              <span>{pinned ? t("sessionMenu.unpin") : t("sessionMenu.pin")}</span>
              <DropdownMenuShortcut>⌥⌘P</DropdownMenuShortcut>
            </DropdownMenuItem>
          </UIRegion>
          <UIRegion id="header.sessionMenu.rename" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={openRename}>
              <Pencil size={15} className="text-subtle shrink-0" />
              <span>{t("sessionMenu.rename")}</span>
              <DropdownMenuShortcut>⌥⌘R</DropdownMenuShortcut>
            </DropdownMenuItem>
          </UIRegion>
          <UIRegion id="header.sessionMenu.archive" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={archive}>
              <Archive size={15} className="text-subtle shrink-0" />
              <span>{archived ? t("sessionMenu.unarchive") : t("sessionMenu.archive")}</span>
              <DropdownMenuShortcut>⇧⌘A</DropdownMenuShortcut>
            </DropdownMenuItem>
          </UIRegion>

          <DropdownMenuSeparator />

          <UIRegion id="header.sessionMenu.openSideChat" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={openSideChat}>
              <PanelRightOpen size={15} className="text-subtle shrink-0" />
              <span>{t("sessionMenu.openSideChat")}</span>
              <DropdownMenuShortcut>⌥⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
          </UIRegion>
          <UIRegion id="header.sessionMenu.copy" data={sessionRegionData(session)}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Copy size={15} className="text-subtle mr-2 shrink-0" />
                <span>{t("sessionMenu.copy")}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuItem onSelect={copyTitle}>
                  {t("sessionMenu.copyTitle")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!agentSessionId} onSelect={copySessionId}>
                  {t("sessionMenu.copySessionId")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={copyConversation}>
                  {t("sessionMenu.copyConversation")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </UIRegion>
          <UIRegion id="header.sessionMenu.branch" data={sessionRegionData(session)}>
            <DropdownMenuItem disabled={branchDisabled} onSelect={createBranch}>
              <GitBranch size={15} className="text-subtle shrink-0" />
              <span>{t("sessionMenu.createBranch")}</span>
            </DropdownMenuItem>
          </UIRegion>
          <UIRegion id="header.sessionMenu.schedule" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={addScheduledTask}>
              <CalendarClock size={15} className="text-subtle shrink-0" />
              <span>{t("sessionMenu.addScheduledTask")}</span>
            </DropdownMenuItem>
          </UIRegion>

          <DropdownMenuSeparator />

          <UIRegion id="header.sessionMenu.openCompactWindow" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={openInCompactWindow}>
              <PictureInPicture2 size={15} className="text-subtle shrink-0" />
              <span>{t("sessionMenu.openInCompactWindow")}</span>
            </DropdownMenuItem>
          </UIRegion>
          <UIRegion id="header.sessionMenu.openWindow" data={sessionRegionData(session)}>
            <DropdownMenuItem onSelect={openInNewWindow}>
              <ExternalLink size={15} className="text-subtle shrink-0" />
              <span>{t("sessionMenu.openInNewWindow")}</span>
            </DropdownMenuItem>
          </UIRegion>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <form onSubmit={submitRename} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("sessionMenu.renamePrompt")}</DialogTitle>
              <DialogDescription>{session.title}</DialogDescription>
            </DialogHeader>
            <input
              ref={renameInputRef}
              autoFocus
              aria-label={t("sessionMenu.renamePrompt")}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              className="border-border-strong bg-surface text-fg w-full rounded-md border px-3 py-2 text-[13px]"
            />
            <DialogFooter>
              <DialogClose type="button" className="ui-button text-[13px]">
                {t("common.cancel")}
              </DialogClose>
              <button type="submit" className="ui-button ui-button-primary text-[13px]">
                {t("common.save")}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </UIRegion>
  );
}

function sessionRegionData(session: Session) {
  return {
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      pinned: Boolean(session.pinnedAt),
      archived: Boolean(session.archivedAt),
      blockCount: session.blocks.length,
      providerId: session.providerId,
      projectPath: session.projectPath ?? null,
    },
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input,textarea,select,[contenteditable='true']"));
}

async function openSessionWindow(sessionId: string, mode: "standard" | "compact", t: TranslateFn) {
  const api = desktopApi();
  try {
    if (api?.window?.openSession) {
      const opened = await api.window.openSession({ sessionId, mode });
      if (!opened) throw new Error("Window creation failed.");
    } else {
      const url = new URL(window.location.href);
      url.searchParams.set("sessionId", sessionId);
      if (mode === "compact") url.searchParams.set("windowMode", "compact");
      else url.searchParams.delete("windowMode");
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    }
    toast.success(
      t(mode === "compact" ? "sessionMenu.compactWindowOpened" : "sessionMenu.newWindowOpened"),
    );
  } catch (error) {
    toast.error(
      t(mode === "compact" ? "sessionMenu.compactWindowFailed" : "sessionMenu.newWindowFailed"),
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function copyMenuText(text: string, successMessage: string, errorMessage: string) {
  try {
    await copyTextToClipboard(text);
    toast.success(successMessage);
  } catch {
    toast.error(errorMessage);
  }
}

function agentSessionIdFromSession(session: Session): string {
  return session.providerSessionId || providerSessionIdFromExtensionState(session);
}

function providerSessionIdFromExtensionState(session: Session): string {
  const state = recordPayload(session.extensionState?.session);
  return (
    stringPayload(state.providerSessionId) ||
    stringPayload(state.provider_session_id) ||
    stringPayload(state.sessionId) ||
    stringPayload(state.session_id) ||
    stringPayload(state.threadId) ||
    stringPayload(state.thread_id)
  );
}

function scheduledPromptFromSession(session: Session): string {
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    const block = session.blocks[index];
    if (block.kind === "user" && block.text.trim()) return block.text.trim();
  }
  return session.title;
}

function formatSessionForClipboard(session: Session): string {
  const parts = session.blocks
    .map(formatBlockForClipboard)
    .filter((part): part is string => Boolean(part));
  return [`# ${session.title}`, ...parts].join("\n\n");
}

function formatBlockForClipboard(block: ChatBlock): string | null {
  switch (block.kind) {
    case "user":
      return `User:\n${block.text}`;
    case "assistant":
      return `Assistant:\n${block.text}`;
    case "reasoning":
      return block.text.trim() ? `Reasoning:\n${block.text}` : null;
    case "tool":
      return `${block.title}:\n${block.output}`;
    case "terminal":
      return `$ ${block.command}\n${block.output}`;
    case "diff":
      return `Diff: ${block.path}`;
    case "plan":
      return block.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n");
    case "image":
      return block.prompt ? `Image: ${block.prompt}` : null;
    case "resource":
    case "artifact":
      return [block.title, block.name, block.uri, block.path, block.content]
        .filter(Boolean)
        .join("\n");
    case "raw":
      return [block.label, formatUnknown(block.value)].filter(Boolean).join("\n");
    case "error":
      return `Error:\n${block.message}`;
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
