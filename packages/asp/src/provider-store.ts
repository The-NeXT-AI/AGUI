import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASP_VERSION,
  type AspModel,
  type AspProvider,
  type AspProviderCapabilities,
  type AspProviderTransport,
} from "./types.js";

export type ProviderStoreOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  userDataPath?: string | (() => string);
};

type ProviderFile = {
  version: 1;
  providers: AspProvider[];
  defaultProvidersSeeded?: boolean;
};

export class ProviderStore {
  private providers: AspProvider[] | null = null;

  constructor(private readonly options: ProviderStoreOptions = {}) {}

  list(): AspProvider[] {
    this.load();
    return this.providers!.map(cloneProvider);
  }

  get(id: string): AspProvider | undefined {
    return this.list().find((provider) => provider.id === id);
  }

  save(provider: AspProvider): AspProvider {
    const normalized = normalizeProvider(provider);
    this.load();
    const index = this.providers!.findIndex((item) => item.id === normalized.id);
    if (index >= 0) this.providers![index] = normalized;
    else this.providers!.push(normalized);
    this.persist();
    return cloneProvider(normalized);
  }

  remove(id: string): boolean {
    this.load();
    const next = this.providers!.filter((provider) => provider.id !== id);
    if (next.length === this.providers!.length) return false;
    this.providers = next;
    this.persist();
    return true;
  }

