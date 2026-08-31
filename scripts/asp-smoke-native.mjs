import assert from "node:assert/strict";
import { connectAspTransport } from "@agui/asp/transport";
import {
  extensionInvokeMessage,
  initializeMessage,
  requestMessage,
  rpcApprovalResult,
  rpcQuestionResult,
  runMessage,
} from "@agui/asp/protocol";

export async function runNativeAdapterSmoke({
  id,
  command,
  approvalMode = "suggest",
  cwd = process.cwd(),
  providerArgs = [],
  providerEnv = {},
  rawRunApprovalMode,
  expectedApprovalRequests = 0,
  expectedListedModel,
  expectedPartTypes = [],
  expectedExtensionEvents = [],
  expectedQuestionRequests = 0,
  expectedReasoningText,
  runtimeAdapter,
  expectedText,
  expectedTitle,
  expectedToolPhases = ["completed"],
  expectedSession,
  exposesHistoryCapability = false,
  expectedCapabilitySessions = exposesHistoryCapability,
  expectedCapabilitySessionHistory = exposesHistoryCapability,
  expectedCapabilityResumeSession = exposesHistoryCapability,
  supportsHistory = false,
  deleteHistorySession = false,
  preserveNativeEvents = false,
}) {
  const nativeProvider = {
    id,
    name: id,
    command,
    args: providerArgs,
    env: providerEnv,
    enabled: true,
    transport: "stdio",
    capabilities: {
      protocolVersions: ["1"],
      runtimeAdapter,
      wireProtocol: runtimeAdapter,
    },
    models: [{ id: "native-test", model: "native-test", isDefault: true }],
  };
  const nativeConnection = await connectAspTransport({
    provider: nativeProvider,
    cwd,
  });
  let output = "";
  let deltaOutput = "";
  const textParts = new Map();
  let sessionId = "";
  let nativeCapabilities;
  let nativeInitialization;
  let historyError;
  let historySessions;
  let listedModels;
  let listedModelsError;
  let approvalRequests = 0;
  let questionRequests = 0;
  let toolCompleted = false;
  let titleSeen = false;
  let usageSeen = false;
  const nativeEvents = [];
  let nativeStderr = "";
  let resolveModelsResponse;
  const modelsResponse = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `${runtimeAdapter} response native-models timed out.${nativeStderr ? `\n${nativeStderr}` : ""}`,
          ),
        ),
      15_000,
    );
    resolveModelsResponse = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  const nativeCompletion = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `${runtimeAdapter} smoke test timed out.${nativeStderr ? `\n${nativeStderr}` : ""}\n${JSON.stringify(nativeEvents, null, 2)}`,
          ),
        ),
      30_000,
    );
    nativeConnection.onError(reject);
    nativeConnection.onStderr((chunk) => {
      nativeStderr += chunk;
    });
    nativeConnection.onMessage((message) => {
      nativeEvents.push(message);
      if (message.id === "native-initialize") nativeInitialization = message.result;
      if (message.id === "native-capabilities") nativeCapabilities = message.result;
      if (message.id === "native-models") {
        listedModels = message.result?.models;
        listedModelsError = message.error;
        resolveModelsResponse();
      }
      if (message.id === "native-history") {
        historyError = message.error?.code;
        historySessions = message.result?.sessions;
      }
      sessionId = message.providerSessionId || sessionId;
      if (message.type === "message_delta") {
        deltaOutput += message.data;
        if (!textParts.size) output = deltaOutput;
      }
      if (message.type === "message_part" && message.part?.type === "text") {
        textParts.set(message.part.id, message.part.content);
        output = [...textParts.values()].join("");
      }
      if (message.type === "tool_event" && message.toolEvent.phase === "completed") {
        toolCompleted = true;
      }
      if (message.type === "usage") usageSeen = true;
      if (
        message.type === "session_state" &&
        (!expectedTitle || message.state?.title === expectedTitle)
      ) {
        titleSeen = true;
      }
      if (
        message.type === "extension_event" &&
        message.extension === "asp.ext.session-state" &&
        (!expectedTitle || message.payload?.title === expectedTitle)
      ) {
        titleSeen = true;
      }
      if (message.method === "approval_request") {
        approvalRequests += 1;
        nativeConnection.send(rpcApprovalResult(message.id, "allow"));
      }
      if (message.method === "question_request") {
        questionRequests += 1;
        nativeConnection.send(
          rpcQuestionResult(message.id, {
            answers: [
              {
                questionId: "continue",
                question: "Continue native adapter test?",
                answer: "OK",
              },
            ],
          }),
        );
      }
      if (message.type === "run_finished") {
        clearTimeout(timeout);
        assert.equal(message.success, true);
        resolve();
      }
    });
  });
  nativeConnection.send(initializeMessage(id, "native-initialize"));
  nativeConnection.send(requestMessage(id, "capabilities", {}, "native-capabilities"));
  nativeConnection.send(requestMessage(id, "list_models", {}, "native-models"));
  nativeConnection.send(requestMessage(id, "list_sessions", {}, "native-history"));
  await modelsResponse;
  assert.equal(nativeInitialization?.protocolVersion, "1");
  assert.equal(listedModelsError, undefined);
  assert.ok(Array.isArray(listedModels));
  if (runtimeAdapter === "codex-app-server") {
    const codexModel = listedModels.find((model) => model.model === "native-test");
    assert.equal(nativeCapabilities.models, true);
    assert.equal(codexModel?.defaultReasoningEffort, "medium");
    assert.deepEqual(codexModel?.supportedReasoningEfforts, ["low", "medium", "high"]);
    assert.deepEqual(
      listedModels.find((model) => model.model === "native-fast")?.supportedReasoningEfforts,
      ["low"],
    );
  }
  if (runtimeAdapter === "claude-code-stream-json") {
    assert.ok(listedModels.length > 10);
    assert.ok(listedModels.some((model) => model.model === "V2EX/Qwen"));
    assert.equal(
      listedModels.find((model) => model.model === "Qwen3-Coder (1M context)")?.contextWindowTokens,
      1_049_000,
    );
    assert.equal(
      listedModels.find((model) => /GLM-5\.2$/.test(model.model))?.contextWindowTokens,
      1_049_000,
    );
    const glmModel = listedModels.find((model) => /GLM-5\.2$/.test(model.model));
    assert.equal(glmModel?.defaultReasoningEffort, "medium");
    assert.deepEqual(glmModel?.supportedReasoningEfforts, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.deepEqual(
      listedModels.find((model) => model.model === "MiniMax/M2")?.supportedReasoningEfforts,
      ["low", "medium", "high", "xhigh", "max"],
    );
  }
  if (runtimeAdapter === "opencode-server") {
    const openCodeModel = listedModels.find((model) => model.model === "fake/native-test");
    assert.equal(openCodeModel?.defaultReasoningEffort, "medium");
    assert.deepEqual(openCodeModel?.supportedReasoningEfforts, ["low", "medium", "high"]);
    assert.deepEqual(
      listedModels.find((model) => model.model === "fake/native-plain")?.supportedReasoningEfforts,
      ["none"],
    );
  }
  if (runtimeAdapter === "pi-rpc") {
    const piModel = listedModels.find((model) => model.model === "fake/native-test");
    assert.equal(piModel?.defaultReasoningEffort, "medium");
    assert.deepEqual(piModel?.supportedReasoningEfforts, ["none", "low", "medium"]);
    assert.deepEqual(
      listedModels.find((model) => model.model === "fake/native-plain")?.supportedReasoningEfforts,
      ["none"],
    );
  }
  if (runtimeAdapter === "grok-cli") {
    const grokModel = listedModels.find((model) => model.model === "native-test");
    assert.equal(grokModel?.displayName, "Native Test");
    assert.equal(grokModel?.contextWindowTokens, 128000);
    assert.equal(grokModel?.defaultReasoningEffort, "medium");
    assert.deepEqual(grokModel?.supportedReasoningEfforts, ["low", "medium", "high"]);
  }
  if (runtimeAdapter === "kimi-cli") {
    const kimiModel = listedModels.find((model) => model.model === "kimi-code/kimi-test");
    assert.equal(kimiModel?.defaultReasoningEffort, "high");
    assert.deepEqual(kimiModel?.supportedReasoningEfforts, ["low", "high", "max"]);
    const kimiThinkingModel = listedModels.find(
      (model) => model.model === "kimi-code/kimi-for-coding",
    );
    assert.equal(kimiThinkingModel?.defaultReasoningEffort, "high");
    assert.deepEqual(kimiThinkingModel?.supportedReasoningEfforts, ["high"]);
  }
  const run = runMessage(
    {
      uiSessionId: `${id}-ui`,
      providerId: id,
      cwd,
      prompt: "Native adapter smoke",
      approvalMode,
      model: "native-test",
      effort: "medium",
      speed: "default",
      preserveNativeEvents,
    },
    `${id}-run`,
  );
  if (rawRunApprovalMode) run.approvalMode = rawRunApprovalMode;
  nativeConnection.send(run);
  if (runtimeAdapter === "pi-rpc") {
    const state = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_state",
          runId: `${id}-run`,
          payload: {},
        },
        "pi-ext-state",
      ),
      "pi-ext-state",
      runtimeAdapter,
    );
    assert.equal(state.result?.result?.providerSessionId, expectedSession);
    const steer = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "steer",
          runId: `${id}-run`,
          payload: { message: "Prefer compatibility assertions." },
        },
        "pi-ext-steer",
      ),
      "pi-ext-steer",
      runtimeAdapter,
    );
    assert.equal(steer.result?.method, "steer");
    const vendor = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "vendor.pi.rpc",
          method: "raw_command",
          runId: `${id}-run`,
          payload: { command: "get_available_thinking_levels" },
        },
        "pi-ext-vendor",
      ),
      "pi-ext-vendor",
      runtimeAdapter,
    );
    assert.ok(vendor.result?.result?.levels?.includes("medium"));
  }
  await nativeCompletion;
  if (preserveNativeEvents) {
    assert.ok(
      nativeEvents.some(
        (event) =>
          event.method === "extension.event" &&
          event.params?.event === "native.event" &&
          event.params?.fallback === "none",
      ),
      `${runtimeAdapter} did not preserve its native event payload.`,
    );
  }
  const methodNames = (extensionId) =>
    new Set(
      (
        nativeCapabilities.extensions.find((extension) => extension.id === extensionId)?.methods ??
        []
      ).map((method) => method.name),
    );
  if (runtimeAdapter === "codex-app-server") {
    assert.ok(nativeCapabilities.slashCommands?.some((command) => command.name === "review"));
    assert.ok(methodNames("asp.ext.run-control").has("abort_current_step"));
    assert.ok(methodNames("asp.ext.run-control").has("compact"));
    assert.ok(methodNames("asp.ext.run-control").has("steer"));
    assert.ok(methodNames("asp.ext.run-control").has("set_model"));
    assert.ok(methodNames("asp.ext.run-control").has("set_effort"));
    assert.ok(methodNames("asp.ext.run-control").has("set_session_title"));
    assert.ok(methodNames("asp.ext.permissions").has("get_policy"));
    assert.ok(methodNames("asp.ext.permissions").has("set_policy"));
    assert.ok(methodNames("asp.ext.session-state").has("get_state"));
    assert.ok(methodNames("asp.ext.session-state").has("get_messages"));
    assert.ok(methodNames("asp.ext.runtime").has("get_runtime"));
    assert.ok(methodNames("vendor.codex.app-server").has("raw_request"));

    const state = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_state",
          runId: `${id}-run`,
          payload: {},
        },
        "codex-ext-state",
      ),
      "codex-ext-state",
      runtimeAdapter,
    );
    assert.equal(state.result?.result?.providerSessionId, expectedSession);
    const messages = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_messages",
          runId: `${id}-run`,
          payload: {},
        },
        "codex-ext-messages",
      ),
      "codex-ext-messages",
      runtimeAdapter,
    );
    assert.ok(
      messages.result?.result?.messages?.some((message) => message.content.includes(expectedText)),
    );
    const runtime = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.runtime",
          method: "get_runtime",
          runId: `${id}-run`,
          payload: {},
        },
        "codex-ext-runtime",
      ),
      "codex-ext-runtime",
      runtimeAdapter,
    );
    assert.ok(runtime.result?.result?.features?.includes("turns"));
    assert.ok(runtime.result?.result?.commands?.some((command) => command.name === "review"));
    assert.ok(
      runtime.result?.result?.agentsGuidance?.some((item) => item.path.endsWith("AGENTS.md")),
    );
    assert.equal(runtime.result?.result?.mcpServers?.fixture?.command, "node");
    assert.ok(runtime.result?.result?.skills?.some((skill) => skill.id === "fixture-skill"));
    assert.ok(runtime.result?.result?.hooks?.some((hook) => hook.path.endsWith("config.toml")));
    const codexPolicy = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.permissions",
          method: "get_policy",
          runId: `${id}-run`,
          payload: {},
        },
        "codex-ext-policy",
      ),
      "codex-ext-policy",
      runtimeAdapter,
    );
    assert.equal(
      codexPolicy.result?.result?.policy?.defaultEffect,
      approvalMode === "full-auto" ? "allow" : "ask",
    );
    const codexSetPolicy = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.permissions",
          method: "set_policy",
          runId: `${id}-run`,
          payload: { policy: { defaultEffect: "deny", rules: [] } },
        },
        "codex-ext-set-policy",
      ),
      "codex-ext-set-policy",
      runtimeAdapter,
    );
    assert.equal(codexSetPolicy.result?.result?.policy?.defaultEffect, "deny");
    const title = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "set_session_title",
          runId: `${id}-run`,
          payload: { title: "Codex renamed smoke" },
        },
        "codex-ext-title",
      ),
      "codex-ext-title",
      runtimeAdapter,
    );
    assert.equal(title.result?.result?.title, "Codex renamed smoke");
    const model = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "set_model",
          runId: `${id}-run`,
          payload: { model: "fake/new-model" },
        },
        "codex-ext-model",
      ),
      "codex-ext-model",
      runtimeAdapter,
    );
    assert.equal(model.result?.result?.model, "fake/new-model");
    const effort = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "set_effort",
          runId: `${id}-run`,
          payload: { effort: "high" },
        },
        "codex-ext-effort",
      ),
      "codex-ext-effort",
      runtimeAdapter,
    );
    assert.equal(effort.result?.result?.effort, "high");
    const compact = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "compact",
          runId: `${id}-run`,
          payload: {},
        },
        "codex-ext-compact",
      ),
      "codex-ext-compact",
      runtimeAdapter,
    );
    assert.equal(compact.result?.result?.compacted, true);
    const steered = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "steer",
          runId: `${id}-run`,
          payload: { message: "Prefer compatibility assertions." },
        },
        "codex-ext-steer",
      ),
      "codex-ext-steer",
      runtimeAdapter,
    );
    assert.equal(steered.result?.result?.queued, true);
    const raw = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "vendor.codex.app-server",
          method: "raw_request",
          runId: `${id}-run`,
          payload: { method: "codex/raw_test", params: { ok: true } },
        },
        "codex-ext-raw",
      ),
      "codex-ext-raw",
      runtimeAdapter,
    );
    assert.equal(raw.result?.result?.ok, true);
    const aborted = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "abort_current_step",
          runId: `${id}-run`,
          payload: {},
        },
        "codex-ext-abort",
      ),
      "codex-ext-abort",
      runtimeAdapter,
    );
    assert.equal(aborted.result?.result?.aborted, true);
    assert.ok(
      nativeEvents.some(
        (event) => event.type === "tool_event" && event.toolEvent?.semantic?.toolType === "shell",
      ),
    );
  }
  if (runtimeAdapter === "claude-code-stream-json") {
    assert.ok(nativeCapabilities.slashCommands?.some((command) => command.name === "review"));
    assert.ok(methodNames("asp.ext.agents").has("list_agents"));
    assert.ok(methodNames("asp.ext.agents").has("select_agent"));
    assert.ok(methodNames("asp.ext.hooks").has("list_hooks"));
    assert.ok(methodNames("asp.ext.hooks").has("set_hooks"));
    assert.ok(methodNames("asp.ext.permissions").has("get_policy"));
    assert.ok(methodNames("asp.ext.permissions").has("set_policy"));
    assert.ok(methodNames("asp.ext.run-control").has("steer"));
    assert.ok(methodNames("asp.ext.run-control").has("follow_up"));
    assert.ok(methodNames("asp.ext.session-state").has("get_state"));
    assert.ok(methodNames("asp.ext.runtime").has("get_runtime"));
    assert.ok(methodNames("vendor.claude.cli").has("raw_input"));

    const agents = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.agents",
          method: "list_agents",
          runId: `${id}-run`,
          payload: {},
        },
        "claude-ext-agents",
      ),
      "claude-ext-agents",
      runtimeAdapter,
    );
    assert.ok(agents.result?.result?.agents?.some((agent) => agent.id === "reviewer"));
    const selected = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.agents",
          method: "select_agent",
          runId: `${id}-run`,
          payload: { agentId: "reviewer" },
        },
        "claude-ext-select-agent",
      ),
      "claude-ext-select-agent",
      runtimeAdapter,
    );
    assert.equal(selected.result?.result?.agentId, "reviewer");
    const invoked = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.agents",
          method: "invoke_agent",
          runId: `${id}-run`,
          payload: { agentId: "reviewer", message: "Review ASP compatibility." },
        },
        "claude-ext-invoke-agent",
      ),
      "claude-ext-invoke-agent",
      runtimeAdapter,
    );
    assert.equal(invoked.result?.result?.queued, true);
    const hooks = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.hooks",
          method: "list_hooks",
          runId: `${id}-run`,
          payload: {},
        },
        "claude-ext-hooks",
      ),
      "claude-ext-hooks",
      runtimeAdapter,
    );
    assert.ok(hooks.result?.result?.hooks?.some((hook) => hook.event === "PostToolUse"));
    const setHooks = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.hooks",
          method: "set_hooks",
          runId: `${id}-run`,
          payload: {
            hooks: {
              SmokeHook: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "printf smoke" }],
                },
              ],
            },
          },
        },
        "claude-ext-set-hooks",
      ),
      "claude-ext-set-hooks",
      runtimeAdapter,
    );
    assert.ok(setHooks.result?.result?.settings?.hooks?.SmokeHook);
    const policy = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.permissions",
          method: "get_policy",
          runId: `${id}-run`,
          payload: {},
        },
        "claude-ext-policy",
      ),
      "claude-ext-policy",
      runtimeAdapter,
    );
    assert.equal(
      policy.result?.result?.policy?.defaultEffect,
      approvalMode === "full-auto" ? "allow" : "ask",
    );
    const setPolicy = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.permissions",
          method: "set_policy",
          runId: `${id}-run`,
          payload: {
            allowedTools: ["Read"],
            disallowedTools: ["WebFetch"],
            permissionMode: "default",
          },
        },
        "claude-ext-set-policy",
      ),
      "claude-ext-set-policy",
      runtimeAdapter,
    );
    assert.ok(setPolicy.result?.result?.settings?.allowedTools?.includes("Read"));
    const state = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_state",
          runId: `${id}-run`,
          payload: {},
        },
        "claude-ext-state",
      ),
      "claude-ext-state",
      runtimeAdapter,
    );
    assert.equal(state.result?.result?.providerSessionId, expectedSession);
    const messages = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_messages",
          runId: `${id}-run`,
          payload: {},
        },
        "claude-ext-messages",
      ),
      "claude-ext-messages",
      runtimeAdapter,
    );
    assert.ok(
      messages.result?.result?.messages?.some((message) => message.content.includes(expectedText)),
    );
    const runtime = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.runtime",
          method: "get_runtime",
          runId: `${id}-run`,
          payload: {},
        },
        "claude-ext-runtime",
      ),
      "claude-ext-runtime",
      runtimeAdapter,
    );
    assert.ok(runtime.result?.result?.features?.includes("subagent-files"));
    assert.ok(runtime.result?.result?.commands?.some((command) => command.name === "review"));
    assert.ok(runtime.result?.result?.outputStyles?.some((style) => style.id === "concise"));
    assert.ok(runtime.result?.result?.memory?.some((item) => item.path.endsWith("CLAUDE.md")));
    assert.equal(runtime.result?.result?.mcpServers?.fixture?.command, "node");
    const steered = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "steer",
          runId: `${id}-run`,
          payload: { message: "Prefer compatibility assertions." },
        },
        "claude-ext-steer",
      ),
      "claude-ext-steer",
      runtimeAdapter,
    );
    assert.equal(steered.result?.result?.queued, true);
    const vendor = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "vendor.claude.cli",
          method: "raw_input",
          runId: `${id}-run`,
          payload: { message: { type: "noop" } },
        },
        "claude-ext-vendor",
      ),
      "claude-ext-vendor",
      runtimeAdapter,
    );
    assert.equal(vendor.result?.result?.sent, true);
    assert.ok(
      nativeEvents.some(
        (event) =>
          event.type === "tool_event" && event.toolEvent?.semantic?.toolType === "agent.invoke",
      ),
    );
  }
  if (runtimeAdapter === "opencode-server") {
    assert.ok(methodNames("asp.ext.agents").has("list_agents"));
    assert.ok(methodNames("asp.ext.agents").has("select_agent"));
    assert.ok(methodNames("asp.ext.run-control").has("follow_up"));
    assert.ok(methodNames("asp.ext.run-control").has("compact"));
    assert.equal(methodNames("asp.ext.run-control").has("steer"), false);
    assert.ok(methodNames("asp.ext.session-state").has("get_state"));
    assert.ok(methodNames("asp.ext.runtime").has("get_runtime"));
    assert.ok(methodNames("vendor.opencode.server").has("raw_request"));

    const agents = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.agents",
          method: "list_agents",
          runId: `${id}-run`,
          payload: {},
        },
        "opencode-ext-agents",
      ),
      "opencode-ext-agents",
      runtimeAdapter,
    );
    assert.ok(
      agents.result?.result?.agents?.some(
        (agent) => agent.id === "reviewer" && agent.role === "subagent",
      ),
    );
    const selected = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.agents",
          method: "select_agent",
          runId: `${id}-run`,
          payload: { agentId: "reviewer" },
        },
        "opencode-ext-select-agent",
      ),
      "opencode-ext-select-agent",
      runtimeAdapter,
    );
    assert.equal(selected.result?.result?.agentId, "reviewer");
    const state = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_state",
          runId: `${id}-run`,
          providerSessionId: expectedSession,
          payload: {},
        },
        "opencode-ext-state",
      ),
      "opencode-ext-state",
      runtimeAdapter,
    );
    assert.equal(state.result?.result?.providerSessionId, expectedSession);
    const messages = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_messages",
          runId: `${id}-run`,
          providerSessionId: expectedSession,
          payload: {},
        },
        "opencode-ext-messages",
      ),
      "opencode-ext-messages",
      runtimeAdapter,
    );
    assert.ok(
      messages.result?.result?.messages?.some((message) => message.content.includes(expectedText)),
    );
    const runtime = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.runtime",
          method: "get_runtime",
          runId: `${id}-run`,
          payload: {},
        },
        "opencode-ext-runtime",
      ),
      "opencode-ext-runtime",
      runtimeAdapter,
    );
    assert.ok(runtime.result?.result?.providers?.some((provider) => provider.id === "fake"));
    const raw = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "vendor.opencode.server",
          method: "raw_request",
          runId: `${id}-run`,
          payload: { method: "GET", route: "/config" },
        },
        "opencode-ext-raw",
      ),
      "opencode-ext-raw",
      runtimeAdapter,
    );
    assert.equal(raw.result?.result?.ok, true);
    const titled = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "set_session_title",
          runId: `${id}-run`,
          providerSessionId: expectedSession,
          payload: { title: "OpenCode renamed smoke" },
        },
        "opencode-ext-title",
      ),
      "opencode-ext-title",
      runtimeAdapter,
    );
    assert.equal(titled.result?.result?.title, "OpenCode renamed smoke");
    const compact = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.run-control",
          method: "compact",
          runId: `${id}-run`,
          providerSessionId: expectedSession,
          payload: { instructions: "smoke" },
        },
        "opencode-ext-compact",
      ),
      "opencode-ext-compact",
      runtimeAdapter,
    );
    assert.equal(compact.result?.result?.compacted, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (runtimeAdapter === "grok-cli" || runtimeAdapter === "kimi-cli") {
    assert.ok(methodNames("asp.ext.session-state").has("get_state"));
    assert.ok(methodNames("asp.ext.session-state").has("get_messages"));
    assert.ok(methodNames("asp.ext.runtime").has("get_runtime"));

    const state = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_state",
          runId: `${id}-run`,
          payload: {},
        },
        "cli-ext-state",
      ),
      "cli-ext-state",
      runtimeAdapter,
    );
    assert.equal(state.result?.result?.providerSessionId, expectedSession);
    const messages = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.session-state",
          method: "get_messages",
          runId: `${id}-run`,
          payload: {},
        },
        "cli-ext-messages",
      ),
      "cli-ext-messages",
      runtimeAdapter,
    );
    assert.ok(
      messages.result?.result?.messages?.some((message) => message.content.includes(expectedText)),
    );
    const runtime = await transportResponse(
      nativeConnection,
      extensionInvokeMessage(
        {
          extension: "asp.ext.runtime",
          method: "get_runtime",
          runId: `${id}-run`,
          payload: {},
        },
        "cli-ext-runtime",
      ),
      "cli-ext-runtime",
      runtimeAdapter,
    );
    assert.equal(runtime.result?.result?.adapter, runtimeAdapter);
  }
  if (supportsHistory) {
    assert.equal(nativeCapabilities.sessions, true);
    assert.equal(nativeCapabilities.sessionHistory, true);
    assert.equal(nativeCapabilities.resumeSession, true);
    if (runtimeAdapter === "grok-cli" || runtimeAdapter === "kimi-cli") {
      assert.equal(nativeCapabilities.deleteSession, true);
    }
    assert.ok(historySessions.some((session) => session.id === expectedSession));
    const history = await transportResponse(
      nativeConnection,
      requestMessage(
        id,
        "session_messages",
        { providerSessionId: expectedSession },
        "native-messages",
      ),
      "native-messages",
      runtimeAdapter,
    );
    const historyMessages = history.result?.messages ?? [];
    assert.ok(historyMessages.some((message) => message.content.includes(expectedText)));
    const resumed = await transportResponse(
      nativeConnection,
      requestMessage(
        id,
        "resume_session",
        { cwd: process.cwd(), providerSessionId: expectedSession },
        "native-resume",
      ),
      "native-resume",
      runtimeAdapter,
    );
    assert.equal(resumed.result?.session?.id, expectedSession);
    assert.ok(resumed.result?.messages?.some((message) => message.content.includes(expectedText)));
  } else {
    assert.equal(nativeCapabilities.sessions, expectedCapabilitySessions);
    assert.equal(nativeCapabilities.sessionHistory, expectedCapabilitySessionHistory);
    assert.equal(nativeCapabilities.resumeSession, expectedCapabilityResumeSession);
    if (expectedCapabilitySessions) {
      assert.ok(Array.isArray(historySessions));
    } else {
      assert.equal(historyError, -32601);
    }
  }
  if (expectedListedModel) {
    assert.ok(listedModels.some((model) => model.model === expectedListedModel));
  } else {
    assert.ok(listedModels.some((model) => model.model === "native-test"));
  }
  if (runtimeAdapter === "pi-rpc") {
    assert.ok(
      nativeCapabilities.extensions.some((extension) => extension.id === "asp.ext.run-control"),
    );
    assert.ok(nativeCapabilities.extensions.some((extension) => extension.id === "vendor.pi.rpc"));
  }
  const partTypes = new Set(
    nativeEvents.filter((event) => event.type === "message_part").map((event) => event.part?.type),
  );
  for (const partType of expectedPartTypes) {
    assert.ok(partTypes.has(partType), `${runtimeAdapter} did not emit ${partType} part.`);
  }
  if (expectedReasoningText) {
    assert.ok(
      nativeEvents.some(
        (event) =>
          event.type === "message_part" &&
          event.part?.type === "reasoning" &&
          event.part?.content === expectedReasoningText,
      ),
      `${runtimeAdapter} did not emit expected reasoning text.`,
    );
    assert.equal(
      nativeEvents.some(
        (event) =>
          event.type === "tool_event" &&
          event.toolEvent?.kind === "reasoning" &&
          event.toolEvent?.output === undefined,
      ),
      false,
      `${runtimeAdapter} emitted reasoning as an empty tool event.`,
    );
  }
  const toolPhases = new Set(
    nativeEvents
      .filter((event) => event.type === "tool_event")
      .map((event) => event.toolEvent?.phase),
  );
  for (const phase of expectedToolPhases) {
    assert.ok(toolPhases.has(phase), `${runtimeAdapter} did not emit ${phase} tool phase.`);
  }
  const extensionEvents = new Set(
    nativeEvents
      .filter((event) => event.type === "extension_event")
      .map((event) => `${event.extension}:${event.event}`),
  );
  for (const event of expectedExtensionEvents) {
    assert.ok(
      extensionEvents.has(event),
      `${runtimeAdapter} did not emit extension event ${event}.`,
    );
  }
  assert.equal(approvalRequests, expectedApprovalRequests);
  assert.equal(questionRequests, expectedQuestionRequests);
  assert.equal(output, expectedText);
  assert.equal(sessionId, expectedSession);
  if (expectedTitle)
    assert.equal(titleSeen, true, `${runtimeAdapter} did not emit generated session title.`);
  assert.equal(toolCompleted, true);
  assert.equal(usageSeen, true);
  if (supportsHistory && (runtimeAdapter === "grok-cli" || runtimeAdapter === "kimi-cli")) {
    await runNativeCliResumeSmoke({
      id,
      approvalMode,
      cwd,
      expectedSession,
      expectedText,
      nativeConnection,
      runtimeAdapter,
    });
  }
  if (deleteHistorySession) {
    const deleted = await transportResponse(
      nativeConnection,
      requestMessage(id, "delete_session", { providerSessionId: expectedSession }, "native-delete"),
      "native-delete",
      runtimeAdapter,
    );
    assert.equal(deleted.result?.deleted, true);
    const historyAfterDelete = await transportResponse(
      nativeConnection,
      requestMessage(id, "list_sessions", {}, "native-history-after-delete"),
      "native-history-after-delete",
      runtimeAdapter,
    );
    assert.ok(
      !historyAfterDelete.result?.sessions?.some((session) => session.id === expectedSession),
    );
  }
  nativeConnection.close();
  console.log(
    `${runtimeAdapter} compatibility passed: stream, parts, tools, interactions, usage, sessions OK.`,
  );
}

