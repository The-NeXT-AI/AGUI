import type {
  AppExtensionPermission,
  AppExtensionRecord,
  ExtensionChatRendererContribution,
  ExtensionFloatingWidgetContribution,
  ExtensionToolbarControlContribution,
  ExtensionUiRenderMode,
  ExtensionViewContribution,
} from "@/asp/desktop-api";

export type ExtensionRenderSurface =
  "chat" | "composer" | "configuration" | "detail-panel" | "floating-widget" | "header" | "sidebar";

export type ExtensionSlotContribution =
  | ExtensionChatRendererContribution
  | ExtensionFloatingWidgetContribution
  | ExtensionToolbarControlContribution
  | (ExtensionViewContribution & { activationEvent?: string });

export type ExtensionRenderIsolation =
  "host-declarative" | "sandboxed-web-component" | "sandboxed-webview";

export type ExtensionRenderPlan = {
  allowed: boolean;
  mode: ExtensionUiRenderMode;
  isolation: ExtensionRenderIsolation;
  allowNetwork: boolean;
  activationEvent: string;
  reason?: string;
};

export function extensionRenderPlan(
  record: AppExtensionRecord,
  contribution: ExtensionSlotContribution,
  surface: ExtensionRenderSurface,
): ExtensionRenderPlan {
  const mode = extensionRenderMode(contribution);
  const isolation = renderIsolation(mode);
  const activationEvent = extensionActivationEvent(contribution, surface);
  const allowNetwork = hasPermission(record, "network");
  const denied = renderDenialReason(record, contribution, surface, mode);
  return {
    allowed: !denied,
    mode,
    isolation,
    allowNetwork,
    activationEvent,
    reason: denied,
  };
}

export function canRegisterExtensionContribution(
  record: AppExtensionRecord,
  contribution: ExtensionSlotContribution,
  surface: ExtensionRenderSurface,
): boolean {
  return extensionRenderPlan(record, contribution, surface).allowed;
}

export function canUseGlobalExtensionContribution(record: AppExtensionRecord): boolean {
  return record.source === "builtin" || !isUntrustedLimitedWorkspace(record);
}

export function isUntrustedLimitedWorkspace(record: AppExtensionRecord): boolean {
  return (
    record.source === "workspace" &&
    !record.workspaceTrusted &&
    record.manifest.capabilities?.untrustedWorkspaces?.supported === "limited"
  );
}

export function extensionRenderMode(
  contribution: ExtensionSlotContribution,
): ExtensionUiRenderMode {
  const raw =
    "renderMode" in contribution && contribution.renderMode
      ? contribution.renderMode
      : "viewType" in contribution && contribution.viewType
        ? contribution.viewType
        : "web-component";
  return raw === "declarative" || raw === "webview" || raw === "web-component"
    ? raw
    : "web-component";
}

export function extensionActivationEvent(
  contribution: ExtensionSlotContribution,
  surface: ExtensionRenderSurface,
): string {
  const explicitActivationEvent = (contribution as { activationEvent?: unknown }).activationEvent;
  if (typeof explicitActivationEvent === "string") return explicitActivationEvent;
  if (surface === "configuration") return `onConfiguration:${contribution.id}`;
  if (surface === "detail-panel" || surface === "sidebar") return `onView:${contribution.id}`;
  if (surface === "floating-widget") return `onFloatingWidget:${contribution.id}`;
  if (surface === "chat") return `onChatRenderer:${contribution.id}`;
  return `on${surface[0]!.toUpperCase()}${surface.slice(1).replace("-", "")}:${contribution.id}`;
}

function renderDenialReason(
  record: AppExtensionRecord,
  contribution: ExtensionSlotContribution,
  surface: ExtensionRenderSurface,
  mode: ExtensionUiRenderMode,
): string {
  if (record.source === "builtin") return "";
  const surfacePermission = surfacePermissionFor(surface);
  if (surfacePermission && !hasPermission(record, surfacePermission)) {
    return `Extension UI surface requires permission: ${surfacePermission}`;
  }
  const modePermission = modePermissionFor(mode);
  if (modePermission && !hasPermission(record, modePermission)) {
    return `Extension render mode requires permission: ${modePermission}`;
  }
  if (mode === "web-component") {
    if (record.source === "workspace" && !record.workspaceTrusted) {
      return "Trust this workspace before running Web Component extension UI.";
    }
  }
  if (extensionRenderMode(contribution) === "declarative" && !entryPath(contribution)) {
    return "Declarative extension UI requires a JSON entry asset.";
  }
  return "";
}

function surfacePermissionFor(surface: ExtensionRenderSurface): AppExtensionPermission | null {
  if (surface === "chat") return "ui.chatRenderer";
  if (surface === "composer") return "ui.composer";
  if (surface === "detail-panel") return "ui.detailPanel";
  if (surface === "floating-widget") return "ui.floatingWidget";
  if (surface === "header") return "ui.header";
  if (surface === "sidebar") return "ui.sidebar";
  return null;
}

function modePermissionFor(mode: ExtensionUiRenderMode): AppExtensionPermission | null {
  if (mode === "declarative") return "ui.render.declarative";
  if (mode === "web-component") return "ui.webComponent.trusted";
  if (mode === "webview") return "ui.webview";
  return null;
}

function renderIsolation(mode: ExtensionUiRenderMode): ExtensionRenderIsolation {
  if (mode === "declarative") return "host-declarative";
  if (mode === "webview") return "sandboxed-webview";
  return "sandboxed-web-component";
}

function hasPermission(record: AppExtensionRecord, permission: AppExtensionPermission): boolean {
  return record.source === "builtin" || record.grantedPermissions.includes(permission);
}

function entryPath(contribution: ExtensionSlotContribution): string {
  return typeof contribution.entry === "string" ? contribution.entry : "";
}
