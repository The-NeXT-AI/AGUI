import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const children = new Set();
const localElectron = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron",
);
const referenceElectron = path.resolve(
  root,
  "../app/node_modules/electron/dist",
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron",
);
const devElectronBundleId = "com.agui.desktop.dev";
const devElectronName = "AGUI Dev";

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

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  if (process.platform === "darwin") {
    quitMacElectronDevApp(
      path.join(root, "node_modules", ".agui-electron", `${devElectronName}.app`),
    );
  }
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
        if (Date.now() >= deadline) reject(new Error(`Vite did not start on port ${port}.`));
        else setTimeout(probe, 100);
      });
    };
    probe();
  });
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function availablePort(startPort, attempts = 50) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`No available local port found from ${startPort}.`);
}

function waitForFile(filePath, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      if (existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`${label} was not generated within ${timeoutMs}ms.`));
        return;
      }
      setTimeout(probe, 100);
    };
    probe();
  });
}

function macElectronAppPath(electronBinary) {
  return path.dirname(path.dirname(path.dirname(electronBinary)));
}

function prepareMacElectronDevApp(sourceElectronBinary) {
  if (process.platform !== "darwin") return sourceElectronBinary;
  const sourceAppPath = macElectronAppPath(sourceElectronBinary);
  if (!sourceAppPath.endsWith(".app") || !existsSync(sourceAppPath)) return sourceElectronBinary;

  const devRoot = path.join(root, "node_modules", ".agui-electron");
  const devAppPath = path.join(devRoot, `${devElectronName}.app`);
  const devElectronBinary = path.join(devAppPath, "Contents", "MacOS", "Electron");
  const markerPath = path.join(devRoot, "source.json");
  const sourceStat = statSync(sourceElectronBinary);
  const sourceFingerprint = JSON.stringify({
    copyMode: "ditto-v2-framework-symlinks",
    sourceAppPath,
    size: sourceStat.size,
    mtimeMs: Math.round(sourceStat.mtimeMs),
  });
  const currentFingerprint = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "";

  if (!existsSync(devElectronBinary) || currentFingerprint !== sourceFingerprint) {
    mkdirSync(devRoot, { recursive: true });
    rmSync(devAppPath, { recursive: true, force: true });
    copyMacElectronAppBundle(sourceAppPath, devAppPath);
    writeFileSync(markerPath, sourceFingerprint);
  }

  normalizeMacFrameworkSymlinks(devAppPath);
  configureMacElectronDevInfoPlist(devAppPath);
  ensureMacElectronPermissionsSignature(devElectronBinary);
  registerMacElectronDevApp(devAppPath);
  console.info(`Using development Electron app: ${devAppPath}`);
  console.info(`Development Electron bundle id: ${devElectronBundleId}`);
  return devElectronBinary;
}

function copyMacElectronAppBundle(sourceAppPath, devAppPath) {
  const copy = spawnSync("/usr/bin/ditto", [sourceAppPath, devAppPath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (copy.status !== 0) {
    const output = `${copy.stdout ?? ""}${copy.stderr ?? ""}`.trim();
    throw new Error(`Failed to copy development Electron.app.\n${output}`);
  }
}

function normalizeMacFrameworkSymlinks(appPath) {
  const frameworksPath = path.join(appPath, "Contents", "Frameworks");
  if (!existsSync(frameworksPath)) return;

  for (const entry of readdirSync(frameworksPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".framework")) continue;
    normalizeVersionedFrameworkSymlinks(path.join(frameworksPath, entry.name));
  }
}

function normalizeVersionedFrameworkSymlinks(frameworkPath) {
  const versionsPath = path.join(frameworkPath, "Versions");
  const versionPath = path.join(versionsPath, "A");
  if (!existsSync(versionPath)) return;

  replaceWithSymlink(path.join(versionsPath, "Current"), "A");

  for (const entry of readdirSync(versionPath)) {
    replaceWithSymlink(path.join(frameworkPath, entry), path.join("Versions", "Current", entry));
  }
}

function replaceWithSymlink(linkPath, target) {
  let currentTarget = null;
  try {
    const existing = lstatSync(linkPath);
    if (existing.isSymbolicLink()) {
      currentTarget = readlinkSync(linkPath);
    }
  } catch {
    // Missing paths are replaced below.
  }

  if (currentTarget === target) return;
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath);
}

