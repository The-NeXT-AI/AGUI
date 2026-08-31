import { serialize } from "node:v8";
import { pathToFileURL } from "node:url";

const MAX_HOST_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024;

type ParentPort = {
  on(event: "message", listener: (event: { data: HostRequest | StorageReply }) => void): void;
  postMessage(message: unknown): void;
};

type HostRequest = {
  requestId: number;
  type: "activate" | "deactivate" | "executeCommand";
  payload: Record<string, unknown>;
};

type StorageReply = {
  type: "storage-result";
  storageRequestId: number;
  ok: boolean;
  error?: string;
};

type CommandHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type ExtensionCleanup = (() => void | Promise<void>) | undefined;

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort)
  throw new Error("AGUI extension host requires an Electron utility-process parent port.");

const commandHandlers = new Map<string, CommandHandler>();
let activeExtensionId = "";
let cleanup: ExtensionCleanup;
let activation: Promise<void> | null = null;
let nextStorageRequestId = 1;
const pendingStorageUpdates = new Map<
  number,
  {
    resolve(): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }
>();

parentPort.on("message", (event) => {
  if (event.data.type === "storage-result") {
    handleStorageReply(event.data);
    return;
  }
  const request = event.data;
  void handle(request).then(
    (result) => {
      assertMessageSize(result, "Extension result");
      parentPort.postMessage({ requestId: request.requestId, ok: true, result });
    },
    (error) =>
      parentPort.postMessage({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});

async function handle(request: HostRequest): Promise<unknown> {
  assertMessageSize(request.payload, "Extension request");
  if (request.type === "activate") return activateOnce(request.payload);
  if (request.type === "deactivate") return deactivate(String(request.payload.extensionId ?? ""));
  if (request.type === "executeCommand") {
    const extensionId = String(request.payload.extensionId ?? "");
    if (!activeExtensionId || extensionId !== activeExtensionId) {
      throw new Error(`Extension is not active in this host: ${extensionId}`);
    }
    const command = String(request.payload.command ?? "");
    const handler = commandHandlers.get(command);
    if (!handler) throw new Error(`Extension command is not registered: ${command}`);
    const args = Array.isArray(request.payload.args) ? request.payload.args : [];
    return handler(...args);
  }
  throw new Error(`Unknown extension host request: ${request.type}`);
}

async function activateOnce(payload: Record<string, unknown>): Promise<void> {
  if (activeExtensionId) {
    if (activeExtensionId !== String(payload.extensionId ?? "")) {
      throw new Error("An extension host cannot activate more than one extension.");
    }
    return;
  }
  if (!activation) activation = activate(payload);
  try {
    await activation;
  } finally {
    activation = null;
  }
}

async function activate(payload: Record<string, unknown>): Promise<void> {
  const extensionId = String(payload.extensionId ?? "");
  const hostKey = String(payload.hostKey ?? extensionId);
  const extensionPath = String(payload.extensionPath ?? "");
  const main = String(payload.main ?? "");
  const configuration = recordValue(payload.configuration);
  const secrets = stringRecord(payload.secrets);
  const globalState = recordValue(payload.globalState);
  const workspaceState = recordValue(payload.workspaceState);
  const permissions = stringArray(payload.permissions);
  const workspacePath = String(payload.workspacePath ?? "");
  if (!extensionId || !extensionPath || !main)
    throw new Error("Invalid extension activation payload.");

  const subscriptions: Array<{ dispose(): void | Promise<void> }> = [];
  try {
    // The process is destroyed on deactivation, so a cache-busting URL is not
    // required and cannot accumulate stale ESM module instances.
    const extensionModule = (await import(pathToFileURL(main).href)) as {
      activate?: (context: unknown) => unknown | Promise<unknown>;
      deactivate?: () => unknown | Promise<unknown>;
    };
    if (typeof extensionModule.activate !== "function") {
      throw new Error(`${extensionId} does not export activate(context).`);
    }

    const context = {
      extensionId,
      extensionPath,
      permissions: Object.freeze([...permissions]),
      workspace: Object.freeze({
        root:
          workspacePath &&
          (permissions.includes("workspace.read") || permissions.includes("workspace.write"))
            ? workspacePath
            : undefined,
        canRead: permissions.includes("workspace.read") || permissions.includes("workspace.write"),
        canWrite: permissions.includes("workspace.write"),
      }),
      subscriptions,
      commands: {
        registerCommand(command: string, handler: CommandHandler) {
          if (!command || typeof handler !== "function") {
            throw new Error("registerCommand requires a command id and handler.");
          }
          if (!command.startsWith(`${extensionId}.`) && !command.startsWith(`${extensionId}/`)) {
            throw new Error(`Extension command must use the ${extensionId} namespace.`);
          }
          commandHandlers.set(command, handler);
          const disposable = {
            dispose: () => {
              commandHandlers.delete(command);
            },
          };
          subscriptions.push(disposable);
          return disposable;
        },
      },
      configuration: {
        get: <T = unknown>(key: string, fallback?: T): T | undefined =>
          configuration[key] === undefined ? fallback : (configuration[key] as T),
      },
      secrets: {
        get: (key: string) => secrets[key],
      },
      globalState: extensionStateStore(hostKey, extensionId, "global", globalState),
      workspaceState: extensionStateStore(hostKey, extensionId, "workspace", workspaceState),
      log: {
        info: (...values: unknown[]) => log(extensionId, values),
        warn: (...values: unknown[]) => log(extensionId, values, "warn"),
        error: (...values: unknown[]) => log(extensionId, values, "error"),
      },
    };
    const activated = await extensionModule.activate(context);
    const returnedCleanup = typeof activated === "function" ? (activated as () => void) : undefined;
    cleanup = async () => {
      if (returnedCleanup) await returnedCleanup();
      if (typeof extensionModule.deactivate === "function") await extensionModule.deactivate();
      await disposeSubscriptions(subscriptions);
      commandHandlers.clear();
    };
    activeExtensionId = extensionId;
  } catch (error) {
    await disposeSubscriptions(subscriptions);
    commandHandlers.clear();
    throw error;
  }
}

async function deactivate(extensionId: string): Promise<void> {
  if (activeExtensionId && extensionId !== activeExtensionId) return;
  const current = cleanup;
  cleanup = undefined;
  activeExtensionId = "";
  try {
    await current?.();
  } finally {
    commandHandlers.clear();
  }
}

async function disposeSubscriptions(
  subscriptions: Array<{ dispose(): void | Promise<void> }>,
): Promise<void> {
  for (const subscription of subscriptions.splice(0).reverse()) {
    try {
      await subscription.dispose();
    } catch {
      // Continue cleanup so a single faulty disposable cannot retain handlers.
    }
  }
}

function log(extensionId: string, values: unknown[], level = "info"): void {
  const message = values.map(formatLogValue).join(" ");
  parentPort?.postMessage({
    type: "log",
    extensionId,
    message: `[${level}] ${truncateUtf8(message, MAX_LOG_BYTES)}`,
  });
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= maxBytes
    ? value
    : `${buffer.subarray(0, maxBytes).toString("utf8")}…`;
}

function assertMessageSize(value: unknown, label: string): void {
  try {
    if (serialize(value).byteLength > MAX_HOST_MESSAGE_BYTES) {
      throw new Error(`${label} exceeds the 2 MB IPC limit.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("IPC limit")) throw error;
    throw new Error(`${label} is not serializable.`);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function extensionStateStore(
  hostKey: string,
  extensionId: string,
  scope: "global" | "workspace",
  state: Record<string, unknown>,
) {
  return {
    get: <T = unknown>(key: string, fallback?: T): T | undefined =>
      state[key] === undefined ? fallback : (state[key] as T),
    update: async (key: string, value: unknown): Promise<void> => {
      if (!/^[a-zA-Z0-9._-]{1,200}$/.test(key))
        throw new Error("Extension storage keys must be 1-200 safe characters.");
      assertMessageSize(value, "Extension storage value");
      await sendStorageUpdate(hostKey, extensionId, scope, key, value);
      if (value === undefined) delete state[key];
      else state[key] = value;
    },
  };
}

function sendStorageUpdate(
  hostKey: string,
  extensionId: string,
  scope: "global" | "workspace",
  key: string,
  value: unknown,
): Promise<void> {
  const storageRequestId = nextStorageRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingStorageUpdates.delete(storageRequestId);
      reject(new Error("Extension storage update timed out."));
    }, 10_000);
    pendingStorageUpdates.set(storageRequestId, { resolve, reject, timeout });
    try {
      parentPort?.postMessage({
        type: "storage-update",
        storageRequestId,
        hostKey,
        extensionId,
        scope,
        key,
        value,
      });
    } catch (error) {
      clearTimeout(timeout);
      pendingStorageUpdates.delete(storageRequestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function handleStorageReply(reply: StorageReply): void {
  const pending = pendingStorageUpdates.get(reply.storageRequestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingStorageUpdates.delete(reply.storageRequestId);
  if (reply.ok) pending.resolve();
  else pending.reject(new Error(reply.error || "Extension storage update failed."));
}
