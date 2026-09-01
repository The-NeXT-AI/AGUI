import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  connectAspTransport,
  disposePersistentTransports,
  processEnvironment,
} from "@the-next-ai/asp/transport";
import { AspManager } from "@the-next-ai/asp/manager";
import { ProviderStore } from "@the-next-ai/asp/provider-store";
import {
  assertAspClientMessage,
  assertAspClientServiceRequest,
  assertAspCoreEvent,
  assertAspEnvelope,
  assertAspExtensionDescriptor,
  assertAspExtensionEvent,
  assertAspRpcResponse,
  assertJsonSchemaValue,
  aspV1JsonSchema,
} from "@the-next-ai/asp";
import {
  browserMcpProviderId,
  createBrowserMcpToolProvider,
  createMcpGatewayStdioSocketServer,
  McpGateway,
  detectAgentCliProviders,
  injectMcpGatewayRunInput,
  mcpGatewayAgentDeveloperInstructions,
  mcpGatewayScopeArgumentName,
  mcpGatewayStdioBridgeServer,
  parseRuntimeMethodParams,
} from "@the-next-ai/agui-runtime";
import {
  abortMessage,
  extensionInvokeMessage,
  getAspEvent,
  initializeMessage,
  normalizeSessionState,
  normalizeToolEvent,
  normalizeUsage,
  requestMessage,
  rpcApprovalResult,
  rpcErrorMessage,
  rpcQuestionResult,
  runMessage,
} from "@the-next-ai/asp/protocol";
import { runNativeAdapterSmoke, transportResponse } from "./asp-smoke-native.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const mcpAppsExtension = {
  id: "asp.ext.mcp-apps",
  version: "0.1.0",
  stability: "experimental",
  fallback: "core",
  methods: [
    { name: "resources/read", requiresRun: true, safety: "read" },
    { name: "tools/call", requiresRun: true, safety: "write" },
  ],
};
const provider = {
  id: "fake-asp",
  name: "Fake ASP",
  command: process.execPath,
  args: [path.join(directory, "fake-asp-agent.mjs")],
  env: {},
  enabled: true,
  transport: "stdio",
  capabilities: {
    extensions: [mcpAppsExtension],
  },
};
const headlessHistoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agui-headless-history-"));
const grokHistoryRoot = path.join(headlessHistoryRoot, "grok");
const grokHomeRoot = path.join(headlessHistoryRoot, "grok-home");
const kimiHistoryRoot = path.join(headlessHistoryRoot, "kimi");
const kimiHomeRoot = path.join(headlessHistoryRoot, "kimi-home");
writeHeadlessHistoryFixture({
  kind: "grok",
  root: grokHistoryRoot,
  sessionId: "grok-native-session",
  title: "Grok generated smoke",
  text: "Grok CLI OK",
});
writeHeadlessHistoryFixture({
  kind: "kimi",
  root: kimiHistoryRoot,
  sessionId: "kimi-native-session",
  title: "Kimi generated smoke",
  text: "Kimi CLI OK",
});
process.on("exit", () => {
  fs.rmSync(headlessHistoryRoot, { force: true, recursive: true });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeHeadlessHistoryFixture({ kind, root, sessionId, title, text }) {
  const directoryPath = path.join(root, encodeURIComponent(process.cwd()), sessionId);
  const now = new Date().toISOString();
  fs.mkdirSync(directoryPath, { recursive: true });
  if (kind === "grok") {
    fs.writeFileSync(
      path.join(directoryPath, "summary.json"),
      `${JSON.stringify(
        {
          info: {
            id: sessionId,
            cwd: process.cwd(),
          },
          session_summary: title,
          created_at: now,
          updated_at: now,
          current_model_id: "native-test",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(directoryPath, "chat_history.jsonl"),
      [
        {
          type: "user",
          content: [{ type: "text", text: "Native adapter smoke" }],
          created_at: now,
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text }] },
          created_at: now,
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      "utf8",
    );
    return;
  }
  fs.writeFileSync(
    path.join(directoryPath, "state.json"),
    `${JSON.stringify(
      {
        createdAt: now,
        updatedAt: now,
        title,
        workDir: process.cwd(),
        lastPrompt: "Native adapter smoke",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const wireDirectory = path.join(directoryPath, "agents", "main");
  fs.mkdirSync(wireDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(wireDirectory, "wire.jsonl"),
    [
      {
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Native adapter smoke" }],
          origin: { kind: "user" },
        },
        time: Date.now(),
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text } },
        time: Date.now(),
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
    "utf8",
  );
}

function runAgentCliDetectionSmoke() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agui-agent-detect-"));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    const binDir = path.join(tempRoot, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const codexPath = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    fs.writeFileSync(
      codexPath,
      process.platform === "win32"
        ? "@echo off\r\necho codex 9.8.7\r\n"
        : "#!/bin/sh\necho codex 9.8.7\n",
      "utf8",
    );
    fs.chmodSync(codexPath, 0o755);
    const detected = detectAgentCliProviders({
      PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    });
    const codex = detected.find((item) => item.id === "codex");
    assert.equal(codex?.path, codexPath);
    assert.equal(codex?.version, "codex 9.8.7");
    const brokenPath = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    fs.writeFileSync(
      brokenPath,
      process.platform === "win32"
        ? "@echo off\r\necho Error: missing native binary 1>&2\r\nexit /b 1\r\n"
        : "#!/bin/sh\necho 'Error: missing native binary' >&2\nexit 1\n",
      "utf8",
    );
    fs.chmodSync(brokenPath, 0o755);
    const detectedWithBroken = detectAgentCliProviders({
      PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    });
    const claude = detectedWithBroken.find((item) => item.id === "claude-code");
    assert.equal(claude?.path, brokenPath);
    assert.equal(claude?.version, undefined);
    assert.match(claude?.error ?? "", /missing native binary/);

    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    const grokBinDir = path.join(tempRoot, ".grok", "bin");
    const kimiBinDir = path.join(tempRoot, ".kimi-code", "bin");
    fs.mkdirSync(grokBinDir, { recursive: true });
    fs.mkdirSync(kimiBinDir, { recursive: true });
    const grokPath = path.join(grokBinDir, process.platform === "win32" ? "grok.cmd" : "grok");
    const kimiPath = path.join(kimiBinDir, process.platform === "win32" ? "kimi.cmd" : "kimi");
    fs.writeFileSync(
      grokPath,
      process.platform === "win32"
        ? "@echo off\r\necho grok 1.2.3\r\n"
        : "#!/bin/sh\necho grok 1.2.3\n",
      "utf8",
    );
    fs.writeFileSync(
      kimiPath,
      process.platform === "win32"
        ? "@echo off\r\necho kimi 4.5.6\r\n"
        : "#!/bin/sh\necho kimi 4.5.6\n",
      "utf8",
    );
    fs.chmodSync(grokPath, 0o755);
    fs.chmodSync(kimiPath, 0o755);
    const detectedFromHomeBins = detectAgentCliProviders({ PATH: "" });
    assert.equal(detectedFromHomeBins.find((item) => item.id === "grok")?.path, grokPath);
    assert.equal(detectedFromHomeBins.find((item) => item.id === "kimi")?.path, kimiPath);

    process.env.PATH = "";
    const aspPath = processEnvironment().PATH ?? "";
    assert.ok(aspPath.split(path.delimiter).includes(grokBinDir));
    assert.ok(aspPath.split(path.delimiter).includes(kimiBinDir));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
  console.log("Agent CLI detection passed: command path and version OK.");
}

assert.doesNotThrow(() => assertAspExtensionDescriptor(mcpAppsExtension));
assert.throws(() =>
  assertAspClientMessage({
    asp: "agent-server-protocol",
    version: "1",
    type: "abort",
    runId: "",
  }),
);
assert.throws(() =>
  assertAspEnvelope({
    asp: "agent-server-protocol",
    version: "2",
  }),
);
assert.throws(() =>
  getAspEvent({
    asp: "agent-server-protocol",
    version: "2",
    type: "message_delta",
    runId: "schema-smoke",
    data: "wrong version",
  }),
);
assert.throws(() =>
  assertAspCoreEvent({
    type: "approval_request",
    runId: "schema-smoke",
    method: "",
  }),
);
assert.doesNotThrow(() =>
  assertAspCoreEvent({
    type: "question_request",
    runId: "schema-smoke",
    question: "Continue?",
  }),
);
assert.equal(
  normalizeToolEvent({
    id: "semantic-tool",
    kind: "commandExecution",
    name: "Semantic tool",
    phase: "completed",
    semantic: { toolType: "shell", resultKind: "text" },
  }).semantic?.toolType,
  "shell",
);
assert.equal(
  normalizeSessionState({
    providerSessionId: "checkpoint-session",
    checkpoints: [{ id: "checkpoint-1", title: "Before refactor" }],
  })?.checkpoints?.[0]?.id,
  "checkpoint-1",
);
assert.deepEqual(normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), {
  inputCachedTokens: 0,
  inputTokens: 0,
  outputCachedTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});
assert.throws(() =>
  assertAspCoreEvent({
    type: "message_delta",
    runId: "schema-smoke",
    data: 42,
  }),
);
assert.throws(() =>
  assertAspClientMessage({
    asp: "agent-server-protocol",
    version: "1",
    type: "capabilities",
    method: "list_models",
    id: "mismatched-request",
    providerId: "schema-smoke",
    clientCapabilities: {},
  }),
);
assert.throws(() =>
  assertAspExtensionEvent({
    extension: "vendor.schema-smoke",
    type: "extension_event",
    event: "schema-smoke",
    payload: { futureField: true },
  }),
);
assertAspClientServiceRequest({
  asp: "agent-server-protocol",
  jsonrpc: "2.0",
  version: "1",
  id: "client-read",
  method: "client.fs.read_text_file",
  params: { runId: "schema-smoke", path: "README.md" },
});
assertAspRpcResponse(
  rpcErrorMessage("schema-error", {
    code: -32602,
    message: "Invalid params",
    data: { method: "schema-smoke" },
  }),
);
assert.equal(initializeMessage("schema-provider").jsonrpc, "2.0");
assert.equal(abortMessage("schema-run").method, "run.cancel");
assertAspClientMessage({
  asp: "agent-server-protocol",
  jsonrpc: "2.0",
  version: "1",
  method: "run.cancel",
  params: { runId: "schema-run", reason: "No longer needed" },
});
assert.equal(aspV1JsonSchema().$schema, "https://json-schema.org/draft/2020-12/schema");
assertJsonSchemaValue(
  aspV1JsonSchema(),
  initializeMessage("schema-provider"),
  "generated ASP v1 schema",
);
assert.throws(() =>
  assertJsonSchemaValue(
    {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    {},
    "schema payload",
  ),
);
assert.deepEqual(
  parseRuntimeMethodParams("terminal.resize", { id: "schema-smoke", cols: 120, rows: 36 }),
  { id: "schema-smoke", cols: 120, rows: 36 },
);
assert.deepEqual(
  parseRuntimeMethodParams("sessions.usage", {
    providerId: "schema-provider",
    providerSessionId: "schema-session",
  }),
  { providerId: "schema-provider", providerSessionId: "schema-session" },
);
assert.deepEqual(
  parseRuntimeMethodParams("browserWorkflows.save", {
    title: "Schema smoke submit workflow",
    steps: [{ type: "submit", selector: "form" }],
  }),
  {
    title: "Schema smoke submit workflow",
    steps: [{ type: "submit", selector: "form" }],
  },
);
assert.deepEqual(
  parseRuntimeMethodParams("extensions.marketplace", {
    includePrerelease: true,
    limit: 3,
    query: "fixture",
    workspaceId: "",
  }),
  { includePrerelease: true, limit: 3, query: "fixture", workspaceId: "" },
);
assert.deepEqual(
  parseRuntimeMethodParams("extensions.install", {
    expectedSha256: "a".repeat(64),
    sourceUrl: "https://example.com/fixture.aguix",
    workspaceId: "",
  }),
  {
    expectedSha256: "a".repeat(64),
    sourceUrl: "https://example.com/fixture.aguix",
    workspaceId: "",
  },
);
assert.throws(() =>
  parseRuntimeMethodParams("terminal.run", {
    id: "schema-smoke",
    command: "printf smoke",
    unexpected: true,
  }),
);
console.log("ASP core and runtime method schema validation passed.");
runAgentCliDetectionSmoke();

const connection = await connectAspTransport({ provider, cwd: process.cwd() });
const events = [];
let capabilities;
let initialization;
let models;
let finished;
let stderr = "";

const completion = new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error(`ASP smoke test timed out.${stderr ? `\n${stderr}` : ""}`)),
    10_000,
  );
  connection.onStderr((chunk) => {
    stderr += chunk;
  });
  connection.onError(reject);
  connection.onMessage((message) => {
    events.push(message);
    if (message.id === "initialize") initialization = message.result;
    if (message.id === "capabilities") capabilities = message.result;
    if (message.id === "models") models = message.result?.models;
    if (message.method === "approval_request") {
      connection.send(rpcApprovalResult(message.id, "allow"));
    }
    if (message.method === "question_request") {
      connection.send(
        rpcQuestionResult(message.id, {
          answers: [{ questionId: "choice", question: "Result", answer: "OK" }],
        }),
      );
    }
    if (message.type === "run_finished") {
      clearTimeout(timeout);
      finished = message;
      resolve();
    }
  });
});