async function runNativeCliResumeSmoke({
  id,
  approvalMode,
  cwd,
  expectedSession,
  expectedText,
  nativeConnection,
  runtimeAdapter,
}) {
  const runId = `${id}-resume-run`;
  const textParts = new Map();
  let deltaOutput = "";
  let output = "";
  let sessionId = "";
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${runtimeAdapter} resume run timed out.`)),
      30_000,
    );
    nativeConnection.onMessage((message) => {
      if (message.runId !== runId) return;
      sessionId = message.providerSessionId || sessionId;
      if (message.type === "message_delta") {
        deltaOutput += message.data;
        if (!textParts.size) output = deltaOutput;
      }
      if (message.type === "message_part" && message.part?.type === "text") {
        textParts.set(message.part.id, message.part.content);
        output = [...textParts.values()].join("");
      }
      if (message.type === "run_finished") {
        clearTimeout(timeout);
        assert.equal(message.success, true);
        resolve();
      }
    });
  });
  nativeConnection.send(
    runMessage(
      {
        uiSessionId: `${id}-resume-ui`,
        providerId: id,
        providerSessionId: expectedSession,
        cwd,
        prompt: "Native resume smoke",
        approvalMode,
        model: "native-test",
        effort: "medium",
        speed: "default",
      },
      runId,
    ),
  );
  await completion;
  assert.equal(sessionId, expectedSession);
  assert.equal(output, expectedText);
}

export async function transportResponse(connection, message, id, runtimeAdapter) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${runtimeAdapter} response ${id} timed out.`)),
      10_000,
    );
    connection.onMessage((received) => {
      if (received.id !== id) return;
      clearTimeout(timeout);
      resolve(received);
    });
    connection.send(message);
  });
}
