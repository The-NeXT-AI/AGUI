import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import process from "node:process";

const root = process.cwd();
const children = new Set();
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeBinary = process.execPath;
const rpcPort = Number(process.env.AG_UI_RPC_PORT ?? process.env.AGUI_RPC_PORT ?? "17371");
const rpcToken =
  process.env.AG_UI_RPC_TOKEN ??
  process.env.AGUI_RPC_TOKEN ??
  randomBytes(24).toString("base64url");
const rpcUrl = `ws://127.0.0.1:${rpcPort}/agui-rpc?token=${encodeURIComponent(rpcToken)}`;

let stopping = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (code && !stopping) stop(code);
  });
  return child;
}

function runOnce(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = run(command, args, options);
    child.once("exit", (code) => {
      if (code) reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
      else resolve();
    });
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline)
          reject(new Error(`AGUI Node runtime did not start on port ${port}.`));
        else setTimeout(probe, 100);
      });
    };
    probe();
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

await runOnce(packageManager, ["--filter", "@agui/server", "build"]);
run(packageManager, [
  "exec",
  "tsc",
  "-b",
  "packages/asp",
  "packages/runtime",
  "packages/server",
  "--watch",
  "--preserveWatchOutput",
]);
run(nodeBinary, ["packages/server/dist/index.js"], {
  env: {
    ...process.env,
    AG_UI_AUTH_MODE: process.env.AG_UI_AUTH_MODE ?? process.env.AGUI_AUTH_MODE ?? "disabled",
    AG_UI_RPC_PORT: String(rpcPort),
    AG_UI_RPC_TOKEN: rpcToken,
  },
});
await waitForPort(rpcPort);
run(packageManager, ["exec", "vite", "--host", "127.0.0.1"], {
  env: {
    ...process.env,
    VITE_AGUI_RPC_URL: rpcUrl,
  },
});

console.info(`AGUI pure web runtime: ${rpcUrl}`);
