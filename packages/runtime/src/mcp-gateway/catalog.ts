import type {
  McpGatewayCatalogEntry,
  McpGatewayServerStatus,
  McpGatewayToolDefinition,
  McpGatewayToolInvocation,
} from "./types.js";

export type CatalogLookupItem = {
  alias: string;
  canonicalName?: string;
  name: string;
  remoteToolName?: string;
};

export type CatalogServerInput = {
  id: string;
  label?: string;
  namespace?: string;
  status: McpGatewayServerStatus;
  tools: McpGatewayToolDefinition[];
};

export function buildCatalogEntries(servers: CatalogServerInput[]): McpGatewayCatalogEntry[] {
  const namespaces = buildServerNamespaceMap(servers);
  const entries: McpGatewayCatalogEntry[] = [];
  for (const server of servers) {
    const serverNamespace = namespaces.get(server.id) ?? sanitizeNamespace(server.id);
    for (const tool of server.tools) {
      const remoteToolName = tool.name;
      const toolName = `mcp.${serverNamespace}.${remoteToolName}`;
      entries.push({
        alias: toCatalogAlias(toolName),
        canonicalName: `${server.id}.${remoteToolName}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        invocation: inferInvocation(tool),
        outputSchema: tool.outputSchema,
        remoteToolName,
        serverId: server.id,
        serverLabel: server.label,
        serverNamespace,
        status: server.status,
        tags: tool.tags ?? [],
        title: tool.title || tool.name,
        toolName,
      });
    }
  }
  return entries.sort((left, right) => left.toolName.localeCompare(right.toolName));
}

export function resolveCatalogItemName(
  catalog: CatalogLookupItem[],
  token: string,
): string | undefined {
  const normalized = token.trim();
  if (!normalized) return undefined;

  const lookupCandidates = unique([
    normalized,
    toCatalogAlias(normalized),
    normalized.startsWith("mcp.") ? normalized : `mcp.${normalized}`,
    normalized.startsWith("mcp_") ? normalized : `mcp_${toCatalogAlias(normalized)}`,
  ]);

  for (const item of catalog) {
    const exactNames = unique(
      [
        item.name,
        item.alias,
        item.canonicalName ?? "",
        item.canonicalName ? toCatalogAlias(item.canonicalName) : "",
      ].filter(Boolean),
    );
    for (const candidate of lookupCandidates) {
      if (exactNames.includes(candidate)) return item.name;
    }
  }

  const suffixMatches = catalog.filter((item) => matchesUniqueSuffix(item, normalized));
  return suffixMatches.length === 1 ? suffixMatches[0]?.name : undefined;
}

export function toCatalogAlias(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  if (!normalized) return "tool";
  return /^\d/.test(normalized) ? `_${normalized}` : normalized;
}

export function getSchemaRequiredProperties(schema: Record<string, unknown> | undefined): string[] {
  if (!schema || !Array.isArray(schema.required)) return [];
  return schema.required.filter((item): item is string => typeof item === "string");
}

export function tokenizeToolText(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9_]+/g, " ")
    .toLowerCase();
  return spaced.split(/\s+|_+/).filter(Boolean);
}

function buildServerNamespaceMap(servers: CatalogServerInput[]): Map<string, string> {
  const counts = new Map<string, number>();
  const result = new Map<string, string>();
  for (const server of servers) {
    const base = sanitizeNamespace(server.namespace || server.id);
    const nextCount = (counts.get(base) ?? 0) + 1;
    counts.set(base, nextCount);
    result.set(server.id, nextCount === 1 ? base : `${base}_${nextCount}`);
  }
  return result;
}

function sanitizeNamespace(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  if (!normalized) return "server";
  return /^\d/.test(normalized) ? `_${normalized}` : normalized;
}

function inferInvocation(tool: McpGatewayToolDefinition): McpGatewayToolInvocation {
  const text = `${tool.name} ${tool.title ?? ""} ${tool.description}`;
  const tokenList = tokenizeToolText(text);
  const tokens = new Set(tokenList);
  const sideEffect = hasAnyToken(tokens, [
    "book",
    "cancel",
    "commit",
    "create",
    "delete",
    "execute",
    "merge",
    "post",
    "publish",
    "purchase",
    "push",
    "remove",
    "reserve",
    "run",
    "send",
    "submit",
    "update",
    "write",
  ]);
  const workflowOnly =
    hasAnyToken(tokens, ["batch", "bulk", "foreach", "iterate", "parallel"]) ||
    hasTokenSequence(tokenList, ["for", "each"]) ||
    hasTokenSequence(tokenList, ["sync", "all"]) ||
    hasTokenSequence(tokenList, ["export", "all"]);
  return {
    mode: workflowOnly ? "workflow" : "both",
    sideEffect,
  };
}

function matchesUniqueSuffix(item: CatalogLookupItem, token: string): boolean {
  const tokenAlias = toCatalogAlias(token);
  const nameSuffix = item.name.split(".").slice(1).join(".");
  const remoteToolName = item.remoteToolName || item.name.split(".").at(-1) || "";
  const suffixes = unique(
    [
      item.canonicalName ?? "",
      item.canonicalName ? toCatalogAlias(item.canonicalName) : "",
      nameSuffix,
      toCatalogAlias(nameSuffix),
      remoteToolName,
      toCatalogAlias(remoteToolName),
    ].filter(Boolean),
  );
  return suffixes.includes(token) || suffixes.includes(tokenAlias);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasAnyToken(tokens: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.has(candidate));
}

function hasTokenSequence(tokens: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || tokens.length < sequence.length) return false;
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) return true;
  }
  return false;
}
