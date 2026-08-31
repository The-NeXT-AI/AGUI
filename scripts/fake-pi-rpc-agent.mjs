#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(message, data = {}) {
  send({
    command: message.type,
    data,
    id: message.id,
    success: true,
    type: "response",
  });
}

input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "get_available_models") {
    response(message, {
      models: [
        {
          defaultEffort: "medium",
          id: "native-test",
          name: "Native Test",
          provider: "fake",
          thinkingLevels: [{ level: "off" }, { level: "low" }, { default: true, level: "medium" }],
        },
        { id: "native-plain", name: "Native Plain", provider: "fake", thinking: false },
      ],
    });
    return;
  }
  if (message.type === "get_state") {
    response(message, {
      isStreaming: false,
      messageCount: 1,
      model: "native-test",
      pendingMessageCount: 0,
      sessionId: "pi-native-session",
      sessionName: "Pi generated smoke",
      thinkingLevel: "medium",
    });
    return;
  }
  if (message.type === "get_session_stats") {
    response(message, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    return;
  }
  if (message.type === "get_messages") {
    response(message, {
      messages: [
        { id: "pi-user", role: "user", content: "Native adapter smoke" },
        { id: "pi-assistant", role: "assistant", content: "Pi RPC OK" },
      ],
    });
    return;
  }
  if (message.type === "get_available_thinking_levels") {
    response(message, { levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] });
    return;
  }
  if (
    message.type === "set_model" ||
    message.type === "set_thinking_level" ||
    message.type === "set_steering_mode" ||
    message.type === "set_follow_up_mode" ||
    message.type === "steer" ||
    message.type === "follow_up" ||
    message.type === "compact" ||
    message.type === "cycle_model" ||
    message.type === "cycle_thinking_level" ||
    message.type === "abort" ||
    message.type === "new_session"
  ) {
    response(message);
    return;
  }
  if (message.type === "prompt") {
    response(message);
    send({
      sessionId: "pi-native-session",
      sessionName: "Pi generated smoke",
      type: "session_title_updated",
    });
    send({
      id: "pi-confirm",
      message: "Allow Pi compatibility command?",
      method: "confirm",
      title: "Pi confirmation",
      type: "extension_ui_request",
    });
    return;
  }
  if (message.type === "extension_ui_response" && message.id === "pi-confirm") {
    if (!message.confirmed) {
      send({ type: "agent_settled" });
      return;
    }
    send({
      id: "pi-question",
      message: "Continue native adapter test?",
      method: "select",
      options: [
        { label: "OK", value: "OK" },
        { label: "Stop", value: "Stop" },
      ],
      title: "Pi question",
      type: "extension_ui_request",
    });
    return;
  }
  if (message.type === "extension_ui_response" && message.id === "pi-question") {
    send({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: "Checking Pi compatibility",
        type: "thinking_delta",
      },
      type: "message_update",
    });
    send({
      message: "Queue drained",
      type: "queue_update",
    });
    send({
      assistantMessageEvent: { delta: "Pi RPC ", type: "text_delta" },
      type: "message_update",
    });
    send({
      toolExecution: {
        id: "pi-tool",
        input: { command: "printf native" },
        name: "bash",
        status: "pending",
        type: "commandExecution",
      },
      type: "tool_execution_start",
    });
    send({
      toolExecution: {
        id: "pi-tool",
        input: { command: "printf native" },
        name: "bash",
        output: "native",
        status: "completed",
        type: "commandExecution",
      },
      type: "tool_execution_end",
    });
    send({
      assistantMessageEvent: { delta: "OK", type: "text_delta" },
      type: "message_update",
    });
    send({ type: "agent_settled" });
  }
});
