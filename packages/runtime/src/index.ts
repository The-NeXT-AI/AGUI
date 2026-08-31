import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { AspManager, type AspEventSender } from "@agui/asp/manager";
import type {
  AspApprovalDecision,
  AspExtensionInvokeInput,
  AspMcpServerRef,
  AspProvider,
  AspQuestionResponse,
  ApprovalRequestPayload,
  QuestionRequestPayload,
  RunInput,
  RunResult,
} from "@agui/asp/types";
import {
  createMcpGatewayStdioSocketServer,
  BrowserWorkflowStore,
  browserMcpProviderId,
  browserWorkflowMcpProviderId,
  cleanupHandoffFiles,
  createBrowserMcpToolProvider,
  createBrowserWorkflowMcpToolProvider,
  createHandoffFileMcpToolProvider,
  createPanelMcpToolProvider,
  handoffFileMcpProviderId,
  McpGateway,
  normalizeMcpGatewayLlmSettings,
  panelMcpProviderId,
  readMcpGatewaySettings,
  prepareHandoffFiles,
  workflowFromAnnotations,
  writeMcpGatewaySettings,
  type AguiIdePanelState,
  type AguiPanelRuntimeState,
  type McpGatewayRuntimeSettings,
  type McpGatewayServerConfig,
  type McpGatewayStdioSocketAddress,
  type McpGatewayUserInputRequest,
  type BrowserWorkflowAnnotation,
  type BrowserWorkflowSaveInput,
} from "./mcp-gateway/index.js";
import { createAppStorage, type AppStorage } from "./storage/index.js";
import {
  RuntimeAuthController,
  configuredRuntimeAuthOptions,
  tenantPath,
  type RuntimeAuthContext,
  type RuntimeAuthOptions,
} from "./server-auth.js";
import { parseRuntimeMethodParams } from "./runtime-method-schema.js";
import { detectAgentCliProviders } from "./provider-detection.js";
import { TerminalService } from "./terminal-service.js";
import {
  SCHEDULED_TASK_SENDER_ID,
  ScheduledTaskService,
  type ScheduledTaskInput,
} from "./scheduled-tasks.js";
import {
  IDE_FILE_MAX_BYTES,
  IDE_WRITE_MAX_BYTES,
  buildIdeTree,
  configuredWorkspaceRoots,
  readIdeFile,
  readWorkspaceDirectories,
  safeIdePath,
  safeIdeRoot,
  workspaceDirectoryEntry,
  type WorkspaceDirectoryListing,
} from "./workspace-service.js";
export * from "./mcp-gateway/index.js";
export * from "./provider-detection.js";
export * from "./runtime-method-schema.js";
export * from "./scheduled-tasks.js";
export * from "./server-auth.js";
export * from "./storage/index.js";

type JsonRpcMessage = {
  id?: number | string | null;
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

function aspTerminalId(runId: string, terminalId: string): string {
  const digest = createHash("sha256").update(terminalId).digest("hex").slice(0, 16);
  return `asp:${runId}:${digest}`;
}

export type RuntimeClient = AspEventSender & {
  auth?: RuntimeAuthContext;
  sendJsonRpc?(message: unknown): void;
};

export type RuntimeFeatures = {
  browserAutomation: boolean;
  browserScreencast?: boolean;
  filePathAccess: boolean;
  nativeDialogs: boolean;
  webContentsView: boolean;
  webview: boolean;
};

export type RuntimeInfo = {
  features: RuntimeFeatures;
  platform: string;
  versions: Record<string, string | undefined>;
};

export type RuntimeMethodHandler = (
  method: string,
  params: unknown,
  client: RuntimeClient,
) => Promise<unknown> | unknown;

type McpGatewayScopeInput = {
  workspacePath?: string;
  workspaceId?: string;
};

type ExtensionMcpGatewayServer = {
  config: McpGatewayServerConfig;
  extensionId?: string;
};

type ExtensionMcpGatewaySync = {
  scopeKey?: string;
  servers: ExtensionMcpGatewayServer[];
  warnings: string[];
};

const PANEL_STATE_MAX_ITEMS = 200;
const PANEL_TEXT_MAX_CHARS = 1_000_000;

type AspManagerWithUserInput = AspManager & {
  pendingInteractions(client: RuntimeClient): {
    approvals: ApprovalRequestPayload[];
    questions: QuestionRequestPayload[];
  };
  requestUserInput(
    uiSessionId: string,
    request: McpGatewayUserInputRequest,
  ): Promise<AspQuestionResponse>;
};

type TranscriptHydrationWorkerInput = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  previousContextUsage?: {
    used: number;
    usedKnown?: boolean;
    size: number;
    source?: string;
    cost?: { amount: number; currency: string } | null;
  };
  providerId: string;
  providerSessionId: string;
  providers?: AspProvider[];
  transcriptPath?: string;
  userDataPath: string;
};

type TranscriptHydrationWorkerResponse =
  | { ok: true; projection: unknown }
  | { ok: false; error: { message: string; name?: string; stack?: string } };

export type IdeDiagnosticHandlers = {
  diagnostics?: (input: {
    root: string;
    filePath: string;
    content: string;
  }) => Promise<unknown> | unknown;
  semanticTokens?: (input: {
    root: string;
    filePath: string;
    content: string;
  }) => Promise<unknown> | unknown;
  workspaceDiagnostics?: (input: { root: string }) => Promise<unknown> | unknown;
};

export type NodeRuntimeServerOptions = {
  auth?: RuntimeAuthOptions;
  browserMethod?: RuntimeMethodHandler;
  defaultWorkspace?: string;
  env?: NodeJS.ProcessEnv;
  eventBroadcast?: (channel: string, payload: unknown) => void;
  extensionMethod?: RuntimeMethodHandler;
  host?: string;
  homeDir?: string | (() => string);
  ide?: IdeDiagnosticHandlers;
  log?: Pick<Console, "error" | "info" | "warn">;
  port?: number;
  runtimeInfo?: RuntimeInfo | (() => RuntimeInfo);
  staticRoot?: false | string;
  storageBackend?: "sqlite" | "postgres";
  storageNamespace?: string;
  storagePostgresUrl?: string;
  storageSqlitePath?: string;
  token?: string;
  userDataPath?: string | (() => string);
  workspaceChoose?: (initialPath?: string) => Promise<string | null> | string | null;
  workspaceDefault?: string | (() => string);
  workspaceRoots?: string[] | (() => string[]);
};

type TenantRuntimeScope = {
  browserWorkflowStore: BrowserWorkflowStore;
  context: RuntimeAuthContext;
  extensionMcpGatewayScopeKey?: string;
  key: string;
  manager: AspManager;
  mcpGateway: McpGateway;
  mcpGatewayApplyPromise?: Promise<void>;
  mcpGatewayRuntimeError?: string;
  mcpGatewaySettings: McpGatewayRuntimeSettings;
  mcpGatewayStdioSocketServer: ReturnType<typeof createMcpGatewayStdioSocketServer>;
  panelState: AguiPanelRuntimeState;
  registeredNativeMcpProviderSignature: string;
  scheduledTasks: ScheduledTaskService;
  storage: AppStorage;
  terminal: TerminalService;
  userDataPath: () => string;
};

type TenantRegistryFile = {
  tenants?: TenantRegistryRecord[];
  version?: 1;
};

type TenantRegistryRecord = {
  tenantId: string;
  tenantKey: string;
  updatedAt: number;
};

export type RuntimeRpcBindOptions = {
  host?: string;
  port?: number;
  token?: string;
};

const WS_OPEN = 1;
const RPC_MAX_MESSAGE_BYTES = 1024 * 1024;
const RPC_MAX_CALLS_PER_SECOND = 100;
const AGUI_HOME_DIRECTORY = ".agui";
const MCP_GATEWAY_SERVER_ID = "agui_mcp_gateway";
const TENANT_REGISTRY_FILE = "tenants.json";

export type AguiHomePathOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string | (() => string);
};

export type RuntimeUserDataPathOptions = AguiHomePathOptions & {
  userDataPath?: string | (() => string);
};

export function configuredAguiHomePath(options: AguiHomePathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.AG_UI_HOME ?? env.AGUI_HOME;
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(configuredHomeDir(options.homeDir), AGUI_HOME_DIRECTORY);
}

export function configuredRuntimeUserDataPath(options: RuntimeUserDataPathOptions = {}): string {
  const explicit = configuredOptionalPath(options.userDataPath);
  if (explicit) return explicit;
  const env = options.env ?? process.env;
  const override = env.AG_UI_USER_DATA_DIR ?? env.AGUI_USER_DATA_DIR;
  if (override?.trim()) return path.resolve(override.trim());
  return configuredAguiHomePath(options);
}

export class NodeRuntimeServer {
  private readonly auth: RuntimeAuthController;
  private readonly browserMethod?: RuntimeMethodHandler;
  private readonly defaultWorkspace: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly eventBroadcast?: (channel: string, payload: unknown) => void;
  private readonly extensionMethod?: RuntimeMethodHandler;
  private host: string;
  private readonly homeDir: () => string;
  private readonly ide: IdeDiagnosticHandlers;
  private readonly log: Pick<Console, "error" | "info" | "warn">;
  private readonly runtimeInfo?: RuntimeInfo | (() => RuntimeInfo);
  private readonly staticRoot: false | string;
  private readonly storageBackend?: "sqlite" | "postgres";
  private readonly storageNamespace?: string;
  private readonly storagePostgresUrl?: string;
  private readonly storageSqlitePath?: string;
  private token: string;
  private readonly baseUserDataPath: () => string;
  private readonly workspaceChoose?: (
    initialPath?: string,
  ) => Promise<string | null> | string | null;
  private readonly workspaceDefault?: string | (() => string);
  private readonly workspaceRoots?: string[] | (() => string[]);
  private httpServer: http.Server | null = null;
  private nextRuntimeClientId = 1;
  private resolvedPort = 0;
  private socketServer: WebSocketServer | null = null;
  private readonly socketClients = new WeakMap<WebSocket, RuntimeClient>();
  private readonly tenantScopes = new Map<string, TenantRuntimeScope>();

  constructor(options: NodeRuntimeServerOptions = {}) {
    this.env = options.env ?? process.env;
    this.auth = new RuntimeAuthController(
      options.auth ?? configuredRuntimeAuthOptions(this.env, { mode: "token" }),
    );
    this.host = runtimeRpcHost(options.host ?? this.env.AG_UI_WEB_HOST ?? this.env.AGUI_WEB_HOST);
    this.homeDir = configuredPathGetter(options.homeDir, os.homedir());
    this.log = options.log ?? console;
    this.token =
      options.token ?? runtimeRpcToken(this.env) ?? randomBytes(24).toString("base64url");
    this.defaultWorkspace = path.resolve(
      options.defaultWorkspace ??
        this.env.AG_UI_WORKSPACE ??
        this.env.AGUI_WORKSPACE ??
        process.cwd(),
    );
    this.baseUserDataPath = () =>
      configuredRuntimeUserDataPath({
        env: this.env,
        homeDir: this.homeDir,
        userDataPath: options.userDataPath,
      });
    this.staticRoot =
      options.staticRoot === false
        ? false
        : path.resolve(
            options.staticRoot ?? this.env.AG_UI_STATIC_ROOT ?? path.resolve(process.cwd(), "dist"),
          );
    this.storageBackend = options.storageBackend;
    this.storageNamespace = options.storageNamespace;
    this.storagePostgresUrl = options.storagePostgresUrl;
    this.storageSqlitePath = options.storageSqlitePath;
    this.resolvedPort = options.port ?? runtimeRpcPort(this.env);
    this.browserMethod = options.browserMethod;
    this.eventBroadcast = options.eventBroadcast;
    this.extensionMethod = options.extensionMethod;
    this.ide = options.ide ?? {};
    this.runtimeInfo = options.runtimeInfo;
    this.workspaceChoose = options.workspaceChoose;
    this.workspaceDefault = options.workspaceDefault;
    this.workspaceRoots = options.workspaceRoots;
    if (isSessionAuthMode(this.auth.mode)) this.restoreKnownTenantScopes();
    else this.scopeForAuth(this.auth.defaultContext());
  }