connection.send(initializeMessage(provider.id, "initialize"));
connection.send(requestMessage(provider.id, "capabilities", {}, "capabilities"));
connection.send(requestMessage(provider.id, "list_models", {}, "models"));
connection.send(
  runMessage(
    {
      uiSessionId: "ui-smoke",
      providerId: provider.id,
      cwd: process.cwd(),
      prompt: "Run the ASP smoke test",
      approvalMode: "suggest",
      model: "fake-asp",
      effort: "medium",
      speed: "default",
    },
    "run-smoke",
  ),
);

await completion;
const aspSessions = await transportResponse(
  connection,
  requestMessage(provider.id, "list_sessions", { cwd: process.cwd() }, "asp-sessions"),
  "asp-sessions",
  "generic-asp",
);
const aspCreatedSession = await transportResponse(
  connection,
  requestMessage(
    provider.id,
    "new_session",
    { cwd: process.cwd(), title: "Created from smoke" },
    "asp-new-session",
  ),
  "asp-new-session",
  "generic-asp",
);
const aspClosedSession = await transportResponse(
  connection,
  requestMessage(
    provider.id,
    "close_session",
    { providerSessionId: "fake-session-created" },
    "asp-close-session",
  ),
  "asp-close-session",
  "generic-asp",
);
const aspMessages = await transportResponse(
  connection,
  requestMessage(
    provider.id,
    "session_messages",
    { providerSessionId: "fake-session-1" },
    "asp-messages",
  ),
  "asp-messages",
  "generic-asp",
);
const aspResume = await transportResponse(
  connection,
  requestMessage(
    provider.id,
    "resume_session",
    { cwd: process.cwd(), providerSessionId: "fake-session-1" },
    "asp-resume",
  ),
  "asp-resume",
  "generic-asp",
);
const aspMcpResource = await transportResponse(
  connection,
  extensionInvokeMessage(
    {
      extension: "asp.ext.mcp-apps",
      method: "resources/read",
      runId: "run-smoke",
      payload: { server: "fixture", uri: "ui://fixture/pdf-viewer.html" },
    },
    "asp-mcp-resource",
  ),
  "asp-mcp-resource",
  "generic-asp",
);
const aspMcpTool = await transportResponse(
  connection,
  extensionInvokeMessage(
    {
      extension: "asp.ext.mcp-apps",
      method: "tools/call",
      runId: "run-smoke",
      payload: { server: "fixture", name: "extract_pdf_text", arguments: { page: 1 } },
    },
    "asp-mcp-tool",
  ),
  "asp-mcp-tool",
  "generic-asp",
);
connection.close();

assert.deepEqual(capabilities.protocolVersions, ["1"]);
assert.equal(initialization.protocolVersion, "1");
assert.ok(capabilities.extensions.some((extension) => extension.id === "asp.ext.run-control"));
assert.ok(
  capabilities.extensions
    .find((extension) => extension.id === "asp.ext.mcp-apps")
    ?.methods?.some((method) => method.name === "resources/read"),
);
assert.equal(capabilities.sessions, true);
assert.equal(capabilities.sessionHistory, true);
assert.equal(capabilities.resumeSession, true);
assert.equal(models[0].model, "fake-asp");
assert.equal(finished.success, true);
assert.equal(events.filter((event) => event.method === "approval_request").length, 1);
assert.equal(events.filter((event) => event.method === "question_request").length, 1);
assert.ok(events.some((event) => event.type === "message_part" && event.part.type === "reasoning"));
assert.ok(events.some((event) => event.type === "message_part" && event.part.type === "plan"));
assert.ok(events.some((event) => event.type === "message_part" && event.part.type === "diff"));
assert.ok(events.some((event) => event.type === "message_part" && event.part.type === "resource"));
assert.ok(events.some((event) => event.type === "message_part" && event.part.type === "artifact"));
assert.ok(events.some((event) => event.type === "message_part" && event.part.type === "raw"));
assert.ok(
  events.some(
    (event) => event.type === "session_state" && event.state?.title === "Fake ASP generated title",
  ),
);
assert.ok(
  events.some(
    (event) => event.type === "extension_event" && event.extension === "asp.ext.run-control",
  ),
);
assert.ok(
  events.some((event) => event.type === "tool_event" && event.toolEvent.phase === "completed"),
);
assert.ok(events.some((event) => event.type === "usage" && event.usage.totalTokens === 11));
assert.ok(aspSessions.result.sessions.some((session) => session.id === "fake-session-1"));
assert.equal(aspCreatedSession.result.session.status, "active");
assert.equal(aspClosedSession.result.closed, true);
assert.ok(aspMessages.result.messages.some((message) => message.content === "ASP smoke OK"));
assert.equal(aspResume.result.session.id, "fake-session-1");
assert.ok(aspResume.result.messages.some((message) => message.content === "ASP smoke OK"));
assert.match(aspMcpResource.result?.result?.contents?.[0]?.text || "", /Fixture PDF Viewer/);
assert.equal(aspMcpTool.result?.result?.structuredContent?.tool, "extract_pdf_text");

