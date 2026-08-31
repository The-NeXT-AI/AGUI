import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cdp,
  corruptShowcaseArchive,
  crashingExtension,
  escapingPathExtension,
  exitingExtension,
  hangingExtension,
  invalidEngineExtension,
  invalidNamespaceExtension,
  invalidUiSchemaExtension,
  oversizedDirectoryExtension,
  pass,
  root,
  rpc,
  rpcPort,
  securityUiExtension,
  showcaseArchive,
  showcaseUpgradeArchive,
  staleSecretV1Extension,
  staleSecretV2Extension,
  unsupportedCodexPlugin,
  userDataDir,
  workspaceFixtureRoot,
  zipSlipArchive,
} from "./e2e-electron-state.mjs";
import { waitUntil } from "./e2e-electron-driver.mjs";
import {
  ensureDetailPanelOpen,
  openSidePanelPlugin,
  runCommandPaletteCommand,
  selectTheme,
  setRendererWorkspace,
} from "./e2e-electron-ui-helpers.mjs";

function findFiles(rootDir, predicate) {
  if (!fs.existsSync(rootDir)) return [];
  const matches = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(entry.name, fullPath)) matches.push(fullPath);
  }
  return matches;
}

export async function testRpcSecurity() {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${rpcPort}/agui-rpc`);
    const timeout = setTimeout(
      () => reject(new Error("Unauthenticated RPC connection was not rejected.")),
      5_000,
    );
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "terminal.run",
          params: { id: "unauthorized", command: "true" },
        }),
      );
    socket.onmessage = () => {
      clearTimeout(timeout);
      reject(new Error("Unauthenticated RPC request received a response."));
    };
    socket.onclose = (event) => {
      clearTimeout(timeout);
      try {
        assert.equal(event.code, 1008);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    socket.onerror = () => {
      // A handshake-level rejection is also an acceptable authentication result.
    };
  });
  pass("JSON-RPC rejects unauthenticated local clients");
}

export async function testInteractiveAppMessageBridge() {
  const insecureUrlError = await cdp.evaluateMainWorld(`(async () => {
    try {
      await window.agentDesktop?.interactiveApp.create({
        id: "e2e-interactive-app-insecure-url",
        url: "http://example.com/unsafe",
      });
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })()`);
  assert.match(insecureUrlError, /HTTPS or loopback HTTP/);

  const result = await cdp.evaluateMainWorld(`(async () => {
    const api = window.agentDesktop?.interactiveApp;
    if (!api) return { ok: false, error: "interactive app API unavailable" };
    const id = "e2e-interactive-app-bridge";
    let unsubscribe;
    try {
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("interactive app echo timed out")), 5000);
        unsubscribe = api.onEvent((event) => {
          if (event.id !== id || event.type !== "message" || event.message?.type !== "e2e-echo") {
            return;
          }
          clearTimeout(timeout);
          resolve(event.message);
        });
      });
      await api.create({
        id,
        title: "E2E interactive bridge",
        bounds: { x: 0, y: 0, width: 10, height: 10, visible: false },
        html: '<!doctype html><html><body><script>window.aguiInteractiveApp.onMessage((message) => window.aguiInteractiveApp.postMessage({ type: "e2e-echo", message }));</script></body></html>',
      });
      const delivered = await api.postMessage({ id, message: { ping: "native-bridge" } });
      const echoed = await response;
      return { ok: delivered === true && echoed.message?.ping === "native-bridge" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      unsubscribe?.();
      await api.destroy(id).catch(() => undefined);
    }
  })()`);
  assert.equal(result.ok, true, result.error || "interactive app bridge failed");
  pass("native interactive app origin policy and preload message bridge");
}

export async function testExtensionLifecycleAndPackageSecurity() {
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: oversizedDirectoryExtension }),
    /100 MB limit/,
  );
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: invalidEngineExtension }),
    /unsupported AGUI engine/,
  );
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: invalidNamespaceExtension }),
    /namespace/,
  );
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: invalidUiSchemaExtension }),
    /Unsupported extension UI mode/,
  );
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: escapingPathExtension }),
    /escapes its package/,
  );
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: zipSlipArchive }),
    /Unsafe path/,
  );
  assert.equal(fs.existsSync(path.join(userDataDir, "escaped.txt")), false);
  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: corruptShowcaseArchive }),
    /checksum mismatch/,
  );

  const installed = await rpc.request("extensions.install", { sourcePath: showcaseArchive });
  assert.equal(installed.id, "fixture.showcase");
  assert.equal(installed.enabled, false);
  assert.ok(installed.manifest.permissions.includes("runtime.fullTrust"));
  assert.ok(installed.manifest.permissions.includes("ui.sessionTree"));
  assert.ok(installed.manifest.permissions.includes("ui.styles"));
  assert.ok(installed.manifest.permissions.includes("agent.sessionContext"));
  await assert.rejects(
    rpc.request("extensions.setEnabled", { extensionId: installed.id, enabled: true }),
    /Grant extension permissions/,
  );
  await rpc.request("extensions.grant", { extensionId: installed.id, permissions: ["commands"] });
  await assert.rejects(
    rpc.request("extensions.setEnabled", { extensionId: installed.id, enabled: true }),
    /Grant extension permissions/,
  );

  const permissions = installed.manifest.permissions;
  const granted = await rpc.request("extensions.grant", {
    extensionId: installed.id,
    permissions,
  });
  assert.deepEqual(new Set(granted.grantedPermissions), new Set(permissions));
  const enabled = await rpc.request("extensions.setEnabled", {
    extensionId: installed.id,
    enabled: true,
  });
  assert.equal(enabled.enabled, true);

  await rpc.request("extensions.setEnabled", { extensionId: installed.id, enabled: false });
  await assert.rejects(
    rpc.request("extensions.executeCommand", {
      extensionId: installed.id,
      command: "fixture.showcase.echo",
    }),
    /disabled/,
  );
  await rpc.request("extensions.setEnabled", { extensionId: installed.id, enabled: true });
  const oldVersionCommand = await rpc.request("extensions.executeCommand", {
    extensionId: installed.id,
    command: "fixture.showcase.echo",
  });
  assert.equal(oldVersionCommand.version, "1.0.0");

  const upgraded = await rpc.request("extensions.install", { sourcePath: showcaseUpgradeArchive });
  assert.equal(upgraded.manifest.version, "1.1.0");
  assert.equal(upgraded.enabled, false);
  assert.deepEqual(upgraded.grantedPermissions, []);
  assert.equal(fs.existsSync(installed.extensionPath), false);
  const installedExtensionDir = path.dirname(upgraded.extensionPath);
  const installedCopies = fs
    .readdirSync(installedExtensionDir)
    .filter((name) => name.startsWith("fixture.showcase-"));
  assert.deepEqual(installedCopies, ["fixture.showcase-1.1.0"]);
  await assert.rejects(
    rpc.request("extensions.setEnabled", { extensionId: upgraded.id, enabled: true }),
    /Grant extension permissions/,
  );
  await rpc.request("extensions.grant", {
    extensionId: upgraded.id,
    permissions: upgraded.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: upgraded.id, enabled: true });
  const upgradedCommand = await rpc.request("extensions.executeCommand", {
    extensionId: upgraded.id,
    command: "fixture.showcase.echo",
  });
  assert.equal(upgradedCommand.version, "1.1.0");

  const defaultConfiguration = await rpc.request("extensions.getConfiguration", {
    extensionId: upgraded.id,
  });
  assert.equal(
    defaultConfiguration.values["fixture.showcase.greeting"],
    "Hello from the extension",
  );
  assert.deepEqual(defaultConfiguration.configuredSecrets, []);
  console.log("→ extension configuration: reject invalid value");
  await assert.rejects(
    rpc.request("extensions.updateConfiguration", {
      extensionId: upgraded.id,
      values: { "fixture.showcase.mode": "unsupported" },
    }),
    /Invalid value/,
  );
  console.log("→ extension configuration: persist values");
  const configured = await rpc.request("extensions.updateConfiguration", {
    extensionId: upgraded.id,
    values: {
      "fixture.showcase.greeting": "Configured E2E greeting",
      "fixture.showcase.mode": "fast",
      FIXTURE_TOKEN: "fixture-e2e-secret-value",
    },
  });
  assert.equal(configured.values["fixture.showcase.greeting"], "Configured E2E greeting");
  assert.equal(configured.values.FIXTURE_TOKEN, undefined);
  assert.deepEqual(configured.configuredSecrets, ["FIXTURE_TOKEN"]);
  const firstContext = await rpc.request("extensions.executeCommand", {
    extensionId: upgraded.id,
    command: "fixture.showcase.context",
  });
  assert.deepEqual(firstContext, {
    greeting: "Configured E2E greeting",
    mode: "fast",
    secret: "fixture-e2e-secret-value",
    runs: 1,
    workspaceGreeting: "Configured E2E greeting",
    permissions: upgraded.manifest.permissions,
    workspace: { canRead: false, canWrite: false },
  });

  await assert.rejects(
    rpc.request("extensions.install", { sourcePath: unsupportedCodexPlugin }),
    /Could not find an extension manifest/,
  );

  await assert.rejects(
    rpc.request("extensions.executeCommand", {
      extensionId: upgraded.id,
      command: "fixture.showcase.storage",
      args: ["oversized", "x".repeat(65 * 1024)],
    }),
    /64 KB limit/,
  );
  await rpc.request("extensions.setEnabled", { extensionId: upgraded.id, enabled: false });
  await rpc.request("extensions.setEnabled", { extensionId: upgraded.id, enabled: true });
  const persistedContext = await rpc.request("extensions.executeCommand", {
    extensionId: upgraded.id,
    command: "fixture.showcase.context",
  });
  assert.equal(persistedContext.runs, 2);
  assert.equal(persistedContext.workspaceGreeting, "Configured E2E greeting");
  const persistedStorageFiles = findFiles(userDataDir, (name) => name.startsWith("agui.sqlite3"));
  assert.ok(persistedStorageFiles.length > 0);
  assert.equal(
    persistedStorageFiles.some((file) =>
      fs.readFileSync(file).includes(Buffer.from("fixture-e2e-secret-value")),
    ),
    false,
  );

  const crashing = await rpc.request("extensions.install", { sourcePath: crashingExtension });
  await rpc.request("extensions.grant", {
    extensionId: crashing.id,
    permissions: crashing.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: crashing.id, enabled: true });
  await assert.rejects(
    rpc.request("extensions.executeCommand", {
      extensionId: crashing.id,
      command: "fixture.crashing.fail",
    }),
    /fixture activation crash/,
  );
  const afterCrash = await rpc.request("extensions.list", { workspacePath: root });
  assert.equal(afterCrash.find((record) => record.id === crashing.id)?.state, "error");
  const hostStillAlive = await rpc.request("extensions.executeCommand", {
    extensionId: upgraded.id,
    command: "fixture.showcase.echo",
    args: ["after-crash"],
  });
  assert.equal(hostStillAlive.echoed, true);
  await rpc.request("extensions.uninstall", crashing.id);

  const exiting = await rpc.request("extensions.install", { sourcePath: exitingExtension });
  await rpc.request("extensions.grant", {
    extensionId: exiting.id,
    permissions: exiting.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: exiting.id, enabled: true });
  await assert.rejects(
    rpc.request("extensions.executeCommand", {
      extensionId: exiting.id,
      command: "fixture.exiting.exit",
    }),
    /Extension host exited|stopped/,
  );
  const afterExit = await rpc.request("extensions.executeCommand", {
    extensionId: upgraded.id,
    command: "fixture.showcase.echo",
  });
  assert.equal(afterExit.version, "1.1.0");
  await rpc.request("extensions.uninstall", exiting.id);

  const hanging = await rpc.request("extensions.install", { sourcePath: hangingExtension });
  await rpc.request("extensions.grant", {
    extensionId: hanging.id,
    permissions: hanging.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: hanging.id, enabled: true });
  assert.equal(
    await rpc.request("extensions.executeCommand", {
      extensionId: hanging.id,
      command: "fixture.hanging.echo",
    }),
    true,
  );
  const disableStartedAt = Date.now();
  await rpc.request("extensions.setEnabled", { extensionId: hanging.id, enabled: false });
  assert.ok(
    Date.now() - disableStartedAt < 5_000,
    "Hanging extension cleanup was not forcibly terminated.",
  );
  await rpc.request("extensions.uninstall", hanging.id);

  const staleSecretV1 = await rpc.request("extensions.install", {
    sourcePath: staleSecretV1Extension,
  });
  await rpc.request("extensions.grant", {
    extensionId: staleSecretV1.id,
    permissions: staleSecretV1.manifest.permissions,
  });
  await rpc.request("extensions.updateConfiguration", {
    extensionId: staleSecretV1.id,
    values: { LEGACY_TOKEN: "must-not-cross-upgrade" },
  });
  await rpc.request("extensions.setEnabled", { extensionId: staleSecretV1.id, enabled: true });
  const oldSecret = await rpc.request("extensions.executeCommand", {
    extensionId: staleSecretV1.id,
    command: "fixture.stale-secret.read",
  });
  assert.equal(oldSecret.legacy, "must-not-cross-upgrade");

  const staleSecretV2 = await rpc.request("extensions.install", {
    sourcePath: staleSecretV2Extension,
  });
  await rpc.request("extensions.grant", {
    extensionId: staleSecretV2.id,
    permissions: staleSecretV2.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: staleSecretV2.id, enabled: true });
  const retiredSecret = await rpc.request("extensions.executeCommand", {
    extensionId: staleSecretV2.id,
    command: "fixture.stale-secret.read",
  });
  assert.equal(retiredSecret.legacy, null);
  await rpc.request("extensions.uninstall", staleSecretV2.id);

  pass(
    "extension package limits, full-trust gate, configuration/secrets/state persistence, atomic upgrade, cleanup, and host isolation",
  );
}

export async function testWorkspaceScopedExtensionIsolation() {
  const alpha = { workspacePath: root, workspaceId: "scope:alpha" };
  const beta = { workspacePath: workspaceFixtureRoot, workspaceId: "scope alpha" };
  const [alphaInstalled, betaInstalled] = await Promise.all([
    rpc.request("extensions.install", { sourcePath: showcaseUpgradeArchive, ...alpha }),
    rpc.request("extensions.install", { sourcePath: showcaseUpgradeArchive, ...beta }),
  ]);
  assert.equal(alphaInstalled.id, "fixture.showcase");
  assert.equal(betaInstalled.id, "fixture.showcase");
  assert.notEqual(alphaInstalled.extensionPath, betaInstalled.extensionPath);

  for (const [scope, greeting] of [
    [alpha, "Alpha workspace"],
    [beta, "Beta workspace"],
  ]) {
    await rpc.request("extensions.grant", {
      extensionId: "fixture.showcase",
      permissions: alphaInstalled.manifest.permissions,
      ...scope,
    });
    await rpc.request("extensions.updateConfiguration", {
      extensionId: "fixture.showcase",
      values: { "fixture.showcase.greeting": greeting },
      ...scope,
    });
    await rpc.request("extensions.setEnabled", {
      extensionId: "fixture.showcase",
      enabled: true,
      ...scope,
    });
  }

  const alphaSlow = rpc.request("extensions.executeCommand", {
    extensionId: "fixture.showcase",
    command: "fixture.showcase.slow",
    args: [250],
    ...alpha,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const betaDuringAlpha = rpc.request("extensions.executeCommand", {
    extensionId: "fixture.showcase",
    command: "fixture.showcase.context",
    ...beta,
  });
  const [alphaSlowResult, betaConcurrentContext] = await Promise.all([alphaSlow, betaDuringAlpha]);
  assert.equal(alphaSlowResult.greeting, "Alpha workspace");
  assert.equal(betaConcurrentContext.greeting, "Beta workspace");

  const [alphaContext, betaContext] = await Promise.all([
    rpc.request("extensions.executeCommand", {
      extensionId: "fixture.showcase",
      command: "fixture.showcase.context",
      ...alpha,
    }),
    rpc.request("extensions.executeCommand", {
      extensionId: "fixture.showcase",
      command: "fixture.showcase.context",
      ...beta,
    }),
  ]);
  assert.equal(alphaContext.greeting, "Alpha workspace");
  assert.equal(betaContext.greeting, "Beta workspace");

  const reboundRecords = await rpc.request("extensions.list", {
    workspaceId: alpha.workspaceId,
    workspacePath: beta.workspacePath,
  });
  const rebound = reboundRecords.find((record) => record.id === "fixture.showcase");
  assert.equal(rebound?.enabled, true);
  assert.deepEqual(rebound?.grantedPermissions, alphaInstalled.manifest.permissions);
  const reboundContext = await rpc.request("extensions.executeCommand", {
    extensionId: "fixture.showcase",
    command: "fixture.showcase.context",
    workspaceId: alpha.workspaceId,
    workspacePath: beta.workspacePath,
  });
  assert.equal(reboundContext.greeting, "Alpha workspace");

  const [alphaRecords, betaRecords] = await Promise.all([
    rpc.request("extensions.list", alpha),
    rpc.request("extensions.list", beta),
  ]);
  assert.equal(alphaRecords.find((record) => record.id === "fixture.showcase")?.enabled, true);
  assert.equal(betaRecords.find((record) => record.id === "fixture.showcase")?.enabled, true);

  await rpc.request("extensions.uninstall", { extensionId: "fixture.showcase", ...alpha });
  await rpc.request("extensions.uninstall", { extensionId: "fixture.showcase", ...beta });
  const restored = await rpc.request("extensions.list", { workspacePath: root, workspaceId: "" });
  assert.ok(restored.some((record) => record.id === "fixture.showcase" && record.enabled));
  pass("workspace IDs, concurrent requests, configuration, and hosts remain scope-isolated");
}

export async function testWorkspaceExtensionTrust() {
  await setRendererWorkspace(workspaceFixtureRoot);
  const records = await rpc.request("extensions.list", { workspacePath: workspaceFixtureRoot });
  const trusted = records.find((record) => record.id === "fixture.workspace-trusted");
  const limited = records.find((record) => record.id === "fixture.workspace-limited");
  const mutable = records.find((record) => record.id === "fixture.workspace-mutable");
  assert.equal(trusted?.source, "workspace");
  assert.equal(limited?.source, "workspace");
  assert.equal(mutable?.source, "workspace");
  assert.equal(trusted?.workspaceTrusted, false);

  await rpc.request("extensions.grant", {
    extensionId: trusted.id,
    permissions: trusted.manifest.permissions,
  });
  await assert.rejects(
    rpc.request("extensions.setEnabled", { extensionId: trusted.id, enabled: true }),
    /Trust this workspace/,
  );

  await cdp.clickButtonByText("Extensions");
  await cdp.waitFor(
    () => document.querySelector('article[data-extension-id="fixture.workspace-trusted"]') !== null,
    "workspace extensions discovered in UI",
  );
  await cdp.clickButtonByText("Trust");
  await cdp.waitFor(() => buttonWithText("Trusted") !== null, "trust workspace from UI");

  const trustedEnabled = await rpc.request("extensions.setEnabled", {
    extensionId: trusted.id,
    enabled: true,
  });
  assert.equal(trustedEnabled.workspaceTrusted, true);
  const workspaceCommand = await rpc.request("extensions.executeCommand", {
    extensionId: trusted.id,
    command: "fixture.workspace-trusted.echo",
  });
  assert.equal(workspaceCommand.trusted, true);
  const workspaceResources = await rpc.request("extensions.resolveAgent", {
    workspacePath: workspaceFixtureRoot,
  });
  assert.ok(workspaceResources.skills.some((skill) => skill.name === "workspace-fixture"));

  await rpc.request("extensions.grant", {
    extensionId: mutable.id,
    permissions: mutable.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: mutable.id, enabled: true });
  assert.equal(
    await rpc.request("extensions.executeCommand", {
      extensionId: mutable.id,
      command: "fixture.workspace-mutable.echo",
    }),
    true,
  );
  await rpc.request("extensions.setEnabled", { extensionId: mutable.id, enabled: false });
  fs.appendFileSync(
    path.join(workspaceFixtureRoot, ".agui", "extensions", "mutable", "extension.mjs"),
    "\n// package changed after permission grant\n",
  );
  await assert.rejects(
    rpc.request("extensions.setEnabled", { extensionId: mutable.id, enabled: true }),
    /Extension contents changed; permissions were revoked/,
  );
  const afterMutation = await rpc.request("extensions.list", {
    workspacePath: workspaceFixtureRoot,
  });
  const revokedMutable = afterMutation.find((record) => record.id === mutable.id);
  assert.equal(revokedMutable.enabled, false);
  assert.deepEqual(revokedMutable.grantedPermissions, []);

  await cdp.clickButtonByText("Extensions");
  await cdp.waitFor(() => buttonWithText("Trusted") !== null, "trusted workspace state in UI");
  await cdp.clickButtonByText("Trusted");
  await cdp.waitFor(() => buttonWithText("Trust") !== null, "remove workspace trust from UI");
  await cdp.clickButtonByText("New session");
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    "return after workspace trust",
  );

  const untrustedResources = await rpc.request("extensions.resolveAgent", {
    workspacePath: workspaceFixtureRoot,
  });
  assert.equal(untrustedResources.extensionIds.includes(trusted.id), false);
  assert.ok(untrustedResources.warnings.some((warning) => warning.includes(trusted.id)));
  await assert.rejects(
    rpc.request("extensions.executeCommand", {
      extensionId: trusted.id,
      command: "fixture.workspace-trusted.echo",
    }),
    /Workspace trust is required/,
  );
  await rpc.request("extensions.setEnabled", { extensionId: trusted.id, enabled: false });

  await rpc.request("extensions.grant", {
    extensionId: limited.id,
    permissions: limited.manifest.permissions,
  });
  const limitedEnabled = await rpc.request("extensions.setEnabled", {
    extensionId: limited.id,
    enabled: true,
  });
  assert.equal(limitedEnabled.state, "inactive");
  const limitedAsset = await rpc.request("extensions.readAsset", {
    extensionId: limited.id,
    path: "./panel.html",
  });
  assert.ok(limitedAsset.data.includes("Static limited workspace UI"));
  await assert.rejects(
    rpc.request("extensions.executeCommand", {
      extensionId: limited.id,
      command: "fixture.workspace-limited.echo",
    }),
    /Trust this workspace before running extension code/,
  );
  await rpc.request("extensions.setEnabled", { extensionId: limited.id, enabled: false });

  await setRendererWorkspace(root);
  const restored = await rpc.request("extensions.list", { workspacePath: root });
  assert.ok(restored.some((record) => record.id === "fixture.showcase" && record.enabled));
  pass("workspace discovery, trust UI, resource blocking, and limited static contribution mode");
}

export async function testExtensionUiAndResources() {
  const installed = (await rpc.request("extensions.list", { workspacePath: root })).find(
    (record) => record.id === "fixture.showcase",
  );
  assert.ok(installed);

  await cdp.waitFor(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--fixture-showcase-style-loaded")
        .trim() === "1",
    "extension global style permission",
  );

  const resources = await rpc.request("extensions.resolveAgent", {
    workspacePath: root,
  });
  assert.ok(resources.extensionIds.includes(installed.id));
  const remoteMcp = resources.mcpServers.find(
    (server) => server.id === "fixture_showcase_fixture-remote",
  );
  assert.equal(remoteMcp?.id, "fixture_showcase_fixture-remote");
  assert.equal(remoteMcp?.type, "streamablehttp");
  assert.deepEqual(remoteMcp?.headers, {
    Authorization: "Bearer fixture-e2e-secret-value",
    "X-Fixture": "remote",
  });
  assert.equal(resources.skills[0]?.name, "fixture-review");
  assert.equal(
    resources.mcpServers.find((server) => server.id === "fixture_showcase_fixture-secret")?.env
      ?.FIXTURE_TOKEN,
    "fixture-e2e-secret-value",
  );
  assert.equal(resources.prompts[0]?.id, "fixture.showcase.review-prompt");
  assert.equal(resources.prompts[0]?.autoInclude, true);

  const theme = await rpc.request("extensions.readAsset", {
    extensionId: installed.id,
    path: "./theme.json",
  });
  assert.equal(theme.encoding, "utf8");
  assert.equal(JSON.parse(theme.data).colors.accent, "#36d7e7");

  const command = await rpc.request("extensions.executeCommand", {
    extensionId: installed.id,
    command: "fixture.showcase.echo",
    args: ["e2e"],
  });
  assert.equal(command.echoed, true);
  assert.deepEqual(command.args, ["e2e"]);

  await cdp.waitFor(
    () =>
      document.querySelector(
        'agui-extension-component[data-extension-text*="Extension composer"]',
      ) !== null,
    "extension composer control",
  );
  await cdp.waitFor(
    () =>
      document.querySelector(
        'agui-extension-component[data-extension-text*="Extension header"]',
      ) !== null,
    "extension header control",
  );
  await cdp.waitFor(
    () =>
      findByText("GitHub") !== null &&
      findByText("Issues") !== null &&
      findByText("Pull Requests") !== null &&
      findByText("#42 Add repository picker") !== null,
    "extension virtual GitHub session tree",
  );
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll("[data-sidebar-tree-item='true'] button")).find((button) => button.textContent?.includes("#42 Add repository picker"))`,
  );
  await cdp.waitFor(
    () =>
      messageByText("assistant", "Issue #42: Add repository picker") !== null &&
      document.body.innerText.includes("@designer noted"),
    "extension issue session details",
  );
  await waitUntil(
    async () =>
      (await persistedExtensionSessionTree())?.nodeId === "fixture.showcase.github.issue.42",
    "extension issue session context persistence",
  );
  const issueSessionContext = await persistedExtensionSessionTree();
  assert.equal(issueSessionContext?.extensionId, "fixture.showcase");
  assert.equal(issueSessionContext?.nodeId, "fixture.showcase.github.issue.42");
  const issueSession = await persistedActiveSession();
  assert.equal(issueSession?.projectPath, root);
  assert.equal(issueSession?.cwd, root);
  assert.ok(issueSessionContext?.developerInstructions?.includes("GitHub issue #42"));

  await cdp.clickExpression(
    `Array.from(document.querySelectorAll("[data-sidebar-tree-item='true'] button")).find((button) => button.textContent?.includes("#17 Virtual session tree"))`,
  );
  await cdp.waitFor(
    () =>
      messageByText("assistant", "Pull Request #17: Virtual session tree") !== null &&
      document.body.innerText.includes("@reviewer requested"),
    "extension pull request session details",
  );
  await waitUntil(
    async () => (await persistedExtensionSessionTree())?.nodeId === "fixture.showcase.github.pr.17",
    "extension pull request session context persistence",
  );
  const prSessionContext = await persistedExtensionSessionTree();
  assert.equal(prSessionContext?.extensionId, "fixture.showcase");
  assert.equal(prSessionContext?.nodeId, "fixture.showcase.github.pr.17");

  await cdp.clickButtonByExactText("Showcase Sidebar");
  await cdp.waitFor(
    () =>
      document.querySelector(
        'agui-extension-component[data-extension-text*="Showcase sidebar online"]',
      ) !== null,
    "extension activitybar view",
  );
  await cdp.clickButtonByText("New session");
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    "return after extension sidebar view",
  );

  await ensureDetailPanelOpen();
  await openSidePanelPlugin("Showcase");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="fixture.showcase.panel"] agui-extension-component')
        ?.getAttribute("data-extension-text")
        ?.includes("Extension system online"),
    "extension detail panel",
  );
  const webComponentSecurity = await cdp.evaluate(`(() => {
    const host = document.querySelector('[data-panel-id="fixture.showcase.panel"] agui-extension-component');
    const frame = host?.shadowRoot?.querySelector('iframe');
    const parsed = new DOMParser().parseFromString(frame?.getAttribute("srcdoc") || "", "text/html");
    return {
      isolation: frame?.getAttribute("data-extension-isolation") || "",
      sandbox: frame?.getAttribute("sandbox") || "",
      csp: parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") || "",
    };
  })()`);
  assert.equal(webComponentSecurity.isolation, "sandboxed-web-component");
  assert.equal(webComponentSecurity.sandbox, "allow-scripts");
  assert.ok(webComponentSecurity.csp.includes("connect-src https: wss:"));
  assert.ok(webComponentSecurity.csp.includes("navigate-to 'none'"));

  const webviewSelector =
    '[data-panel-id="fixture.showcase.panel"] iframe[data-extension-view="showcase-webview"]';
  await cdp.waitFor(
    () =>
      document.querySelector(
        '[data-panel-id="fixture.showcase.panel"] iframe[data-extension-view="showcase-webview"]',
      ) !== null,
    "extension webview frame",
  );
  const webviewSecurity = await cdp.evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(webviewSelector)});
    return {
      sandbox: frame?.getAttribute("sandbox") || "",
      source: frame?.getAttribute("srcdoc") || "",
    };
  })()`);
  assert.ok(webviewSecurity.sandbox.includes("allow-scripts"));
  assert.equal(webviewSecurity.sandbox.includes("allow-same-origin"), false);
  assert.equal(webviewSecurity.sandbox.includes("allow-forms"), false);
  assert.ok(webviewSecurity.source.includes("connect-src https: wss:"));
  assert.ok(webviewSecurity.source.includes("window.agui="));
  assert.ok(webviewSecurity.source.includes("Webview extension online"));
  assert.ok(webviewSecurity.source.includes("blocked-by-csp"));
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="fixture.showcase.panel"] iframe')
        ?.getAttribute("data-extension-ready") === "true",
    "extension webview bridge ready",
  );
  await cdp.waitFor(() => {
    const frame = document.querySelector('[data-panel-id="fixture.showcase.panel"] iframe');
    return (
      frame?.getAttribute("data-extension-command") === "fixture.showcase.echo" &&
      frame?.getAttribute("data-extension-command-status") === "success"
    );
  }, "extension webview command bridge");

  await cdp.clickButtonByText("Extensions");
  await cdp.waitFor(
    () =>
      document
        .querySelector('article[data-extension-id="fixture.showcase"]')
        ?.textContent?.includes("v1.1.0"),
    "extension management record",
  );
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll('article[data-extension-id="fixture.showcase"] button')).find((button) => button.textContent?.includes("Configure"))`,
  );
  await cdp.waitFor(() => {
    const article = document.querySelector('article[data-extension-id="fixture.showcase"]');
    const inputs = Array.from(article?.querySelectorAll("input") || []);
    return (
      article?.textContent?.includes("Greeting") &&
      !article.textContent.includes("fixture.showcase.greeting") &&
      inputs.some((input) => input.value === "Configured E2E greeting") &&
      inputs.some((input) => input.placeholder?.includes("Configured"))
    );
  }, "extension configuration editor");
  const configurationUi = await cdp.evaluate(`(() => {
    const article = document.querySelector('article[data-extension-id="fixture.showcase"]');
    return {
      greeting: Array.from(article?.querySelectorAll('input') || []).find((input) => input.value === "Configured E2E greeting")?.value,
      hasSecretPlaceholder: Array.from(article?.querySelectorAll('input') || []).some((input) => input.placeholder?.includes("Configured")),
    };
  })()`);
  assert.equal(configurationUi.greeting, "Configured E2E greeting");
  assert.equal(configurationUi.hasSecretPlaceholder, true);
  await cdp.clickMainWorldExpression(
    `document.querySelector('article[data-extension-id="fixture.showcase"] button[aria-label="Disable extension"]')`,
    "fixture showcase disable button",
  );
  await cdp.waitFor(
    () =>
      document
        .querySelector('article[data-extension-id="fixture.showcase"]')
        ?.getAttribute("data-extension-state") === "disabled",
    "disable extension from UI",
  );
  await cdp.waitFor(() => {
    const article = document.querySelector('article[data-extension-id="fixture.showcase"]');
    return !Array.from(article?.querySelectorAll("button") || []).some((button) =>
      button.textContent?.includes("Configure"),
    );
  }, "hide extension configuration while disabled");
  await cdp.clickMainWorldExpression(
    `document.querySelector('article[data-extension-id="fixture.showcase"] button[aria-label="Enable extension"]')`,
    "fixture showcase enable button",
  );
  await cdp.waitFor(
    () => {
      const article = document.querySelector('article[data-extension-id="fixture.showcase"]');
      const state = article?.getAttribute("data-extension-state");
      const enabled = state === "active" || state === "inactive";
      const permissionDialog = Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Continue",
      );
      return enabled || permissionDialog;
    },
    "enable extension from UI or permissions dialog",
    20_000,
  );
  const hasPermissionDialog = await cdp.evaluateMainWorld(`(() =>
    Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Continue",
    )
  )()`);
  if (hasPermissionDialog) await cdp.clickButtonByText("Continue");
  await cdp.waitFor(
    () => {
      const state = document
        .querySelector('article[data-extension-id="fixture.showcase"]')
        ?.getAttribute("data-extension-state");
      return state === "active" || state === "inactive";
    },
    "enable extension from UI",
    20_000,
  );
  await cdp.waitFor(() => {
    const article = document.querySelector('article[data-extension-id="fixture.showcase"]');
    return Array.from(article?.querySelectorAll("button") || []).some((button) =>
      button.textContent?.includes("Configure"),
    );
  }, "show extension configuration after enabling");
  await cdp.clickButtonByTitle("Settings");
  await cdp.waitFor(
    () => document.body.innerText.includes("General"),
    "settings for extension theme",
  );
  await cdp.clickButtonByExactText("General");
  await cdp.waitFor(
    () => document.querySelector('select[aria-label="Theme"]') !== null,
    "theme settings",
  );
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll("select")).some((select) =>
        Array.from(select.options).some(
          (option) => option.value === "fixture.showcase.midnight-cyan",
        ),
      ),
    "extension theme contribution",
  );
  await cdp.evaluate(
    `window.__aguiExtensionThemeEvents = []; window.addEventListener("agui-theme-changed", (event) => { window.__aguiExtensionThemeEvents.push(event.detail); })`,
  );
  await selectTheme("fixture.showcase.midnight-cyan");
  await cdp.waitFor(
    () => document.documentElement.dataset.themeId === "fixture.showcase.midnight-cyan",
    "extension theme applied",
  );
  await cdp.waitFor(
    () =>
      (window.__aguiExtensionThemeEvents || []).some(
        (event) => event?.id === "fixture.showcase.midnight-cyan" && event?.type === "dark",
      ),
    "extension theme event",
  );
  const appliedTheme = await cdp.evaluate(`({
    accent: document.documentElement.style.getPropertyValue("--accent").trim(),
    eventId: (window.__aguiExtensionThemeEvents || []).find((event) => event?.id === "fixture.showcase.midnight-cyan")?.id,
    eventType: (window.__aguiExtensionThemeEvents || []).find((event) => event?.id === "fixture.showcase.midnight-cyan")?.type,
  })`);
  assert.deepEqual(appliedTheme, {
    accent: "#36d7e7",
    eventId: "fixture.showcase.midnight-cyan",
    eventType: "dark",
  });
  await selectTheme("dark");
  await cdp.waitFor(
    () =>
      document.documentElement.dataset.theme === "dark" &&
      document.documentElement.dataset.themeId !== "fixture.showcase.midnight-cyan",
    "restore base theme",
  );
  const restoredTheme = await cdp.evaluate(`({
    accent: document.documentElement.style.getPropertyValue("--accent").trim(),
    theme: document.documentElement.dataset.theme,
    themeId: document.documentElement.dataset.themeId,
  })`);
  assert.equal(restoredTheme.theme, "dark");
  assert.notEqual(restoredTheme.themeId, "fixture.showcase.midnight-cyan");
  assert.notEqual(restoredTheme.accent, "#36d7e7");
  await cdp.clickButtonByTitle("Back");
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    "return after extension theme settings",
  );
  await runCommandPaletteCommand("Open Agent Tools");
  await cdp.waitFor(
    () =>
      document.querySelector('[data-agent-resource-id="fixture_showcase_fixture-remote"]') !== null,
    "MCP resource management row",
  );
  await cdp.clickSelector('[data-agent-resource-id="fixture_showcase_fixture-remote"] button');
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-agent-resource-id="fixture_showcase_fixture-remote"]')
        ?.getAttribute("data-agent-resource-enabled") === "false",
    "disable MCP resource",
  );
  await cdp.clickSelector('[data-agent-resource-id="fixture_showcase_fixture-remote"] button');
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-agent-resource-id="fixture_showcase_fixture-remote"]')
        ?.getAttribute("data-agent-resource-enabled") === "true",
    "enable MCP resource",
  );
  await cdp.clickSelector('[data-agent-resource-id="fixture.showcase/review"] button');
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-agent-resource-id="fixture.showcase/review"]')
        ?.getAttribute("data-agent-resource-enabled") === "false",
    "disable Skill resource",
  );
  await cdp.clickSelector('[data-agent-resource-id="fixture.showcase/review"] button');
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-agent-resource-id="fixture.showcase/review"]')
        ?.getAttribute("data-agent-resource-enabled") === "true",
    "enable Skill resource",
  );
  await cdp.clickSelector('[data-agent-resource-id="fixture.showcase.review-prompt"] button');
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-agent-resource-id="fixture.showcase.review-prompt"]')
        ?.getAttribute("data-agent-resource-enabled") === "false",
    "disable Prompt resource",
  );
  await cdp.clickSelector('[data-agent-resource-id="fixture.showcase.review-prompt"] button');
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-agent-resource-id="fixture.showcase.review-prompt"]')
        ?.getAttribute("data-agent-resource-enabled") === "true",
    "enable Prompt resource",
  );
  await cdp.clickButtonByText("New session");
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    "return after extension resource settings",
  );
  pass(
    "extension UI surfaces, configuration, Web Component, sandbox Webview, theme, MCP, Skill, and Prompt controls",
  );
}