  private load(): void {
    if (this.providers) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as Partial<ProviderFile>;
      const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : [];
      const raw = rawProviders.map((provider) => normalizeProvider(provider));
      this.providers =
        parsed.defaultProvidersSeeded === true
          ? removeSeededDefaultProviders(dedupeProviders(raw), defaultProviders(this.options))
          : dedupeProviders(raw);
      if (
        parsed.defaultProvidersSeeded === true ||
        JSON.stringify(rawProviders) !== JSON.stringify(this.providers)
      ) {
        this.persist();
      }
      return;
    } catch {
      this.providers = [];
      this.persist();
    }
  }

  private persist(): void {
    const filePath = this.filePath();
    const tempPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      tempPath,
      `${JSON.stringify(
        {
          version: 1,
          providers: this.providers ?? [],
          defaultProvidersSeeded: false,
        } satisfies ProviderFile,
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.renameSync(tempPath, filePath);
  }

  private filePath(): string {
    return path.join(userDataPath(this.options), "asp-providers.json");
  }
}

function removeSeededDefaultProviders(
  providers: AspProvider[],
  defaults: AspProvider[],
): AspProvider[] {
  const defaultsById = new Map(defaults.map((provider) => [provider.id, provider]));
  return providers.filter((provider) => {
    const defaultProvider = defaultsById.get(provider.id);
    return !defaultProvider || !matchesSeededDefaultProvider(provider, defaultProvider);
  });
}

function matchesSeededDefaultProvider(
  provider: AspProvider,
  defaultProvider: AspProvider,
): boolean {
  const comparableProvider = providerComparableForSeedRemoval(provider);
  const comparableDefault = providerComparableForSeedRemoval(defaultProvider);
  return JSON.stringify(comparableProvider) === JSON.stringify(comparableDefault);
}

function providerComparableForSeedRemoval(
  provider: AspProvider,
): Omit<AspProvider, "capabilities" | "description" | "enabled" | "models" | "name"> {
  const {
    capabilities: _capabilities,
    description: _description,
    enabled: _enabled,
    models: _models,
    name: _name,
    ...rest
  } = provider;
  return rest;
}

function dedupeProviders(providers: AspProvider[]): AspProvider[] {
  const byId = new Map<string, AspProvider>();
  for (const provider of providers) byId.set(provider.id, provider);
  return providers.filter((provider) => byId.get(provider.id) === provider);
}

function userDataPath(options: ProviderStoreOptions): string {
  if (typeof options.userDataPath === "function") return options.userDataPath();
  if (typeof options.userDataPath === "string" && options.userDataPath.trim()) {
    return path.resolve(options.userDataPath);
  }
  const env = options.env ?? process.env;
  const fromEnv = env.AG_UI_USER_DATA_DIR ?? env.AGUI_USER_DATA_DIR;
  if (fromEnv?.trim()) return path.resolve(fromEnv);
  const aguiHome = env.AG_UI_HOME ?? env.AGUI_HOME;
  if (aguiHome?.trim()) return path.resolve(aguiHome);
  return path.join(options.homeDir ?? os.homedir(), ".agui");
}

function normalizeProvider(value: AspProvider): AspProvider {
  const id = string(value.id).replace(/[^a-zA-Z0-9._-]/g, "-");
  const transport = normalizeTransport(value.transport, value.url);
  const commandParts = splitProviderCommand(string(value.command));
  const capabilities = normalizeRuntimeAdapterCapability(normalizeCapabilities(value.capabilities));
  const command = commandParts[0] ?? "";
  const runtimeAdapter = string(record(capabilities).runtimeAdapter);
  const args = normalizeProviderArgsForRuntimeAdapter(
    [...commandParts.slice(1), ...stringArray(value.args)],
    runtimeAdapter,
  );
  const normalizedCapabilities =
    runtimeAdapter === "codex-app-server" ? { ...capabilities, models: true } : capabilities;
  const url = string(value.url);
  if (!id) throw new Error("Provider id is required.");
  if (
    (transport === "stdio" || transport === "persistent-stdio") &&
    !command &&
    !(runtimeAdapter === "opencode-server" && /^https?:\/\//i.test(url))
  ) {
    throw new Error("Provider command is required for ASP stdio.");
  }
  if ((transport === "websocket" || transport === "ssh") && !url) {
    throw new Error(`Provider URL is required for ASP ${transport}.`);
  }
  return {
    id,
    name: string(value.name) || id,
    description: string(value.description) || undefined,
    command,
    args,
    env: environment(value.env),
    enabled: value.enabled !== false,
    transport,
    url: url || undefined,
    installCommand: string(value.installCommand) || undefined,
    timeoutMs: positiveInteger(value.timeoutMs),
    capabilities: normalizedCapabilities,
    models: normalizeModels(value.models),
  };
}

function normalizeRuntimeAdapterCapability(
  capabilities: AspProviderCapabilities | undefined,
): AspProviderCapabilities | undefined {
  if (!capabilities) return capabilities;
  const runtimeAdapter = normalizeRuntimeAdapterAlias(string(capabilities.runtimeAdapter));
  if (!runtimeAdapter || runtimeAdapter === capabilities.runtimeAdapter) return capabilities;
  return { ...capabilities, runtimeAdapter };
}

function normalizeRuntimeAdapterAlias(value: string): string {
  const adapter = value.trim();
  const normalized = adapter.toLowerCase();
  if (normalized === "grok-agent-stdio") return "grok-cli";
  if (normalized === "kimi-acp-stdio") return "kimi-cli";
  return adapter;
}

function normalizeProviderArgsForRuntimeAdapter(args: string[], runtimeAdapter: string): string[] {
  if (runtimeAdapter !== "kimi-cli") return args;
  const [first, ...rest] = args;
  return first?.trim().toLowerCase() === "acp" ? rest : args;
}

function defaultProviders(options: ProviderStoreOptions = {}): AspProvider[] {
  return [
    defaultProvider(
      "codex",
      "Codex",
      "Runs Codex as a native Agent Server Protocol provider backed by codex app-server.",
      "codex",
      runtimeCapabilityDefaults("codex"),
      [],
      codexModelDefaults(options),
    ),
    defaultProvider(
      "claude-code",
      "Claude Code",
      "Runs Claude Code as a native Agent Server Protocol provider backed by its stream-json SDK protocol.",
      "claude",
      runtimeCapabilityDefaults("claude"),
    ),
    defaultProvider(
      "opencode",
      "OpenCode",
      "Runs OpenCode as a native Agent Server Protocol provider backed by opencode serve.",
      "opencode",
      runtimeCapabilityDefaults("opencode"),
    ),
    defaultProvider(
      "pi",
      "Pi",
      "Runs Pi as a native Agent Server Protocol provider backed by pi rpc mode.",
      "pi",
      runtimeCapabilityDefaults("pi"),
    ),
    defaultProvider(
      "kimi",
      "Kimi",
      "Runs Kimi through its native headless CLI stream.",
      "kimi",
      runtimeCapabilityDefaults("kimi"),
    ),
    defaultProvider(
      "kilo",
      "Kilo",
      "Runs Kilo as an ASP stdio provider.",
      "kilo",
      genericAspCapabilityDefaults(),
    ),
    defaultProvider(
      "grok",
      "Grok",
      "Runs Grok through its native headless CLI stream.",
      "grok",
      runtimeCapabilityDefaults("grok"),
    ),
  ];
}

function defaultProvider(
  id: string,
  name: string,
  description: string,
  command: string,
  capabilities: Record<string, unknown>,
  args: string[] = [],
  models: AspModel[] = [],
): AspProvider {
  return normalizeProvider({
    id,
    name,
    description,
    command,
    args,
    env: {},
    enabled: true,
    transport: "stdio",
    capabilities,
    models,
  });
}

function codexModelDefaults(options: ProviderStoreOptions): AspModel[] {
  const configuredModel = readCodexConfiguredModel(options);
  return modelDefaults(
    [
      configuredModel,
      "gpt-5-codex",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5",
    ],
    configuredModel || "gpt-5-codex",
    {
      "gpt-5-codex": "GPT-5",
      "gpt-5.5": "GPT-5.5",
      "gpt-5.4": "GPT-5.4",
      "gpt-5.3-codex": "GPT-5.3",
      "gpt-5.2-codex": "GPT-5.2",
      "gpt-5": "GPT-5",
    },
  ).map((model) => ({
    ...model,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: codexReasoningEfforts(),
    supportedSpeeds: ["default", "fast"],
  }));
}

function modelDefaults(
  models: Array<string | undefined>,
  defaultModel: string,
  displayNames: Record<string, string>,
): AspModel[] {
  const unique = [...new Set(models.map((model) => string(model)).filter(Boolean))];
  return unique.map((model) => ({
    id: model,
    model,
    displayName: displayNames[model] || model,
    isDefault: model === defaultModel,
  }));
}

function codexReasoningEfforts(): NonNullable<AspModel["supportedReasoningEfforts"]> {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
}

function readCodexConfiguredModel(options: ProviderStoreOptions): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const codexHome = string(env.CODEX_HOME) || path.join(homeDir, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  try {
    const config = fs.readFileSync(configPath, "utf8");
    const match = config.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
    return string(match?.[1]);
  } catch {
    return "";
  }
}

function runtimeCapabilityDefaults(kind: string): Record<string, unknown> {
  if (kind === "codex") {
    return {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: ["text", "tool", "reasoning", "status", "resource", "artifact", "diff", "raw"],
      deleteSession: true,
      diffs: true,
      humanInput: true,
      models: true,
      reasoningEfforts: codexReasoningEfforts(),
      resumeSession: true,
      runtimeAdapter: "codex-app-server",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "codex-app-server",
      workspace: true,
    };
  }
  if (kind === "claude") {
    return {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: ["text", "tool", "reasoning", "status", "resource", "artifact", "diff", "raw"],
      deleteSession: true,
      diffs: true,
      humanInput: true,
      models: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      resumeSession: true,
      runtimeAdapter: "claude-code-stream-json",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "claude-code-stream-json",
      workspace: true,
    };
  }
  if (kind === "opencode") {
    return {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: [
        "text",
        "tool",
        "reasoning",
        "plan",
        "status",
        "resource",
        "artifact",
        "diff",
        "raw",
      ],
      diffs: true,
      humanInput: true,
      models: true,
      resumeSession: true,
      runtimeAdapter: "opencode-server",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "opencode-http-sse",
      workspace: true,
    };
  }
  if (kind === "pi") {
    return {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: ["text", "tool", "reasoning", "status", "raw"],
      humanInput: true,
      models: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      runtimeAdapter: "pi-rpc",
      sessionHistory: false,
      sessions: false,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "pi-rpc-jsonl",
      workspace: true,
    };
  }
  if (kind === "grok") {
    return {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: [
        "text",
        "tool",
        "reasoning",
        "plan",
        "status",
        "resource",
        "artifact",
        "diff",
        "raw",
      ],
      deleteSession: true,
      humanInput: true,
      models: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      resumeSession: true,
      runtimeAdapter: "grok-cli",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "grok-streaming-messages-json",
      workspace: true,
    };
  }
  if (kind === "kimi") {
    return {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: [
        "text",
        "tool",
        "reasoning",
        "plan",
        "status",
        "resource",
        "artifact",
        "diff",
        "raw",
      ],
      deleteSession: true,
      humanInput: true,
      models: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      resumeSession: true,
      runtimeAdapter: "kimi-cli",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "kimi-stream-json",
      workspace: true,
    };
  }
  return {};
}

function genericAspCapabilityDefaults(): Record<string, unknown> {
  return {
    approvalModes: ["request", "auto", "full"],
    approvalScopes: ["command", "filesystem", "network", "tool"],
    contentParts: [
      "text",
      "tool",
      "reasoning",
      "plan",
      "status",
      "resource",
      "artifact",
      "diff",
      "citation",
      "raw",
    ],
    humanInput: true,
    models: true,
    protocolVersions: [ASP_VERSION],
    toolEvents: true,
    transports: ["stdio"],
    wireProtocol: "agent-server-protocol",
    workspace: true,
  };
}

function normalizeCapabilities(value: unknown): AspProviderCapabilities | undefined {
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  return {
    ...source,
    protocolVersions: stringArray(source.protocolVersions).length
      ? stringArray(source.protocolVersions)
      : [ASP_VERSION],
    approvalModes: enumArray(source.approvalModes, ["request", "auto", "full"]),
    approvalScopes: stringArray(source.approvalScopes),
    contentParts: enumArray(source.contentParts, [
      "text",
      "tool",
      "reasoning",
      "plan",
      "status",
      "resource",
      "artifact",
      "diff",
      "citation",
      "raw",
    ]),
    reasoningEfforts: enumArray(source.reasoningEfforts, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    speeds: enumArray(source.speeds, ["default", "fast"]),
    transports: enumArray(source.transports, ["stdio", "persistent-stdio", "websocket", "ssh"]),
  } as AspProviderCapabilities;
}

function normalizeModels(value: unknown, defaultModel = ""): AspModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AspModel | null => {
      if (typeof item === "string") {
        return {
          id: item,
          model: item,
          displayName: item,
          isDefault: item === defaultModel,
        };
      }
      const source = record(item);
      const model = string(source.model) || string(source.id);
      if (!model) return null;
      return {
        id: string(source.id) || model,
        model,
        displayName: string(source.displayName) || string(source.label) || model,
        isDefault: source.isDefault === true || source.default === true || model === defaultModel,
        hidden: source.hidden === true,
        contextWindowTokens: positiveInteger(
          source.contextWindowTokens ?? source.context_window_tokens,
        ),
        defaultReasoningEffort: normalizeEffort(
          source.defaultReasoningEffort ??
            source.default_reasoning_effort ??
            source.defaultReasoningLevel ??
            source.default_reasoning_level ??
            source.defaultEffort ??
            source.default_effort,
        ),
        supportedReasoningEfforts: normalizeReasoningEfforts(
          source.supportedReasoningEfforts ??
            source.supported_reasoning_efforts ??
            source.reasoningEfforts ??
            source.reasoning_efforts ??
            source.supportEfforts ??
            source.support_efforts ??
            source.thinkingLevels ??
            source.thinking_levels,
        ),
        supportedSpeeds: enumArray(source.supportedSpeeds ?? source.supported_speeds, [
          "default",
          "fast",
        ]),
      };
    })
    .filter((model): model is AspModel => Boolean(model));
}

function normalizeTransport(value: unknown, url: unknown): AspProviderTransport {
  const transport = string(value);
  if (
    transport === "stdio" ||
    transport === "persistent-stdio" ||
    transport === "websocket" ||
    transport === "ssh"
  ) {
    return transport;
  }
  const address = string(url);
  if (address.startsWith("ws://") || address.startsWith("wss://")) return "websocket";
  if (address.startsWith("ssh://")) return "ssh";
  return "stdio";
}

function normalizeEffort(value: unknown): AspModel["defaultReasoningEffort"] {
  const effort = string(value);
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
    ? (effort as AspModel["defaultReasoningEffort"])
    : undefined;
}

function normalizeReasoningEfforts(value: unknown): AspModel["supportedReasoningEfforts"] {
  if (!Array.isArray(value)) return undefined;
  const efforts = value
    .map((item) => {
      if (typeof item === "string") return item;
      const source = record(item);
      return string(
        source.reasoningEffort ??
          source.reasoning_effort ??
          source.effort ??
          source.level ??
          source.value ??
          source.id,
      );
    })
    .map(normalizeEffort)
    .filter((effort): effort is NonNullable<AspModel["defaultReasoningEffort"]> => Boolean(effort));
  return efforts.length ? [...new Set(efforts)] : undefined;
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const items = stringArray(value).filter((item): item is T => allowed.includes(item as T));
  return items.length ? items : undefined;
}

function environment(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value))
      .map(([key, entry]) => [key.trim(), typeof entry === "string" ? entry : String(entry)])
      .filter(([key]) => Boolean(key)),
  );
}

function cloneProvider(provider: AspProvider): AspProvider {
  return {
    ...provider,
    args: [...provider.args],
    env: { ...provider.env },
    capabilities: provider.capabilities ? { ...provider.capabilities } : undefined,
    models: provider.models?.map((model) => ({ ...model })),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function splitProviderCommand(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? "" : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? "" : '"';
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) parts.push(current);
  return parts;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
