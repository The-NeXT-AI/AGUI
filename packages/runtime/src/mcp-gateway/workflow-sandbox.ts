import vm from "node:vm";
import { toCatalogAlias } from "./catalog.js";
import type {
  McpGatewayWorkflowSandbox,
  McpGatewayWorkflowSandboxInput,
  McpGatewayWorkflowSandboxResult,
} from "./types.js";

const defaultWorkflowTimeoutMs = 60_000;
const defaultCompileTimeoutMs = 1_000;

type ExplicitResult = {
  __mcpGatewayExplicitResult: true;
  value: unknown;
};

/**
 * Default sandbox for environments that cannot ship QuickJS yet.
 *
 * Node's vm is a convenience isolation layer, not a hard security boundary.
 * Hosts that execute untrusted workflow code should pass a custom
 * McpGatewayWorkflowSandbox implementation, for example one backed by QuickJS.
 */
export class VmWorkflowSandbox implements McpGatewayWorkflowSandbox {
  constructor(private readonly options: { compileTimeoutMs?: number } = {}) {}

  async run(input: McpGatewayWorkflowSandboxInput): Promise<McpGatewayWorkflowSandboxResult> {
    const timeoutMs = positiveInt(input.timeoutMs, defaultWorkflowTimeoutMs);
    const callableTools = new Set(input.callableTools);
    let explicitResult = false;

    const callTool = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (typeof tool !== "string" || !tool.trim()) {
        throw new Error("Workflow tool name must be a non-empty string.");
      }
      if (!isRecord(args)) {
        throw new Error("Workflow tool arguments must be an object.");
      }
      if (!callableTools.has(tool)) {
        throw new Error(`Workflow cannot call unresolved tool: ${tool}`);
      }
      return input.callTool(tool, args);
    };

    const result = (value: unknown): ExplicitResult => {
      explicitResult = true;
      return {
        __mcpGatewayExplicitResult: true,
        value,
      };
    };

    const namespaces = buildNamespaces(input.callableTools, callTool);
    const context = vm.createContext({
      AbortController,
      Array,
      BigInt,
      Boolean,
      console: scopedConsole(),
      Date,
      Error,
      JSON,
      Map,
      Math,
      Number,
      Object,
      Promise,
      Reflect,
      RegExp,
      Set,
      String,
      Symbol,
      URL,
      URLSearchParams,
    });

    const source = [
      "(async (callTool, tools, mcp, result, input) => {",
      '"use strict";',
      "const window = undefined, document = undefined, parent = undefined, top = undefined, frames = undefined;",
      "const global = undefined, process = undefined, require = undefined, module = undefined, exports = undefined;",
      "const localStorage = undefined, sessionStorage = undefined, indexedDB = undefined;",
      "const XMLHttpRequest = undefined, fetch = undefined, WebSocket = undefined, EventSource = undefined;",
      "const Worker = undefined, SharedWorker = undefined, importScripts = undefined;",
      input.code,
      "})",
    ].join("\n");

    const script = new vm.Script(source, { filename: "mcp-gateway-workflow.js" });
    const fn = script.runInContext(context, {
      timeout: positiveInt(this.options.compileTimeoutMs, defaultCompileTimeoutMs),
    }) as (
      callTool: (tool: string, args?: Record<string, unknown>) => Promise<unknown>,
      tools: Record<string, unknown>,
      mcp: Record<string, unknown>,
      result: (value: unknown) => ExplicitResult,
      input: Record<string, unknown>,
    ) => Promise<unknown>;

    const output = await withTimeout(
      Promise.resolve(
        fn(callTool, Object.freeze(namespaces.tools), Object.freeze(namespaces.mcp), result, {}),
      ),
      timeoutMs,
      `code_tool.workflow timed out after ${timeoutMs}ms.`,
    );
    if (isExplicitResult(output)) {
      return { explicitResult: true, result: output.value };
    }
    return { explicitResult, result: output };
  }
}

export function buildNamespaces(
  callableTools: string[],
  callTool: (tool: string, args?: Record<string, unknown>) => Promise<unknown>,
): {
  mcp: Record<string, unknown>;
  tools: Record<string, unknown>;
} {
  const mcp: Record<string, unknown> = Object.create(null);
  const tools: Record<string, unknown> = Object.create(null);
  tools.call = callTool;

  for (const toolName of callableTools) {
    tools[toCatalogAlias(toolName)] = (args: Record<string, unknown> = {}) =>
      callTool(toolName, args);
    const parts = toolName.split(".").filter(Boolean);
    if (parts[0] === "mcp" && parts.length >= 3) {
      definePath(mcp, parts.slice(1), (args: Record<string, unknown> = {}) =>
        callTool(toolName, args),
      );
    }
  }
  return { mcp, tools };
}

function definePath(root: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const existing = current[part];
    if (!isRecord(existing)) {
      current[part] = Object.create(null);
    }
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts.at(-1);
  if (leaf) current[leaf] = value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scopedConsole(): Pick<Console, "debug" | "error" | "info" | "log" | "warn"> {
  return {
    debug: (...args: unknown[]) => console.debug("[MCPGateway workflow]", ...args),
    error: (...args: unknown[]) => console.error("[MCPGateway workflow]", ...args),
    info: (...args: unknown[]) => console.info("[MCPGateway workflow]", ...args),
    log: (...args: unknown[]) => console.log("[MCPGateway workflow]", ...args),
    warn: (...args: unknown[]) => console.warn("[MCPGateway workflow]", ...args),
  };
}

function isExplicitResult(value: unknown): value is ExplicitResult {
  return isRecord(value) && value.__mcpGatewayExplicitResult === true;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
