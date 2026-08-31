#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist");
const output = path.join(root, "release", "frontend");

assertDirectory(source, "Missing frontend build output. Run pnpm build:frontend first.");
assertFile(path.join(source, "index.html"), "Missing dist/index.html.");
resetDirectory(output);
fs.cpSync(source, output, { recursive: true });

console.log(`Packaged frontend -> ${path.relative(root, output)}`);

function assertDirectory(directory, message) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(message);
  }
}

function assertFile(file, message) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(message);
  }
}

function resetDirectory(directory) {
  const releaseRoot = path.join(root, "release");
  const resolved = path.resolve(directory);
  if (resolved !== releaseRoot && !resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error(`Refusing to reset directory outside release/: ${directory}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}
