import * as ts from "typescript";
import {
  buildCatalogEntries,
  getSchemaRequiredProperties,
  resolveCatalogItemName,
  tokenizeToolText,
} from "./catalog.js";
import {
  OpenAiCodeToolSearchAgent,
  type CodeToolSearchCatalogItem,
} from "./code-tool-search-agent.js";
import { createMcpGatewayClient } from "./mcp-client.js";
import { VmWorkflowSandbox } from "./workflow-sandbox.js";
import type {
  McpGatewayCatalogEntry,
  McpGatewayLlmSettings,
  McpGatewayMcpExport,
  McpGatewayOptions,
  McpGatewayResolveInput,
  McpGatewayResolveResult,
  McpGatewayResolverResult,
  McpGatewayServerConfig,
  McpGatewayServerStatus,
  McpGatewayServerView,
  McpGatewaySummary,
  McpGatewayToolDefinition,
  McpGatewayToolProvider,
  McpGatewayUserInputRequest,
  McpGatewayWorkflowOptions,
  McpGatewayWorkflowPlanStep,
} from "./types.js";

type SourceEntry = {
  error?: string;
  extensionId?: string;
  id: string;
  label?: string;
  lastCheckedAt?: number;
  lastSeenOnlineAt?: number;
  namespace?: string;
  provider: McpGatewayToolProvider;
  readOnly?: boolean;
  scopeKey?: string;
  source?: string;
  status: McpGatewayServerStatus;
  tools: McpGatewayToolDefinition[];
  type: McpGatewayServerConfig["type"] | "provider";
};

type SessionState = {
  inFlightResolves: Map<string, Promise<McpGatewayResolveResult>>;
  loadedTools: Set<string>;
  recentObservations: Array<{
    resultSummary: string;
    toolName: string;
  }>;
  recentlyResolvedTasks: Array<{
    resolvedAt: number;
    taskHash: string;
    toolNames: string[];
  }>;
};

const gatewayScopeArg = "__mcpGatewayScopeKey";
const defaultScopeKey = "default";
const defaultGatewayName = "agui-mcp-gateway";
const defaultGatewayVersion = "0.1.0";
const defaultMaxTools = 5;
const maxResolveTools = 20;
const defaultResolveLlmModel = "gpt-4.1-mini";
const defaultResolveLlmTimeoutMs = 60_000;
const repeatedResolveWindowMs = 5 * 60_000;
const defaultWorkflowTimeoutMs = 60_000;
const maxWorkflowTimeoutMs = 5 * 60_000;
const defaultMaxToolCalls = 40;

export class McpGateway {
  private readonly options: McpGatewayOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sources = new Map<string, SourceEntry>();
  private catalogCache: McpGatewayCatalogEntry[] | undefined;
  private discoveryPromise: Promise<void> | undefined;
  private llmSettings: McpGatewayLlmSettings;

  constructor(options: McpGatewayOptions = {}) {
    this.options = {
      ...options,
      sandbox: options.sandbox ?? new VmWorkflowSandbox(),
    };
    this.llmSettings = normalizeMcpGatewayLlmRuntimeSettings(options.llm);
  }

  configure(input: { llm?: McpGatewayLlmSettings }): void {
    this.llmSettings = normalizeMcpGatewayLlmRuntimeSettings(input.llm);
  }

  exportMcp(): McpGatewayMcpExport {
    return {
      server: {
        name: this.options.name || defaultGatewayName,
        version: this.options.version || defaultGatewayVersion,
      },
      tools: buildMetaToolDefinitions(),
    };
  }

  registerMcpServer(
    config: McpGatewayServerConfig,
    options: {
      extensionId?: string;
      namespace?: string;
      readOnly?: boolean;
      scopeKey?: string;
      source?: string;
    } = {},
  ): void {
    const id = normalizeServerId(config.id);
    if (!id) throw new Error("MCP Gateway server id is required.");
    if (!config.url && !config.command) {
      throw new Error(`MCP Gateway server ${id} requires url or command.`);
    }
    const provider = createMcpGatewayClient({
      ...config,
      id,
    });
    this.setSource({
      extensionId: options.extensionId,
      id,
      label: config.label,
      namespace: options.namespace,
      provider,
      readOnly: options.readOnly,
      scopeKey: options.scopeKey,
      source: options.source,
      status: "unknown",
      tools: [],
      type: config.type ?? (config.url ? "http" : "stdio"),
    });
  }

  registerScopedMcpServer(
    scopeKey: string,
    config: McpGatewayServerConfig,
    options: { extensionId?: string; readOnly?: boolean; source?: string } = {},
  ): string {
    const originalId = normalizeServerId(config.id);
    if (!originalId) throw new Error("MCP Gateway server id is required.");
    const id = scopedServerId(scopeKey, originalId);
    this.registerMcpServer(
      {
        ...config,
        id,
      },
      {
        extensionId: options.extensionId,
        namespace: originalId,
        readOnly: options.readOnly,
        scopeKey,
        source: options.source,
      },
    );
    return id;
  }

  registerToolProvider(input: {
    id: string;
    label?: string;
    provider: McpGatewayToolProvider;
  }): void {
    const id = normalizeServerId(input.id);
    if (!id) throw new Error("MCP Gateway provider id is required.");
    this.setSource({
      id,
      label: input.label,
      provider: input.provider,
      status: "unknown",
      tools: [],
      type: "provider",
    });
  }

  registerScopedToolProvider(
    scopeKey: string,
    input: {
      id: string;
      label?: string;
      provider: McpGatewayToolProvider;
      readOnly?: boolean;
      source?: string;
    },
  ): string {
    const originalId = normalizeServerId(input.id);
    if (!originalId) throw new Error("MCP Gateway provider id is required.");
    const id = scopedServerId(scopeKey, originalId);
    this.setSource({
      id,
      label: input.label,
      namespace: originalId,
      provider: input.provider,
      readOnly: input.readOnly,
      scopeKey,
      source: input.source,
      status: "unknown",
      tools: [],
      type: "provider",
    });
    return id;
  }

  async unregisterServer(id: string): Promise<void> {
    const source = this.sources.get(id);
    this.sources.delete(id);
    this.invalidateCatalog();
    await source?.provider.close?.();
  }

  async unregisterScope(scopeKey: string): Promise<void> {
    const ids = [...this.sources.values()]
      .filter((source) => source.scopeKey === scopeKey)
      .map((source) => source.id);
    this.sessions.delete(scopeKey);
    await Promise.allSettled(ids.map((id) => this.unregisterServer(id)));
  }

