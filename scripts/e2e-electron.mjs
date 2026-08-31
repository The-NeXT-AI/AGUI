import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  Cdp,
  JsonRpc,
  freePort,
  waitForCdpPage,
  waitForHealth,
  waitUntil,
} from "./e2e-electron-driver.mjs";
import {
  testExtensionLifecycleAndPackageSecurity,
  testExtensionUiAndResources,
  testExtensionUiSecurity,
  testExtensionUninstall,
  testInteractiveAppMessageBridge,
  testRpcSecurity,
  testWorkspaceExtensionTrust,
  testWorkspaceScopedExtensionIsolation,
} from "./e2e-electron-extension-tests.mjs";
import { ensureBuilt, prepareGeneratedExtensionFixtures } from "./e2e-electron-fixtures.mjs";
import {
  testBrowserAutomationPlugin,
  testEcosystemPlugins,
  testRightSidePlugins,
  testSettingsAndLayoutToggles,
} from "./e2e-electron-plugin-tests.mjs";
import {
  aguiHomeDir,
  cdp,
  cdpPort,
  codexReasoningProviderId,
  electron,
  electronBin,
  fakeAgent,
  fakeCodexAgent,
  generatedFixturesRoot,
  pageHelperScript,
  pass,
  providerId,
  results,
  root,
  rpc,
  rpcPort,
  rpcToken,
  setCdp,
  setElectron,
  setPorts,
  setRpc,
  shuttingDown,
  stopElectron,
  userDataDir,
  workspaceName,
} from "./e2e-electron-state.mjs";
import {
  clickSidebarNewSession,
  clickSessionRowAction,
  runCommandPaletteCommand,
  sessionCountInStorage,
  waitForDeleteConfirmation,
  waitForProjectDraftState,
  waitForToolbar,
} from "./e2e-electron-ui-helpers.mjs";

const allocatedCdpPort = await freePort();
const allocatedRpcPort = await freePort();
setPorts(allocatedCdpPort, allocatedRpcPort);

