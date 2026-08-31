import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import type { AppExtensionPermission } from "@agui/extensions";

const HOST_REQUEST_TIMEOUT_MS = 10_000;
const HOST_COMMAND_TIMEOUT_MS = 60_000;
const HOST_DEACTIVATE_TIMEOUT_MS = 2_000;
const MAX_HOST_MESSAGE_BYTES = 2 * 1024 * 1024;

type HostReply = {
  requestId?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  type?: "log" | "storage-update";
  hostKey?: string;
  extensionId?: string;
  message?: string;
  scope?: "global" | "workspace";
  key?: string;
  value?: unknown;
  storageRequestId?: number;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

type HostState = {
  hostKey: string;
  extensionId: string;
  process: ChildProcess;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  idleWaiters: Array<() => void>;
  restartRequested: boolean;
  restartPromise?: Promise<void>;
  stopping: boolean;
};

type ExtensionActivationInput = {
  hostKey?: string;
  extensionId: string;
  extensionPath: string;
  main: string;
  configuration?: Record<string, unknown>;
  secrets?: Record<string, string>;
  globalState?: Record<string, unknown>;
  workspacePath?: string;
  workspaceState?: Record<string, unknown>;
  permissions?: AppExtensionPermission[];
};

/**
 * Runs each executable extension in a dedicated Node child process. This is an
 * availability and revocation boundary, not a filesystem sandbox: executable
 * extensions are explicitly treated as full-trust Node.js programs.
 */
export class ServerExtensionHostClient {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    private readonly onLog: (hostKey: string, extensionId: string, message: string) => void,
    private readonly onExit: (hostKey: string, extensionId: string, message: string) => void,
    private readonly onStorageUpdate: (
      hostKey: string,
      extensionId: string,
      scope: "global" | "workspace",
      key: string,
      value: unknown,
    ) => void | Promise<void>,
  ) {}

  async activate(input: ExtensionActivationInput): Promise<void> {
    const hostKey = input.hostKey || input.extensionId;
    const existing = this.hosts.get(hostKey);
    if (existing?.restartRequested) await this.waitForRestart(existing);
    const state = this.ensureProcess({ ...input, hostKey });
    try {
      await this.request(state, "activate", { ...input, hostKey });
    } catch (error) {
      this.stopHost(state, errorMessage(error));
      throw error;
    }
  }

  async executeCommand(input: {
    hostKey?: string;
    extensionId: string;
    command: string;
    args: unknown[];
  }): Promise<unknown> {
    const hostKey = input.hostKey || input.extensionId;
    let state = this.hosts.get(hostKey);
    if (state?.restartRequested) {
      await this.waitForRestart(state);
      state = this.hosts.get(hostKey);
    }
    if (!state) throw new Error(`Extension host is not active: ${input.extensionId}`);
    return this.request(state, "executeCommand", input, HOST_COMMAND_TIMEOUT_MS);
  }

  requestRestart(hostKey: string): Promise<void> {
    const state = this.hosts.get(hostKey);
    if (!state || state.stopping) return Promise.resolve();
    state.restartRequested = true;
    state.restartPromise ??= this.restartWhenIdle(state)
      .catch((error) => {
        this.onLog(
          state.hostKey,
          state.extensionId,
          `Extension restart after configuration update failed: ${errorMessage(error)}`,
        );
      })
      .finally(() => {
        if (this.hosts.get(hostKey) === state) {
          state.restartRequested = false;
          state.restartPromise = undefined;
        }
      });
    return state.restartPromise;
  }

  async deactivate(hostKey: string): Promise<void> {
    const state = this.hosts.get(hostKey);
    if (!state) return;
    try {
      await this.request(
        state,
        "deactivate",
        { extensionId: state.extensionId },
        HOST_DEACTIVATE_TIMEOUT_MS,
      );
    } catch (error) {
      this.onLog(
        state.hostKey,
        state.extensionId,
        `Extension cleanup failed and its host was terminated: ${errorMessage(error)}`,
      );
    } finally {
      this.stopHost(state, "Extension deactivated.", false);
    }
  }

  dispose(): void {
    for (const state of [...this.hosts.values()]) {
      this.stopHost(state, "Extension host stopped.", false);
    }
  }

  private ensureProcess(input: ExtensionActivationInput): HostState {
    const { extensionId } = input;
    const hostKey = input.hostKey || extensionId;
    const existing = this.hosts.get(hostKey);
    if (existing) return existing;
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const hostPath = path.join(currentDirectory, "server-extension-host.js");
    const policy = extensionHostProcessPolicy({
      extensionId,
      extensionPath: input.extensionPath,
      hostPath,
      permissions: input.permissions ?? [],
      workspacePath: input.workspacePath,
    });
    if (policy.warning) this.onLog(hostKey, extensionId, policy.warning);
    const child = fork(hostPath, [], {
      cwd: policy.cwd,
      env: policy.env,
      execArgv: policy.execArgv,
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const state: HostState = {
      hostKey,
      extensionId,
      process: child,
      nextRequestId: 1,
      pending: new Map(),
      idleWaiters: [],
      restartRequested: false,
      stopping: false,
    };
    child.on("message", (message) => {
      void this.handleMessage(state, message as HostReply);
    });
    child.on("exit", (code, signal) => {
      if (this.hosts.get(hostKey) !== state) return;
      this.hosts.delete(hostKey);
      const detail = `Extension host exited${
        code == null ? "" : ` with code ${code}`
      }${signal ? ` (${signal})` : ""}.`;
      this.rejectPending(state, detail);
      if (!state.stopping) this.onExit(hostKey, extensionId, detail);
    });
    child.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim().slice(0, 16_384);
      if (message) this.onLog(hostKey, extensionId, message);
    });
    this.hosts.set(hostKey, state);
    return state;
  }

  private request(
    state: HostState,
    type: string,
    payload: unknown,
    timeoutMs = HOST_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    assertMessageSize(payload, `Extension host request ${type}`);
    const requestId = state.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(requestId);
        this.notifyIdle(state);
        const detail = timeoutDetail(type, payload, timeoutMs);
        reject(new Error(detail));
        this.stopHost(state, detail);
      }, timeoutMs);
      state.pending.set(requestId, { resolve, reject, timeout });
      try {
        if (!state.process.connected) {
          throw new Error("Extension host IPC channel is closed.");
        }
        state.process.send({ requestId, type, payload });
      } catch (error) {
        clearTimeout(timeout);
        state.pending.delete(requestId);
        this.notifyIdle(state);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleMessage(state: HostState, message: HostReply): Promise<void> {
    if (message.type === "log") {
      this.onLog(state.hostKey, state.extensionId, String(message.message ?? "").slice(0, 16_384));
      return;
    }
    if (message.type === "storage-update") {
      if (
        (message.scope === "global" || message.scope === "workspace") &&
        typeof message.key === "string" &&
        Number.isSafeInteger(message.storageRequestId)
      ) {
        try {
          assertMessageSize(message.value, "Extension storage update");
          await this.onStorageUpdate(
            typeof message.hostKey === "string" ? message.hostKey : state.hostKey,
            state.extensionId,
            message.scope,
            message.key,
            message.value,
          );
          state.process.send({
            type: "storage-result",
            storageRequestId: message.storageRequestId,
            ok: true,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.onLog(state.hostKey, state.extensionId, detail);
          try {
            state.process.send({
              type: "storage-result",
              storageRequestId: message.storageRequestId,
              ok: false,
              error: detail.slice(0, 16_384),
            });
          } catch {
            // The dedicated host may already be stopping.
          }
        }
      }
      return;
    }
    if (typeof message.requestId !== "number") return;
    const pending = state.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    state.pending.delete(message.requestId);
    if (message.ok) {
      try {
        assertMessageSize(message.result, "Extension host response");
        pending.resolve(message.result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } else {
      pending.reject(new Error(message.error || "Extension host request failed."));
    }
    this.notifyIdle(state);
  }

  private stopHost(state: HostState, detail: string, reject = true): void {
    if (state.stopping) return;
    state.stopping = true;
    if (this.hosts.get(state.hostKey) === state) this.hosts.delete(state.hostKey);
    if (reject) this.rejectPending(state, detail);
    else this.rejectPending(state, "Extension host stopped.");
    state.process.kill();
    if (reject) this.onExit(state.hostKey, state.extensionId, detail);
  }

  private rejectPending(state: HostState, detail: string): void {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(detail));
    }
    state.pending.clear();
    this.notifyIdle(state);
  }

  private async restartWhenIdle(state: HostState): Promise<void> {
    await this.waitForIdle(state);
    if (this.hosts.get(state.hostKey) !== state || state.stopping) return;
    await this.deactivate(state.hostKey);
  }

  private waitForRestart(state: HostState): Promise<void> {
    return state.restartPromise ?? Promise.resolve();
  }

  private waitForIdle(state: HostState): Promise<void> {
    if (state.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      state.idleWaiters.push(resolve);
    });
  }

  private notifyIdle(state: HostState): void {
    if (state.pending.size > 0) return;
    const waiters = state.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function assertMessageSize(value: unknown, label: string): void {
  let size: number;
  try {
    size = serialize(value).byteLength;
  } catch (error) {
    throw new Error(`${label} is not serializable: ${errorMessage(error)}`);
  }
  if (size > MAX_HOST_MESSAGE_BYTES) {
    throw new Error(`${label} exceeds the 2 MB IPC limit.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutDetail(type: string, payload: unknown, timeoutMs: number): string {
  const suffix = commandTimeoutSuffix(type, payload);
  return `Extension host request timed out: ${type}${suffix} after ${Math.round(timeoutMs / 1000)}s`;
}

function commandTimeoutSuffix(type: string, payload: unknown): string {
  if (type !== "executeCommand" || !payload || typeof payload !== "object") return "";
  const record = payload as { extensionId?: unknown; command?: unknown };
  const extensionId = typeof record.extensionId === "string" ? record.extensionId : "";
  const command = typeof record.command === "string" ? record.command : "";
  if (!extensionId && !command) return "";
  return ` (${[extensionId, command].filter(Boolean).join(":")})`;
}

type ExtensionHostProcessPolicyInput = {
  extensionId: string;
  extensionPath: string;
  hostPath: string;
  permissions: AppExtensionPermission[];
  workspacePath?: string;
};

type ExtensionHostProcessPolicy = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execArgv: string[];
  warning?: string;
};

const DEFAULT_EXTENSION_HOST_ENV_ALLOWLIST = [
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
];

function extensionHostProcessPolicy(
  input: ExtensionHostProcessPolicyInput,
): ExtensionHostProcessPolicy {
  const permissions = new Set(input.permissions);
  const cwd = canonicalPath(input.extensionPath);
  const env = extensionHostEnvironment(input);
  const execArgv = extensionHostMemoryArgs();
  let warning: string | undefined;

  if (nodePermissionModelDisabled()) {
    warning = "Server extension host Node permission model is disabled by configuration.";
    return { cwd, env, execArgv, warning };
  }
  if (!nodePermissionModelSupported()) {
    warning = "Server extension host Node permission model is unavailable in this Node runtime.";
    return { cwd, env, execArgv, warning };
  }

  execArgv.push("--experimental-permission");
  for (const readable of extensionHostReadRoots(input, permissions)) {
    execArgv.push(`--allow-fs-read=${readable}`);
  }
  for (const writable of extensionHostWriteRoots(input, permissions)) {
    execArgv.push(`--allow-fs-write=${writable}`);
  }
  if (permissions.has("process.spawn")) execArgv.push("--allow-child-process");
  return { cwd, env, execArgv };
}

function extensionHostReadRoots(
  input: ExtensionHostProcessPolicyInput,
  permissions: Set<AppExtensionPermission>,
): string[] {
  const roots = [serverPackageRoot(input.hostPath), input.extensionPath];
  if (input.workspacePath && permissions.has("workspace.read")) roots.push(input.workspacePath);
  if (input.workspacePath && permissions.has("workspace.write")) roots.push(input.workspacePath);
  return uniquePaths(roots.flatMap(pathPermissionVariants));
}

function extensionHostWriteRoots(
  input: ExtensionHostProcessPolicyInput,
  permissions: Set<AppExtensionPermission>,
): string[] {
  if (!input.workspacePath || !permissions.has("workspace.write")) return [];
  return pathPermissionVariants(input.workspacePath);
}

function extensionHostEnvironment(input: ExtensionHostProcessPolicyInput): NodeJS.ProcessEnv {
  const allowlist = configuredEnvAllowlist();
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.AGUI_EXTENSION_HOST = "server";
  env.AGUI_EXTENSION_HOST_KIND = "workspace";
  env.AGUI_EXTENSION_ID = input.extensionId;
  env.AGUI_EXTENSION_PATH = input.extensionPath;
  if (
    input.workspacePath &&
    (input.permissions.includes("workspace.read") || input.permissions.includes("workspace.write"))
  ) {
    env.AG_UI_WORKSPACE = input.workspacePath;
  }
  return env;
}

function configuredEnvAllowlist(): string[] {
  const configured =
    process.env.AG_UI_EXTENSION_HOST_ENV_ALLOWLIST ?? process.env.AGUI_EXTENSION_HOST_ENV_ALLOWLIST;
  const raw = configured?.trim()
    ? configured.split(/[,\s]+/).filter(Boolean)
    : DEFAULT_EXTENSION_HOST_ENV_ALLOWLIST;
  return [...new Set(raw.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))];
}

function extensionHostMemoryArgs(): string[] {
  const raw =
    process.env.AG_UI_EXTENSION_HOST_MAX_OLD_SPACE_MB ??
    process.env.AGUI_EXTENSION_HOST_MAX_OLD_SPACE_MB;
  const value = Number(raw ?? 256);
  if (!Number.isInteger(value) || value < 64 || value > 8192) return ["--max-old-space-size=256"];
  return [`--max-old-space-size=${value}`];
}

function nodePermissionModelDisabled(): boolean {
  const raw =
    process.env.AG_UI_EXTENSION_HOST_NODE_PERMISSIONS ??
    process.env.AGUI_EXTENSION_HOST_NODE_PERMISSIONS;
  return /^(0|false|off|no)$/i.test(String(raw ?? ""));
}

function nodePermissionModelSupported(): boolean {
  return (
    process.allowedNodeEnvironmentFlags.has("--experimental-permission") &&
    process.allowedNodeEnvironmentFlags.has("--allow-fs-read") &&
    process.allowedNodeEnvironmentFlags.has("--allow-fs-write") &&
    process.allowedNodeEnvironmentFlags.has("--allow-child-process")
  );
}

function serverPackageRoot(hostPath: string): string {
  let directory = path.dirname(path.resolve(hostPath));
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.dirname(path.resolve(hostPath));
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values)];
}

function pathPermissionVariants(value: string): string[] {
  const resolved = path.resolve(value);
  return uniquePaths([resolved, canonicalPath(resolved)]);
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