  hasSources(): boolean {
    return this.sources.size > 0;
  }

  hasScopeSources(scopeKey: string): boolean {
    return [...this.sources.values()].some((source) => source.scopeKey === scopeKey);
  }

  notifyCatalogChanged(): void {
    this.invalidateCatalog();
  }

  async clear(): Promise<void> {
    const providers = [...this.sources.values()].map((source) => source.provider);
    this.sources.clear();
    this.sessions.clear();
    this.invalidateCatalog();
    await Promise.allSettled(providers.map((provider) => provider.close?.()));
  }

  async refresh(): Promise<{
    servers: McpGatewayServerView[];
    summary: McpGatewaySummary;
    tools: McpGatewayCatalogEntry[];
  }> {
    this.invalidateCatalog();
    await this.ensureDiscovery();
    return {
      servers: await this.listServers(),
      summary: await this.getSummary(),
      tools: await this.listTools(),
    };
  }

  async listTools(scopeKey?: string): Promise<McpGatewayCatalogEntry[]> {
    await this.ensureDiscovery();
    return this.catalogForScope(scopeKey);
  }

  async listServers(scopeKey?: string): Promise<McpGatewayServerView[]> {
    await this.ensureDiscovery();
    const catalog = this.catalogForScope(scopeKey);
    return [...this.sources.values()]
      .filter((source) => this.sourceVisibleForScope(source, scopeKey))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((source) => {
        const tools = catalog.filter((tool) => tool.serverId === source.id);
        return {
          error: source.error,
          extensionId: source.extensionId,
          id: source.id,
          label: source.label,
          lastCheckedAt: toIso(source.lastCheckedAt),
          lastSeenOnlineAt: toIso(source.lastSeenOnlineAt),
          namespace: source.namespace,
          readOnly: source.readOnly,
          source: source.source,
          status: source.status,
          toolCount: tools.length,
          tools,
          type: source.type ?? "provider",
        };
      });
  }

  async getSummary(scopeKey?: string): Promise<McpGatewaySummary> {
    await this.ensureDiscovery();
    const servers = [...this.sources.values()].filter((source) =>
      this.sourceVisibleForScope(source, scopeKey),
    );
    const toolCount = servers.reduce((total, source) => total + source.tools.length, 0);
    return {
      offlineServerCount: servers.filter((source) => source.status === "offline").length,
      onlineServerCount: servers.filter((source) => source.status === "online").length,
      serverCount: servers.length,
      toolCount,
      unknownServerCount: servers.filter((source) => source.status === "unknown").length,
    };
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const toolName = normalizeMetaToolName(name);
    if (toolName === "code_tool.resolve")
      return this.executeResolve(input as McpGatewayResolveInput);
    if (toolName === "code_tool.invoke") return this.executeInvoke(input);
    if (toolName === "code_tool.workflow") return this.executeWorkflow(input);
    if (toolName === "code_tool.request_user_input") return this.executeRequestUserInput(input);
    throw new Error(
      `MCP Gateway only exposes code_tool.resolve, code_tool.invoke, code_tool.workflow, and code_tool.request_user_input: ${name}`,
    );
  }

  private setSource(source: SourceEntry): void {
    const existing = this.sources.get(source.id);
    void existing?.provider.close?.();
    this.sources.set(source.id, source);
    this.invalidateCatalog();
  }

  private invalidateCatalog(): void {
    this.catalogCache = undefined;
  }

  private catalogForScope(scopeKey?: string): McpGatewayCatalogEntry[] {
    const catalog = this.catalogCache ?? [];
    return catalog.filter((entry) =>
      this.sourceVisibleForScope(this.sources.get(entry.serverId), scopeKey),
    );
  }

  private sourceVisibleForScope(source: SourceEntry | undefined, scopeKey?: string): boolean {
    if (!source) return false;
    if (!source.scopeKey) return true;
    return Boolean(scopeKey && source.scopeKey === scopeKey);
  }

  private async ensureDiscovery(): Promise<void> {
    if (this.catalogCache) return;
    if (this.discoveryPromise) {
      await this.discoveryPromise;
      return;
    }
    this.discoveryPromise = this.discoverSources();
    try {
      await this.discoveryPromise;
    } finally {
      this.discoveryPromise = undefined;
    }
  }

  private async discoverSources(): Promise<void> {
    for (const source of this.sources.values()) {
      const now = Date.now();
      try {
        const tools = await Promise.resolve(source.provider.listTools());
        source.status = "online";
        source.tools = tools.map((tool) => ({ ...tool }));
        source.error = undefined;
        source.lastCheckedAt = now;
        source.lastSeenOnlineAt = now;
      } catch (error) {
        source.status = "offline";
        source.tools = [];
        source.error = formatError(error);
        source.lastCheckedAt = now;
      }
    }
    this.catalogCache = buildCatalogEntries(
      [...this.sources.values()].map((source) => ({
        id: source.id,
        label: source.label,
        namespace: source.namespace,
        status: source.status,
        tools: source.tools,
      })),
    );
  }

  private async executeResolve(input: McpGatewayResolveInput): Promise<McpGatewayResolveResult> {
    const task = readNonEmptyString(input.task);
    if (!task) throw new Error("code_tool.resolve requires a non-empty task.");
    const maxTools = resolveMaxToolCount(input.constraints?.maxTools);
    const scopeKey = this.getScopeKey(input as Record<string, unknown>);
    const session = this.getOrCreateSession(scopeKey);
    const taskHash = normalizeResolveTaskKey(task);
    const catalog = await this.listTools(scopeKey);
    if (catalog.length === 0) {
      return this.buildNoMatchResolveOutput(
        "No connected MCP tools are currently available. Continue without MCP Gateway.",
      );
    }

    const cached = this.findRecentlyResolvedTask(scopeKey, taskHash);
    if (cached) {
      const selectedTools = cached.toolNames
        .map((toolName) => this.resolveCatalogEntry(toolName, catalog))
        .filter((entry): entry is McpGatewayCatalogEntry => Boolean(entry));
      if (selectedTools.length > 0) {
        this.markToolsLoaded(scopeKey, selectedTools);
        return this.buildRepeatedResolveOutput(selectedTools);
      }
    }

    const inFlightResolve = session.inFlightResolves.get(taskHash);
    if (inFlightResolve) {
      const resolved = await inFlightResolve;
      return {
        ...this.buildRepeatedResolveOutput(resolved.selectedTools),
        plannedSteps: resolved.plannedSteps,
        referencedTokens: resolved.referencedTokens,
        retriever: resolved.retriever,
        usedLlm: resolved.usedLlm,
        workflowSketch: resolved.workflowSketch,
      };
    }

    const resolvePromise = this.executeFreshResolve({
      catalog,
      input,
      maxTools,
      scopeKey,
      session,
      task,
      taskHash,
    });
    session.inFlightResolves.set(taskHash, resolvePromise);
    try {
      return await resolvePromise;
    } finally {
      if (session.inFlightResolves.get(taskHash) === resolvePromise) {
        session.inFlightResolves.delete(taskHash);
      }
    }
  }

