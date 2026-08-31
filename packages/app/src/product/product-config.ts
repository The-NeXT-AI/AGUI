import { useSyncExternalStore } from "react";
import type { ApprovalMode } from "@/chat/types";
import type { ExtensionDeclarativeNode } from "@/asp/desktop-api";

export type ProductLanguage = "en" | "zh";
export type ProductTheme = string;
export type ProductRunSpeed = "default" | "fast";
export type ProductUIRenderable = ProductUIFragment | ProductUIFragment[];
export type ProductUIFragment = ProductUIDeclarative | ProductUIWebComponent;

export interface ProductUIDeclarative {
  renderMode: "declarative";
  schema: ExtensionDeclarativeNode;
  allowNetwork?: boolean;
}

export interface ProductUIWebComponent {
  renderMode: "web-component";
  html: string;
  allowNetwork?: boolean;
}

export interface ProductPaneConfig {
  defaultOpen: boolean;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export interface ProductConfig {
  app: {
    name: string;
    displayName: string;
    storageKeyPrefix: string;
  };
  defaults: {
    theme: ProductTheme;
    approvalMode: ApprovalMode;
    model: string;
    effort: string;
    speed: ProductRunSpeed;
    language: ProductLanguage;
  };
  layout: {
    sidebar: ProductPaneConfig;
    detailPanel: ProductPaneConfig;
    minimumMainWidth: number;
  };
  features: {
    extensionsPage: boolean;
    scheduledTasks: boolean;
    settingsPage: boolean;
    themeToggle: boolean;
    sidebarAddConversation: boolean;
  };
  navigation: {
    initialSidebarPanelId: string;
  };
  extensions: {
    defaultPanelIcon: string;
  };
  ui: {
    rootClassName: string;
    bodyClassName: string;
    cssVariables: Record<string, string>;
    customCss: string;
    text: Record<string, string>;
    translations: Partial<Record<ProductLanguage, Record<string, string>>>;
    regions: Record<string, ProductUIRegionConfig>;
  };
}

export interface ProductUIRegionConfig {
  hidden?: boolean;
  className?: string;
  before?: ProductUIRenderable;
  after?: ProductUIRenderable;
  replace?: ProductUIRenderable;
  data?: Record<string, unknown>;
  allowNetwork?: boolean;
}

export type ProductConfigOverride = Partial<{
  app: Partial<ProductConfig["app"]>;
  defaults: Partial<ProductConfig["defaults"]>;
  layout: Partial<{
    sidebar: Partial<ProductPaneConfig>;
    detailPanel: Partial<ProductPaneConfig>;
    minimumMainWidth: number;
  }>;
  features: Partial<ProductConfig["features"]>;
  navigation: Partial<ProductConfig["navigation"]>;
  extensions: Partial<ProductConfig["extensions"]>;
  ui: Partial<{
    rootClassName: string;
    bodyClassName: string;
    cssVariables: Record<string, string>;
    customCss: string;
    text: Record<string, string>;
    translations: Partial<Record<ProductLanguage, Record<string, string>>>;
    regions: Record<string, ProductUIRegionConfig>;
  }>;
}>;

const baseProductConfig: ProductConfig = {
  app: {
    name: envString("VITE_AGUI_PRODUCT_NAME", "AGUI"),
    displayName: envString("VITE_AGUI_PRODUCT_DISPLAY_NAME", "AGUI Desktop"),
    storageKeyPrefix: envString("VITE_AGUI_STORAGE_KEY_PREFIX", "agui"),
  },
  defaults: {
    theme: envString("VITE_AGUI_DEFAULT_THEME", "dark"),
    approvalMode: envApprovalMode("VITE_AGUI_DEFAULT_APPROVAL_MODE", "auto-edit"),
    model: envString("VITE_AGUI_DEFAULT_MODEL", "gpt-5-codex"),
    effort: envString("VITE_AGUI_DEFAULT_EFFORT", "medium"),
    speed: envRunSpeed("VITE_AGUI_DEFAULT_SPEED", "default"),
    language: envLanguage("VITE_AGUI_DEFAULT_LANGUAGE", "en"),
  },
  layout: {
    sidebar: {
      defaultOpen: envBoolean("VITE_AGUI_SIDEBAR_DEFAULT_OPEN", true),
      defaultWidth: envNumber("VITE_AGUI_SIDEBAR_WIDTH", 280),
      minWidth: envNumber("VITE_AGUI_SIDEBAR_MIN_WIDTH", 240),
      maxWidth: envNumber("VITE_AGUI_SIDEBAR_MAX_WIDTH", 480),
    },
    detailPanel: {
      defaultOpen: envBoolean("VITE_AGUI_DETAIL_PANEL_DEFAULT_OPEN", false),
      defaultWidth: envNumber("VITE_AGUI_DETAIL_PANEL_WIDTH", 420),
      minWidth: envNumber("VITE_AGUI_DETAIL_PANEL_MIN_WIDTH", 320),
      maxWidth: envNumber("VITE_AGUI_DETAIL_PANEL_MAX_WIDTH", 720),
    },
    minimumMainWidth: envNumber("VITE_AGUI_MINIMUM_MAIN_WIDTH", 520),
  },
  features: {
    extensionsPage: envBoolean("VITE_AGUI_FEATURE_EXTENSIONS_PAGE", true),
    scheduledTasks: envBoolean("VITE_AGUI_FEATURE_SCHEDULED_TASKS", true),
    settingsPage: envBoolean("VITE_AGUI_FEATURE_SETTINGS_PAGE", true),
    themeToggle: envBoolean("VITE_AGUI_FEATURE_THEME_TOGGLE", true),
    sidebarAddConversation: envBoolean("VITE_AGUI_FEATURE_SIDEBAR_ADD_CONVERSATION", true),
  },
  navigation: {
    initialSidebarPanelId: envString("VITE_AGUI_INITIAL_SIDEBAR_PANEL", "sessions"),
  },
  extensions: {
    defaultPanelIcon: envString("VITE_AGUI_EXTENSION_DEFAULT_PANEL_ICON", "blocks"),
  },
  ui: {
    rootClassName: envString("VITE_AGUI_ROOT_CLASS_NAME", ""),
    bodyClassName: envString("VITE_AGUI_BODY_CLASS_NAME", ""),
    cssVariables: envStringRecord("VITE_AGUI_CSS_VARIABLES_JSON"),
    customCss: envString("VITE_AGUI_CUSTOM_CSS", ""),
    text: envStringRecord("VITE_AGUI_TEXT_OVERRIDES_JSON"),
    translations: envTranslations("VITE_AGUI_TRANSLATIONS_JSON"),
    regions: envRegionRecord("VITE_AGUI_UI_REGIONS_JSON"),
  },
};

const productConfigListeners = new Set<() => void>();
let productConfigOverride = runtimeProductConfig();

export let productConfig: ProductConfig = buildProductConfig();

export function getProductConfig(): ProductConfig {
  return productConfig;
}

export function setProductConfigOverride(override: ProductConfigOverride): ProductConfig {
  productConfigOverride = override;
  productConfig = buildProductConfig();
  emitProductConfigChange();
  return productConfig;
}

export function updateProductConfig(override: ProductConfigOverride): ProductConfig {
  return setProductConfigOverride(mergeProductConfigOverride(productConfigOverride, override));
}

export function subscribeProductConfig(listener: () => void): () => void {
  productConfigListeners.add(listener);
  return () => productConfigListeners.delete(listener);
}

export function useProductConfig(): ProductConfig {
  return useSyncExternalStore(subscribeProductConfig, getProductConfig, getProductConfig);
}

export function clampSidebarWidth(width: number): number {
  return clampPaneWidth(width, productConfig.layout.sidebar);
}

export function clampDetailPanelWidth(width: number): number {
  return clampPaneWidth(width, productConfig.layout.detailPanel);
}

function runtimeProductConfig(): ProductConfigOverride {
  if (typeof window === "undefined") return {};
  return window.__AGUI_PRODUCT_CONFIG__ ?? {};
}

function buildProductConfig(): ProductConfig {
  return normalizeProductConfig(mergeProductConfig(baseProductConfig, productConfigOverride));
}

function emitProductConfigChange(): void {
  for (const listener of productConfigListeners) listener();
}

function mergeProductConfigOverride(
  base: ProductConfigOverride,
  override: ProductConfigOverride,
): ProductConfigOverride {
  return {
    ...base,
    ...override,
    app: { ...base.app, ...override.app },
    defaults: { ...base.defaults, ...override.defaults },
    layout: {
      ...base.layout,
      ...override.layout,
      sidebar: { ...base.layout?.sidebar, ...override.layout?.sidebar },
      detailPanel: { ...base.layout?.detailPanel, ...override.layout?.detailPanel },
    },
    features: { ...base.features, ...override.features },
    navigation: { ...base.navigation, ...override.navigation },
    extensions: { ...base.extensions, ...override.extensions },
    ui: {
      ...base.ui,
      ...override.ui,
      cssVariables: { ...base.ui?.cssVariables, ...override.ui?.cssVariables },
      text: { ...base.ui?.text, ...override.ui?.text },
      translations: mergeTranslations(base.ui?.translations ?? {}, override.ui?.translations),
      regions: { ...base.ui?.regions, ...override.ui?.regions },
    },
  };
}

function mergeProductConfig(config: ProductConfig, override: ProductConfigOverride): ProductConfig {
  return {
    app: { ...config.app, ...override.app },
    defaults: { ...config.defaults, ...override.defaults },
    layout: {
      ...config.layout,
      ...override.layout,
      sidebar: { ...config.layout.sidebar, ...override.layout?.sidebar },
      detailPanel: { ...config.layout.detailPanel, ...override.layout?.detailPanel },
    },
    features: { ...config.features, ...override.features },
    navigation: { ...config.navigation, ...override.navigation },
    extensions: { ...config.extensions, ...override.extensions },
    ui: {
      ...config.ui,
      ...override.ui,
      cssVariables: { ...config.ui.cssVariables, ...override.ui?.cssVariables },
      text: { ...config.ui.text, ...override.ui?.text },
      translations: mergeTranslations(config.ui.translations, override.ui?.translations),
      regions: { ...config.ui.regions, ...override.ui?.regions },
    },
  };
}

function normalizeProductConfig(config: ProductConfig): ProductConfig {
  return {
    ...config,
    app: {
      name: nonEmptyString(config.app.name, "AGUI"),
      displayName: nonEmptyString(config.app.displayName, "AGUI Desktop"),
      storageKeyPrefix: nonEmptyString(config.app.storageKeyPrefix, "agui"),
    },
    defaults: {
      theme: nonEmptyString(config.defaults.theme, "dark"),
      approvalMode: approvalMode(config.defaults.approvalMode, "auto-edit"),
      model: nonEmptyString(config.defaults.model, "gpt-5-codex"),
      effort: nonEmptyString(config.defaults.effort, "medium"),
      speed: runSpeed(config.defaults.speed, "default"),
      language: language(config.defaults.language, "en"),
    },
    layout: {
      sidebar: normalizePane(config.layout.sidebar, {
        defaultOpen: true,
        defaultWidth: 280,
        minWidth: 240,
        maxWidth: 480,
      }),
      detailPanel: normalizePane(config.layout.detailPanel, {
        defaultOpen: false,
        defaultWidth: 420,
        minWidth: 320,
        maxWidth: 720,
      }),
      minimumMainWidth: positiveNumber(config.layout.minimumMainWidth, 520),
    },
    features: {
      extensionsPage: Boolean(config.features.extensionsPage),
      scheduledTasks: Boolean(config.features.scheduledTasks),
      settingsPage: Boolean(config.features.settingsPage),
      themeToggle: Boolean(config.features.themeToggle),
      sidebarAddConversation: Boolean(config.features.sidebarAddConversation),
    },
    navigation: {
      initialSidebarPanelId: nonEmptyString(config.navigation.initialSidebarPanelId, "sessions"),
    },
    extensions: {
      defaultPanelIcon: nonEmptyString(config.extensions.defaultPanelIcon, "blocks"),
    },
    ui: {
      rootClassName: boundedString(config.ui.rootClassName, 4096),
      bodyClassName: boundedString(config.ui.bodyClassName, 4096),
      cssVariables: stringRecord(config.ui.cssVariables),
      customCss: boundedString(config.ui.customCss, 512 * 1024),
      text: stringRecord(config.ui.text),
      translations: {
        en: stringRecord(config.ui.translations.en),
        zh: stringRecord(config.ui.translations.zh),
      },
      regions: regionRecord(config.ui.regions),
    },
  };
}

function normalizePane(pane: ProductPaneConfig, fallback: ProductPaneConfig): ProductPaneConfig {
  const minWidth = positiveNumber(pane.minWidth, fallback.minWidth);
  const maxWidth = Math.max(minWidth, positiveNumber(pane.maxWidth, fallback.maxWidth));
  return {
    defaultOpen: Boolean(pane.defaultOpen),
    minWidth,
    maxWidth,
    defaultWidth: clamp(
      positiveNumber(pane.defaultWidth, fallback.defaultWidth),
      minWidth,
      maxWidth,
    ),
  };
}

function clampPaneWidth(width: number, pane: ProductPaneConfig): number {
  return clamp(width, pane.minWidth, pane.maxWidth);
}

function envString(key: string, fallback: string): string {
  return nonEmptyString(import.meta.env[key], fallback);
}

function envNumber(key: string, fallback: number): number {
  return positiveNumber(Number(import.meta.env[key]), fallback);
}

function envBoolean(key: string, fallback: boolean): boolean {
  const value = String(import.meta.env[key] ?? "")
    .trim()
    .toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function envStringRecord(key: string): Record<string, string> {
  return stringRecord(parseJsonEnv(key));
}

function envTranslations(key: string): Partial<Record<ProductLanguage, Record<string, string>>> {
  const source = recordValue(parseJsonEnv(key));
  return {
    en: stringRecord(source.en),
    zh: stringRecord(source.zh),
  };
}

function envRegionRecord(key: string): Record<string, ProductUIRegionConfig> {
  return regionRecord(parseJsonEnv(key));
}

function envApprovalMode(key: string, fallback: ApprovalMode): ApprovalMode {
  return approvalMode(import.meta.env[key], fallback);
}

function envRunSpeed(key: string, fallback: ProductRunSpeed): ProductRunSpeed {
  return runSpeed(import.meta.env[key], fallback);
}

function envLanguage(key: string, fallback: ProductLanguage): ProductLanguage {
  return language(import.meta.env[key], fallback);
}

function nonEmptyString(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function boundedString(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= limit ? text : text.slice(0, limit);
}

function stringRecord(value: unknown): Record<string, string> {
  const source = recordValue(value);
  return Object.fromEntries(
    Object.entries(source)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, item]) => [boundedString(key, 256), boundedString(item, 64 * 1024)]),
  );
}