async function main() {
  try {
    await ensureBuilt();
    prepareGeneratedExtensionFixtures();
    setElectron(
      spawn(
        electronBin,
        [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, "."],
        {
          cwd: root,
          env: {
            ...process.env,
            AGUI_E2E: "1",
            AG_UI_DISABLE_SYSTEM_NOTIFICATIONS: "1",
            AG_UI_HOME: aguiHomeDir,
            AG_UI_RPC_PORT: String(rpcPort),
            AG_UI_RPC_TOKEN: rpcToken,
            AG_UI_TENANT_WORKSPACE_ROOTS: [root, generatedFixturesRoot].join(path.delimiter),
            HOME: userDataDir,
            USERPROFILE: userDataDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    electron.stdout.on("data", (chunk) => process.stdout.write(chunk));
    electron.stderr.on("data", (chunk) => process.stderr.write(chunk));
    electron.on("exit", (code, signal) => {
      if (!shuttingDown && code !== 0) {
        console.error(`Electron exited unexpectedly: code=${code} signal=${signal}`);
      }
    });

    const page = await waitForCdpPage(cdpPort, { preferApp: true });
    await waitForHealth(rpcPort);
    setRpc(await JsonRpc.connect(`ws://127.0.0.1:${rpcPort}/agui-rpc?token=${rpcToken}`));
    setCdp(await Cdp.connect(page.webSocketDebuggerUrl));

    if (process.env.AGUI_E2E_ONLY === "right-side-plugins") {
      await installFakeProvider();
      await prepareRenderer();
      await testRightSidePlugins();
      console.log("E2E passed: right-side plugins.");
      return;
    }
    if (process.env.AGUI_E2E_ONLY === "codex-reasoning") {
      await installCodexReasoningProvider();
      await prepareRenderer(codexReasoningProviderId);
      await testCodexReasoningDetails();
      console.log("E2E passed: Codex reasoning details.");
      return;
    }

    await testRpcSecurity();
    await installFakeProvider();
    await prepareRenderer();
    if (process.env.AGUI_E2E_ONLY === "mcp-app") {
      await testInteractiveAppMessageBridge();
      await testExtensionLifecycleAndPackageSecurity();
      await testAgentConversationFlow();
      console.log("E2E passed: native MCP app messaging and persisted model context.");
      return;
    }
    if (process.env.AGUI_E2E_ONLY === "extensions") {
      await testInteractiveAppMessageBridge();
      await testExtensionLifecycleAndPackageSecurity();
      await testWorkspaceScopedExtensionIsolation();
      await testWorkspaceExtensionTrust();
      await testExtensionUiAndResources();
      await testExtensionUiSecurity();
      await testExtensionUninstall();
      console.log("E2E passed: extension lifecycle, isolation, UI, security, and cleanup.");
      return;
    }
    await testInteractiveAppMessageBridge();
    await testExtensionLifecycleAndPackageSecurity();
    await testWorkspaceScopedExtensionIsolation();
    await testWorkspaceExtensionTrust();
    await testExtensionUiAndResources();
    await testExtensionUiSecurity();
    await testRuntimeTransports();
    await testLaunchAndCoreMenus();
    await testAgentConversationFlow();
    await testSearchRenameBranchAndDelete();
    await testExtensionUninstall();
    await testRightSidePlugins();
    await testEcosystemPlugins();
    await testSettingsAndLayoutToggles();
    await testBrowserAutomationPlugin();

    console.log(
      `E2E passed: ${results.length} checks across extension lifecycle/security, runtime, chat, dialogs, plugins, settings, and layout.`,
    );
  } finally {
    try {
      if (rpc) await rpc.request("providers.remove", providerId).catch(() => undefined);
      if (rpc)
        await rpc.request("providers.remove", codexReasoningProviderId).catch(() => undefined);
    } finally {
      rpc?.close();
      await cdp?.close();
      await stopElectron();
      await removeUserDataDir(userDataDir);
    }
  }
}

async function removeUserDataDir(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}

async function installFakeProvider() {
  await rpc.request("providers.save", {
    id: providerId,
    name: "E2E Fake ASP",
    description: "Deterministic end-to-end fake ASP provider",
    command: process.execPath,
    args: [fakeAgent],
    env: {},
    enabled: true,
    transport: "stdio",
    timeoutMs: 20_000,
    capabilities: {
      approvalModes: ["request", "auto", "full"],
      contentParts: ["text", "reasoning", "plan", "tool", "diff", "resource", "artifact", "raw"],
      diffs: true,
      humanInput: true,
      models: true,
      reasoningEfforts: ["medium", "high"],
      speeds: ["default", "fast"],
      sessions: true,
      sessionHistory: true,
      resumeSession: true,
      toolEvents: true,
      workspace: true,
    },
    models: [
      {
        id: "fake-asp",
        model: "fake-asp",
        displayName: "Fake ASP",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"],
        supportedSpeeds: ["default", "fast"],
      },
    ],
  });
}

async function installCodexReasoningProvider() {
  await rpc.request("providers.save", {
    id: codexReasoningProviderId,
    name: "E2E Codex Reasoning",
    description: "Deterministic Codex runtime adapter reasoning provider",
    command: fakeCodexAgent,
    args: [],
    env: {},
    enabled: true,
    transport: "stdio",
    timeoutMs: 20_000,
    capabilities: {
      approvalModes: ["request", "auto", "full"],
      contentParts: ["text", "reasoning", "plan", "tool", "diff", "status"],
      diffs: true,
      humanInput: true,
      models: true,
      reasoningEfforts: ["medium", "high"],
      runtimeAdapter: "codex-app-server",
      speeds: ["default"],
      toolEvents: true,
      wireProtocol: "codex-app-server",
      workspace: true,
    },
    models: [
      {
        id: "codex-reasoning",
        model: "codex-reasoning",
        displayName: "Codex Reasoning",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"],
        supportedSpeeds: ["default"],
      },
    ],
  });
}

async function prepareRenderer(activeProviderId = providerId) {
  await initializeCdpForApp();
  await rpc.request("storage.set", {
    key: "agui-asp-preferences",
    namespace: "renderer",
    value: JSON.stringify({
      state: { activeProviderId, workspacePath: root },
      version: 0,
    }),
  });
  await rpc.request("storage.set", {
    key: "agui-asp-sessions",
    namespace: "renderer",
    value: JSON.stringify({
      state: { sessions: [], activeSessionId: null, openTabs: [] },
      version: 0,
    }),
  });
  await cdp.evaluateMainWorld(`
    localStorage.clear();
  `);
  await cdp.call("Page.reload", { ignoreCache: true });
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    "new session landing",
  );
  await cdp.evaluate(pageHelperScript);
}

async function persistedChatState() {
  const raw = await rpc.request("storage.get", {
    key: "agui-asp-sessions",
    namespace: "renderer",
  });
  if (typeof raw !== "string" || !raw) return {};
  return JSON.parse(raw).state || {};
}

async function initializeCdpForApp() {
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");
  await cdp.captureMainFrame();
  await cdp.call("Page.bringToFront");
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: pageHelperScript });
  await cdp.evaluate(pageHelperScript);
}

async function testRuntimeTransports() {
  const info = await rpc.request("runtime.info");
  assert.equal(info.platform, process.platform);
  assert.equal(info.features.webview, false);
  assert.equal(info.features.webContentsView, true);
  assert.equal(info.features.browserAutomation, true);
  const providers = await rpc.request("providers.list");
  assert.ok(providers.some((provider) => provider.id === providerId));
  const tree = await rpc.request("ide.tree", { root });
  assert.equal(tree.name, workspaceName);
  const file = await rpc.request("ide.readFile", {
    root,
    filePath: path.join(root, "packages", "app", "src", "asp", "desktop-api.ts"),
  });
  const semantic = await rpc.request("ide.semanticTokens", {
    root,
    filePath: file.path,
    content: file.content,
  });
  assert.ok(semantic.data.length > 100);

  const terminalId = `rpc-e2e-${Date.now()}`;
  const terminalEvents = [];
  const unsubscribe = rpc.on("agui:terminal:event", (event) => terminalEvents.push(event));
  await rpc.request("terminal.create", { id: terminalId, cwd: root });
  await waitUntil(
    () => terminalEvents.some((event) => event.id === terminalId && event.type === "ready"),
    "RPC terminal ready",
  );
  terminalEvents.length = 0;
  await rpc.request("terminal.create", { id: terminalId, cwd: root });
  await waitUntil(
    () => terminalEvents.some((event) => event.id === terminalId && event.type === "ready"),
    "RPC terminal replace ready",
  );
  terminalEvents.length = 0;
  assert.equal(
    await rpc.request("terminal.write", { id: terminalId, data: "printf RPC_TERMINAL_REPLACED\r" }),
    true,
  );
  await waitUntil(
    () =>
      terminalEvents.some(
        (event) =>
          event.id === terminalId &&
          event.type === "stdout" &&
          String(event.chunk).includes("RPC_TERMINAL_REPLACED"),
      ),
    "RPC terminal remains writable after replacement",
  );
  await rpc.request("terminal.dispose", terminalId);
  unsubscribe();

  const bridge = await cdp.evaluateMainWorld(`(async () => {
    const providers = await window.agentDesktop.providers.list();
    const tree = await window.agentDesktop.ide.tree({ root: ${JSON.stringify(root)} });
    return {
      hasBridge: Boolean(window.agentDesktop),
      platform: window.agentDesktop.platform,
      providers: providers.length,
      treeName: tree.name,
      desktopDataset: document.documentElement.dataset.desktop,
    };
  })()`);
  assert.equal(bridge.hasBridge, true);
  assert.equal(bridge.platform, process.platform);
  assert.equal(bridge.treeName, workspaceName);
  assert.equal(bridge.desktopDataset, "electron");
  pass("runtime transport: Electron bridge + WebSocket JSON-RPC + terminal notifications");
}

async function testCodexReasoningDetails() {
  await cdp.setTextarea("Codex reasoning e2e prompt");
  await cdp.clickButtonByTitle("Send");
  await cdp.waitFor(
    () => document.body.innerText.includes("Allow E2E Codex Reasoning to run this command?"),
    "codex approval card",
  );
  await cdp.clickButtonByText("Allow once");
  await cdp.waitFor(
    () => document.body.innerText.includes("Codex compatibility question"),
    "codex question dialog",
  );
  await cdp.clickButtonByText("OK");
  await cdp.clickButtonByText("Submit answers");
  await cdp.waitFor(
    () => document.body.innerText.includes("File change"),
    "codex run completion",
    15_000,
  );
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.includes("Reasoning") && window.__aguiE2e.isVisible(button),
      ),
    "codex reasoning header",
  );
  const collapsed = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("Reasoning") &&
      window.__aguiE2e.isVisible(item)
    );
    const region = button?.nextElementSibling;
    const style = region ? getComputedStyle(region) : null;
    return {
      hasRegion: Boolean(region?.matches("[data-collapsible-region]")),
      open: region?.getAttribute("data-open") ?? null,
      transitionProperty: style?.transitionProperty ?? "",
    };
  })()`);
  assert.equal(collapsed.hasRegion, true);
  assert.equal(collapsed.open, "false");
  assert.match(collapsed.transitionProperty, /grid-template-rows|all/);
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Reasoning") && window.__aguiE2e.isVisible(button))`,
  );
  await cdp.waitFor(() => {
    const detail = window.__aguiE2e.findByText("Codex app-server reasoning details");
    return Boolean(detail && window.__aguiE2e.isVisible(detail));
  }, "codex reasoning detail text");
  const expanded = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("Reasoning") &&
      window.__aguiE2e.isVisible(item)
    );
    return button?.nextElementSibling?.getAttribute("data-open") ?? null;
  })()`);
  assert.equal(expanded, "true");
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Reasoning") && window.__aguiE2e.isVisible(button))`,
  );
  await cdp.waitFor(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("Reasoning") && window.__aguiE2e.isVisible(item),
    );
    return button?.nextElementSibling?.getAttribute("data-open") === "false";
  }, "codex reasoning collapse");
  const state = await persistedChatState().then((store) => {
    const session = store.sessions[0];
    return {
      hasReasoningBlock: session.blocks.some(
        (block) =>
          block.kind === "reasoning" && block.text.includes("Codex app-server reasoning details"),
      ),
      hasEmptyReasoningTool: session.blocks.some(
        (block) => block.kind === "tool" && block.toolKind === "reasoning" && !block.output,
      ),
      pageText: null,
    };
  });
  state.pageText = await cdp.evaluate("document.body.innerText");
  assert.equal(state.hasReasoningBlock, true);
  assert.equal(state.hasEmptyReasoningTool, false);
  assert.equal(state.pageText.includes("Reasoning details were not provided."), false);
  pass("Codex Responses API reasoning renders as expandable reasoning details");
}

