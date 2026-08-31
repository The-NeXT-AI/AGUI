import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import WebSocket, { type RawData } from "ws";
import { connectRuntimeAdapter } from "./asp-runtime-adapters.js";
import { splitProviderCommand } from "./provider-store.js";
import { ensureProviderCli, runtimeEnvironment } from "./runtime-adapters/shared.js";
import type { AspProvider, AspProviderTransport } from "./types.js";

export type TransportCloseResult = {
  code?: number;
  exitCode?: number | null;
  reason?: string;
  signal?: NodeJS.Signals | null;
};

export type AspTransportConnection = {
  send(message: Record<string, unknown>): void;
  close(): void;
  onMessage(handler: (message: unknown) => void): void;
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: (result: TransportCloseResult) => void): void;
};

export type ConnectAspInput = {
  provider: AspProvider;
  cwd: string;
  env?: Record<string, string>;
  runEnvironment?: Record<string, string | undefined>;
};

const gracefulExitTimeoutMs = 1_000;
const forceKillTimeoutMs = 4_000;
const persistentStdioConnections = new Map<string, PersistentStdioProcess>();

export async function connectAspTransport(input: ConnectAspInput): Promise<AspTransportConnection> {
  const runtimeAdapter = connectRuntimeAdapter(input);
  if (runtimeAdapter) return runtimeAdapter;
  const transport = input.provider.transport;
  if (transport === "stdio") {
    return connectStdio(input);
  }
  if (transport === "persistent-stdio") return connectPersistentStdio(input);
  if (transport === "websocket") return connectWebSocket(requireUrl(input.provider));
  if (transport === "ssh") return connectSsh(input);
  throw new Error(`Unsupported ASP transport: ${transport satisfies never}`);
}

export function disposePersistentTransports(): void {
  for (const process of persistentStdioConnections.values()) process.close();
  persistentStdioConnections.clear();
}

export function isSuccessfulClose(
  transport: AspProviderTransport,
  result: TransportCloseResult,
): boolean {
  if (transport === "websocket" || (transport === "ssh" && result.code !== undefined)) {
    return result.code === 1000 || result.code === 1005;
  }
  return result.exitCode === 0;
}