  private async executeFreshResolve(input: {
    catalog: McpGatewayCatalogEntry[];
    input: McpGatewayResolveInput;
    maxTools: number;
    scopeKey: string;
    session: SessionState;
    task: string;
    taskHash: string;
  }): Promise<McpGatewayResolveResult> {
    const observations = input.session.recentObservations.slice(-5);
    let retriever: NonNullable<McpGatewayResolveResult["retriever"]> = this.options.resolver
      ? "custom"
      : "llm";
    let usedLlm = false;
    let resolution: McpGatewayResolverResult;

    if (this.options.resolver) {
      resolution = await this.resolveWithCustomResolver(
        input.task,
        input.input,
        input.maxTools,
        observations,
        input.catalog,
      );
    } else {
      try {
        resolution = await this.resolveCatalogWithLlm(
          input.task,
          input.input,
          input.maxTools,
          observations,
          input.catalog,
        );
        usedLlm = true;
      } catch (error) {
        const fallback = this.resolveLocally(
          input.task,
          input.input,
          input.maxTools,
          observations,
          input.catalog,
          error,
        );
        if (fallback.selectedToolNames.length === 0) {
          return {
            ...this.buildNoMatchResolveOutput(
              "No connected MCP tool matched this task. Continue without MCP Gateway.",
            ),
            plannedSteps: fallback.plannedSteps,
            referencedTokens: fallback.referencedTokens,
            retriever: "local",
            usedLlm: false,
            workflowSketch: fallback.workflowSketch,
          };
        }
        resolution = fallback;
        retriever = "local";
      }
    }

    let selectedTools = resolution.selectedToolNames
      .map((toolName) => this.resolveCatalogEntry(toolName, input.catalog))
      .filter((entry): entry is McpGatewayCatalogEntry => Boolean(entry))
      .slice(0, input.maxTools);
    if (input.input.constraints?.allowSideEffects === false) {
      selectedTools = selectedTools.filter((tool) => !tool.invocation.sideEffect);
    }
    if (selectedTools.length === 0) {
      return {
        ...this.buildNoMatchResolveOutput(
          "No permitted connected MCP tool matched this task. Continue without MCP Gateway.",
        ),
        plannedSteps: resolution.plannedSteps,
        referencedTokens: resolution.referencedTokens,
        retriever,
        usedLlm,
        workflowSketch: resolution.workflowSketch,
      };
    }

    this.markToolsLoaded(input.scopeKey, selectedTools);
    this.rememberResolvedTask(input.scopeKey, input.taskHash, selectedTools);
    return {
      ...this.buildResolveOutput(resolution.reasoningSummary, selectedTools),
      plannedSteps: resolution.plannedSteps,
      referencedTokens: resolution.referencedTokens,
      retriever,
      usedLlm,
      workflowSketch: resolution.workflowSketch,
    };
  }

  private async resolveWithCustomResolver(
    task: string,
    input: McpGatewayResolveInput,
    maxTools: number,
    observations: SessionState["recentObservations"],
    catalog: McpGatewayCatalogEntry[],
  ): Promise<McpGatewayResolverResult> {
    const result = await this.options.resolver?.({
      catalog,
      constraints: input.constraints,
      context: input.context,
      maxTools,
      observations,
      task,
    });
    if (!result) throw new Error("MCP Gateway resolver returned no result.");
    return result;
  }

  private async resolveCatalogWithLlm(
    task: string,
    input: McpGatewayResolveInput,
    maxTools: number,
    observations: SessionState["recentObservations"],
    catalog: McpGatewayCatalogEntry[],
  ): Promise<McpGatewayResolverResult> {
    const settings = this.llmSettings;
    if (settings.enabled === false) {
      throw new Error("MCP Gateway LLM resolver is disabled.");
    }
    const apiKey = readNonEmptyString(settings.apiKey);
    if (!apiKey && !process.env.OPENAI_API_KEY) {
      throw new Error("MCP Gateway LLM resolver requires an API key.");
    }

    const searchAgent = new OpenAiCodeToolSearchAgent({
      openAiApiKey: apiKey,
      openAiBaseUrl: readNonEmptyString(settings.baseUrl),
      openAiModel: readNonEmptyString(settings.model) ?? defaultResolveLlmModel,
    });
    const result = await searchAgent.search({
      catalog: catalog.map(toLlmCatalogItem),
      code: JSON.stringify(
        {
          context: input.context ?? {},
          observations,
        },
        null,
        2,
      ),
      query: task,
      timeoutMs: resolveLlmSearchTimeout(input.constraints?.latencyBudgetMs),
      topK: maxTools,
    });
    const selectedToolNames = uniqueStrings(
      result.selectedToolNames
        .map((toolName) => this.resolveCatalogEntry(toolName, catalog)?.toolName)
        .filter((toolName): toolName is string => typeof toolName === "string"),
    ).slice(0, maxTools);

    if (selectedToolNames.length === 0) {
      throw new Error("MCP Gateway LLM resolver returned no valid catalog tools.");
    }

    return {
      plannedSteps: result.plannedSteps,
      reasoningSummary: result.summary,
      referencedTokens: result.referencedTokens,
      selectedToolNames,
      workflowSketch: result.workflowSketch,
    };
  }

