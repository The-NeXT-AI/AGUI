export const AGUI_EXTENSION_ENGINE = "0.2.0";

type ParsedSemVer = {
  major: number;
  minor: number;
  patch: number;
  parts: number;
  prerelease?: string[];
};

/**
 * Checks an extension engine range without depending on a package manager at
 * runtime. The supported syntax matches the range forms accepted by extension
 * manifests: exact/partial versions, wildcards, comparators, caret, tilde,
 * hyphen ranges, whitespace intersections, and `||` unions.
 */
export function isExtensionEngineCompatible(
  range: string,
  currentVersion = AGUI_EXTENSION_ENGINE,
): boolean {
  const current = parseSemVer(currentVersion);
  if (!current) return false;
  return range
    .split("||")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .some((candidate) => matchesSemVerIntersection(candidate, current));
}

function matchesSemVerIntersection(range: string, current: ParsedSemVer): boolean {
  if (range === "*" || /^x$/i.test(range)) return true;
  const hyphen = range.match(/^\s*([^\s]+)\s+-\s+([^\s]+)\s*$/);
  if (hyphen) {
    const lower = parseSemVer(hyphen[1]!);
    const upper = parseSemVer(hyphen[2]!);
    return Boolean(
      lower && upper && compareSemVer(current, lower) >= 0 && compareSemVer(current, upper) <= 0,
    );
  }
  const tokens = range.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => matchesSemVerToken(token, current));
}

function matchesSemVerToken(token: string, current: ParsedSemVer): boolean {
  if (token === "*" || /^x$/i.test(token)) return true;
  const operator = token.match(/^(\^|~|>=|<=|>|<|=)?(.*)$/);
  if (!operator) return false;
  const prefix = operator[1] ?? "";
  const rawVersion = operator[2]!;
  const wildcard = parseWildcardVersion(rawVersion);
  if (wildcard) {
    if (prefix && prefix !== "=") return false;
    return (
      current.major === wildcard.major &&
      (wildcard.minor === undefined || current.minor === wildcard.minor) &&
      (wildcard.patch === undefined || current.patch === wildcard.patch)
    );
  }
  const version = parseSemVer(rawVersion);
  if (!version) return false;
  const comparison = compareSemVer(current, version);
  if (prefix === ">=") return comparison >= 0;
  if (prefix === "<=") return comparison <= 0;
  if (prefix === ">") return comparison > 0;
  if (prefix === "<") return comparison < 0;
  if (prefix === "^")
    return comparison >= 0 && compareSemVer(current, caretUpperBound(version)) < 0;
  if (prefix === "~")
    return comparison >= 0 && compareSemVer(current, tildeUpperBound(version)) < 0;
  if (version.parts < 3) {
    const upper =
      version.parts === 1
        ? { major: version.major + 1, minor: 0, patch: 0, parts: 3 }
        : { major: version.major, minor: version.minor + 1, patch: 0, parts: 3 };
    return comparison >= 0 && compareSemVer(current, upper) < 0;
  }
  return comparison === 0;
}

function parseSemVer(value: string): ParsedSemVer | null {
  const match = value
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const parts = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1;
  const version = {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    parts,
    prerelease: match[4]?.split("."),
  };
  return [version.major, version.minor, version.patch, version.parts].every(Number.isSafeInteger)
    ? version
    : null;
}

function parseWildcardVersion(
  value: string,
): { major: number; minor?: number; patch?: number } | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (!match || !/[x*]/i.test(value)) return null;
  if (match[2] === undefined || /[x*]/i.test(match[2])) return { major: Number(match[1]) };
  if (match[3] === undefined || /[x*]/i.test(match[3])) {
    return { major: Number(match[1]), minor: Number(match[2]) };
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  const primary = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (primary) return primary;
  const leftPrerelease = left.prerelease ?? [];
  const rightPrerelease = right.prerelease ?? [];
  if (!leftPrerelease.length || !rightPrerelease.length) {
    return leftPrerelease.length === rightPrerelease.length ? 0 : leftPrerelease.length ? -1 : 1;
  }
  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function caretUpperBound(version: ParsedSemVer): ParsedSemVer {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, parts: 3 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, parts: 3 };
  return { major: 0, minor: 0, patch: version.patch + 1, parts: 3 };
}

function tildeUpperBound(version: ParsedSemVer): ParsedSemVer {
  if (version.parts === 1) return { major: version.major + 1, minor: 0, patch: 0, parts: 3 };
  return { major: version.major, minor: version.minor + 1, patch: 0, parts: 3 };
}

export type AppExtensionSource = "builtin" | "user" | "workspace";
export type AppExtensionState =
  "inactive" | "activating" | "active" | "disabled" | "blocked" | "error";