async function testLaunchAndCoreMenus() {
  if (!(await cdp.evaluate(`buttonWithTitle("Run settings") !== null`))) {
    const hasBackButton = await cdp.evaluate(`buttonWithTitle("Back") !== null`);
    if (hasBackButton) await cdp.clickButtonByTitle("Back");
  }
  await cdp.waitFor(() => buttonWithTitle("Run settings") !== null, "chat composer controls");
  await cdp.waitFor(
    (name) => document.body.innerText.includes(name),
    "workspace label",
    undefined,
    workspaceName,
  );
  const landingScroll = await cdp.evaluate(`(() => {
    const scroller = document.querySelector("[data-chat-scroll-root]");
    if (!scroller) return null;
    return {
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      overflowY: getComputedStyle(scroller).overflowY,
    };
  })()`);
  assert.ok(landingScroll, "New session scroll root is missing");
  assert.equal(landingScroll.overflowY, "hidden");
  assert.ok(
    landingScroll.scrollHeight <= landingScroll.clientHeight + 1,
    `New session landing should not scroll: ${JSON.stringify(landingScroll)}`,
  );
  await cdp.clickButtonByTitle("Run settings");
  await cdp.waitFor(
    () =>
      document.body.innerText.includes("E2E Fake ASP") &&
      document.body.innerText.includes("Fake ASP"),
    "run settings dropdown",
  );
  await cdp.press("Escape");
  await cdp.clickButtonByTitle("Permissions");
  await cdp.waitFor(
    () =>
      document.body.innerText.includes("Request approval") &&
      document.body.innerText.includes("Full access"),
    "approval dropdown",
  );
  await cdp.clickMainWorldExpression(
    `Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')).find((item) => item.textContent?.trim() === "Request approval" && window.__aguiE2e.isVisible(item))`,
    "approval suggest menu item",
  );
  await cdp.waitFor(
    () => buttonWithTitle("Permissions")?.textContent?.includes("Request approval"),
    "approval mode set to suggest",
  );
  await cdp.press("Escape");
  await cdp.evaluateMainWorld(`(() => {
    const original = document.startViewTransition?.bind(document);
    window.__aguiThemeTransitionCount = 0;
    if (original && !window.__aguiOriginalStartViewTransition) {
      window.__aguiOriginalStartViewTransition = original;
      document.startViewTransition = (callback) => {
        window.__aguiThemeTransitionCount += 1;
        const transition = original(callback);
        window.__aguiThemeTransitionFinished = false;
        transition.finished.finally(() => {
          window.__aguiThemeTransitionFinished = true;
        });
        return transition;
      };
    }
  })()`);
  await runCommandPaletteCommand("Toggle theme");
  await cdp.waitFor(
    () => document.documentElement.getAttribute("data-theme") === "light",
    "light theme",
  );
  await cdp.waitForMainWorld(
    () =>
      !document.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.__aguiThemeTransitionCount >= 1,
    "theme view transition",
  );
  await cdp.waitForMainWorld(
    () =>
      !document.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.__aguiThemeTransitionFinished === true,
    "theme view transition finished",
  );
  await runCommandPaletteCommand("Toggle theme");
  await cdp.waitFor(
    () => document.documentElement.getAttribute("data-theme") === "dark",
    "dark theme",
  );
  await runCommandPaletteCommand("Open editor");
  await cdp.waitFor(
    () =>
      document.querySelector('[data-panel-id="ide"]:not([hidden])') !== null ||
      document.body.innerText.includes("IDE"),
    "command palette executes side panel command",
  );
  pass("launch, run settings, approval dropdown, theme toggle, command palette");
}

