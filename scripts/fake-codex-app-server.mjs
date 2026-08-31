#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const dumpRequestsPath = process.env.AGUI_FAKE_CODEX_DUMP_REQUESTS || "";
const expectedApprovalPolicy = process.env.AGUI_FAKE_CODEX_EXPECT_APPROVAL_POLICY || "";
const expectedSandboxType = process.env.AGUI_FAKE_CODEX_EXPECT_SANDBOX_TYPE || "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function dumpRequest(message) {
  if (!dumpRequestsPath || !message?.method) return;
  fs.appendFileSync(
    dumpRequestsPath,
    `${JSON.stringify({ method: message.method, params: message.params })}\n`,
    "utf8",
  );
}

function inputText(message) {
  return (message.params?.input ?? []).map((part) => part?.text || part?.content || "").join("\n");
}

function validateApprovalSettings(message) {
  if (!expectedApprovalPolicy && !expectedSandboxType) return true;
  const approvalPolicy = message.params?.approvalPolicy;
  const sandboxType = message.params?.sandboxPolicy?.type;
  if (
    (!expectedApprovalPolicy || approvalPolicy === expectedApprovalPolicy) &&
    (!expectedSandboxType || sandboxType === expectedSandboxType)
  ) {
    return true;
  }
  send({
    id: message.id,
    error: {
      code: -32000,
      message: `Unexpected Codex approval settings: approvalPolicy=${approvalPolicy}, sandboxPolicy.type=${sandboxType}`,
    },
  });
  return false;
}

function codexCompletedResponse(accepted = true) {
  return {
    id: "codex-native-response",
    object: "response",
    status: accepted ? "completed" : "failed",
    output: [
      {
        id: "codex-response-reasoning",
        type: "reasoning",
        status: "completed",
        summary: [],
        content: [
          {
            type: "reasoning_text",
            text: "Codex response reasoning details",
          },
        ],
      },
      {
        id: "codex-message",
        type: "message",
        role: "assistant",
        status: accepted ? "completed" : "failed",
        content: [
          {
            type: "output_text",
            text: accepted ? "Codex ASP OK" : "Codex ASP DENIED",
            annotations: [],
          },
        ],
      },
    ],
  };
}

