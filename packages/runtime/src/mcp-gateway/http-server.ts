import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import type { McpGateway } from "./mcp-gateway.js";
import {
  createMcpSessionId,
  handleMcpGatewayJsonRpcRequest,
  mcpGatewayJsonRpcError,
  mcpGatewayProtocolVersion,
  type McpGatewayJsonRpcRequest,
} from "./mcp-protocol.js";

export type McpGatewayHttpServerOptions = {
  gateway: McpGateway;
  host?: string;
  path?: string;
  port?: number;
  token?: string;
};

const defaultHost = "127.0.0.1";
const defaultPath = "/mcp";
const maxRequestBodyBytes = 1_000_000;
const allowedMethods = "GET, POST, OPTIONS";

export function createMcpGatewayHttpServer(options: McpGatewayHttpServerOptions) {
  const host = options.host?.trim() || defaultHost;
  const path = normalizePath(options.path);
  const preferredPort = Number.isFinite(options.port)
    ? Math.max(0, Math.floor(Number(options.port)))
    : 0;
  let server: Server | null = null;
  let endpoint: string | null = null;
  let token = options.token || randomBytes(24).toString("base64url");
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    if (requestUrl.pathname !== path) {
      sendJson(request, response, 404, { ok: false, error: "Not found." });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...getPreflightCorsHeaders(request),
        allow: allowedMethods,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (!isAuthorized(requestUrl, request)) {
      sendJson(request, response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    if (request.method === "GET") {
      const exported = options.gateway.exportMcp();
      sendJson(request, response, 200, {
        ok: true,
        protocolVersion: mcpGatewayProtocolVersion,
        server: exported.server,
        toolCount: exported.tools.length,
      });
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, {
        ...getCorsHeaders(request),
        allow: allowedMethods,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    let parsedBody: McpGatewayJsonRpcRequest;
    try {
      parsedBody = JSON.parse(await readRequestBody(request)) as McpGatewayJsonRpcRequest;
    } catch (error) {
      sendJson(
        request,
        response,
        400,
        mcpGatewayJsonRpcError(null, -32700, "Invalid JSON body.", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    const sessionId = getOrCreateMcpSessionId(requestUrl, request, parsedBody);
    const jsonRpcResponse = await handleMcpGatewayJsonRpcRequest(options.gateway, parsedBody, {
      sessionId,
    });
    if (jsonRpcResponse === null) {
      response.writeHead(204, {
        ...getCorsHeaders(request),
        "cache-control": "no-store",
        "mcp-session-id": sessionId,
      });
      response.end();
      return;
    }
    sendJson(request, response, 200, jsonRpcResponse, { "mcp-session-id": sessionId });
  }

  function isAuthorized(requestUrl: URL, request: IncomingMessage): boolean {
    const authHeader = request.headers.authorization?.trim();
    if (authHeader === `Bearer ${token}`) return true;
    return requestUrl.searchParams.get("token") === token;
  }

  function getOrCreateMcpSessionId(
    requestUrl: URL,
    request: IncomingMessage,
    body: McpGatewayJsonRpcRequest,
  ): string {
    const headerSessionId =
      getRequestHeaderString(request, "mcp-session-id") ||
      getRequestHeaderString(request, "x-mcp-session-id");
    if (headerSessionId) return headerSessionId;
    const querySessionId =
      requestUrl.searchParams.get("mcpSessionId") || requestUrl.searchParams.get("sessionId");
    if (querySessionId?.trim()) return querySessionId.trim();
    if (body.method === "initialize") return createMcpSessionId();
    return `token:${token}`;
  }

  async function start(): Promise<void> {
    if (server) return;
    if (startPromise) return startPromise;
    token = options.token || randomBytes(24).toString("base64url");
    startPromise = (async () => {
      const nextServer = createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          if (!response.headersSent) {
            sendJson(request, response, 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          response.destroy();
        });
      });
      nextServer.requestTimeout = 0;
      nextServer.timeout = 0;
      nextServer.headersTimeout = 0;
      nextServer.keepAliveTimeout = 0;
      await listen(nextServer, preferredPort, host);
      const address = nextServer.address();
      if (!address || typeof address === "string") {
        nextServer.close();
        throw new Error("MCP Gateway HTTP server did not expose a TCP address.");
      }
      const port = (address as AddressInfo).port;
      endpoint = `http://${host}:${port}${path}?token=${encodeURIComponent(token)}`;
      server = nextServer;
    })()
      .catch((error) => {
        endpoint = null;
        throw error;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  async function stop(): Promise<void> {
    endpoint = null;
    if (startPromise) await startPromise.catch(() => undefined);
    if (!server) return;
    if (stopPromise) return stopPromise;
    const activeServer = server;
    server = null;
    stopPromise = new Promise<void>((resolve) => activeServer.close(() => resolve())).finally(
      () => {
        stopPromise = null;
      },
    );
    return stopPromise;
  }

  async function getAddress(): Promise<string> {
    await start();
    if (!endpoint) throw new Error("MCP Gateway HTTP server is not listening.");
    return endpoint;
  }

  return {
    getAddress,
    start,
    stop,
  };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    request.on("data", (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalLength += buffer.length;
      if (totalLength > maxRequestBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    ...getCorsHeaders(request),
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function getCorsHeaders(_request: IncomingMessage): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
  };
}

function getPreflightCorsHeaders(request: IncomingMessage): Record<string, string> {
  const requestedHeaders = request.headers["access-control-request-headers"];
  const allowHeaders = new Set([
    "accept",
    "authorization",
    "content-type",
    "mcp-session-id",
    "x-mcp-session-id",
  ]);
  if (typeof requestedHeaders === "string") {
    for (const headerName of requestedHeaders.split(",")) {
      const normalized = headerName.trim().toLowerCase();
      if (normalized) allowHeaders.add(normalized);
    }
  }
  return {
    ...getCorsHeaders(request),
    "access-control-allow-headers": Array.from(allowHeaders).join(", "),
    "access-control-allow-methods": allowedMethods,
    "access-control-max-age": "86400",
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
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
    server.listen(port, host);
  });
}

function getRequestHeaderString(request: IncomingMessage, headerName: string): string {
  const value = request.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim() ?? "";
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(value: string | undefined): string {
  const raw = value?.trim() || defaultPath;
  return raw.startsWith("/") ? raw : `/${raw}`;
}