function registerMacElectronDevApp(devAppPath) {
  const lsregister = [
    "/System/Library/Frameworks/CoreServices.framework",
    "Frameworks/LaunchServices.framework/Support/lsregister",
  ].join("/");
  if (!existsSync(lsregister)) return;
  const registration = spawnSync(lsregister, ["-f", devAppPath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (registration.status !== 0) {
    const output = `${registration.stdout ?? ""}${registration.stderr ?? ""}`.trim();
    console.warn(`Failed to register development Electron.app with LaunchServices.\n${output}`);
  }
}

function configureMacElectronDevInfoPlist(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  setPlistString(plistPath, "CFBundleIdentifier", devElectronBundleId);
  setPlistString(plistPath, "CFBundleName", devElectronName);
  setPlistString(plistPath, "CFBundleDisplayName", devElectronName);
  setPlistString(
    plistPath,
    "NSMicrophoneUsageDescription",
    "AGUI Dev uses the microphone to turn your voice into composer text.",
  );

  const helperBundles = [
    {
      bundleId: `${devElectronBundleId}.helper`,
      displayName: `${devElectronName} Helper`,
      path: "Electron Helper.app",
    },
    {
      bundleId: `${devElectronBundleId}.helper.renderer`,
      displayName: `${devElectronName} Helper (Renderer)`,
      path: "Electron Helper (Renderer).app",
    },
    {
      bundleId: `${devElectronBundleId}.helper.gpu`,
      displayName: `${devElectronName} Helper (GPU)`,
      path: "Electron Helper (GPU).app",
    },
    {
      bundleId: `${devElectronBundleId}.helper.plugin`,
      displayName: `${devElectronName} Helper (Plugin)`,
      path: "Electron Helper (Plugin).app",
    },
  ];

  for (const helper of helperBundles) {
    const helperPlistPath = path.join(
      appPath,
      "Contents",
      "Frameworks",
      helper.path,
      "Contents",
      "Info.plist",
    );
    if (!existsSync(helperPlistPath)) continue;
    setPlistString(helperPlistPath, "CFBundleIdentifier", helper.bundleId);
    setPlistString(helperPlistPath, "CFBundleName", helper.displayName);
    setPlistString(helperPlistPath, "CFBundleDisplayName", helper.displayName);
    setPlistString(
      helperPlistPath,
      "NSMicrophoneUsageDescription",
      "AGUI Dev uses the microphone to turn your voice into composer text.",
    );
  }
}

function setPlistString(plistPath, key, value) {
  const set = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
    encoding: "utf8",
  });
  if (set.status === 0) return;
  const add = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Add :${key} string ${value}`, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (add.status !== 0) {
    const output = `${add.stdout ?? ""}${add.stderr ?? ""}`.trim();
    throw new Error(`Failed to update ${key} in development Electron Info.plist.\n${output}`);
  }
}

function ensureMacElectronPermissionsSignature(electronBinary) {
  if (process.platform !== "darwin") return;
  const appPath = macElectronAppPath(electronBinary);
  if (!appPath.endsWith(".app") || !existsSync(appPath)) return;

  const check = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  const signature = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  const entitlementCheck = spawnSync("codesign", ["-d", "--entitlements", ":-", appPath], {
    encoding: "utf8",
  });
  const entitlementsOutput = `${entitlementCheck.stdout ?? ""}${entitlementCheck.stderr ?? ""}`;
  if (
    check.status === 0 &&
    verify.status === 0 &&
    !signature.includes("Info.plist=not bound") &&
    entitlementsOutput.includes("com.apple.security.device.audio-input")
  ) {
    return;
  }

  const entitlements = path.join(root, "build", "entitlements.mac.plist");
  const args = ["--force", "--deep", "--sign", "-", appPath];
  if (existsSync(entitlements)) args.splice(4, 0, "--entitlements", entitlements);
  console.info("Signing development Electron.app so macOS can register microphone permission.");
  const sign = spawnSync("codesign", args, { encoding: "utf8", stdio: "pipe" });
  if (sign.status !== 0) {
    const output = `${sign.stdout ?? ""}${sign.stderr ?? ""}`.trim();
    throw new Error(`Failed to sign development Electron.app for macOS permissions.\n${output}`);
  }
  const signedVerify = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { encoding: "utf8" },
  );
  if (signedVerify.status !== 0) {
    const output = `${signedVerify.stdout ?? ""}${signedVerify.stderr ?? ""}`.trim();
    throw new Error(`Development Electron.app signature is invalid after signing.\n${output}`);
  }
}

function runElectronApp(electronBinary, devServerUrl) {
  if (process.platform === "darwin") {
    const appPath = macElectronAppPath(electronBinary);
    if (appPath.endsWith(".app") && existsSync(appPath)) {
      quitMacElectronDevApp(appPath);
      return run("/usr/bin/open", [
        "-n",
        "-W",
        appPath,
        "--args",
        root,
        `--dev-server-url=${devServerUrl}`,
      ]);
    }
  }
  return run(electronBinary, ["."], {
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl,
    },
  });
}

function quitMacElectronDevApp(appPath) {
  spawnSync("osascript", ["-e", `tell application id "${devElectronBundleId}" to quit`], {
    stdio: "ignore",
  });
  if (appPath) {
    spawnSync("pkill", ["-f", appPath], { stdio: "ignore" });
  }
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const sourceElectronBinary = existsSync(localElectron) ? localElectron : referenceElectron;

if (process.argv.includes("--prepare-electron-app")) {
  if (!existsSync(sourceElectronBinary)) {
    throw new Error(
      "Electron is not installed. Run `pnpm install` before preparing the desktop app.",
    );
  }
  prepareMacElectronDevApp(sourceElectronBinary);
  process.exit(0);
}

const devServerPort = await availablePort(5173);
const devServerUrl = `http://127.0.0.1:${devServerPort}`;

run(packageManager, [
  "exec",
  "tsc",
  "-b",
  "tsconfig.electron.json",
  "--watch",
  "--preserveWatchOutput",
]);
run(packageManager, [
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  String(devServerPort),
  "--strictPort",
]);

await waitForPort(devServerPort);
await waitForFile(path.join(root, "dist-electron", "main.js"), "Electron main process bundle");
if (!existsSync(sourceElectronBinary)) {
  throw new Error("Electron is not installed. Run `pnpm install` before starting the desktop app.");
}
const electronBinary = prepareMacElectronDevApp(sourceElectronBinary);
ensureMacElectronPermissionsSignature(electronBinary);
const electron = runElectronApp(electronBinary, devServerUrl);
electron.once("exit", (code) => {
  if (!stopping) stop(code ?? 0);
});