console.log(
  `Generic ASP compatibility passed: ${events.length} protocol messages, sessions, approval + question OK.`,
);

await runMcpAppManagerSmoke();
await runClientServiceManagerSmoke();
await runManagerCancelSmoke();
await runQuestionWaitTimeoutSmoke();
await runPendingInteractionReplaySmoke();
runMcpGatewayInjectionContractSmoke();
await runMcpGatewayStdioBridgeRoundTripSmoke();
await runMcpGatewayUserInputSmoke();
await runMcpGatewayResolveContractSmoke();
await runMcpGatewayLocalResolveFallbackSmoke();
await runMcpGatewayBrowserProviderSmoke();
await runPersistentStdioSmoke();
await runPersistentStdioIsolationSmoke();
await runClaudeAuthErrorManagerSmoke();
await runBuiltInProviderStoreSmoke();

await runNativeAdapterSmoke({
  id: "codex-native",
  command: path.join(directory, "fake-codex-app-server.mjs"),
  cwd: path.join(directory, "fixtures", "codex-workspace"),
  rawRunApprovalMode: "suggest",
  preserveNativeEvents: true,
  providerEnv: {
    AGUI_FAKE_CODEX_EXPECT_APPROVAL_POLICY: "untrusted",
    AGUI_FAKE_CODEX_EXPECT_SANDBOX_TYPE: "workspaceWrite",
  },
  runtimeAdapter: "codex-app-server",
  expectedApprovalRequests: 1,
  expectedExtensionEvents: ["asp.ext.session-state:state.updated"],
  expectedPartTypes: ["plan", "status", "reasoning", "diff"],
  expectedQuestionRequests: 1,
  expectedReasoningText: "Codex app-server reasoning details",
  expectedText: "Codex ASP OK",
  expectedTitle: "Codex generated smoke",
  expectedToolPhases: ["started", "updated", "completed"],
  expectedSession: "codex-native-session",
  exposesHistoryCapability: true,
});
await runNativeAdapterSmoke({
  id: "codex-native-auto",
  command: path.join(directory, "fake-codex-app-server.mjs"),
  cwd: path.join(directory, "fixtures", "codex-workspace"),
  approvalMode: "auto-edit",
  rawRunApprovalMode: "auto-edit",
  providerEnv: {
    AGUI_FAKE_CODEX_EXPECT_APPROVAL_POLICY: "on-request",
    AGUI_FAKE_CODEX_EXPECT_SANDBOX_TYPE: "workspaceWrite",
  },
  runtimeAdapter: "codex-app-server",
  expectedApprovalRequests: 1,
  expectedExtensionEvents: ["asp.ext.session-state:state.updated"],
  expectedPartTypes: ["plan", "status", "reasoning", "diff"],
  expectedQuestionRequests: 1,
  expectedReasoningText: "Codex app-server reasoning details",
  expectedText: "Codex ASP OK",
  expectedTitle: "Codex generated smoke",
  expectedToolPhases: ["started", "updated", "completed"],
  expectedSession: "codex-native-session",
  exposesHistoryCapability: true,
});
await runNativeAdapterSmoke({
  id: "claude-native",
  command: path.join(directory, "fake-claude-stream-json.mjs"),
  cwd: path.join(directory, "fixtures", "claude-workspace"),
  rawRunApprovalMode: "suggest",
  providerEnv: {
    AGUI_FAKE_CLAUDE_EXPECT_PERMISSION_MODE: "manual",
  },
  runtimeAdapter: "claude-code-stream-json",
  expectedApprovalRequests: 1,
  expectedListedModel: "haiku",
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.agents:agent.selected",
    "asp.ext.agents:agent.started",
    "asp.ext.agents:agent.completed",
    "asp.ext.hooks:hook.completed",
    "asp.ext.permissions:policy.updated",
  ],
  expectedPartTypes: ["reasoning"],
  expectedQuestionRequests: 1,
  expectedText: "Claude ASP OK",
  expectedTitle: "Claude generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "claude-native-session",
  exposesHistoryCapability: true,
});
await runNativeAdapterSmoke({
  id: "claude-native-auto",
  command: path.join(directory, "fake-claude-stream-json.mjs"),
  cwd: path.join(directory, "fixtures", "claude-workspace"),
  approvalMode: "auto-edit",
  rawRunApprovalMode: "auto-edit",
  providerEnv: {
    AGUI_FAKE_CLAUDE_EXPECT_PERMISSION_MODE: "auto",
  },
  runtimeAdapter: "claude-code-stream-json",
  expectedApprovalRequests: 1,
  expectedListedModel: "haiku",
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.agents:agent.selected",
    "asp.ext.agents:agent.started",
    "asp.ext.agents:agent.completed",
    "asp.ext.hooks:hook.completed",
    "asp.ext.permissions:policy.updated",
  ],
  expectedPartTypes: ["reasoning"],
  expectedQuestionRequests: 1,
  expectedText: "Claude ASP OK",
  expectedTitle: "Claude generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "claude-native-session",
  exposesHistoryCapability: true,
});
await runNativeAdapterSmoke({
  id: "opencode-native",
  command: path.join(directory, "fake-opencode-server.mjs"),
  expectedApprovalRequests: 1,
  runtimeAdapter: "opencode-server",
  expectedListedModel: "fake/native-test",
  expectedPartTypes: ["status", "reasoning", "resource", "plan", "diff"],
  expectedText: "OpenCode ASP OK",
  expectedTitle: "OpenCode generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.agents:agent.selected",
    "asp.ext.run-control:compaction.started",
    "asp.ext.run-control:compaction.completed",
  ],
  expectedSession: "opencode-native-session",
  supportsHistory: true,
});
await runOpenCodeCliModelFallbackSmoke();
await runNativeAdapterSmoke({
  id: "pi-native",
  command: path.join(directory, "fake-pi-rpc-agent.mjs"),
  expectedApprovalRequests: 1,
  runtimeAdapter: "pi-rpc",
  expectedListedModel: "fake/native-test",
  expectedQuestionRequests: 1,
  expectedText: "Pi RPC OK",
  expectedTitle: "Pi generated smoke",
  expectedPartTypes: ["reasoning"],
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.run-control:queue.updated",
  ],
  expectedToolPhases: ["started", "completed"],
  expectedSession: "pi-native-session",
});
await runNativeAdapterSmoke({
  id: "grok-native",
  command: path.join(directory, "fake-grok-cli-agent.mjs"),
  providerEnv: {
    AGUI_GROK_SESSIONS_DIR: grokHistoryRoot,
    GROK_HOME: grokHomeRoot,
  },
  runtimeAdapter: "grok-cli",
  expectedListedModel: "native-test",
  expectedPartTypes: ["reasoning"],
  expectedReasoningText: "Grok CLI reasoning details",
  expectedText: "Grok CLI OK",
  expectedTitle: "Grok generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "grok-native-session",
  supportsHistory: true,
});
await runNativeAdapterSmoke({
  id: "kimi-native",
  command: path.join(directory, "fake-kimi-cli-agent.mjs"),
  approvalMode: "auto",
  providerArgs: ["--yolo"],
  providerEnv: {
    AGUI_KIMI_SESSIONS_DIR: kimiHistoryRoot,
    AGUI_FAKE_KIMI_EXPECT_NO_YOLO: "1",
    KIMI_CODE_HOME: kimiHomeRoot,
  },
  runtimeAdapter: "kimi-cli",
  expectedListedModel: "kimi-code/kimi-test",
  expectedPartTypes: ["reasoning"],
  expectedReasoningText: "Kimi CLI reasoning details",
  expectedText: "Kimi CLI OK",
  expectedTitle: "Kimi generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "kimi-native-session",
  supportsHistory: true,
});
await runNativeAdapterSmoke({
  id: "grok-native-legacy-adapter",
  command: path.join(directory, "fake-grok-cli-agent.mjs"),
  providerEnv: {
    AGUI_GROK_SESSIONS_DIR: grokHistoryRoot,
    GROK_HOME: grokHomeRoot,
  },
  runtimeAdapter: "grok-agent-stdio",
  expectedListedModel: "native-test",
  expectedPartTypes: ["reasoning"],
  expectedReasoningText: "Grok CLI reasoning details",
  expectedText: "Grok CLI OK",
  expectedTitle: "Grok generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "grok-native-session",
  supportsHistory: true,
});
await runNativeAdapterSmoke({
  id: "kimi-native-legacy-adapter",
  command: path.join(directory, "fake-kimi-cli-agent.mjs"),
  providerArgs: ["acp"],
  providerEnv: {
    AGUI_KIMI_SESSIONS_DIR: kimiHistoryRoot,
    KIMI_CODE_HOME: kimiHomeRoot,
  },
  runtimeAdapter: "kimi-acp-stdio",
  expectedListedModel: "kimi-code/kimi-test",
  expectedPartTypes: ["reasoning"],
  expectedReasoningText: "Kimi CLI reasoning details",
  expectedText: "Kimi CLI OK",
  expectedTitle: "Kimi generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "kimi-native-session",
  supportsHistory: true,
});
await runNativeAdapterSmoke({
  id: "codex-native-full",
  command: path.join(directory, "fake-codex-app-server.mjs"),
  cwd: path.join(directory, "fixtures", "codex-workspace"),
  approvalMode: "full-auto",
  rawRunApprovalMode: "full-auto",
  providerEnv: {
    AGUI_FAKE_CODEX_EXPECT_APPROVAL_POLICY: "never",
    AGUI_FAKE_CODEX_EXPECT_SANDBOX_TYPE: "dangerFullAccess",
  },
  runtimeAdapter: "codex-app-server",
  expectedApprovalRequests: 0,
  expectedExtensionEvents: ["asp.ext.session-state:state.updated"],
  expectedPartTypes: ["plan", "status", "reasoning", "diff"],
  expectedQuestionRequests: 1,
  expectedReasoningText: "Codex app-server reasoning details",
  expectedText: "Codex ASP OK",
  expectedTitle: "Codex generated smoke",
  expectedToolPhases: ["started", "updated", "completed"],
  expectedSession: "codex-native-session",
  exposesHistoryCapability: true,
});
await runNativeAdapterSmoke({
  id: "claude-native-full",
  command: path.join(directory, "fake-claude-stream-json.mjs"),
  cwd: path.join(directory, "fixtures", "claude-workspace"),
  approvalMode: "full-auto",
  rawRunApprovalMode: "full-auto",
  providerEnv: {
    AGUI_FAKE_CLAUDE_EXPECT_PERMISSION_MODE: "bypassPermissions",
  },
  runtimeAdapter: "claude-code-stream-json",
  expectedApprovalRequests: 0,
  expectedListedModel: "haiku",
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.agents:agent.selected",
    "asp.ext.agents:agent.started",
    "asp.ext.agents:agent.completed",
    "asp.ext.hooks:hook.completed",
    "asp.ext.permissions:policy.updated",
  ],
  expectedPartTypes: ["reasoning"],
  expectedQuestionRequests: 1,
  expectedText: "Claude ASP OK",
  expectedTitle: "Claude generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "claude-native-session",
  exposesHistoryCapability: true,
});
await runNativeAdapterSmoke({
  id: "opencode-native-full",
  command: path.join(directory, "fake-opencode-server.mjs"),
  approvalMode: "full-auto",
  runtimeAdapter: "opencode-server",
  expectedApprovalRequests: 0,
  expectedListedModel: "fake/native-test",
  expectedPartTypes: ["status", "reasoning", "resource", "plan", "diff"],
  expectedText: "OpenCode ASP OK",
  expectedTitle: "OpenCode generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.agents:agent.selected",
    "asp.ext.run-control:compaction.started",
    "asp.ext.run-control:compaction.completed",
  ],
  expectedSession: "opencode-native-session",
  supportsHistory: true,
});
await runNativeAdapterSmoke({
  id: "pi-native-full",
  command: path.join(directory, "fake-pi-rpc-agent.mjs"),
  approvalMode: "full-auto",
  expectedApprovalRequests: 0,
  runtimeAdapter: "pi-rpc",
  expectedListedModel: "fake/native-test",
  expectedQuestionRequests: 1,
  expectedText: "Pi RPC OK",
  expectedTitle: "Pi generated smoke",
  expectedPartTypes: ["reasoning"],
  expectedExtensionEvents: [
    "asp.ext.session-state:state.updated",
    "asp.ext.run-control:queue.updated",
  ],
  expectedToolPhases: ["started", "completed"],
  expectedSession: "pi-native-session",
});
await runNativeAdapterSmoke({
  id: "grok-native-full",
  command: path.join(directory, "fake-grok-cli-agent.mjs"),
  approvalMode: "full-auto",
  providerEnv: {
    AGUI_GROK_SESSIONS_DIR: grokHistoryRoot,
    AGUI_FAKE_GROK_EXPECT_PERMISSION_MODE: "bypassPermissions",
    GROK_HOME: grokHomeRoot,
  },
  runtimeAdapter: "grok-cli",
  expectedListedModel: "native-test",
  expectedPartTypes: ["reasoning"],
  expectedReasoningText: "Grok CLI reasoning details",
  expectedText: "Grok CLI OK",
  expectedTitle: "Grok generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "grok-native-session",
  supportsHistory: true,
  deleteHistorySession: true,
});
await runNativeAdapterSmoke({
  id: "kimi-native-full",
  command: path.join(directory, "fake-kimi-cli-agent.mjs"),
  approvalMode: "full-auto",
  providerEnv: {
    AGUI_KIMI_SESSIONS_DIR: kimiHistoryRoot,
    AGUI_FAKE_KIMI_EXPECT_AUTO: "1",
    KIMI_CODE_HOME: kimiHomeRoot,
  },
  runtimeAdapter: "kimi-cli",
  expectedListedModel: "kimi-code/kimi-test",
  expectedPartTypes: ["reasoning"],
  expectedReasoningText: "Kimi CLI reasoning details",
  expectedText: "Kimi CLI OK",
  expectedTitle: "Kimi generated smoke",
  expectedToolPhases: ["started", "completed"],
  expectedSession: "kimi-native-session",
  supportsHistory: true,
  deleteHistorySession: true,
});