  private scopeForClient(client: RuntimeClient): TenantRuntimeScope {
    return this.scopeForAuth(client.auth ?? this.auth.defaultContext());
  }

  private scopeForAuth(context: RuntimeAuthContext): TenantRuntimeScope {
    const key = context.tenantKey;
    const existing = this.tenantScopes.get(key);
    if (existing) return existing;
    const userDataPath = () =>
      isSessionAuthMode(context.mode)
        ? tenantPath(this.baseUserDataPath(), context)
        : this.baseUserDataPath();
    const storage = createScopedStorage(
      createAppStorage({
        backend: this.storageBackend,
        env: this.env,
        namespace: this.storageNamespace,
        postgresUrl: this.storagePostgresUrl,
        sqlitePath: scopedSqlitePath(this.storageSqlitePath, userDataPath),
        userDataPath,
      }),
      key,
    );
    const scope: TenantRuntimeScope = {
      browserWorkflowStore: new BrowserWorkflowStore(userDataPath()),
      context,
      key,
      manager: new AspManager({
        providerStoreOptions: {
          env: this.env,
          userDataPath,
        },
      }),
      mcpGateway: undefined as unknown as McpGateway,
      mcpGatewaySettings: readMcpGatewaySettings(userDataPath()),
      mcpGatewayStdioSocketServer: undefined as unknown as ReturnType<
        typeof createMcpGatewayStdioSocketServer
      >,
      panelState: emptyPanelState(),
      registeredNativeMcpProviderSignature: "",
      scheduledTasks: undefined as unknown as ScheduledTaskService,
      storage,
      terminal: undefined as unknown as TerminalService,
      userDataPath,
    };
    scope.terminal = new TerminalService(
      () => this.defaultWorkspaceForScope(scope),
      this.env,
      (channel, payload) => this.broadcastTenant(scope, channel, payload),
    );
    scope.manager.setClientServices({
      readTextFile: (input, context) => {
        const filePath = safeIdePath(context.cwd, path.resolve(context.cwd, input.path));
        const file = readIdeFile(filePath);
        const lines = file.content.split(/\r?\n/);
        const start = Math.max(0, (input.line ?? 1) - 1);
        const end = Math.min(lines.length, start + (input.limit ?? lines.length));
        return {
          content: lines.slice(start, end).join("\n"),
          path: file.path,
          truncated: start > 0 || end < lines.length,
        };
      },
      writeTextFile: (input, context) => {
        const filePath = safeIdePath(context.cwd, path.resolve(context.cwd, input.path));
        const bytes = Buffer.byteLength(input.content, "utf8");
        if (bytes > IDE_WRITE_MAX_BYTES) throw new Error("File is too large to write.");
        fs.writeFileSync(filePath, input.content, "utf8");
        return { path: filePath, bytes };
      },
      terminalCreate: (input, context) => {
        const id = aspTerminalId(context.runId, input.id);
        const cwd = safeIdePath(context.cwd, path.resolve(context.cwd, input.cwd || context.cwd));
        if (!fs.statSync(cwd).isDirectory()) throw new Error("Terminal cwd is not a directory.");
        scope.terminal.exec(
          { id, command: input.command, args: input.args, cwd, env: input.env },
          { send: () => undefined },
        );
        return { id: input.id };
      },
      terminalOutput: (input, context) => {
        const snapshot = scope.terminal.readOutput({
          id: aspTerminalId(context.runId, input.id),
          maxChars: input.maxChars,
        });
        return { ...snapshot, id: input.id };
      },
      terminalWaitForExit: async (input, context) => ({
        ...(await scope.terminal.waitForExit({
          id: aspTerminalId(context.runId, input.id),
          timeoutMs: input.timeoutMs,
        })),
        id: input.id,
      }),
      terminalKill: (input, context) => scope.terminal.stop(aspTerminalId(context.runId, input.id)),
      terminalRelease: (input, context) =>
        scope.terminal.release(aspTerminalId(context.runId, input.id)),
    });
    scope.mcpGateway = new McpGateway({
      requestUserInput: ({ request, scopeKey }) =>
        (scope.manager as AspManagerWithUserInput).requestUserInput(scopeKey, request),
    });
    scope.mcpGatewayStdioSocketServer = createMcpGatewayStdioSocketServer({
      gateway: scope.mcpGateway,
    });
    scope.scheduledTasks = new ScheduledTaskService({
      broadcast: (channel, payload) => this.broadcastTenant(scope, channel, payload),
      defaultWorkspace: () => this.defaultWorkspaceForScope(scope),
      log: this.log,
      privateSessionDirectory: (sessionId, createdAt) =>
        this.ensurePrivateSessionDirectory(scope, sessionId, createdAt),
      run: (input, sender) =>
        this.runAspSession(input, {
          ...(sender as RuntimeClient),
          auth: scope.context,
        } as RuntimeClient),
      storage,
    });
    this.tenantScopes.set(key, scope);
    scope.scheduledTasks.start();
    void this.queueMcpGatewayApply(scope);
    this.rememberTenant(context);
    return scope;
  }

  private restoreKnownTenantScopes(): void {
    for (const tenant of this.readTenantRegistry()) {
      this.scopeForAuth({
        mode: "oauth",
        tenantId: tenant.tenantId,
        tenantKey: tenant.tenantKey,
        user: { id: "system", name: "System" },
      });
    }
  }

  private rememberTenant(context: RuntimeAuthContext): void {
    if (!isSessionAuthMode(context.mode)) return;
    const tenants = this.readTenantRegistry();
    const now = Date.now();
    const next = [
      { tenantId: context.tenantId, tenantKey: context.tenantKey, updatedAt: now },
      ...tenants.filter((tenant) => tenant.tenantKey !== context.tenantKey),
    ].sort((a, b) => a.tenantKey.localeCompare(b.tenantKey));
    this.writeTenantRegistry(next);
  }

