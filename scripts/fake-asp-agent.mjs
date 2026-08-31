import readline from "node:readline";

const ASP = "agent-server-protocol";
const VERSION = "1";
const input = readline.createInterface({ input: process.stdin });
let runId = "";
let approvalAccepted = false;
let injectedMcp = 1;
let injectedSkills = 1;
let injectedPrompts = 1;
let lastPrompt = "E2E full-flow prompt";
let completedRun = true;
let clientServiceAccepted = true;

function sessionMessages() {
  const createdAt = Date.now();
  const assistant = {
    id: "fake-assistant-message",
    role: "assistant",
    content: "ASP smoke OK",
    createdAt,
    parts: completedRun
      ? transcriptParts()
      : [{ id: "answer-1", type: "text", content: "ASP smoke OK" }],
  };
  if (completedRun) {
    assistant.toolEvents = [completedToolEvent()];
    assistant.usage = { inputTokens: 8, outputTokens: 3, totalTokens: 11 };
  }
  return [
    {
      id: "fake-user-message",
      role: "user",
      content: lastPrompt,
      createdAt: createdAt - 1000,
    },
    assistant,
  ];
}

function send(message) {
  process.stdout.write(
    `${JSON.stringify({ asp: ASP, jsonrpc: "2.0", version: VERSION, ...message })}\n`,
  );
}

function fakeCapabilities() {
  return {
    approvalModes: ["request", "auto", "full"],
    contentParts: ["text", "reasoning", "plan", "tool", "diff", "resource", "artifact", "raw"],
    diffs: true,
    createSession: true,
    closeSession: true,
    extensions: [
      {
        id: "asp.ext.run-control",
        version: "0.1.0",
        stability: "experimental",
        fallback: "core",
        methods: [{ name: "steer", requiresRun: true, safety: "write" }],
        events: [{ name: "queue.updated" }],
      },
      {
        id: "asp.ext.mcp-apps",
        version: "0.1.0",
        stability: "experimental",
        fallback: "core",
        methods: [
          { name: "resources/read", requiresRun: true, safety: "read" },
          { name: "tools/call", requiresRun: true, safety: "write" },
        ],
      },
    ],
    humanInput: true,
    models: true,
    pid: process.pid,
    protocolVersions: [VERSION],
    resumeSession: true,
    sessionHistory: true,
    sessions: true,
    toolEvents: true,
  };
}

function completedToolEvent() {
  return {
    id: "tool-1",
    kind: "commandExecution",
    name: "Fake command",
    input: { command: "printf smoke" },
    output: "smoke",
    phase: "completed",
    status: "completed",
  };
}

function sendApprovalRequest() {
  send({
    id: "approval-1",
    method: "approval_request",
    params: {
      title: "Run fake command",
      method: "execute",
      scope: "command",
      command: "printf smoke",
      options: ["allow", "allow-session", "allow-always", "deny"],
    },
  });
}

function transcriptParts() {
  return [
    { id: "reasoning-1", type: "reasoning", content: "Inspecting request" },
    { id: "plan-1", type: "plan", items: ["Approve tool", "Answer question"] },
    {
      id: "diff-1",
      type: "diff",
      path: "smoke.txt",
      content: "@@ -0,0 +1 @@\n+ASP smoke",
    },
    {
      id: "resource-1",
      type: "resource",
      title: "Smoke resource",
      uri: "file:///tmp/smoke-resource.txt",
      mimeType: "text/plain",
      content: "resource payload",
    },
    {
      id: "artifact-1",
      type: "artifact",
      artifactId: "artifact-smoke",
      title: "Smoke artifact",
      mimeType: "text/markdown",
      content: "artifact payload",
    },
    {
      id: "mcp-app-1",
      type: "artifact",
      artifactId: "mcp-app-smoke",
      title: "Smoke MCP App",
      mimeType: "application/vnd.mcp.app+html",
      metadata: {
        app: {
          title: "Smoke MCP App",
          height: 220,
          toolInput: { prompt: lastPrompt },
          toolOutput: { status: "ready" },
          widgetState: { count: 0 },
        },
      },
      content: mcpAppHtml(),
    },
    {
      id: "custom-renderer-1",
      type: "raw",
      label: "Custom renderer fallback",
      value: {
        title: "Plugin rendered custom block",
        body: "Custom renderer payload",
      },
      metadata: {
        renderer: "agui.card",
        accent: "success",
      },
    },
    {
      id: "extension-renderer-1",
      type: "raw",
      label: "Extension renderer",
      value: {
        title: "Installed extension renderer",
        body: `${injectedMcp} MCP · ${injectedSkills} skill · ${injectedPrompts} prompt`,
      },
      metadata: {
        renderer: "fixture.card",
      },
    },
    {
      id: "raw-1",
      type: "raw",
      label: "Smoke raw",
      value: { ok: true },
    },
    { id: "answer-1", type: "text", content: "ASP smoke OK" },
  ];
}