async function runPersistentStdioSmoke() {
  const persistentProvider = {
    ...provider,
    id: "fake-asp-persistent",
    name: "Fake ASP persistent",
    transport: "persistent-stdio",
  };
  try {
    const firstPid = await capabilitiesPid(persistentProvider, "persistent-capabilities-1");
    const secondPid = await capabilitiesPid(persistentProvider, "persistent-capabilities-2");
    assert.ok(Number.isInteger(firstPid));
    assert.equal(firstPid, secondPid);
    console.log(`persistent-stdio smoke passed: reused fake ASP process ${firstPid}.`);
  } finally {
    disposePersistentTransports();
  }
}

async function capabilitiesPid(persistentProvider, id) {
  const persistentConnection = await connectAspTransport({
    provider: persistentProvider,
    cwd: process.cwd(),
  });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`persistent-stdio capabilities request ${id} timed out.`)),
        10_000,
      );
      persistentConnection.onError(reject);
      persistentConnection.onMessage((message) => {
        if (message.id !== id) return;
        clearTimeout(timeout);
        resolve(message.result?.pid);
      });
      persistentConnection.send(requestMessage(persistentProvider.id, "capabilities", {}, id));
    });
  } finally {
    persistentConnection.close();
  }
}

async function runPersistentStdioIsolationSmoke() {
  const agentScript = `
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify({ asp: "agent-server-protocol", version: "1", ...message }) + "\\n");
}
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "capabilities") {
    const delay = String(message.id).endsWith("a") ? 20 : 5;
    setTimeout(() => send({ id: message.id, result: { protocolVersions: ["1"], models: false } }), delay);
    return;
  }
  if (message.type === "run") {
    const delay = String(message.runId).endsWith("a") ? 20 : 5;
    setTimeout(() => send({ type: "message_delta", runId: message.runId, data: message.runId }), delay);
    setTimeout(() => send({ type: "run_finished", runId: message.runId, durationMs: delay, exitCode: 0, success: true }), delay + 5);
  }
});
`;
  const persistentProvider = {
    ...provider,
    id: "fake-asp-persistent-isolation",
    name: "Fake ASP persistent isolation",
    args: ["-e", agentScript],
    transport: "persistent-stdio",
    capabilities: { extensions: [], protocolVersions: ["1"] },
  };
  const first = await connectAspTransport({ provider: persistentProvider, cwd: process.cwd() });
  const second = await connectAspTransport({ provider: persistentProvider, cwd: process.cwd() });
  const firstMessages = [];
  const secondMessages = [];
  first.onMessage((message) => firstMessages.push(message));
  second.onMessage((message) => secondMessages.push(message));
  try {
    const firstResponse = waitForTransportMessage(first, (message) => message.id === "request-a");
    const secondResponse = waitForTransportMessage(second, (message) => message.id === "request-b");
    first.send(requestMessage(persistentProvider.id, "capabilities", {}, "request-a"));
    second.send(requestMessage(persistentProvider.id, "capabilities", {}, "request-b"));
    await Promise.all([firstResponse, secondResponse]);
    assert.deepEqual(
      firstMessages.map((message) => message.id),
      ["request-a"],
    );
    assert.deepEqual(
      secondMessages.map((message) => message.id),
      ["request-b"],
    );

    firstMessages.length = 0;
    secondMessages.length = 0;
    const firstFinished = waitForTransportMessage(
      first,
      (message) => message.type === "run_finished" && message.runId === "run-a",
    );
    const secondFinished = waitForTransportMessage(
      second,
      (message) => message.type === "run_finished" && message.runId === "run-b",
    );
    first.send(
      runMessage(
        {
          uiSessionId: "persistent-ui-a",
          providerId: persistentProvider.id,
          cwd: process.cwd(),
          prompt: "first",
          approvalMode: "suggest",
        },
        "run-a",
      ),
    );
    second.send(
      runMessage(
        {
          uiSessionId: "persistent-ui-b",
          providerId: persistentProvider.id,
          cwd: process.cwd(),
          prompt: "second",
          approvalMode: "suggest",
        },
        "run-b",
      ),
    );
    await Promise.all([firstFinished, secondFinished]);
    assert.ok(firstMessages.every((message) => message.runId === "run-a"));
    assert.ok(secondMessages.every((message) => message.runId === "run-b"));
    console.log("persistent-stdio isolation passed: concurrent requests and runs stayed scoped.");
  } finally {
    first.close();
    second.close();
    disposePersistentTransports();
  }
}