function connectStdio(input: ConnectAspInput): AspTransportConnection {
  const { args, command } = localProviderCommand(input.provider);
  if (!command) throw new Error(`${input.provider.name} ASP stdio transport requires a command.`);
  const env = processEnvironment(input.provider.env, input.env, input.runEnvironment);
  ensureProviderCli(input.provider, input.cwd, env);
  const child = spawn(command, args, {
    cwd: input.cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return childConnection(child);
}

function connectPersistentStdio(input: ConnectAspInput): AspTransportConnection {
  const { args, command } = localProviderCommand(input.provider);
  if (!command) {
    throw new Error(`${input.provider.name} ASP persistent-stdio transport requires a command.`);
  }
  const key = persistentStdioKey(input, command, args);
  let process = persistentStdioConnections.get(key);
  if (!process || process.closed) {
    const env = processEnvironment(input.provider.env, input.env);
    ensureProviderCli(input.provider, input.cwd, env);
    const child = spawn(command, args, {
      cwd: input.cwd,
      // Persistent providers receive per-run state in ASP messages, so the
      // process environment is limited to stable provider/workspace values.
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    process = new PersistentStdioProcess(child, () => {
      if (persistentStdioConnections.get(key) === process) persistentStdioConnections.delete(key);
    });
    persistentStdioConnections.set(key, process);
  }
  return process.connect();
}

async function connectSsh(input: ConnectAspInput): Promise<AspTransportConnection> {
  const target = parseSshTarget(requireUrl(input.provider));
  if (target.remotePort) return connectSshTunnel(input, target);
  if (!input.provider.command) {
    throw new Error(`${input.provider.name} ASP SSH stdio transport requires a remote command.`);
  }
  assertReadable(target.identityFile, "SSH private key");
  assertReadable(target.configFile, "SSH config");
  const remote = buildRemoteCommand(input);
  const child = spawn("ssh", ["-T", ...sshConnectionArgs(target), target.destination, remote], {
    env: processEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return childConnection(child);
}

async function connectSshTunnel(
  input: ConnectAspInput,
  target: SshTarget,
): Promise<AspTransportConnection> {
  assertReadable(target.identityFile, "SSH private key");
  assertReadable(target.configFile, "SSH config");
  const localPort = await availablePort();
  const remotePort = target.remotePort!;
  const remoteCommand = input.provider.command
    ? buildRemoteCommand(input, {
        ASP_HOST: target.remoteHost,
        ASP_PATH: target.path,
        ASP_PORT: String(remotePort),
        ASP_TRANSPORT: "websocket",
      })
    : "";
  const args = [
    "-T",
    ...sshConnectionArgs(target),
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${localPort}:${target.remoteHost}:${remotePort}`,
  ];
  if (!remoteCommand) args.push("-N");
  args.push(target.destination);
  if (remoteCommand) args.push(remoteCommand);
  const child = spawn("ssh", args, {
    env: processEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return connectTunnelSocket(child, `ws://127.0.0.1:${localPort}${target.path}`);
}

function childConnection(child: ChildProcessWithoutNullStreams): AspTransportConnection {
  const connection = new CallbackConnection({
    send: (message) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    },
    close: () => closeProcess(child),
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim()) emitJsonOrStdout(connection, line, `${line}\n`);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => connection.emitStderr(chunk));
  child.on("error", (error) => connection.emitError(error));
  child.on("close", (exitCode, signal) => {
    lines.close();
    connection.emitClose({ exitCode, signal });
  });
  return connection;
}

class PersistentStdioProcess {
  readonly connections = new Set<CallbackConnection>();
  closed = false;
  private readonly lines: readline.Interface;
  private readonly requestOwners = new Map<string, CallbackConnection>();
  private readonly runOwners = new Map<string, CallbackConnection>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onClosed: () => void,
  ) {
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      this.routeStdoutLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const connection of this.connections) connection.emitStderr(chunk);
    });
    child.on("error", (error) => {
      for (const connection of this.connections) connection.emitError(error);
    });
    child.on("close", (exitCode, signal) => {
      this.closed = true;
      this.lines.close();
      const result = { exitCode, signal };
      for (const connection of this.connections) {
        connection.emitClose(result);
        connection.clearHandlers();
      }
      this.connections.clear();
      this.onClosed();
    });
  }

  connect(): AspTransportConnection {
    const connection = new CallbackConnection({
      send: (message) => this.send(connection, message),
      close: () => {
        this.removeConnection(connection);
        connection.clearHandlers();
      },
    });
    if (this.closed) {
      queueMicrotask(() => connection.emitClose({ reason: "persistent stdio process closed" }));
      return connection;
    }
    this.connections.add(connection);
    return connection;
  }

  close(): void {
    closeProcess(this.child);
  }

  private send(connection: CallbackConnection, message: Record<string, unknown>): void {
    const requestId = outgoingRequestId(message);
    if (requestId !== undefined) {
      const current = this.requestOwners.get(requestId);
      if (current && current !== connection) {
        connection.emitError(
          new Error(`ASP persistent-stdio request id is already in use: ${requestId}`),
        );
        return;
      }
      this.requestOwners.set(requestId, connection);
    }
    const runId = outgoingRunId(message);
    if (runId) {
      const current = this.runOwners.get(runId);
      if (current && current !== connection) {
        connection.emitError(new Error(`ASP persistent-stdio run id is already in use: ${runId}`));
        return;
      }
      this.runOwners.set(runId, connection);
    }
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private routeStdoutLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.routeUnscoped((connection) => connection.emitStdout(`${line}\n`), "non-JSON stdout");
      return;
    }
    const source = messageRecord(message);
    const responseId = incomingResponseId(source);
    if (responseId !== undefined) {
      const owner = this.requestOwners.get(responseId);
      if (owner) {
        this.requestOwners.delete(responseId);
        owner.emitMessage(message);
        return;
      }
      this.emitRoutingError(
        `ASP persistent-stdio received a response for unknown or completed request ${String(responseId)}.`,
      );
      return;
    }
    const runId = incomingRunId(source);
    if (runId) {
      const owner = this.runOwners.get(runId);
      if (owner) {
        owner.emitMessage(message);
        return;
      }
      this.emitRoutingError(`ASP persistent-stdio received an event for unknown run ${runId}.`);
      return;
    }
    this.routeUnscoped(
      (connection) => connection.emitMessage(message),
      "unscoped protocol message",
    );
  }

  private routeUnscoped(
    deliver: (connection: CallbackConnection) => void,
    description: string,
  ): void {
    const runConnections = new Set(this.runOwners.values());
    if (runConnections.size === 1) {
      const connection = [...runConnections][0];
      if (connection) deliver(connection);
      return;
    }
    const requestConnections = new Set(this.requestOwners.values());
    if (!runConnections.size && requestConnections.size === 1) {
      const connection = [...requestConnections][0];
      if (connection) deliver(connection);
      return;
    }
    if (this.connections.size === 1) {
      const connection = [...this.connections][0];
      if (connection) deliver(connection);
      return;
    }
    this.emitRoutingError(
      `ASP persistent-stdio cannot safely route ${description}; include a request id or runId.`,
    );
  }

  private emitRoutingError(message: string): void {
    const error = new Error(message);
    for (const connection of this.connections) connection.emitError(error);
  }

  private removeConnection(connection: CallbackConnection): void {
    this.connections.delete(connection);
    for (const [id, owner] of this.requestOwners) {
      if (owner === connection) this.requestOwners.delete(id);
    }
    for (const [id, owner] of this.runOwners) {
      if (owner === connection) this.runOwners.delete(id);
    }
  }
}

function connectWebSocket(url: string): Promise<AspTransportConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const connection = webSocketConnection(socket);
    let opened = false;
    socket.once("open", () => {
      opened = true;
      resolve(connection);
    });
    socket.once("error", (error) => {
      if (!opened) reject(error);
    });
  });
}

