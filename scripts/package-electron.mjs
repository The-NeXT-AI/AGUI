#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nativePackages = [
  "node-pty",
  "sqlite3",
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-typescript",
];

let build;
let buildError;
try {
  build = run(packageManager, ["exec", "electron-builder", ...process.argv.slice(2)]);
} catch (error) {
  buildError = error;
}
const restore = restoreNodeNativeModules();

if (restore.status !== 0) {
  console.error("Failed to restore native modules for the local Node runtime after packaging.");
  process.exit(restore.status ?? 1);
}
if (buildError) throw buildError;
if (build?.status !== 0) process.exit(build?.status ?? 1);

function restoreNodeNativeModules() {
  const args = [];
  const storeDir = installedStoreDirectory();
  if (storeDir) args.push("--store-dir", storeDir);
  args.push("--filter", "@the-next-ai/agui-runtime", "rebuild", ...nativePackages);
  console.log("Restoring native modules for the local Node runtime...");
  return run(packageManager, args);
}

function installedStoreDirectory() {
  const modulesFile = path.join(root, "node_modules", ".modules.yaml");
  if (!fs.existsSync(modulesFile)) return "";
  const match = fs.readFileSync(modulesFile, "utf8").match(/^storeDir:\s*(.+?)\s*$/m);
  return match?.[1]?.replace(/^['"]|['"]$/g, "") ?? "";
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result;
}
