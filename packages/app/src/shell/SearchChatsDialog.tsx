import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { chatWorkspaceId, useChatStore } from "@/chat/chat-store";
import { useUIStore } from "@/ui/ui-store";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";
import { useAspStore } from "@/asp/asp-store";
import { AgentLogo } from "@/asp/AgentLogo";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { useWorkspaceStore } from "@/workspaces/workspace-store";

/**
 * The "search chats" dialog — the AGUI `codex.command.searchChats` surface.
 * A centered, command-palette-styled modal that filters session titles. Trigger
 * it from the sidebar search button or the command palette. Enter opens, Esc
 * closes, ↑↓ navigates.
 */
export function SearchChatsDialog() {
  const t = useT();
  const open = useUIStore((s) => s.searchChatsOpen);
  const close = useUIStore((s) => s.setSearchChatsOpen);
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const openSession = useChatStore((s) => s.openSession);
  const providers = useAspStore((s) => s.providers);
  const activeWorkspaceId = useWorkspaceStore((s) => chatWorkspaceId(s.activeWorkspaceId));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const list = useMemo(() => {
    const sorted = sessions
      .filter((session) => chatWorkspaceId(session.workspaceId) === activeWorkspaceId)
      .sort(
        (a, b) =>
          Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
          (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) ||
          b.createdAt - a.createdAt,
      );
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((s) => s.title.toLowerCase().includes(q)) : sorted;
  }, [activeWorkspaceId, sessions, query]);

  useEffect(() => setActive(0), [activeWorkspaceId, query]);

  if (!open) return null;

  const choose = (id: string) => {
    openSession(id);
    close(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      close(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = list[active];
      if (s) choose(s.id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => close(nextOpen)}>
      <DialogContent showClose={false} className="max-w-xl overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("searchChats.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("searchChats.description")}</DialogDescription>
        <div className="border-border-subtle focus-within:border-border-strong flex items-center gap-2 border-b px-3 transition-colors">
          <Search size={15} className="text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-label={t("searchChats.placeholder")}
            aria-controls="search-chat-results"
            aria-expanded="true"
            aria-activedescendant={
              list[active] ? `search-chat-option-${list[active].id}` : undefined
            }
            placeholder={t("searchChats.placeholder")}
            className="text-fg placeholder:text-subtle h-11 flex-1 bg-transparent text-[13.5px] focus:outline-none"
          />
          <kbd className="text-subtle text-[11px]">Esc</kbd>
          <button
            type="button"
            onClick={() => close(false)}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="ui-icon-button h-7 w-7 rounded-md"
          >
            <X size={14} />
          </button>
        </div>
        <ul id="search-chat-results" role="listbox" className="max-h-80 overflow-auto py-1">
          {list.length === 0 ? (
            <li role="status" className="text-subtle px-4 py-6 text-center text-[13px]">
              {t("searchChats.noMatches")}
            </li>
          ) : null}
          {list.map((s, i) => {
            const provider = providerById.get(s.providerId);
            return (
              <li key={s.id} role="none">
                <button
                  id={`search-chat-option-${s.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px]",
                    i === active ? "bg-surface-active text-fg" : "text-fg",
                  )}
                >
                  <AgentLogo provider={provider} compact className="h-4 w-4" />
                  <span className="flex-1 truncate">{s.title}</span>
                  {s.id === activeId ? (
                    <span className="text-subtle text-[11px]">{t("searchChats.current")}</span>
                  ) : null}
                  {s.archivedAt ? (
                    <span className="text-subtle text-[11px]">{t("searchChats.archived")}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