  private resolveLocally(
    task: string,
    input: McpGatewayResolveInput,
    maxTools: number,
    observations: SessionState["recentObservations"],
    catalog: McpGatewayCatalogEntry[],
    llmError?: unknown,
  ): McpGatewayResolverResult {
    const taskText = [
      task,
      input.context ? JSON.stringify(input.context) : "",
      ...observations.map((observation) => `${observation.toolName} ${observation.resultSummary}`),
    ].join(" ");
    const taskTokens = tokenizeLocalSearchText(taskText);
    const taskTokenSet = new Set(taskTokens);
    const scored = catalog
      .map((tool, index) => ({
        index,
        score: scoreLocalCatalogMatch(taskTokenSet, tool),
        tool,
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const selectedTools = uniqueToolEntries(scored.map((item) => item.tool)).slice(0, maxTools);
    const fallbackReason = llmError ? ` after LLM retrieval failed: ${formatError(llmError)}` : "";
    return {
      plannedSteps:
        selectedTools.length > 0
          ? [`Selected candidate tools using local catalog matching${fallbackReason}.`]
          : undefined,
      reasoningSummary:
        selectedTools.length > 0
          ? `Resolved tools using local catalog matching${fallbackReason}.`
          : "No strong local catalog match was found.",
      referencedTokens: taskTokens,
      selectedToolNames: selectedTools.map((tool) => tool.toolName),
      workflowSketch:
        selectedTools
          .slice(0, 5)
          .map((tool) => `await callTool(${JSON.stringify(tool.toolName)}, {});`)
          .join("\n") || undefined,
    };
  }

  private async executeInvoke(input: Record<string, unknown>): Promise<unknown> {
    const requestedTool = readNonEmptyString(input.tool);
    if (!requestedTool) throw new Error("code_tool.invoke requires a non-empty tool.");
    const args = isRecord(input.args) ? input.args : {};
    const scopeKey = this.getScopeKey(input);
    if (normalizeMetaToolName(requestedTool) === "code_tool.request_user_input") {
      return this.executeRequestUserInput(withGatewayScope(args, scopeKey));
    }
    const catalog = await this.listTools(scopeKey);
    const entry = this.resolveCatalogEntry(requestedTool, catalog);
    if (!entry) return buildFailure("UNKNOWN_TOOL", `Unknown MCP Gateway tool: ${requestedTool}`);
    const access = this.assertToolLoaded(scopeKey, entry);
    if (!access.ok) return buildFailure("TOOL_NOT_RESOLVED", access.message);
    return this.invokeResolvedEntry(scopeKey, entry, args);
  }

  private async executeWorkflow(input: Record<string, unknown>): Promise<unknown> {
    const scopeKey = this.getScopeKey(input);
    const session = this.getOrCreateSession(scopeKey);
    if (session.loadedTools.size === 0) {
      return buildFailure("NO_RESOLVED_TOOLS", "Call code_tool.resolve before code_tool.workflow.");
    }

    const format = readNonEmptyString(input.format);
    let code: string;
    if (format === "plan") {
      code = compilePlanToJavaScript(input.plan);
    } else if (format === "code") {
      if (readNonEmptyString(input.language) !== "ts") {
        throw new Error("code_tool.workflow format code requires language ts.");
      }
      const rawCode = readNonEmptyString(input.code);
      if (!rawCode) throw new Error("code_tool.workflow format code requires non-empty code.");
      code = transpileWorkflowTypeScript(rawCode);
    } else {
      throw new Error("code_tool.workflow requires format plan or code.");
    }

    const options = readWorkflowOptions(input.options);
    const timeoutMs = resolveWorkflowTimeout(options.timeoutMs);
    const maxToolCalls = resolveMaxToolCalls(options.maxToolCalls);
    const catalog = await this.listTools(scopeKey);
    const callableTools = this.workflowCallableToolRefs(scopeKey, catalog);
    let toolCalls = 0;
    const result = await this.options.sandbox!.run({
      callableTools,
      code,
      timeoutMs,
      callTool: async (tool, args) => {
        toolCalls += 1;
        if (toolCalls > maxToolCalls) {
          throw new Error(`code_tool.workflow exceeded maxToolCalls (${maxToolCalls}).`);
        }
        const entry = this.resolveCatalogEntry(tool, catalog);
        if (!entry) throw new Error(`Unknown workflow tool: ${tool}`);
        const access = this.assertToolLoaded(scopeKey, entry);
        if (!access.ok) throw new Error(access.message);
        return this.invokeResolvedEntry(scopeKey, entry, args);
      },
    });
    this.rememberObservation(scopeKey, "code_tool.workflow", result.result);
    return {
      ok: true,
      data: result.result,
      meta: {
        explicitResult: result.explicitResult === true,
      },
    };
  }

  private async executeRequestUserInput(input: Record<string, unknown>): Promise<unknown> {
    if (!this.options.requestUserInput) {
      return buildFailure(
        "USER_INPUT_UNAVAILABLE",
        "This MCP Gateway was not configured with a user-input bridge.",
      );
    }
    const scopeKey = this.getScopeKey(input);
    const request = normalizeUserInputRequest(input);
    if (
      !request.question &&
      (!request.questions || request.questions.length === 0) &&
      !request.app
    ) {
      return buildFailure(
        "INVALID_USER_INPUT_REQUEST",
        "code_tool.request_user_input requires question, questions, or app.",
      );
    }
    const response = await Promise.resolve(this.options.requestUserInput({ request, scopeKey }));
    this.rememberObservation(scopeKey, "code_tool.request_user_input", response);
    return {
      ok: response.canceled !== true && response.unanswered !== true,
      response,
    };
  }

  private async invokeResolvedEntry(
    scopeKey: string,
    entry: McpGatewayCatalogEntry,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const source = this.sources.get(entry.serverId);
    if (!source) throw new Error(`MCP Gateway server not found: ${entry.serverId}`);
    const result = await Promise.resolve(source.provider.callTool(entry.remoteToolName, args));
    this.rememberObservation(scopeKey, entry.toolName, result);
    return result;
  }

  private resolveCatalogEntry(
    requestedToolOrAlias: string,
    catalog: McpGatewayCatalogEntry[],
  ): McpGatewayCatalogEntry | undefined {
    const resolvedName = resolveCatalogItemName(
      catalog.map((entry) => ({
        alias: entry.alias,
        canonicalName: entry.canonicalName,
        name: entry.toolName,
        remoteToolName: entry.remoteToolName,
      })),
      requestedToolOrAlias,
    );
    if (!resolvedName) return undefined;
    return catalog.find((entry) => entry.toolName === resolvedName);
  }

  private workflowCallableToolRefs(scopeKey: string, catalog: McpGatewayCatalogEntry[]): string[] {
    const session = this.getOrCreateSession(scopeKey);
    const output = new Set<string>();
    for (const toolName of session.loadedTools) {
      const entry = this.resolveCatalogEntry(toolName, catalog);
      if (!entry) continue;
      output.add(entry.toolName);
      output.add(entry.alias);
      output.add(entry.canonicalName);
      output.add(entry.remoteToolName);
    }
    return [...output];
  }

  private buildResolveOutput(
    summary: string,
    selectedTools: McpGatewayCatalogEntry[],
  ): McpGatewayResolveResult {
    return {
      matched: true,
      nextAction: this.buildResolveNextAction(selectedTools),
      reasoningSummary: summary,
      runtimeContext: {
        availableContextKeys: ["selectedTools"],
        summary: selectedTools.map((tool) => `${tool.toolName}: ${tool.description || tool.title}`),
      },
      selectedTools,
      selectedToolNames: selectedTools.map((tool) => tool.toolName),
      tsDefinitions: buildTsDefinitions(selectedTools),
    };
  }

  private buildRepeatedResolveOutput(
    selectedTools: McpGatewayCatalogEntry[],
  ): McpGatewayResolveResult {
    const nextAction = this.buildResolveNextAction(selectedTools);
    return {
      alreadyResolved: true,
      matched: true,
      nextAction,
      reasoningSummary: [
        "This task has already been resolved in the current MCP Gateway session.",
        nextAction.instruction,
      ].join(" "),
      runtimeContext: {
        availableContextKeys: ["selectedTools", "nextAction"],
        summary: [
          "The selected tools are already loaded for code_tool.invoke and code_tool.workflow.",
          "Do not repeat discovery for this task.",
          nextAction.instruction,
        ],
      },
      selectedTools,
      selectedToolNames: selectedTools.map((tool) => tool.toolName),
    };
  }

  private buildNoMatchResolveOutput(reasoningSummary: string): McpGatewayResolveResult {
    return {
      matched: false,
      reasoningSummary,
      runtimeContext: {
        availableContextKeys: [],
        summary: [
          "MCP Gateway found no matching connected tool.",
          "Do not call code_tool.resolve again for the same task unless the task or available services change.",
        ],
      },
      selectedTools: [],
      selectedToolNames: [],
    };
  }

  private buildResolveNextAction(
    selectedTools: McpGatewayCatalogEntry[],
  ): NonNullable<McpGatewayResolveResult["nextAction"]> {
    const requiredArgumentsByTool = selectedTools
      .map((tool) => ({
        requiredArguments: getSchemaRequiredProperties(tool.inputSchema),
        sideEffect: tool.invocation.sideEffect,
        toolName: tool.toolName,
      }))
      .filter((item) => item.requiredArguments.length > 0);
    const confirmationRequiredFor = selectedTools
      .filter((tool) => tool.invocation.sideEffect)
      .map((tool) => tool.toolName);
    const firstTool = selectedTools.find((tool) => !tool.invocation.sideEffect) ?? selectedTools[0];
    const firstRequiredArguments = firstTool
      ? getSchemaRequiredProperties(firstTool.inputSchema)
      : [];
    const firstAction =
      firstRequiredArguments.length > 0
        ? {
            missingArguments: firstRequiredArguments,
            toolName: firstTool?.toolName,
            type: "ask_user" as const,
          }
        : {
            toolName: firstTool?.toolName,
            type: "invoke_tool" as const,
          };

    const needsUserInput =
      !firstTool || firstRequiredArguments.length > 0 || confirmationRequiredFor.length > 0;
    const instructionParts = ["Do not call code_tool.resolve again for this task."];
    if (needsUserInput) {
      instructionParts.push(
        "When user input is needed, call code_tool.request_user_input exactly, or emit an ASP question_request protocol event if you are an ASP provider; do not ask with markdown tables, numbered text, or freeform chat.",
      );
      instructionParts.push(
        "The user-input bridge is mode-agnostic; use it in any run or collaboration mode when clarification, confirmation, or selection is required.",
      );
      instructionParts.push(
        "Do not call a bare top-level Codex tool named request_user_input; that host tool is outside MCP Gateway and may be unavailable in Default mode.",
      );
      instructionParts.push(
        "For finite choices, populate questions[].options with label, value, description, imageUri, disabled, and metadata when available.",
      );
      instructionParts.push(
        "For visual or stateful selection flows such as delivery addresses, menus, product ordering, maps, carts, or document review, include an MCP App embed in the same request using app.html or app.resourceUri plus app.height and app.widgetState.",
      );
    }
    if (firstTool && firstRequiredArguments.length > 0) {
      instructionParts.push(
        `Collect missing required arguments for ${firstTool.toolName}: ${firstRequiredArguments.join(", ")}.`,
      );
    } else if (firstTool) {
      instructionParts.push(
        `Call code_tool.invoke for ${firstTool.toolName}, or compose code_tool.workflow with the resolved tools.`,
      );
    } else {
      instructionParts.push("Collect missing task details before invoking tools.");
    }
    if (confirmationRequiredFor.length > 0) {
      instructionParts.push(
        `Before calling side-effecting tools, collect explicit confirmation for: ${confirmationRequiredFor.join(", ")}.`,
      );
    }

    return {
      confirmationRequiredFor,
      firstAction,
      instruction: instructionParts.join(" "),
      requiredArgumentsByTool,
    };
  }

  private getScopeKey(input: Record<string, unknown>): string {
    return (
      readNonEmptyString(input[gatewayScopeArg]) ||
      readNonEmptyString(input.scopeKey) ||
      readNonEmptyString(input.sessionId) ||
      defaultScopeKey
    );
  }

  private getOrCreateSession(scopeKey: string): SessionState {
    const existing = this.sessions.get(scopeKey);
    if (existing) return existing;
    const session: SessionState = {
      inFlightResolves: new Map(),
      loadedTools: new Set(),
      recentObservations: [],
      recentlyResolvedTasks: [],
    };
    this.sessions.set(scopeKey, session);
    return session;
  }

  private markToolsLoaded(scopeKey: string, entries: McpGatewayCatalogEntry[]): void {
    const session = this.getOrCreateSession(scopeKey);
    for (const entry of entries) session.loadedTools.add(entry.toolName);
  }

  private rememberResolvedTask(
    scopeKey: string,
    taskHash: string,
    entries: McpGatewayCatalogEntry[],
  ): void {
    const session = this.getOrCreateSession(scopeKey);
    session.recentlyResolvedTasks = session.recentlyResolvedTasks.filter(
      (item) => item.taskHash !== taskHash,
    );
    session.recentlyResolvedTasks.unshift({
      resolvedAt: Date.now(),
      taskHash,
      toolNames: entries.map((entry) => entry.toolName),
    });
    session.recentlyResolvedTasks = session.recentlyResolvedTasks.slice(0, 10);
  }

  private findRecentlyResolvedTask(
    scopeKey: string,
    taskHash: string,
  ): SessionState["recentlyResolvedTasks"][number] | undefined {
    const session = this.getOrCreateSession(scopeKey);
    const now = Date.now();
    session.recentlyResolvedTasks = session.recentlyResolvedTasks.filter(
      (item) => now - item.resolvedAt <= repeatedResolveWindowMs,
    );
    const exactMatch = session.recentlyResolvedTasks.find((item) => item.taskHash === taskHash);
    return exactMatch;
  }

  private rememberObservation(scopeKey: string, toolName: string, result: unknown): void {
    const session = this.getOrCreateSession(scopeKey);
    session.recentObservations.push({
      resultSummary: summarizeValue(result),
      toolName,
    });
    session.recentObservations = session.recentObservations.slice(-20);
  }

  private assertToolLoaded(
    scopeKey: string,
    entry: McpGatewayCatalogEntry,
  ): { message: string; ok: false } | { ok: true } {
    const session = this.getOrCreateSession(scopeKey);
    if (session.loadedTools.has(entry.toolName)) return { ok: true };
    return {
      ok: false,
      message: `Tool ${entry.toolName} is not loaded in this session. Call code_tool.resolve for the task first.`,
    };
  }
}

export { gatewayScopeArg as mcpGatewayScopeArgumentName };

function buildMetaToolDefinitions(): Array<
  McpGatewayToolDefinition & { inputSchema: Record<string, unknown> }
> {
  return [
    {
      name: "code_tool.resolve",
      description:
        "Search connected MCP services for the minimal tool bundle needed by a task. Call this first when a task may require external, private, connected-service, or real-time data, or an action outside the local workspace; the user does not need to mention MCP Gateway or a service name. Do not call it for tasks answerable entirely from the conversation or local workspace. A matched=false result means continue without MCP Gateway.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          context: { type: "object", additionalProperties: true },
          constraints: {
            type: "object",
            properties: {
              allowSideEffects: { type: "boolean" },
              latencyBudgetMs: { type: "number" },
              maxTools: { type: "number" },
              preferWorkflow: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "code_tool.request_user_input",
      description:
        "Open the AGUI native input card to collect structured user input, a confirmation, or a visual/stateful MCP App interaction. This MCP Gateway tool is mode-agnostic; call code_tool.request_user_input exactly in any run or collaboration mode instead of markdown tables, numbered reply prompts, freeform chat, or a bare top-level Codex request_user_input tool whenever the user must choose or clarify before the workflow can continue.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          question: { type: "string" },
          instructions: { type: "string" },
          interactionType: { type: "string", enum: ["form", "mcp_app", "custom"] },
          providerSessionId: { type: "string" },
          submitLabel: { type: "string" },
          cancelLabel: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                question: { type: "string" },
                header: { type: "string" },
                description: { type: "string" },
                control: {
                  type: "string",
                  enum: ["text", "single_select", "multi_select", "dropdown"],
                },
                required: { type: "boolean" },
                multiSelect: { type: "boolean" },
                allowCustomAnswer: { type: "boolean" },
                placeholder: { type: "string" },
                defaultValue: {
                  oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                      description: { type: "string" },
                      imageUri: { type: "string" },
                      disabled: { type: "boolean" },
                      metadata: { type: "object", additionalProperties: true },
                    },
                    required: ["label"],
                    additionalProperties: true,
                  },
                },
                metadata: { type: "object", additionalProperties: true },
              },
              required: ["question"],
              additionalProperties: true,
            },
          },
          app: {
            type: "object",
            description:
              "Optional MCP App embed for rich interactions such as address picking, product menus with images, cart state, maps, or document review. Provide html or resourceUri, plus title, height, widgetState, and metadata when useful.",
            additionalProperties: true,
          },
          metadata: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
    {
      name: "code_tool.invoke",
      description:
        "Invoke one MCP tool that was already returned by code_tool.resolve in this session.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string" },
          args: { type: "object", additionalProperties: true },
          timeoutMs: { type: "number" },
        },
        required: ["tool"],
        additionalProperties: false,
      },
    },
    {
      name: "code_tool.workflow",
      description:
        "Execute a multi-step workflow against resolved MCP tools using a plan DSL or TypeScript code.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["plan", "code"] },
          plan: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                items: { type: "object" },
              },
            },
            additionalProperties: false,
          },
          language: { type: "string", enum: ["ts"] },
          code: { type: "string" },
          options: {
            type: "object",
            properties: {
              maxToolCalls: { type: "number" },
              timeoutMs: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        required: ["format"],
        additionalProperties: false,
      },
    },
  ];
}

