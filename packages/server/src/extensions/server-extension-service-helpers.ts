import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGUI_EXTENSION_ENGINE,
  APP_EXTENSION_PERMISSIONS,
  isExtensionEngineCompatible,
  type AppExtensionManifest,
  type AppExtensionPermission,
  type AppExtensionRecord,
  type AppExtensionSource,
  type ExtensionAuditRecord,
  type ExtensionConfigurationProperty,
} from "@the-next-ai/agui-extensions";

export type PersistedExtensionState = {
  auditLog: ExtensionAuditRecord[];
  enabled: Record<string, boolean>;
  grants: Record<string, AppExtensionPermission[]>;
  identities: Record<string, { scope: string; fingerprint: string }>;
  updateSources: Record<string, { sha256?: string; url?: string }>;
  trustedWorkspaces: string[];
  configuration: Record<string, Record<string, unknown>>;
  secrets: Record<string, Record<string, string>>;
  storage: Record<
    string,
    {
      global: Record<string, unknown>;
      workspaces: Record<string, Record<string, unknown>>;
    }
  >;
};

export type DiscoveredExtension = {
  id: string;
  manifest: AppExtensionManifest;
  source: AppExtensionSource;
  extensionPath: string;
  warning?: string;
};

export const BUILTIN_ID = "agui.core";
export const AGUI_HOME_DIRECTORY = ".agui";
export const USER_EXTENSIONS_DIRECTORY = "extensions";
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_UI_ASSET_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const SCAN_CACHE_MS = 250;
export const E2E_SECRET_PREFIX = "e2e:";
const NODE_SECRET_PREFIX = "node:v1:";
const SERVER_SECRET_KEY_FILENAME = "extension-secret.key";
const serverSecretKeys = new Map<string, Buffer>();
export const extensionManifestCache = new Map<
  string,
  {
    manifestPath: string;
    mtimeMs: number;
    size: number;
    discovered: DiscoveredExtension;
  }
>();
export const VALID_PERMISSIONS = new Set<AppExtensionPermission>(APP_EXTENSION_PERMISSIONS);

export function isE2eRuntime(): boolean {
  return process.env.AGUI_E2E === "1" || process.env.AG_UI_E2E === "1";
}

function serverSecretKey(homeRoot = aguiHomeRoot()): Buffer {
  const configured = configuredServerSecretKey();
  if (configured?.trim()) {
    const value = configured.trim();
    if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
    return createHash("sha256").update(value).digest();
  }
  const root = path.resolve(homeRoot);
  const cached = serverSecretKeys.get(root);
  if (cached) return cached;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const keyPath = path.join(root, SERVER_SECRET_KEY_FILENAME);
  let key: Buffer;
  try {
    key = fs.readFileSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(32);
    try {
      fs.writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      key = fs.readFileSync(keyPath);
    }
  }
  if (key.byteLength !== 32) {
    throw new Error(`Invalid extension secret key file: ${keyPath}`);
  }
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Some filesystems do not expose POSIX permissions. The random key is still
    // materially safer than deriving one from public machine attributes.
  }
  serverSecretKeys.set(root, key);
  return key;
}

function configuredServerSecretKey(): string | undefined {
  return process.env.AG_UI_EXTENSION_SECRET_KEY ?? process.env.AGUI_EXTENSION_SECRET_KEY;
}

function aguiHomeRoot(): string {
  const override = process.env.AG_UI_HOME || process.env.AGUI_HOME;
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), AGUI_HOME_DIRECTORY);
}

