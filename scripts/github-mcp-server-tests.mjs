import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, tools } from "../extensions/github/dist/mcp-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJson(path.join(root, "extensions", "github", "package.json"));
const mcpConfig = readJson(path.join(root, "extensions", "github", "mcp.json"));

assert.equal(manifest.contributes.mcpServers, "./mcp.json");
assert.ok(manifest.permissions.includes("agent.mcp"));
assert.ok(manifest.permissions.includes("process.spawn"));
assert.ok(manifest.permissions.includes("secrets"));
assert.deepEqual(mcpConfig.mcpServers.github.env, {
  AGUI_GITHUB_TOKEN: "${secret:AGUI_GITHUB_TOKEN}",
});
assert.equal(mcpConfig.mcpServers.github.command, "./dist/mcp-server.js");
assert.equal(
  fs.statSync(path.join(root, "extensions", "github", "dist", "mcp-server.js")).mode & 0o111,
  0o111,
);

const toolNames = new Set(tools.map((tool) => tool.name));
for (const name of [
  "github_get_issue",
  "github_create_issue_comment",
  "github_update_issue",
  "github_get_pull_request",
  "github_create_pull_request_review",
  "github_merge_pull_request",
]) {
  assert.ok(toolNames.has(name), `Missing GitHub MCP tool ${name}`);
}

{
  const calls = [];
  const result = await callTool(
    "github_create_issue_comment",
    { repository: "owner/repo", number: 42, body: "hello" },
    {
      token: "token",
      apiUrl: "https://api.github.test",
      fetch: mockFetch(calls, { id: 1, body: "hello" }),
    },
  );
  assert.equal(result.comment.id, 1);
  assert.equal(calls[0].url, "https://api.github.test/repos/owner/repo/issues/42/comments");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { body: "hello" });
}

{
  const calls = [];
  await callTool(
    "github_update_issue",
    { repository: "owner/repo", number: 42, state: "closed", labels: ["bug"] },
    { token: "token", apiUrl: "https://api.github.test", fetch: mockFetch(calls, { number: 42 }) },
  );
  assert.equal(calls[0].url, "https://api.github.test/repos/owner/repo/issues/42");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: "closed", labels: ["bug"] });
}

{
  const calls = [];
  await callTool(
    "github_merge_pull_request",
    { owner: "owner", repo: "repo", number: 7, merge_method: "squash", sha: "abc123" },
    {
      token: "token",
      apiUrl: "https://api.github.test",
      fetch: mockFetch(calls, { merged: true }),
    },
  );
  assert.equal(calls[0].url, "https://api.github.test/repos/owner/repo/pulls/7/merge");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].init.body), { merge_method: "squash", sha: "abc123" });
}

await assert.rejects(
  callTool("github_update_issue", { repository: "owner/repo", number: 42 }, { token: "token" }),
  /requires at least one update field/,
);

{
  const child = spawn(path.join(root, "extensions", "github", "dist", "mcp-server.js"), [], {
    env: { ...process.env, AGUI_GITHUB_TOKEN: "token" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const initialize = await sendMcpRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(initialize.serverInfo.name, "agui-github-mcp");
    const listed = await sendMcpRequest(child, "tools/list", {});
    assert.ok(listed.tools.some((tool) => tool.name === "github_create_issue_comment"));
  } finally {
    child.kill();
  }
}

console.log("✓ GitHub MCP server manifest and tool contracts");

function mockFetch(calls, payload) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sendMcpRequest(child, method, params) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 2000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`MCP server exited before response: code=${code} signal=${signal}`));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match?.[1]) return;
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (buffer.length < bodyEnd) return;
      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  });
}