input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  dumpRequest(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [
          {
            id: "native-test",
            model: "native-test",
            displayName: "Native Test",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "low",
                description: "Fast reasoning for simple work",
              },
              {
                reasoningEffort: "medium",
                description: "Balanced reasoning",
              },
              {
                reasoningEffort: "high",
                description: "Deeper reasoning",
              },
            ],
          },
          {
            id: "native-fast",
            model: "native-fast",
            displayName: "Native Fast",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "low",
                description: "Fast reasoning only",
              },
            ],
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (!validateApprovalSettings(message)) return;
    send({
      id: message.id,
      result: {
        thread: {
          id: "codex-native-session",
          title: "Codex generated smoke",
        },
      },
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: { ok: true, interrupted: true } });
    return;
  }
  if (message.method === "codex/raw_test") {
    send({ id: message.id, result: { ok: true, params: message.params } });
    return;
  }
  if (message.method === "turn/start") {
    if (!validateApprovalSettings(message)) return;
    if (inputText(message).includes("Prefer compatibility assertions.")) {
      send({ id: message.id, result: { turn: { id: "codex-native-steer-turn" } } });
      send({
        method: "turn/started",
        params: { turn: { id: "codex-native-steer-turn", status: "queued" } },
      });
      return;
    }
    send({ id: message.id, result: { turn: { id: "codex-native-turn" } } });
    send({
      method: "turn/started",
      params: { turn: { id: "codex-native-turn", status: "inProgress" } },
    });
    send({
      method: "thread/updated",
      params: {
        thread: {
          id: "codex-native-session",
          title: "Codex generated smoke",
        },
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: { itemId: "codex-message", delta: "Codex ASP " },
    });
    send({
      method: "item/plan/delta",
      params: { itemId: "codex-plan", delta: "1. Check compatibility\n" },
    });
    send({
      method: "item/status",
      params: { itemId: "codex-status", message: "Waiting for approval", status: "inProgress" },
    });
    send({
      method: "item/started",
      params: {
        threadId: "codex-native-session",
        turnId: "codex-native-turn",
        item: {
          id: "codex-app-server-reasoning",
          type: "reasoning",
          summary: [],
          content: [],
          status: "inProgress",
        },
      },
    });
    send({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "codex-native-session",
        turnId: "codex-native-turn",
        itemId: "codex-app-server-reasoning",
        contentIndex: 0,
        delta: "Codex app-server reasoning ",
      },
    });
    send({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "codex-native-session",
        turnId: "codex-native-turn",
        itemId: "codex-app-server-reasoning",
        contentIndex: 0,
        delta: "details",
      },
    });
    send({
      method: "rawResponseItem/completed",
      params: {
        threadId: "codex-native-session",
        turnId: "codex-native-turn",
        item: {
          id: "codex-raw-response-reasoning",
          type: "reasoning",
          summary: [],
          content: [
            {
              type: "reasoning_text",
              text: "Codex app-server reasoning details",
            },
          ],
          encrypted_content: null,
        },
      },
    });
    send({
      method: "response.output_item.added",
      params: {
        output_index: 0,
        item: {
          id: "codex-response-reasoning",
          type: "reasoning",
          summary: [],
          content: [],
          status: "in_progress",
        },
      },
    });
    send({
      method: "response.reasoning_text.delta",
      params: {
        item_id: "codex-response-reasoning",
        output_index: 0,
        content_index: 0,
        delta: "Codex response reasoning ",
      },
    });
    send({
      method: "response.reasoning_text.delta",
      params: {
        item_id: "codex-response-reasoning",
        output_index: 0,
        content_index: 0,
        delta: "details",
      },
    });
    send({
      method: "response.reasoning_text.done",
      params: {
        item_id: "codex-response-reasoning",
        output_index: 0,
        content_index: 0,
        text: "Codex response reasoning details",
      },
    });
    send({
      method: "response.output_item.done",
      params: {
        output_index: 0,
        item: {
          id: "codex-response-reasoning",
          type: "reasoning",
          summary: [],
          content: [
            {
              type: "reasoning_text",
              text: "Codex response reasoning details",
            },
          ],
          status: "completed",
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "codex-native-session",
        turnId: "codex-native-turn",
        item: {
          id: "codex-thread-item-reasoning",
          type: "reasoning",
          summary: [],
          content: ["Codex app-server reasoning details"],
        },
        completedAtMs: Date.now(),
      },
    });
    send({
      method: "item/started",
      params: {
        item: {
          id: "codex-tool",
          type: "commandExecution",
          command: "printf native",
          status: "inProgress",
        },
      },
    });
    send({
      method: "item/commandExecution/outputDelta",
      params: { itemId: "codex-tool", delta: "native" },
    });
    send({
      id: "codex-native-approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "printf native" },
    });
    return;
  }
  if (message.id === "codex-native-approval" && message.result) {
    const accepted =
      message.result.decision === "accept" || message.result.decision === "acceptForSession";
    if (!accepted) {
      send({
        method: "turn/completed",
        params: {
          threadId: "codex-native-session",
          turn: { id: "codex-native-turn", status: "failed" },
        },
      });
      return;
    }
    send({
      id: "codex-native-question",
      method: "request_user_input",
      params: {
        title: "Codex compatibility question",
        question: "Continue native adapter test?",
        questions: [
          {
            id: "continue",
            question: "Continue native adapter test?",
            options: [{ label: "OK" }, { label: "Stop" }],
          },
        ],
        app: {
          title: "Codex question app",
          html: '<div style="padding:12px;font:13px system-ui;color:#111827;">Codex request_user_input app</div>',
          height: 96,
          widgetState: { source: "codex" },
        },
      },
    });
    return;
  }
  if (message.id === "codex-native-question" && message.result) {
    const accepted = !message.result.canceled;
    send({
      method: "item/agentMessage/delta",
      params: { itemId: "codex-message", delta: accepted ? "OK" : "DENIED" },
    });
    send({
      type: "event_msg",
      payload: {
        id: "codex-message",
        type: "agent_message",
        message: accepted ? "Codex ASP OK" : "Codex ASP DENIED",
      },
    });
    send({
      type: "event_msg",
      payload: {
        id: "codex-message",
        type: "agent_message",
        message: accepted ? "Codex ASP OK" : "Codex ASP DENIED",
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          id: "codex-message",
          type: "agentMessage",
          status: accepted ? "completed" : "failed",
          text: accepted ? "Codex ASP OK" : "Codex ASP DENIED",
          metadata: {
            gatewayTrace: {
              response: codexCompletedResponse(accepted),
            },
          },
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          id: "codex-tool",
          type: "commandExecution",
          command: "printf native",
          aggregatedOutput: "native",
          status: accepted ? "completed" : "failed",
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          id: "codex-file",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "codex-compat.txt",
              diff: "@@ -0,0 +1 @@\n+Codex compatibility",
            },
          ],
        },
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "codex-native-session",
        turn: { id: "codex-native-turn", status: accepted ? "completed" : "failed" },
        response: codexCompletedResponse(accepted),
      },
    });
  }
});
