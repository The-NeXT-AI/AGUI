#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "release");
const frontendSource = path.join(root, "dist");
const output = path.join(releaseRoot, "server");
const staging = path.join(releaseRoot, ".server-workspace");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packageNames = ["asp", "extensions", "runtime"];

assertFile(path.join(frontendSource, "index.html"), "Missing dist/index.html.");
assertFile(
  path.join(root, "packages", "server", "dist", "index.js"),
  "Missing server build output.",
);
assertFile(path.join(root, "pnpm-lock.yaml"), "Missing pnpm-lock.yaml.");

resetDirectory(staging);
writeStagingManifest();
copyFile(path.join(root, "pnpm-lock.yaml"), path.join(staging, "pnpm-lock.yaml"));
fs.writeFileSync(
  path.join(staging, "pnpm-workspace.yaml"),
  'packages:\n  - "packages/*"\n',
  "utf8",
);

for (const name of packageNames) copyWorkspacePackage(name);

run(packageManager, ["install", "--prod", "--no-frozen-lockfile"], staging);

fs.cpSync(path.join(root, "packages", "server", "dist"), path.join(staging, "dist"), {
  recursive: true,
});
fs.cpSync(frontendSource, path.join(staging, "dist"), { recursive: true });
for (const file of ["LICENSE", "NOTICE.md", "README.md"]) {
  copyFile(path.join(root, file), path.join(staging, file));
}

assertAbsent(path.join(staging, "node_modules", "mermaid"), "Mermaid leaked into server output.");
assertAbsent(
  path.join(staging, "node_modules", "monaco-editor"),
  "Monaco Editor leaked into server output.",
);

const bytes = directoryBytes(staging);
const maximumBytes = 300 * 1024 * 1024;
if (bytes > maximumBytes) {
  throw new Error(`Server package is unexpectedly large: ${formatBytes(bytes)} (limit 300 MiB).`);
}

removeDirectory(output);
fs.renameSync(staging, output);
console.log(`Packaged server -> ${path.relative(root, output)} (${formatBytes(bytes)})`);

function copyWorkspacePackage(name) {
  const source = path.join(root, "packages", name);
  const destination = path.join(staging, "packages", name);
  assertFile(path.join(source, "package.json"), `Missing packages/${name}/package.json.`);
  assertFile(path.join(source, "dist", "index.js"), `Missing packages/${name}/dist/index.js.`);
  fs.mkdirSync(destination, { recursive: true });
  copyFile(path.join(source, "package.json"), path.join(destination, "package.json"));
  fs.cpSync(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true });
  const schema = path.join(source, "schema");
  if (fs.existsSync(schema))
    fs.cpSync(schema, path.join(destination, "schema"), { recursive: true });
}

function writeStagingManifest() {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const serverManifest = JSON.parse(
    fs.readFileSync(path.join(root, "packages", "server", "package.json"), "utf8"),
  );
  serverManifest.packageManager = rootManifest.packageManager;
  serverManifest.pnpm = {
    onlyBuiltDependencies: rootManifest.pnpm?.onlyBuiltDependencies ?? [],
  };
  fs.writeFileSync(
    path.join(staging, "package.json"),
    `${JSON.stringify(serverManifest, null, 2)}\n`,
    "utf8",
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function assertFile(file, message) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(message);
}

function assertAbsent(target, message) {
  if (fs.existsSync(target)) throw new Error(message);
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function resetDirectory(directory) {
  removeDirectory(directory);
  fs.mkdirSync(directory, { recursive: true });
}

function removeDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved !== releaseRoot && !resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove directory outside release/: ${directory}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function directoryBytes(directory) {
  let bytes = 0;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) bytes += fs.statSync(target).size;
    }
  };
  visit(directory);
  return bytes;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