function compilePlanToJavaScript(plan: unknown): string {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) {
    throw new Error("code_tool.workflow format plan requires plan.steps.");
  }
  const steps = plan.steps.filter(isRecord) as McpGatewayWorkflowPlanStep[];
  const lines = ["const workflowVars = Object.create(null);", "let workflowResult;"];
  for (const step of steps) {
    if (step.type === "invoke") {
      const tool = readNonEmptyString(step.toolName) || readNonEmptyString(step.tool);
      if (!tool) throw new Error("Workflow invoke step requires tool or toolName.");
      const args = isRecord(step.args) ? step.args : {};
      const saveAs = readNonEmptyString(step.saveAs);
      const expression = `await callTool(${JSON.stringify(tool)}, ${JSON.stringify(args)})`;
      if (saveAs) {
        lines.push(`workflowVars[${JSON.stringify(saveAs)}] = ${expression};`);
        lines.push(`workflowResult = workflowVars[${JSON.stringify(saveAs)}];`);
      } else {
        lines.push(`workflowResult = ${expression};`);
      }
      continue;
    }
    if (step.type === "return") {
      const from = readNonEmptyString(step.from);
      if (from) {
        lines.push(`return result(workflowVars[${JSON.stringify(from)}]);`);
      } else {
        lines.push(`return result(${JSON.stringify(step.value)});`);
      }
      continue;
    }
    throw new Error(`Unsupported workflow step type: ${String(step.type)}`);
  }
  lines.push("return workflowResult;");
  return lines.join("\n");
}