  private readTenantRegistry(): TenantRegistryRecord[] {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(this.baseUserDataPath(), TENANT_REGISTRY_FILE), "utf8"),
      ) as TenantRegistryFile;
      return (Array.isArray(parsed.tenants) ? parsed.tenants : [])
        .map(normalizeTenantRegistryRecord)
        .filter((tenant): tenant is TenantRegistryRecord => Boolean(tenant));
    } catch {
      return [];
    }
  }

  private writeTenantRegistry(tenants: TenantRegistryRecord[]): void {
    const filePath = path.join(this.baseUserDataPath(), TENANT_REGISTRY_FILE);
    const tempPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      tempPath,
      `${JSON.stringify({ tenants, version: 1 } satisfies TenantRegistryFile, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(tempPath, filePath);
  }

  async start(): Promise<{ port: number; rpcUrl: string; webUrl: string }> {
    if (this.httpServer) {
      return {
        port: this.resolvedPort,
        rpcUrl: this.rpcUrl(),
        webUrl: this.webUrl(),
      };
    }
    const server = http.createServer((request, response) => this.handleHttp(request, response));
    const socketServer = new WebSocketServer({
      path: "/agui-rpc",
      server,
      maxPayload: RPC_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    socketServer.on("connection", (socket, request) => {
      const auth = this.authenticateRuntimeRpcConnection(request);
      if (!auth) {
        socket.close(1008, "Unauthorized");
        return;
      }
      const client = this.webSocketRuntimeClient(socket, auth);
      let rateWindowStartedAt = Date.now();
      let callsInWindow = 0;
      socket.on("message", (data) => {
        const now = Date.now();
        if (now - rateWindowStartedAt >= 1_000) {
          rateWindowStartedAt = now;
          callsInWindow = 0;
        }
        callsInWindow += 1;
        if (callsInWindow > RPC_MAX_CALLS_PER_SECOND) {
          socket.close(1008, "Rate limit exceeded");
          return;
        }
        void this.handleJsonRpcMessage(data, client);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("error", onError);
        socketServer.off("error", onError);
        server.on("error", () => undefined);
        socketServer.on("error", () => undefined);
        socketServer.close();
        server.close();
        reject(error);
      };
      server.once("error", onError);
      socketServer.once("error", onError);
      server.listen(this.resolvedPort, this.host, () => {
        server.off("error", onError);
        socketServer.off("error", onError);
        server.on("error", (error) => {
          this.log.warn(`AGUI runtime failed: ${error.message}`);
        });
        socketServer.on("error", (error) => {
          this.log.warn(`AGUI runtime WebSocket failed: ${error.message}`);
        });
        const address = server.address();
        this.resolvedPort =
          typeof address === "object" && address ? address.port : this.resolvedPort;
        resolve();
      });
    });
    this.httpServer = server;
    this.socketServer = socketServer;
    this.log.info(`AGUI runtime listening on ${this.webUrl()}`);
    this.log.info(`AGUI JSON-RPC listening on ${this.rpcUrl()}`);
    return {
      port: this.resolvedPort,
      rpcUrl: this.rpcUrl(),
      webUrl: this.webUrl(),
    };
  }

  configureRpcServer(options: RuntimeRpcBindOptions): void {
    if (this.httpServer) {
      throw new Error("AGUI runtime RPC server must be stopped before changing bind settings.");
    }
    if (options.host !== undefined) this.host = runtimeRpcHost(options.host);
    if (options.port !== undefined) this.resolvedPort = runtimeRpcPortValue(options.port);
    if (options.token !== undefined) {
      this.token = options.token.trim() || randomBytes(24).toString("base64url");
    }
  }

  async stopRpcServer(): Promise<void> {
    this.socketServer?.clients.forEach((socket) => socket.close(1001, "AGUI shutting down"));
    this.socketServer?.close();
    this.socketServer = null;
    await new Promise<void>((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
      this.httpServer = null;
    });
  }

  async stop(): Promise<void> {
    await this.stopRpcServer();
    await Promise.all(
      [...this.tenantScopes.values()].map(async (scope) => {
        scope.scheduledTasks.stop();
        scope.terminal.dispose();
        await scope.mcpGatewayStdioSocketServer.stop();
        await scope.mcpGateway.clear();
        await scope.manager.dispose();
        await scope.storage.close();
      }),
    );
    this.tenantScopes.clear();
  }

  private hydrateTranscriptInWorker(input: TranscriptHydrationWorkerInput): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./transcript-hydration-worker.js", import.meta.url), {
        workerData: input,
      });
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        worker.removeAllListeners();
        callback();
      };
      worker.once("message", (message: TranscriptHydrationWorkerResponse) => {
        finish(() => {
          if (message.ok) {
            resolve(message.projection);
          } else {
            reject(errorFromWorkerPayload(message.error));
          }
        });
      });
      worker.once("error", (error) => {
        finish(() => reject(error));
      });
      worker.once("exit", (code) => {
        if (settled) return;
        finish(() => {
          reject(
            new Error(
              `Transcript hydration worker exited without a result${code === 0 ? "" : ` (code ${code})`}.`,
            ),
          );
        });
      });
    });
  }

  rpcUrl(host = this.host): string {
    return `ws://${host}:${this.resolvedPort}/agui-rpc?token=${encodeURIComponent(this.token)}`;
  }

  webUrl(host = this.host): string {
    return `http://${host}:${this.resolvedPort}/`;
  }

  broadcast(channel: string, payload: unknown, tenantKey?: string): void {
    this.eventBroadcast?.(channel, payload);
    this.socketServer?.clients.forEach((socket) => {
      if (socket.readyState !== WS_OPEN) return;
      const client = this.socketClients.get(socket);
      if (tenantKey && client?.auth?.tenantKey !== tenantKey) return;
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: channel, params: payload }));
    });
  }

  private broadcastTenant(scope: TenantRuntimeScope, channel: string, payload: unknown): void {
    this.broadcast(channel, payload, scope.key);
  }

  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.url === "/health") {
      sendJson(response, 200, { ok: true, protocol: "jsonrpc", path: "/agui-rpc" });
      return;
    }
    if (await this.auth.handleAuthRoute(request, response)) return;
    if (request.url?.startsWith("/agui-rpc")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const auth = this.auth.requireHttpAuth(request, response);
    if (!auth) return;
    this.scopeForAuth(auth);
    await this.serveStatic(request, response, auth);
  }

  private async serveStatic(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    auth: RuntimeAuthContext,
  ): Promise<void> {
    if (!this.staticRoot || !fs.existsSync(this.staticRoot)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("AGUI web assets are not built. Run `pnpm build` or use `pnpm dev:pure-web`.");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const candidate = path.resolve(this.staticRoot, pathname.replace(/^\/+/, ""));
    if (!isPathInside(this.staticRoot, candidate)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    const filePath =
      fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : path.join(this.staticRoot, "index.html");
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error("Not a file.");
      const contentType = contentTypeFor(filePath);
      if (contentType === "text/html") {
        const html = await fs.promises.readFile(filePath, "utf8");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(this.injectRuntimeUrl(html, request, auth));
        return;
      }
      response.writeHead(200, {
        "content-length": stat.size,
        "content-type": contentType,
      });
      fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  }

  private injectRuntimeUrl(
    html: string,
    request: http.IncomingMessage,
    auth: RuntimeAuthContext,
  ): string {
    if (html.includes('name="agui-rpc-url"')) return html;
    if (!isSessionAuthMode(this.auth.mode) && !isLocalRuntimePageRequest(request)) return html;
    const rpcUrl = this.auth.runtimeRpcUrl(
      request,
      this.auth.mode === "token" && auth.mode === "token" ? this.token : undefined,
    );
    const metadata = `<meta name="agui-rpc-url" content="${escapeHtmlAttribute(rpcUrl)}">`;
    return html.includes("<head>")
      ? html.replace("<head>", `<head>${metadata}`)
      : `${metadata}\n${html}`;
  }

  async invokeRuntimeMethod(
    method: string,
    params: unknown,
    client: RuntimeClient,
  ): Promise<unknown> {
    params = parseRuntimeMethodParams(method, params);
    const scope = this.scopeForClient(client);
    switch (method) {
      case "runtime.info":
        return this.currentRuntimeInfo();
      case "providers.list":
        return scope.manager.providers.list();
      case "providers.save":
        return scope.manager.providers.save(params as AspProvider);
      case "providers.remove":
        return scope.manager.providers.remove(String(params));
      case "providers.test":
        return scope.manager.testProvider(params as AspProvider);
      case "providers.capabilities": {
        const input = params as { providerId?: string; cwd?: string };
        return scope.manager.providerCapabilities(
          String(input?.providerId ?? ""),
          this.safeWorkspacePathOrDefault(scope, input?.cwd),
        );
      }
      case "providers.detect":
        return detectAgentCliProviders(this.env);
      case "workspace.choose":
        return this.chooseWorkspace(scope, typeof params === "string" ? params : undefined);
      case "workspace.getDefault":
        return this.safeWorkspacePathOrDefault(
          scope,
          typeof this.workspaceDefault === "function"
            ? this.workspaceDefault()
            : (this.workspaceDefault ?? this.defaultWorkspaceForScope(scope)),
        );
      case "workspace.listDirectories": {
        const input = params as { path?: string };
        return this.listWorkspaceDirectories(
          scope,
          typeof input?.path === "string" ? input.path : undefined,
        );
      }
      case "workspace.privateRoot":
        return this.privateSessionsRoot(scope);
      case "workspace.privateSession": {
        const input = params as { sessionId?: string; createdAt?: number };
        return this.ensurePrivateSessionDirectory(
          scope,
          String(input?.sessionId ?? ""),
          input?.createdAt,
        );
      }
      case "mcpGateway.getSettings":
        return this.getMcpGatewaySettings(
          scope,
          params as McpGatewayScopeInput | undefined,
          client,
        );
      case "mcpGateway.setEnabled": {
        const input = params as { enabled?: boolean } & McpGatewayScopeInput;
        return this.updateMcpGatewaySettings(
          scope,
          {
            ...scope.mcpGatewaySettings,
            enabled: input?.enabled === true,
          },
          input,
          client,
        );
      }
      case "mcpGateway.setLlm": {
        const input = params as McpGatewayScopeInput;
        return this.updateMcpGatewaySettings(
          scope,
          {
            ...scope.mcpGatewaySettings,
            llm: normalizeMcpGatewayLlmSettings(params),
          },
          input,
          client,
        );
      }
      case "mcpGateway.saveServer": {
        const input = params as Partial<McpGatewayRuntimeSettings["servers"][number]> &
          McpGatewayScopeInput;
        return this.saveMcpGatewayServer(scope, input, client);
      }
      case "mcpGateway.removeServer": {
        const input = params as { id?: string } & McpGatewayScopeInput;
        return this.removeMcpGatewayServer(scope, String(input?.id ?? ""), input, client);
      }
      case "mcpGateway.refresh":
        await this.queueMcpGatewayApply(scope);
        return this.getMcpGatewaySettings(
          scope,
          params as McpGatewayScopeInput | undefined,
          client,
        );
      case "browserWorkflows.list":
        return scope.browserWorkflowStore.list();
      case "browserWorkflows.get": {
        const input = params as { id?: string; toolName?: string };
        return scope.browserWorkflowStore.get(String(input?.id || input?.toolName || "")) ?? null;
      }
      case "browserWorkflows.save": {
        const workflow = scope.browserWorkflowStore.save(params as BrowserWorkflowSaveInput);
        scope.mcpGateway.notifyCatalogChanged();
        return workflow;
      }
      case "browserWorkflows.remove": {
        const input = params as { id?: string; toolName?: string };
        const removed = scope.browserWorkflowStore.remove(
          String(input?.id || input?.toolName || ""),
        );
        if (removed) scope.mcpGateway.notifyCatalogChanged();
        return removed;
      }
      case "browserWorkflows.generateFromAnnotations": {
        const input = params as {
          browserId?: string;
          description?: string;
          id?: string;
          save?: boolean;
          title?: string;
        };
        const result = record(
          await this.invokeBrowserMethod(
            "browser.listAnnotations",
            { id: input?.browserId },
            client,
          ),
        );
        const annotations = Array.isArray(result.annotations) ? result.annotations : [];
        const workflow = workflowFromAnnotations({
          annotations: annotations as BrowserWorkflowAnnotation[],
          description: stringValue(input?.description),
          id: stringValue(input?.id),
          title: stringValue(input?.title),
        });
        if (input?.save === true) {
          const saved = scope.browserWorkflowStore.save(workflow);
          scope.mcpGateway.notifyCatalogChanged();
          return saved;
        }
        return workflow;
      }
      case "scheduledTasks.list":
        return scope.scheduledTasks.listTasks();
      case "scheduledTasks.add":
        return scope.scheduledTasks.addTask(
          this.safeScheduledTaskInput(scope, params as ScheduledTaskInput),
        );
      case "scheduledTasks.update": {
        const input = params as { id?: string; task?: ScheduledTaskInput };
        return scope.scheduledTasks.updateTask(
          String(input?.id ?? ""),
          this.safeScheduledTaskInput(scope, input?.task as ScheduledTaskInput),
        );
      }
      case "scheduledTasks.remove": {
        const input = params as { id?: string };
        return scope.scheduledTasks.removeTask(String(input?.id ?? ""));
      }
      case "scheduledTasks.setEnabled": {
        const input = params as { enabled?: boolean; id?: string };
        return scope.scheduledTasks.setTaskEnabled(
          String(input?.id ?? ""),
          input?.enabled === true,
        );
      }
      case "scheduledTasks.runNow": {
        const input = params as { id?: string };
        return scope.scheduledTasks.runTaskNow(String(input?.id ?? ""));
      }
      case "storage.get": {
        const input = params as { key?: string; namespace?: string };
        return scope.storage.get({
          key: String(input?.key ?? ""),
          namespace: input?.namespace,
        });
      }
      case "storage.set": {
        const input = params as { key?: string; namespace?: string; value?: string };
        return scope.storage.set({
          key: String(input?.key ?? ""),
          namespace: input?.namespace,
          value: String(input?.value ?? ""),
        });
      }
      case "storage.remove": {
        const input = params as { key?: string; namespace?: string };
        return scope.storage.remove({
          key: String(input?.key ?? ""),
          namespace: input?.namespace,
        });
      }
      case "storage.list": {
        return scope.storage.list(params as { namespace?: string; prefix?: string } | undefined);
      }
      case "sessions.run": {
        return this.runAspSession(params as RunInput, client);
      }
      case "sessions.cancel":
        return scope.manager.cancel(String(params));
      case "sessions.cleanupHandoffFiles":
        await cleanupHandoffFiles(scope.userDataPath(), String(params));
        return true;
      case "sessions.invokeExtension":
        return scope.manager.invokeExtension(params as AspExtensionInvokeInput, client.id);
      case "sessions.list": {
        const input = params as { providerId?: string; cwd?: string };
        return scope.manager.listSessions(
          String(input?.providerId ?? ""),
          this.safeWorkspacePathOrDefault(scope, input?.cwd),
        );
      }
      case "sessions.create": {
        const input = params as { providerId?: string; cwd?: string; title?: string };
        return scope.manager.newSession(
          String(input?.providerId ?? ""),
          this.safeWorkspacePathOrDefault(scope, input?.cwd),
          input?.title,
        );
      }
      case "sessions.close": {
        const input = params as { providerId?: string; providerSessionId?: string; cwd?: string };
        return scope.manager.closeSession(
          String(input?.providerId ?? ""),
          String(input?.providerSessionId ?? ""),
          this.safeWorkspacePathOrDefault(scope, input?.cwd),
        );
      }
      case "sessions.messages": {
        const input = params as { providerId?: string; providerSessionId?: string };
        return scope.manager.sessionMessages(
          String(input?.providerId ?? ""),
          String(input?.providerSessionId ?? ""),
        );
      }
      case "sessions.usage": {
        const input = params as { providerId?: string; providerSessionId?: string };
        return scope.manager.sessionUsage(
          String(input?.providerId ?? ""),
          String(input?.providerSessionId ?? ""),
        );
      }
      case "sessions.resume": {
        const input = params as { providerId?: string; providerSessionId?: string; cwd?: string };
        return scope.manager.resumeSession(
          String(input?.providerId ?? ""),
          String(input?.providerSessionId ?? ""),
          this.safeWorkspacePathOrDefault(scope, input?.cwd),
        );
      }
      case "sessions.hydrateTranscript": {
        const input = params as {
          cwd?: string;
          previousContextUsage?: {
            used: number;
            usedKnown?: boolean;
            size: number;
            source?: string;
            cost?: { amount: number; currency: string } | null;
          };
          providerId?: string;
          providerSessionId?: string;
          providers?: AspProvider[];
          transcriptPath?: string;
        };
        const providerId = String(input?.providerId ?? "");
        const providerSessionId = String(input?.providerSessionId ?? "");
        const transcriptPath = String(input?.transcriptPath ?? "").trim();
        return this.hydrateTranscriptInWorker({
          cwd: this.safeWorkspacePathOrDefault(scope, input?.cwd),
          env: this.env,
          previousContextUsage: input?.previousContextUsage,
          providerId,
          providerSessionId,
          providers: input?.providers ?? [],
          transcriptPath: transcriptPath || undefined,
          userDataPath: scope.userDataPath(),
        });
      }
      case "sessions.delete": {
        const input = params as {
          providerId?: string;
          providerSessionId?: string;
          transcriptPath?: string;
          cwd?: string;
        };
        return scope.manager.deleteSession(
          String(input?.providerId ?? ""),
          String(input?.providerSessionId ?? ""),
          this.safeWorkspacePathOrDefault(scope, input?.cwd),
          this.safeTranscriptPath(scope, input?.transcriptPath),
        );
      }
      case "interactions.respondApproval": {
        const input = params as {
          requestId?: string;
          decision?: AspApprovalDecision;
          message?: string;
        };
        const responded = scope.manager.respondApproval(
          String(input?.requestId ?? ""),
          input?.decision ?? "cancel",
          input?.message,
          client.id,
        );
        if (responded) return true;
        return scope.manager.respondApproval(
          String(input?.requestId ?? ""),
          input?.decision ?? "cancel",
          input?.message,
          SCHEDULED_TASK_SENDER_ID,
        );
      }
      case "interactions.respondQuestion": {
        const input = params as { requestId?: string; response?: AspQuestionResponse };
        const responded = scope.manager.respondQuestion(
          String(input?.requestId ?? ""),
          input?.response ?? { canceled: true },
          client.id,
        );
        if (responded) return true;
        return scope.manager.respondQuestion(
          String(input?.requestId ?? ""),
          input?.response ?? { canceled: true },
          SCHEDULED_TASK_SENDER_ID,
        );
      }
      case "interactions.pending":
        return (scope.manager as AspManagerWithUserInput).pendingInteractions(client);
      case "panel.syncState":
        return this.syncPanelState(scope, params);
      case "panel.syncIdeState":
        return this.syncIdePanelState(scope, params);
      case "terminal.run":
        return scope.terminal.run(
          this.safeTerminalInput(scope, params as { id?: string; command?: string; cwd?: string }),
          client,
        );
      case "terminal.exec":
        return scope.terminal.exec(
          this.safeTerminalInput(
            scope,
            params as { id?: string; command?: string; args?: unknown; cwd?: string },
          ),
          client,
        );
      case "terminal.cancel":
        return scope.terminal.stop(String(params));
      case "terminal.create":
        return scope.terminal.create(
          this.safeTerminalInput(scope, params as { id?: string; cwd?: string }),
          client,
        );
      case "terminal.write":
        return scope.terminal.write(params as { id?: string; data?: string });
      case "terminal.resize":
        return scope.terminal.resize(params as { id?: string; cols?: number; rows?: number });
      case "terminal.dispose":
        return scope.terminal.stop(String(params));
      case "ide.tree": {
        const input = params as { root?: string };
        return buildIdeTree(this.safeIdeRootForScope(scope, input?.root));
      }
      case "ide.readFile": {
        const input = params as { root?: string; filePath?: string };
        const root = this.safeIdeRootForScope(scope, input?.root);
        return readIdeFile(safeIdePath(root, input?.filePath));
      }
      case "ide.writeFile": {
        const input = params as { root?: string; filePath?: string; content?: string };
        const root = this.safeIdeRootForScope(scope, input?.root);
        const filePath = safeIdePath(root, input?.filePath);
        const content = String(input?.content ?? "");
        if (Buffer.byteLength(content, "utf8") > IDE_WRITE_MAX_BYTES) {
          throw new Error("File is too large to write from the IDE panel.");
        }
        fs.writeFileSync(filePath, content, "utf8");
        return readIdeFile(filePath);
      }
      case "ide.diagnostics":
        return this.invokeIdeDiagnostics(
          scope,
          params as { root?: string; filePath?: string; content?: string },
        );
      case "ide.workspaceDiagnostics":
        return this.invokeIdeWorkspaceDiagnostics(scope, params as { root?: string });
      case "ide.semanticTokens":
        return this.invokeIdeSemanticTokens(
          scope,
          params as { root?: string; filePath?: string; content?: string },
        );
      case "browser.list":
      case "browser.unregister":
      case "browser.releaseFocus":
      case "browser.create":
      case "browser.register":
      case "browser.setBounds":
      case "browser.navigate":
      case "browser.reload":
      case "browser.stop":
      case "browser.goBack":
      case "browser.goForward":
      case "browser.evaluate":
      case "browser.click":
      case "browser.type":
      case "browser.snapshot":
      case "browser.screenshot":
      case "browser.setAnnotationMode":
      case "browser.setWorkflowRecordingMode":
      case "browser.listAnnotations":
      case "browser.clearAnnotations":
      case "browser.addAnnotation":
      case "browser.deleteAnnotation":
      case "browser.inspectElement":
      case "browser.cdpCommand":
      case "browser.cdpStartCapture":
      case "browser.cdpEvents":
      case "browser.cdpStopCapture":
      case "browser.screencastStart":
      case "browser.screencastAck":
      case "browser.screencastStop":
      case "browser.dispatchMouse":
      case "browser.dispatchKey":
      case "browser.insertText":
      case "interactiveApp.create":
      case "interactiveApp.destroy":
      case "interactiveApp.setBounds":
      case "interactiveApp.postMessage":
        return this.invokeBrowserMethod(method, params, client);
      case "extensions.list":
      case "extensions.audit":
      case "extensions.marketplace":
      case "extensions.chooseInstall":
      case "extensions.chooseUpdate":
      case "extensions.workspaceTrusted":
      case "extensions.setWorkspaceTrust":
      case "extensions.uninstall":
      case "extensions.resolveAgent":
      case "extensions.getConfiguration":
      case "extensions.updateConfiguration":
      case "extensions.install":
      case "extensions.update":
      case "extensions.grant":
      case "extensions.setEnabled":
      case "extensions.readAsset":
      case "extensions.activate":
      case "extensions.executeCommand":
        return this.invokeExtensionMethod(method, this.scopeExtensionParams(scope, params), client);
      default:
        throw new Error(`Unknown runtime method: ${method}`);
    }
  }

  private async runAspSession(input: RunInput, client: AspEventSender): Promise<RunResult> {
    const runtimeClient = client as RuntimeClient;
    const scope = this.scopeForClient(runtimeClient);
    const scopedInput = this.safeRunInput(scope, input);
    try {
      const prepared = await prepareHandoffFiles(scopedInput, scope.userDataPath());
      if (prepared.files.length) {
        scope.mcpGateway.registerScopedToolProvider(scopedInput.uiSessionId, {
          id: handoffFileMcpProviderId,
          label: "Original Handoff Files",
          provider: createHandoffFileMcpToolProvider(prepared.files),
          readOnly: true,
          source: "handoff",
        });
      }
      const runInput = await this.withMcpGatewayRunInput(scope, prepared.input);
      return await scope.manager.run(runInput, client);
    } finally {
      await this.cleanupMcpGatewayRun(scope, scopedInput.uiSessionId);
    }
  }

  private syncPanelState(scope: TenantRuntimeScope, input: unknown): AguiPanelRuntimeState {
    const previousSignature = this.nativeMcpProviderSignature(scope);
    const previousToolSignature = this.panelMcpToolSignature(scope);
    const next = normalizePanelState(input, scope.panelState.ide);
    scope.panelState = next;
    const nextSignature = this.nativeMcpProviderSignature(scope);
    const nextToolSignature = this.panelMcpToolSignature(scope);
    if (nextSignature !== previousSignature) {
      void this.queueMcpGatewayApply(scope);
    } else if (nextToolSignature !== previousToolSignature) {
      void scope.mcpGateway.refresh().catch((error) => {
        this.log.warn(`Failed to refresh AGUI panel MCP tools: ${formatRuntimeError(error)}`);
      });
    }
    return scope.panelState;
  }

  private syncIdePanelState(scope: TenantRuntimeScope, input: unknown): AguiIdePanelState {
    const ide = normalizeIdePanelState(input);
    scope.panelState = {
      ...scope.panelState,
      ide,
      updatedAt: Date.now(),
    };
    return ide;
  }

  private async getMcpGatewaySettings(
    scope: TenantRuntimeScope,
    input?: McpGatewayScopeInput,
    client?: RuntimeClient,
  ): Promise<Record<string, unknown>> {
    if (scope.mcpGatewayApplyPromise) {
      await scope.mcpGatewayApplyPromise.catch((error) => {
        this.log.warn(`Failed to apply MCP Gateway settings: ${formatRuntimeError(error)}`);
      });
    }
    const extensionSync = await this.syncExtensionMcpGatewaySources(scope, input, client);
    const resolveModelError = validateMcpGatewayResolveModel(
      scope.mcpGatewaySettings.llm,
      this.env,
    );
    const configurationError = scope.mcpGatewaySettings.enabled ? resolveModelError : undefined;
    const nativeProviders = this.nativeMcpProviderIds(scope);
    const gatewayRuntimeAvailable =
      scope.mcpGatewaySettings.enabled ||
      nativeProviders.length > 0 ||
      extensionSync.servers.length > 0;
    let runtime: Record<string, unknown>;
    if (gatewayRuntimeAvailable && (!configurationError || nativeProviders.length > 0)) {
      let endpointError: string | null = null;
      let transport: "stdio" | null = null;
      try {
        await scope.mcpGatewayStdioSocketServer.getAddress();
        transport = "stdio";
        scope.mcpGatewayRuntimeError = undefined;
      } catch (error) {
        endpointError = formatRuntimeError(error);
        scope.mcpGatewayRuntimeError = endpointError;
      }
      runtime = {
        endpoint: transport,
        error: endpointError ?? configurationError ?? null,
        nativeProviders,
        resolveModelReady: !resolveModelError,
        transport,
      };
    } else {
      runtime = {
        endpoint: null,
        nativeProviders,
        error: configurationError ?? resolveModelError ?? scope.mcpGatewayRuntimeError ?? null,
        resolveModelReady: !resolveModelError,
        transport: null,
      };
    }
    const serverViews = await scope.mcpGateway.listServers(extensionSync.scopeKey).catch(() => []);
    const viewsById = new Map(serverViews.map((server) => [server.id, server]));
    const extensionViewsByNamespace = new Map(
      serverViews
        .filter((server) => server.source === "extension" && server.namespace)
        .map((server) => [server.namespace!, server]),
    );
    const configuredServers = scope.mcpGatewaySettings.servers.map((server) => ({
      ...server,
      ...(viewsById.get(server.id) ?? {
        status: server.enabled ? "unknown" : "offline",
        toolCount: 0,
        tools: [],
      }),
      readOnly: false,
      source: "settings",
    }));
    const extensionServers = extensionSync.servers.map(({ config, extensionId }) => {
      const view = extensionViewsByNamespace.get(config.id);
      return {
        ...config,
        enabled: true,
        extensionId: view?.extensionId ?? extensionId,
        namespace: config.id,
        readOnly: true,
        source: "extension",
        status: view?.status ?? "unknown",
        toolCount: view?.toolCount ?? 0,
        tools: view?.tools ?? [],
        error: view?.error,
      };
    });
    return {
      ...scope.mcpGatewaySettings,
      runtime,
      servers: [...configuredServers, ...extensionServers],
      summary: await scope.mcpGateway.getSummary(extensionSync.scopeKey).catch(() => ({
        offlineServerCount: 0,
        onlineServerCount: 0,
        serverCount: 0,
        toolCount: 0,
        unknownServerCount: 0,
      })),
    };
  }

  private async updateMcpGatewaySettings(
    scope: TenantRuntimeScope,
    settings: McpGatewayRuntimeSettings,
    scopeInput?: McpGatewayScopeInput,
    client?: RuntimeClient,
  ): Promise<Record<string, unknown>> {
    const startupError = validateMcpGatewayStartupSettings(settings, this.env);
    if (settings.enabled && startupError) {
      scope.mcpGatewayRuntimeError = startupError;
      await scope.mcpGatewayStdioSocketServer.stop();
      throw new Error(startupError);
    }
    scope.mcpGatewayRuntimeError = undefined;
    scope.mcpGatewaySettings = writeMcpGatewaySettings(scope.userDataPath(), settings);
    await this.queueMcpGatewayApply(scope);
    return this.getMcpGatewaySettings(scope, scopeInput, client);
  }

  private async saveMcpGatewayServer(
    scope: TenantRuntimeScope,
    input: Partial<McpGatewayRuntimeSettings["servers"][number]> & McpGatewayScopeInput,
    client?: RuntimeClient,
  ): Promise<Record<string, unknown>> {
    const server = normalizeRuntimeMcpGatewayServer(input);
    const nextServers = [
      ...scope.mcpGatewaySettings.servers.filter((candidate) => candidate.id !== server.id),
      server,
    ];
    return this.updateMcpGatewaySettings(
      scope,
      {
        ...scope.mcpGatewaySettings,
        servers: nextServers,
      },
      input,
      client,
    );
  }

  private async removeMcpGatewayServer(
    scope: TenantRuntimeScope,
    id: string,
    scopeInput?: McpGatewayScopeInput,
    client?: RuntimeClient,
  ): Promise<Record<string, unknown>> {
    const serverId = id.trim();
    if (!serverId) throw new Error("MCP Gateway server id is required.");
    return this.updateMcpGatewaySettings(
      scope,
      {
        ...scope.mcpGatewaySettings,
        servers: scope.mcpGatewaySettings.servers.filter((server) => server.id !== serverId),
      },
      scopeInput,
      client,
    );
  }

  private async syncExtensionMcpGatewaySources(
    scope: TenantRuntimeScope,
    input?: McpGatewayScopeInput,
    client?: RuntimeClient,
  ): Promise<ExtensionMcpGatewaySync> {
    const workspacePath = stringValue(input?.workspacePath);
    if (!workspacePath || !client) {
      if (scope.extensionMcpGatewayScopeKey) {
        await scope.mcpGateway.unregisterScope(scope.extensionMcpGatewayScopeKey).catch((error) => {
          this.log.warn(
            `Failed to cleanup extension MCP Gateway scope: ${formatRuntimeError(error)}`,
          );
        });
        scope.extensionMcpGatewayScopeKey = undefined;
      }
      return { servers: [], warnings: [] };
    }

    const safeWorkspacePath = this.safeServerWorkspaceDirectory(scope, workspacePath);
    const workspaceId = this.tenantWorkspaceId(
      scope,
      extensionMcpGatewayWorkspaceId(input?.workspaceId),
    );
    const scopeKey = extensionMcpGatewayScopeKey(safeWorkspacePath, workspaceId);
    if (scope.extensionMcpGatewayScopeKey && scope.extensionMcpGatewayScopeKey !== scopeKey) {
      await scope.mcpGateway.unregisterScope(scope.extensionMcpGatewayScopeKey).catch((error) => {
        this.log.warn(
          `Failed to cleanup previous extension MCP Gateway scope: ${formatRuntimeError(error)}`,
        );
      });
    }
    scope.extensionMcpGatewayScopeKey = scopeKey;
    await scope.mcpGateway.unregisterScope(scopeKey).catch((error) => {
      this.log.warn(`Failed to reset extension MCP Gateway scope: ${formatRuntimeError(error)}`);
    });

    let resolved: unknown;
    try {
      resolved = await Promise.resolve(
        this.invokeExtensionMethod(
          "extensions.resolveAgent",
          { workspacePath: safeWorkspacePath, workspaceId },
          client,
        ),
      );
    } catch (error) {
      this.log.warn(`Failed to resolve extension MCP servers: ${formatRuntimeError(error)}`);
      return { scopeKey, servers: [], warnings: [formatRuntimeError(error)] };
    }

    const resources = record(resolved);
    const warnings = stringArray(resources.warnings);
    for (const warning of warnings) {
      this.log.warn(`Extension MCP Gateway warning: ${warning}`);
    }
    const metadataById = extensionMcpGatewayMetadataById(resources.mcpServers);
    const servers = mcpGatewayServersFromRun(resources.mcpServers as RunInput["mcpServers"]).map(
      (config) => ({
        config,
        extensionId: metadataById.get(config.id)?.extensionId,
      }),
    );

    for (const { config, extensionId } of servers) {
      try {
        scope.mcpGateway.registerScopedMcpServer(scopeKey, config, {
          extensionId,
          readOnly: true,
          source: "extension",
        });
      } catch (error) {
        this.log.warn(
          `Failed to register extension MCP server ${config.id}: ${formatRuntimeError(error)}`,
        );
      }
    }
    if (servers.length) {
      await scope.mcpGateway.refresh().catch((error) => {
        this.log.warn(
          `Failed to refresh extension MCP Gateway catalog: ${formatRuntimeError(error)}`,
        );
      });
    }
    return { scopeKey, servers, warnings };
  }

  private queueMcpGatewayApply(scope: TenantRuntimeScope): Promise<void> {
    const previous = scope.mcpGatewayApplyPromise;
    const promise = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.applyMcpGatewaySettings(scope))
      .finally(() => {
        if (scope.mcpGatewayApplyPromise === promise) scope.mcpGatewayApplyPromise = undefined;
      });
    scope.mcpGatewayApplyPromise = promise;
    return promise;
  }

  private async applyMcpGatewaySettings(scope: TenantRuntimeScope): Promise<void> {
    scope.mcpGateway.configure({ llm: scope.mcpGatewaySettings.llm });
    await scope.mcpGateway.clear();
    const nativeProviderCount = this.registerNativeMcpProviders(scope);
    if (!scope.mcpGatewaySettings.enabled) {
      scope.mcpGatewayRuntimeError = undefined;
      if (nativeProviderCount === 0) {
        await scope.mcpGatewayStdioSocketServer.stop();
        return;
      }
      await this.refreshAndStartMcpGateway(scope);
      return;
    }
    const startupError = validateMcpGatewayStartupSettings(scope.mcpGatewaySettings, this.env);
    if (startupError) {
      scope.mcpGatewayRuntimeError = startupError;
      this.log.warn(startupError);
      if (nativeProviderCount === 0) {
        await scope.mcpGatewayStdioSocketServer.stop();
        return;
      }
      await this.refreshAndStartMcpGateway(scope);
      return;
    }
    scope.mcpGatewayRuntimeError = undefined;
    for (const server of scope.mcpGatewaySettings.servers) {
      if (!server.enabled) continue;
      try {
        scope.mcpGateway.registerMcpServer(server);
      } catch (error) {
        this.log.warn(
          `Failed to register MCP Gateway server ${server.id}: ${formatRuntimeError(error)}`,
        );
      }
    }
    await this.refreshAndStartMcpGateway(scope);
  }

  private async refreshAndStartMcpGateway(scope: TenantRuntimeScope): Promise<void> {
    await scope.mcpGateway.refresh().catch((error) => {
      this.log.warn(`Failed to refresh MCP Gateway catalog: ${formatRuntimeError(error)}`);
    });
    await scope.mcpGatewayStdioSocketServer.start().catch((error) => {
      this.log.warn(
        `Failed to start MCP Gateway stdio bridge server: ${formatRuntimeError(error)}`,
      );
    });
  }

  private async withMcpGatewayRunInput(
    scope: TenantRuntimeScope,
    input: RunInput,
  ): Promise<RunInput> {
    const nativeProviders = this.nativeMcpProviderIds(scope);
    const runMcpServers = mcpGatewayServersFromRun(input.mcpServers);
    const hasRunScopedSources = scope.mcpGateway.hasScopeSources(input.uiSessionId);
    if (
      !scope.mcpGatewaySettings.enabled &&
      nativeProviders.length === 0 &&
      runMcpServers.length === 0 &&
      !hasRunScopedSources
    ) {
      return input;
    }
    const startupError = validateMcpGatewayStartupSettings(scope.mcpGatewaySettings, this.env);
    if (scope.mcpGatewaySettings.enabled && startupError) {
      throw new Error(`MCP Gateway is enabled but cannot be injected: ${startupError}`);
    }
    if (
      nativeProviders.length > 0 &&
      scope.registeredNativeMcpProviderSignature !== this.nativeMcpProviderSignature(scope)
    ) {
      await this.queueMcpGatewayApply(scope);
    }
    if (scope.mcpGatewayApplyPromise) {
      try {
        await scope.mcpGatewayApplyPromise;
      } catch (error) {
        const message = formatRuntimeError(error);
        scope.mcpGatewayRuntimeError = message;
        throw new Error(`MCP Gateway is enabled but cannot be injected: ${message}`);
      }
    }
    if (runMcpServers.length) {
      for (const server of runMcpServers) {
        try {
          scope.mcpGateway.registerScopedMcpServer(input.uiSessionId, server);
        } catch (error) {
          this.log.warn(
            `Failed to register run MCP server ${server.id}: ${formatRuntimeError(error)}`,
          );
        }
      }
    }
    if (runMcpServers.length || hasRunScopedSources) await this.refreshAndStartMcpGateway(scope);
    let bridgeAddress: McpGatewayStdioSocketAddress;
    try {
      bridgeAddress = await scope.mcpGatewayStdioSocketServer.getAddress();
      scope.mcpGatewayRuntimeError = undefined;
    } catch (error) {
      const message = formatRuntimeError(error);
      scope.mcpGatewayRuntimeError = message;
      throw new Error(`MCP Gateway is enabled but cannot be injected: ${message}`);
    }
    return injectMcpGatewayRunInput(
      input,
      mcpGatewayStdioBridgeServer(bridgeAddress, input.uiSessionId),
    );
  }

  private async cleanupMcpGatewayRun(
    scope: TenantRuntimeScope,
    uiSessionId: string,
  ): Promise<void> {
    if (!uiSessionId) return;
    await scope.mcpGateway.unregisterScope(uiSessionId).catch((error) => {
      this.log.warn(`Failed to cleanup run MCP servers: ${formatRuntimeError(error)}`);
    });
    if (
      !scope.mcpGatewaySettings.enabled &&
      this.nativeMcpProviderIds(scope).length === 0 &&
      !scope.mcpGateway.hasSources()
    ) {
      await scope.mcpGatewayStdioSocketServer.stop().catch(() => undefined);
    }
  }

  private nativeMcpProviderIds(scope: TenantRuntimeScope): string[] {
    const ids = this.shouldRegisterPanelMcpProvider(scope) ? [panelMcpProviderId] : [];
    if (this.shouldRegisterBrowserMcpProvider(scope)) ids.push(browserMcpProviderId);
    if (this.shouldRegisterBrowserWorkflowMcpProvider(scope))
      ids.push(browserWorkflowMcpProviderId);
    return ids;
  }

  private registerNativeMcpProviders(scope: TenantRuntimeScope): number {
    const signature = this.nativeMcpProviderSignature(scope);
    scope.registeredNativeMcpProviderSignature = signature;
    let count = 0;
    if (this.shouldRegisterPanelMcpProvider(scope)) {
      scope.mcpGateway.registerToolProvider({
        id: panelMcpProviderId,
        label: "AGUI Panel",
        provider: createPanelMcpToolProvider({
          getPanelState: () => scope.panelState,
          sendPanelCommand: (command) => {
            this.broadcastTenant(scope, "agui:panel:command", { ...command, at: Date.now() });
            return { sent: true };
          },
          terminal: {
            cancel: (id) => scope.terminal.stop(id),
            list: () => scope.terminal.list(),
            readOutput: (input) => scope.terminal.readOutput(input),
            runCommand: (input) =>
              scope.terminal.run(
                {
                  id: input.id,
                  command: input.command,
                  cwd: this.safeWorkspacePathOrDefault(scope, input.cwd),
                },
                this.nativeMcpRuntimeClient(scope),
              ),
            writeInput: (input) => scope.terminal.write(input),
          },
          ide: {
            readFile: ({ root, filePath }) =>
              readIdeFile(safeIdePath(this.safeIdeRootForScope(scope, root), filePath)),
            tree: ({ root }) => buildIdeTree(this.safeIdeRootForScope(scope, root)),
            workspaceDiagnostics: ({ root }) =>
              this.invokeIdeWorkspaceDiagnostics(scope, {
                root: this.safeIdeRootForScope(scope, root),
              }),
            writeFile: ({ root, filePath, content }) => {
              const safeRoot = this.safeIdeRootForScope(scope, root);
              const safePath = safeIdePath(safeRoot, filePath);
              if (Buffer.byteLength(content, "utf8") > IDE_WRITE_MAX_BYTES) {
                throw new Error("File is too large to write from the IDE panel.");
              }
              fs.writeFileSync(safePath, content, "utf8");
              return readIdeFile(safePath);
            },
          },
        }),
      });
      count += 1;
    }
    if (this.shouldRegisterBrowserMcpProvider(scope)) {
      scope.mcpGateway.registerToolProvider({
        id: browserMcpProviderId,
        label: "AGUI Browser",
        provider: createBrowserMcpToolProvider({
          invokeBrowserMethod: (method, params) =>
            this.browserMethod!(method, params, this.nativeMcpRuntimeClient(scope)),
        }),
      });
      count += 1;
    }
    if (this.shouldRegisterBrowserWorkflowMcpProvider(scope)) {
      scope.mcpGateway.registerToolProvider({
        id: browserWorkflowMcpProviderId,
        label: "AGUI Browser Workflows",
        provider: createBrowserWorkflowMcpToolProvider({
          invokeBrowserMethod: (method, params) =>
            this.browserMethod!(method, params, this.nativeMcpRuntimeClient(scope)),
          onCatalogChanged: () => scope.mcpGateway.notifyCatalogChanged(),
          store: scope.browserWorkflowStore,
        }),
      });
      count += 1;
    }
    return count;
  }

  private shouldRegisterBrowserMcpProvider(scope: TenantRuntimeScope): boolean {
    return Boolean(
      this.panelHas(scope, "browser") &&
      this.browserMethod &&
      this.currentRuntimeInfo().features.browserAutomation,
    );
  }

  private shouldRegisterBrowserWorkflowMcpProvider(scope: TenantRuntimeScope): boolean {
    return this.shouldRegisterBrowserMcpProvider(scope);
  }

  private shouldRegisterPanelMcpProvider(scope: TenantRuntimeScope): boolean {
    return scope.panelState.panels.length > 0;
  }

  private nativeMcpProviderSignature(scope: TenantRuntimeScope): string {
    return this.nativeMcpProviderIds(scope).join(",");
  }

  private panelHas(scope: TenantRuntimeScope, panelId: string): boolean {
    return scope.panelState.panels.some((panel) => panel.id === panelId);
  }

  private panelMcpToolSignature(scope: TenantRuntimeScope): string {
    return scope.panelState.panels
      .map((panel) => panel.id)
      .filter((panelId) => panelId === "terminal" || panelId === "ide" || panelId === "browser")
      .sort()
      .join(",");
  }

  private nativeMcpRuntimeClient(scope: TenantRuntimeScope): RuntimeClient {
    return {
      auth: scope.context,
      id: "agui-native-mcp",
      isDestroyed: () => false,
      send: (channel, payload) => this.broadcastTenant(scope, channel, payload),
    };
  }

  private currentRuntimeInfo(): RuntimeInfo {
    const info = typeof this.runtimeInfo === "function" ? this.runtimeInfo() : this.runtimeInfo;
    return (
      info ?? {
        platform: process.platform,
        versions: { node: process.versions.node },
        features: {
          filePathAccess: false,
          nativeDialogs: false,
          webview: false,
          webContentsView: false,
          browserAutomation: false,
        },
      }
    );
  }

  private async chooseWorkspace(
    scope: TenantRuntimeScope,
    initialPath?: string,
  ): Promise<string | null> {
    if (this.workspaceChoose) {
      const chosen = await this.workspaceChoose(initialPath);
      return chosen ? this.safeServerWorkspaceDirectory(scope, chosen) : null;
    }
    if (!initialPath?.trim()) return null;
    return this.safeServerWorkspaceDirectory(scope, initialPath);
  }

  private listWorkspaceDirectories(
    scope: TenantRuntimeScope,
    inputPath?: string,
  ): WorkspaceDirectoryListing {
    const roots = this.allowedWorkspaceRoots(scope);
    if (!roots.length) throw new Error("No server workspace roots are available.");
    const pathForListing = inputPath?.trim()
      ? inputPath
      : (roots.find((root) => isPathInside(root, this.defaultWorkspace)) ?? roots[0]!);
    const directory = this.safeServerWorkspaceDirectory(scope, pathForListing);
    const entries = readWorkspaceDirectories(directory);
    const containingRoot = roots.find((root) => isPathInside(root, directory));
    const parentPath =
      containingRoot && directory !== containingRoot ? path.dirname(directory) : null;
    return {
      entries,
      parentPath:
        parentPath && isPathInside(containingRoot ?? directory, parentPath) ? parentPath : null,
      path: directory,
      roots: roots.map(workspaceDirectoryEntry),
    };
  }

  private safeServerWorkspaceDirectory(scope: TenantRuntimeScope, value: string): string {
    let directory: string;
    try {
      directory = fs.realpathSync(path.resolve(value));
      if (!fs.statSync(directory).isDirectory()) throw new Error("Not a directory.");
    } catch {
      throw new Error("Workspace path does not exist or is not a directory.");
    }
    if (!this.allowedWorkspaceRoots(scope).some((root) => isPathInside(root, directory))) {
      throw new Error("Workspace path is outside the server workspace roots.");
    }
    return directory;
  }

  private allowedWorkspaceRoots(scope: TenantRuntimeScope): string[] {
    const configured = this.configuredWorkspaceRootsForScope(scope);
    const fallbackRoot = isSessionAuthMode(scope.context.mode)
      ? path.join(scope.userDataPath(), "workspaces")
      : this.defaultWorkspace;
    if (isSessionAuthMode(scope.context.mode)) fs.mkdirSync(fallbackRoot, { recursive: true });
    const candidates = configured.length ? configured : [fallbackRoot, this.defaultWorkspace];
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const candidate of candidates) {
      try {
        const root = fs.realpathSync(path.resolve(candidate));
        if (!fs.statSync(root).isDirectory()) continue;
        const key = process.platform === "win32" ? root.toLowerCase() : root;
        if (seen.has(key)) continue;
        seen.add(key);
        roots.push(root);
      } catch {
        // Ignore unavailable configured roots.
      }
    }
    return roots;
  }

  private configuredWorkspaceRootsForScope(scope: TenantRuntimeScope): string[] {
    const raw = this.env.AG_UI_TENANT_WORKSPACE_ROOTS ?? this.env.AGUI_TENANT_WORKSPACE_ROOTS ?? "";
    if (isSessionAuthMode(scope.context.mode) && !raw.trim()) return [];
    const templates = raw
      ? raw
          .split(path.delimiter)
          .map((item) => item.trim())
          .filter(Boolean)
      : configuredWorkspaceRoots(this.workspaceRoots, this.env);
    return templates.map((template) => this.expandTenantTemplate(scope, template));
  }

  private expandTenantTemplate(scope: TenantRuntimeScope, value: string): string {
    const emailDomain = scope.context.user.email?.split("@").pop() ?? "";
    return value
      .replace(/\{tenant\}/g, scope.context.tenantKey)
      .replace(/\{tenantId\}/g, scope.context.tenantId)
      .replace(/\{user\}/g, safePathSegment(scope.context.user.id) || "user")
      .replace(/\{userId\}/g, safePathSegment(scope.context.user.id) || "user")
      .replace(/\{emailDomain\}/g, emailDomain);
  }

  private defaultWorkspaceForScope(scope: TenantRuntimeScope): string {
    const roots = this.allowedWorkspaceRoots(scope);
    return (
      roots.find((root) => isPathInside(root, this.defaultWorkspace)) ??
      roots[0] ??
      this.defaultWorkspace
    );
  }

  private safeWorkspacePathOrDefault(scope: TenantRuntimeScope, value: unknown): string {
    const pathValue = typeof value === "string" ? value.trim() : "";
    return pathValue
      ? this.safeServerWorkspaceDirectory(scope, pathValue)
      : this.defaultWorkspaceForScope(scope);
  }

  private safeTranscriptPath(scope: TenantRuntimeScope, value: unknown): string | undefined {
    const pathValue = typeof value === "string" ? value.trim() : "";
    return pathValue ? this.safeIdePathForScope(scope, pathValue) : undefined;
  }

  private safeIdeRootForScope(scope: TenantRuntimeScope, value?: string): string {
    return safeIdeRoot(this.safeServerWorkspaceDirectory(scope, String(value ?? "")));
  }

  private safeIdePathForScope(scope: TenantRuntimeScope, value: string): string {
    const resolved = path.resolve(value);
    const root = this.allowedWorkspaceRoots(scope).find((candidate) =>
      isPathInside(candidate, resolved),
    );
    if (!root) {
      throw new Error("File is outside the server workspace roots.");
    }
    return safeIdePath(root, resolved);
  }

  private safeTerminalInput<T extends { cwd?: string }>(scope: TenantRuntimeScope, input: T): T {
    return {
      ...input,
      cwd: this.safeWorkspacePathOrDefault(scope, input.cwd),
    };
  }

  private safeRunInput(scope: TenantRuntimeScope, input: RunInput): RunInput {
    return {
      ...input,
      cwd: this.safeWorkspacePathOrDefault(scope, input.cwd),
    };
  }

  private safeScheduledTaskInput(
    scope: TenantRuntimeScope,
    input: ScheduledTaskInput,
  ): ScheduledTaskInput {
    return {
      ...input,
      cwd: input?.cwd ? this.safeServerWorkspaceDirectory(scope, input.cwd) : input?.cwd,
      projectPath: input?.projectPath
        ? this.safeServerWorkspaceDirectory(scope, input.projectPath)
        : input?.projectPath,
      workspaceId: this.tenantWorkspaceId(scope, input?.workspaceId),
    };
  }

  private tenantWorkspaceId(scope: TenantRuntimeScope, workspaceId?: string): string {
    const normalized = extensionMcpGatewayWorkspaceId(workspaceId);
    return `${scope.key}:${normalized || "default"}`;
  }

  private invokeIdeDiagnostics(
    scope: TenantRuntimeScope,
    input: {
      root?: string;
      filePath?: string;
      content?: string;
    },
  ): Promise<unknown> | unknown {
    if (!this.ide.diagnostics) return [];
    const root = this.safeIdeRootForScope(scope, input?.root);
    const filePath = safeIdePath(root, input?.filePath);
    const content = String(input?.content ?? "");
    if (Buffer.byteLength(content, "utf8") > IDE_FILE_MAX_BYTES) return [];
    return this.ide.diagnostics({ root, filePath, content });
  }

  private invokeIdeWorkspaceDiagnostics(
    scope: TenantRuntimeScope,
    input: { root?: string },
  ): Promise<unknown> | unknown {
    if (!this.ide.workspaceDiagnostics) return [];
    return this.ide.workspaceDiagnostics({ root: this.safeIdeRootForScope(scope, input?.root) });
  }

  private invokeIdeSemanticTokens(
    scope: TenantRuntimeScope,
    input: {
      root?: string;
      filePath?: string;
      content?: string;
    },
  ): Promise<unknown> | unknown {
    if (!this.ide.semanticTokens) return { data: [] };
    const root = this.safeIdeRootForScope(scope, input?.root);
    const filePath = safeIdePath(root, input?.filePath);
    const content = String(input?.content ?? "");
    if (Buffer.byteLength(content, "utf8") > IDE_FILE_MAX_BYTES) return { data: [] };
    return this.ide.semanticTokens({ root, filePath, content });
  }

  private invokeBrowserMethod(
    method: string,
    params: unknown,
    client: RuntimeClient,
  ): Promise<unknown> | unknown {
    if (this.browserMethod) return this.browserMethod(method, params, client);
    if (method === "browser.list") return [];
    if (method === "browser.unregister") return false;
    if (method === "browser.releaseFocus") return true;
    throw new Error("Browser automation is only available in the Electron runtime.");
  }

  private invokeExtensionMethod(
    method: string,
    params: unknown,
    client: RuntimeClient,
  ): Promise<unknown> | unknown {
    if (this.extensionMethod) return this.extensionMethod(method, params, client);
    if (method === "extensions.list") return [];
    if (method === "extensions.audit") return [];
    if (method === "extensions.marketplace") return { items: [], sources: [], warnings: [] };
    if (method === "extensions.chooseInstall" || method === "extensions.chooseUpdate") return null;
    if (
      method === "extensions.workspaceTrusted" ||
      method === "extensions.setWorkspaceTrust" ||
      method === "extensions.uninstall"
    ) {
      return false;
    }
    if (method === "extensions.resolveAgent") {
      return { extensionIds: [], mcpServers: [], skills: [], prompts: [], warnings: [] };
    }
    if (method === "extensions.getConfiguration" || method === "extensions.updateConfiguration") {
      return { values: {}, configuredSecrets: [] };
    }
    throw new Error("Extension management is only available in the Electron runtime.");
  }

  private scopeExtensionParams(scope: TenantRuntimeScope, params: unknown): unknown {
    if (!params || typeof params !== "object" || Array.isArray(params)) return params;
    const value = params as Record<string, unknown>;
    const workspacePath =
      typeof value.workspacePath === "string" && value.workspacePath.trim()
        ? this.safeServerWorkspaceDirectory(scope, value.workspacePath)
        : value.workspacePath;
    return {
      ...value,
      workspaceId: this.tenantWorkspaceId(scope, String(value.workspaceId ?? "")),
      workspacePath,
    };
  }

  private privateSessionsRoot(scope: TenantRuntimeScope): string {
    return path.join(scope.userDataPath(), "private-sessions");
  }

  private ensurePrivateSessionDirectory(
    scope: TenantRuntimeScope,
    sessionId: string,
    createdAt?: number,
  ): string {
    const date = dateStamp(createdAt);
    const safeSessionId = safePathSegment(sessionId) || "session";
    const directory = path.join(this.privateSessionsRoot(scope), date, safeSessionId);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  private webSocketRuntimeClient(socket: WebSocket, auth: RuntimeAuthContext): RuntimeClient {
    const id = `ws:${this.nextRuntimeClientId++}`;
    const client: RuntimeClient = {
      auth,
      id,
      isDestroyed: () => socket.readyState !== WS_OPEN,
      send: (channel, payload) => {
        if (socket.readyState !== WS_OPEN) return;
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: channel, params: payload }));
      },
      sendJsonRpc: (message) => {
        if (socket.readyState !== WS_OPEN) return;
        socket.send(JSON.stringify(message));
      },
    };
    this.socketClients.set(socket, client);
    return client;
  }

  private async handleJsonRpcMessage(data: RawData, client: RuntimeClient): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch (error) {
      client.send("jsonrpc:error", rpcError(-32700, "Parse error", formatRuntimeError(error)));
      return;
    }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      sendJsonRpcResponse(client, message?.id, undefined, rpcError(-32600, "Invalid Request"));
      return;
    }
    try {
      const result = await this.invokeRuntimeMethod(message.method, message.params, client);
      sendJsonRpcResponse(client, message.id, result);
    } catch (error) {
      sendJsonRpcResponse(
        client,
        message.id,
        undefined,
        rpcError(-32000, formatRuntimeError(error)),
      );
    }
  }

  private authenticateRuntimeRpcConnection(
    request: http.IncomingMessage,
  ): RuntimeAuthContext | null {
    if (!this.isAllowedRuntimeRpcOrigin(request)) return null;
    if (isSessionAuthMode(this.auth.mode)) return this.auth.authenticateWebSocket(request);
    if (this.auth.mode === "disabled") return this.auth.defaultContext();
    if (!this.isAllowedRuntimeRpcConnection(request)) return null;
    return this.auth.defaultContext();
  }

  private isAllowedRuntimeRpcConnection(request: http.IncomingMessage): boolean {
    const requestUrl = new URL(request.url ?? "/agui-rpc", "ws://127.0.0.1");
    const authorization = String(request.headers.authorization ?? "");
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const queryToken = requestUrl.searchParams.get("token");
    if (queryToken && !isLoopbackRemoteAddress(request.socket.remoteAddress)) return false;
    const supplied = queryToken ?? bearer;
    if (!safeTokenEqual(supplied, this.token)) return false;
    return true;
  }

  private isAllowedRuntimeRpcOrigin(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return isLocalhostName(parsed.hostname) || parsed.hostname === requestHostName(request);
    } catch {
      return false;
    }
  }
}