/**
 * Canonical extension permission registry. Runtime validation, manifest
 * validation, and permission UI derive from this list to prevent drift.
 */
export const APP_EXTENSION_PERMISSIONS = [
  "runtime.fullTrust",
  "ui.render.declarative",
  "ui.sessionTree",
  "ui.sidebar",
  "ui.detailPanel",
  "ui.composer",
  "ui.header",
  "ui.floatingWidget",
  "ui.chatRenderer",
  "ui.webComponent.trusted",
  "ui.webview",
  "ui.styles",
  "ui.overrideBuiltins",
  "theme",
  "commands",
  "agent.skills",
  "agent.mcp",
  "agent.prompts",
  "agent.sessionContext",
  "workspace.read",
  "workspace.write",
  "network",
  "process.spawn",
  "secrets",
] as const;

export type AppExtensionPermission = (typeof APP_EXTENSION_PERMISSIONS)[number];

export type ExtensionKind = "ui" | "workspace";
export type UntrustedWorkspaceSupport = true | false | "limited";
export type ExtensionWhenClause = string;
export type ExtensionUiRenderMode = "declarative" | "web-component" | "webview";

export type ExtensionDeclarativeTone =
  "default" | "muted" | "accent" | "success" | "warning" | "danger";

export type ExtensionDeclarativeNode =
  string | number | boolean | null | ExtensionDeclarativeElement | ExtensionDeclarativeNode[];

export interface ExtensionDeclarativeElement {
  type:
    | "badge"
    | "box"
    | "button"
    | "code"
    | "column"
    | "container"
    | "data"
    | "divider"
    | "image"
    | "kv"
    | "link"
    | "list"
    | "row"
    | "stack"
    | "text";
  text?: string;
  label?: string;
  value?: unknown;
  path?: string;
  fallback?: string;
  tone?: ExtensionDeclarativeTone;
  size?: "xs" | "sm" | "md";
  weight?: "regular" | "medium" | "semibold";
  variant?: "default" | "secondary" | "ghost" | "danger";
  gap?: "none" | "xs" | "sm" | "md";
  padding?: "none" | "xs" | "sm" | "md";
  align?: "start" | "center" | "end";
  wrap?: boolean;
  ordered?: boolean;
  src?: string;
  alt?: string;
  href?: string;
  command?: string;
  args?: unknown[];
  language?: string;
  children?: ExtensionDeclarativeNode[];
  items?: ExtensionDeclarativeNode[];
}

export interface ExtensionIconContribution {
  light?: string;
  dark?: string;
  path?: string;
}

export interface ExtensionToolbarControlContribution {
  id: string;
  title: string;
  align: "left" | "right";
  viewType: ExtensionUiRenderMode;
  entry: string;
  loadingIndicator?: "visible" | "hidden";
  order?: number;
  when?: ExtensionWhenClause;
}

export type ExtensionFloatingWidgetPosition =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface ExtensionFloatingWidgetContribution {
  id: string;
  title: string;
  viewType: ExtensionUiRenderMode;
  entry: string;
  position?: ExtensionFloatingWidgetPosition;
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  loadingIndicator?: "visible" | "hidden";
  order?: number;
  when?: ExtensionWhenClause;
}

export interface ExtensionChatRendererContribution {
  id: string;
  kind?: string | string[];
  renderer?: string | string[];
  mimeType?: string | string[];
  renderMode: ExtensionUiRenderMode;
  entry?: string;
  priority?: number;
  when?: ExtensionWhenClause;
}

export interface ExtensionViewsContainerContribution {
  id: string;
  title: string;
  icon?: string | ExtensionIconContribution;
  allowMultiple?: boolean;
  retainContextWhenHidden?: boolean;
  order?: number;
  when?: ExtensionWhenClause;
}

export interface ExtensionViewsContainersContribution {
  activitybar?: ExtensionViewsContainerContribution[];
  panel?: ExtensionViewsContainerContribution[];
}

export interface ExtensionViewContribution {
  id: string;
  name: string;
  icon?: string | ExtensionIconContribution;
  contextualTitle?: string;
  viewType?: ExtensionUiRenderMode;
  entry: string;
  visibility?: "visible" | "collapsed" | "hidden";
  order?: number;
  when?: ExtensionWhenClause;
}

export interface ExtensionMenuContribution {
  command?: string;
  alt?: string;
  submenu?: string;
  when?: ExtensionWhenClause;
  group?: string;
}

export type ExtensionMenusContribution = Record<string, ExtensionMenuContribution[]>;

export interface ExtensionThemeContribution {
  id: string;
  label: string;
  type: "dark" | "light";
  path: string;
}

export interface ExtensionStyleContribution {
  id: string;
  path: string;
  media?: string;
  order?: number;
  when?: ExtensionWhenClause;
}

