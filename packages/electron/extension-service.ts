import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import {
  APP_EXTENSION_PERMISSIONS,
  type AppExtensionSecuritySummary,
  type AppExtensionPermission,
  type AppExtensionRecord,
  type ExtensionAuditListInput,
  type ExtensionAuditRecord,
  type ExtensionAssetResult,
  type ExtensionMarketplaceItem,
  type ExtensionMarketplaceListInput,
  type ExtensionMarketplaceResult,
  type ExtensionRuntimeEvent,
  type ResolvedAgentContributions,
  type ResolvedExtensionPrompt,
  type ResolvedExtensionMcpServer,
  type ResolvedExtensionSkill,
} from "@agui/extensions";
import { createAppStorage, type AppStorage } from "@agui/runtime";
import { ExtensionHostClient } from "./extension-host-client.js";
import {
  computePackageFingerprint,
  computePackageFingerprintSync,
  extractAguix,
  findPackageRoot,
  packageFiles,
  validatePackageTree,
} from "./extension-package.js";
import {
  AGUI_HOME_DIRECTORY,
  MAX_ASSET_BYTES,
  MAX_UI_ASSET_BYTES,
  SCAN_CACHE_MS,
  USER_EXTENSIONS_DIRECTORY,
  activationMatches,
  arrayValue,
  builtinExtension,
  cloneJsonRecord,
  cloneRecord,
  compareExtensions,
  configurationProperties,
  configurationValueMatches,
  decryptExtensionSecret,
  discoveredIdentityScope,
  emptyPersistedExtensionState,
  encryptExtensionSecret,
  extensionManifestCache,
  extensionUpdateUrl,
  identityScope,
  isTextMime,
  isUiAsset,
  isWithin,
  limitedStringRecord,
  mimeTypeFor,
  normalizeWorkspacePath,
  objectValue,
  parseFrontmatter,
  readExtension,
  readPersistedExtensionState,
  recordRequiresSecrets,
  replaceInstalledExtension,
  requestedPermissions,
  safeExistingPath,
  safeExistingPathAsync,
  safeFileSegment,
  safeIdentifier,
  safeMcpUrl,
  scanExtensionRoot,
  stringArray,
  stringValue,
  type DiscoveredExtension,
  type PersistedExtensionState,
} from "./extension-service-helpers.js";

type ExtensionExecutionScope = {
  workspaceId: string;
  workspacePath: string;
};

type ExtensionHostScope = ExtensionExecutionScope & {
  extensionId: string;
  extensionIdentity: string;
};

const FINGERPRINT_VERIFICATION_CACHE_MS = 5_000;
const EXTENSION_PACKAGE_DOWNLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

export class ExtensionService {
  private state: PersistedExtensionState | null = null;
  private readonly stateReady: Promise<void>;
  private readonly stateStorage: AppStorage;
  private stateSaveQueue: Promise<void> = Promise.resolve();
  private readonly scopeOperationContext = new AsyncLocalStorage<boolean>();
  private scopeOperationQueue: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, AppExtensionRecord>();
  private readonly host: ExtensionHostClient;
  private readonly hostScopes = new Map<string, ExtensionHostScope>();
  private readonly workspacePaths = new Map<string, string>();
  private readonly restartingHosts = new Set<string>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly verifiedFingerprints = new Map<
    string,
    {
      fingerprint: string;
      verifiedAt: number;
    }
  >();
  private workspacePath = "";
  private workspaceId = "";
  private lastScanAt = 0;

  constructor(private readonly emit: (event: ExtensionRuntimeEvent) => void) {
    this.stateStorage = createAppStorage({
      env: process.env,
      namespace: "extensions",
      userDataPath: () => this.aguiHomeRoot(),
    });
    this.host = new ExtensionHostClient(
      (hostKey, extensionId, message) => {
        const scope = this.hostScopes.get(hostKey);
        this.emitScoped({ type: "log", extensionId, message }, scope);
      },
      (hostKey, extensionId, message) => {
        const scope = this.hostScopes.get(hostKey);
        const record = this.isCurrentScope(scope) ? this.records.get(extensionId) : undefined;
        if (record && (record.state === "active" || record.state === "activating")) {
          record.state = "error";
          record.statusMessage = message;
        }
        this.hostScopes.delete(hostKey);
        this.activations.delete(hostKey);
        this.restartingHosts.delete(hostKey);
        this.emitScoped({ type: "changed", extensionId, message }, scope);
      },
      (hostKey, extensionId, scope, key, value) =>
        this.updateExtensionStorage(hostKey, extensionId, scope, key, value),
    );
    this.stateReady = this.initializeState();
  }