async function persistedExtensionSessionTree() {
  const active = await persistedActiveSession();
  return active?.extensionState?.sessionTree || null;
}

async function persistedActiveSession() {
  const raw = await rpc.request("storage.get", {
    key: "agui-asp-sessions",
    namespace: "renderer",
  });
  if (typeof raw !== "string" || !raw) return null;
  const state = JSON.parse(raw).state || {};
  return (state.sessions || []).find((session) => session.id === state.activeSessionId) || null;
}

export async function testExtensionUiSecurity() {
  const installed = await rpc.request("extensions.install", { sourcePath: securityUiExtension });
  assert.ok(installed.manifest.permissions.includes("process.spawn"));
  await rpc.request("extensions.grant", {
    extensionId: installed.id,
    permissions: installed.manifest.permissions.filter(
      (permission) => permission !== "process.spawn",
    ),
  });
  await assert.rejects(
    rpc.request("extensions.setEnabled", { extensionId: installed.id, enabled: true }),
    /Grant extension permissions/,
  );
  await rpc.request("extensions.grant", {
    extensionId: installed.id,
    permissions: installed.manifest.permissions,
  });
  await rpc.request("extensions.setEnabled", { extensionId: installed.id, enabled: true });
  await cdp.clickButtonByText("Extensions");
  await cdp.waitFor(
    () => document.querySelector('article[data-extension-id="fixture.security-ui"]') !== null,
    "security extension management record",
  );
  await cdp.clickButtonByText("New session");

  const resources = await rpc.request("extensions.resolveAgent", { workspacePath: root });
  assert.ok(
    resources.mcpServers.some(
      (server) => server.extensionId === installed.id && server.command === "node",
    ),
  );

  await ensureDetailPanelOpen();
  await openSidePanelPlugin("Security Webview");
  const webviewSelector = '[data-panel-id="fixture.security-ui.webview"] iframe';
  await cdp.waitFor(
    () => document.querySelector('[data-panel-id="fixture.security-ui.webview"] iframe') !== null,
    "security extension webview",
  );
  const webviewSecurity = await cdp.evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(webviewSelector)});
    const parsed = new DOMParser().parseFromString(frame?.getAttribute("srcdoc") || "", "text/html");
    const external = parsed.querySelector('script[src]');
    const extensionInline = Array.from(parsed.querySelectorAll("script:not([src])"))
      .find((script) => script.textContent?.includes("example.invalid/leak"));
    return {
      sandbox: frame?.getAttribute("sandbox") || "",
      csp: parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") || "",
      externalNonce: external?.getAttribute("nonce") ?? null,
      inlineNonce: extensionInline?.getAttribute("nonce") ?? null,
    };
  })()`);
  assert.equal(webviewSecurity.sandbox, "allow-scripts");
  assert.ok(webviewSecurity.csp.includes("img-src data:"));
  assert.equal(webviewSecurity.csp.includes("img-src data: https:"), false);
  assert.ok(webviewSecurity.csp.includes("connect-src 'none'"));
  assert.ok(webviewSecurity.csp.includes("navigate-to 'none'"));
  assert.equal(webviewSecurity.externalNonce, null);
  assert.ok(webviewSecurity.inlineNonce?.startsWith("agui-"));

  await cdp.clickButtonByTitle("Settings");
  await cdp.waitFor(
    () => document.body.innerText.includes("General"),
    "settings for malicious theme sanitizer",
  );
  await cdp.clickButtonByExactText("General");
  await cdp.waitFor(
    () => document.querySelector('select[aria-label="Theme"]') !== null,
    "theme settings",
  );
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll("select")).some((select) =>
        Array.from(select.options).some(
          (option) => option.value === "fixture.security-ui.unsafe-theme",
        ),
      ),
    "sanitized extension theme contribution",
  );
  await selectTheme("fixture.security-ui.unsafe-theme");
  await cdp.waitFor(
    () => document.documentElement.dataset.themeId === "fixture.security-ui.unsafe-theme",
    "sanitized extension theme applied",
  );
  const themeSecurity = await cdp.evaluate(`({
    accent: document.documentElement.style.getPropertyValue("--accent").trim(),
    canvas: document.documentElement.style.getPropertyValue("--bg-canvas").trim(),
    foreground: document.documentElement.style.getPropertyValue("--fg-primary").trim(),
  })`);
  assert.equal(themeSecurity.foreground, "#ffffff");
  assert.equal(/example\.invalid|url\s*\(|background\s*:/i.test(themeSecurity.accent), false);
  assert.equal(/example\.invalid|url\s*\(|background\s*:/i.test(themeSecurity.canvas), false);
  await selectTheme("dark");
  await cdp.waitFor(
    () =>
      document.documentElement.dataset.theme === "dark" &&
      document.documentElement.dataset.themeId !== "fixture.security-ui.unsafe-theme",
    "restore theme after sanitizer check",
  );
  await cdp.clickButtonByTitle("Back");

  await rpc.request("extensions.uninstall", installed.id);
  pass("extension Webview CSP, theme sanitization, and MCP permission boundaries");
}

export async function testExtensionUninstall() {
  console.log("→ extension uninstall");
  const before = await rpc.request("extensions.list", { workspacePath: root });
  const installed = before.find((record) => record.id === "fixture.showcase");
  await cdp.clickButtonByText("Extensions");
  await cdp.waitFor(
    () => document.querySelector('article[data-extension-id="fixture.showcase"]') !== null,
    "extension management record before uninstall",
  );
  await cdp.waitFor(
    () =>
      Array.from(
        document.querySelectorAll('article[data-extension-id="fixture.showcase"] button'),
      ).some((button) => button.textContent?.includes("Uninstall") && !button.disabled),
    "extension uninstall button",
  );
  await cdp.clickMainWorldExpression(
    `Array.from(document.querySelectorAll('article[data-extension-id="fixture.showcase"] button')).find((button) => button.textContent?.includes("Uninstall") && !button.disabled)`,
    "extension uninstall button",
  );
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll('[role="dialog"] button')).some(
        (button) => button.textContent?.trim() === "Uninstall",
      ),
    "extension uninstall confirmation",
  );
  await cdp.clickMainWorldExpression(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent?.trim() === "Uninstall")`,
    "extension uninstall confirmation button",
  );
  await waitUntil(async () => {
    const records = await rpc.request("extensions.list", { workspacePath: root });
    return !records.some((record) => record.id === "fixture.showcase");
  }, "extension runtime uninstall");
  const records = await rpc.request("extensions.list", { workspacePath: root });
  assert.equal(
    records.some((record) => record.id === "fixture.showcase"),
    false,
  );
  if (installed) assert.equal(fs.existsSync(installed.extensionPath), false);
  await cdp.waitFor(
    () =>
      document.querySelectorAll(
        '[data-extension-id="fixture.showcase"], [data-panel-id^="fixture.showcase"]',
      ).length === 0,
    "frontend extension contribution cleanup",
  );
  pass("extension uninstall through runtime API and contribution cleanup");
}