function transpileWorkflowTypeScript(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function buildTsDefinitions(entries: McpGatewayCatalogEntry[]): string {
  return entries
    .map((entry) => {
      const typeName = toTypeName(entry.toolName);
      const argsTypeName = `${typeName}Args`;
      return [
        "/**",
        ` * ${entry.description || entry.title}`,
        ` * Exact tool name: "${entry.toolName}".`,
        ` * Workflow callable references: "${entry.toolName}", "${entry.alias}", "${entry.remoteToolName}".`,
        " */",
        `type ${argsTypeName} = ${schemaToType(entry.inputSchema)};`,
        `type ${typeName}Call = { tool: "${entry.toolName}"; args: ${argsTypeName}; };`,
      ].join("\n");
    })
    .join("\n\n");
}

function toLlmCatalogItem(entry: McpGatewayCatalogEntry): CodeToolSearchCatalogItem {
  return {
    alias: entry.alias,
    canonicalName: entry.canonicalName,
    description: entry.description,
    invocationMode: entry.invocation.mode,
    name: entry.toolName,
    remoteToolName: entry.remoteToolName,
    required: getSchemaRequiredProperties(entry.inputSchema),
    serverId: entry.serverId,
    serverLabel: entry.serverLabel,
    sideEffect: entry.invocation.sideEffect,
    title: entry.title,
  };
}

function normalizeMcpGatewayLlmRuntimeSettings(
  value: McpGatewayLlmSettings | undefined,
): McpGatewayLlmSettings {
  return {
    apiKey: value?.apiKey ?? "",
    baseUrl: value?.baseUrl ?? "",
    enabled: value?.enabled !== false,
    model: readNonEmptyString(value?.model) ?? defaultResolveLlmModel,
  };
}

function resolveLlmSearchTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return defaultResolveLlmTimeoutMs;
  return Math.max(8_000, Math.min(Math.floor(value), defaultResolveLlmTimeoutMs));
}

