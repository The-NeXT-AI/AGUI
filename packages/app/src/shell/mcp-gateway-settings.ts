import type {
  McpGatewayLlmSettings,
  McpGatewayManagedServer,
  McpGatewayServerConfig,
} from "@/asp/desktop-api";
import { t as translateText } from "@/lib/i18n";
import {
  isPlainRecord,
  parseStringRecordJson,
  stringArrayFromUnknown,
  stringFromUnknown,
  stringRecordFromUnknown,
} from "./settings-json";

export type McpGatewayServerForm = {
  argsText: string;
  authHeaderName: string;
  authPassword: string;
  authToken: string;
  authType: "api-key" | "basic" | "bearer" | "none";
  authUsername: string;
  authValue: string;
  command: string;
  enabled: boolean;
  envText: string;
  headersText: string;
  id: string;
  label: string;
  type: "http" | "sse" | "stdio";
  url: string;
};

export function defaultMcpGatewayLlmForm(): McpGatewayLlmSettings {
  return {
    apiKey: "",
    baseUrl: "",
    enabled: true,
    model: "gpt-4.1-mini",
  };
}

export function normalizeMcpGatewayLlmForm(
  value: Partial<McpGatewayLlmSettings> | undefined,
): McpGatewayLlmSettings {
  return {
    apiKey: value?.apiKey ?? "",
    baseUrl: value?.baseUrl ?? "",
    enabled: value?.enabled !== false,
    model: value?.model?.trim() || "gpt-4.1-mini",
  };
}

export function emptyMcpGatewayForm(): McpGatewayServerForm {
  return {
    argsText: "",
    authHeaderName: "X-API-Key",
    authPassword: "",
    authToken: "",
    authType: "none",
    authUsername: "",
    authValue: "",
    command: "",
    enabled: true,
    envText: "{}",
    headersText: "{}",
    id: `mcp-${Date.now().toString(36)}`,
    label: translateText("settings.mcpGateway.customMcp"),
    type: "http",
    url: "http://127.0.0.1:8787/mcp",
  };
}

export function mcpGatewayFormFromServer(server: McpGatewayManagedServer): McpGatewayServerForm {
  const authentication = server.authentication;
  return {
    argsText: (server.args ?? []).join("\n"),
    authHeaderName:
      authentication?.type === "api-key" ? (authentication.headerName ?? "X-API-Key") : "X-API-Key",
    authPassword: authentication?.type === "basic" ? authentication.password : "",
    authToken: authentication?.type === "bearer" ? authentication.token : "",
    authType: authentication?.type && authentication.type !== "none" ? authentication.type : "none",
    authUsername: authentication?.type === "basic" ? authentication.username : "",
    authValue: authentication?.type === "api-key" ? authentication.value : "",
    command: server.command ?? "",
    enabled: server.enabled,
    envText: JSON.stringify(server.env ?? {}, null, 2),
    headersText: JSON.stringify(server.headers ?? {}, null, 2),
    id: server.id,
    label: server.label || server.id,
    type: server.type === "sse" || server.type === "stdio" ? server.type : "http",
    url: server.url ?? "",
  };
}

export function mcpGatewayConfigFromManagedServer(
  server: McpGatewayManagedServer,
  overrides: { enabled?: boolean } = {},
): McpGatewayServerConfig {
  const parsed = mcpGatewayServerFromForm({
    ...mcpGatewayFormFromServer(server),
    enabled: overrides.enabled ?? server.enabled,
  });
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

export function mcpGatewayConfigsFromImportJson(value: string): McpGatewayServerConfig[] | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return new Error(
      error instanceof Error
        ? error.message
        : translateText("settings.mcpGateway.error.invalidJson"),
    );
  }

  const entries = mcpGatewayImportEntries(parsed);
  if (entries instanceof Error) return entries;
  const configs: McpGatewayServerConfig[] = [];
  for (const entry of entries) {
    const config = mcpGatewayConfigFromImportEntry(entry.id, entry.value);
    if (config instanceof Error) return config;
    configs.push(config);
  }
  return configs;
}

export function mcpGatewayServerFromForm(
  form: McpGatewayServerForm,
): McpGatewayServerConfig | Error {
  const id = form.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) {
    return new Error(translateText("settings.mcpGateway.error.idInvalid"));
  }
  const env = parseStringRecordJson(form.envText, translateText("settings.field.environment"));
  if (env instanceof Error) return env;
  const headers = parseStringRecordJson(form.headersText, translateText("settings.field.headers"));
  if (headers instanceof Error) return headers;

  if (form.type === "stdio") {
    const command = form.command.trim();
    if (!command) return new Error(translateText("settings.mcpGateway.error.stdioRequiresCommand"));
    return {
      args: form.argsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      command,
      enabled: form.enabled,
      env,
      headers: {},
      id,
      label: form.label.trim() || id,
      type: "stdio",
    };
  }

  const url = form.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return new Error(translateText("settings.mcpGateway.error.httpUrlRequired"));
  }
  const authentication = mcpGatewayAuthenticationFromForm(form);
  if (authentication instanceof Error) return authentication;
  return {
    authentication,
    enabled: form.enabled,
    env: {},
    headers,
    id,
    label: form.label.trim() || id,
    type: form.type,
    url,
  };
}