export interface ExtensionCommandContribution {
  id?: string;
  command?: string;
  title: string;
  category?: string;
  icon?: string;
  keybinding?: string;
  hidden?: boolean;
  when?: ExtensionWhenClause;
}

export interface ExtensionConfigurationProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  title?: string;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  enumLabels?: Record<string, string>;
  secret?: boolean;
  restricted?: boolean;
}

export interface ExtensionConfigurationViewContribution {
  id: string;
  name?: string;
  viewType?: ExtensionUiRenderMode;
  entry: string;
  activationEvent?: string;
}

export interface ExtensionConfigurationContribution {
  title?: string;
  properties: Record<string, ExtensionConfigurationProperty>;
  view?: ExtensionConfigurationViewContribution;
}

export interface ExtensionPromptContribution {
  id: string;
  title: string;
  description?: string;
  content?: string;
  path?: string;
  autoInclude?: boolean;
}

export interface ExtensionSessionTreeSessionContribution {
  title?: string;
  providerId?: string;
  projectPath?: string | null;
  cwd?: string;
  renderer?: string;
  initialMarkdown?: string;
  developerInstructions?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtensionSessionTreeNodeContribution {
  id: string;
  title: string;
  icon?: string | ExtensionIconContribution;
  kind?: "folder" | "session";
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  cursor?: string;
  loadChildrenCommand?: string;
  loadMoreCommand?: string;
  loadInput?: Record<string, unknown>;
  badge?: string;
  description?: string;
  order?: number;
  children?: ExtensionSessionTreeNodeContribution[];
  session?: ExtensionSessionTreeSessionContribution;
}

export interface ExtensionSessionTreeContribution {
  id: string;
  title: string;
  icon?: string | ExtensionIconContribution;
  order?: number;
  when?: ExtensionWhenClause;
  command?: string;
  children?: ExtensionSessionTreeNodeContribution[];
}

export interface ExtensionContributions {
  viewsContainers?: ExtensionViewsContainersContribution;
  views?: Record<string, ExtensionViewContribution[]>;
  menus?: ExtensionMenusContribution;
  composerControls?: ExtensionToolbarControlContribution[];
  headerControls?: ExtensionToolbarControlContribution[];
  floatingWidgets?: ExtensionFloatingWidgetContribution[];
  chatRenderers?: ExtensionChatRendererContribution[];
  themes?: ExtensionThemeContribution[];
  styles?: ExtensionStyleContribution[];
  commands?: ExtensionCommandContribution[];
  sessionTree?: ExtensionSessionTreeContribution[];
  configuration?: ExtensionConfigurationContribution;
  skills?: string | string[];
  mcpServers?: string | string[] | Record<string, unknown>;
  prompts?: ExtensionPromptContribution[];
}

export interface ExtensionLocalizedContribution {
  title?: string;
  name?: string;
  label?: string;
  displayName?: string;
  description?: string;
  category?: string;
  badge?: string;
  initialMarkdown?: string;
  developerInstructions?: string;
  enumLabels?: Record<string, string>;
}

export interface ExtensionLocalizationBundle {
  displayName?: string;
  description?: string;
  configuration?: {
    title?: string;
    properties?: Record<string, ExtensionLocalizedContribution>;
  };
  contributions?: Record<string, ExtensionLocalizedContribution>;
}

export interface AppExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  description?: string;
  updateUrl?: string;
  localizations?: Record<string, ExtensionLocalizationBundle>;
  license?: string;
  icon?: string;
  engines: {
    agui: string;
  };
  main?: string;
  browser?: string;
  extensionKind?: ExtensionKind[];
  activationEvents?: string[];
  permissions?: AppExtensionPermission[];
  capabilities?: {
    untrustedWorkspaces?: {
      supported: UntrustedWorkspaceSupport;
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
  contributes?: ExtensionContributions;
}

export interface AppExtensionRecord {
  id: string;
  manifest: AppExtensionManifest;
  source: AppExtensionSource;
  extensionPath: string;
  updateUrl?: string;
  updateSha256?: string;
  enabled: boolean;
  security?: AppExtensionSecuritySummary;
  state: AppExtensionState;
  statusMessage?: string;
  grantedPermissions: AppExtensionPermission[];
  workspaceTrusted: boolean;
}

export type AppExtensionSecurityRiskLevel = "low" | "medium" | "high";

export interface AppExtensionSecuritySummary {
  fingerprint?: string;
  hasNetworkAccess: boolean;
  hasProcessSpawn: boolean;
  hasSecrets: boolean;
  hasWorkspaceWrite: boolean;
  requiresFullTrust: boolean;
  riskLevel: AppExtensionSecurityRiskLevel;
  riskReasons: string[];
  verifiedIdentity: boolean;
}

export interface ExtensionThemeDefinition {
  type?: "dark" | "light";
  colors?: Record<string, string>;
  terminal?: Record<string, string>;
  monaco?: {
    base?: "vs" | "vs-dark" | "hc-black" | "hc-light";
    colors?: Record<string, string>;
    rules?: Array<Record<string, unknown>>;
  };
}

export interface ExtensionAssetResult {
  mimeType: string;
  encoding: "utf8" | "base64";
  data: string;
}

export interface ResolvedExtensionMcpServer {
  id: string;
  name: string;
  extensionId: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  type?: "http" | "sse" | "stdio" | "streamablehttp";
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvedExtensionSkill {
  id: string;
  name: string;
  description?: string;
  extensionId: string;
  path: string;
  manifestPath: string;
  hasScripts: boolean;
}

export interface ResolvedExtensionPrompt {
  id: string;
  title: string;
  description?: string;
  content: string;
  extensionId: string;
  autoInclude: boolean;
}

export interface ResolvedAgentContributions {
  extensionIds: string[];
  mcpServers: ResolvedExtensionMcpServer[];
  skills: ResolvedExtensionSkill[];
  prompts: ResolvedExtensionPrompt[];
  warnings: string[];
}

export interface ExtensionListInput {
  workspacePath?: string;
  workspaceId?: string;
  extensionIds?: string[];
}

export interface ExtensionInstallInput {
  expectedSha256?: string;
  sourcePath?: string;
  sourceUrl?: string;
  updateUrl?: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionUpdateInput {
  extensionId: string;
  expectedSha256?: string;
  sourcePath?: string;
  sourceUrl?: string;
  workspacePath?: string;
  workspaceId?: string;
}

export type ExtensionReleaseChannel = "stable" | "beta" | "dev";

export interface ExtensionMarketplaceItem {
  categories?: string[];
  description?: string;
  displayName: string;
  downloads?: number;
  homepage?: string;
  id: string;
  license?: string;
  permissions?: AppExtensionPermission[];
  publisher: string;
  rating?: number;
  releaseChannel?: ExtensionReleaseChannel;
  sha256: string;
  sourceUrl: string;
  updateUrl?: string;
  updatedAt?: number;
  verifiedPublisher?: boolean;
  version: string;
}

export interface ExtensionMarketplaceListInput {
  includePrerelease?: boolean;
  limit?: number;
  query?: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionMarketplaceResult {
  items: ExtensionMarketplaceItem[];
  sources: string[];
  warnings: string[];
}

export type ExtensionAuditOutcome = "success" | "failure";

export interface ExtensionAuditRecord {
  action: string;
  at: number;
  extensionId?: string;
  id: string;
  message?: string;
  metadata?: Record<string, unknown>;
  outcome: ExtensionAuditOutcome;
  workspaceId?: string;
  workspacePath?: string;
}

export interface ExtensionAuditListInput {
  extensionId?: string;
  limit?: number;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionUninstallInput {
  extensionId: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionEnableInput {
  extensionId: string;
  enabled: boolean;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionGrantInput {
  extensionId: string;
  permissions: AppExtensionPermission[];
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionWorkspaceTrustInput {
  workspacePath: string;
  workspaceId?: string;
  trusted: boolean;
}

export interface ExtensionAssetInput {
  extensionId: string;
  path: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionActivateInput {
  extensionId: string;
  event: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionCommandInput {
  extensionId: string;
  command: string;
  args?: unknown[];
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionConfigurationInput {
  extensionId: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionConfigurationUpdateInput {
  extensionId: string;
  values: Record<string, unknown>;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionConfigurationResult {
  values: Record<string, unknown>;
  configuredSecrets: string[];
}

export interface ResolveAgentContributionsInput {
  workspacePath: string;
  workspaceId?: string;
  extensionIds?: string[];
}

export interface ExtensionRuntimeEvent {
  type: "changed" | "state" | "log";
  extensionId?: string;
  state?: AppExtensionState;
  message?: string;
  workspacePath?: string;
  workspaceId?: string;
}

export interface ExtensionDisposable {
  dispose(): void | Promise<void>;
}

export interface AppExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly permissions: readonly AppExtensionPermission[];
  readonly workspace: {
    readonly root?: string;
    readonly canRead: boolean;
    readonly canWrite: boolean;
  };
  readonly subscriptions: ExtensionDisposable[];
  readonly commands: {
    registerCommand(
      command: string,
      handler: (...args: unknown[]) => unknown | Promise<unknown>,
    ): ExtensionDisposable;
  };
  readonly configuration: {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
  };
  readonly secrets: {
    get(key: string): string | undefined;
  };
  readonly globalState: {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  };
  readonly workspaceState: {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  };
  readonly log: {
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
  };
}

export type ActivateAppExtension = (
  context: AppExtensionContext,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
