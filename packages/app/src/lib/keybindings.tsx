import { useEffect } from "react";
import { useRegistryStore } from "@agui/app";

/**
 * Global keybinding engine. Every registered command with a `keybinding` is
 * bound to a real `window` keydown listener (so `⌘B`, `⌘J`, … actually fire,
 * not just display in the palette). Bindings are read live from the registry
 * inside the handler, so commands registered after mount are picked up.
 *
 * Only combos that include a modifier (⌘/Ctrl) are matched, so ordinary typing
 * in inputs is never intercepted.
 */

/** Normalize a key event into a canonical combo string, e.g. "mod+shift+p". */
function eventCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

/** Normalize a binding string like "⌘Shift+P" / "Ctrl+S" into the same form. */
function bindingCombo(binding: string): string {
  const normalized = binding
    .toLowerCase()
    .replace(/⌘/g, "cmd+")
    .replace(/⌃/g, "ctrl+")
    .replace(/⇧/g, "shift+")
    .replace(/⌥/g, "alt+");
  const parts = normalized
    .split(/[+\s]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const combo: string[] = [];
  let mod = false;
  for (const p of parts) {
    if (p === "⌘" || p === "cmd" || p === "meta" || p === "ctrl" || p === "control") {
      mod = true;
    } else if (p === "shift") {
      combo.push("shift");
    } else if (p === "alt" || p === "opt" || p === "option" || p === "⌥") {
      combo.push("alt");
    } else {
      combo.push(p === "escape" ? "escape" : p);
    }
  }
  if (mod) combo.unshift("mod");
  return combo.join("+");
}

export function KeyBindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only modifier combos are ever bound — bail for bare keys.
      if (!e.metaKey && !e.ctrlKey) return;
      const combo = eventCombo(e);
      const commands = useRegistryStore.getState().commands;
      for (const cmd of Object.values(commands)) {
        if (cmd.keybinding && bindingCombo(cmd.keybinding) === combo) {
          e.preventDefault();
          cmd.handler();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}