function mcpGatewayImportEntries(
  value: unknown,
): Array<{ id: string; value: Record<string, unknown> }> | Error {
  if (!isPlainRecord(value))
    return new Error(translateText("settings.mcpGateway.error.mustBeObject"));
  const mcpServers = value.mcpServers;
  if (mcpServers !== undefined) {
    if (!isPlainRecord(mcpServers))
      return new Error(translateText("settings.mcpGateway.error.mcpServersObject"));
    const entries = Object.entries(mcpServers)
      .filter(([, entry]) => isPlainRecord(entry))
      .map(([id, entry]) => ({ id, value: entry as Record<string, unknown> }));
    return entries.length
      ? entries
      : new Error(translateText("settings.mcpGateway.error.noServerObjects"));
  }

  if (looksLikeMcpServerObject(value)) {
    return [
      { id: stringFromUnknown(value.id) ?? stringFromUnknown(value.name) ?? "custom-mcp", value },
    ];
  }

  const objectEntries = Object.entries(value).filter(([, entry]) => isPlainRecord(entry));
  if (objectEntries.length === 1 && looksLikeMcpServerObject(objectEntries[0]![1])) {
    return [{ id: objectEntries[0]![0], value: objectEntries[0]![1] as Record<string, unknown> }];
  }
  return new Error(translateText("settings.mcpGateway.error.importShape"));
}

function mcpGatewayConfigFromImportEntry(
  idHint: string,
  value: Record<string, unknown>,
): McpGatewayServerConfig | Error {
  const transport = mcpGatewayTransportFromImport(value);
  if (transport instanceof Error) return transport;
  const id = normalizeMcpGatewayImportId(
    stringFromUnknown(value.id) ?? stringFromUnknown(value.name) ?? idHint,
  );
  const label = stringFromUnknown(value.label) ?? stringFromUnknown(value.name) ?? id;
  const enabled =
    typeof value.enabled === "boolean"
      ? value.enabled
      : typeof value.disabled === "boolean"
        ? !value.disabled
        : true;
  const env = stringRecordFromUnknown(value.env, translateText("settings.field.environment"));
  if (env instanceof Error) return env;
  const headers = stringRecordFromUnknown(value.headers, translateText("settings.field.headers"));
  if (headers instanceof Error) return headers;

  if (transport === "stdio") {
    const command = stringFromUnknown(value.command) ?? stringFromUnknown(value.cmd);
    if (!command)
      return new Error(translateText("settings.mcpGateway.error.stdioMissingCommand", { id }));
    const args = stringArrayFromUnknown(
      value.args,
      translateText("settings.field.argumentsCommaOnePerLine"),
    );
    if (args instanceof Error) return args;
    return {
      args,
      command,
      enabled,
      env,
      headers: {},
      id,
      label,
      type: "stdio",
    };
  }

  const url = stringFromUnknown(value.url) ?? stringFromUnknown(value.endpoint);
  if (!url) return new Error(translateText("settings.mcpGateway.error.missingUrl", { id }));
  if (!/^https?:\/\//i.test(url))
    return new Error(translateText("settings.mcpGateway.error.urlProtocol", { id }));
  return {
    enabled,
    env: {},
    headers,
    id,
    label,
    type: transport,
    url,
  };
}

function mcpGatewayTransportFromImport(
  value: Record<string, unknown>,
): McpGatewayServerForm["type"] | Error {
  const raw = stringFromUnknown(value.type) ?? stringFromUnknown(value.transport);
  const normalized = raw?.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "sse") return "sse";
  if (normalized === "stdio") return "stdio";
  if (normalized === "http" || normalized === "streamablehttp") return "http";
  if (!normalized) {
    if (stringFromUnknown(value.command) || stringFromUnknown(value.cmd)) return "stdio";
    if (stringFromUnknown(value.url) || stringFromUnknown(value.endpoint)) return "http";
  }
  return new Error(
    translateText("settings.mcpGateway.error.unsupportedTransport", {
      transport: raw ? ` "${raw}"` : "",
    }),
  );
}

function looksLikeMcpServerObject(value: unknown): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    (value.type !== undefined ||
      value.transport !== undefined ||
      value.url !== undefined ||
      value.endpoint !== undefined ||
      value.command !== undefined ||
      value.cmd !== undefined)
  );
}

function normalizeMcpGatewayImportId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(normalized)) return normalized;
  return `mcp-${Date.now().toString(36)}`;
}

function mcpGatewayAuthenticationFromForm(
  form: McpGatewayServerForm,
): McpGatewayServerConfig["authentication"] | Error {
  if (form.authType === "none") return undefined;
  if (form.authType === "bearer") {
    const token = form.authToken.trim();
    return token
      ? { type: "bearer", token }
      : new Error(translateText("settings.mcpGateway.error.bearerTokenRequired"));
  }
  if (form.authType === "api-key") {
    const headerName = form.authHeaderName.trim();
    const value = form.authValue.trim();
    return headerName && value
      ? { type: "api-key", headerName, value }
      : new Error(translateText("settings.mcpGateway.error.apiKeyRequired"));
  }
  const username = form.authUsername.trim();
  return username
    ? { type: "basic", username, password: form.authPassword }
    : new Error(translateText("settings.mcpGateway.error.basicUsernameRequired"));
}