function waitForTransportMessage(connection, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ASP transport message timed out.")), 10_000);
    connection.onError((error) => {
      clearTimeout(timeout);
      reject(error);
    });
    connection.onMessage((message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

async function runOpenCodeCliModelFallbackSmoke() {
  const fallbackProvider = {
    id: "opencode-cli-model-fallback",
    name: "OpenCode CLI model fallback",
    command: path.join(directory, "fake-opencode-server.mjs"),
    args: [],
    env: {
      AGUI_FAKE_OPENCODE_EMPTY_MODELS: "1",
    },
    enabled: true,
    transport: "stdio",
    capabilities: {
      protocolVersions: ["1"],
      runtimeAdapter: "opencode-server",
      wireProtocol: "opencode-server",
    },
    models: [],
  };
  const connection = await connectAspTransport({
    provider: fallbackProvider,
    cwd: process.cwd(),
  });
  try {
    const result = await transportResponse(
      connection,
      requestMessage(fallbackProvider.id, "list_models", {}, "opencode-cli-models"),
      "opencode-cli-models",
      "opencode-server",
    );
    assert.ok(result.result?.models?.some((model) => model.model === "fake/cli-model"));
    console.log(
      "opencode-server CLI model fallback passed: list_models uses opencode models when server config is empty.",
    );
  } finally {
    connection.close();
  }
}

async function runClaudeAuthErrorManagerSmoke() {
  const claudeAuthProvider = {
    id: "claude-auth-smoke",
    name: "Claude auth smoke",
    command: path.join(directory, "fake-claude-stream-json.mjs"),
    args: [],
    env: {},
    enabled: true,
    transport: "stdio",
    capabilities: {
      runtimeAdapter: "claude-code-stream-json",
      wireProtocol: "claude-code-stream-json",
    },
  };
  const manager = new AspManager({
    providerStore: {
      get: (id) => (id === claudeAuthProvider.id ? claudeAuthProvider : undefined),
      list: () => [claudeAuthProvider],
    },
  });
  const managerEvents = [];
  const sender = {
    id: "claude-auth-smoke-renderer",
    isDestroyed: () => false,
    send: (channel, payload) => {
      managerEvents.push({ channel, payload });
    },
  };
  const result = await manager.run(
    {
      uiSessionId: "ui-claude-auth-smoke",
      providerId: claudeAuthProvider.id,
      cwd: process.cwd(),
      prompt: "CLAUDE_AUTH_FAIL",
      approvalMode: "suggest",
      model: "native-test",
      effort: "medium",
      speed: "default",
    },
    sender,
  );
  const runEvents = managerEvents
    .filter((event) => event.channel === "agui:asp:event" && event.payload?.type === "run_event")
    .map((event) => event.payload.event);
  assert.equal(result.success, false);
  assert.ok(
    runEvents.some((event) => event.type === "error" && /Invalid API key/i.test(event.message)),
    "Claude auth failures should be surfaced as visible ASP error events.",
  );
  assert.ok(runEvents.some((event) => event.type === "run_finished" && event.success === false));

  managerEvents.length = 0;
  const serverErrorResult = await manager.run(
    {
      uiSessionId: "ui-claude-server-error-smoke",
      providerId: claudeAuthProvider.id,
      cwd: process.cwd(),
      prompt: "CLAUDE_SERVER_ERROR",
      approvalMode: "suggest",
      model: "native-test",
      effort: "medium",
      speed: "default",
    },
    sender,
  );
  const serverErrorRunEvents = managerEvents
    .filter((event) => event.channel === "agui:asp:event" && event.payload?.type === "run_event")
    .map((event) => event.payload.event);
  assert.equal(serverErrorResult.success, false);
  assert.ok(
    serverErrorRunEvents.some(
      (event) => event.type === "error" && /API Error: 502 status code/i.test(event.message),
    ),
    "Claude server_error results should surface detailed diagnostics instead of the generic error code.",
  );
  assert.ok(
    !serverErrorRunEvents.some(
      (event) => event.type === "error" && event.message === "server_error",
    ),
  );
  await manager.dispose();
  console.log(
    "Claude error surfacing passed: auth and server errors emit visible diagnostic events.",
  );
}

async function runBuiltInProviderStoreSmoke() {
  const legacyUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agui-provider-store-legacy-"));
  const seededUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agui-provider-store-seeded-"));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agui-provider-store-"));
  try {
    fs.mkdirSync(path.join(userDataPath, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(userDataPath, ".codex", "config.toml"),
      'model = "gpt-5-smoke"\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(legacyUserDataPath, "asp-providers.json"),
      `${JSON.stringify(
        {
          version: 1,
          providers: [
            {
              id: "grok",
              name: "Grok",
              command: process.execPath,
              args: [path.join(directory, "fake-grok-cli-agent.mjs")],
              env: {},
              enabled: true,
              transport: "stdio",
              capabilities: {
                runtimeAdapter: "grok-agent-stdio",
                wireProtocol: "grok-streaming-messages-json",
              },
              models: [],
            },
            {
              id: "kimi",
              name: "Kimi",
              command: process.execPath,
              args: ["acp"],
              env: {},
              enabled: true,
              transport: "stdio",
              capabilities: {
                runtimeAdapter: "kimi-acp-stdio",
                wireProtocol: "kimi-acp-jsonrpc",
              },
              models: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const legacyStore = new ProviderStore({
      homeDir: legacyUserDataPath,
      userDataPath: legacyUserDataPath,
    });
    assert.equal(legacyStore.get("grok")?.command, process.execPath);
    assert.equal(legacyStore.get("grok")?.capabilities?.runtimeAdapter, "grok-cli");
    assert.equal(legacyStore.get("kimi")?.capabilities?.runtimeAdapter, "kimi-cli");
    assert.deepEqual(legacyStore.get("kimi")?.args, []);
    assert.deepEqual(legacyStore.get("grok")?.args, [
      path.join(directory, "fake-grok-cli-agent.mjs"),
    ]);

    fs.writeFileSync(
      path.join(seededUserDataPath, "asp-providers.json"),
      `${JSON.stringify(
        {
          version: 1,
          defaultProvidersSeeded: true,
          providers: [
            {
              id: "claude-code",
              name: "Claude Code",
              command: "claude",
              args: [],
              env: {},
              enabled: true,
              transport: "stdio",
              capabilities: {
                runtimeAdapter: "claude-code-stream-json",
                wireProtocol: "claude-code-stream-json",
                models: true,
              },
              models: [
                {
                  id: "default",
                  model: "default",
                  displayName: "Default (recommended)",
                  isDefault: true,
                },
                { id: "fable", model: "fable", displayName: "Fable" },
                { id: "opus", model: "opus", displayName: "Opus" },
                { id: "sonnet", model: "sonnet", displayName: "Sonnet" },
              ],
            },
            {
              id: "grok",
              name: "Grok",
              command: process.execPath,
              args: [path.join(directory, "fake-grok-cli-agent.mjs")],
              env: {},
              enabled: true,
              transport: "stdio",
              capabilities: {
                runtimeAdapter: "grok-cli",
                wireProtocol: "grok-streaming-messages-json",
              },
              models: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const seededStore = new ProviderStore({
      homeDir: seededUserDataPath,
      userDataPath: seededUserDataPath,
    });
    assert.equal(seededStore.get("claude-code"), undefined);
    assert.equal(seededStore.get("grok")?.command, process.execPath);
    assert.deepEqual(
      seededStore.list().map((provider) => provider.id),
      ["grok"],
    );

    const store = new ProviderStore({
      env: { ...process.env, CODEX_HOME: path.join(userDataPath, ".codex") },
      homeDir: userDataPath,
      userDataPath,
    });
    const providers = store.list();
    assert.deepEqual(
      providers.map((provider) => provider.id),
      [],
    );
    const grok = store.save({
      id: "grok",
      args: [path.join(directory, "fake-grok-cli-agent.mjs")],
      command: process.execPath,
      enabled: true,
      env: {},
      capabilities: {
        runtimeAdapter: "grok-cli",
        wireProtocol: "grok-streaming-messages-json",
      },
      name: "Grok Custom Smoke",
      transport: "stdio",
    });
    const overridden = store.get("grok");
    assert.equal(overridden?.command, process.execPath);
    assert.deepEqual(overridden?.args, [path.join(directory, "fake-grok-cli-agent.mjs")]);
    assert.deepEqual(
      store.list().map((provider) => provider.id),
      ["grok"],
    );
    assert.equal(store.remove("grok"), true);
    assert.equal(store.get("grok"), undefined);
    assert.deepEqual(
      store.list().map((provider) => provider.id),
      [],
    );
    store.save({
      ...grok,
      args: [path.join(directory, "fake-grok-cli-agent.mjs")],
      command: process.execPath,
      name: "Grok Custom Smoke",
    });
    assert.equal(store.get("grok")?.command, process.execPath);
    assert.deepEqual(
      store.list().map((provider) => provider.id),
      ["grok"],
    );
  } finally {
    fs.rmSync(legacyUserDataPath, { force: true, recursive: true });
    fs.rmSync(seededUserDataPath, { force: true, recursive: true });
    fs.rmSync(userDataPath, { force: true, recursive: true });
  }
  console.log(
    "Default Agent provider store passed: empty defaults, legacy seed cleanup, edit, delete, and re-add behavior OK.",
  );
}

async function runMcpAppManagerSmoke() {
  const manager = new AspManager({
    providerStore: {
      get: (id) => (id === provider.id ? provider : undefined),
      list: () => [provider],
    },
  });
  const managerEvents = [];
  let fallbackQuestionPromise;
  const sender = {
    id: "manager-smoke-renderer",
    isDestroyed: () => false,
    send: (channel, payload) => {
      managerEvents.push({ channel, payload });
      if (channel === "agui:asp:event" && !fallbackQuestionPromise) {
        fallbackQuestionPromise = manager.requestUserInput("missing-gateway-scope", {
          question: "Fallback routed question?",
        });
      }
      if (channel === "agui:asp:approval") {
        manager.respondApproval(payload.requestId, "allow", undefined, sender.id);
      }
      if (channel === "agui:asp:question") {
        manager.respondQuestion(
          payload.requestId,
          { answers: [{ questionId: "choice", question: "Result", answer: "OK" }] },
          sender.id,
        );
      }
    },
  };
  const uiSessionId = "ui-manager-smoke";
  const result = await manager.run(
    {
      uiSessionId,
      providerId: provider.id,
      cwd: process.cwd(),
      prompt: "Run the ASP manager MCP Apps smoke test",
      approvalMode: "suggest",
      model: "fake-asp",
      effort: "medium",
      speed: "default",
    },
    sender,
  );
  assert.equal(result.success, true);
  assert.equal((await fallbackQuestionPromise).answers?.[0]?.answer, "OK");
  assert.ok(managerEvents.some((event) => event.channel === "agui:asp:event"));
  const questionEvent = managerEvents.find(
    (event) =>
      event.channel === "agui:asp:question" && event.payload?.app?.title === "Smoke question app",
  );
  assert.equal(questionEvent?.payload?.app?.title, "Smoke question app");
  const afterRunTool = await manager.invokeExtension(
    {
      uiSessionId,
      providerSessionId: result.providerSessionId,
      extension: "asp.ext.mcp-apps",
      method: "tools/call",
      payload: { server: "fixture", name: "manager_after_run", arguments: { ok: true } },
      timeoutMs: 5_000,
    },
    sender.id,
  );
  assert.equal(afterRunTool.result?.structuredContent?.tool, "manager_after_run");
  const noTimeoutTool = await manager.invokeExtension(
    {
      uiSessionId,
      providerSessionId: result.providerSessionId,
      extension: "asp.ext.mcp-apps",
      method: "tools/call",
      payload: { server: "fixture", name: "manager_no_timeout", arguments: { ok: true } },
      timeoutMs: 0,
    },
    sender.id,
  );
  assert.equal(noTimeoutTool.result?.structuredContent?.tool, "manager_no_timeout");
  assert.equal(await manager.cancel(uiSessionId), true);
  await manager.dispose();
  console.log(
    "AspManager MCP Apps retained channel passed: tools/call works after run completion without interaction timeout.",
  );
}

async function runClientServiceManagerSmoke() {
  let written;
  const manager = new AspManager({
    clientServices: {
      writeTextFile: (input, context) => {
        written = { ...input, context };
        return {
          path: path.join(context.cwd, input.path),
          bytes: Buffer.byteLength(input.content),
        };
      },
    },
    providerStore: {
      get: (id) => (id === provider.id ? provider : undefined),
      list: () => [provider],
    },
  });
  const sender = {
    id: "client-service-smoke-renderer",
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (channel === "agui:asp:approval") {
        manager.respondApproval(payload.requestId, "allow", undefined, sender.id);
      }
      if (channel === "agui:asp:question") {
        manager.respondQuestion(
          payload.requestId,
          { answers: [{ questionId: "choice", question: "Result", answer: "OK" }] },
          sender.id,
        );
      }
    },
  };
  const createdSession = await manager.newSession(provider.id, process.cwd(), "Manager session");
  assert.equal(createdSession.id, "fake-session-created");
  assert.equal(await manager.closeSession(provider.id, createdSession.id, process.cwd()), true);
  const result = await manager.run(
    {
      uiSessionId: "ui-client-service-smoke",
      providerId: provider.id,
      cwd: process.cwd(),
      prompt: "client-service-smoke",
      approvalMode: "suggest",
    },
    sender,
  );
  assert.equal(result.success, true);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(written?.path, "client-service-smoke.txt");
  assert.equal(written?.content, "ASP client service OK");
  assert.equal(written?.context.runId, result.runId);
  await manager.dispose();
  console.log(
    "ASP bidirectional client service passed: negotiated, approved, correlated, and returned.",
  );
}

async function runQuestionWaitTimeoutSmoke() {
  const slowQuestionProvider = {
    ...provider,
    id: "fake-asp-slow-question",
    name: "Fake ASP slow question",
    timeoutMs: 150,
  };
  const manager = new AspManager({
    providerStore: {
      get: (id) => (id === slowQuestionProvider.id ? slowQuestionProvider : undefined),
      list: () => [slowQuestionProvider],
    },
  });
  let delayedQuestion = false;
  const sender = {
    id: "question-timeout-smoke-renderer",
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (channel === "agui:asp:approval") {
        manager.respondApproval(payload.requestId, "allow", undefined, sender.id);
      }
      if (channel === "agui:asp:question") {
        delayedQuestion = true;
        setTimeout(() => {
          manager.respondQuestion(
            payload.requestId,
            { answers: [{ questionId: "choice", question: "Result", answer: "OK" }] },
            sender.id,
          );
        }, 250);
      }
    },
  };
  const result = await manager.run(
    {
      uiSessionId: "ui-question-timeout-smoke",
      providerId: slowQuestionProvider.id,
      cwd: process.cwd(),
      prompt: "Run the delayed ASP question timeout smoke test",
      approvalMode: "suggest",
      model: "fake-asp",
      effort: "medium",
      speed: "default",
    },
    sender,
  );
  assert.equal(delayedQuestion, true);
  assert.equal(result.success, true);
  await manager.dispose();
  console.log(
    "AspManager question wait timeout suspension passed: delayed user input does not time out the run.",
  );
}

async function runManagerCancelSmoke() {
  const cancelAgentScript = `
const readline = require("node:readline");
const ASP = "agent-server-protocol";
const VERSION = "1";
const input = readline.createInterface({ input: process.stdin });
setInterval(() => {}, 1000);
function send(message) {
  process.stdout.write(JSON.stringify({ asp: ASP, version: VERSION, ...message }) + "\\n");
}
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: VERSION,
        agentInfo: { name: "cancel-smoke", version: "0.1.0" },
        capabilities: { extensions: [], protocolVersions: [VERSION] },
      },
    });
    return;
  }
  if (message.type === "run") {
    send({ type: "message_delta", runId: message.runId, data: "cancel smoke started" });
  }
});
`;
  const cancelProvider = {
    ...provider,
    id: "fake-asp-cancel",
    name: "Fake ASP cancel",
    args: ["-e", cancelAgentScript],
    capabilities: { extensions: [] },
  };
  const manager = new AspManager({
    providerStore: {
      get: (id) => (id === cancelProvider.id ? cancelProvider : undefined),
      list: () => [cancelProvider],
    },
  });
  const managerEvents = [];
  const sender = {
    id: "manager-cancel-smoke-renderer",
    isDestroyed: () => false,
    send: (channel, payload) => {
      managerEvents.push({ channel, payload });
    },
  };
  const uiSessionId = "ui-manager-cancel-smoke";
  const runPromise = manager.run(
    {
      uiSessionId,
      providerId: cancelProvider.id,
      cwd: process.cwd(),
      prompt: "Run the ASP manager cancel smoke test",
      approvalMode: "suggest",
      model: "fake-asp",
      effort: "medium",
      speed: "default",
    },
    sender,
  );
  await delay(100);
  assert.equal(await manager.cancel(uiSessionId), true);
  const result = await runPromise;
  await delay(1_300);
  const runEvents = managerEvents
    .filter((event) => event.channel === "agui:asp:event" && event.payload?.type === "run_event")
    .map((event) => event.payload.event);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.output, "cancel smoke started");
  assert.ok(runEvents.some((event) => event.type === "run_finished" && event.success === false));
  assert.equal(
    runEvents.some((event) => event.type === "error"),
    false,
  );
  await manager.dispose();
  console.log(
    "AspManager cancel passed: stopped runs resolve without surfacing SIGTERM as an error.",
  );
}

async function runPendingInteractionReplaySmoke() {
  const manager = new AspManager({
    providerStore: {
      get: (id) => (id === provider.id ? provider : undefined),
      list: () => [provider],
    },
  });
  let capturedQuestionId = "";
  let resolveQuestionSeen;
  const questionSeen = new Promise((resolve) => {
    resolveQuestionSeen = resolve;
  });
  const firstSender = {
    id: "pending-replay-old-renderer",
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (channel === "agui:asp:approval") {
        manager.respondApproval(payload.requestId, "allow", undefined, firstSender.id);
      }
      if (channel === "agui:asp:question") {
        capturedQuestionId = payload.requestId;
        resolveQuestionSeen();
      }
    },
  };
  const runPromise = manager.run(
    {
      uiSessionId: "ui-pending-replay-smoke",
      providerId: provider.id,
      cwd: process.cwd(),
      prompt: "Run the pending interaction replay smoke test",
      approvalMode: "suggest",
      model: "fake-asp",
      effort: "medium",
      speed: "default",
    },
    firstSender,
  );
  await questionSeen;

  const secondSender = {
    id: "pending-replay-new-renderer",
    isDestroyed: () => false,
    send: () => undefined,
  };
  const pending = manager.pendingInteractions(secondSender);
  assert.equal(pending.questions.length, 1);
  assert.equal(pending.questions[0].requestId, capturedQuestionId);
  assert.equal(
    manager.respondQuestion(
      capturedQuestionId,
      { answers: [{ questionId: "choice", question: "Result", answer: "Fail" }] },
      firstSender.id,
    ),
    false,
  );
  assert.equal(
    manager.respondQuestion(
      capturedQuestionId,
      { answers: [{ questionId: "choice", question: "Result", answer: "OK" }] },
      secondSender.id,
    ),
    true,
  );
  const result = await runPromise;
  assert.equal(result.success, true);
  await manager.dispose();
  console.log(
    "AspManager pending interaction replay passed: reopened renderer can restore and answer questions.",
  );
}

async function runMcpGatewayUserInputSmoke() {
  let captured;
  const gateway = new McpGateway({
    requestUserInput: async ({ request, scopeKey }) => {
      captured = { request, scopeKey };
      return {
        answers: [
          {
            questionId: "address",
            question: "配送到哪里？",
            answer: "home",
          },
        ],
        app: {
          title: "Address picker",
          widgetState: { selectedAddressId: "home" },
        },
      };
    },
  });
  const requestUserInputTool = gateway
    .exportMcp()
    .tools.find((tool) => tool.name === "code_tool.request_user_input");
  assert.ok(requestUserInputTool, "MCP Gateway did not expose code_tool.request_user_input.");
  assert.match(requestUserInputTool.description, /mode-agnostic/);
  assert.match(requestUserInputTool.description, /bare top-level Codex request_user_input/);
  assert.doesNotMatch(requestUserInputTool.description, /plan mode/i);
  assert.doesNotMatch(requestUserInputTool.description, /QuestionDialog/);
  const result = await gateway.callTool("code_tool.request_user_input", {
    [mcpGatewayScopeArgumentName]: "ui-gateway-input-smoke",
    title: "选择配送地址",
    question: "配送到哪里？",
    options: [
      {
        label: "家",
        value: "home",
        description: "浙江省杭州市余杭区",
        imageUri: "https://example.test/address.png",
      },
    ],
    app: {
      title: "Address picker",
      html: "<div>Address picker</div>",
      height: 320,
      widgetState: { selectedAddressId: "home" },
    },
  });
  assert.equal(captured.scopeKey, "ui-gateway-input-smoke");
  assert.equal(captured.request.interactionType, "mcp_app");
  assert.equal(captured.request.questions[0].control, "single_select");
  assert.equal(
    captured.request.questions[0].options[0].imageUri,
    "https://example.test/address.png",
  );
  assert.equal(captured.request.app.title, "Address picker");
  assert.equal(result.ok, true);
  assert.equal(result.response.answers[0].answer, "home");
  const invokeAliasResult = await gateway.callTool("code_tool.invoke", {
    [mcpGatewayScopeArgumentName]: "ui-gateway-input-invoke-smoke",
    tool: "request_user_input",
    args: {
      question: "继续吗？",
      options: [
        {
          label: "继续",
          value: "continue",
        },
      ],
    },
  });
  assert.equal(captured.scopeKey, "ui-gateway-input-invoke-smoke");
  assert.equal(captured.request.questions[0].question, "继续吗？");
  assert.equal(captured.request.questions[0].control, "single_select");
  assert.equal(invokeAliasResult.ok, true);
  assert.equal(invokeAliasResult.response.answers[0].answer, "home");
  console.log(
    "MCP Gateway user-input bridge passed: request_user_input tool preserves options and app payload.",
  );
}

function runMcpGatewayInjectionContractSmoke() {
  const privateServerId = "private_service_that_must_not_leak";
  const input = {
    uiSessionId: "gateway-injection-smoke",
    providerId: "fake-asp",
    cwd: process.cwd(),
    prompt: "Read current private service data",
    approvalMode: "suggest",
    additionalDeveloperInstructions: "Preserve this instruction.",
    mcpServers: [
      {
        id: privateServerId,
        name: "Private service with a large catalog",
        type: "http",
        url: "https://private.example.test/mcp",
      },
    ],
  };
  const gatewayServer = mcpGatewayStdioBridgeServer(
    { socketPath: "/tmp/agui-mcp-gateway-test.sock", token: "test" },
    input.uiSessionId,
  );
  const transformed = injectMcpGatewayRunInput(input, gatewayServer);

  assert.deepEqual(
    transformed.mcpServers.map((server) => server.id),
    ["agui_mcp_gateway"],
  );
  assert.equal(transformed.mcpServers[0].type, "stdio");
  assert.equal(transformed.mcpServers[0].command, process.execPath);
  assert.equal(
    transformed.mcpServers[0].env.AGUI_MCP_GATEWAY_SOCKET,
    gatewayServer.env.AGUI_MCP_GATEWAY_SOCKET,
  );
  assert.equal(transformed.mcpServers[0].env.AGUI_MCP_GATEWAY_TOKEN, "test");
  assert.equal(transformed.mcpServers[0].env.AGUI_MCP_GATEWAY_SESSION_ID, input.uiSessionId);
  assert.equal(transformed.mcpServers[0].env.AGUI_MCP_GATEWAY_ENDPOINT, undefined);
  assert.match(transformed.additionalDeveloperInstructions, /Preserve this instruction/);
  assert.match(transformed.additionalDeveloperInstructions, /does not need to mention MCP Gateway/);
  assert.match(transformed.additionalDeveloperInstructions, /external, private, connected-service/);
  assert.doesNotMatch(transformed.additionalDeveloperInstructions, new RegExp(privateServerId));
  assert.equal(
    transformed.additionalDeveloperInstructions.endsWith(mcpGatewayAgentDeveloperInstructions()),
    true,
  );
  console.log(
    "MCP Gateway injection contract passed: fixed routing policy is present and direct MCP catalog identifiers are hidden.",
  );
}

async function runMcpGatewayStdioBridgeRoundTripSmoke() {
  const gateway = new McpGateway();
  const socketBasePath = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const socketServer = createMcpGatewayStdioSocketServer({
    gateway,
    socketPath: path.join(socketBasePath, `agui-mcp-gateway-smoke-${process.pid}.sock`),
    token: "stdio-bridge-smoke-token",
  });
  let child;
  try {
    await socketServer.start();
    const gatewayServer = mcpGatewayStdioBridgeServer(
      await socketServer.getAddress(),
      "stdio-bridge-smoke",
    );
    child = spawn(gatewayServer.command, gatewayServer.args, {
      env: { ...process.env, ...gatewayServer.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const responses = new Map();
    const pending = new Map();
    const lines = createInterface({ crlfDelay: Infinity, input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      responses.set(message.id, message);
      pending.get(message.id)?.();
    });

    const request = async (method, params = {}) => {
      const id = `mcp-bridge-smoke-${method}-${responses.size + pending.size + 1}`;
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
      await waitForBridgeResponse(id, pending, responses, () => stderr);
      const response = responses.get(id);
      responses.delete(id);
      if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
      return response.result;
    };

    const initialized = await request("initialize", {
      capabilities: {},
      clientInfo: { name: "asp-smoke", version: "0.1.0" },
      protocolVersion: "2025-03-26",
    });
    assert.equal(initialized.serverInfo.name, "agui-mcp-gateway");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const tools = await request("tools/list");
    assert.ok(
      tools.tools.some((tool) => tool.name === "code_tool.resolve"),
      "MCP Gateway stdio bridge did not expose code_tool.resolve.",
    );
    console.log("MCP Gateway stdio bridge passed: round-tripped initialize and tools/list.");
  } finally {
    child?.stdin?.end();
    child?.kill();
    await socketServer.stop();
  }
}

function waitForBridgeResponse(id, pending, responses, stderrText) {
  if (responses.has(id)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const stderr = stderrText();
      reject(new Error(`MCP Gateway stdio bridge timed out: ${id}${stderr ? `: ${stderr}` : ""}`));
    }, 2000);
    pending.set(id, () => {
      clearTimeout(timer);
      pending.delete(id);
      resolve();
    });
  });
}

async function runMcpGatewayResolveContractSmoke() {
  const resolvedTasks = [];
  const gateway = new McpGateway({
    resolver: ({ task }) => {
      resolvedTasks.push(task);
      const selectedToolNames = task.includes("alpha")
        ? ["mcp.connected.alpha_tool"]
        : task.includes("beta")
          ? ["mcp.connected.beta_tool"]
          : [];
      return {
        reasoningSummary: selectedToolNames.length
          ? `Resolved ${selectedToolNames[0]}.`
          : "No connected tool matched.",
        selectedToolNames,
      };
    },
  });
  gateway.registerToolProvider({
    id: "connected",
    provider: {
      listTools: () => [
        { name: "alpha_tool", description: "Read alpha data." },
        { name: "beta_tool", description: "Read beta data." },
      ],
      callTool: () => ({ ok: true }),
    },
  });

  const resolveTool = gateway.exportMcp().tools.find((tool) => tool.name === "code_tool.resolve");
  assert.ok(resolveTool);
  assert.match(resolveTool.description, /user does not need to mention MCP Gateway/);

  const alpha = await gateway.callTool("code_tool.resolve", {
    [mcpGatewayScopeArgumentName]: "gateway-resolve-contract",
    task: "read alpha",
  });
  const beta = await gateway.callTool("code_tool.resolve", {
    [mcpGatewayScopeArgumentName]: "gateway-resolve-contract",
    task: "read beta",
  });
  const unmatched = await gateway.callTool("code_tool.resolve", {
    [mcpGatewayScopeArgumentName]: "gateway-resolve-contract",
    task: "answer only from the conversation",
  });

  assert.equal(alpha.matched, true);
  assert.deepEqual(alpha.selectedToolNames, ["mcp.connected.alpha_tool"]);
  assert.equal(beta.matched, true);
  assert.deepEqual(beta.selectedToolNames, ["mcp.connected.beta_tool"]);
  assert.equal(unmatched.matched, false);
  assert.deepEqual(unmatched.selectedToolNames, []);
  assert.deepEqual(resolvedTasks, ["read alpha", "read beta", "answer only from the conversation"]);
  console.log(
    "MCP Gateway resolve contract passed: cache keys are task-exact and no-match is a normal fallback result.",
  );
}

async function runMcpGatewayLocalResolveFallbackSmoke() {
  const gateway = new McpGateway({
    llm: {
      apiKey: "",
      baseUrl: "",
      enabled: false,
      model: "",
    },
  });
  gateway.registerToolProvider({
    id: "run_scoped_github",
    provider: {
      listTools: () => [
        {
          name: "github_get_issue",
          description: "Read GitHub issue details for a repository.",
        },
      ],
      callTool: (_name, args) => ({ ok: true, args }),
    },
  });

  const resolved = await gateway.callTool("code_tool.resolve", {
    [mcpGatewayScopeArgumentName]: "run-scoped-extension-mcp",
    task: "read github issue details",
  });
  assert.equal(resolved.matched, true);
  assert.equal(resolved.retriever, "local");
  assert.equal(resolved.usedLlm, false);
  assert.deepEqual(resolved.selectedToolNames, ["mcp.run_scoped_github.github_get_issue"]);

  const invoked = await gateway.callTool("code_tool.invoke", {
    [mcpGatewayScopeArgumentName]: "run-scoped-extension-mcp",
    tool: "github_get_issue",
    args: { number: 42 },
  });
  assert.equal(invoked.ok, true);
  assert.deepEqual(invoked.args, { number: 42 });
  console.log(
    "MCP Gateway local fallback passed: run-scoped extension tools resolve without a configured resolver.",
  );
}

async function runMcpGatewayBrowserProviderSmoke() {
  const calls = [];
  const gateway = new McpGateway({
    llm: { enabled: false },
  });
  gateway.registerToolProvider({
    id: browserMcpProviderId,
    label: "AGUI Browser",
    provider: createBrowserMcpToolProvider({
      invokeBrowserMethod: async (method, params) => {
        calls.push({ method, params });
        if (method === "browser.list") {
          return [
            {
              id: "tab-1",
              url: "https://example.test/",
              title: "Example",
              loading: false,
              canGoBack: false,
              canGoForward: false,
              updatedAt: Date.now(),
            },
          ];
        }
        if (method === "browser.snapshot") {
          return {
            id: params.id ?? "tab-1",
            url: "https://example.test/",
            title: "Example",
            text: "Example page text",
            html: "<html><body>Example page text</body></html>",
          };
        }
        if (method === "browser.navigate") {
          return {
            id: params.id ?? "tab-1",
            url: params.url,
            title: "Navigated",
            faviconUrl: "https://example.test/favicon.ico",
          };
        }
        throw new Error(`Unexpected browser method: ${method}`);
      },
    }),
  });

  const tools = await gateway.listTools();
  assert.ok(tools.some((tool) => tool.toolName === "mcp.agui_browser.browser_snapshot"));
  const snapshotResolve = await gateway.callTool("code_tool.resolve", {
    [mcpGatewayScopeArgumentName]: "browser-provider-smoke",
    task: "read a browser snapshot page text",
    constraints: { maxTools: 2 },
  });
  assert.ok(snapshotResolve.selectedToolNames.includes("mcp.agui_browser.browser_snapshot"));
  const snapshotResult = await gateway.callTool("code_tool.invoke", {
    [mcpGatewayScopeArgumentName]: "browser-provider-smoke",
    tool: "browser_snapshot",
    args: { id: "tab-1", includeHtml: false },
  });
  assert.equal(snapshotResult.ok, true);
  assert.equal(snapshotResult.snapshot.text, "Example page text");
  assert.equal(snapshotResult.snapshot.html, undefined);

  const navigateResolve = await gateway.callTool("code_tool.resolve", {
    [mcpGatewayScopeArgumentName]: "browser-provider-smoke",
    task: "navigate browser url",
    constraints: { maxTools: 2 },
  });
  assert.ok(navigateResolve.selectedToolNames.includes("mcp.agui_browser.browser_navigate"));
  const navigateResult = await gateway.callTool("code_tool.invoke", {
    [mcpGatewayScopeArgumentName]: "browser-provider-smoke",
    tool: "browser_navigate",
    args: { id: "tab-1", url: "https://example.test/next", waitUntil: "none" },
  });
  assert.equal(navigateResult.ok, true);
  assert.equal(navigateResult.target.url, "https://example.test/next");
  assert.ok(calls.some((call) => call.method === "browser.snapshot"));
  assert.ok(calls.some((call) => call.method === "browser.navigate"));
  console.log(
    "MCP Gateway Browser provider passed: Browser tools resolve and invoke through code_tool.*.",
  );
}
