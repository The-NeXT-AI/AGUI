import type { McpAppStatePatch } from "./chat-store-types";

export const MAX_MCP_APP_STATE_BYTES = 256 * 1024;
const MAX_MCP_APP_STATE_DEPTH = 32;
const MAX_MCP_APP_STATE_NODES = 10_000;
const MAX_MCP_APP_METADATA_CHARS = 2_048;

export function boundedMcpAppStatePatch(patch: McpAppStatePatch): McpAppStatePatch {
  const bounded: McpAppStatePatch = {};
  if (patch.title !== undefined) bounded.title = boundedText(patch.title, "title");
  if (patch.server !== undefined) bounded.server = boundedText(patch.server, "server");
  if (patch.resourceUri !== undefined) {
    bounded.resourceUri = boundedText(patch.resourceUri, "resource URI");
  }
  if (patch.documentId !== undefined) {
    bounded.documentId = boundedText(patch.documentId, "document id");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "widgetState")) {
    bounded.widgetState = boundedJsonClone(patch.widgetState, "widget state");
  }
  if (patch.modelContext === null) {
    bounded.modelContext = null;
  } else if (patch.modelContext !== undefined) {
    bounded.modelContext = boundedJsonClone(patch.modelContext, "model context") as Exclude<
      McpAppStatePatch["modelContext"],
      null | undefined
    >;
  }
  const serialized = JSON.stringify(bounded);
  if (utf8Bytes(serialized) > MAX_MCP_APP_STATE_BYTES) {
    throw new Error("Interactive app state exceeds the 256 KB limit.");
  }
  return bounded;
}

function boundedText(value: string, label: string): string {
  if (value.length > MAX_MCP_APP_METADATA_CHARS) {
    throw new Error(`Interactive app ${label} exceeds the 2,048 character limit.`);
  }
  return value;
}

function boundedJsonClone(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let estimatedBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_MCP_APP_STATE_NODES) {
      throw new Error(`Interactive app ${label} is too complex.`);
    }
    if (current.depth > MAX_MCP_APP_STATE_DEPTH) {
      throw new Error(`Interactive app ${label} exceeds the maximum nesting depth.`);
    }
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new Error(`Interactive app ${label} contains a non-finite number.`);
      continue;
    }
    if (typeof item === "string") {
      estimatedBytes += utf8Bytes(item);
    } else if (typeof item === "object") {
      if (seen.has(item)) throw new Error(`Interactive app ${label} must not contain cycles.`);
      seen.add(item);
      const prototype = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Interactive app ${label} must contain only JSON values.`);
      }
      for (const [key, child] of Object.entries(item)) {
        estimatedBytes += utf8Bytes(key);
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (typeof item !== "undefined") {
      throw new Error(`Interactive app ${label} must contain only JSON values.`);
    }
    if (estimatedBytes > MAX_MCP_APP_STATE_BYTES) {
      throw new Error(`Interactive app ${label} exceeds the 256 KB limit.`);
    }
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Interactive app ${label} must be JSON serializable.`);
  }
  if (serialized === undefined) return undefined;
  if (utf8Bytes(serialized) > MAX_MCP_APP_STATE_BYTES) {
    throw new Error(`Interactive app ${label} exceeds the 256 KB limit.`);
  }
  return JSON.parse(serialized) as unknown;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