function regionRecord(value: unknown): Record<string, ProductUIRegionConfig> {
  const source = recordValue(value);
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, item]) => [boundedString(key, 256), regionConfig(item)] as const)
      .filter(([key]) => Boolean(key)),
  );
}

function regionConfig(value: unknown): ProductUIRegionConfig {
  const source = recordValue(value);
  return {
    hidden: source.hidden === true ? true : undefined,
    className: boundedString(source.className, 4096) || undefined,
    before: renderableValue(source.before),
    after: renderableValue(source.after),
    replace: renderableValue(source.replace),
    data: recordValue(source.data),
    allowNetwork: source.allowNetwork === true ? true : undefined,
  };
}

function renderableValue(value: unknown): ProductUIRenderable | undefined {
  if (value == null || value === false) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 100)
      .map((item) => renderableFragment(item))
      .filter((item): item is ProductUIFragment => item !== undefined);
    return items.length ? items : undefined;
  }
  return renderableFragment(value);
}

function renderableFragment(value: unknown): ProductUIFragment | undefined {
  if (value == null || value === false) return undefined;
  const source = recordValue(value);
  if (source.renderMode === "web-component" && typeof source.html === "string") {
    return {
      renderMode: "web-component",
      html: boundedString(source.html, 256 * 1024),
      allowNetwork: source.allowNetwork === true ? true : undefined,
    };
  }
  if (source.renderMode === "declarative" && source.schema !== undefined) {
    return {
      renderMode: "declarative",
      schema: boundedJsonValue(source.schema, 256 * 1024) as ExtensionDeclarativeNode,
      allowNetwork: source.allowNetwork === true ? true : undefined,
    };
  }
  return undefined;
}

function boundedJsonValue(value: unknown, limit: number): unknown {
  try {
    const json = JSON.stringify(value);
    if (!json || json.length > limit) return null;
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonEnv(key: string): unknown {
  const raw = import.meta.env[key];
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mergeTranslations(
  base: Partial<Record<ProductLanguage, Record<string, string>>>,
  override: Partial<Record<ProductLanguage, Record<string, string>>> | undefined,
): Partial<Record<ProductLanguage, Record<string, string>>> {
  return {
    en: { ...base.en, ...override?.en },
    zh: { ...base.zh, ...override?.zh },
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function approvalMode(value: unknown, fallback: ApprovalMode): ApprovalMode {
  return value === "suggest" || value === "auto-edit" || value === "full-auto" ? value : fallback;
}

function runSpeed(value: unknown, fallback: ProductRunSpeed): ProductRunSpeed {
  return value === "default" || value === "fast" ? value : fallback;
}

function language(value: unknown, fallback: ProductLanguage): ProductLanguage {
  return value === "en" || value === "zh" ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