function mcpAppHtml() {
  return `<!doctype html>
<html>
  <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:white;font:14px system-ui;">
    <button id="counter" style="border:1px solid #4b5563;border-radius:8px;background:#1f2937;color:white;padding:10px 14px;">MCP app counter 0</button>
    <script>
      let count = 0;
      window.parent.postMessage({ type: "mcp-app:resize", height: 240 }, "*");
      async function activate() {
        count += 1;
        document.getElementById("counter").textContent = "MCP app counter " + count;
        if (window.openai && window.openai.setWidgetState) {
          try { await window.openai.setWidgetState({ count }); } catch {}
        }
        window.parent.postMessage({ type: "mcp-app:state", label: "clicked", count }, "*");
      }
      document.body.addEventListener("click", activate);
      window.addEventListener("message", (event) => {
        if (event.data && event.data.method === "ui/e2e-click") void activate();
      });
      window.addEventListener("mcp:notification", (event) => {
        if (event.detail && event.detail.method === "ui/e2e-click") void activate();
      });
    </script>
  </body>
</html>`;
}

input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: VERSION,
        agentInfo: { name: "fake-asp", title: "Fake ASP", version: "0.1.0" },
        capabilities: fakeCapabilities(),
      },
    });
    return;
  }
  if (message.method === "capabilities") {
    send({
      id: message.id,
      result: fakeCapabilities(),
    });
    return;
  }
  if (message.method === "list_models") {
    send({
      id: message.id,
      result: {
        models: [
          {
            id: "fake-asp",
            model: "fake-asp",
            displayName: "Fake ASP",
            isDefault: true,
          },
        ],
      },
    });
    return;
  }
  if (message.method === "new_session") {
    send({
      id: message.id,
      result: {
        session: {
          id: "fake-session-created",
          title: message.title || "New fake ASP session",
          cwd: message.cwd || process.cwd(),
          status: "active",
        },
      },
    });
    return;
  }
  if (message.method === "close_session") {
    send({
      id: message.id,
      result: { closed: true, providerSessionId: message.providerSessionId },
    });
    return;
  }
  if (message.method === "extension.invoke" && message.params?.extension === "asp.ext.mcp-apps") {
    if (message.params.method === "resources/read") {
      send({
        id: message.id,
        result: {
          extension: "asp.ext.mcp-apps",
          method: "resources/read",
          result: {
            contents: [
              {
                uri: message.params.payload?.uri || "ui://fixture/pdf-viewer.html",
                mimeType: "text/html;profile=mcp-app",
                text: '<!doctype html><html><body><main data-testid="fixture-pdf-viewer">Fixture PDF Viewer</main></body></html>',
              },
            ],
          },
        },
      });
      return;
    }
    if (message.params.method === "tools/call") {
      send({
        id: message.id,
        result: {
          extension: "asp.ext.mcp-apps",
          method: "tools/call",
          result: {
            content: [
              { type: "text", text: `called ${message.params.payload?.name || "unknown"}` },
            ],
            structuredContent: { ok: true, tool: message.params.payload?.name },
          },
        },
      });
      return;
    }
  }
  if (message.method === "list_sessions") {
    send({
      id: message.id,
      result: {
        sessions: [
          {
            id: "fake-session-1",
            title: "Fake ASP compatibility",
            cwd: process.cwd(),
            createdAt: Date.now() - 1000,
            updatedAt: Date.now(),
          },
        ],
      },
    });
    return;
  }
  if (message.method === "session_messages") {
    send({
      id: message.id,
      result: { messages: sessionMessages() },
    });
    return;
  }
  if (message.method === "resume_session") {
    send({
      id: message.id,
      result: {
        session: {
          id: message.providerSessionId || "fake-session-1",
          title: "Fake ASP compatibility",
          cwd: process.cwd(),
        },
        messages: sessionMessages(),
      },
    });
    return;
  }
  if (message.type === "run") {
    runId = message.runId;
    lastPrompt =
      typeof message.prompt === "string" && message.prompt.trim() ? message.prompt : lastPrompt;
    completedRun = false;
    injectedMcp = Array.isArray(message.mcpServers) ? message.mcpServers.length : 0;
    injectedSkills = Array.isArray(message.skills) ? message.skills.length : 0;
    injectedPrompts =
      typeof message.additionalDeveloperInstructions === "string" &&
      message.additionalDeveloperInstructions.includes("Showcase review prompt")
        ? 1
        : 0;
    send({
      type: "session_state",
      runId,
      providerSessionId: "fake-session-1",
      state: {
        providerSessionId: "fake-session-1",
        title: "Fake ASP generated title",
        cwd: process.cwd(),
        model: "fake-asp",
        effort: "medium",
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: { id: "reasoning-1", type: "reasoning", content: "Inspecting request" },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: { id: "plan-1", type: "plan", items: ["Approve tool", "Answer question"] },
    });
    send({
      type: "extension_event",
      runId,
      providerSessionId: "fake-session-1",
      extension: "asp.ext.run-control",
      event: "queue.updated",
      payload: { pending: 0 },
      fallback: "none",
    });
    send({
      type: "tool_event",
      runId,
      providerSessionId: "fake-session-1",
      toolEvent: {
        id: "tool-1",
        kind: "commandExecution",
        name: "Fake command",
        input: { command: "printf smoke" },
        phase: "started",
        status: "inProgress",
      },
    });
    if (lastPrompt.includes("client-service-smoke")) {
      clientServiceAccepted = false;
      send({
        id: "client-write-1",
        method: "client.fs.write_text_file",
        params: {
          runId,
          providerSessionId: "fake-session-1",
          path: "client-service-smoke.txt",
          content: "ASP client service OK",
        },
      });
    } else {
      clientServiceAccepted = true;
      sendApprovalRequest();
    }
    return;
  }
  if (message.id === "client-write-1" && message.result) {
    clientServiceAccepted = message.result.bytes === 21;
    sendApprovalRequest();
    return;
  }
  if (message.id === "approval-1" && message.result) {
    approvalAccepted = message.result.decision === "allow";
    send({
      id: "question-1",
      method: "question_request",
      params: {
        title: "Smoke question",
        questions: [
          {
            id: "choice",
            header: "Result",
            question: "Which result should the fake agent return?",
            options: [{ label: "OK" }, { label: "Fail" }],
          },
        ],
        app: {
          title: "Smoke question app",
          html: '<div style="padding:12px;font:13px system-ui;color:#111827;">Question-scoped MCP App</div>',
          height: 96,
          widgetState: { source: "question_request" },
        },
      },
    });
    return;
  }
  if (message.id === "question-1" && message.result) {
    const serialized = JSON.stringify(message.result);
    const answeredOk = serialized.includes("OK");
    const success = approvalAccepted && answeredOk && clientServiceAccepted;
    completedRun = true;
    send({
      type: "tool_event",
      runId,
      providerSessionId: "fake-session-1",
      toolEvent: completedToolEvent(),
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "diff-1",
        type: "diff",
        path: "smoke.txt",
        content: "@@ -0,0 +1 @@\n+ASP smoke",
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "resource-1",
        type: "resource",
        title: "Smoke resource",
        uri: "file:///tmp/smoke-resource.txt",
        mimeType: "text/plain",
        content: "resource payload",
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "artifact-1",
        type: "artifact",
        artifactId: "artifact-smoke",
        title: "Smoke artifact",
        mimeType: "text/markdown",
        content: "artifact payload",
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "mcp-app-1",
        type: "artifact",
        artifactId: "mcp-app-smoke",
        title: "Smoke MCP App",
        mimeType: "application/vnd.mcp.app+html",
        metadata: {
          app: {
            title: "Smoke MCP App",
            height: 220,
            toolInput: { prompt: lastPrompt },
            toolOutput: { status: "ready" },
            widgetState: { count: 0 },
          },
        },
        content: mcpAppHtml(),
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "custom-renderer-1",
        type: "raw",
        label: "Custom renderer fallback",
        value: {
          title: "Plugin rendered custom block",
          body: "Custom renderer payload",
        },
        metadata: {
          renderer: "agui.card",
          accent: "success",
        },
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "extension-renderer-1",
        type: "raw",
        label: "Extension renderer",
        value: {
          title: "Installed extension renderer",
          body: `${injectedMcp} MCP · ${injectedSkills} skill · ${injectedPrompts} prompt`,
        },
        metadata: {
          renderer: "fixture.card",
        },
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: {
        id: "raw-1",
        type: "raw",
        label: "Smoke raw",
        value: { ok: true },
      },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: { id: "answer-1", type: "text", content: "ASP " },
    });
    send({
      type: "message_part",
      runId,
      providerSessionId: "fake-session-1",
      part: { id: "answer-1", type: "text", content: "ASP smoke OK" },
    });
    send({
      type: "usage",
      runId,
      providerSessionId: "fake-session-1",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    });
    send({
      type: "run_finished",
      runId,
      providerSessionId: "fake-session-1",
      durationMs: 5,
      exitCode: success ? 0 : 1,
      success,
    });
  }
});
