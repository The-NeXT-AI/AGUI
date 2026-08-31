#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "release", "server");
const entry = path.join(packageRoot, "dist", "index.js");

for (const file of [
  entry,
  path.join(packageRoot, "LICENSE"),
  path.join(packageRoot, "NOTICE.md"),
]) {
  assert.ok(fs.existsSync(file), `Missing packaged file: ${path.relative(packageRoot, file)}`);
}
assert.equal(fs.existsSync(path.join(packageRoot, "node_modules", "mermaid")), false);
assert.equal(fs.existsSync(path.join(packageRoot, "node_modules", "monaco-editor")), false);

await withServer({ AG_UI_AUTH_MODE: "disabled" }, async (baseUrl) => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<meta name="agui-rpc-url" content="ws:\/\/127\.0\.0\.1:/);
  assert.equal(html.includes("globalThis.__AGUI_RPC_URL__"), false);
  assert.match(html, /script-src-attr 'none'/);
});

await withServer(
  {
    AG_UI_AUTH_MODE: "webauth",
    AG_UI_WEBAUTH_PASSWORD: "package-smoke-secret",
    AG_UI_WEBAUTH_TENANT: "package-smoke-tenant",
    AG_UI_WEBAUTH_USERNAME: "package-smoke-user",
  },
  async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get("location") ?? "", /^\/auth\/login\?/);

    const loginForm = await fetch(`${baseUrl}/auth/login`);
    assert.equal(loginForm.status, 200);
    assert.match(await loginForm.text(), /autocomplete="current-password"/);

    const login = await fetch(`${baseUrl}/auth/login`, {
      body: new URLSearchParams({
        password: "package-smoke-secret",
        returnTo: "/",
        username: "package-smoke-user",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^agui_session=/);
    assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.match(login.headers.get("set-cookie") ?? "", /SameSite=Lax/i);

    const session = await fetch(`${baseUrl}/auth/session`, { headers: { cookie } });
    assert.deepEqual(await session.json(), {
      authenticated: true,
      mode: "webauth",
      tenant: { id: "package-smoke-tenant" },
      user: { id: "package-smoke-user", name: "package-smoke-user" },
    });

    const authenticated = await fetch(`${baseUrl}/`, { headers: { cookie } });
    assert.equal(authenticated.status, 200);
    assert.match(await authenticated.text(), /<meta name="agui-rpc-url"/);
  },
);

console.log("Server package and WebAuth smoke passed.");

async function withServer(environment, test) {
  const port = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agui-server-package-"));
  const child = spawn(process.execPath, [entry], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...environment,
      AG_UI_USER_DATA_DIR: userData,
      AG_UI_WEB_HOST: "127.0.0.1",
      AG_UI_WEB_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForResponse(`${baseUrl}/auth/session`, child, () => output);
    await test(baseUrl);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForResponse(url, child, output) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited early.\n${output()}`);
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Timed out waiting for packaged server: ${String(lastError)}\n${output()}`);
}
