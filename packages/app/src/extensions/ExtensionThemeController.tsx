import { useEffect } from "react";
import type { ExtensionThemeDefinition } from "@/asp/desktop-api";
import { useUIStore } from "@/ui/ui-store";
import { readExtensionAsset, useExtensionStore } from "./extension-store";
import { canUseGlobalExtensionContribution } from "./extension-broker";

const COLOR_VARIABLES: Record<string, string> = {
  canvas: "--bg-canvas",
  surface: "--bg-surface",
  surfaceHover: "--bg-surface-hover",
  surfaceActive: "--bg-surface-active",
  elevated: "--bg-elevated",
  sidebar: "--bg-sidebar",
  input: "--bg-input",
  foreground: "--fg-primary",
  mutedForeground: "--fg-secondary",
  subtleForeground: "--fg-tertiary",
  border: "--border-default",
  borderSubtle: "--border-subtle",
  borderStrong: "--border-strong",
  accent: "--accent",
  accentForeground: "--accent-fg",
  accentMuted: "--accent-muted",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  info: "--info",
  selection: "--selection-bg",
  codeBackground: "--code-bg",
  scrollbar: "--scrollbar",
  scrollbarHover: "--scrollbar-hover",
  scrollbarActive: "--scrollbar-active",
};

const TERMINAL_VARIABLES: Record<string, string> = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  selectionBackground: "--terminal-selection",
  black: "--ansi-black",
  red: "--ansi-red",
  green: "--ansi-green",
  yellow: "--ansi-yellow",
  blue: "--ansi-blue",
  magenta: "--ansi-magenta",
  cyan: "--ansi-cyan",
  white: "--ansi-white",
  brightBlack: "--ansi-bright-black",
  brightRed: "--ansi-bright-red",
  brightGreen: "--ansi-bright-green",
  brightYellow: "--ansi-bright-yellow",
  brightBlue: "--ansi-bright-blue",
  brightMagenta: "--ansi-bright-magenta",
  brightCyan: "--ansi-bright-cyan",
  brightWhite: "--ansi-bright-white",
};

let appliedVariables: string[] = [];

export function ExtensionThemeController() {
  const themeId = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const records = useExtensionStore((state) => state.records);
  const loading = useExtensionStore((state) => state.loading);

  useEffect(() => {
    let canceled = false;
    if (themeId === "dark" || themeId === "light") {
      clearExtensionTheme();
      applyBaseTheme(themeId);
      return undefined;
    }
    if (themeId === "system") {
      clearExtensionTheme();
      const query = window.matchMedia("(prefers-color-scheme: light)");
      const apply = () => applyBaseTheme(query.matches ? "light" : "dark", "system");
      apply();
      query.addEventListener("change", apply);
      return () => query.removeEventListener("change", apply);
    }
    if (loading) return undefined;
    const owner = records.find(
      (record) =>
        record.enabled &&
        record.state !== "blocked" &&
        canUseGlobalExtensionContribution(record) &&
        record.manifest.contributes?.themes?.some((theme) => theme.id === themeId),
    );
    const contribution = owner?.manifest.contributes?.themes?.find((theme) => theme.id === themeId);
    if (!owner || !contribution) {
      clearExtensionTheme();
      setTheme("dark");
      return undefined;
    }
    void readExtensionAsset(owner.id, contribution.path)
      .then((asset) => {
        if (asset.encoding !== "utf8") throw new Error("Theme definition must be JSON text.");
        const definition = sanitizeThemeDefinition(JSON.parse(asset.data));
        if (!canceled) applyExtensionTheme(themeId, contribution.type, definition);
      })
      .catch(() => {
        if (!canceled) setTheme("dark");
      });
    return () => {
      canceled = true;
    };
  }, [loading, records, setTheme, themeId]);

  return null;
}

function applyBaseTheme(theme: "dark" | "light", id: string = theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeId = id;
  dispatchThemeChanged(id, theme, undefined);
}