function schemaToType(schema: Record<string, unknown> | undefined): string {
  if (!isRecord(schema) || !isRecord(schema.properties)) return "Record<string, unknown>";
  const required = new Set(getSchemaRequiredProperties(schema));
  const lines = ["{"];
  for (const [key, value] of Object.entries(schema.properties)) {
    const propertySchema = isRecord(value) ? value : {};
    lines.push(
      `  ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${jsonSchemaTypeToTs(propertySchema)};`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function jsonSchemaTypeToTs(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string")) {
    return schema.enum.map((item) => JSON.stringify(item)).join(" | ") || "string";
  }
  switch (schema.type) {
    case "array":
      return "unknown[]";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "object":
      return "Record<string, unknown>";
    case "string":
      return "string";
    default:
      return "unknown";
  }
}

function scoreLocalCatalogMatch(taskTokenSet: Set<string>, tool: McpGatewayCatalogEntry): number {
  const toolText = [
    tool.toolName,
    tool.alias,
    tool.canonicalName,
    tool.remoteToolName,
    tool.serverId,
    tool.serverLabel ?? "",
    tool.title,
    tool.description,
    ...tool.tags,
  ].join(" ");
  const toolTokens = tokenizeToolText(toolText);
  let score = 0;
  for (const token of toolTokens) {
    if (taskTokenSet.has(token)) score += token.length > 4 ? 3 : 1;
  }
  if (tool.invocation.sideEffect) score -= 3;
  return score;
}

function tokenizeLocalSearchText(text: string): string[] {
  const tokens = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !localSearchStopWords.has(token));
  return [...new Set(tokens)];
}

const localSearchStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "need",
  "of",
  "or",
  "the",
  "then",
  "to",
  "with",
]);

function uniqueToolEntries(entries: McpGatewayCatalogEntry[]): McpGatewayCatalogEntry[] {
  const seen = new Set<string>();
  const output: McpGatewayCatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.toolName)) continue;
    seen.add(entry.toolName);
    output.push(entry);
  }
  return output;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeMetaToolName(value: string): string {
  switch (value.trim()) {
    case "code_tool_resolve":
      return "code_tool.resolve";
    case "code_tool_invoke":
      return "code_tool.invoke";
    case "code_tool_workflow":
      return "code_tool.workflow";
    case "code_tool_request_user_input":
    case "question_request":
    case "request_user_input":
      return "code_tool.request_user_input";
    default:
      return value.trim();
  }
}

function withGatewayScope(
  input: Record<string, unknown>,
  scopeKey: string,
): Record<string, unknown> {
  if (readNonEmptyString(input[gatewayScopeArg])) return input;
  return {
    ...input,
    [gatewayScopeArg]: scopeKey,
  };
}

type UserInputQuestion = McpGatewayUserInputRequest["questions"][number];
type UserInputOption = NonNullable<UserInputQuestion["options"]>[number];

function normalizeUserInputRequest(input: Record<string, unknown>): McpGatewayUserInputRequest {
  const app =
    readRecord(input.app) ||
    readRecord(input.mcpApp) ||
    readRecord(input.mcp_app) ||
    readRecord(input.ui) ||
    readRecord(input.widget);
  const topLevelQuestion =
    readNonEmptyString(input.question) ||
    readNonEmptyString(input.prompt) ||
    readNonEmptyString(input.message) ||
    readNonEmptyString(input.text);
  const questions = Array.isArray(input.questions)
    ? input.questions
        .map(normalizeUserInputQuestion)
        .filter((question): question is UserInputQuestion => Boolean(question))
    : [];
  const topLevelOptions = normalizeUserInputOptions(input.options);
  if (questions.length === 0 && topLevelQuestion && (!app || topLevelOptions.length > 0)) {
    questions.push({
      question: topLevelQuestion,
      control: topLevelOptions.length ? "single_select" : "text",
      ...(topLevelOptions.length ? { options: topLevelOptions } : {}),
      ...(typeof input.required === "boolean" ? { required: input.required } : {}),
    });
  }
  const interactionType = normalizeInteractionType(
    input.interactionType ?? input.interaction_type,
    app,
  );
  return {
    questions,
    ...(readNonEmptyString(input.providerSessionId)
      ? { providerSessionId: readNonEmptyString(input.providerSessionId) }
      : {}),
    ...(readNonEmptyString(input.questionId)
      ? { questionId: readNonEmptyString(input.questionId) }
      : {}),
    ...(readNonEmptyString(input.title) ? { title: readNonEmptyString(input.title) } : {}),
    ...(topLevelQuestion ? { question: topLevelQuestion } : {}),
    ...(readNonEmptyString(input.instructions) || (app && topLevelQuestion)
      ? { instructions: readNonEmptyString(input.instructions) || topLevelQuestion }
      : {}),
    ...(interactionType ? { interactionType } : {}),
    ...(readNonEmptyString(input.method) ? { method: readNonEmptyString(input.method) } : {}),
    ...(app ? { app } : {}),
    ...(readRecord(input.metadata) ? { metadata: readRecord(input.metadata) } : {}),
    ...(readNonEmptyString(input.submitLabel)
      ? { submitLabel: readNonEmptyString(input.submitLabel) }
      : {}),
    ...(readNonEmptyString(input.cancelLabel)
      ? { cancelLabel: readNonEmptyString(input.cancelLabel) }
      : {}),
  };
}