function webSocketConnection(socket: WebSocket, closeExtra?: () => void): CallbackConnection {
  const connection = new CallbackConnection({
    send: (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close: () => {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close(1000);
      }
      closeExtra?.();
    },
  });
  socket.on("message", (data) => {
    for (const frame of splitPayload(data)) emitJsonOrStdout(connection, frame, frame);
  });
  socket.on("error", (error) => connection.emitError(error));
  socket.on("close", (code, reason) => {
    connection.emitClose({ code, reason: reason.toString("utf8") });
    closeExtra?.();
  });
  return connection;
}

function connectTunnelSocket(
  child: ChildProcessWithoutNullStreams,
  url: string,
): Promise<AspTransportConnection> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    let stderr = "";
    let opened = false;
    let stopped = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      stopped = true;
      if (!opened) {
        reject(
          new Error(
            `ASP SSH tunnel closed before ${url} opened (code ${code}, signal ${signal}).${stderr ? `\n${stderr}` : ""}`,
          ),
        );
      }
    });

    const tryConnect = () => {
      if (stopped) return;
      const socket = new WebSocket(url);
      let settled = false;
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        opened = true;
        resolve(webSocketConnection(socket, () => closeProcess(child)));
      });
      const retry = () => {
        if (settled) return;
        settled = true;
        socket.close();
        if (Date.now() >= deadline) {
          closeProcess(child);
          reject(
            new Error(
              `ASP SSH tunnel did not expose ${url} within 15000ms.${stderr ? `\n${stderr}` : ""}`,
            ),
          );
        } else {
          setTimeout(tryConnect, 150).unref();
        }
      };
      socket.once("error", retry);
      socket.once("close", retry);
    };
    tryConnect();
  });
}

class CallbackConnection implements AspTransportConnection {
  private readonly messageHandlers = new Set<(value: unknown) => void>();
  private readonly stdoutHandlers = new Set<(value: string) => void>();
  private readonly stderrHandlers = new Set<(value: string) => void>();
  private readonly errorHandlers = new Set<(value: Error) => void>();
  private readonly closeHandlers = new Set<(value: TransportCloseResult) => void>();
  private closeResult: TransportCloseResult | null = null;

  constructor(
    private readonly handlers: {
      send(message: Record<string, unknown>): void;
      close(): void;
    },
  ) {}

  send(message: Record<string, unknown>): void {
    this.handlers.send(message);
  }
  close(): void {
    this.handlers.close();
  }
  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.add(handler);
  }
  onStdout(handler: (chunk: string) => void): void {
    this.stdoutHandlers.add(handler);
  }
  onStderr(handler: (chunk: string) => void): void {
    this.stderrHandlers.add(handler);
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.add(handler);
  }
  onClose(handler: (result: TransportCloseResult) => void): void {
    this.closeHandlers.add(handler);
    if (this.closeResult) handler(this.closeResult);
  }
  clearHandlers(): void {
    this.messageHandlers.clear();
    this.stdoutHandlers.clear();
    this.stderrHandlers.clear();
    this.errorHandlers.clear();
    this.closeHandlers.clear();
  }
  emitMessage(value: unknown): void {
    for (const handler of this.messageHandlers) handler(value);
  }
  emitStdout(value: string): void {
    for (const handler of this.stdoutHandlers) handler(value);
  }
  emitStderr(value: string): void {
    for (const handler of this.stderrHandlers) handler(value);
  }
  emitError(value: Error): void {
    for (const handler of this.errorHandlers) handler(value);
  }
  emitClose(value: TransportCloseResult): void {
    if (this.closeResult) return;
    this.closeResult = value;
    for (const handler of this.closeHandlers) handler(value);
  }
}

type SshTarget = {
  destination: string;
  port?: string;
  identityFile?: string;
  configFile?: string;
  options: string[];
  remoteHost: string;
  remotePort?: number;
  path: string;
};

