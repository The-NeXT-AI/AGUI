import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ASP_ERROR_CODES, ASP_NAME, ASP_VERSION, type AspProviderCapabilities } from "../types.js";
import { ASP_JSON_RPC_VERSION } from "../asp-protocol.js";
import type {
  AspTransportConnection,
  ConnectAspInput,
  TransportCloseResult,
} from "../asp-transport.js";
import { splitProviderCommand } from "../provider-store.js";
import {
  closeChild,
  ensureProviderCli,
  nativeAdapterCapabilities,
  rpcId,
  runtimeEnvironment,
  text,
} from "./shared.js";

type Handler<T> = (value: T) => void;
export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};
export type PendingRequest = {
  method?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export abstract class RuntimeConnection implements AspTransportConnection {
  protected child: ChildProcessWithoutNullStreams | null = null;
  protected closed = false;
  protected readonly messageHandlers = new Set<Handler<unknown>>();
  protected readonly stdoutHandlers = new Set<Handler<string>>();
  protected readonly stderrHandlers = new Set<Handler<string>>();
  protected readonly errorHandlers = new Set<Handler<Error>>();
  protected readonly closeHandlers = new Set<Handler<TransportCloseResult>>();
  private closeResult: TransportCloseResult | null = null;

  constructor(protected readonly input: ConnectAspInput) {}

  abstract send(message: Record<string, unknown>): void;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeChild(this.child);
  }

  onMessage(handler: Handler<unknown>): void {
    this.messageHandlers.add(handler);
  }
  onStdout(handler: Handler<string>): void {
    this.stdoutHandlers.add(handler);
  }
  onStderr(handler: Handler<string>): void {
    this.stderrHandlers.add(handler);
  }
  onError(handler: Handler<Error>): void {
    this.errorHandlers.add(handler);
  }
  onClose(handler: Handler<TransportCloseResult>): void {
    this.closeHandlers.add(handler);
    if (this.closeResult) handler(this.closeResult);
  }

  protected emitMessage(message: unknown): void {
    const source =
      message && typeof message === "object" && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : null;
    const canonical = source
      ? {
          asp: ASP_NAME,
          jsonrpc: ASP_JSON_RPC_VERSION,
          version: ASP_VERSION,
          ...source,
        }
      : message;
    queueMicrotask(() => {
      for (const handler of this.messageHandlers) handler(canonical);
    });
  }
  protected emitStdout(chunk: string): void {
    for (const handler of this.stdoutHandlers) handler(chunk);
  }
  protected emitStderr(chunk: string): void {
    for (const handler of this.stderrHandlers) handler(chunk);
  }
  protected emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  protected emitNativeEvent(
    extension: string,
    enabled: boolean,
    payload: unknown,
    runId: string,
    providerSessionId?: string,
  ): void {
    if (!enabled || !runId) return;
    this.emitMessage({
      method: "extension.event",
      params: {
        extension,
        event: "native.event",
        fallback: "none",
        payload,
        providerSessionId: providerSessionId || undefined,
        runId,
      },
    });
  }
  protected emitClose(result: TransportCloseResult): void {
    if (this.closeResult) return;
    this.closeResult = result;
    for (const handler of this.closeHandlers) handler(result);
  }

  protected handleCommonQuery(
    message: Record<string, unknown>,
    capabilities = nativeAdapterCapabilities(this.input.provider.capabilities),
  ): boolean {
    const method = text(message.method);
    const id = rpcId(message.id);
    if (id === undefined) return false;
    if (method === "initialize") {
      const supportedVersions = Array.isArray(message.supportedProtocolVersions)
        ? message.supportedProtocolVersions.map(String)
        : [];
      if (!supportedVersions.includes(ASP_VERSION)) {
        this.emitMessage({
          id,
          error: {
            code: ASP_ERROR_CODES.protocolVersionMismatch,
            message: `${this.input.provider.name} requires ASP v${ASP_VERSION}.`,
            data: { details: { supportedProtocolVersions: [ASP_VERSION] } },
          },
        });
        return true;
      }
      this.emitMessage({
        id,
        result: {
          agentInfo: {
            name: this.input.provider.id,
            title: this.input.provider.name,
            version: "0.1.0",
          },
          capabilities,
          protocolVersion: ASP_VERSION,
        },
      });
      return true;
    }
    if (method === "capabilities") {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: capabilities,
        version: ASP_VERSION,
      });
      return true;
    }
    if (method === "list_models") {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        result: { models: this.input.provider.models ?? [] },
        version: ASP_VERSION,
      });
      return true;
    }
    if (
      method === "list_sessions" ||
      method === "session_messages" ||
      method === "resume_session"
    ) {
      this.emitMessage({
        asp: ASP_NAME,
        id,
        error: {
          code: ASP_ERROR_CODES.methodNotFound,
          message: `${this.input.provider.name} native adapter does not expose ASP session history.`,
        },
        version: ASP_VERSION,
      });
      return true;
    }
    return false;
  }

  protected startChild(
    args: string[],
    extraEnv: Record<string, string | undefined> = {},
  ): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const provider = this.input.provider;
    const commandParts = splitProviderCommand(provider.command);
    const command = expandHome(commandParts[0] ?? "");
    const env = runtimeEnvironment(
      provider.env,
      this.input.env,
      this.input.runEnvironment,
      extraEnv,
    );
    ensureProviderCli(provider, this.input.cwd, env);
    this.child = spawn(command, [...commandParts.slice(1), ...args], {
      cwd: this.input.cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emitStderr(chunk));
    this.child.on("error", (error) => this.emitError(error));
    this.child.on("close", (exitCode, signal) => {
      this.emitClose({ exitCode, signal });
    });
    return this.child;
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