async function testAgentConversationFlow() {
  const composerEditorSelector =
    "textarea[placeholder], .composer-editor[role='textbox'], [role='textbox'][aria-multiline='true']";
  const composerEditorVisible = () =>
    cdp.evaluate(`document.querySelector(${JSON.stringify(composerEditorSelector)}) !== null`);
  if (!(await composerEditorVisible())) {
    if (await cdp.evaluate(`buttonWithTitle("Back") !== null`)) {
      await cdp.clickButtonByTitle("Back");
    }
    await cdp.waitFor(
      () =>
        document.querySelector(
          "textarea[placeholder], .composer-editor[role='textbox'], [role='textbox'][aria-multiline='true']",
        ) !== null || buttonWithTitle("Run settings") !== null,
      "chat shell before conversation",
    );
  }
  if (!(await composerEditorVisible())) {
    await clickSidebarNewSession();
    await cdp.waitFor(
      () =>
        document.querySelector(
          "textarea[placeholder], .composer-editor[role='textbox'], [role='textbox'][aria-multiline='true']",
        ) !== null,
      "chat composer before conversation",
    );
  }
  const bridgeResources = await cdp.evaluateMainWorld(
    `window.agentDesktop.extensions.resolveAgentContributions({ workspacePath: ${JSON.stringify(root)} })`,
  );
  assert.ok(
    bridgeResources.mcpServers.length > 0,
    "Electron extension bridge lost MCP contributions before run",
  );
  assert.ok(
    bridgeResources.skills.length > 0,
    "Electron extension bridge lost skill contributions before run",
  );
  assert.ok(
    bridgeResources.prompts.some((prompt) => prompt.autoInclude),
    "Electron extension bridge lost prompt contributions before run",
  );
  await cdp.setTextarea("E2E full-flow prompt");
  await cdp.clickButtonByTitle("Send");
  await cdp.waitFor(
    () => document.body.innerText.includes("Allow E2E Fake ASP to run this command?"),
    "approval card",
  );
  await cdp.clickButtonByTitle("Approval options");
  await cdp.waitFor(
    () => document.body.innerText.includes("Always allow"),
    "always allow approval option",
  );
  await cdp.press("Escape");
  await cdp.clickButtonByText("Allow once");
  await cdp.waitFor(() => document.body.innerText.includes("Smoke question"), "question dialog");
  await cdp.clickButtonByText("OK");
  await cdp.clickButtonByText("Submit answers");
  await cdp.waitFor(
    () => document.body.innerText.includes("ASP smoke OK"),
    "agent response",
    15_000,
  );
  try {
    await cdp.waitFor(
      () => {
        const visibleContent = document.body.innerText;
        if (visibleContent.includes("Fake command") && visibleContent.includes("smoke.txt")) {
          return true;
        }
        const button = document.querySelector(
          '[data-ui-region="chat.agentProcess"] button[aria-expanded]',
        );
        if (!button) return false;
        if (button.getAttribute("aria-expanded") === "true") {
          return visibleContent.includes("Fake command") || visibleContent.includes("smoke.txt");
        }
        button.click();
        return false;
      },
      "agent process expanded",
      20_000,
    );
  } catch (error) {
    const debug = await cdp.evaluate(`(() => ({
      text: document.body.innerText.slice(0, 2000),
      processRegions: Array.from(document.querySelectorAll('[data-ui-region="chat.agentProcess"]')).map((region) => region.textContent?.trim().slice(0, 200)),
      buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
        text: button.textContent?.trim().slice(0, 120),
        title: button.title || button.getAttribute('aria-label') || '',
        expanded: button.getAttribute('aria-expanded'),
      })).filter((button) => button.text || button.title).slice(0, 80),
      regions: Array.from(document.querySelectorAll('[data-ui-region]')).map((region) => region.getAttribute('data-ui-region')).slice(0, 120),
    }))()`);
    const stateDebug = await persistedChatState()
      .then((store) => ({
        activeSessionId: store.activeSessionId,
        sessions: store.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          status: session.status,
          blocks: session.blocks.map((block) => ({
            id: block.id,
            kind: block.kind,
            text: block.text,
          })),
        })),
      }))
      .catch((cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
    console.error(`agent process debug: ${JSON.stringify({ debug, stateDebug }, null, 2)}`);
    throw error;
  }
  await cdp.waitFor(
    () =>
      Array.from(
        document.querySelectorAll('agui-extension-component[data-extension-id="fixture.showcase"]'),
      ).some((element) =>
        element.getAttribute("data-extension-text")?.includes("Installed extension renderer"),
      ),
    "installed extension chat renderer",
  );
  await cdp.waitFor(
    () =>
      Array.from(
        document.querySelectorAll('agui-extension-component[data-extension-id="fixture.showcase"]'),
      ).some((element) =>
        /(\d+) MCP · (\d+) skill/.test(element.getAttribute("data-extension-text") || ""),
      ),
    "installed extension chat renderer resource counts",
  );

  const content = await cdp.text();
  const extensionContent = await cdp.evaluate(
    `Array.from(document.querySelectorAll("agui-extension-component")).map((element) => element.getAttribute("data-extension-text") || "").join("\\n")`,
  );
  const visibleContent = `${content}\n${extensionContent}`;
  for (const expected of [
    "E2E full-flow prompt",
    "Reasoning",
    "Plan",
    "smoke.txt",
    "Smoke resource",
    "Smoke artifact",
    "Smoke MCP App",
    "Plugin rendered custom block",
    "Custom renderer payload",
    "Installed extension renderer",
    "Smoke raw",
    "ASP smoke OK",
  ]) {
    assert.ok(visibleContent.includes(expected), `missing conversation content: ${expected}`);
  }
  const injectedResources = visibleContent.match(/(\d+) MCP · (\d+) skill/);
  assert.ok(injectedResources, "extension renderer did not expose injected agent resource counts");
  assert.ok(
    Number(injectedResources[1]) > 0,
    `MCP contribution was not injected: ${injectedResources[0]}`,
  );
  assert.ok(
    Number(injectedResources[2]) > 0,
    `Skill contribution was not injected: ${injectedResources[0]}`,
  );
  assert.match(
    visibleContent,
    /\d+ MCP · \d+ skill · 1 prompt/,
    "Prompt contribution was not injected",
  );
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-plugin-chat-renderer="agui.card"]')
        ?.textContent?.includes("Plugin rendered custom block"),
    "plugin registered chat block renderer",
  );
  await cdp.waitFor(
    () =>
      document.querySelector('iframe[data-mcp-app-frame][title="Smoke MCP App"]') !== null ||
      document.querySelector("[data-mcp-app-native-view][data-mcp-app-native-view-id]") !== null,
    "MCP app renderer",
  );
  await cdp.waitFor(
    () => document.querySelector('[data-mcp-app-block][data-mcp-app-ready="true"]') !== null,
    "MCP app bridge ready",
  );
  const mcpAppTarget = await cdp.evaluate(`(() => {
    const block = Array.from(
      document.querySelectorAll('[data-mcp-app-block][data-mcp-app-ready="true"]'),
    ).find((element) => element.textContent?.includes("Smoke MCP App"));
    const iframe = block?.querySelector('iframe[data-mcp-app-frame][title="Smoke MCP App"]');
    if (iframe) return { kind: "iframe" };
    const native = block?.querySelector(
      '[data-mcp-app-native-view][data-mcp-app-native-view-id]',
    );
    const id = native?.getAttribute("data-mcp-app-native-view-id") || "";
    return id ? { kind: "native", id } : null;
  })()`);
  assert.ok(mcpAppTarget, "MCP app target was not mounted");
  if (mcpAppTarget.kind === "iframe") {
    await cdp.clickSelector('iframe[data-mcp-app-frame][title="Smoke MCP App"]');
    await cdp.evaluate(`(() => {
      document
        .querySelector('iframe[data-mcp-app-frame][title="Smoke MCP App"]')
        ?.contentWindow
        ?.postMessage({ jsonrpc: "2.0", method: "ui/e2e-click", params: {} }, "*");
    })()`);
  } else {
    const delivered = await cdp.evaluateMainWorld(
      `window.agentDesktop.interactiveApp.postMessage({
        id: ${JSON.stringify(mcpAppTarget.id)},
        message: { jsonrpc: "2.0", method: "ui/e2e-click", params: {} },
      })`,
    );
    assert.equal(delivered, true, "MCP app test notification was not delivered to the native view");
  }
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll("[data-mcp-app-block]")).some((block) =>
        ["ui/update-model-context", "mcp-app:state"].includes(
          block.getAttribute("data-mcp-app-event") || "",
        ),
      ),
    "MCP app outbound state event",
  );
  await waitUntil(
    async () => {
      const state = await persistedChatState();
      const sessions = state?.sessions || [];
      const session =
        sessions.find((item) =>
          item.blocks?.some((block) => block.id === "extension-renderer-1"),
        ) ||
        sessions.find((item) => item.id === state?.activeSessionId) ||
        sessions[0];
      return Object.values(session?.mcpAppState || {}).some(
        (entry) => entry?.widgetState?.count === 1,
      );
    },
    "MCP app state update",
    15_000,
  );

  const state = await persistedChatState().then((store) => {
    const session =
      store.sessions.find((item) =>
        item.blocks?.some((block) => block.id === "extension-renderer-1"),
      ) ||
      store.sessions.find((item) => item.id === store.activeSessionId) ||
      store.sessions[0];
    const mcpAppState = Object.values(session.mcpAppState || {}).find(
      (entry) => entry?.widgetState?.count === 1,
    );
    return {
      title: session.title,
      status: session.status,
      providerSessionId: session.providerSessionId,
      blockKinds: session.blocks.map((block) => block.kind),
      mcpAppRenderer: session.blocks.find((block) => block.id === "mcp-app-1")?.app?.renderer,
      mcpWidgetCount: mcpAppState?.widgetState?.count,
      usage: session.usage,
    };
  });
  assert.equal(state.title, "Fake ASP generated title");
  assert.equal(state.status, "idle");
  assert.equal(state.providerSessionId, "fake-session-1");
  for (const kind of [
    "user",
    "reasoning",
    "plan",
    "tool",
    "diff",
    "resource",
    "artifact",
    "raw",
    "assistant",
  ]) {
    assert.ok(state.blockKinds.includes(kind), `missing block kind ${kind}`);
  }
  assert.equal(state.mcpAppRenderer, "mcp-app");
  assert.equal(state.mcpWidgetCount, 1);
  assert.ok(state.usage, `missing usage in session state: ${JSON.stringify(state)}`);
  assert.equal(state.usage.input, 8);
  assert.equal(state.usage.output, 3);

  await cdp.hoverMessage("user", "E2E full-flow prompt");
  await waitForToolbar(
    () => visibleButton("Copy message") && visibleButton("Edit message"),
    "user message toolbar",
  );
  await cdp.hoverMessage("assistant", "ASP smoke OK");
  await waitForToolbar(
    () => visibleButton("Copy agent messages") && visibleButton("Branch from here"),
    "assistant message toolbar",
  );
  await cdp.hoverSelector('[role="meter"][aria-label="Context usage"]');
  await cdp.waitFor(
    () => document.body.innerText.includes("Context usage"),
    "context usage tooltip",
  );
  pass(
    "agent conversation, approval/question dialogs, all block renderers, message toolbar, context tooltip",
  );
}

