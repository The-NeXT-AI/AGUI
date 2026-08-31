import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { McpGateway } from "./mcp-gateway.js";
import {
  handleMcpGatewayJsonRpcRequest,
  mcpGatewayJsonRpcError,
  mcpGatewayJsonRpcResult,
  type McpGatewayJsonRpcRequest,
  type McpGatewayJsonRpcResponse,
} from "./mcp-protocol.js";

export type McpGatewayStdioSocketServerOptions = {
  gateway: McpGateway;
  socketPath?: string;
  token?: string;
};

export type McpGatewayStdioSocketAddress = {
  socketPath: string;
  token: string;
};

const handshakeMethod = "agui/mcpGatewayBridge/hello";
const defaultSessionId = "default";

export function createMcpGatewayStdioSocketServer(options: McpGatewayStdioSocketServerOptions) {
  const socketPath = options.socketPath?.trim() || defaultSocketPath();
  let server: Server | null = null;
  let token = options.token || randomBytes(24).toString("base64url");
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  const sockets = new Set<Socket>();

  async function start(): Promise<void> {
    if (server) return;
    if (startPromise) return startPromise;
    token = options.token || randomBytes(24).toString("base64url");
    startPromise = (async () => {
      await prepareSocketPath(socketPath);
      const nextServer = net.createServer((socket) => {
        sockets.add(socket);
        handleSocket(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      await listen(nextServer, socketPath);
      server = nextServer;
    })()
      .catch((error) => {
        cleanupSocketPath(socketPath);
        throw error;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  async function stop(): Promise<void> {
    if (startPromise) await startPromise.catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (!server) {
      cleanupSocketPath(socketPath);
      return;
    }
    if (stopPromise) return stopPromise;
    const activeServer = server;
    server = null;
    stopPromise = new Promise<void>((resolve) => activeServer.close(() => resolve())).finally(
      () => {
        cleanupSocketPath(socketPath);
        stopPromise = null;
      },
    );
    return stopPromise;
  }

  async function getAddress(): Promise<McpGatewayStdioSocketAddress> {
    await start();
    return { socketPath, token };
  }

  function handleSocket(socket: Socket): void {
    let buffer = "";
    let sessionId: string | undefined;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.search(/\r?\n/);
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(line.length + (buffer[line.length] === "\r" ? 2 : 1));
        void handleLine(socket, line, {
          get sessionId() {
            return sessionId;
          },
          set sessionId(value: string | undefined) {
            sessionId = value;
          },
        });
        newlineIndex = buffer.search(/\r?\n/);
      }
    });
    socket.on("error", () => undefined);
  }

  async function handleLine(
    socket: Socket,
    line: string,
    context: {
      sessionId: string | undefined;
    },
  ): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      writeSocketJson(
        socket,
        mcpGatewayJsonRpcError(null, -32700, "Parse error.", { error: formatError(error) }),
      );
      return;
    }

    if (!context.sessionId) {
      const handshake = handleHandshake(message);
      writeSocketJson(socket, handshake.response);
      if (!handshake.ok) {
        socket.destroy();
        return;
      }
      context.sessionId = handshake.sessionId;
      return;
    }

    if (Array.isArray(message)) {
      const responses = (
        await Promise.all(
          message.map((item) =>
            handleMcpGatewayJsonRpcRequest(options.gateway, item as McpGatewayJsonRpcRequest, {
              sessionId: context.sessionId || defaultSessionId,
            }),
          ),
        )
      ).filter((item): item is McpGatewayJsonRpcResponse => Boolean(item));
      if (responses.length) writeSocketJson(socket, responses);
      return;
    }

    const response = await handleMcpGatewayJsonRpcRequest(
      options.gateway,
      message as McpGatewayJsonRpcRequest,
      {
        sessionId: context.sessionId,
      },
    );
    if (response) writeSocketJson(socket, response);
  }

  function handleHandshake(
    message: unknown,
  ):
    | { ok: true; response: McpGatewayJsonRpcResponse; sessionId: string }
    | { ok: false; response: McpGatewayJsonRpcResponse } {
    const request = record(message);
    const id = request.id ?? null;
    if (
      request.jsonrpc !== "2.0" ||
      request.method !== handshakeMethod ||
      !isRecord(request.params)
    ) {
      return {
        ok: false,
        response: mcpGatewayJsonRpcError(id, -32600, "Invalid MCP Gateway bridge handshake."),
      };
    }

    const suppliedToken = stringValue(request.params.token);
    if (!safeTokenEqual(suppliedToken, token)) {
      return {
        ok: false,
        response: mcpGatewayJsonRpcError(id, -32001, "Unauthorized MCP Gateway bridge."),
      };
    }

    return {
      ok: true,
      response: mcpGatewayJsonRpcResult(id, { ok: true }),
      sessionId: stringValue(request.params.sessionId) || defaultSessionId,
    };
  }

  return {
    getAddress,
    start,
    stop,
  };
}

function writeSocketJson(socket: Socket, value: unknown): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(value)}\n`);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.removeListener("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.removeListener("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(socketPath);
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.promises.unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function cleanupSocketPath(socketPath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function defaultSocketPath(): string {
  const id = randomBytes(8).toString("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\agui-mcp-gateway-${process.pid}-${id}`;
  const baseDir = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return path.join(baseDir, `agui-mcp-gateway-${process.pid}-${id}.sock`);
}

function safeTokenEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