function sendJsonRpcResponse(
  client: RuntimeClient,
  id: JsonRpcMessage["id"],
  result?: unknown,
  error?: JsonRpcError,
): void {
  if (id === undefined || client.isDestroyed()) return;
  const response = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  client.sendJsonRpc?.(response);
}

function createScopedStorage(storage: AppStorage, tenantKeyValue: string): AppStorage {
  const prefix = `tenant:${tenantKeyValue}:`;
  const scopedNamespace = (namespace?: string) => `${prefix}${namespace || "app"}`;
  const unscopedNamespace = (namespace: string) =>
    namespace.startsWith(prefix) ? namespace.slice(prefix.length) : namespace;
  return {
    backend: storage.backend,
    close: () => storage.close(),
    get: (input) => storage.get({ ...input, namespace: scopedNamespace(input.namespace) }),
    list: async (input) =>
      (
        await storage.list({
          ...input,
          namespace: scopedNamespace(input?.namespace),
        })
      ).map((record) => ({
        ...record,
        namespace: unscopedNamespace(record.namespace),
      })),
    remove: (input) => storage.remove({ ...input, namespace: scopedNamespace(input.namespace) }),
    set: (input) => storage.set({ ...input, namespace: scopedNamespace(input.namespace) }),
  };
}

function scopedSqlitePath(
  configuredPath: string | undefined,
  userDataPath: () => string,
): string | undefined {
  if (!configuredPath?.trim()) return undefined;
  const parsed = path.parse(path.resolve(configuredPath));
  return path.join(userDataPath(), `${parsed.name}${parsed.ext || ".sqlite3"}`);
}

