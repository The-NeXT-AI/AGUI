import { randomBytes } from "node:crypto";
import { mcpGatewayScopeArgumentName, type McpGateway } from "./mcp-gateway.js";

export type McpGatewayJsonRpcRequest = {
  id?: unknown;
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
};

export type McpGatewayJsonRpcResponse = {
  error?: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: unknown;
  jsonrpc: "2.0";
  result?: unknown;
};

export const mcpGatewayJsonRpcVersion = "2.0";
export const mcpGatewayProtocolVersion = "2025-03-26";

export async function handleMcpGatewayJsonRpcRequest(
  gateway: McpGateway,
  body: McpGatewayJsonRpcRequest,
  context: { sessionId: string },
): Promise<McpGatewayJsonRpcResponse | null> {
  const id = body.id ?? null;
  if (
    body.jsonrpc !== mcpGatewayJsonRpcVersion ||
    typeof body.method !== "string" ||
    !body.method.trim()
  ) {
    return mcpGatewayJsonRpcError(id, -32600, "Invalid JSON-RPC request.");
  }

  const method = body.method.trim();
  if (method === "notifications/initialized") return null;

  if (method === "initialize") {
    const exported = gateway.exportMcp();
    return mcpGatewayJsonRpcResult(id, {
      protocolVersion: mcpGatewayProtocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: exported.server,
    });
  }

  if (method === "ping") return mcpGatewayJsonRpcResult(id, {});

  if (method === "tools/list") {
    const exported = gateway.exportMcp();
    return mcpGatewayJsonRpcResult(id, {
      tools: exported.tools.map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name,
      })),
    });
  }

  if (method === "tools/call") {
    if (!isRecord(body.params)) {
      return mcpGatewayJsonRpcError(id, -32602, "tools/call requires params to be an object.");
    }
    const toolName = typeof body.params.name === "string" ? body.params.name.trim() : "";
    const toolArguments = withScopeArgument(
      isRecord(body.params.arguments) ? body.params.arguments : {},
      context.sessionId,
    );
    if (!toolName)
      return mcpGatewayJsonRpcError(id, -32602, "tools/call requires a non-empty tool name.");
    try {
      const result = await gateway.callTool(toolName, toolArguments);
      return mcpGatewayJsonRpcResult(id, wrapToolResult(result));
    } catch (error) {
      return mcpGatewayJsonRpcResult(id, wrapToolError(toolName, error));
    }
  }

  return mcpGatewayJsonRpcError(id, -32601, `Unsupported MCP method: ${method}`);
}

export function mcpGatewayJsonRpcResult(id: unknown, result: unknown): McpGatewayJsonRpcResponse {
  return {
    id,
    jsonrpc: mcpGatewayJsonRpcVersion,
    result,
  };
}

export function mcpGatewayJsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): McpGatewayJsonRpcResponse {
  return {
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
    id,
    jsonrpc: mcpGatewayJsonRpcVersion,
  };
}

export function createMcpSessionId(): string {
  return randomBytes(18).toString("base64url");
}

function wrapToolResult(result: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    structuredContent: result,
  };
}

function wrapToolError(toolName: string, error: unknown): Record<string, unknown> {
  const structuredContent = {
    ok: false,
    toolName,
    error: {
      code: "MCP_GATEWAY_TOOL_CALL_FAILED",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    isError: true,
    structuredContent,
  };
}

function withScopeArgument(
  args: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  if (args[mcpGatewayScopeArgumentName] !== undefined) return args;
  return {
    ...args,
    [mcpGatewayScopeArgumentName]: sessionId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