function parseSshTarget(value: string): SshTarget {
  const source = value.startsWith("ssh://") ? new URL(value) : new URL(`ssh://${value}`);
  if (!source.hostname) throw new Error("ASP SSH transport requires a host.");
  const get = (...names: string[]) => {
    for (const name of names) {
      const candidate = source.searchParams.get(name)?.trim();
      if (candidate) return candidate;
    }
    return "";
  };
  const username = decodeURIComponent(source.username || "");
  const rawPath =
    get("path", "aspPath") || (source.pathname !== "/" ? source.pathname : "") || "/asp";
  return {
    destination: username ? `${username}@${source.hostname}` : source.hostname,
    port: source.port || undefined,
    identityFile: expandHome(get("identityFile", "keyFile")) || undefined,
    configFile: expandHome(get("sshConfigFile", "configFile")) || undefined,
    options: [
      ...source.searchParams.getAll("sshOption"),
      ...source.searchParams.getAll("sshOptions"),
    ],
    remoteHost: get("remoteHost", "aspHost") || "127.0.0.1",
    remotePort: positiveInteger(get("remotePort", "aspPort", "serverPort")),
    path: rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
  };
}

function sshConnectionArgs(target: SshTarget): string[] {
  return [
    ...(target.configFile ? ["-F", target.configFile] : []),
    ...(target.identityFile ? ["-i", target.identityFile] : []),
    ...target.options.flatMap((option) => ["-o", option]),
    ...(target.port ? ["-p", target.port] : []),
  ];
}

function buildRemoteCommand(
  input: ConnectAspInput,
  additionalEnvironment: Record<string, string> = {},
): string {
  const commandParts = splitProviderCommand(input.provider.command);
  const command = commandParts[0] ?? "";
  const args = [...commandParts.slice(1), ...input.provider.args];
  const environment = {
    ...input.provider.env,
    ...input.env,
    ...input.runEnvironment,
    ...additionalEnvironment,
  };
  const envPrefix = Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && typeof entry[1] === "string",
    )
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const executable = [command, ...args].map(shellQuote).join(" ");
  const install = input.provider.installCommand?.trim();
  const lines = [
    "set -eu",
    'export PATH="$HOME/.grok/bin:$HOME/.kimi-code/bin:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"',
    ...(install
      ? [`if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${install}; fi`]
      : []),
    `cd ${shellQuote(input.cwd)}`,
    `exec ${envPrefix ? `env ${envPrefix} ` : ""}${executable}`,
  ];
  return `sh -lc ${shellQuote(lines.join("\n"))}`;
}

export function processEnvironment(
  ...sources: Array<Record<string, string | undefined> | undefined>
): NodeJS.ProcessEnv {
  return runtimeEnvironment(...sources);
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function emitJsonOrStdout(connection: CallbackConnection, value: string, fallback: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    connection.emitStdout(fallback);
    return;
  }
  connection.emitMessage(parsed);
}

function messageRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function outgoingRequestId(message: Record<string, unknown>): string | undefined {
  return typeof message.method === "string" &&
    message.result === undefined &&
    message.error === undefined
    ? messageId(message.id)
    : undefined;
}

function outgoingRunId(message: Record<string, unknown>): string | undefined {
  return message.type === "run" && typeof message.runId === "string" && message.runId
    ? message.runId
    : undefined;
}

function incomingResponseId(message: Record<string, unknown>): string | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(message, "result") &&
    !Object.prototype.hasOwnProperty.call(message, "error")
  ) {
    return undefined;
  }
  return messageId(message.id);
}

function incomingRunId(message: Record<string, unknown>): string | undefined {
  const params = messageRecord(message.params);
  for (const value of [message.runId, message.run_id, params.runId, params.run_id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function persistentStdioKey(input: ConnectAspInput, command: string, args: string[]): string {
  return JSON.stringify({
    args,
    command,
    cwd: input.cwd,
    env: stableEntries({ ...input.provider.env, ...input.env }),
    id: input.provider.id,
  });
}

function localProviderCommand(provider: AspProvider): { args: string[]; command: string } {
  const commandParts = splitProviderCommand(provider.command);
  return {
    args: [...commandParts.slice(1), ...provider.args],
    command: expandHome(commandParts[0] ?? ""),
  };
}

function stableEntries(value: Record<string, string | undefined>): Array<[string, string]> {
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
}

function splitPayload(data: RawData): string[] {
  const payload = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Buffer.from(data).toString("utf8");
  const lines = payload.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 1 ? lines : [payload];
}

function closeProcess(child: ChildProcessWithoutNullStreams): void {
  if (!child.stdin.writableEnded) child.stdin.end();
  if (child.killed || child.exitCode !== null) return;
  setTimeout(() => {
    if (child.killed || child.exitCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    }, forceKillTimeoutMs).unref();
  }, gracefulExitTimeoutMs).unref();
}

function requireUrl(provider: AspProvider): string {
  const value = provider.url?.trim();
  if (!value)
    throw new Error(`${provider.name} ASP ${provider.transport} transport requires a URL.`);
  return value;
}

function assertReadable(filePath: string | undefined, description: string): void {
  if (!filePath) return;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`${description} is not readable: ${filePath}`);
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