  async list(
    workspacePath = "",
    workspaceId = "",
    extensionIds?: string[],
  ): Promise<AppExtensionRecord[]> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() => this.list(workspacePath, workspaceId, extensionIds));
    }
    await this.ensureStateLoaded();
    await this.switchWorkspace(
      normalizeWorkspacePath(workspacePath),
      normalizeWorkspaceId(workspaceId),
    );
    this.scan();
    await this.reconcileCurrentHosts();
    this.scan(true);
    const allowed = extensionIds ? new Set(extensionIds) : null;
    return [...this.records.values()]
      .filter(
        (record) =>
          record.source === "builtin" ||
          record.source === "workspace" ||
          !allowed ||
          allowed.has(record.id),
      )
      .sort(compareExtensions)
      .map(cloneRecord);
  }

  async audit(input: ExtensionAuditListInput = {}): Promise<ExtensionAuditRecord[]> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() => this.audit(input));
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(input.workspacePath, input.workspaceId);
    const extensionId = stringValue(input.extensionId);
    const limit = clampInteger(input.limit ?? 50, 1, 200);
    return this.loadState()
      .auditLog.filter((entry) => !extensionId || entry.extensionId === extensionId)
      .filter(
        (entry) =>
          !this.workspaceId || !entry.workspaceId || entry.workspaceId === this.workspaceId,
      )
      .slice(0, limit)
      .map((entry) => JSON.parse(JSON.stringify(entry)) as ExtensionAuditRecord);
  }

  async marketplace(
    input: ExtensionMarketplaceListInput = {},
  ): Promise<ExtensionMarketplaceResult> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() => this.marketplace(input));
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(input.workspacePath, input.workspaceId);
    const sources = extensionMarketplaceSources();
    const warnings: string[] = [];
    const items: ExtensionMarketplaceItem[] = [];
    for (const source of sources) {
      try {
        const catalog = await readMarketplaceCatalog(source);
        items.push(...marketplaceCatalogItems(catalog));
      } catch (error) {
        warnings.push(`${source}: ${errorMessage(error)}`);
      }
    }
    const query = stringValue(input.query).toLowerCase();
    const includePrerelease = Boolean(input.includePrerelease);
    const limit = clampInteger(input.limit ?? 50, 1, 100);
    const seen = new Set<string>();
    const filtered = items
      .filter((item) => includePrerelease || (item.releaseChannel ?? "stable") === "stable")
      .filter((item) => !query || marketplaceItemMatches(item, query))
      .filter((item) => {
        const key = item.id.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(compareMarketplaceItems)
      .slice(0, limit);
    return {
      items: filtered,
      sources,
      warnings,
    };
  }

  async install(
    sourcePath: string,
    workspaceId?: string,
    workspacePath?: string,
    options: { expectedSha256?: string; sourceUrl?: string; updateUrl?: string } = {},
  ): Promise<AppExtensionRecord> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.install(sourcePath, workspaceId, workspacePath, options),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    const scopeId = this.workspaceId;
    const sourceUrl = extensionUpdateUrl(options.sourceUrl, { allowEmpty: true });
    const updateUrl = extensionUpdateUrl(options.updateUrl || sourceUrl, { allowEmpty: true });
    let downloadRoot = "";
    let absoluteSource = sourcePath ? path.resolve(sourcePath) : "";
    if (!absoluteSource && sourceUrl) {
      downloadRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agui-extension-download-"));
      absoluteSource = path.join(downloadRoot, "extension.aguix");
      try {
        await downloadExtensionPackage(sourceUrl, absoluteSource, {
          expectedSha256: options.expectedSha256,
        });
      } catch (error) {
        this.recordAudit({
          action: "install",
          message: errorMessage(error),
          metadata: { source: "download", sourceUrl },
          outcome: "failure",
        });
        throw error;
      }
    }
    if (!fs.existsSync(absoluteSource)) {
      const message = `Extension source does not exist: ${sourcePath}`;
      this.recordAudit({
        action: "install",
        message,
        metadata: { source: sourceUrl ? "download" : "local", sourceUrl: sourceUrl || undefined },
        outcome: "failure",
      });
      throw new Error(message);
    }
    try {
      const installed = await this.installSource(absoluteSource, scopeId, {
        updateUrl,
        updateSha256:
          sourceUrl && updateUrl === sourceUrl
            ? normalizeSha256(options.expectedSha256)
            : undefined,
        message: "Extension installed.",
      });
      this.recordAudit({
        action: "install",
        extensionId: installed.id,
        message: "Extension installed.",
        metadata: {
          source: sourceUrl ? "download" : "local",
          updateUrl: installed.updateUrl,
        },
        outcome: "success",
      });
      return installed;
    } catch (error) {
      this.recordAudit({
        action: "install",
        message: errorMessage(error),
        metadata: {
          source: sourceUrl ? "download" : "local",
          sourceUrl: sourceUrl || undefined,
        },
        outcome: "failure",
      });
      throw error;
    } finally {
      if (downloadRoot)
        await fs.promises.rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async update(
    extensionId: string,
    input: { expectedSha256?: string; sourcePath?: string; sourceUrl?: string } = {},
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<AppExtensionRecord> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.update(extensionId, input, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    const scopeId = this.workspaceId;
    this.scan(true);
    const record = this.requireRecord(extensionId);
    if (record.source !== "user") {
      throw new Error("Only user-installed extensions can be updated.");
    }
    if (input.sourcePath && input.sourceUrl) {
      throw new Error("Provide at most one extension update source.");
    }
    const sourceUrl = extensionUpdateUrl(input.sourceUrl || record.updateUrl, { allowEmpty: true });
    let downloadRoot = "";
    let absoluteSource = input.sourcePath ? path.resolve(input.sourcePath) : "";
    if (!absoluteSource) {
      if (!sourceUrl) throw new Error("Extension does not declare an online update URL.");
      downloadRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agui-extension-update-"));
      absoluteSource = path.join(downloadRoot, "extension.aguix");
      try {
        await downloadExtensionPackage(sourceUrl, absoluteSource, {
          expectedSha256: input.expectedSha256,
        });
      } catch (error) {
        this.recordAudit({
          action: "update",
          extensionId,
          message: errorMessage(error),
          metadata: { source: "download", sourceUrl },
          outcome: "failure",
        });
        throw error;
      }
    }
    if (!fs.existsSync(absoluteSource)) {
      const message = `Extension update source does not exist: ${input.sourcePath ?? sourceUrl}`;
      this.recordAudit({
        action: "update",
        extensionId,
        message,
        metadata: { source: sourceUrl ? "download" : "local", sourceUrl: sourceUrl || undefined },
        outcome: "failure",
      });
      throw new Error(message);
    }
    try {
      const updated = await this.installSource(absoluteSource, scopeId, {
        expectedExtensionId: extensionId,
        fallbackUpdateUrl: record.updateUrl,
        updateUrl: sourceUrl,
        updateSha256:
          !input.sourcePath && sourceUrl ? normalizeSha256(input.expectedSha256) : undefined,
        message: "Extension updated.",
      });
      this.recordAudit({
        action: "update",
        extensionId,
        message: "Extension updated.",
        metadata: {
          source: downloadRoot ? "download" : "local",
          updateUrl: updated.updateUrl,
        },
        outcome: "success",
      });
      return updated;
    } catch (error) {
      this.recordAudit({
        action: "update",
        extensionId,
        message: errorMessage(error),
        metadata: {
          source: downloadRoot ? "download" : "local",
          sourceUrl: sourceUrl || undefined,
        },
        outcome: "failure",
      });
      throw error;
    } finally {
      if (downloadRoot)
        await fs.promises.rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async installSource(
    absoluteSource: string,
    scopeId: string,
    options: {
      expectedExtensionId?: string;
      fallbackUpdateUrl?: string;
      message: string;
      updateSha256?: string;
      updateUrl?: string;
    },
  ): Promise<AppExtensionRecord> {
    const temporaryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "agui-extension-install-"),
    );
    let staging = "";
    try {
      const packageRoot = fs.statSync(absoluteSource).isDirectory()
        ? findPackageRoot(absoluteSource)
        : await extractAguix(absoluteSource, temporaryRoot);
      await validatePackageTree(packageRoot);
      const discovered = readExtension(packageRoot, "user");
      if (options.expectedExtensionId && discovered.id !== options.expectedExtensionId) {
        throw new Error(
          `Extension update package id mismatch: expected ${options.expectedExtensionId}, got ${discovered.id}.`,
        );
      }
      const destinationRoot = this.userExtensionsRoot(scopeId);
      await fs.promises.mkdir(destinationRoot, { recursive: true });
      const destination = path.join(
        destinationRoot,
        `${safeFileSegment(discovered.id)}-${safeFileSegment(discovered.manifest.version)}`,
      );
      staging = `${destination}.installing-${process.pid}-${Date.now()}`;
      await fs.promises.cp(packageRoot, staging, { recursive: true, errorOnExist: true });
      const runtimeKey = this.extensionRuntimeKey(discovered.id, scopeId);
      await this.deactivateHost(discovered.id, scopeId);
      this.activations.delete(runtimeKey);
      await replaceInstalledExtension(destinationRoot, discovered.id, staging, destination);
      extensionManifestCache.delete(`user:${path.resolve(destination)}`);
      staging = "";

      const state = this.loadState();
      const stateKey = this.extensionStateKey(discovered.id, scopeId);
      const updateUrl =
        extensionUpdateUrl(options.updateUrl, { allowEmpty: true }) ||
        extensionUpdateUrl(discovered.manifest.updateUrl, { allowEmpty: true }) ||
        extensionUpdateUrl(options.fallbackUpdateUrl, { allowEmpty: true });
      state.enabled[stateKey] = false;
      state.grants[stateKey] = [];
      delete state.identities[stateKey];
      if (updateUrl) {
        state.updateSources[stateKey] = {
          ...(options.updateSha256 ? { sha256: options.updateSha256 } : {}),
          url: updateUrl,
        };
      } else delete state.updateSources[stateKey];
      this.saveState();
      this.verifiedFingerprints.delete(runtimeKey);
      this.scan(true);
      const installed = this.records.get(discovered.id);
      if (!installed)
        throw new Error(`Installed extension could not be discovered: ${discovered.id}`);
      this.emitScoped({
        type: "changed",
        extensionId: discovered.id,
        message: options.message,
      });
      return cloneRecord(installed);
    } finally {
      if (staging)
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async uninstall(
    extensionId: string,
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<boolean> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() => this.uninstall(extensionId, workspaceId, workspacePath));
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    const scopeId = this.workspaceId;
    this.scan(true);
    const record = this.requireRecord(extensionId);
    if (record.source !== "user")
      throw new Error("Only user-installed extensions can be uninstalled.");
    if (scopeId) {
      const runtimeKey = this.extensionRuntimeKey(extensionId, scopeId);
      await this.deactivateHost(extensionId, scopeId);
      this.activations.delete(runtimeKey);
      const target = safeExistingPath(this.userExtensionsRoot(scopeId), record.extensionPath);
      await fs.promises.rm(target, { recursive: true, force: true });
      this.deleteScopedExtensionState(extensionId, scopeId);
      this.saveState();
      this.verifiedFingerprints.delete(runtimeKey);
      this.scan(true);
      this.emitScoped({
        type: "changed",
        extensionId,
        message: "Extension removed from workspace.",
      });
      this.recordAudit({
        action: "uninstall",
        extensionId,
        message: "Extension removed from workspace.",
        outcome: "success",
      });
      return true;
    }
    const runtimeKey = this.extensionRuntimeKey(extensionId, "");
    await this.deactivateHost(extensionId, "");
    this.activations.delete(runtimeKey);
    const userRoot = this.userExtensionsRoot();
    const target = safeExistingPath(userRoot, record.extensionPath);
    await fs.promises.rm(target, { recursive: true, force: true });
    this.deleteScopedExtensionState(extensionId, "");
    this.saveState();
    this.verifiedFingerprints.delete(runtimeKey);
    this.scan(true);
    this.emitScoped({ type: "changed", extensionId, message: "Extension uninstalled." });
    this.recordAudit({
      action: "uninstall",
      extensionId,
      message: "Extension uninstalled.",
      outcome: "success",
    });
    return true;
  }

  async setEnabled(
    extensionId: string,
    enabled: boolean,
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<AppExtensionRecord> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.setEnabled(extensionId, enabled, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    this.scan(true);
    const record = this.requireRecord(extensionId);
    if (record.source === "builtin") return cloneRecord(record);
    if (enabled) {
      const missing = requestedPermissions(record.manifest).filter(
        (permission) => !record.grantedPermissions.includes(permission),
      );
      if (missing.length) {
        throw new Error(`Grant extension permissions before enabling: ${missing.join(", ")}`);
      }
      if (record.source === "workspace" && !record.workspaceTrusted) {
        const support = record.manifest.capabilities?.untrustedWorkspaces?.supported;
        if (support !== true && support !== "limited") {
          throw new Error("Trust this workspace before enabling its extension.");
        }
      }
      await this.verifyRecordIdentity(record);
    } else {
      await this.deactivateHost(extensionId);
      const runtimeKey = this.extensionRuntimeKey(extensionId);
      this.activations.delete(runtimeKey);
      this.verifiedFingerprints.delete(runtimeKey);
    }
    this.loadState().enabled[this.extensionStateKey(extensionId)] = enabled;
    this.saveState();
    this.scan(true);
    const updated = this.requireRecord(extensionId);
    this.emitScoped({
      type: "changed",
      extensionId,
      message: enabled ? "Extension enabled." : "Extension disabled.",
    });
    this.recordAudit({
      action: enabled ? "enable" : "disable",
      extensionId,
      message: enabled ? "Extension enabled." : "Extension disabled.",
      outcome: "success",
    });
    return cloneRecord(updated);
  }

  async grant(
    extensionId: string,
    permissions: AppExtensionPermission[],
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<AppExtensionRecord> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.grant(extensionId, permissions, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    this.scan(true);
    const record = this.requireRecord(extensionId);
    if (record.source === "builtin") return cloneRecord(record);
    const requested = new Set(requestedPermissions(record.manifest));
    const grants = permissions.filter((permission) => requested.has(permission));
    const state = this.loadState();
    const stateKey = this.extensionStateKey(extensionId);
    const previous = state.grants[stateKey] ?? [];
    if (record.enabled && previous.some((permission) => !grants.includes(permission))) {
      await this.deactivateHost(extensionId);
      this.activations.delete(this.extensionRuntimeKey(extensionId));
      state.enabled[stateKey] = false;
    }
    state.grants[stateKey] = [...new Set(grants)];
    state.identities[stateKey] = {
      scope: identityScope(record),
      fingerprint: await computePackageFingerprint(record.extensionPath, identityScope(record)),
    };
    this.saveState();
    this.verifiedFingerprints.delete(this.extensionRuntimeKey(extensionId));
    this.scan(true);
    this.emitScoped({ type: "changed", extensionId, message: "Extension permissions updated." });
    this.recordAudit({
      action: "grant",
      extensionId,
      message: "Extension permissions updated.",
      metadata: { permissions: state.grants[stateKey] },
      outcome: "success",
    });
    return cloneRecord(this.requireRecord(extensionId));
  }

  async setWorkspaceTrust(
    workspacePath: string,
    trusted: boolean,
    workspaceId?: string,
  ): Promise<boolean> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.setWorkspaceTrust(workspacePath, trusted, workspaceId),
      );
    }
    await this.ensureStateLoaded();
    const normalized = normalizeWorkspacePath(workspacePath);
    if (!normalized) throw new Error("A workspace path is required.");
    await this.useWorkspaceScope(normalized, workspaceId);
    const state = this.loadState();
    const paths = new Set(state.trustedWorkspaces.map(normalizeWorkspacePath));
    if (trusted) paths.add(normalized);
    else paths.delete(normalized);
    state.trustedWorkspaces = [...paths];
    if (!trusted) await this.deactivateContextExtensions();
    this.saveState();
    this.scan(true);
    this.emitScoped({
      type: "changed",
      message: trusted ? "Workspace trusted." : "Workspace trust removed.",
    });
    this.recordAudit({
      action: trusted ? "trustWorkspace" : "untrustWorkspace",
      message: trusted ? "Workspace trusted." : "Workspace trust removed.",
      outcome: "success",
      workspacePath: normalized,
    });
    return trusted;
  }

  async isWorkspaceTrusted(workspacePath: string): Promise<boolean> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() => this.isWorkspaceTrusted(workspacePath));
    }
    await this.ensureStateLoaded();
    return this.isWorkspaceTrustedLoaded(workspacePath);
  }

  private isWorkspaceTrustedLoaded(workspacePath: string): boolean {
    const normalized = normalizeWorkspacePath(workspacePath);
    return Boolean(
      normalized &&
      this.loadState().trustedWorkspaces.some(
        (candidate) => normalizeWorkspacePath(candidate) === normalized,
      ),
    );
  }

  async getConfiguration(
    extensionId: string,
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<{
    values: Record<string, unknown>;
    configuredSecrets: string[];
  }> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.getConfiguration(extensionId, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    this.scan();
    await this.reconcileCurrentHosts();
    this.scan(true);
    const record = this.requireRecord(extensionId);
    return this.configurationResult(record, this.workspaceId);
  }

  async updateConfiguration(
    extensionId: string,
    updates: Record<string, unknown>,
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<{ values: Record<string, unknown>; configuredSecrets: string[] }> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.updateConfiguration(extensionId, updates, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    this.scan(true);
    const record = this.requireRecord(extensionId);
    if (record.source === "builtin")
      throw new Error("Built-in extension configuration is managed by the application.");
    const properties = configurationProperties(record);
    const state = this.loadState();
    const stateKey = this.extensionStateKey(extensionId);
    const values = { ...(state.configuration[stateKey] ?? {}) };
    const secrets = { ...(state.secrets[stateKey] ?? {}) };
    for (const [key, value] of Object.entries(updates)) {
      const property = properties[key];
      if (!property) throw new Error(`Unknown extension configuration key: ${key}`);
      if (property.secret) {
        if (value === undefined || value === "") continue;
        if (value === null) {
          delete secrets[key];
          continue;
        }
        if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8_192) {
          throw new Error(`Secret configuration ${key} must be a string no larger than 8 KB.`);
        }
        secrets[key] = encryptExtensionSecret(value);
        continue;
      }
      if (!configurationValueMatches(property, value)) {
        throw new Error(`Invalid value for extension configuration ${key}.`);
      }
      if (value === undefined) delete values[key];
      else values[key] = value;
    }
    if (Buffer.byteLength(JSON.stringify(values), "utf8") > 256 * 1024) {
      throw new Error("Extension configuration exceeds the 256 KB limit.");
    }
    state.configuration[stateKey] = values;
    state.secrets[stateKey] = secrets;
    this.saveState();
    if (record.enabled && record.manifest.main) {
      const runtimeKey = this.extensionRuntimeKey(extensionId);
      const restartScope = this.hostScopes.get(runtimeKey);
      const restart = this.host.requestRestart(runtimeKey);
      this.restartingHosts.add(runtimeKey);
      this.activations.delete(runtimeKey);
      this.setRuntimeState(extensionId, "inactive");
      this.scan(true);
      try {
        await restart;
      } finally {
        this.restartingHosts.delete(runtimeKey);
        if (!restartScope || this.hostScopes.get(runtimeKey) === restartScope) {
          this.hostScopes.delete(runtimeKey);
        }
        this.scan(true);
      }
    }
    this.emitScoped({ type: "changed", extensionId, message: "Extension configuration updated." });
    return this.configurationResult(record, this.workspaceId);
  }

  async readAsset(
    extensionId: string,
    relativePath: string,
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<ExtensionAssetResult> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.readAsset(extensionId, relativePath, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    this.scan();
    await this.reconcileCurrentHosts();
    this.scan(true);
    const record = this.requireUsableRecord(extensionId);
    await this.verifyRecordIdentity(record);
    const assetPath = await safeExistingPathAsync(record.extensionPath, relativePath);
    const stat = await fs.promises.stat(assetPath);
    if (!stat.isFile()) throw new Error("Extension asset is not a file.");
    if (stat.size > MAX_ASSET_BYTES) throw new Error("Extension asset exceeds the 8 MB limit.");
    if (isUiAsset(record.manifest, relativePath) && stat.size > MAX_UI_ASSET_BYTES) {
      throw new Error("Extension UI and theme assets cannot exceed 1 MB.");
    }
    const mimeType = mimeTypeFor(assetPath);
    const text = isTextMime(mimeType);
    return {
      mimeType,
      encoding: text ? "utf8" : "base64",
      data: await fs.promises.readFile(assetPath, text ? "utf8" : "base64"),
    };
  }

  async activate(
    extensionId: string,
    event: string,
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<AppExtensionRecord> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.activate(extensionId, event, workspaceId, workspacePath),
      );
    }
    await this.ensureStateLoaded();
    await this.useWorkspaceScope(workspacePath, workspaceId);
    const runtimeKey = this.extensionRuntimeKey(extensionId);
    this.scan();
    await this.reconcileCurrentHosts();
    this.scan(true);
    const record = this.requireUsableRecord(extensionId);
    await this.verifyRecordIdentity(record);
    if (
      record.state === "active" &&
      this.hostScopes.has(runtimeKey) &&
      !this.restartingHosts.has(runtimeKey)
    ) {
      return cloneRecord(record);
    }
    if (!activationMatches(record.manifest.activationEvents, event)) {
      return cloneRecord(record);
    }
    const pending = this.activations.get(runtimeKey);
    if (pending) {
      await pending;
      return cloneRecord(this.requireRecord(extensionId));
    }
    const activation = this.activateRecord(record, extensionId, runtimeKey);
    this.activations.set(runtimeKey, activation);
    try {
      await activation;
    } finally {
      if (this.activations.get(runtimeKey) === activation) this.activations.delete(runtimeKey);
    }
    return cloneRecord(this.requireRecord(extensionId));
  }

  async executeCommand(
    extensionId: string,
    command: string,
    args: unknown[] = [],
    workspaceId?: string,
    workspacePath?: string,
  ): Promise<unknown> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.executeCommand(extensionId, command, args, workspaceId, workspacePath),
      );
    }
    const record = await this.activate(
      extensionId,
      `onCommand:${command}`,
      workspaceId,
      workspacePath,
    );
    if (!record.manifest.main) {
      throw new Error(`Extension command has no executable extension entry: ${command}`);
    }
    return this.host.executeCommand({
      hostKey: this.extensionRuntimeKey(extensionId),
      extensionId,
      command,
      args,
    });
  }

  async resolveAgentContributions(
    workspacePath: string,
    workspaceId = "",
    selectedExtensionIds?: string[],
  ): Promise<ResolvedAgentContributions> {
    if (!this.scopeOperationContext.getStore()) {
      return this.runScopeOperation(() =>
        this.resolveAgentContributions(workspacePath, workspaceId, selectedExtensionIds),
      );
    }
    await this.ensureStateLoaded();
    await this.switchWorkspace(
      normalizeWorkspacePath(workspacePath),
      normalizeWorkspaceId(workspaceId),
    );
    this.scan();
    await this.reconcileCurrentHosts();
    this.scan(true);
    const selected = selectedExtensionIds ? new Set(selectedExtensionIds) : null;
    const resolved: ResolvedAgentContributions = {
      extensionIds: [],
      mcpServers: [],
      skills: [],
      prompts: [],
      warnings: [],
    };
    for (const record of this.records.values()) {
      if (record.source === "builtin" || !record.enabled) continue;
      if (selected && record.source === "user" && !selected.has(record.id)) continue;
      const contributions = record.manifest.contributes;
      if (!contributions) continue;
      const hasAgentResources = Boolean(
        contributions.skills || contributions.mcpServers || contributions.prompts?.length,
      );
      if (!hasAgentResources) continue;
      if (record.source === "workspace" && !record.workspaceTrusted) {
        resolved.warnings.push(
          `${record.id}: workspace resources are disabled until the workspace is trusted.`,
        );
        continue;
      }
      if (record.state === "blocked") continue;
      try {
        await this.verifyRecordIdentity(record);
      } catch (error) {
        resolved.warnings.push(
          `${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const beforeMcp = resolved.mcpServers.length;
      const beforeSkills = resolved.skills.length;
      const beforePrompts = resolved.prompts.length;
      if (contributions.mcpServers && record.grantedPermissions.includes("agent.mcp")) {
        await this.resolveMcpServers(record, resolved);
      }
      if (contributions.skills && record.grantedPermissions.includes("agent.skills")) {
        this.resolveSkills(record, resolved);
      }
      if (contributions.prompts?.length && record.grantedPermissions.includes("agent.prompts")) {
        this.resolvePrompts(record, resolved);
      }
      if (
        resolved.mcpServers.length > beforeMcp ||
        resolved.skills.length > beforeSkills ||
        resolved.prompts.length > beforePrompts
      ) {
        resolved.extensionIds.push(record.id);
      }
    }
    return resolved;
  }

  async dispose(): Promise<void> {
    await this.scopeOperationQueue;
    await this.ensureStateLoaded();
    this.host.dispose();
    this.hostScopes.clear();
    this.restartingHosts.clear();
    await this.flushState();
    await this.stateStorage.close();
  }

  private runScopeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.scopeOperationQueue
      .catch(() => undefined)
      .then(() =>
        this.scopeOperationContext.run(true, async () => {
          try {
            return await operation();
          } finally {
            await this.flushState();
          }
        }),
      );
    this.scopeOperationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async useWorkspaceScope(workspacePath?: string, workspaceId?: string): Promise<void> {
    const nextWorkspaceId =
      workspaceId === undefined ? this.workspaceId : normalizeWorkspaceId(workspaceId);
    const suppliedPath =
      workspacePath === undefined ? undefined : normalizeWorkspacePath(workspacePath);
    const nextWorkspacePath =
      suppliedPath ??
      this.workspacePaths.get(nextWorkspaceId) ??
      (nextWorkspaceId === this.workspaceId ? this.workspacePath : "");
    if (suppliedPath !== undefined) this.workspacePaths.set(nextWorkspaceId, suppliedPath);
    await this.switchWorkspace(nextWorkspacePath, nextWorkspaceId);
  }

  private async switchWorkspace(nextWorkspacePath: string, nextWorkspaceId = ""): Promise<void> {
    const normalizedWorkspaceId = normalizeWorkspaceId(nextWorkspaceId);
    if (nextWorkspacePath === this.workspacePath && normalizedWorkspaceId === this.workspaceId)
      return;
    const previousScope = this.currentExecutionScope();
    const staleHosts = [...this.hostScopes.entries()].filter(([, scope]) =>
      sameExecutionScope(scope, previousScope),
    );
    await Promise.all(staleHosts.map(([hostKey]) => this.host.deactivate(hostKey)));
    for (const [hostKey] of staleHosts) {
      this.hostScopes.delete(hostKey);
      this.activations.delete(hostKey);
      this.restartingHosts.delete(hostKey);
    }
    this.workspacePath = nextWorkspacePath;
    this.workspaceId = normalizedWorkspaceId;
    this.workspacePaths.set(normalizedWorkspaceId, nextWorkspacePath);
    this.lastScanAt = 0;
    this.scan(true);
  }

  private async deactivateContextExtensions(): Promise<void> {
    const active = [...this.records.values()].filter((record) => record.source !== "builtin");
    await Promise.all(active.map((record) => this.deactivateHost(record.id)));
    for (const record of active) this.activations.delete(this.extensionRuntimeKey(record.id));
  }

  private async deactivateHost(extensionId: string, workspaceId = this.workspaceId): Promise<void> {
    const runtimeKey = this.extensionRuntimeKey(extensionId, workspaceId);
    await this.host.deactivate(runtimeKey);
    this.hostScopes.delete(runtimeKey);
    this.restartingHosts.delete(runtimeKey);
  }

  private async activateRecord(
    record: AppExtensionRecord,
    extensionId: string,
    runtimeKey: string,
  ): Promise<void> {
    this.setRuntimeState(extensionId, "activating");
    this.emitScoped({ type: "state", extensionId, state: "activating" });
    try {
      if (record.manifest.main) {
        if (!record.grantedPermissions.includes("runtime.fullTrust")) {
          throw new Error("Executable extensions require the runtime.fullTrust permission.");
        }
        if (record.source === "workspace" && !record.workspaceTrusted) {
          throw new Error("Trust this workspace before running extension code.");
        }
        const scope: ExtensionHostScope = {
          ...this.currentExecutionScope(),
          extensionId,
          extensionIdentity: identityScope(record),
        };
        const entry = await safeExistingPathAsync(record.extensionPath, record.manifest.main);
        const configuration = this.configurationSnapshot(record, scope);
        this.hostScopes.set(runtimeKey, scope);
        try {
          await this.host.activate({
            hostKey: runtimeKey,
            extensionId,
            extensionPath: record.extensionPath,
            main: entry,
            configuration: configuration.values,
            secrets: record.grantedPermissions.includes("secrets") ? configuration.secrets : {},
            globalState: this.extensionStorageSnapshot(extensionId, "global", scope),
            permissions: record.grantedPermissions,
            workspacePath: scope.workspacePath,
            workspaceState: this.extensionStorageSnapshot(extensionId, "workspace", scope),
          });
        } catch (error) {
          this.hostScopes.delete(runtimeKey);
          this.restartingHosts.delete(runtimeKey);
          throw error;
        }
      }
      this.restartingHosts.delete(runtimeKey);
      this.setRuntimeState(extensionId, "active");
    } catch (error) {
      this.restartingHosts.delete(runtimeKey);
      this.setRuntimeState(
        extensionId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      const current = this.records.get(extensionId) ?? record;
      this.emitScoped({
        type: "state",
        extensionId,
        state: current.state,
        message: current.statusMessage,
      });
    }
  }

  private async verifyRecordIdentity(record: AppExtensionRecord): Promise<void> {
    if (record.source === "builtin") return;
    const runtimeKey = this.extensionRuntimeKey(record.id);
    const state = this.loadState();
    const stateKey = this.extensionStateKey(record.id);
    const identity = state.identities[stateKey];
    const scope = identityScope(record);
    if (!identity || identity.scope !== scope) {
      await this.revokeChangedExtension(
        record,
        "Extension identity changed; permissions were revoked.",
      );
    }
    const expectedFingerprint = identity!.fingerprint;
    const cached = this.verifiedFingerprints.get(runtimeKey);
    if (
      cached?.fingerprint === expectedFingerprint &&
      Date.now() - cached.verifiedAt < FINGERPRINT_VERIFICATION_CACHE_MS
    ) {
      return;
    }
    const files = await packageFiles(record.extensionPath);
    const fingerprint = await computePackageFingerprint(record.extensionPath, scope, files);
    if (fingerprint !== expectedFingerprint) {
      await this.revokeChangedExtension(
        record,
        "Extension contents changed; permissions were revoked.",
      );
    }
    this.verifiedFingerprints.set(runtimeKey, { fingerprint, verifiedAt: Date.now() });
  }

  private async reconcileCurrentHosts(): Promise<void> {
    const currentScope = this.currentExecutionScope();
    const stale = [...this.hostScopes.entries()].filter(([, scope]) => {
      if (!sameExecutionScope(scope, currentScope)) return false;
      const record = this.records.get(scope.extensionId);
      return (
        !record ||
        !record.enabled ||
        record.state === "blocked" ||
        scope.extensionIdentity !== identityScope(record)
      );
    });
    await Promise.all(stale.map(([hostKey]) => this.host.deactivate(hostKey)));
    for (const [hostKey, scope] of stale) {
      if (this.hostScopes.get(hostKey) !== scope) continue;
      this.hostScopes.delete(hostKey);
      this.activations.delete(hostKey);
      this.restartingHosts.delete(hostKey);
    }
  }

  private async revokeChangedExtension(
    record: AppExtensionRecord,
    message: string,
  ): Promise<never> {
    const runtimeKey = this.extensionRuntimeKey(record.id);
    await this.deactivateHost(record.id);
    this.activations.delete(runtimeKey);
    this.verifiedFingerprints.delete(runtimeKey);
    const state = this.loadState();
    const stateKey = this.extensionStateKey(record.id);
    state.enabled[stateKey] = false;
    state.grants[stateKey] = [];
    delete state.identities[stateKey];
    this.saveState();
    this.scan(true);
    this.emitScoped({ type: "changed", extensionId: record.id, message });
    this.recordAudit({
      action: "identityRevoked",
      extensionId: record.id,
      message,
      outcome: "failure",
    });
    throw new Error(message);
  }

  private scan(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastScanAt < SCAN_CACHE_MS) return;
    this.lastScanAt = now;
    const previous = new Map(this.records);
    const discovered = new Map<string, DiscoveredExtension>();
    const builtin = builtinExtension();
    discovered.set(builtin.id, builtin);
    for (const item of scanExtensionRoot(this.userExtensionsRoot(this.workspaceId), "user")) {
      if (!discovered.has(item.id)) discovered.set(item.id, item);
    }
    if (this.workspacePath) {
      const workspaceRoot = path.join(this.workspacePath, ".agui", "extensions");
      for (const item of scanExtensionRoot(workspaceRoot, "workspace")) {
        if (!discovered.has(item.id)) discovered.set(item.id, item);
      }
    }

    const state = this.loadState();
    this.records.clear();
    for (const item of discovered.values()) {
      const requested = requestedPermissions(item.manifest);
      const stateKey = this.extensionStateKey(item.id);
      const identity = state.identities[stateKey];
      const scopeMatches = identity?.scope === discoveredIdentityScope(item);
      const grants =
        item.source === "builtin"
          ? requested
          : scopeMatches
            ? (state.grants[stateKey] ?? []).filter((permission) => requested.includes(permission))
            : [];
      const defaultEnabled = item.source === "builtin";
      const enabled =
        item.source === "builtin"
          ? true
          : scopeMatches && Boolean(state.enabled[stateKey] ?? defaultEnabled);
      const workspaceTrusted =
        item.source !== "workspace" || this.isWorkspaceTrustedLoaded(this.workspacePath);
      const updateUrl =
        item.source === "user"
          ? state.updateSources[stateKey]?.url || item.manifest.updateUrl
          : item.manifest.updateUrl;
      const updateSha256 =
        item.source === "user" ? state.updateSources[stateKey]?.sha256 : undefined;
      const missingGrants = requested.filter((permission) => !grants.includes(permission));
      const prior = previous.get(item.id);
      let extensionState: AppExtensionRecord["state"] = enabled ? "inactive" : "disabled";
      let statusMessage = item.warning;
      const runtimeKey = this.extensionRuntimeKey(item.id);
      if (enabled && missingGrants.length) {
        extensionState = "blocked";
        statusMessage = `Missing permissions: ${missingGrants.join(", ")}`;
      } else if (
        enabled &&
        item.source === "workspace" &&
        !workspaceTrusted &&
        item.manifest.capabilities?.untrustedWorkspaces?.supported !== true &&
        item.manifest.capabilities?.untrustedWorkspaces?.supported !== "limited"
      ) {
        extensionState = "blocked";
        statusMessage = "Workspace trust is required.";
      } else if (
        enabled &&
        this.hostScopes.has(runtimeKey) &&
        !this.restartingHosts.has(runtimeKey)
      ) {
        extensionState = "active";
      } else if (
        prior &&
        prior.enabled === enabled &&
        ["active", "activating", "error"].includes(prior.state)
      ) {
        extensionState = prior.state;
        statusMessage = prior.statusMessage;
      }
      this.records.set(item.id, {
        id: item.id,
        manifest: item.manifest,
        source: item.source,
        extensionPath: item.extensionPath,
        ...(updateUrl ? { updateUrl } : {}),
        ...(updateSha256 ? { updateSha256 } : {}),
        enabled,
        security: this.securitySummary(item, requested, grants, scopeMatches),
        state: extensionState,
        statusMessage,
        grantedPermissions: grants,
        workspaceTrusted,
      });
    }
    for (const [id, record] of previous) {
      if (!this.records.has(id) && record.source !== "builtin") {
        const runtimeKey = this.extensionRuntimeKey(id);
        void this.deactivateHost(id);
        this.activations.delete(runtimeKey);
      }
    }
  }

  private async resolveMcpServers(
    record: AppExtensionRecord,
    output: ResolvedAgentContributions,
  ): Promise<void> {
    const contribution = record.manifest.contributes?.mcpServers;
    const sources: Array<{ label: string; servers: Record<string, unknown> }> = [];
    if (contribution && typeof contribution === "object" && !Array.isArray(contribution)) {
      const root = objectValue(contribution);
      sources.push({
        label: "inline MCP configuration",
        servers: objectValue(root.mcpServers ?? root.mcp_servers ?? root),
      });
    }
    for (const configPath of arrayValue(contribution)) {
      try {
        const absolute = safeExistingPath(record.extensionPath, configPath);
        const configStat = fs.statSync(absolute);
        if (!configStat.isFile() || configStat.size > 1024 * 1024) {
          throw new Error(`MCP configuration exceeds the 1 MB limit: ${configPath}`);
        }
        const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
        const root = objectValue(parsed);
        sources.push({
          label: configPath,
          servers: objectValue(root.mcpServers ?? root.mcp_servers ?? parsed),
        });
      } catch (error) {
        output.warnings.push(
          `${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const configuration = this.configurationSnapshot(record);
    const secretValues = record.grantedPermissions.includes("secrets") ? configuration.secrets : {};
    const configurationValues = configuration.values;
    for (const source of sources) {
      for (const [serverId, rawServer] of Object.entries(source.servers).slice(0, 50)) {
        try {
          const server = objectValue(rawServer);
          const commandValue = stringValue(server.command);
          const command =
            commandValue.startsWith("./") || commandValue.startsWith("../")
              ? safeExistingPath(record.extensionPath, commandValue)
              : commandValue || undefined;
          const env = limitedStringRecord(server.env, 50, 8192);
          const headers =
            limitedStringRecord(server.http_headers, 50, 8192) ??
            limitedStringRecord(server.headers, 50, 8192);
          if (
            !record.grantedPermissions.includes("secrets") &&
            (recordRequiresSecrets(env) || recordRequiresSecrets(headers))
          ) {
            output.warnings.push(
              `${record.id}/${serverId}: secrets permission is required for sensitive MCP configuration.`,
            );
            continue;
          }
          const resolvedEnv = resolveMcpVariableRecord(env, secretValues, configurationValues);
          const resolvedHeaders = resolveMcpVariableRecord(
            headers,
            secretValues,
            configurationValues,
          );
          const unresolvedVariables = [
            ...unresolvedMcpVariableKeys("env", resolvedEnv),
            ...unresolvedMcpVariableKeys("headers", resolvedHeaders),
          ];
          if (unresolvedVariables.length) {
            output.warnings.push(
              `${record.id}/${serverId}: unresolved variable references in ${unresolvedVariables.join(", ")}.`,
            );
            continue;
          }
          const id = `${safeIdentifier(record.id)}_${safeIdentifier(serverId)}`;
          const url = stringValue(server.url) || undefined;
          const resolved: ResolvedExtensionMcpServer = {
            id,
            name: stringValue(server.name) || serverId,
            extensionId: record.id,
            command,
            args: stringArray(server.args)
              ?.slice(0, 100)
              .map((value) => value.slice(0, 8192)),
            env: resolvedEnv,
            headers: resolvedHeaders,
            type: mcpTransportType(
              stringValue(server.type) || stringValue(server.transport),
              url ? "http" : "stdio",
            ),
            url,
            metadata: {
              sourceExtensionId: record.id,
              originalId: serverId,
              source: source.label,
            },
          };
          if (!resolved.command && !resolved.url) {
            output.warnings.push(`${record.id}/${serverId}: MCP server requires command or url.`);
            continue;
          }
          if (resolved.command && !record.grantedPermissions.includes("process.spawn")) {
            output.warnings.push(
              `${record.id}/${serverId}: process.spawn permission is required for command-based MCP servers.`,
            );
            continue;
          }
          if (resolved.url) {
            if (!record.grantedPermissions.includes("network")) {
              output.warnings.push(
                `${record.id}/${serverId}: network permission is required for remote MCP servers.`,
              );
              continue;
            }
            const safeUrl = safeMcpUrl(resolved.url);
            if (!safeUrl) {
              output.warnings.push(
                `${record.id}/${serverId}: MCP URL must use HTTPS or loopback HTTP.`,
              );
              continue;
            }
            resolved.url = safeUrl;
          }
          output.mcpServers.push(resolved);
        } catch (error) {
          output.warnings.push(
            `${record.id}/${serverId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  private resolveSkills(record: AppExtensionRecord, output: ResolvedAgentContributions): void {
    const skillRoots = arrayValue(record.manifest.contributes?.skills);
    for (const rootPath of skillRoots) {
      try {
        const absolute = safeExistingPath(record.extensionPath, rootPath);
        const candidates = fs.existsSync(path.join(absolute, "SKILL.md"))
          ? [absolute]
          : fs
              .readdirSync(absolute, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => path.join(absolute, entry.name));
        for (const skillPath of candidates.slice(0, 100)) {
          let manifestPath: string;
          try {
            manifestPath = safeExistingPath(skillPath, "SKILL.md");
          } catch {
            continue;
          }
          const stat = fs.statSync(manifestPath);
          if (!stat.isFile() || stat.size > 256 * 1024) {
            output.warnings.push(`${record.id}: skill manifest exceeds the 256 KB limit.`);
            continue;
          }
          const frontmatter = parseFrontmatter(fs.readFileSync(manifestPath, "utf8"));
          const localName = frontmatter.name || path.basename(skillPath);
          const skill: ResolvedExtensionSkill = {
            id: `${record.id}/${path.basename(skillPath)}`,
            name: localName,
            description: frontmatter.description || undefined,
            extensionId: record.id,
            path: skillPath,
            manifestPath,
            hasScripts: fs.existsSync(path.join(skillPath, "scripts")),
          };
          output.skills.push(skill);
        }
      } catch (error) {
        output.warnings.push(
          `${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private resolvePrompts(record: AppExtensionRecord, output: ResolvedAgentContributions): void {
    for (const contribution of (record.manifest.contributes?.prompts ?? []).slice(0, 100)) {
      try {
        let content = stringValue(contribution.content);
        if (contribution.path) {
          const promptPath = safeExistingPath(record.extensionPath, contribution.path);
          const stat = fs.statSync(promptPath);
          if (!stat.isFile() || stat.size > 256 * 1024)
            throw new Error(`Prompt exceeds the 256 KB limit: ${contribution.id}`);
          content = fs.readFileSync(promptPath, "utf8");
        }
        if (!content) throw new Error(`Prompt contribution has no content: ${contribution.id}`);
        const prompt: ResolvedExtensionPrompt = {
          id: contribution.id,
          title: stringValue(contribution.title) || contribution.id,
          description: stringValue(contribution.description) || undefined,
          content: content.slice(0, 256 * 1024),
          extensionId: record.id,
          autoInclude: contribution.autoInclude === true,
        };
        output.prompts.push(prompt);
      } catch (error) {
        output.warnings.push(
          `${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private configurationResult(
    record: AppExtensionRecord,
    workspaceId = this.workspaceId,
    workspacePath?: string,
  ): { values: Record<string, unknown>; configuredSecrets: string[] } {
    const properties = configurationProperties(record);
    const stateKey = this.extensionStateKey(record.id, workspaceId, workspacePath);
    const stored = this.loadState().configuration[stateKey] ?? {};
    const values: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(properties)) {
      if (property.secret) continue;
      values[key] = stored[key] === undefined ? property.default : stored[key];
    }
    const configuredSecrets = Object.keys(this.loadState().secrets[stateKey] ?? {}).filter((key) =>
      Boolean(properties[key]?.secret),
    );
    return { values, configuredSecrets };
  }

  private configurationSnapshot(
    record: AppExtensionRecord,
    scope = this.currentExecutionScope(),
  ): {
    values: Record<string, unknown>;
    secrets: Record<string, string>;
  } {
    const values = this.configurationResult(record, scope.workspaceId, scope.workspacePath).values;
    const encrypted =
      this.loadState().secrets[
        this.extensionStateKey(record.id, scope.workspaceId, scope.workspacePath)
      ] ?? {};
    const properties = configurationProperties(record);
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(encrypted)) {
      if (!properties[key]?.secret) continue;
      try {
        secrets[key] = decryptExtensionSecret(value);
      } catch {
        // Ignore secrets that cannot be decrypted on the current OS account.
      }
    }
    return { values, secrets };
  }

  private async updateExtensionStorage(
    hostKey: string,
    extensionId: string,
    scope: "global" | "workspace",
    key: string,
    value: unknown,
  ): Promise<void> {
    const executionScope = this.hostScopes.get(hostKey);
    if (!executionScope) throw new Error(`Extension host is not active: ${extensionId}`);
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(key)) {
      throw new Error("Extension storage keys must be 1-200 safe characters.");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error(`Extension storage value for ${key} must be JSON serializable.`);
    }
    if (Buffer.byteLength(serialized ?? "", "utf8") > 64 * 1024) {
      throw new Error(`Extension storage value exceeds the 64 KB limit for ${key}.`);
    }
    const state = this.loadState();
    const workspaceStorageKey = this.storageWorkspaceKey(executionScope);
    const storageKey = this.extensionStateKey(
      extensionId,
      executionScope.workspaceId,
      executionScope.workspacePath,
    );
    const existing = state.storage[storageKey];
    const storage = existing
      ? {
          global: cloneJsonRecord(existing.global),
          workspaces: Object.fromEntries(
            Object.entries(existing.workspaces).map(([workspace, values]) => [
              workspace,
              cloneJsonRecord(values),
            ]),
          ),
        }
      : { global: {}, workspaces: {} };
    const target =
      scope === "global" ? storage.global : (storage.workspaces[workspaceStorageKey] ?? {});
    if (value === undefined) delete target[key];
    else if (serialized !== undefined) target[key] = JSON.parse(serialized) as unknown;
    if (scope === "workspace") storage.workspaces[workspaceStorageKey] = target;
    const total = Buffer.byteLength(JSON.stringify(storage), "utf8");
    if (total > 512 * 1024) {
      throw new Error("Extension storage update exceeds the 512 KB quota.");
    }
    state.storage[storageKey] = storage;
    await this.saveState();
  }

  private extensionStorageSnapshot(
    extensionId: string,
    scope: "global" | "workspace",
    executionScope = this.currentExecutionScope(),
  ): Record<string, unknown> {
    const storage =
      this.loadState().storage[
        this.extensionStateKey(
          extensionId,
          executionScope.workspaceId,
          executionScope.workspacePath,
        )
      ];
    if (!storage) return {};
    return cloneJsonRecord(
      scope === "global"
        ? storage.global
        : (storage.workspaces[this.storageWorkspaceKey(executionScope)] ?? {}),
    );
  }

  private storageWorkspaceKey(scope = this.currentExecutionScope()): string {
    return scope.workspaceId
      ? createHash("sha256").update(`workspace:${scope.workspaceId}`).digest("hex")
      : scope.workspacePath
        ? createHash("sha256").update(scope.workspacePath).digest("hex")
        : "no-workspace";
  }

  private currentExecutionScope(): ExtensionExecutionScope {
    return {
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
    };
  }

  private isCurrentScope(scope: ExtensionExecutionScope | undefined): boolean {
    return Boolean(scope && sameExecutionScope(scope, this.currentExecutionScope()));
  }

  private emitScoped(
    event: ExtensionRuntimeEvent,
    scope: ExtensionExecutionScope | undefined = this.currentExecutionScope(),
  ): void {
    this.emit(
      scope
        ? { ...event, workspaceId: scope.workspaceId, workspacePath: scope.workspacePath }
        : event,
    );
  }

  private extensionStateKey(
    extensionId: string,
    workspaceId = this.workspaceId,
    _workspacePath?: string,
  ): string {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (!normalizedWorkspaceId) return extensionId;
    const scope = `workspace:${normalizedWorkspaceId}`;
    return `workspace:${createHash("sha256").update(scope).digest("hex")}:${extensionId}`;
  }

  private extensionRuntimeKey(extensionId: string, workspaceId = this.workspaceId): string {
    return this.extensionStateKey(extensionId, workspaceId);
  }

  private securitySummary(
    item: DiscoveredExtension,
    requested: AppExtensionPermission[],
    grants: AppExtensionPermission[],
    verifiedIdentity: boolean,
  ): AppExtensionSecuritySummary {
    const permissions = new Set(requested);
    const granted = new Set(grants);
    const riskReasons: string[] = [];
    const requiresFullTrust = permissions.has("runtime.fullTrust");
    const hasProcessSpawn = permissions.has("process.spawn");
    const hasWorkspaceWrite = permissions.has("workspace.write");
    const hasNetworkAccess = permissions.has("network") || permissions.has("ui.webview");
    const hasSecrets = permissions.has("secrets");
    if (requiresFullTrust) riskReasons.push("Runs extension code in the host runtime.");
    if (hasProcessSpawn) riskReasons.push("Can start local processes.");
    if (hasWorkspaceWrite) riskReasons.push("Can write inside the workspace.");
    if (hasSecrets) riskReasons.push("Can access configured extension secrets.");
    if (permissions.has("ui.overrideBuiltins"))
      riskReasons.push("Can override built-in UI surfaces.");
    if (permissions.has("ui.webview")) riskReasons.push("Can render webview content.");
    const highRisk = requiresFullTrust || hasProcessSpawn || hasWorkspaceWrite;
    const mediumRisk =
      !highRisk &&
      (hasNetworkAccess ||
        hasSecrets ||
        permissions.has("ui.overrideBuiltins") ||
        granted.size > 4);
    const stateKey = this.extensionStateKey(item.id);
    const fingerprint = this.loadState().identities[stateKey]?.fingerprint;
    return {
      fingerprint,
      hasNetworkAccess,
      hasProcessSpawn,
      hasSecrets,
      hasWorkspaceWrite,
      requiresFullTrust,
      riskLevel: highRisk ? "high" : mediumRisk ? "medium" : "low",
      riskReasons,
      verifiedIdentity: item.source === "builtin" || verifiedIdentity,
    };
  }

  private recordAudit(
    input: Omit<ExtensionAuditRecord, "at" | "id" | "workspaceId" | "workspacePath"> & {
      workspaceId?: string;
      workspacePath?: string;
    },
  ): void {
    const state = this.loadState();
    const entry: ExtensionAuditRecord = {
      action: input.action,
      at: Date.now(),
      extensionId: input.extensionId,
      id: `audit:${randomUUID()}`,
      message: input.message,
      metadata: input.metadata,
      outcome: input.outcome,
      workspaceId: input.workspaceId ?? this.workspaceId,
      workspacePath: input.workspacePath ?? this.workspacePath,
    };
    state.auditLog = [entry, ...state.auditLog].slice(0, 200);
    void this.saveState();
  }

  private deleteScopedExtensionState(extensionId: string, workspaceId: string): void {
    const state = this.loadState();
    const stateKey = this.extensionStateKey(extensionId, workspaceId);
    delete state.enabled[stateKey];
    delete state.grants[stateKey];
    delete state.identities[stateKey];
    delete state.updateSources[stateKey];
    delete state.configuration[stateKey];
    delete state.secrets[stateKey];
    delete state.storage[stateKey];
  }

  private requireRecord(extensionId: string): AppExtensionRecord {
    const record = this.records.get(extensionId);
    if (!record) throw new Error(`Extension is not installed: ${extensionId}`);
    return record;
  }

  private requireUsableRecord(extensionId: string): AppExtensionRecord {
    const record = this.requireRecord(extensionId);
    if (!record.enabled) throw new Error(`Extension is disabled: ${extensionId}`);
    if (record.state === "blocked")
      throw new Error(record.statusMessage || `Extension is blocked: ${extensionId}`);
    return record;
  }

  private setRuntimeState(
    extensionId: string,
    state: AppExtensionRecord["state"],
    statusMessage?: string,
  ): void {
    const current = this.records.get(extensionId);
    if (!current) return;
    current.state = state;
    current.statusMessage = statusMessage;
  }

  private userExtensionsRoot(workspaceId = ""): string {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (!normalizedWorkspaceId) return path.join(this.aguiHomeRoot(), USER_EXTENSIONS_DIRECTORY);
    return path.join(
      this.aguiHomeRoot(),
      "workspaces",
      createHash("sha256").update(normalizedWorkspaceId).digest("hex"),
      USER_EXTENSIONS_DIRECTORY,
    );
  }

  private aguiHomeRoot(): string {
    const override = process.env.AG_UI_HOME || process.env.AGUI_HOME;
    if (override?.trim()) return path.resolve(override.trim());
    return path.join(app.getPath("home"), AGUI_HOME_DIRECTORY);
  }

  private loadState(): PersistedExtensionState {
    if (this.state) return this.state;
    throw new Error("Extension state is not loaded.");
  }

  private saveState(): Promise<void> {
    const value = JSON.stringify(this.loadState());
    this.stateSaveQueue = this.stateSaveQueue
      .catch(() => undefined)
      .then(() => this.stateStorage.set({ key: "state", value }))
      .then(() => undefined);
    void this.stateSaveQueue.catch((error: unknown) => {
      this.emit({
        type: "changed",
        message: `Extension state persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
    return this.stateSaveQueue;
  }

  private async flushState(): Promise<void> {
    const pending = this.stateSaveQueue;
    try {
      await pending;
    } finally {
      if (this.stateSaveQueue === pending) this.stateSaveQueue = Promise.resolve();
    }
  }

  private async ensureStateLoaded(): Promise<void> {
    await this.stateReady;
  }

  private async initializeState(): Promise<void> {
    const stored = await this.stateStorage.get({ key: "state" });
    if (stored) {
      try {
        this.state = normalizePersistedExtensionState(JSON.parse(stored) as unknown);
        return;
      } catch {
        // Fall through to an empty state.
      }
    }
    this.state = emptyPersistedExtensionState();
    await this.stateStorage.set({ key: "state", value: JSON.stringify(this.state) });
  }
}

function normalizePersistedExtensionState(value: unknown): PersistedExtensionState {
  const temporary = path.join(
    os.tmpdir(),
    `agui-extension-state-${process.pid}-${Date.now()}.json`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
    return readPersistedExtensionState(temporary) ?? emptyPersistedExtensionState();
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function extensionMarketplaceSources(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = [env.AG_UI_EXTENSION_MARKETPLACE_URLS, env.AGUI_EXTENSION_MARKETPLACE_URLS]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");
  return [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function readMarketplaceCatalog(source: string): Promise<unknown> {
  const url = safeMarketplaceCatalogUrl(source);
  if (url) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok)
      throw new Error(`Marketplace catalog request failed: HTTP ${response.status}`);
    const content = await response.text();
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) {
      throw new Error("Marketplace catalog exceeds the 2 MB limit.");
    }
    return JSON.parse(content) as unknown;
  }
  const catalogPath = path.resolve(source);
  const stat = await fs.promises.stat(catalogPath);
  if (!stat.isFile()) throw new Error("Marketplace catalog source is not a file.");
  if (stat.size > 2 * 1024 * 1024) throw new Error("Marketplace catalog exceeds the 2 MB limit.");
  return JSON.parse(await fs.promises.readFile(catalogPath, "utf8")) as unknown;
}

function safeMarketplaceCatalogUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return parsed.href;
    if (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    ) {
      return parsed.href;
    }
    throw new Error("Marketplace catalog URL must use HTTPS.");
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function marketplaceCatalogItems(catalog: unknown): ExtensionMarketplaceItem[] {
  const root = objectValue(catalog);
  const entries = Array.isArray(catalog)
    ? catalog
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.extensions)
        ? root.extensions
        : [];
  return entries
    .map((item) => {
      try {
        return normalizeMarketplaceItem(item);
      } catch {
        return null;
      }
    })
    .filter((item): item is ExtensionMarketplaceItem => Boolean(item));
}

function normalizeMarketplaceItem(value: unknown): ExtensionMarketplaceItem | null {
  const record = objectValue(value);
  const name = marketplaceName(record.name);
  const publisher = marketplaceName(record.publisher);
  const id = stringValue(record.id) || (name && publisher ? `${publisher}.${name}` : "");
  const version = stringValue(record.version);
  if (!id || !publisher || !version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return null;
  }
  const sourceUrl = extensionUpdateUrl(record.sourceUrl || record.packageUrl || record.url);
  const updateUrl = extensionUpdateUrl(record.updateUrl || sourceUrl, { allowEmpty: true });
  const sha256 = normalizeSha256(record.sha256);
  const releaseChannel = marketplaceReleaseChannel(record.releaseChannel);
  const permissions = marketplacePermissions(record.permissions);
  const categories = stringArray(record.categories)?.slice(0, 12);
  if (!sha256) return null;
  return {
    categories,
    description: stringValue(record.description) || undefined,
    displayName: stringValue(record.displayName) || id,
    downloads: finiteMetric(record.downloads),
    homepage: marketplaceHttpsUrl(record.homepage),
    id,
    license: stringValue(record.license) || undefined,
    permissions,
    publisher,
    rating: finiteMetric(record.rating, 0, 5),
    releaseChannel,
    sha256,
    sourceUrl,
    updateUrl: updateUrl || sourceUrl,
    updatedAt: finiteMetric(record.updatedAt),
    verifiedPublisher: record.verifiedPublisher === true,
    version,
  };
}

function marketplaceName(value: unknown): string {
  const text = stringValue(value);
  return /^[a-z0-9][a-z0-9-]*$/.test(text) ? text : "";
}

function marketplaceReleaseChannel(value: unknown): ExtensionMarketplaceItem["releaseChannel"] {
  return value === "beta" || value === "dev" ? value : "stable";
}

function marketplacePermissions(value: unknown): AppExtensionPermission[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = new Set<AppExtensionPermission>(
    APP_EXTENSION_PERMISSIONS as unknown as AppExtensionPermission[],
  );
  const permissions = value.filter((item): item is AppExtensionPermission =>
    valid.has(item as AppExtensionPermission),
  );
  return permissions.length ? [...new Set(permissions)] : undefined;
}

function marketplaceHttpsUrl(value: unknown): string | undefined {
  try {
    return extensionUpdateUrl(value, { allowEmpty: true }) || undefined;
  } catch {
    return undefined;
  }
}

function marketplaceItemMatches(item: ExtensionMarketplaceItem, query: string): boolean {
  const haystack = [
    item.id,
    item.displayName,
    item.description,
    item.publisher,
    item.version,
    ...(item.categories ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function compareMarketplaceItems(
  left: ExtensionMarketplaceItem,
  right: ExtensionMarketplaceItem,
): number {
  return (
    Number(right.verifiedPublisher) - Number(left.verifiedPublisher) ||
    (right.rating ?? 0) - (left.rating ?? 0) ||
    left.displayName.localeCompare(right.displayName)
  );
}

async function downloadExtensionPackage(
  url: string,
  destination: string,
  options: { expectedSha256?: string } = {},
): Promise<void> {
  const expectedSha256 = requireExpectedSha256(options.expectedSha256);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Extension update download failed: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > EXTENSION_PACKAGE_DOWNLOAD_LIMIT_BYTES) {
    throw new Error("Extension update package exceeds the 100 MB limit.");
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length > EXTENSION_PACKAGE_DOWNLOAD_LIMIT_BYTES) {
    throw new Error("Extension update package exceeds the 100 MB limit.");
  }
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Extension package SHA-256 did not match the marketplace metadata.");
  }
  await fs.promises.writeFile(destination, content, { flag: "wx" });
}

function requireExpectedSha256(value: unknown): string {
  const hash = normalizeSha256(value);
  if (!hash) {
    throw new Error("Remote extension downloads require valid SHA-256 integrity metadata.");
  }
  return hash;
}

function normalizeSha256(value: unknown): string | undefined {
  const hash = stringValue(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

function finiteMetric(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWorkspaceId(value: string): string {
  if (value.length > 512) throw new Error("Workspace IDs cannot exceed 512 characters.");
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Workspace IDs cannot contain control characters.");
  }
  if (value !== value.trim()) {
    throw new Error("Workspace IDs cannot contain leading or trailing whitespace.");
  }
  return value;
}

function sameExecutionScope(
  left: ExtensionExecutionScope,
  right: ExtensionExecutionScope,
): boolean {
  return left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath;
}

function resolveMcpVariableRecord(
  record: Record<string, string> | undefined,
  secretValues: Record<string, string>,
  configurationValues: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const resolved = value
        .replace(/\$\{secret:([^}]+)\}/g, (match, name: string) => secretValues[name] ?? match)
        .replace(/\$\{config:([^}]+)\}/g, (match, name: string) => {
          const serialized = serializedMcpConfigurationValue(configurationValues[name]);
          return serialized === undefined ? match : serialized;
        });
      return [key, resolved];
    }),
  );
}

function unresolvedMcpVariableKeys(
  label: string,
  record: Record<string, string> | undefined,
): string[] {
  return Object.entries(record ?? {})
    .filter(([, value]) => /\$\{(?:secret|config):[^}]+\}/.test(value))
    .map(([key]) => `${label}.${key}`);
}

function serializedMcpConfigurationValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized && Buffer.byteLength(serialized, "utf8") <= 8192 ? serialized : undefined;
}

function mcpTransportType(
  value: string,
  fallback: NonNullable<ResolvedExtensionMcpServer["type"]>,
): NonNullable<ResolvedExtensionMcpServer["type"]> {
  const normalized = value.toLowerCase().replace(/[-_]/g, "");
  if (normalized === "streamablehttp") return "streamablehttp";
  if (normalized === "http" || normalized === "sse" || normalized === "stdio") return normalized;
  return fallback;
}
