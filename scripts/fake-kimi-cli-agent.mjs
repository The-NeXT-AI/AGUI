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

if (
  process.argv.includes("provider") &&
  process.argv.includes("list") &&
  process.argv.includes("--json")
) {
  writeKimiConfig();
  process.stdout.write(`[logger] write failed: EPERM
{
  "providers": {
    "managed:kimi-code": {
      "type": "kimi"
    }
  },
  "models": {
    "kimi-code/kimi-for-coding": {
      "provider": "managed:kimi-code",
      "model": "kimi-for-coding",
      "maxContextSize": 262144,
      "capabilities": ["thinking", "always_thinking", "image_in", "video_in", "tool_use"],
      "displayName": "K2.7 Coding"
    },
    "kimi-code/kimi-test": {
      "provider": "managed:kimi-code",
      "model": "kimi-test",
      "maxContextSize": 128000,
      "displayName": "Kimi Test",
      "supportEfforts": ["low", "high", "max"],
      "defaultEffort": "high"
    }
  }
}
`);
  process.exit(0);
}

function writeKimiConfig() {
  if (!process.env.KIMI_CODE_HOME) return;
  fs.mkdirSync(process.env.KIMI_CODE_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.KIMI_CODE_HOME, "config.toml"),
    '[thinking]\neffort = "high"\n',
    "utf8",
  );
}

if (argValue("--output-format") !== "stream-json") {
  console.error(`Unexpected Kimi output format: ${argValue("--output-format") || "<missing>"}`);
  process.exit(2);
}

const prompt = argValue("-p", "--prompt");

if (!prompt) {
  console.error("Missing Kimi prompt");
  process.exit(2);
}

if (
  prompt.includes("Native resume smoke") &&
  argValue("-S", "--session") !== "kimi-native-session"
) {
  console.error(`Unexpected Kimi session: ${argValue("-S", "--session") || "<missing>"}`);
  process.exit(2);
}

if (process.env.AGUI_FAKE_KIMI_EXPECT_AUTO && !process.argv.includes("--auto")) {
  console.error("Expected Kimi --auto");
  process.exit(2);
}

if (
  process.env.AGUI_FAKE_KIMI_EXPECT_NO_YOLO &&
  (process.argv.includes("--yolo") || process.argv.includes("-y"))
) {
  console.error("Unexpected Kimi --yolo");
  process.exit(2);
}

send({
  type: "session_title_updated",
  sessionId: "kimi-native-session",
  title: "Kimi generated smoke",
});
send({
  type: "message_update",
  sessionId: "kimi-native-session",
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex: 0,
    delta: "Kimi CLI reasoning details",
  },
});
send({
  type: "message_update",
  sessionId: "kimi-native-session",
  assistantMessageEvent: { type: "text_delta", delta: "Kimi CLI " },
});
send({
  type: "tool_execution_start",
  sessionId: "kimi-native-session",
  toolExecution: {
    id: "kimi-tool",
    type: "commandExecution",
    name: "bash",
    input: { command: "printf native" },
    status: "running",
  },
});
send({
  type: "tool_execution_end",
  sessionId: "kimi-native-session",
  toolExecution: {
    id: "kimi-tool",
    type: "commandExecution",
    name: "bash",
    input: { command: "printf native" },
    output: "native",
    status: "completed",
  },
});
send({
  type: "message_update",
  sessionId: "kimi-native-session",
  assistantMessageEvent: { type: "text_delta", delta: "OK" },
});
send({
  type: "result",
  sessionId: "kimi-native-session",
  title: "Kimi generated smoke",
  result: "Kimi CLI OK",
  is_error: false,
  durationMs: 8,
  inputTokens: 6,
  outputTokens: 3,
  totalTokens: 9,
});
