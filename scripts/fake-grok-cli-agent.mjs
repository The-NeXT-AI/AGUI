#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function argValue(...names) {
  for (const name of names) {
    const index = process.argv.indexOf(name);
    if (index >= 0) return process.argv[index + 1] || "";
    const prefix = `${name}=`;
    const match = process.argv.find((arg) => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
  }
  return "";
}

if (process.argv.includes("agent") || process.argv.includes("stdio")) {
  console.error("fake Grok CLI must not be started through agent stdio");
  process.exit(2);
}

if (process.argv.includes("models")) {
  writeModelsCache();
  process.stdout.write(`Default model: native-test

Available models:
  * native-test (default)
  - native-fast
`);
  process.exit(0);
}

function writeModelsCache() {
  if (!process.env.GROK_HOME) return;
  fs.mkdirSync(process.env.GROK_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.GROK_HOME, "models_cache.json"),
    `${JSON.stringify(
      {
        fetched_at: "2026-08-25T00:00:00.000Z",
        grok_version: "test",
        models: {
          "native-test": {
            info: {
              id: "native-test",
              model: "native-test",
              name: "Native Test",
              context_window: 128000,
              hidden: false,
              reasoning_effort: "medium",
              supports_reasoning_effort: true,
              reasoning_efforts: [
                { value: "low", default: false },
                { value: "medium", default: true },
                { value: "high", default: false },
              ],
            },
          },
          "native-fast": {
            info: {
              id: "native-fast",
              model: "native-fast",
              name: "Native Fast",
              context_window: 64000,
              hidden: false,
              reasoning_effort: "low",
              supports_reasoning_effort: true,
              reasoning_efforts: [{ value: "low", default: true }],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

if (argValue("--output-format") !== "streaming-messages-json") {
  console.error(`Unexpected Grok output format: ${argValue("--output-format") || "<missing>"}`);
  process.exit(2);
}

if (!process.argv.includes("--include-partial-messages")) {
  console.error("Missing Grok partial message flag");
  process.exit(2);
}

const prompt = argValue("-p", "--single");

if (!prompt) {
  console.error("Missing Grok single prompt");
  process.exit(2);
}

if (
  prompt.includes("Native resume smoke") &&
  argValue("-r", "--resume") !== "grok-native-session"
) {
  console.error(`Unexpected Grok resume session: ${argValue("-r", "--resume") || "<missing>"}`);
  process.exit(2);
}

if (
  process.env.AGUI_FAKE_GROK_EXPECT_PERMISSION_MODE &&
  argValue("--permission-mode") !== process.env.AGUI_FAKE_GROK_EXPECT_PERMISSION_MODE
) {
  console.error(
    `Unexpected Grok permission mode: ${argValue("--permission-mode") || "<missing>"}; expected ${process.env.AGUI_FAKE_GROK_EXPECT_PERMISSION_MODE}`,
  );
  process.exit(2);
}

send({
  type: "stream_event",
  session_id: "grok-native-session",
  session_title: "Grok generated smoke",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "Grok CLI reasoning details" },
  },
});
send({
  type: "stream_event",
  session_id: "grok-native-session",
  event: {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "Grok CLI " },
  },
});
send({
  type: "stream_event",
  session_id: "grok-native-session",
  event: {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "grok-tool",
      name: "read_file",
      input: { path: "README.md" },
    },
  },
});
send({
  type: "user",
  session_id: "grok-native-session",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "grok-tool",
        content: JSON.stringify({ lines: 1 }),
      },
    ],
  },
});
send({
  type: "stream_event",
  session_id: "grok-native-session",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "OK" },
  },
});
send({
  type: "assistant",
  session_id: "grok-native-session",
  message: {
    content: [{ id: "grok-final-text", type: "text", text: "Grok CLI OK" }],
  },
});
send({
  type: "result",
  session_id: "grok-native-session",
  result: "Grok CLI OK",
  is_error: false,
  duration_ms: 7,
  input_tokens: 8,
  output_tokens: 3,
  total_tokens: 11,
});