function normalizeTenantRegistryRecord(value: unknown): TenantRegistryRecord | null {
  const source = record(value);
  const tenantId = stringValue(source.tenantId);
  const tenantKeyValue = stringValue(source.tenantKey);
  if (!tenantId || !tenantKeyValue) return null;
  return {
    tenantId,
    tenantKey: tenantKeyValue,
    updatedAt: finiteNumber(source.updatedAt) ?? Date.now(),
  };
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function rpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return data === undefined ? { code, message } : { code, message, data };
}

function runtimeRpcPort(env: NodeJS.ProcessEnv): number {
  const raw =
    env.AG_UI_WEB_PORT ?? env.AGUI_WEB_PORT ?? env.AG_UI_RPC_PORT ?? env.AGUI_RPC_PORT ?? "17371";
  return runtimeRpcPortValue(raw);
}

function runtimeRpcPortValue(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 65535 ? number : 17371;
}

function runtimeRpcHost(value: unknown): string {
  const host = String(value ?? "").trim();
  return host || "127.0.0.1";
}

function runtimeRpcToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = String(env.AG_UI_RPC_TOKEN ?? env.AGUI_RPC_TOKEN ?? "").trim();
  return token || undefined;
}

function isSessionAuthMode(mode: RuntimeAuthContext["mode"]): boolean {
  return mode === "webauth" || mode === "oauth";
}

function safeTokenEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateMcpGatewayStartupSettings(
  settings: McpGatewayRuntimeSettings,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!settings.enabled) return undefined;
  return validateMcpGatewayResolveModel(settings.llm, env);
}

function validateMcpGatewayResolveModel(
  llm: McpGatewayRuntimeSettings["llm"],
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (llm.enabled === false) {
    return "MCP Gateway requires Resolve model to be enabled before startup.";
  }
  if (!llm.model?.trim()) {
    return "MCP Gateway requires a Resolve model name before startup.";
  }
  if (!llm.apiKey?.trim() && !env.OPENAI_API_KEY?.trim()) {
    return "MCP Gateway requires a Resolve model API key before startup.";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function emptyPanelState(): AguiPanelRuntimeState {
  return {
    detailPanelOpen: false,
    panels: [],
    tabs: [],
    updatedAt: 0,
  };
}

function normalizePanelState(input: unknown, ide?: AguiIdePanelState): AguiPanelRuntimeState {
  const value = record(input);
  return {
    activeDetailPanelId: stringValue(value.activeDetailPanelId) || null,
    activeDetailPanelTabId: stringValue(value.activeDetailPanelTabId) || null,
    detailPanelOpen: value.detailPanelOpen === true,
    ide,
    panels: arrayValue(value.panels)
      .map(normalizePanelSummary)
      .filter((panel): panel is NonNullable<ReturnType<typeof normalizePanelSummary>> =>
        Boolean(panel),
      )
      .slice(0, PANEL_STATE_MAX_ITEMS),
    project: normalizePanelProject(value.project),
    tabs: arrayValue(value.tabs)
      .map(normalizePanelTab)
      .filter((tab): tab is NonNullable<ReturnType<typeof normalizePanelTab>> => Boolean(tab))
      .slice(0, PANEL_STATE_MAX_ITEMS),
    updatedAt: finiteNumber(value.updatedAt) || Date.now(),
  };
}

function normalizePanelSummary(input: unknown): AguiPanelRuntimeState["panels"][number] | null {
  const value = record(input);
  const id = stringValue(value.id).slice(0, 256);
  if (!id) return null;
  return {
    allowMultiple: value.allowMultiple === true,
    id,
    order: finiteNumber(value.order),
    title: (stringValue(value.title) || id).slice(0, 1_024),
  };
}

function normalizePanelTab(input: unknown): AguiPanelRuntimeState["tabs"][number] | null {
  const value = record(input);
  const id = stringValue(value.id).slice(0, 512);
  const panelId = stringValue(value.panelId).slice(0, 256);
  if (!id || !panelId) return null;
  return {
    active: value.active === true,
    createdAt: finiteNumber(value.createdAt),
    id,
    ordinal: finiteNumber(value.ordinal),
    panelId,
    title: optionalText(value.title, 1_024),
  };
}

function normalizePanelProject(input: unknown): AguiPanelRuntimeState["project"] {
  const value = record(input);
  const root = stringValue(value.root);
  const workspaceId = stringValue(value.workspaceId);
  return root || workspaceId
    ? {
        root: root || undefined,
        workspaceId: workspaceId || undefined,
      }
    : undefined;
}

function normalizeIdePanelState(input: unknown): AguiIdePanelState {
  const value = record(input);
  return {
    activeContent: optionalText(value.activeContent, PANEL_TEXT_MAX_CHARS),
    activePath: stringValue(value.activePath) || null,
    root: stringValue(value.root) || undefined,
    tabs: arrayValue(value.tabs)
      .map(normalizeIdePanelTab)
      .filter((tab): tab is NonNullable<ReturnType<typeof normalizeIdePanelTab>> => Boolean(tab))
      .slice(0, PANEL_STATE_MAX_ITEMS),
    updatedAt: finiteNumber(value.updatedAt) || Date.now(),
  };
}

function normalizeIdePanelTab(input: unknown): AguiIdePanelState["tabs"][number] | null {
  const value = record(input);
  const filePath = stringValue(value.path);
  if (!filePath) return null;
  return {
    diagnostics: arrayValue(value.diagnostics).slice(0, 500),
    diagnosticsLoading: value.diagnosticsLoading === true,
    dirty: value.dirty === true,
    error: optionalText(value.error, 8_192),
    language: optionalText(value.language, 256),
    mtimeMs: finiteNumber(value.mtimeMs),
    name: optionalText(value.name, 1_024),
    path: filePath,
  };
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  const text = stringValue(value);
  return text ? text.slice(0, maxLength) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeRuntimeMcpGatewayServer(
  input: Partial<McpGatewayRuntimeSettings["servers"][number]>,
): McpGatewayRuntimeSettings["servers"][number] {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) {
    throw new Error(
      "MCP Gateway server id must start with a letter or number and contain only letters, numbers, underscores, or dashes.",
    );
  }
  const type = input.type === "stdio" || input.type === "sse" ? input.type : "http";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (type === "http" || type === "sse") {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("MCP Gateway HTTP/SSE server requires an http:// or https:// URL.");
    }
  } else if (!command) {
    throw new Error("MCP Gateway stdio server requires a launch command.");
  }
  return {
    args: stringArray(input.args),
    authentication: normalizeRuntimeMcpGatewayAuthentication(input.authentication),
    command: type === "stdio" ? command : undefined,
    enabled: input.enabled !== false,
    env: stringRecord(input.env),
    headers: stringRecord(input.headers),
    id,
    label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : id,
    type,
    url: type === "stdio" ? undefined : url,
  };
}

function normalizeRuntimeMcpGatewayAuthentication(
  value: unknown,
): McpGatewayRuntimeSettings["servers"][number]["authentication"] {
  const record = isRecord(value) ? value : {};
  if (record.type === "bearer") {
    const token = typeof record.token === "string" ? record.token : "";
    return token ? { type: "bearer", token } : undefined;
  }
  if (record.type === "api-key") {
    const headerName =
      typeof record.headerName === "string" && record.headerName.trim()
        ? record.headerName.trim()
        : "X-API-Key";
    const value = typeof record.value === "string" ? record.value : "";
    return value ? { type: "api-key", headerName, value } : undefined;
  }
  if (record.type === "basic") {
    const username = typeof record.username === "string" ? record.username : "";
    const password = typeof record.password === "string" ? record.password : "";
    return username ? { type: "basic", username, password } : undefined;
  }
  return undefined;
}

function appendDeveloperInstructions(existing: string | undefined, addition: string): string {
  const current = existing?.trim();
  return current ? `${current}\n\n${addition}` : addition;
}

export function mcpGatewayAgentDeveloperInstructions(): string {
  return [
    "MCP Gateway provides the interface to gateway-managed connected MCP services in this run without exposing their catalogs.",
    "If a task may require external, private, connected-service, or real-time data, or an action outside the local workspace, call code_tool.resolve before answering or taking action.",
    "The user does not need to mention MCP Gateway or a service name.",
    "Do not call it for tasks answerable entirely from the conversation or local workspace.",
    "If resolve returns matched=false, continue without MCP Gateway and do not retry unless the task or available services change.",
  ].join(" ");
}

export function injectMcpGatewayRunInput(
  input: RunInput,
  gatewayServer: AspMcpServerRef,
): RunInput {
  return {
    ...input,
    additionalDeveloperInstructions: appendDeveloperInstructions(
      input.additionalDeveloperInstructions,
      mcpGatewayAgentDeveloperInstructions(),
    ),
    mcpServers: [gatewayServer],
  };
}

export function mcpGatewayStdioBridgeServer(
  address: McpGatewayStdioSocketAddress,
  sessionId: string,
): AspMcpServerRef {
  return {
    args: [mcpGatewayStdioBridgePath()],
    command: process.execPath,
    env: {
      AGUI_MCP_GATEWAY_SESSION_ID: sessionId || "default",
      AGUI_MCP_GATEWAY_SOCKET: address.socketPath,
      AGUI_MCP_GATEWAY_TOKEN: address.token,
      ELECTRON_RUN_AS_NODE: "1",
    },
    id: MCP_GATEWAY_SERVER_ID,
    metadata: {
      gateway: true,
      source: "agui.mcpGateway",
    },
    name: "MCP Gateway",
    type: "stdio",
  };
}

function mcpGatewayStdioBridgePath(): string {
  return fileURLToPath(new URL("./mcp-gateway/stdio-bridge.js", import.meta.url));
}

function mcpGatewayServersFromRun(value: RunInput["mcpServers"]): McpGatewayServerConfig[] {
  const entries: Array<[string, Record<string, unknown>]> = Array.isArray(value)
    ? value.map((item, index) => {
        const server = record(item);
        return [
          stringValue(server.id) || stringValue(server.name) || `server_${index + 1}`,
          server,
        ];
      })
    : Object.entries(record(value)).map(([id, server]) => [id, record(server)]);
  return entries.flatMap(([rawId, server]) => {
    const id = safeMcpGatewayServerId(stringValue(rawId) || stringValue(server.id));
    if (!id || id === MCP_GATEWAY_SERVER_ID) return [];
    const command = stringValue(server.command);
    const url = stringValue(server.url);
    if (!command && !url) return [];
    const type =
      command && !url ? "stdio" : mcpGatewayTransportType(server.type ?? server.transport);
    return [
      {
        args: stringArray(server.args),
        authentication: normalizeRuntimeMcpGatewayAuthentication(server.authentication),
        command: command || undefined,
        env: stringRecord(server.env),
        headers: stringRecord(server.headers),
        id,
        label: stringValue(server.name) || stringValue(server.label) || id,
        type,
        url: url || undefined,
      } satisfies McpGatewayServerConfig,
    ];
  });
}

function extensionMcpGatewayMetadataById(value: unknown): Map<string, { extensionId?: string }> {
  const entries: Array<[string, Record<string, unknown>]> = Array.isArray(value)
    ? value.map((item, index) => {
        const server = record(item);
        return [
          stringValue(server.id) || stringValue(server.name) || `server_${index + 1}`,
          server,
        ];
      })
    : Object.entries(record(value)).map(([id, server]) => [id, record(server)]);
  const metadataById = new Map<string, { extensionId?: string }>();
  for (const [rawId, server] of entries) {
    const id = safeMcpGatewayServerId(stringValue(rawId) || stringValue(server.id));
    if (!id) continue;
    const metadata = record(server.metadata);
    metadataById.set(id, {
      extensionId: stringValue(server.extensionId) || stringValue(metadata.sourceExtensionId),
    });
  }
  return metadataById;
}

function extensionMcpGatewayWorkspaceId(value: unknown): string {
  const workspaceId = stringValue(value);
  return workspaceId === "default" ? "" : workspaceId;
}

function extensionMcpGatewayScopeKey(workspacePath: string, workspaceId: string): string {
  return `extension:${workspaceId || "default"}:${workspacePath}`;
}

function mcpGatewayTransportType(value: unknown): NonNullable<McpGatewayServerConfig["type"]> {
  const normalized = stringValue(value)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "streamablehttp") return "http";
  if (normalized === "http" || normalized === "sse" || normalized === "stdio") return normalized;
  return "http";
}

