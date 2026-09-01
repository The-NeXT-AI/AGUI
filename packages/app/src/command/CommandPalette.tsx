import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
// ⌘K is bound globally by the KeyBindings engine (commandPalette.open command).
import { Search, SquareTerminal, X } from "lucide-react";
import { useCommands, useRegistryStore } from "@the-next-ai/app";
import { useUIStore } from "@/ui/ui-store";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

const BUILTIN_COMMAND_TRANSLATIONS: Record<string, { title: string; category?: string }> = {
  "chat.newSession": { title: "command.newSession" },
  "sidebar.toggle": { title: "command.toggleSidebar" },
  "detailPanel.toggle": { title: "command.toggleDetailPanel" },
  "sidePanel.terminal": { title: "command.openTerminal", category: "command.category.sidePanel" },
  "sidePanel.browser": { title: "command.openBrowser", category: "command.category.sidePanel" },
  "sidePanel.ide": { title: "command.openEditor", category: "command.category.sidePanel" },
  "sidePanel.tasksTests": {
    title: "command.openTasksTests",
    category: "command.category.sidePanel",
  },
  "find.toggle": { title: "command.findConversation" },
  searchChats: { title: "command.searchConversations" },
  "settings.open": { title: "command.openSettings" },
  "theme.toggle": { title: "command.toggleTheme" },
};

/**
 * VSCode-style command palette (⌘K / Ctrl+K). Lists every non-hidden command
 * registered by extensions, fuzzy-filters by title, and is fully keyboard
 * driven (↑↓ to move, Enter to run, Esc to close).
 */
export function CommandPalette() {
  const t = useT();
  const open = useUIStore((s) => s.paletteOpen);
  const close = useUIStore((s) => s.closePalette);
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const list = useMemo(() => {
    const all = Object.values(commands)
      .filter((c) => !c.hidden)
      .map((command) => {
        const translation = BUILTIN_COMMAND_TRANSLATIONS[command.id];
        return translation
          ? {
              ...command,
              title: t(translation.title),
              category: translation.category ? t(translation.category) : command.category,
            }
          : command;
      });
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => `${c.title} ${c.category ?? ""}`.toLowerCase().includes(q));
  }, [commands, query, t]);

  if (!open) return null;

  const run = (id: string) => {
    const cmd = useRegistryStore.getState().commands[id];
    cmd?.handler();
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = list[active];
      if (cmd) run(cmd.id);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogContent showClose={false} className="max-w-xl overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("commandPalette.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("commandPalette.description")}</DialogDescription>
        <div className="border-border-subtle focus-within:border-border-strong flex items-center gap-2 border-b px-3 transition-colors">
          <Search size={15} className="text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-label={t("commandPalette.placeholder")}
            aria-controls="command-palette-results"
            aria-expanded="true"
            aria-activedescendant={list[active] ? `command-option-${list[active].id}` : undefined}
            placeholder={t("commandPalette.placeholder")}
            className="text-fg placeholder:text-subtle h-11 flex-1 bg-transparent text-[13.5px] focus:outline-none"
          />
          <kbd className="text-subtle text-[11px]">Esc</kbd>
          <button
            type="button"
            onClick={close}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="ui-icon-button h-7 w-7 rounded-md"
          >
            <X size={14} />
          </button>
        </div>
        <ul id="command-palette-results" role="listbox" className="max-h-80 overflow-auto py-1">
          {list.length === 0 ? (
            <li role="status" className="text-subtle px-4 py-6 text-center text-[13px]">
              {t("commandPalette.noMatches")}
            </li>
          ) : null}
          {list.map((cmd, i) => {
            const Icon = cmd.icon ?? SquareTerminal;
            return (
              <li key={cmd.id} role="none">
                <button
                  id={`command-option-${cmd.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(cmd.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px]",
                    i === active ? "bg-surface-active text-fg" : "text-fg",
                  )}
                >
                  <Icon size={14} className="text-subtle shrink-0" />
                  <span className="flex-1">{cmd.title}</span>
                  {cmd.category ? (
                    <span className="text-subtle text-[11px]">{cmd.category}</span>
                  ) : null}
                  {cmd.keybinding ? (
                    <kbd className="text-subtle text-[11px]">{cmd.keybinding}</kbd>
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