function normalizeUserInputQuestion(value: unknown): UserInputQuestion | undefined {
  const source = typeof value === "string" ? { question: value } : readRecord(value);
  if (!source) return undefined;
  const question =
    readNonEmptyString(source.question) ||
    readNonEmptyString(source.prompt) ||
    readNonEmptyString(source.label) ||
    readNonEmptyString(source.title);
  if (!question) return undefined;
  const options = normalizeUserInputOptions(source.options);
  const multi =
    source.multiSelect === true || source.multi_select === true || source.multiple === true;
  const control = normalizeQuestionControl(source.control ?? source.type, options.length, multi);
  return {
    question,
    ...(readNonEmptyString(source.id) ? { id: readNonEmptyString(source.id) } : {}),
    ...(readNonEmptyString(source.header) ? { header: readNonEmptyString(source.header) } : {}),
    ...(control ? { control } : {}),
    ...(multi ? { multiSelect: true } : {}),
    ...(source.allowCustomAnswer === true || source.allow_custom_answer === true
      ? { allowCustomAnswer: true }
      : {}),
    ...(source.defaultValue !== undefined || source.default_value !== undefined
      ? { defaultValue: normalizeDefaultValue(source.defaultValue ?? source.default_value, multi) }
      : {}),
    ...(readNonEmptyString(source.description)
      ? { description: readNonEmptyString(source.description) }
      : {}),
    ...(typeof source.required === "boolean" ? { required: source.required } : {}),
    ...(options.length ? { options } : {}),
    ...(readNonEmptyString(source.placeholder)
      ? { placeholder: readNonEmptyString(source.placeholder) }
      : {}),
    ...(readNonEmptyString(source.preview) ? { preview: readNonEmptyString(source.preview) } : {}),
    ...(readRecord(source.metadata) ? { metadata: readRecord(source.metadata) } : {}),
  };
}

function normalizeUserInputOptions(value: unknown): UserInputOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((option): UserInputOption | undefined => {
      const source =
        typeof option === "string" ? { label: option, value: option } : readRecord(option);
      if (!source) return undefined;
      const label =
        readNonEmptyString(source.label) ||
        readNonEmptyString(source.title) ||
        readNonEmptyString(source.name) ||
        readNonEmptyString(source.value);
      if (!label) return undefined;
      return {
        label,
        ...(readNonEmptyString(source.value) ? { value: readNonEmptyString(source.value) } : {}),
        ...(readNonEmptyString(source.description)
          ? { description: readNonEmptyString(source.description) }
          : {}),
        ...(readNonEmptyString(source.imageUri) ||
        readNonEmptyString(source.image_uri) ||
        readNonEmptyString(source.image)
          ? {
              imageUri:
                readNonEmptyString(source.imageUri) ||
                readNonEmptyString(source.image_uri) ||
                readNonEmptyString(source.image),
            }
          : {}),
        ...(readNonEmptyString(source.preview)
          ? { preview: readNonEmptyString(source.preview) }
          : {}),
        ...(typeof source.disabled === "boolean" ? { disabled: source.disabled } : {}),
        ...(readRecord(source.metadata) ? { metadata: readRecord(source.metadata) } : {}),
      };
    })
    .filter((option): option is UserInputOption => Boolean(option));
}

function normalizeQuestionControl(
  value: unknown,
  optionCount: number,
  multi: boolean,
): UserInputQuestion["control"] | undefined {
  const control = readNonEmptyString(value)?.toLowerCase();
  if (
    control === "dropdown" ||
    control === "multi_select" ||
    control === "single_select" ||
    control === "text"
  ) {
    return control;
  }
  if (control === "multiselect" || control === "multi-select") return "multi_select";
  if (control === "select" || control === "radio" || control === "choice")
    return multi ? "multi_select" : "single_select";
  if (optionCount > 0) return multi ? "multi_select" : "single_select";
  return "text";
}

function normalizeInteractionType(
  value: unknown,
  app: Record<string, unknown> | undefined,
): McpGatewayUserInputRequest["interactionType"] | undefined {
  const type = readNonEmptyString(value);
  if (type === "form" || type === "mcp_app" || type === "custom") return type;
  return app ? "mcp_app" : "form";
}

function normalizeDefaultValue(value: unknown, multi: boolean): string | string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.map(readNonEmptyString).filter((item): item is string => Boolean(item));
    return values.length ? values : undefined;
  }
  const scalar = readNonEmptyString(value);
  if (!scalar) return undefined;
  return multi ? [scalar] : scalar;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readWorkflowOptions(value: unknown): McpGatewayWorkflowOptions {
  return isRecord(value) ? (value as McpGatewayWorkflowOptions) : {};
}

function resolveWorkflowTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return defaultWorkflowTimeoutMs;
  return Math.min(Math.floor(value), maxWorkflowTimeoutMs);
}

function resolveMaxToolCalls(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return defaultMaxToolCalls;
  return Math.min(Math.floor(value), 200);
}

function resolveMaxToolCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return defaultMaxTools;
  return Math.min(Math.floor(value), maxResolveTools);
}

function normalizeResolveTaskKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeServerId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) return "";
  return id;
}

function scopedServerId(scopeKey: string, serverId: string): string {
  const hash = stableHash(scopeKey);
  const suffix = `_${hash}`;
  return `${serverId.slice(0, Math.max(1, 96 - suffix.length))}${suffix}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function toTypeName(value: string): string {
  const words = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  const name = words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join("");
  return name || "Tool";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value?: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeValue(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return String(value);
  }
}

function buildFailure(code: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}
