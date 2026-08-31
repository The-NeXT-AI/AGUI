import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

let electronPackageJson;
try {
  electronPackageJson = require.resolve("electron/package.json");
} catch {
  process.exit(0);
}

const electronRoot = path.dirname(electronPackageJson);
const packageJson = JSON.parse(readFileSync(electronPackageJson, "utf8"));
const platformPath = electronPlatformPath();
const electronBinary =
  process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, "dist", platformPath);
const versionFile = path.join(electronRoot, "dist", "version");
const pathFile = path.join(electronRoot, "path.txt");

if (electronBinaryInstalled()) process.exit(0);

const installScript = path.join(electronRoot, "install.js");
const result = spawnSync(process.execPath, [installScript], {
  cwd: electronRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function electronBinaryInstalled() {
  if (!existsSync(electronBinary)) return false;
  try {
    const installedVersion = readFileSync(versionFile, "utf8").trim().replace(/^v/, "");
    const installedPath = readFileSync(pathFile, "utf8").trim();
    return installedVersion === packageJson.version && installedPath === platformPath;
  } catch {
    return false;
  }
}

function electronPlatformPath() {
  const platform =
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || os.platform();
  if (platform === "mas" || platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  if (platform === "win32") return "electron.exe";
  if (platform === "freebsd" || platform === "openbsd" || platform === "linux") return "electron";
  throw new Error(`Electron builds are not available on platform: ${platform}`);
}
