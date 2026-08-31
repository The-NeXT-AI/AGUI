#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  isOutgoingConfigured,
  mailSendMessageFromInput,
  normalizeAccount,
  sendSmtpMessage,
} from "./extension.js";

const tools = [
  {
    name: "mail_send_message",
    title: "Send email",
    description:
      "Send an email through the user's configured SMTP account. This modifies the user's mailbox/provider by sending mail.",
    inputSchema: objectSchema(
      {
        to: stringArraySchema(
          "Recipient email addresses. At least one visible recipient is required unless cc or bcc is set.",
        ),
        cc: stringArraySchema("CC recipient email addresses."),
        bcc: stringArraySchema("BCC recipient email addresses."),
        subject: stringSchema("Email subject.", 998),
        body: stringSchema("Email body.", 256 * 1024),
        bodyFormat: enumSchema(["text", "html"], "Body format. Defaults to text."),
        from: stringSchema("Optional From address. Defaults to the configured account."),
        replyTo: stringSchema("Optional Reply-To address."),
      },
      ["subject", "body"],
    ),
  },
];

export { callTool, tools };

async function callTool(name: string, args: Record<string, unknown> = {}) {
  switch (name) {
    case "mail_send_message":
      return sendMessageTool(args);
    default:
      throw new Error(`Unknown Mail MCP tool: ${name}`);
  }
}

async function sendMessageTool(args: Record<string, unknown>) {
  const account = configuredAccount();
  const password = process.env.AGUI_MAIL_PASSWORD || "";
  if (!password) throw new Error("Mail MCP server is not configured with AGUI_MAIL_PASSWORD.");
  if (!isOutgoingConfigured(account)) {
    throw new Error("Mail MCP server is missing SMTP host, port, or username.");
  }
  const message = mailSendMessageFromInput(args, account, false);
  return sendSmtpMessage(account, password, message, false);
}

function configuredAccount() {
  const raw = process.env.AGUI_MAIL_ACCOUNT_JSON || "";
  if (!raw) throw new Error("Mail MCP server is not configured with AGUI_MAIL_ACCOUNT_JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGUI_MAIL_ACCOUNT_JSON is not valid JSON.");
  }
  return normalizeAccount(parsed);
}

function startMcpServer() {
  const transport = new StdioTransport(async (message) => {
    if (message.method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agui-mail-mcp", version: "0.1.0" },
      };
    }
    if (message.method === "tools/list") return { tools };
    if (message.method === "tools/call") {
      const params = recordValue(message.params);
      const name = requiredString(params.name, "name");
      const result = await callTool(name, recordValue(params.arguments));
      return toolResult(result);
    }
    if (message.method === "ping") return {};
    throw new Error(`Unsupported MCP method: ${message.method}`);
  });
  transport.start();
}

class StdioTransport {
  buffer = Buffer.alloc(0);
  handler: (message: Record<string, unknown>) => Promise<unknown>;

  constructor(handler: (message: Record<string, unknown>) => Promise<unknown>) {
    this.handler = handler;
  }

  start() {
    process.stdin.on("data", (chunk) => this.handleData(chunk));
    process.stdin.resume();
  }

  handleData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const message = this.readFrame();
      if (!message) break;
      void this.handleMessage(message);
    }
  }

  readFrame(): Record<string, unknown> | undefined {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match?.[1]) {
        this.buffer = Buffer.alloc(0);
        return undefined;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (this.buffer.length < bodyEnd) return undefined;
      const raw = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      return recordValue(JSON.parse(raw));
    }
    const newline = this.buffer.indexOf("\n");
    if (newline < 0) return undefined;
    const raw = this.buffer.subarray(0, newline).toString("utf8").trim();
    this.buffer = this.buffer.subarray(newline + 1);
    return raw ? recordValue(JSON.parse(raw)) : undefined;
  }

  async handleMessage(message: Record<string, unknown>) {
    if (message.jsonrpc !== "2.0" || !message.method) return;
    if (message.id === undefined) return;
    try {
      const result = await this.handler(message);
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  write(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }
}

function toolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, name: string) {
  const text = typeof value === "string" && value.trim() ? value.trim() : "";
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringSchema(description: string, maxLength?: number) {
  return { type: "string", description, ...(maxLength ? { maxLength } : {}) };
}

function enumSchema(values: string[], description: string) {
  return { type: "string", enum: values, description };
}

function stringArraySchema(description: string) {
  return {
    type: "array",
    maxItems: 100,
    items: { type: "string" },
    description,
  };
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  startMcpServer();
}