function safeMcpGatewayServerId(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  if (!normalized) return "";
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : `mcp_${normalized}`.slice(0, 96);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
      return typeof entry[1] === "string" && Boolean(entry[0].trim());
    }),
  );
}

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requestHostName(request: http.IncomingMessage): string | null {
  const host = request.headers.host;
  if (!host) return null;
  try {
    return new URL(`ws://${host}`).hostname;
  } catch {
    return host.split(":")[0] || null;
  }
}

function isLocalRuntimePageRequest(request: http.IncomingMessage): boolean {
  const hostname = requestHostName(request);
  return (
    isLoopbackRemoteAddress(request.socket.remoteAddress) &&
    (!hostname || isLocalhostName(hostname))
  );
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  const normalized = String(address ?? "")
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function isLocalhostName(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}

function dateStamp(value?: number): string {
  const date = Number.isFinite(value) ? new Date(value!) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function configuredPathGetter(value?: string | (() => string), fallback?: string): () => string {
  return () =>
    path.resolve(typeof value === "function" ? value() : value || fallback || os.homedir());
}

function configuredHomeDir(value?: string | (() => string)): string {
  return path.resolve(typeof value === "function" ? value() : value || os.homedir());
}

function configuredOptionalPath(value?: string | (() => string)): string | undefined {
  const resolved = typeof value === "function" ? value() : value;
  if (!resolved?.trim()) return undefined;
  return path.resolve(resolved.trim());
}

function errorFromWorkerPayload(payload: {
  message: string;
  name?: string;
  stack?: string;
}): Error {
  const error = new Error(payload.message);
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  return error;
}

export { NodeRuntimeServer as AguiRuntime };