export function encryptExtensionSecret(value: string, homeRoot?: string): string {
  if (isE2eRuntime()) {
    return `${E2E_SECRET_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", serverSecretKey(homeRoot), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${NODE_SECRET_PREFIX}${iv.toString("base64url")}:${tag.toString(
    "base64url",
  )}:${encrypted.toString("base64url")}`;
}

export function decryptExtensionSecret(value: string, homeRoot?: string): string {
  if (isE2eRuntime() && value.startsWith(E2E_SECRET_PREFIX)) {
    return Buffer.from(value.slice(E2E_SECRET_PREFIX.length), "base64").toString("utf8");
  }
  if (!value.startsWith(NODE_SECRET_PREFIX)) {
    throw new Error("Unsupported extension secret format.");
  }
  const [ivValue, tagValue, encryptedValue] = value.slice(NODE_SECRET_PREFIX.length).split(":");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid extension secret format.");
  return decryptServerSecret(ivValue, tagValue, encryptedValue, serverSecretKey(homeRoot));
}

function decryptServerSecret(
  ivValue: string,
  tagValue: string,
  encryptedValue: string,
  key: Buffer,
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function emptyPersistedExtensionState(): PersistedExtensionState {
  return {
    auditLog: [],
    enabled: {},
    grants: {},
    identities: {},
    updateSources: {},
    trustedWorkspaces: [],
    configuration: {},
    secrets: {},
    storage: {},
  };
}

export function readPersistedExtensionState(filePath: string): PersistedExtensionState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<PersistedExtensionState>;
    return {
      auditLog: objectAuditLog(parsed.auditLog),
      enabled: objectBooleanRecord(parsed.enabled),
      grants: objectPermissionRecord(parsed.grants),
      identities: objectIdentityRecord(parsed.identities),
      updateSources: objectUpdateSourceRecord(parsed.updateSources),
      configuration: objectNestedRecord(parsed.configuration),
      secrets: objectStringNestedRecord(parsed.secrets),
      storage: objectStorageRecord(parsed.storage),
      trustedWorkspaces: Array.isArray(parsed.trustedWorkspaces)
        ? parsed.trustedWorkspaces.filter((value): value is string => typeof value === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function builtinExtension(): DiscoveredExtension {
  const manifest: AppExtensionManifest = {
    name: "core",
    publisher: "agui",
    version: process.env.npm_package_version || "0.1.0",
    displayName: "AGUI Core",
    description: "Built-in application shell, agent runtime and default renderers.",
    engines: { agui: `^${AGUI_EXTENSION_ENGINE}` },
    permissions: [
      "ui.render.declarative",
      "ui.sidebar",
      "ui.detailPanel",
      "ui.composer",
      "ui.header",
      "ui.floatingWidget",
      "ui.chatRenderer",
      "ui.webComponent.trusted",
      "ui.webview",
      "ui.overrideBuiltins",
      "theme",
      "commands",
      "workspace.read",
      "workspace.write",
      "process.spawn",
    ],
  };
  return { id: BUILTIN_ID, manifest, source: "builtin", extensionPath: process.cwd() };
}

export function scanExtensionRoot(root: string, source: AppExtensionSource): DiscoveredExtension[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const extensions: DiscoveredExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      extensions.push(readExtension(path.join(root, entry.name), source));
    } catch (error) {
      const fallbackId = `${source}.${safeIdentifier(entry.name)}`;
      extensions.push({
        id: fallbackId,
        source,
        extensionPath: path.join(root, entry.name),
        warning: error instanceof Error ? error.message : String(error),
        manifest: {
          name: safeIdentifier(entry.name),
          publisher: source,
          version: "0.0.0",
          engines: { agui: `^${AGUI_EXTENSION_ENGINE}` },
        },
      });
    }
  }
  return extensions;
}

export async function replaceInstalledExtension(
  root: string,
  extensionId: string,
  staging: string,
  destination: string,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const moved: Array<{ original: string; backup: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (path.resolve(candidate) === path.resolve(staging)) continue;
    try {
      if (readExtension(candidate, "user").id === extensionId) {
        const backup = `${candidate}.replaced-${process.pid}-${Date.now()}-${moved.length}`;
        await fs.promises.rename(candidate, backup);
        moved.push({ original: candidate, backup });
      }
    } catch {
      // Leave unrelated or malformed packages untouched.
    }
  }
  try {
    await fs.promises.rename(staging, destination);
  } catch (error) {
    for (const item of moved.reverse()) {
      await fs.promises.rename(item.backup, item.original).catch(() => undefined);
    }
    throw error;
  }
  await Promise.all(
    moved.map((item) =>
      fs.promises.rm(item.backup, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

export function readExtension(
  extensionPath: string,
  source: AppExtensionSource,
): DiscoveredExtension {
  const packagePath = path.join(extensionPath, "package.json");
  const manifestPath = fs.existsSync(packagePath) ? packagePath : "";
  if (!manifestPath) throw new Error("Extension requires package.json.");
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Extension manifest exceeds the 1 MB limit.");
  }
  const cacheKey = `${source}:${path.resolve(extensionPath)}`;
  const cached = extensionManifestCache.get(cacheKey);
  if (
    cached &&
    cached.manifestPath === manifestPath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.discovered;
  }
  const raw = JSON.parse(fs.readFileSync(packagePath, "utf8")) as unknown;
  const manifest = validateManifest(raw, extensionPath);
  const discovered = {
    id: `${manifest.publisher}.${manifest.name}`,
    manifest,
    source,
    extensionPath,
  };
  extensionManifestCache.set(cacheKey, {
    manifestPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    discovered,
  });
  if (extensionManifestCache.size > 500) {
    extensionManifestCache.delete(extensionManifestCache.keys().next().value ?? "");
  }
  return discovered;
}

export function validateManifest(value: unknown, extensionPath: string): AppExtensionManifest {
  const raw = objectValue(value);
  const name = extensionName(raw.name, "name");
  const publisher = extensionName(raw.publisher, "publisher");
  const version = stringValue(raw.version);
  const updateUrl = extensionUpdateUrl(raw.updateUrl || objectValue(raw.updates).url, {
    allowEmpty: true,
  });
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Extension version must be valid SemVer.");
  }
  const engines = objectValue(raw.engines);
  const engine = stringValue(engines.agui);
  if (!engine || !engineCompatible(engine)) {
    throw new Error(
      `Extension requires unsupported AGUI engine ${engine || "<missing>"}; current is ${AGUI_EXTENSION_ENGINE}.`,
    );
  }
  const manifest = withInferredMcpPermissions(value as AppExtensionManifest, extensionPath);
  for (const permission of manifest.permissions ?? []) {
    if (!VALID_PERMISSIONS.has(permission))
      throw new Error(`Unknown extension permission: ${permission}`);
  }
  validateSupportedContributions(manifest);
  validateContributionModes(manifest);
  for (const relative of manifestPaths(manifest)) validateRelativePath(extensionPath, relative);
  validateContributionIds(manifest, `${publisher}.${name}`);
  validateMenuCommands(manifest, `${publisher}.${name}`);
  return {
    ...manifest,
    name,
    publisher,
    version,
    ...(updateUrl ? { updateUrl } : {}),
    engines: { agui: engine },
    permissions: requestedPermissions(manifest),
  };
}

export function extensionUpdateUrl(value: unknown, options: { allowEmpty?: boolean } = {}): string {
  const raw = stringValue(value).trim();
  if (!raw) {
    if (options.allowEmpty) return "";
    throw new Error("Extension update URL is required.");
  }
  if (raw.length > 8_192) throw new Error("Extension update URL is too long.");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Extension update URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Extension update URL must use HTTPS.");
  }
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

export function validateContributionModes(manifest: AppExtensionManifest): void {
  const contributes = manifest.contributes;
  for (const item of contributes?.composerControls ?? []) validateUiMode(item.viewType, item.id);
  for (const item of contributes?.headerControls ?? []) validateUiMode(item.viewType, item.id);
  for (const item of contributes?.floatingWidgets ?? []) validateUiMode(item.viewType, item.id);
  for (const item of contributes?.chatRenderers ?? []) validateUiMode(item.renderMode, item.id);
  if (contributes?.configuration?.view) {
    validateUiMode(
      contributes.configuration.view.viewType ?? "web-component",
      contributes.configuration.view.id,
    );
  }
  for (const item of extensionViews(contributes))
    validateUiMode(item.viewType ?? "web-component", item.id);
}

export function validateSupportedContributions(manifest: AppExtensionManifest): void {
  const contributes = objectValue(manifest.contributes);
  for (const legacy of ["sidebarPanels", "detailPanels"]) {
    if (legacy in contributes) {
      throw new Error(
        `Unsupported extension contribution: contributes.${legacy}. Use viewsContainers and views instead.`,
      );
    }
  }
}

export function validateUiMode(value: unknown, contributionId: string): void {
  if (value === "declarative" || value === "web-component" || value === "webview") return;
  throw new Error(
    `Unsupported extension UI mode for ${contributionId}: ${String(value || "<missing>")}`,
  );
}

function withInferredMcpPermissions(
  manifest: AppExtensionManifest,
  extensionPath: string,
): AppExtensionManifest {
  const inferred = inferMcpPermissions(manifest, extensionPath);
  if (!inferred.length) return manifest;
  return {
    ...manifest,
    permissions: [...new Set([...(manifest.permissions ?? []), ...inferred])],
  };
}

function inferMcpPermissions(
  manifest: AppExtensionManifest,
  extensionPath: string,
): AppExtensionPermission[] {
  const permissions = new Set<AppExtensionPermission>();
  for (const rawServer of mcpServerDefinitions(extensionPath, manifest.contributes?.mcpServers)) {
    const server = objectValue(rawServer);
    if (stringValue(server.command)) permissions.add("process.spawn");
    if (stringValue(server.url)) permissions.add("network");
    if (
      recordRequiresSecrets(server.env) ||
      recordRequiresSecrets(server.headers) ||
      recordRequiresSecrets(server.http_headers)
    ) {
      permissions.add("secrets");
    }
  }
  return [...permissions];
}

function mcpServerDefinitions(
  extensionPath: string,
  mcpServers: NonNullable<AppExtensionManifest["contributes"]>["mcpServers"],
): unknown[] {
  const definitions: unknown[] = [];
  if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
    definitions.push(...Object.values(objectValue(mcpServers)));
  }
  for (const configPath of arrayValue(mcpServers)) {
    try {
      const absolute = safeExistingPath(extensionPath, configPath);
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
      const root = objectValue(parsed);
      definitions.push(
        ...Object.values(objectValue(root.mcpServers ?? root.mcp_servers ?? parsed)),
      );
    } catch {
      // MCP config errors are surfaced when resources are resolved; discovery should stay best-effort.
    }
  }
  return definitions.slice(0, 50);
}

export function recordRequiresSecrets(value: unknown): boolean {
  const record = limitedStringRecord(value, 50, 8192);
  return Boolean(
    record &&
    Object.entries(record).some(
      ([key, item]) => sensitiveMcpKey(key) || secretNamesInString(item).length > 0,
    ),
  );
}

function secretNamesInString(value: string): string[] {
  return [...value.matchAll(/\$\{secret:([^}]+)\}/g)]
    .map((match) => match[1]?.trim())
    .filter((name): name is string => Boolean(name))
    .map((name) => name.slice(0, 256));
}

export function sensitiveMcpKey(value: string): boolean {
  return /authorization|secret|token|password|credential|api[_-]?key/i.test(value);
}

export function requestedPermissions(manifest: AppExtensionManifest): AppExtensionPermission[] {
  const permissions = new Set(manifest.permissions ?? []);
  const contributes = manifest.contributes;
  if (contributes?.sessionTree?.length) permissions.add("ui.sessionTree");
  if (contributes?.viewsContainers?.activitybar?.length) permissions.add("ui.sidebar");
  if (contributes?.viewsContainers?.panel?.length) permissions.add("ui.detailPanel");
  if (contributes?.composerControls?.length) permissions.add("ui.composer");
  if (contributes?.headerControls?.length) permissions.add("ui.header");
  if (contributes?.floatingWidgets?.length) permissions.add("ui.floatingWidget");
  if (contributes?.chatRenderers?.length) permissions.add("ui.chatRenderer");
  if (contributes?.styles?.length) permissions.add("ui.styles");
  if (contributes?.themes?.length) permissions.add("theme");
  if (contributes?.commands?.length || manifest.main) permissions.add("commands");
  if (usesUiMode(contributes, "declarative")) permissions.add("ui.render.declarative");
  if (usesUiMode(contributes, "webview")) permissions.add("ui.webview");
  if (usesWebComponent(contributes)) permissions.add("ui.webComponent.trusted");
  if (manifest.main) permissions.add("runtime.fullTrust");
  if (contributes?.skills) permissions.add("agent.skills");
  if (contributes?.mcpServers) permissions.add("agent.mcp");
  if (contributes?.prompts?.length) permissions.add("agent.prompts");
  if (sessionTreeRequestsAgentContext(contributes?.sessionTree)) {
    permissions.add("agent.sessionContext");
  }
  if (
    Object.values(contributes?.configuration?.properties ?? {}).some((property) => property.secret)
  )
    permissions.add("secrets");
  return [...permissions];
}

function sessionTreeRequestsAgentContext(
  roots: NonNullable<AppExtensionManifest["contributes"]>["sessionTree"],
): boolean {
  for (const root of roots ?? []) {
    if (root.command) return true;
    const pending = [...(root.children ?? [])];
    while (pending.length) {
      const node = pending.pop()!;
      const session = node.session;
      if (
        session &&
        (session.providerId ||
          session.projectPath !== undefined ||
          session.cwd ||
          session.developerInstructions)
      ) {
        return true;
      }
      pending.push(...(node.children ?? []));
    }
  }
  return false;
}

export function usesWebComponent(contributes: AppExtensionManifest["contributes"]): boolean {
  return usesUiMode(contributes, "web-component");
}

export function usesUiMode(
  contributes: AppExtensionManifest["contributes"],
  mode: "declarative" | "web-component" | "webview",
): boolean {
  return Boolean(
    contributes?.composerControls?.some((item) => contributionMode(item.viewType) === mode) ||
    contributes?.headerControls?.some((item) => contributionMode(item.viewType) === mode) ||
    contributes?.floatingWidgets?.some((item) => contributionMode(item.viewType) === mode) ||
    contributes?.chatRenderers?.some((item) => contributionMode(item.renderMode) === mode) ||
    (Boolean(contributes?.configuration?.view) &&
      contributionMode(contributes?.configuration?.view?.viewType ?? "web-component") === mode) ||
    extensionViews(contributes).some(
      (item) => contributionMode(item.viewType ?? "web-component") === mode,
    ),
  );
}

export function contributionMode(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function manifestPaths(manifest: AppExtensionManifest): string[] {
  const contributes = manifest.contributes;
  return [
    manifest.main,
    manifest.browser,
    manifest.icon,
    ...iconContributionPaths(manifest.icon),
    ...(contributes?.sessionTree ?? []).flatMap((item) => iconContributionPaths(item.icon)),
    ...sessionTreeNodes(contributes).flatMap((item) => iconContributionPaths(item.icon)),
    ...extensionViewContainers(contributes).flatMap((item) => iconContributionPaths(item.icon)),
    ...(contributes?.composerControls ?? []).map((item) => item.entry),
    ...(contributes?.headerControls ?? []).map((item) => item.entry),
    ...(contributes?.floatingWidgets ?? []).map((item) => item.entry),
    ...(contributes?.chatRenderers ?? []).map((item) => item.entry),
    contributes?.configuration?.view?.entry,
    ...extensionViews(contributes).map((item) => item.entry),
    ...extensionViews(contributes).flatMap((item) => iconContributionPaths(item.icon)),
    ...(contributes?.commands ?? []).flatMap((item) => iconContributionPaths(item.icon)),
    ...(contributes?.themes ?? []).map((item) => item.path),
    ...(contributes?.styles ?? []).map((item) => item.path),
    ...arrayValue(contributes?.skills),
    ...arrayValue(contributes?.mcpServers),
    ...(contributes?.prompts ?? [])
      .map((item) => item.path)
      .filter((value): value is string => Boolean(value)),
  ].filter((value): value is string => Boolean(value));
}

export function validateContributionIds(manifest: AppExtensionManifest, extensionId: string): void {
  const ids = [
    ...(manifest.contributes?.composerControls ?? []).map((item) => item.id),
    ...(manifest.contributes?.headerControls ?? []).map((item) => item.id),
    ...(manifest.contributes?.floatingWidgets ?? []).map((item) => item.id),
    ...(manifest.contributes?.chatRenderers ?? []).map((item) => item.id),
    ...(manifest.contributes?.sessionTree ?? []).map((item) => item.id),
    ...sessionTreeNodes(manifest.contributes).map((item) => item.id),
    ...(manifest.contributes?.configuration?.view
      ? [manifest.contributes.configuration.view.id]
      : []),
    ...extensionViewContainers(manifest.contributes).map((item) => item.id),
    ...extensionViews(manifest.contributes).map((item) => item.id),
    ...(manifest.contributes?.themes ?? []).map((item) => item.id),
    ...(manifest.contributes?.styles ?? []).map((item) => item.id),
    ...(manifest.contributes?.commands ?? []).map((item) => commandContributionId(item)),
    ...(manifest.contributes?.prompts ?? []).map((item) => item.id),
  ];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || (!id.startsWith(`${extensionId}.`) && !id.startsWith(`${extensionId}/`))) {
      throw new Error(
        `Contribution id must use the ${extensionId} namespace: ${id || "<missing>"}`,
      );
    }
    if (seen.has(id)) throw new Error(`Duplicate extension contribution id: ${id}`);
    seen.add(id);
  }
}

export function validateMenuCommands(manifest: AppExtensionManifest, extensionId: string): void {
  for (const menu of Object.values(manifest.contributes?.menus ?? {})) {
    if (!Array.isArray(menu)) continue;
    for (const item of menu) {
      const contribution = objectValue(item);
      for (const value of [contribution.command, contribution.alt]) {
        const command = stringValue(value);
        if (!command) continue;
        if (!command.startsWith(`${extensionId}.`) && !command.startsWith(`${extensionId}/`)) {
          throw new Error(`Menu command must use the ${extensionId} namespace: ${command}`);
        }
      }
    }
  }
}

export function validateRelativePath(root: string, relative: string): void {
  if (!relative || path.isAbsolute(relative))
    throw new Error(`Extension paths must be relative: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!isWithin(root, resolved)) throw new Error(`Extension path escapes its package: ${relative}`);
}

export function safeExistingPath(root: string, relativeOrAbsolute: string): string {
  const resolved = path.isAbsolute(relativeOrAbsolute)
    ? path.resolve(relativeOrAbsolute)
    : path.resolve(root, relativeOrAbsolute);
  if (!isWithin(root, resolved))
    throw new Error(`Extension path escapes its package: ${relativeOrAbsolute}`);
  if (!fs.existsSync(resolved))
    throw new Error(`Extension asset does not exist: ${relativeOrAbsolute}`);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(resolved);
  if (!isWithin(realRoot, real))
    throw new Error(`Extension symlink escapes its package: ${relativeOrAbsolute}`);
  return real;
}

export async function safeExistingPathAsync(
  root: string,
  relativeOrAbsolute: string,
): Promise<string> {
  const resolved = path.isAbsolute(relativeOrAbsolute)
    ? path.resolve(relativeOrAbsolute)
    : path.resolve(root, relativeOrAbsolute);
  if (!isWithin(root, resolved))
    throw new Error(`Extension path escapes its package: ${relativeOrAbsolute}`);
  const [realRoot, real] = await Promise.all([
    fs.promises.realpath(root),
    fs.promises.realpath(resolved),
  ]);
  if (!isWithin(realRoot, real))
    throw new Error(`Extension symlink escapes its package: ${relativeOrAbsolute}`);
  return real;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function identityScope(record: AppExtensionRecord): string {
  return `${record.source}:${path.resolve(record.extensionPath)}:${record.manifest.version}`;
}

export function discoveredIdentityScope(record: DiscoveredExtension): string {
  return `${record.source}:${path.resolve(record.extensionPath)}:${record.manifest.version}`;
}

export function isUiAsset(manifest: AppExtensionManifest, relativePath: string): boolean {
  const candidate = path.normalize(relativePath);
  const contributes = manifest.contributes;
  const paths = [
    ...(contributes?.composerControls ?? []).map((item) => item.entry),
    ...(contributes?.headerControls ?? []).map((item) => item.entry),
    ...(contributes?.floatingWidgets ?? []).map((item) => item.entry),
    ...(contributes?.chatRenderers ?? [])
      .map((item) => item.entry)
      .filter((value): value is string => Boolean(value)),
    contributes?.configuration?.view?.entry,
    ...(contributes?.sessionTree ?? []).flatMap((item) => iconContributionPaths(item.icon)),
    ...sessionTreeNodes(contributes).flatMap((item) => iconContributionPaths(item.icon)),
    ...extensionViews(contributes).map((item) => item.entry),
    ...extensionViewContainers(contributes).flatMap((item) => iconContributionPaths(item.icon)),
    ...extensionViews(contributes).flatMap((item) => iconContributionPaths(item.icon)),
    ...(contributes?.commands ?? []).flatMap((item) => iconContributionPaths(item.icon)),
    ...(contributes?.themes ?? []).map((item) => item.path),
    ...(contributes?.styles ?? []).map((item) => item.path),
  ];
  return paths
    .filter((value): value is string => Boolean(value))
    .some((value) => path.normalize(value) === candidate);
}

export function extensionViewContainers(contributes: AppExtensionManifest["contributes"]): Array<{
  id: string;
  title: string;
  icon?: unknown;
}> {
  return [
    ...(contributes?.viewsContainers?.activitybar ?? []),
    ...(contributes?.viewsContainers?.panel ?? []),
  ];
}

export function extensionViews(contributes: AppExtensionManifest["contributes"]): Array<{
  id: string;
  entry: string;
  icon?: unknown;
  viewType?: unknown;
}> {
  return Object.values(contributes?.views ?? {}).flat();
}

export function sessionTreeNodes(contributes: AppExtensionManifest["contributes"]): Array<{
  id: string;
  icon?: unknown;
}> {
  const output: Array<{ id: string; icon?: unknown }> = [];
  const visit = (
    nodes: Array<{ id?: unknown; icon?: unknown; children?: unknown }> | undefined,
  ) => {
    for (const node of nodes ?? []) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      output.push({ id: stringValue(node.id), icon: node.icon });
      const children = Array.isArray(node.children)
        ? (node.children as Array<{ id?: unknown; icon?: unknown; children?: unknown }>)
        : [];
      visit(children);
    }
  };
  visit(contributes?.sessionTree?.flatMap((item) => item.children ?? []));
  return output;
}

export function commandContributionId(command: { id?: string; command?: string }): string {
  return command.id || command.command || "";
}

export function iconContributionPaths(icon: unknown): string[] {
  if (typeof icon === "string") return isIconAssetPath(icon) ? [icon] : [];
  const source =
    icon && typeof icon === "object" && !Array.isArray(icon)
      ? (icon as Record<string, unknown>)
      : {};
  return [source.path, source.dark, source.light].filter(
    (value): value is string => typeof value === "string" && isIconAssetPath(value),
  );
}

export function isIconAssetPath(value: string): boolean {
  const text = value.trim();
  return (
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("/") ||
    /\.(svg|png|jpg|jpeg|gif|webp|ico)$/i.test(text)
  );
}

export function safeMcpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return parsed.href;
    if (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    ) {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

export function engineCompatible(range: string): boolean {
  return isExtensionEngineCompatible(range, AGUI_EXTENSION_ENGINE);
}

export function activationMatches(events: string[] | undefined, event: string): boolean {
  if (!events?.length) return true;
  return (
    events.includes("*") ||
    events.includes(event) ||
    (event === "onStartupFinished" && events.includes("onStartupFinished"))
  );
}

export function cloneRecord(record: AppExtensionRecord): AppExtensionRecord {
  return JSON.parse(JSON.stringify(record)) as AppExtensionRecord;
}

export function compareExtensions(a: AppExtensionRecord, b: AppExtensionRecord): number {
  if (a.source !== b.source) {
    const rank = { builtin: 0, user: 1, workspace: 2 };
    return rank[a.source] - rank[b.source];
  }
  return (a.manifest.displayName || a.id).localeCompare(b.manifest.displayName || b.id);
}

export function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  return Object.fromEntries(
    content
      .slice(3, end)
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator < 0) return ["", ""];
        const key = line.slice(0, separator).trim();
        const value = line
          .slice(separator + 1)
          .trim()
          .replace(/^['"]|['"]$/g, "");
        return [key, value];
      })
      .filter(([key]) => Boolean(key)),
  );
}

export function extensionName(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) {
    throw new Error(`Extension ${field} must be lowercase kebab-case.`);
  }
  return result;
}

export function normalizeWorkspacePath(value: string): string {
  if (!value.trim()) return "";
  const resolved = path.resolve(value.trim());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    (
      {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".cjs": "text/javascript",
        ".json": "application/json",
        ".md": "text/markdown",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

export function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "image/svg+xml"
  );
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
  const entries = Object.entries(objectValue(value));
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([key, item]) => [key, String(item)]));
}

export function limitedStringRecord(
  value: unknown,
  maxEntries: number,
  maxValueLength: number,
): Record<string, string> | undefined {
  const entries = Object.entries(objectValue(value)).slice(0, maxEntries);
  if (!entries.length) return undefined;
  return Object.fromEntries(
    entries.map(([key, item]) => [key.slice(0, 256), String(item).slice(0, maxValueLength)]),
  );
}

export function arrayValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

export function objectBooleanRecord(value: unknown): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(objectValue(value)).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

export function objectNestedRecord(value: unknown): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(objectValue(value))
      .slice(0, 500)
      .map(([key, item]) => [
        key,
        Object.fromEntries(Object.entries(objectValue(item)).slice(0, 200)),
      ]),
  );
}

export function objectStringNestedRecord(value: unknown): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(objectValue(value))
      .slice(0, 500)
      .map(([key, item]) => [
        key,
        Object.fromEntries(
          Object.entries(objectValue(item))
            .slice(0, 200)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      ]),
  );
}

export function objectUpdateSourceRecord(value: unknown): PersistedExtensionState["updateSources"] {
  return Object.fromEntries(
    Object.entries(objectValue(value)).flatMap(([key, item]) => {
      try {
        const record = objectValue(item);
        const url = extensionUpdateUrl(record.url, { allowEmpty: true });
        const sha256 = normalizePersistedSha256(record.sha256);
        return url ? [[key, { ...(sha256 ? { sha256 } : {}), url }] as const] : [];
      } catch {
        return [];
      }
    }),
  );
}

function normalizePersistedSha256(value: unknown): string | undefined {
  const hash = stringValue(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

export function objectStorageRecord(value: unknown): PersistedExtensionState["storage"] {
  return Object.fromEntries(
    Object.entries(objectValue(value))
      .slice(0, 500)
      .map(([extensionId, item]) => {
        const record = objectValue(item);
        return [
          extensionId,
          {
            global: cloneJsonRecord(objectValue(record.global)),
            workspaces: Object.fromEntries(
              Object.entries(objectValue(record.workspaces))
                .slice(0, 100)
                .map(([workspace, stored]) => [workspace, cloneJsonRecord(objectValue(stored))]),
            ),
          },
        ];
      }),
  );
}

export function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function configurationProperties(
  record: AppExtensionRecord,
): Record<string, ExtensionConfigurationProperty> {
  const raw = record.manifest.contributes?.configuration?.properties ?? {};
  return Object.fromEntries(
    Object.entries(raw)
      .slice(0, 200)
      .filter(([, property]) =>
        Boolean(
          property &&
          typeof property === "object" &&
          ["string", "number", "boolean", "array", "object"].includes(property.type),
        ),
      ),
  );
}

export function configurationValueMatches(
  property: ExtensionConfigurationProperty,
  value: unknown,
): boolean {
  if (value === undefined) return true;
  if (
    property.enum?.length &&
    !property.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  ) {
    return false;
  }
  if (property.type === "string") return typeof value === "string" && value.length <= 64 * 1024;
  if (property.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (property.type === "boolean") return typeof value === "boolean";
  if (property.type === "array") return Array.isArray(value) && value.length <= 1_000;
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function objectIdentityRecord(
  value: unknown,
): Record<string, { scope: string; fingerprint: string }> {
  return Object.fromEntries(
    Object.entries(objectValue(value)).flatMap(([key, item]) => {
      const record = objectValue(item);
      const scope = stringValue(record.scope);
      const fingerprint = stringValue(record.fingerprint);
      return scope && /^[a-f0-9]{64}$/.test(fingerprint)
        ? [[key, { scope, fingerprint }] as const]
        : [];
    }),
  );
}

export function objectAuditLog(value: unknown): ExtensionAuditRecord[] {
  return (Array.isArray(value) ? value : [])
    .map((item): ExtensionAuditRecord | null => {
      const record = objectValue(item);
      const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0;
      const action = stringValue(record.action);
      const id = stringValue(record.id);
      const outcome =
        record.outcome === "failure" || record.outcome === "success" ? record.outcome : "success";
      if (!id || !action || !at) return null;
      const metadata = objectValue(record.metadata);
      return {
        action,
        at,
        extensionId: stringValue(record.extensionId) || undefined,
        id,
        message: stringValue(record.message) || undefined,
        metadata: Object.keys(metadata).length ? cloneJsonRecord(metadata) : undefined,
        outcome,
        workspaceId: stringValue(record.workspaceId) || undefined,
        workspacePath: stringValue(record.workspacePath) || undefined,
      } satisfies ExtensionAuditRecord;
    })
    .filter((item): item is ExtensionAuditRecord => Boolean(item))
    .sort((left, right) => right.at - left.at)
    .slice(0, 200);
}

export function objectPermissionRecord(value: unknown): Record<string, AppExtensionPermission[]> {
  return Object.fromEntries(
    Object.entries(objectValue(value)).map(([key, item]) => [
      key,
      Array.isArray(item)
        ? item.filter((permission): permission is AppExtensionPermission =>
            VALID_PERMISSIONS.has(permission as AppExtensionPermission),
          )
        : [],
    ]),
  );
}
