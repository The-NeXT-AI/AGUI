import path from "node:path";
import { serialize } from "node:v8";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import type { AppExtensionPermission } from "@the-next-ai/extensions";

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
  process: UtilityProcess;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  idleWaiters: Array<() => void>;
  restartRequested: boolean;
  restartPromise?: Promise<void>;
  stopping: boolean;
};

/**
 * Runs each executable extension in a dedicated utility process. This is an
 * availability and revocation boundary, not a filesystem sandbox: executable
 * extensions are explicitly treated as full-trust Node.js programs.
 */
export class ExtensionHostClient {
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

  async activate(input: {
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
  }): Promise<void> {
    const hostKey = input.hostKey || input.extensionId;
    const existing = this.hosts.get(hostKey);
    if (existing?.restartRequested) await this.waitForRestart(existing);
    const state = this.ensureProcess(hostKey, input.extensionId);
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
      // Cooperative cleanup is best-effort. Killing the dedicated host is what
      // makes disable/uninstall/workspace-trust revocation deterministic.
      this.stopHost(state, "Extension deactivated.", false);
    }
  }

  dispose(): void {
    for (const state of [...this.hosts.values()]) {
      this.stopHost(state, "Extension host stopped.", false);
    }
  }

  private ensureProcess(hostKey: string, extensionId: string): HostState {
    const existing = this.hosts.get(hostKey);
    if (existing) return existing;
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const child = utilityProcess.fork(path.join(currentDirectory, "extension-host.js"), [], {
      serviceName: `AGUI Extension Host: ${extensionId}`,
      stdio: "pipe",
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
    child.on("exit", (code) => {
      if (this.hosts.get(hostKey) !== state) return;
      this.hosts.delete(hostKey);
      const detail = `Extension host exited${code == null ? "" : ` with code ${code}`}.`;
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
        state.process.postMessage({ requestId, type, payload });
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
          state.process.postMessage({
            type: "storage-result",
            storageRequestId: message.storageRequestId,
            ok: true,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.onLog(state.hostKey, state.extensionId, detail);
          try {
            state.process.postMessage({
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
