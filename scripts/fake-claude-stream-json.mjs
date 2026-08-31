#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let started = false;
let interleaveText = false;
const expectedPermissionMode = process.env.AGUI_FAKE_CLAUDE_EXPECT_PERMISSION_MODE || "";
const printMode = process.argv.includes("--print") || process.argv.includes("-p");
const screenReaderMode = process.argv.includes("--ax-screen-reader");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function permissionModeArg() {
  const index = process.argv.indexOf("--permission-mode");
  return index >= 0 ? process.argv[index + 1] : "";
}

if (
  !printMode &&
  !screenReaderMode &&
  expectedPermissionMode &&
  permissionModeArg() !== expectedPermissionMode
) {
  console.error(
    `Unexpected Claude permission mode: ${permissionModeArg() || "<missing>"}; expected ${expectedPermissionMode}`,
  );
  process.exit(2);
}

function sendInteractiveModelPicker() {
  process.stdout.write(`Select model
Switch between Claude models. For best results with Claude Code, use Sonnet 5.
1. (selected) Default (recommended) — Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok
2. Opus (1M context) — Opus 5 with 1M context · $5/$25 per Mtok
3. Sonnet — Sonnet 5 with 200k context · $3/$15 per Mtok
4. Sonnet 5 (1M context) — Sonnet 5 for long sessions · $6/$22.50 per Mtok
5. Haiku — Haiku 4.5 with 200k context · $1/$5 per Mtok
6. Zhipu AI (China) - Coding Plan/GLM-5.2 — From gateway
7. DeepSeek - Coding Plan/DeepSeek V3.2 Exp — From gateway
8. V2EX/Qwen — From gateway
9. Qwen3-Coder (1M context) — 1049k context window
10. Kimi by Moonshot — From gateway
11. MiniMax/M2 — From gateway
12. Zhipu AI (China) - Coding Plan/GLM-5.2 (1M context) — 1049k context window
Enter selection [1-12], or Escape to cancel:
`);
}

if (screenReaderMode) {
  process.stdout.write("Claude Code v1.0.0\nmanual mode on\n> ");
}

input.on("line", (line) => {
  const trimmed = line.trim().replace(/\x1b/g, "");
  if (!trimmed) return;
  if (screenReaderMode && trimmed === "/exit") {
    process.exit(0);
  }
  if (screenReaderMode && (trimmed === "/model" || trimmed === "/models")) {
    sendInteractiveModelPicker();
    return;
  }
  if (printMode && (trimmed === "/model" || trimmed === "/models")) {
    send({
      is_error: false,
      result:
        "Current model: Sonnet 5 (effort: medium)\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.",
      type: "result",
    });
    process.exit(0);
  }
  const message = JSON.parse(line);
  if (message.type === "user" && !started) {
    started = true;
    const promptText = JSON.stringify(message.message?.content ?? "");
    if (promptText.includes("CLAUDE_AUTH_FAIL")) {
      send({
        type: "system",
        subtype: "init",
        session_id: "claude-auth-fail-session",
        apiKeySource: "none",
      });
      send({
        type: "system",
        subtype: "status",
        session_id: "claude-auth-fail-session",
        status: "requesting",
      });
      send({
        type: "result",
        session_id: "claude-auth-fail-session",
        result: "HTTP 401 Unauthorized: Invalid API key.",
        is_error: true,
        duration_ms: 5,
      });
      return;
    }
    if (promptText.includes("CLAUDE_SERVER_ERROR")) {
      send({
        type: "system",
        subtype: "init",
        session_id: "claude-server-error-session",
        cwd: process.cwd(),
      });
      send({
        type: "result",
        session_id: "claude-server-error-session",
        error: "server_error",
        result:
          "API Error: 502 status code (no body). This is a server-side issue, usually temporary.",
        is_error: true,
        duration_ms: 5,
      });
      return;
    }
    send({
      type: "stream_event",
      session_id: "claude-native-session",
      session_title: "Claude generated smoke",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "Claude ASP " },
      },
    });
    interleaveText = promptText.includes("CLAUDE_INTERLEAVE_TEXT");
    send({
      type: "stream_event",
      session_id: "claude-native-session",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "Checking Claude compatibility" },
      },
    });
    send({
      type: "stream_event",
      session_id: "claude-native-session",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "claude-tool",
          name: "Bash",
          input: { command: "printf native" },
        },
      },
    });
    send({
      type: "stream_event",
      session_id: "claude-native-session",
      event: {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "tool_use",
          id: "claude-agent-tool",
          name: "Task",
          input: {
            subagent_type: "reviewer",
            prompt: "Review ASP compatibility.",
          },
        },
      },
    });
    send({
      type: "control_request",
      session_id: "claude-native-session",
      request_id: "claude-native-approval",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "printf native" },
      },
    });
    return;
  }
  if (
    message.type === "control_response" &&
    message.response?.request_id === "claude-native-approval"
  ) {
    const accepted = message.response?.response?.behavior === "allow";
    if (!accepted) {
      send({
        type: "result",
        session_id: "claude-native-session",
        result: "Claude ASP DENIED",
        is_error: true,
        duration_ms: 7,
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
      });
      return;
    }
    send({
      type: "control_request",
      session_id: "claude-native-session",
      request_id: "claude-native-question",
      request: {
        subtype: "request_user_input",
        tool_name: "ask_user",
        input: {
          title: "Claude compatibility question",
          question: "Continue native adapter test?",
          questions: [
            {
              id: "continue",
              question: "Continue native adapter test?",
              options: [{ label: "OK" }, { label: "Stop" }],
            },
          ],
          app: {
            title: "Claude question app",
            html: '<div style="padding:12px;font:13px system-ui;color:#111827;">Claude request_user_input app</div>',
            height: 96,
            widgetState: { source: "claude" },
          },
        },
      },
    });
    return;
  }
  if (
    message.type === "control_response" &&
    message.response?.request_id === "claude-native-question"
  ) {
    const accepted = JSON.stringify(message.response?.response).includes("OK");
    send({
      type: "stream_event",
      session_id: "claude-native-session",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: accepted ? "OK" : "DENIED" },
      },
    });
    send({
      type: "assistant",
      session_id: "claude-native-session",
      message: {
        content: [
          {
            id: "claude-final-text",
            type: "text",
            text: accepted ? "Claude ASP OK" : "Claude ASP DENIED",
          },
        ],
      },
    });
    send({
      type: "user",
      session_id: "claude-native-session",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "claude-tool",
            content: "native",
            is_error: !accepted,
          },
          {
            type: "tool_result",
            tool_use_id: "claude-agent-tool",
            content: JSON.stringify({ ok: true }),
            is_error: !accepted,
          },
        ],
      },
    });
    if (interleaveText) {
      send({
        type: "stream_event",
        session_id: "claude-native-session",
        event: {
          type: "message_start",
          message: { id: "claude-second-message" },
        },
      });
      send({
        type: "stream_event",
        session_id: "claude-native-session",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "After tools" },
        },
      });
      send({
        type: "assistant",
        session_id: "claude-native-session",
        message: {
          id: "claude-second-message",
          content: [{ id: "claude-second-final-text", type: "text", text: "After tools" }],
        },
      });
    }
    send({
      type: "result",
      session_id: "claude-native-session",
      result: accepted ? "Claude ASP OK" : "Claude ASP DENIED",
      is_error: !accepted,
      duration_ms: 7,
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
    });
  }
});