function applyExtensionTheme(
  id: string,
  fallbackType: "dark" | "light",
  definition: ExtensionThemeDefinition,
): void {
  clearExtensionTheme();
  const type =
    definition.type === "dark" || definition.type === "light" ? definition.type : fallbackType;
  document.documentElement.dataset.theme = type;
  document.documentElement.dataset.themeId = id;
  for (const [key, value] of Object.entries(definition.colors ?? {})) {
    const variable = COLOR_VARIABLES[key];
    if (!variable || !validThemeValue(value)) continue;
    document.documentElement.style.setProperty(variable, value.trim());
    appliedVariables.push(variable);
  }
  for (const [key, value] of Object.entries(definition.terminal ?? {})) {
    const variable = TERMINAL_VARIABLES[key];
    if (!variable || !validThemeValue(value)) continue;
    document.documentElement.style.setProperty(variable, value.trim());
    appliedVariables.push(variable);
  }
  dispatchThemeChanged(id, type, definition);
}

function clearExtensionTheme(): void {
  for (const variable of appliedVariables) document.documentElement.style.removeProperty(variable);
  appliedVariables = [];
}

function validThemeValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) return false;
  const candidate = value.trim();
  if (!candidate || /[;{}<>\\]|\b(?:url|var)\s*\(/i.test(candidate)) return false;
  return CSS.supports("color", candidate);
}

function sanitizeThemeDefinition(value: unknown): ExtensionThemeDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Theme definition must be an object.");
  }
  const source = value as Record<string, unknown>;
  const stringRecord = (candidate: unknown, allowed?: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(
        candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {},
      )
        .slice(0, 100)
        .filter(([key, item]) => (!allowed || Boolean(allowed[key])) && validThemeValue(item))
        .map(([key, item]) => [key, String(item).trim()]),
    );
  const monacoSource =
    source.monaco && typeof source.monaco === "object" && !Array.isArray(source.monaco)
      ? (source.monaco as Record<string, unknown>)
      : {};
  const monacoColors = Object.fromEntries(
    Object.entries(
      monacoSource.colors && typeof monacoSource.colors === "object" ? monacoSource.colors : {},
    )
      .slice(0, 100)
      .filter(
        ([key, item]) =>
          /^[a-zA-Z0-9._-]{1,100}$/.test(key) &&
          typeof item === "string" &&
          /^#[0-9a-fA-F]{3,8}$/.test(item.trim()),
      )
      .map(([key, item]) => [key, String(item).trim()]),
  );
  const monacoRules = Array.isArray(monacoSource.rules)
    ? monacoSource.rules
        .slice(0, 200)
        .map(sanitizeMonacoRule)
        .filter((rule): rule is Record<string, unknown> => Boolean(rule))
    : [];
  const base = ["vs", "vs-dark", "hc-black", "hc-light"].includes(String(monacoSource.base))
    ? (monacoSource.base as NonNullable<ExtensionThemeDefinition["monaco"]>["base"])
    : undefined;
  return {
    type: source.type === "light" || source.type === "dark" ? source.type : undefined,
    colors: stringRecord(source.colors, COLOR_VARIABLES),
    terminal: stringRecord(source.terminal, TERMINAL_VARIABLES),
    monaco:
      Object.keys(monacoColors).length || base || monacoRules.length
        ? { base, colors: monacoColors, rules: monacoRules }
        : undefined,
  };
}

function sanitizeMonacoRule(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.token !== "string" ||
    source.token.length > 100 ||
    !/^[a-zA-Z0-9._:-]*$/.test(source.token)
  ) {
    return null;
  }
  const rule: Record<string, unknown> = { token: source.token };
  const foreground = sanitizeMonacoRuleColor(source.foreground);
  const background = sanitizeMonacoRuleColor(source.background);
  const fontStyle = sanitizeMonacoFontStyle(source.fontStyle);
  if (foreground) rule.foreground = foreground;
  if (background) rule.background = background;
  if (fontStyle !== undefined) rule.fontStyle = fontStyle;
  return Object.keys(rule).length > 1 || source.token === "" ? rule : null;
}

function sanitizeMonacoRuleColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(candidate) ? candidate : undefined;
}

function sanitizeMonacoFontStyle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (candidate === "") return "";
  const allowed = new Set(["italic", "bold", "underline", "strikethrough"]);
  const parts = candidate.split(/\s+/);
  if (parts.length > 4 || !parts.every((part) => allowed.has(part))) return undefined;
  return [...new Set(parts)].join(" ");
}

function dispatchThemeChanged(
  id: string,
  type: "dark" | "light",
  definition: ExtensionThemeDefinition | undefined,
): void {
  window.__AGUI_CURRENT_THEME__ = { id, type, definition };
  window.dispatchEvent(
    new CustomEvent("agui-theme-changed", {
      detail: { id, type, definition },
    }),
  );
}
