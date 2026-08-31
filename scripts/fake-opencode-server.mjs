#!/usr/bin/env node
import http from "node:http";

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("fake/cli-model\n");
  process.exit(0);
}
const port = Number(args[args.indexOf("--port") + 1] || 0);
const hostname = args[args.indexOf("--hostname") + 1] || "127.0.0.1";
const clients = new Set();
let messageId = "opencode-message";
let sessionTitle = "OpenCode native smoke";

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function event(type, properties = {}) {
  const payload = JSON.stringify({ properties, type });
  for (const client of clients) client.write(`event: message\ndata: ${payload}\n\n`);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function approved(sessionId) {
  event("session.updated", {
    session: { id: sessionId, timeIdle: 0 },
    sessionID: sessionId,
  });
  event("message.part.updated", {
    part: {
      id: "opencode-reasoning",
      messageID: messageId,
      text: "Checking OpenCode compatibility",
      type: "reasoning",
    },
    sessionID: sessionId,
  });
  event("message.part.updated", {
    part: { id: "opencode-text", messageID: messageId, text: "OpenCode ", type: "text" },
    sessionID: sessionId,
  });
  event("message.part.updated", {
    part: {
      id: "opencode-file",
      messageID: messageId,
      name: "opencode-compat.txt",
      path: "opencode-compat.txt",
      type: "file",
    },
    sessionID: sessionId,
  });
  event("message.part.updated", {
    part: {
      id: "opencode-tool",
      messageID: messageId,
      state: { input: { command: "printf native" }, status: "pending" },
      tool: "bash",
      type: "tool",
    },
    sessionID: sessionId,
  });
  event("message.part.updated", {
    part: {
      id: "opencode-tool",
      messageID: messageId,
      state: { input: { command: "printf native" }, output: "native", status: "completed" },
      tool: "bash",
      type: "tool",
    },
    sessionID: sessionId,
  });
  event("todo.updated", {
    sessionID: sessionId,
    todos: [{ content: "Run native adapter smoke", status: "completed" }],
  });
  event("file.edited", {
    file: {
      path: "opencode-compat.txt",
      patch: "@@ -0,0 +1 @@\n+OpenCode compatibility",
    },
    sessionID: sessionId,
  });
  event("message.part.updated", {
    part: { id: "opencode-text", messageID: messageId, text: "OpenCode ASP OK", type: "text" },
    sessionID: sessionId,
  });
  event("message.updated", {
    message: {
      id: messageId,
      modelID: "native-test",
      tokenUsage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
    },
    sessionID: sessionId,
  });
  event("session.idle", { sessionID: sessionId });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === "/event") {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write("\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "GET" && pathname === "/config") {
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "GET" && pathname === "/config/providers") {
    if (process.env.AGUI_FAKE_OPENCODE_EMPTY_MODELS) {
      sendJson(response, []);
      return;
    }
    sendJson(response, [
      {
        id: "fake",
        name: "Fake",
        models: {
          "native-test": {
            defaultReasoningEffort: "medium",
            id: "native-test",
            name: "Native Test",
            limit: { context: 128000 },
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { default: true, reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
          },
          "native-plain": {
            id: "native-plain",
            name: "Native Plain",
            reasoning: false,
          },
        },
      },
    ]);
    return;
  }
  if (request.method === "GET" && pathname === "/agent") {
    sendJson(response, [
      {
        id: "build",
        name: "Build Agent",
        role: "primary",
        description: "Runs implementation tasks",
        tools: ["bash", "edit"],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        role: "subagent",
        description: "Reviews changes before handoff",
        tools: ["bash"],
      },
    ]);
    return;
  }
  if (request.method === "GET" && pathname === "/session") {
    sendJson(response, [
      {
        id: "opencode-native-session",
        title: sessionTitle,
        timeCreated: Date.now(),
        timeUpdated: Date.now(),
      },
    ]);
    return;
  }
  if (request.method === "POST" && pathname === "/session") {
    await body(request);
    sessionTitle = "OpenCode generated smoke";
    sendJson(response, {
      id: "opencode-native-session",
      title: sessionTitle,
      timeCreated: Date.now(),
      timeUpdated: Date.now(),
    });
    return;
  }
  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    sendJson(response, {
      id: decodeURIComponent(sessionMatch[1]),
      title: sessionTitle,
      timeCreated: Date.now(),
      timeUpdated: Date.now(),
    });
    return;
  }
  if (request.method === "POST" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const payload = await body(request);
    sessionTitle = payload.title || sessionTitle;
    event("session.updated", {
      session: {
        id: sessionId,
        title: sessionTitle,
        timeCreated: Date.now(),
        timeUpdated: Date.now(),
      },
      sessionID: sessionId,
    });
    sendJson(response, {
      id: sessionId,
      title: sessionTitle,
      timeCreated: Date.now(),
      timeUpdated: Date.now(),
    });
    return;
  }
  const messagesMatch = pathname.match(/^\/session\/([^/]+)\/message$/);
  if (request.method === "GET" && messagesMatch) {
    sendJson(response, [
      {
        info: { id: messageId, role: "assistant", timeCreated: Date.now() },
        parts: [
          { id: "opencode-reasoning", text: "Checking OpenCode compatibility", type: "reasoning" },
          { id: "opencode-text", text: "OpenCode ASP OK", type: "text" },
          {
            id: "opencode-tool",
            state: { input: { command: "printf native" }, output: "native", status: "completed" },
            tool: "bash",
            type: "tool",
          },
        ],
      },
    ]);
    return;
  }
  const promptMatch = pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (request.method === "POST" && promptMatch) {
    const sessionId = decodeURIComponent(promptMatch[1]);
    const payload = await body(request);
    messageId = payload.messageID || messageId;
    sendJson(response, { ok: true });
    setTimeout(() => {
      event("permission.updated", {
        permission: {
          id: "opencode-native-approval",
          metadata: { command: "printf native" },
          sessionID: sessionId,
          status: "pending",
          type: "bash",
        },
        sessionID: sessionId,
      });
    }, 10);
    return;
  }
  const compactMatch = pathname.match(/^\/session\/([^/]+)\/compact$/);
  if (request.method === "POST" && compactMatch) {
    const sessionId = decodeURIComponent(compactMatch[1]);
    const payload = await body(request);
    event("session.compact", {
      instructions: payload.instructions,
      session: {
        id: sessionId,
        title: sessionTitle,
        timeCreated: Date.now(),
        timeUpdated: Date.now(),
      },
      sessionID: sessionId,
    });
    sendJson(response, { ok: true, compacted: true, sessionId });
    return;
  }
  const permissionMatch = pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
  if (request.method === "POST" && permissionMatch) {
    const sessionId = decodeURIComponent(permissionMatch[1]);
    const payload = await body(request);
    sendJson(response, { ok: true });
    setTimeout(() => {
      if (payload.response === "once" || payload.response === "always") approved(sessionId);
      else
        event("session.error", { error: { message: "Permission rejected" }, sessionID: sessionId });
    }, 10);
    return;
  }
  const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/);
  if (request.method === "POST" && abortMatch) {
    await body(request).catch(() => undefined);
    sendJson(response, { ok: true });
    return;
  }
  sendJson(response, { message: `Unhandled ${request.method} ${pathname}` }, 404);
});

server.listen(port, hostname);