async function testSearchRenameBranchAndDelete() {
  await cdp.clickButtonByTitle("Search conversations");
  await cdp.waitFor(
    () => document.querySelector('input[placeholder="Search recent conversations"]') !== null,
    "search chats dialog",
  );
  await cdp.typeText("generated");
  await cdp.waitFor(
    () => document.body.innerText.includes("Fake ASP generated title"),
    "search finds generated session title",
  );
  await cdp.press("Escape");

  await cdp.hoverText("ASP smoke OK");
  await cdp.clickButtonByTitle("Branch from here");
  await cdp.waitFor(
    () => document.body.innerText.includes("Fake ASP generated title branch"),
    "branch session created",
  );
  await waitUntil(async () => {
    const state = await persistedChatState();
    return (
      state.sessions.filter((session) => !session.extensionState?.sessionTree?.hideInSessionList)
        .length === 2
    );
  }, "branch session persisted");
  let sessionCount = await sessionCountInStorage();
  assert.equal(sessionCount, 2);
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll("button[title]")).some(
        (button) =>
          button.title === "Fake ASP generated title branch" &&
          button.textContent?.includes("Fake ASP generated title branch"),
      ),
    "branch session row",
  );

  await cdp.clickButtonByTitle("Conversation actions");
  await cdp.clickMenuItem("Rename chat");
  await cdp.waitFor(
    () =>
      Array.from(document.querySelectorAll("input")).some(
        (input) => input.value === "Fake ASP generated title branch",
      ),
    "rename input",
  );
  await cdp.setInputValueByLabel("Rename chat", "E2E renamed branch");
  const renameSubmitted = await cdp.evaluateMainWorld(`(() => {
    const input = Array.from(document.querySelectorAll("input")).find(
      (element) => element.getAttribute("aria-label") === "Rename chat" &&
        window.__aguiE2e.isVisible(element),
    );
    const form = input?.closest("form");
    if (!form) return false;
    form.requestSubmit();
    return true;
  })()`);
  assert.equal(renameSubmitted, true, "rename form was not submitted");
  await cdp.waitFor(
    () =>
      !Array.from(document.querySelectorAll("input")).some(
        (input) =>
          input.getAttribute("aria-label") === "Rename chat" && window.__aguiE2e.isVisible(input),
      ),
    "rename dialog closed",
  );
  await waitUntil(async () => {
    const state = await persistedChatState();
    return state.sessions?.some((session) => session.title === "E2E renamed branch");
  }, "rename session persisted");
  await cdp.waitFor(() => document.body.innerText.includes("E2E renamed branch"), "rename session");

  await clickSessionRowAction("E2E renamed branch", "Delete");
  await waitForDeleteConfirmation("delete confirmation");
  await cdp.clickButtonByText("Cancel");
  sessionCount = await sessionCountInStorage();
  assert.equal(sessionCount, 2);
  await clickSessionRowAction("E2E renamed branch", "Delete");
  await waitForDeleteConfirmation("delete confirmation second open");
  await cdp.clickButtonByText("Remove from list");
  await waitUntil(async () => (await sessionCountInStorage()) === 1, "delete confirmed");
  await cdp.waitFor(
    () => !document.body.innerText.includes("Remove session?"),
    "delete dialog closed",
  );
  const remainingSessionCount = await sessionCountInStorage();
  await clickSidebarNewSession();
  await waitForProjectDraftState();
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    "project draft landing",
  );
  assert.equal(await sessionCountInStorage(), remainingSessionCount);
  pass("chat search, branch, rename, delete confirmation cancel + confirm, project draft shortcut");
}

await main();
