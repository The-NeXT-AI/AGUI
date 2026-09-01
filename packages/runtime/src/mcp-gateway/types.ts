import type { AspQuestionResponse, QuestionRequestPayload } from "@the-next-ai/asp/types";

export type McpGatewayTransport = "http" | "sse" | "stdio";

export type McpGatewayServerStatus = "offline" | "online" | "unknown";

export type McpGatewayAuthentication =
  | { type: "api-key"; headerName?: string; value: string }
  | { type: "basic"; password: string; username: string }
  | { type: "bearer"; token: string }
  | { type: "none" };

export type McpGatewayServerConfig = {
  args?: string[];
  authentication?: McpGatewayAuthentication;
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  id: string;
  label?: string;
  type?: McpGatewayTransport;
  url?: string;
};

export type McpGatewayToolDefinition = {
  description: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  tags?: string[];
  title?: string;
};

export type McpGatewayToolInvocationMode = "both" | "invoke" | "workflow";

export type McpGatewayToolInvocation = {
  mode: McpGatewayToolInvocationMode;
  sideEffect: boolean;
};

export type McpGatewayCatalogEntry = {
  alias: string;
  canonicalName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  invocation: McpGatewayToolInvocation;
  outputSchema?: Record<string, unknown>;
  remoteToolName: string;
  serverId: string;
  serverLabel?: string;
  serverNamespace: string;
  status: McpGatewayServerStatus;
  tags: string[];
  title: string;
  toolName: string;
};

export type McpGatewayServerView = {
  error?: string;
  extensionId?: string;
  id: string;
  label?: string;
  lastCheckedAt?: string;
  lastSeenOnlineAt?: string;
  namespace?: string;
  readOnly?: boolean;
  source?: string;
  status: McpGatewayServerStatus;
  toolCount: number;
  tools: McpGatewayCatalogEntry[];
  type: McpGatewayTransport | "provider";
};

export type McpGatewaySummary = {
  offlineServerCount: number;
  onlineServerCount: number;
  serverCount: number;
  toolCount: number;
  unknownServerCount: number;
};

export type McpGatewayLlmSettings = {
  apiKey?: string;
  baseUrl?: string;
  enabled: boolean;
  model?: string;
};

export type McpGatewayResolveConstraints = {
  allowSideEffects?: boolean;
  latencyBudgetMs?: number;
  maxTools?: number;
  preferWorkflow?: boolean;
};

export type McpGatewayResolveInput = {
  constraints?: McpGatewayResolveConstraints;
  context?: Record<string, unknown>;
  task: string;
};

export type McpGatewayResolveResult = {
  alreadyResolved?: boolean;
  matched: boolean;
  nextAction?: {
    confirmationRequiredFor: string[];
    firstAction: {
      missingArguments?: string[];
      toolName?: string;
      type: "ask_user" | "invoke_tool";
    };
    instruction: string;
    requiredArgumentsByTool: Array<{
      requiredArguments: string[];
      sideEffect: boolean;
      toolName: string;
    }>;
  };
  plannedSteps?: string[];
  reasoningSummary: string;
  referencedTokens?: string[];
  retriever?: "custom" | "llm" | "local";
  runtimeContext?: {
    availableContextKeys: string[];
    summary: string[];
  };
  selectedTools: McpGatewayCatalogEntry[];
  selectedToolNames?: string[];
  tsDefinitions?: string;
  usedLlm?: boolean;
  workflowSketch?: string;
};

export type McpGatewayWorkflowOptions = {
  maxToolCalls?: number;
  timeoutMs?: number;
};

export type McpGatewayWorkflowPlanStep = {
  args?: Record<string, unknown>;
  from?: string;
  saveAs?: string;
  tool?: string;
  toolName?: string;
  type?: string;
  value?: unknown;
};

export type McpGatewayToolProvider = {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
  close?(): Promise<void> | void;
  listTools(signal?: AbortSignal): Promise<McpGatewayToolDefinition[]> | McpGatewayToolDefinition[];
};

export type McpGatewayResolverInput = {
  catalog: McpGatewayCatalogEntry[];
  constraints?: McpGatewayResolveConstraints;
  context?: Record<string, unknown>;
  maxTools: number;
  observations: Array<{
    resultSummary: string;
    toolName: string;
  }>;
  task: string;
};

export type McpGatewayResolverResult = {
  plannedSteps?: string[];
  referencedTokens?: string[];
  reasoningSummary: string;
  selectedToolNames: string[];
  workflowSketch?: string;
};

export type McpGatewayResolver = (
  input: McpGatewayResolverInput,
) => Promise<McpGatewayResolverResult> | McpGatewayResolverResult;

export type McpGatewayWorkflowSandboxInput = {
  callableTools: string[];
  code: string;
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;
  timeoutMs: number;
};

export type McpGatewayWorkflowSandboxResult = {
  explicitResult?: boolean;
  result?: unknown;
};

export type McpGatewayWorkflowSandbox = {
  run(input: McpGatewayWorkflowSandboxInput): Promise<McpGatewayWorkflowSandboxResult>;
};

export type McpGatewayMcpExport = {
  server: {
    name: string;
    version: string;
  };
  tools: Array<McpGatewayToolDefinition & { inputSchema: Record<string, unknown> }>;
};

export type McpGatewayUserInputRequest = Omit<
  QuestionRequestPayload,
  "requestId" | "runId" | "uiSessionId"
>;

export type McpGatewayUserInputHandler = (input: {
  request: McpGatewayUserInputRequest;
  scopeKey: string;
}) => Promise<AspQuestionResponse> | AspQuestionResponse;

export type McpGatewayOptions = {
  llm?: McpGatewayLlmSettings;
  name?: string;
  requestUserInput?: McpGatewayUserInputHandler;
  resolver?: McpGatewayResolver;
  sandbox?: McpGatewayWorkflowSandbox;
  version?: string;
};
