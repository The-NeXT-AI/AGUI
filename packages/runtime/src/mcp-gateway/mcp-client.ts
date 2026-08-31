import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  McpGatewayServerConfig,
  McpGatewayToolDefinition,
  McpGatewayToolProvider,
} from "./types.js";

type JsonRpcRequest = {
  id?: string;
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  error?: {
    code?: number;
    data?: unknown;
    message?: string;
  };
  id?: string;
  jsonrpc?: string;
  result?: unknown;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const defaultProtocolVersion = "2025-03-26";
const defaultStartupTimeoutMs = 10_000;
const defaultRequestTimeoutMs = 60_000;
const httpFetchRetryDelaysMs = [250, 750, 1_500];

export function createMcpGatewayClient(server: McpGatewayServerConfig): McpGatewayToolProvider {
  if (server.type === "sse") {
    return new SseMcpGatewayClient(server);
  }
  if (server.url) return new HttpMcpGatewayClient(server);
  return new StdioMcpGatewayClient(server);
}

export async function probeMcpGatewayServerTools(
  server: McpGatewayServerConfig,
): Promise<McpGatewayToolDefinition[]> {
  const client = createMcpGatewayClient(server);
  try {
    return await client.listTools();
  } finally {
    await client.close?.();
  }
}

class HttpMcpGatewayClient implements McpGatewayToolProvider {
  private initialized = false;
  private sessionId: string | undefined;

  constructor(private readonly server: McpGatewayServerConfig) {}

  async listTools(signal?: AbortSignal): Promise<McpGatewayToolDefinition[]> {
    await this.ensureInitialized(signal);
    const result = await this.sendRequest("tools/list", {}, signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(`Invalid tools/list response from MCP server ${this.server.id}.`);
    }
    return result.tools.map((tool) =>
      normalizeToolDefinition(tool, `Tool from MCP server ${this.server.id}`),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureInitialized(signal);
    return this.sendRequest("tools/call", { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.sessionId = undefined;
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.sendRequest(
      "initialize",
      {
        protocolVersion: defaultProtocolVersion,
        capabilities: {},
        clientInfo: {
          name: "agui-mcp-gateway",
          version: "0.1.0",
        },
      },
      signal,
      defaultStartupTimeoutMs,
    );
    await this.sendNotification("notifications/initialized", {}, signal).catch(() => undefined);
    this.initialized = true;
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sendFrame({ jsonrpc: "2.0", method, params }, signal, defaultRequestTimeoutMs, true);
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = defaultRequestTimeoutMs,
  ): Promise<unknown> {
    const response = await this.sendFrame(
      { jsonrpc: "2.0", id: randomUUID(), method, params },
      signal,
      timeoutMs,
      false,
    );
    if (!isRecord(response))
      throw new Error(`Invalid JSON-RPC response from MCP server ${this.server.id}.`);
    if (isRecord(response.error)) {
      throw new Error(
        `MCP request failed (${this.server.id}): ${String(response.error.message || "Unknown error")}`,
      );
    }
    return response.result;
  }

  private async sendFrame(
    request: JsonRpcRequest,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    notification: boolean,
  ): Promise<JsonRpcResponse | undefined> {
    if (!this.server.url) throw new Error(`MCP HTTP server ${this.server.id} is missing a URL.`);
    const headers = buildMcpHeaders(this.server, {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    });
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);

    for (let attempt = 0; attempt <= httpFetchRetryDelaysMs.length; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const abortListener = () => controller.abort();
      signal?.addEventListener("abort", abortListener, { once: true });
      try {
        const response = await fetch(this.server.url, {
          body: JSON.stringify(request),
          headers,
          method: "POST",
          signal: controller.signal,
        });
        const nextSessionId =
          response.headers.get("mcp-session-id") || response.headers.get("x-mcp-session-id");
        if (nextSessionId) this.sessionId = nextSessionId;
        if (notification && response.status === 204) return undefined;
        const text = await response.text();
        if (!response.ok) {
          throw new Error(
            `MCP HTTP request failed (${this.server.id}): ${response.status} ${text.slice(0, 400)}`,
          );
        }
        if (!text.trim()) return undefined;
        return parseJsonRpcHttpResponse(text);
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error(`MCP HTTP request timed out or was aborted (${this.server.id}).`);
        }
        if (attempt >= httpFetchRetryDelaysMs.length || !isTransientFetchError(error)) throw error;
        await delay(httpFetchRetryDelaysMs[attempt] ?? 250);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortListener);
      }
    }
    return undefined;
  }
}

class SseMcpGatewayClient implements McpGatewayToolProvider {
  private endpointReady:
    | { reject: (error: Error) => void; resolve: () => void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  private endpointUrl: string | undefined;
  private eventData: string[] = [];
  private eventName = "";
  private initialized = false;
  private openPromise: Promise<void> | undefined;
  private pending = new Map<string, PendingRequest>();
  private streamAbort: AbortController | undefined;

  constructor(private readonly server: McpGatewayServerConfig) {}

  async listTools(signal?: AbortSignal): Promise<McpGatewayToolDefinition[]> {
    await this.ensureInitialized(signal);
    const result = await this.sendRequest("tools/list", {}, signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(`Invalid tools/list response from MCP server ${this.server.id}.`);
    }
    return result.tools.map((tool) =>
      normalizeToolDefinition(tool, `Tool from MCP server ${this.server.id}`),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureInitialized(signal);
    return this.sendRequest("tools/call", { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.endpointUrl = undefined;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.openPromise = undefined;
    this.rejectAll(new Error(`MCP SSE client closed: ${this.server.id}`));
    if (this.endpointReady) {
      clearTimeout(this.endpointReady.timer);
      this.endpointReady.reject(
        new Error(`MCP SSE client closed before endpoint was ready: ${this.server.id}`),
      );
      this.endpointReady = undefined;
    }
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.ensureStream(signal);
    await this.sendRequest(
      "initialize",
      {
        protocolVersion: defaultProtocolVersion,
        capabilities: {},
        clientInfo: {
          name: "agui-mcp-gateway",
          version: "0.1.0",
        },
      },
      signal,
      defaultStartupTimeoutMs,
    );
    await this.sendNotification("notifications/initialized", {}, signal).catch(() => undefined);
    this.initialized = true;
  }

  private async ensureStream(signal?: AbortSignal): Promise<void> {
    if (this.endpointUrl) return;
    if (this.openPromise) {
      await this.openPromise;
      return;
    }
    if (!this.server.url) throw new Error(`MCP SSE server ${this.server.id} is missing a URL.`);
    this.openPromise = this.openStream(signal);
    try {
      await this.openPromise;
    } finally {
      this.openPromise = undefined;
    }
  }

  private async openStream(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    this.streamAbort = controller;
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      const response = await fetch(this.server.url!, {
        headers: buildMcpHeaders(this.server, { accept: "text/event-stream" }),
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `MCP SSE stream failed (${this.server.id}): ${response.status} ${text.slice(0, 400)}`,
        );
      }
      if (!response.body)
        throw new Error(`MCP SSE stream has no response body (${this.server.id}).`);
      const endpointPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.endpointReady = undefined;
          controller.abort();
          reject(new Error(`MCP SSE endpoint timeout (${this.server.id}).`));
        }, defaultStartupTimeoutMs);
        this.endpointReady = { resolve, reject, timer };
      });
      void this.consumeStream(response.body);
      await endpointPromise;
    } catch (error) {
      controller.abort();
      if (isAbortError(error))
        throw new Error(`MCP SSE stream timed out or was aborted (${this.server.id}).`);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.search(/\r?\n/);
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(line.length + (buffer[line.length] === "\r" ? 2 : 1));
          this.handleSseLine(line);
          newlineIndex = buffer.search(/\r?\n/);
        }
      }
      const trailing = buffer.trim();
      if (trailing) this.handleSseLine(trailing);
    } catch (error) {
      if (!isAbortError(error)) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.initialized = false;
      this.endpointUrl = undefined;
      if (this.endpointReady) {
        clearTimeout(this.endpointReady.timer);
        this.endpointReady.reject(
          new Error(`MCP SSE stream closed before endpoint was ready: ${this.server.id}`),
        );
        this.endpointReady = undefined;
      }
    }
  }

  private handleSseLine(line: string): void {
    if (!line) {
      this.flushSseEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).replace(/^ /, "") : "";
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.eventData.push(value);
    }
  }

  private flushSseEvent(): void {
    const eventName = this.eventName || "message";
    const data = this.eventData.join("\n");
    this.eventName = "";
    this.eventData = [];
    if (!data) return;
    if (eventName === "endpoint") {
      this.endpointUrl = new URL(data, this.server.url).toString();
      if (this.endpointReady) {
        clearTimeout(this.endpointReady.timer);
        this.endpointReady.resolve();
        this.endpointReady = undefined;
      }
      return;
    }
    if (eventName !== "message") return;
    try {
      this.handleFrame(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // Ignore non-JSON SSE messages.
    }
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureStream(signal);
    await this.postFrame({ jsonrpc: "2.0", method, params }, signal, defaultRequestTimeoutMs);
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = defaultRequestTimeoutMs,
  ): Promise<unknown> {
    await this.ensureStream(signal);
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP SSE request timeout (${this.server.id}): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const abortListener = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(`MCP SSE request aborted (${this.server.id}): ${method}`));
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      await this.postFrame({ jsonrpc: "2.0", id, method, params }, signal, timeoutMs);
      return await promise;
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
  }

  private async postFrame(
    request: JsonRpcRequest,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.endpointUrl) throw new Error(`MCP SSE endpoint is not ready: ${this.server.id}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      const response = await fetch(this.endpointUrl, {
        body: JSON.stringify(request),
        headers: buildMcpHeaders(this.server, {
          accept: "application/json",
          "content-type": "application/json",
        }),
        method: "POST",
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `MCP SSE POST failed (${this.server.id}): ${response.status} ${text.slice(0, 400)}`,
        );
      }
      if (text.trim()) this.handleFrame(JSON.parse(text) as JsonRpcResponse);
    } catch (error) {
      if (isAbortError(error))
        throw new Error(`MCP SSE POST timed out or was aborted (${this.server.id}).`);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortListener);
    }
  }

  private handleFrame(frame: JsonRpcResponse): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (isRecord(frame.error)) {
      pending.reject(
        new Error(
          `MCP SSE request failed (${this.server.id}): ${String(frame.error.message || "Unknown error")}`,
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class StdioMcpGatewayClient implements McpGatewayToolProvider {
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private pending = new Map<string, PendingRequest>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private stderrTail = "";

  constructor(private readonly server: McpGatewayServerConfig) {}

  async listTools(signal?: AbortSignal): Promise<McpGatewayToolDefinition[]> {
    await this.ensureInitialized(signal);
    const result = await this.sendRequest("tools/list", {}, signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(`Invalid tools/list response from MCP server ${this.server.id}.`);
    }
    return result.tools.map((tool) =>
      normalizeToolDefinition(tool, `Tool from MCP server ${this.server.id}`),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureInitialized(signal);
    return this.sendRequest("tools/call", { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server client closed: ${this.server.id}`));
    }
    this.pending.clear();
    this.initialized = false;
    const child = this.process;
    this.process = undefined;
    if (!child || child.killed) return;
    child.kill();
    await delay(25).catch(() => undefined);
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.ensureProcess();
    await this.sendRequest(
      "initialize",
      {
        protocolVersion: defaultProtocolVersion,
        capabilities: {},
        clientInfo: {
          name: "agui-mcp-gateway",
          version: "0.1.0",
        },
      },
      signal,
      defaultStartupTimeoutMs,
    );
    await this.sendNotification("notifications/initialized", {}).catch(() => undefined);
    this.initialized = true;
  }

  private async ensureProcess(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (!this.server.command)
      throw new Error(`MCP stdio server ${this.server.id} is missing a command.`);
    const child = spawn(this.server.command, this.server.args ?? [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(this.server.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.buffer = Buffer.alloc(0);
    this.stderrTail = "";

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("error", (error) => {
      this.rejectAll(new Error(`MCP process error (${this.server.id}): ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      this.rejectAll(
        new Error(
          `MCP process exited (${this.server.id}): code=${String(code)}, signal=${String(signal)}${this.stderrTail ? `, stderr=${this.stderrTail}` : ""}`,
        ),
      );
      this.initialized = false;
      this.process = undefined;
    });
  }

  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.ensureProcess();
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = defaultRequestTimeoutMs,
  ): Promise<unknown> {
    await this.ensureProcess();
    const id = String(++this.sequence);
    const child = this.process;
    if (!child || !child.stdin.writable)
      throw new Error(`MCP process is not writable: ${this.server.id}`);

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout (${this.server.id}): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const abortListener = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(`MCP request aborted (${this.server.id}): ${method}`));
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    this.writeFrame({ jsonrpc: "2.0", id, method, params });
    try {
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
  }

  private writeFrame(payload: JsonRpcRequest): void {
    const child = this.process;
    if (!child || !child.stdin.writable)
      throw new Error(`MCP process is not writable: ${this.server.id}`);
    const json = JSON.stringify(payload);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const frame = this.readNextFrame();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }

  private readNextFrame(): JsonRpcResponse | undefined {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch?.[1]) {
        this.buffer = Buffer.alloc(0);
        return undefined;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return undefined;
      const rawBody = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      return JSON.parse(rawBody) as JsonRpcResponse;
    }

    const newlineIndex = this.buffer.indexOf("\n");
    if (newlineIndex < 0) return undefined;
    const line = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
    this.buffer = this.buffer.subarray(newlineIndex + 1);
    if (!line) return undefined;
    return JSON.parse(line) as JsonRpcResponse;
  }

  private handleFrame(frame: JsonRpcResponse): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (isRecord(frame.error)) {
      pending.reject(
        new Error(
          `MCP request failed (${this.server.id}): ${String(frame.error.message || "Unknown error")}`,
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeToolDefinition(value: unknown, fallbackTitle: string): McpGatewayToolDefinition {
  const record = isRecord(value) ? value : {};
  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : fallbackTitle;
  return {
    description: typeof record.description === "string" ? record.description : "",
    inputSchema: isRecord(record.inputSchema) ? record.inputSchema : undefined,
    name,
    outputSchema: isRecord(record.outputSchema) ? record.outputSchema : undefined,
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined,
    title:
      typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined,
  };
}

function parseJsonRpcHttpResponse(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  const events = trimmed.split(/\n\n+/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (data) return JSON.parse(data) as JsonRpcResponse;
  }
  throw new Error("Invalid MCP event-stream response: missing data frame.");
}

function buildMcpHeaders(
  server: McpGatewayServerConfig,
  defaults: Record<string, string>,
): Headers {
  const headers = new Headers({
    ...defaults,
    ...(server.headers ?? {}),
  });
  applyAuthenticationHeaders(headers, server);
  return headers;
}

function applyAuthenticationHeaders(headers: Headers, server: McpGatewayServerConfig): void {
  const authentication = server.authentication;
  if (!authentication || authentication.type === "none") return;
  if (authentication.type === "bearer") {
    headers.set("authorization", `Bearer ${authentication.token}`);
    return;
  }
  if (authentication.type === "api-key") {
    headers.set(authentication.headerName || "X-API-Key", authentication.value);
    return;
  }
  if (authentication.type === "basic") {
    const credentials = Buffer.from(
      `${authentication.username}:${authentication.password}`,
    ).toString("base64");
    headers.set("authorization", `Basic ${credentials}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
  );
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  if (!isRecord(cause)) return error instanceof TypeError && error.message === "fetch failed";
  const code = typeof cause.code === "string" ? cause.code : "";
  return ["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code);
}
