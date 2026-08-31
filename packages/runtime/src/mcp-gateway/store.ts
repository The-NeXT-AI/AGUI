import fs from "node:fs";
import path from "node:path";
import type { McpGatewayLlmSettings, McpGatewayServerConfig } from "./types.js";

export type McpGatewayRuntimeSettings = {
  enabled: boolean;
  llm: McpGatewayLlmSettings;
  servers: Array<McpGatewayServerConfig & { enabled: boolean }>;
};

const settingsVersion = 1;

export function readMcpGatewaySettings(userDataPath: string): McpGatewayRuntimeSettings {
  try {
    const filePath = mcpGatewaySettingsPath(userDataPath);
    if (!fs.existsSync(filePath)) return defaultMcpGatewaySettings();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeMcpGatewaySettings(parsed);
  } catch {
    return defaultMcpGatewaySettings();
  }
}

export function writeMcpGatewaySettings(
  userDataPath: string,
  settings: McpGatewayRuntimeSettings,
): McpGatewayRuntimeSettings {
  const normalized = normalizeMcpGatewaySettings(settings);
  const filePath = mcpGatewaySettingsPath(userDataPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(
    tempFile,
    `${JSON.stringify({ ...normalized, version: settingsVersion }, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(tempFile, filePath);
  return normalized;
}

export function mcpGatewaySettingsPath(userDataPath: string): string {
  return path.join(userDataPath, "mcp-gateway.json");
}

export function defaultMcpGatewaySettings(): McpGatewayRuntimeSettings {
  return {
    enabled: false,
    llm: defaultMcpGatewayLlmSettings(),
    servers: [],
  };
}

export function defaultMcpGatewayLlmSettings(): McpGatewayLlmSettings {
  return {
    apiKey: "",
    baseUrl: "",
    enabled: true,
    model: "gpt-4.1-mini",
  };
}

export function normalizeMcpGatewaySettings(value: unknown): McpGatewayRuntimeSettings {
  const record = isRecord(value) ? value : {};
  const seen = new Set<string>();
  return {
    enabled: record.enabled === true,
    llm: normalizeMcpGatewayLlmSettings(record.llm),
    servers: Array.isArray(record.servers)
      ? record.servers
          .map(normalizeMcpGatewayServer)
          .filter((server): server is McpGatewayRuntimeSettings["servers"][number] => {
            if (!server || seen.has(server.id)) return false;
            seen.add(server.id);
            return true;
          })
      : [],
  };
}

export function normalizeMcpGatewayLlmSettings(value: unknown): McpGatewayLlmSettings {
  const record = isRecord(value) ? value : {};
  return {
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
    enabled: record.enabled !== false,
    model:
      typeof record.model === "string" && record.model.trim()
        ? record.model.trim()
        : defaultMcpGatewayLlmSettings().model,
  };
}

function normalizeMcpGatewayServer(
  value: unknown,
): McpGatewayRuntimeSettings["servers"][number] | null {
  const record = isRecord(value) ? value : {};
  const id = normalizeServerId(record.id);
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!id || (!url && !command)) return null;
  const type =
    record.type === "sse" && url
      ? "sse"
      : record.type === "stdio" || (!url && command)
        ? "stdio"
        : "http";
  return {
    args: stringArray(record.args),
    authentication: normalizeAuthentication(record.authentication),
    command: command || undefined,
    enabled: record.enabled === true,
    env: stringRecord(record.env),
    headers: stringRecord(record.headers),
    id,
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
    type,
    url: url || undefined,
  };
}

function normalizeAuthentication(value: unknown): McpGatewayServerConfig["authentication"] {
  const record = isRecord(value) ? value : {};
  if (record.type === "bearer" && typeof record.token === "string" && record.token) {
    return { type: "bearer", token: record.token };
  }
  if (record.type === "api-key" && typeof record.value === "string" && record.value) {
    return {
      type: "api-key",
      headerName:
        typeof record.headerName === "string" && record.headerName.trim()
          ? record.headerName.trim()
          : "X-API-Key",
      value: record.value,
    };
  }
  if (record.type === "basic" && typeof record.username === "string") {
    return {
      type: "basic",
      username: record.username,
      password: typeof record.password === "string" ? record.password : "",
    };
  }
  return undefined;
}

function normalizeServerId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id) ? id : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return Boolean(entry[0].trim()) && typeof entry[1] === "string";
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
