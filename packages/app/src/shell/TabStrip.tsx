import { useMemo } from "react";
import { X } from "lucide-react";
import { chatWorkspaceId, useChatStore } from "@/chat/chat-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/ui/cn";
import type { Session } from "@/chat/types";
import { useWorkspaceStore } from "@/workspaces/workspace-store";

type TabSession = Pick<Session, "id" | "title">;

/**
 * The multi-tab strip across the top of the main area (AGUI
 * `app-shell-tab-strip`). When more than one session is open each gets a tab;
 * with a single session the strip is hidden to keep the layout minimal.
 */
export function TabStrip() {
  const t = useT();
  const activeWorkspaceId = useWorkspaceStore((s) => chatWorkspaceId(s.activeWorkspaceId));
  const openTabs = useChatStore((s) => s.openTabs);
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const openSession = useChatStore((s) => s.openSession);
  const closeTab = useChatStore((s) => s.closeTab);
  const tabs = useMemo(
    () => selectOpenTabSessions(activeWorkspaceId, openTabs, sessions),
    [activeWorkspaceId, openTabs, sessions],
  );

  if (tabs.length <= 1) return null;

  return (
    <div className="border-border-subtle bg-sidebar flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
      {tabs.map((s) => {
        const active = s.id === activeId;
        return (
          <div
            key={s.id}
            onClick={() => openSession(s.id)}
            className={cn(
              "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors",
              active ? "bg-surface text-fg" : "text-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            <span className="max-w-[140px] truncate">{s.title}</span>
            <button
              type="button"
              title={t("tab.close")}
              aria-label={t("tab.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(s.id);
              }}
              className="text-subtle hover:text-fg flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function selectOpenTabSessions(
  workspaceId: string,
  openTabs: string[],
  sessions: Session[],
): TabSession[] {
  return openTabs
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is Session => {
      if (!session) return false;
      return chatWorkspaceId(session.workspaceId) === workspaceId;
    })
    .map((session) => ({ id: session.id, title: session.title }));
}
