#!/usr/bin/env node
import net from "node:net";
import process from "node:process";
import readline from "node:readline";

const socketPath = (process.env.AGUI_MCP_GATEWAY_SOCKET ?? "").trim();
const token = (process.env.AGUI_MCP_GATEWAY_TOKEN ?? "").trim();
const sessionId = (process.env.AGUI_MCP_GATEWAY_SESSION_ID ?? "").trim();
const handshakeId = "agui-mcp-gateway-bridge-handshake";

if (!socketPath || !token || !sessionId) {
  process.stderr.write(
    "AGUI_MCP_GATEWAY_SOCKET, AGUI_MCP_GATEWAY_TOKEN, and AGUI_MCP_GATEWAY_SESSION_ID are required for MCP Gateway stdio bridge.\n",
  );
  process.exit(1);
}

const pendingInput: string[] = [];
let bridgeReady = false;

const socket = net.createConnection(socketPath);
socket.setEncoding("utf8");

const socketLines = readline.createInterface({
  crlfDelay: Infinity,
  input: socket,
  terminal: false,
});

const inputLines = readline.createInterface({
  crlfDelay: Infinity,
  input: process.stdin,
  terminal: false,
});

socket.on("connect", () => {
  writeSocket({
    id: handshakeId,
    jsonrpc: "2.0",
    method: "agui/mcpGatewayBridge/hello",
    params: {
      sessionId,
      token,
    },
  });
});

socket.on("error", (error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
});

socket.on("close", () => {
  process.exit(0);
});

socketLines.on("line", (line) => {
  if (!bridgeReady) {
    handleHandshakeResponse(line);
    return;
  }
  process.stdout.write(`${line}\n`);
});

inputLines.on("line", (line) => {
  if (!bridgeReady) {
    pendingInput.push(line);
    return;
  }
  writeRawLine(line);
});

inputLines.on("close", () => {
  socket.end();
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`${formatError(error)}\n`);
});

process.on("unhandledRejection", (error) => {
  process.stderr.write(`${formatError(error)}\n`);
});

function handleHandshakeResponse(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`Invalid MCP Gateway bridge handshake response: ${formatError(error)}\n`);
    process.exit(1);
  }

  const response = record(message);
  if (response.id !== handshakeId || response.error) {
    process.stderr.write(
      `MCP Gateway bridge handshake failed: ${JSON.stringify(response.error ?? response)}\n`,
    );
    process.exit(1);
  }

  bridgeReady = true;
  for (const pending of pendingInput.splice(0)) writeRawLine(pending);
}

function writeSocket(value: unknown): void {
  writeRawLine(JSON.stringify(value));
}

function writeRawLine(line: string): void {
  if (socket.destroyed) return;
  socket.write(`${line}\n`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
