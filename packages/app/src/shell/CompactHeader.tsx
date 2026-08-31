import { useEffect, useState } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { desktopApi, type DesktopWindowState } from "@/asp/desktop-api";
import { useChatStore } from "@/chat/chat-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/ui/cn";
import { toast } from "@/ui/toast";

const INITIAL_STATE: DesktopWindowState = {
  isFullScreen: false,
  mode: "compact",
  pinned: false,
};

export function CompactHeader() {
  const t = useT();
  const session = useChatStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const [windowState, setWindowState] = useState<DesktopWindowState>(() => ({
    ...INITIAL_STATE,
    pinned: document.documentElement.dataset.windowPinned === "true",
  }));
  const [pinPending, setPinPending] = useState(false);

  useEffect(() => {
    const api = desktopApi()?.window;
    if (!api) return undefined;
    let active = true;
    void api
      .state()
      .then((state) => {
        if (active && state.mode === "compact") setWindowState(state);
      })
      .catch(() => undefined);
    const unsubscribe = api.onState((state) => {
      if (state.mode === "compact") setWindowState(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const togglePinned = async () => {
    const api = desktopApi()?.window;
    if (!api?.setPinned || pinPending) return;
    setPinPending(true);
    try {
      const state = await api.setPinned(!windowState.pinned);
      setWindowState(state);
      toast.success(state.pinned ? t("compactWindow.pinSuccess") : t("compactWindow.unpinSuccess"));
    } catch (error) {
      toast.error(
        t("compactWindow.pinFailed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPinPending(false);
    }
  };

  const closeWindow = () => {
    const api = desktopApi()?.window;
    if (api?.close) void api.close();
    else window.close();
  };

  const pinned = windowState.pinned;

  return (
    <header
      data-pinned={pinned ? "true" : undefined}
      className={cn(
        "compact-window-titlebar border-border-subtle flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b px-2.5 select-none",
        !pinned && "electron-drag-region",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            session?.status === "streaming" ? "bg-success animate-pulse" : "bg-fg/30",
          )}
        />
        <span className="text-muted min-w-0 truncate text-[12.5px] font-medium">
          {session?.title || t("compactWindow.title")}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? t("compactWindow.unpin") : t("compactWindow.pin")}
          title={pinned ? t("compactWindow.unpin") : t("compactWindow.pin")}
          disabled={pinPending}
          onClick={() => void togglePinned()}
          className="ui-icon-button h-7 w-7 rounded-[7px]"
        >
          {pinned ? <PinOff size={14} strokeWidth={2} /> : <Pin size={14} strokeWidth={2} />}
        </button>
        <button
          type="button"
          aria-label={t("compactWindow.close")}
          title={t("compactWindow.close")}
          onClick={closeWindow}
          className="ui-icon-button compact-window-close h-7 w-7 rounded-[7px]"
        >
          <X size={15} strokeWidth={1.9} />
        </button>
      </div>
    </header>
  );
}
