import assert from "node:assert/strict";
import { cdp, pass, root, rpc } from "./e2e-electron-state.mjs";
import { freePort, waitUntil } from "./e2e-electron-driver.mjs";
import {
  clickDetailPanelTabClose,
  closeDetailPanelTabs,
  ensureDetailPanelOpen,
  ensureSidebarOpen,
  openIdePath,
  openSidePanelPlugin,
  startBrowserAutomationServer,
  stopHttpServer,
  waitForBrowserAutomationTarget,
  waitForBrowserPanel,
} from "./e2e-electron-ui-helpers.mjs";

export async function testRightSidePlugins() {
  await ensureDetailPanelOpen();
  const terminalEvents = [];
  const unsubscribeTerminalEvents = rpc.on("agui:terminal:event", (event) =>
    terminalEvents.push(event),
  );
  await openSidePanelPlugin("Terminal");
  await cdp.waitFor(
    () => document.querySelector('[data-panel-id="terminal"]') !== null,
    "terminal tab",
  );
  await openSidePanelPlugin("Terminal");
  await cdp.waitFor(
    () => document.querySelectorAll('[data-side-panel-plugin="terminal"]').length >= 2,
    "terminal multiple tabs",
  );
  await cdp.waitFor(
    () => document.querySelector('[data-panel-id="terminal"] .xterm-helper-textarea') !== null,
    "terminal input surface",
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[data-panel-id="terminal"] .xterm') !== null && document.querySelector('[data-panel-id="terminal"] .xterm-helper-textarea') !== null`,
    ),
    true,
  );
  await cdp.clickSelector('[data-panel-id="terminal"]:not([hidden]) [data-terminal-panel-root]');
  await cdp.waitFor(() => {
    const panel = document.querySelector('[data-panel-id="terminal"]:not([hidden])');
    const active = document.activeElement;
    return Boolean(
      panel &&
      active &&
      panel.contains(active) &&
      active.classList.contains("xterm-helper-textarea"),
    );
  }, "terminal input focus");
  const imeHelperGeometry = await cdp.evaluateMainWorld(`(() => {
    const panel = document.querySelector('[data-panel-id="terminal"]:not([hidden])');
    const helper = panel?.querySelector('.xterm-helper-textarea');
    if (!panel || !helper) return null;
    const panelRect = panel.getBoundingClientRect();
    const helperRect = helper.getBoundingClientRect();
    return {
      left: helperRect.left,
      top: helperRect.top,
      width: helperRect.width,
      height: helperRect.height,
      opacity: getComputedStyle(helper).opacity,
      panelLeft: panelRect.left,
      panelTop: panelRect.top,
      panelRight: panelRect.right,
      panelBottom: panelRect.bottom,
    };
  })()`);
  assert.ok(imeHelperGeometry, "Terminal IME helper geometry is missing");
  assert.ok(
    imeHelperGeometry.width >= 1,
    `Terminal IME helper width should be focusable: ${JSON.stringify(imeHelperGeometry)}`,
  );
  assert.ok(
    imeHelperGeometry.height >= 1,
    `Terminal IME helper height should be focusable: ${JSON.stringify(imeHelperGeometry)}`,
  );
  assert.notEqual(imeHelperGeometry.opacity, "0");
  assert.ok(
    imeHelperGeometry.left >= imeHelperGeometry.panelLeft - 1 &&
      imeHelperGeometry.left <= imeHelperGeometry.panelRight + 1 &&
      imeHelperGeometry.top >= imeHelperGeometry.panelTop - 1 &&
      imeHelperGeometry.top <= imeHelperGeometry.panelBottom + 1,
    `Terminal IME helper should stay inside the terminal panel: ${JSON.stringify(imeHelperGeometry)}`,
  );
  await cdp.typeText("printf E2E_CDP_INPUT\n");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_CDP_INPUT"),
    "terminal CDP keyboard input",
    10_000,
  );
  terminalEvents.length = 0;
  await cdp.press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(
    terminalEvents.filter((event) => event?.type === "stdin" && event.data === "\r").length,
    1,
  );
  await cdp.evaluateMainWorld(`(() => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    helper?.blur();
    document.body.tabIndex = -1;
    document.body.focus({ preventScroll: true });
  })()`);
  await cdp.typeKeyEvents("printf E2E_GLOBAL_INPUT\n");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_GLOBAL_INPUT"),
    "terminal global keyboard input fallback",
    10_000,
  );
  await cdp.evaluateMainWorld(`(() => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    helper.focus({ preventScroll: true });
    helper.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "printf E2E_TEXT_INPUT\\r",
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_TEXT_INPUT"),
    "terminal text input event fallback",
    10_000,
  );
  await cdp.evaluateMainWorld(`(async () => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    helper.focus({ preventScroll: true });
    helper.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "",
    }));
    helper.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertCompositionText",
      data: "E2E_IME_PARTIAL",
    }));
    helper.dispatchEvent(new KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }));
    helper.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }));
    helper.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "printf E2E_IME_INPUT\\r",
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_IME_INPUT"),
    "terminal IME composition input fallback",
    10_000,
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[data-panel-id="terminal"]:not([hidden])')?.textContent?.includes("E2E_IME_PARTIAL") ?? false`,
    ),
    false,
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[data-panel-id="terminal"]:not([hidden])')?.textContent?.includes("xprintf E2E_IME_INPUT") ?? false`,
    ),
    false,
  );
  await cdp.evaluateMainWorld(`(async () => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    helper.focus({ preventScroll: true });
    helper.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "",
    }));
    helper.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertCompositionText",
      data: "E2E_IME_VALUE_PARTIAL",
      isComposing: true,
    }));
    if (valueSetter) {
      valueSetter.call(helper, "printf E2E_IME_VALUE\\r");
    } else {
      helper.value = "printf E2E_IME_VALUE\\r";
    }
    helper.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertCompositionText",
      data: "printf E2E_IME_VALUE\\r",
      isComposing: true,
    }));
    helper.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "",
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_IME_VALUE"),
    "terminal IME value commit fallback",
    10_000,
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[data-panel-id="terminal"]:not([hidden])')?.textContent?.includes("E2E_IME_VALUE_PARTIAL") ?? false`,
    ),
    false,
  );
  await cdp.evaluateMainWorld(`(async () => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    helper.focus({ preventScroll: true });
    helper.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "",
    }));
    helper.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "",
    }));
    if (valueSetter) {
      valueSetter.call(helper, "printf E2E_IME_POST_END\\r");
    } else {
      helper.value = "printf E2E_IME_POST_END\\r";
    }
    helper.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertCompositionText",
      data: "printf E2E_IME_POST_END\\r",
      isComposing: false,
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_IME_POST_END"),
    "terminal IME post-compositionend input fallback",
    10_000,
  );
  terminalEvents.length = 0;
  await cdp.evaluateMainWorld(`(async () => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    helper.focus({ preventScroll: true });
    if (valueSetter) {
      valueSetter.call(helper, "STALE_PREFIX");
    } else {
      helper.value = "STALE_PREFIX";
    }
    helper.setSelectionRange(helper.value.length, helper.value.length);
    helper.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "",
    }));
    if (valueSetter) {
      valueSetter.call(helper, "printf E2E_IME_STALE\\r");
    } else {
      helper.value = "printf E2E_IME_STALE\\r";
    }
    helper.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "printf E2E_IME_STALE\\r",
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_IME_STALE"),
    "terminal IME stale helper commit fallback",
    10_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(
    terminalEvents.filter((event) => event?.type === "stdin").map((event) => event.data),
    ["printf E2E_IME_STALE\r"],
  );
  await cdp.evaluateMainWorld(`(async () => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    helper.focus({ preventScroll: true });
    for (const char of "printf E2E_KEYDOWN") {
      helper.dispatchEvent(new KeyboardEvent("keydown", {
        key: char,
        bubbles: true,
        cancelable: true,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    helper.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_KEYDOWN"),
    "terminal keydown fallback",
    10_000,
  );
  await cdp.evaluateMainWorld(`(async () => {
    const helper = document.querySelector('[data-panel-id="terminal"]:not([hidden]) .xterm-helper-textarea');
    if (!helper) throw new Error("Terminal helper textarea is not visible");
    helper.focus({ preventScroll: true });
    for (const char of "printf E2E_DEDUPE") {
      helper.dispatchEvent(new KeyboardEvent("keydown", {
        key: char,
        bubbles: true,
        cancelable: true,
      }));
      helper.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: char,
      }));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    helper.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    }));
  })()`);
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="terminal"]:not([hidden])')
        ?.textContent?.includes("E2E_DEDUPE"),
    "terminal paired keydown/beforeinput dedupe",
    10_000,
  );

  await openSidePanelPlugin("Browser");
  await waitForBrowserPanel();
  await openSidePanelPlugin("Browser");
  await cdp.waitFor(
    () => document.querySelectorAll('[data-side-panel-plugin="browser"]').length >= 2,
    "browser multiple tabs",
  );
  await clickDetailPanelTabClose("browser");
  await cdp.waitFor(
    () => document.querySelectorAll('[data-side-panel-plugin="browser"]').length === 1,
    "browser tab close",
  );

  await openSidePanelPlugin("Editor");
  await cdp.waitFor(
    () => document.querySelector('[data-panel-id="ide"]')?.textContent?.includes("Explorer"),
    "IDE explorer",
  );
  await openIdePath(["packages", "app", "src", "asp", "desktop-api.ts"]);
  await cdp.waitFor(
    () => document.querySelector('[data-panel-id="ide"] .monaco-editor') !== null,
    "Monaco editor",
  );
  const ide = await cdp.evaluate(`(() => ({
    activeTab: document.querySelector('[data-panel-id="ide"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
    hasSaveButton: document.querySelector('[data-panel-id="ide"] button[title="Save"]') !== null,
    hasLspText: document.querySelector('[data-panel-id="ide"]')?.textContent?.includes("LSP") ?? false,
    hasBottomContent:
      document.querySelector('[data-panel-id="ide"]')?.textContent?.includes("Problems") ||
      document.querySelector('[data-panel-id="ide"]')?.textContent?.includes("No diagnostics"),
    highlightedSpans: document.querySelectorAll('[data-panel-id="ide"] .mtk1, [data-panel-id="ide"] .mtk5, [data-panel-id="ide"] .mtk6, [data-panel-id="ide"] .mtk7, [data-panel-id="ide"] .mtk8, [data-panel-id="ide"] .mtk9, [data-panel-id="ide"] .mtk10').length,
    textareaCount: document.querySelectorAll('[data-panel-id="ide"] textarea:not(.inputarea):not(.ime-text-area)').length,
  }))()`);
  assert.ok(ide.activeTab.includes("desktop-api.ts"));
  assert.equal(ide.hasSaveButton, false);
  assert.equal(ide.hasLspText, false);
  assert.equal(ide.hasBottomContent, false);
  assert.ok(ide.highlightedSpans > 10);
  assert.equal(ide.textareaCount, 0);
  await cdp.clickSelector('[data-panel-id="ide"] .monaco-editor');
  await cdp.typeText(" ");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="ide"] [role="tab"][aria-selected="true"]')
        ?.getAttribute("data-ide-tab-dirty") === "true" &&
      document.querySelector('[data-panel-id="ide"] [data-ide-tab-dirty-indicator]') !== null,
    "IDE dirty tab indicator",
  );
  pass(
    "right plugins: terminal web terminal, browser multi-tab/close, VS Code IDE + Monaco rendering",
  );
  unsubscribeTerminalEvents();
}

export async function testEcosystemPlugins() {
  await ensureDetailPanelOpen();

  await openSidePanelPlugin("Source Control");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="source-control"]:not([hidden])')
        ?.textContent?.includes("Source Control"),
    "source control panel",
  );
  await cdp.waitFor(
    () =>
      (document
        .querySelector('[data-panel-id="source-control"]:not([hidden]) pre')
        ?.textContent?.trim().length ?? 0) > 0,
    "source control status result",
  );

  await openSidePanelPlugin("Workspace Search");
  await cdp.waitFor(
    () =>
      document.querySelector(
        '[data-panel-id="workspace-search"]:not([hidden]) input[placeholder*="ripgrep"]',
      ) !== null,
    "workspace search panel",
  );
  await cdp.clickSelector(
    '[data-panel-id="workspace-search"]:not([hidden]) input[placeholder*="ripgrep"]',
  );
  await cdp.typeText("AGUI_EXTENSION_ENGINE");
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll('[data-panel-id="workspace-search"]:not([hidden]) button')).find((button) => button.textContent?.trim() === "Search")`,
  );
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="workspace-search"]:not([hidden]) pre')
        ?.textContent?.includes("packages/extensions/src/index.ts"),
    "workspace search results",
  );
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll('[data-panel-id="workspace-search"]:not([hidden]) button')).find((button) => button.textContent?.trim() === "problems")`,
  );
  await cdp.waitFor(
    () =>
      !document
        .querySelector('[data-panel-id="workspace-search"]:not([hidden])')
        ?.textContent?.includes("Analyzing workspace"),
    "workspace problems diagnostics",
    30_000,
  );
  const diagnostics = await rpc.request("ide.workspaceDiagnostics", { root });
  assert.ok(Array.isArray(diagnostics));
  assert.ok(diagnostics.length <= 500);

  await openSidePanelPlugin("Tasks & Tests");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="tasks-tests"]:not([hidden])')
        ?.textContent?.includes("typecheck"),
    "workspace task discovery",
  );
  await cdp.clickExpression(
    `Array.from(document.querySelectorAll('[data-panel-id="tasks-tests"]:not([hidden]) button')).find((button) => button.textContent?.includes("typecheck"))`,
  );
  await cdp.waitFor(
    () => {
      const panel = document.querySelector('[data-panel-id="tasks-tests"]:not([hidden])');
      const output = panel?.querySelector("pre")?.textContent?.trim() ?? "";
      return (
        output.length > 0 &&
        output !== "Run a task to see its output." &&
        !Array.from(panel?.querySelectorAll("button") ?? []).some((button) =>
          button.textContent?.includes("Stop"),
        )
      );
    },
    "workspace task execution",
    120_000,
  );

  await openSidePanelPlugin("Preview");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="preview"]:not([hidden])')
        ?.textContent?.includes("AGUI Desktop"),
    "markdown preview",
  );

  await openSidePanelPlugin("Agent Control");
  await cdp.waitFor(
    () =>
      document
        .querySelector('[data-panel-id="agent-control"]:not([hidden])')
        ?.textContent?.includes("Agent Control Center"),
    "agent control center",
  );
  assert.ok((await cdp.text()).includes("Enabled extensions"));
  pass(
    "ecosystem plugins: source control, search/problems, task execution, preview, and agent control",
  );
}

export async function testBrowserAutomationPlugin() {
  console.log("→ browser automation: open browser panel");
  await ensureDetailPanelOpen();
  await closeDetailPanelTabs("browser");
  await openSidePanelPlugin("Browser");
  await waitForBrowserPanel();
  const browserServer = await startBrowserAutomationServer();
  const browserEvents = [];
  const unsubscribeBrowserEvents = rpc.on("agui:browser:event", (event) =>
    browserEvents.push(event),
  );
  try {
    console.log("→ browser automation: create WebContentsView target");
    const targetId = await cdp.evaluate(
      `document.querySelector('[data-panel-id="browser"]:not([hidden]) [data-browser-id]')?.getAttribute("data-browser-id")`,
    );
    assert.ok(targetId, "Browser panel did not expose an automation id");
    await cdp.evaluateMainWorld(`(() => {
      const panel = document.querySelector('[data-panel-id="browser"]:not([hidden])');
      const input = panel?.querySelector('input[placeholder="Search or enter URL"]');
      if (!input) throw new Error("Browser address input is not visible");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, ${JSON.stringify(browserServer.url)});
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(browserServer.url)} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await cdp.evaluateMainWorld(`(() => {
      const form = document.querySelector('[data-panel-id="browser"]:not([hidden]) form');
      if (!form) throw new Error("Browser form is not visible");
      form.requestSubmit();
    })()`);
    await waitForBrowserAutomationTarget(targetId);
    await waitUntil(async () => {
      const targets = await rpc.request("browser.list");
      const target = Array.isArray(targets) ? targets.find((item) => item.id === targetId) : null;
      return typeof target?.url === "string" && target.url.startsWith(browserServer.url);
    }, "browser UI navigation");
    await waitForBrowserDocumentReady(targetId, browserServer.url, "browser UI navigation load");
    console.log("→ browser automation: navigate");
    const listBefore = await rpc.request("browser.list");
    const rpcUrl = `${browserServer.url}?rpc=1`;
    await rpc.request("browser.navigate", {
      id: targetId,
      url: rpcUrl,
      waitUntil: "load",
      timeoutMs: 10000,
    });
    await waitForBrowserDocumentReady(targetId, rpcUrl, "browser RPC navigation load");
    console.log("→ browser automation: evaluate/click/type");
    await rpc.request("browser.evaluate", {
      id: targetId,
      expression: "document.querySelector('#status').textContent = 'CDP evaluated'",
    });
    await rpc.request("browser.click", { id: targetId, selector: "#count" });
    await rpc.request("browser.type", { id: targetId, selector: "#name", text: "CDP_TYPED" });
    const typed = await rpc.request("browser.evaluate", {
      id: targetId,
      expression: "document.querySelector('#name').value",
    });
    console.log("→ browser automation: snapshot/screenshot");
    const snapshot = await rpc.request("browser.snapshot", { id: targetId });
    const screenshot = await rpc.request("browser.screenshot", { id: targetId });
    const automated = {
      targetId,
      listBeforeCount: listBefore.length,
      snapshotText: snapshot.text,
      typed: typed.value,
      screenshotMime: screenshot.mimeType,
      screenshotBytes: screenshot.data.length,
    };
    assert.ok(automated.targetId);
    assert.ok(automated.listBeforeCount >= 1);
    assert.ok(automated.snapshotText.includes("clicked:1"));
    assert.equal(automated.typed, "CDP_TYPED");
    assert.equal(automated.screenshotMime, "image/png");
    assert.ok(automated.screenshotBytes > 100);
    const rpcSnapshot = await rpc.request("browser.snapshot", { id: automated.targetId });
    assert.ok(rpcSnapshot.text.includes("clicked:1"));
    const refusedPort = await freePort();
    const refusedUrl = `http://127.0.0.1:${refusedPort}/`;
    const refusedResult = await rpc.request("browser.navigate", {
      id: targetId,
      url: refusedUrl,
      waitUntil: "load",
      timeoutMs: 3000,
    });
    assert.equal(refusedResult.id, targetId);
    await waitUntil(
      () =>
        browserEvents.some(
          (event) =>
            event.id === targetId &&
            event.type === "failed" &&
            event.url === refusedUrl &&
            /ERR_CONNECTION_REFUSED|refused/i.test(event.error ?? ""),
        ),
      "browser failed-load event without rejected navigation",
      5000,
    );
  } finally {
    unsubscribeBrowserEvents();
    await stopHttpServer(browserServer.server);
  }
  pass("browser plugin WebContentsView CDP automation over JSON-RPC");
}

async function waitForBrowserDocumentReady(targetId, expectedUrl, description) {
  await waitUntil(async () => {
    const targets = await rpc.request("browser.list");
    if (!Array.isArray(targets) || !targets.some((item) => item.id === targetId)) return false;
    try {
      const result = await rpc.request("browser.evaluate", {
        id: targetId,
        expression:
          "({ href: location.href, readyState: document.readyState, hasFixture: Boolean(document.querySelector('#status')) })",
      });
      const value = result.value || {};
      return (
        typeof value.href === "string" &&
        value.href.startsWith(expectedUrl) &&
        (value.readyState === "interactive" || value.readyState === "complete") &&
        value.hasFixture === true
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /no target available|target closed|target is not available|context was destroyed|navigated/i.test(
          message,
        )
      ) {
        return false;
      }
      throw error;
    }
  }, description);
}

export async function testSettingsAndLayoutToggles() {
  await cdp.clickButtonByText("Settings");
  await cdp.waitFor(
    () =>
      document.body.innerText.includes("Settings") && document.body.innerText.includes("Agents"),
    "settings page",
  );
  await cdp.clickButtonByTitle("Back");
  await cdp.waitFor(
    () => document.body.innerText.includes("Fake ASP generated title"),
    "settings back",
  );

  await ensureSidebarOpen();
  await cdp.clickButtonByTitle("Collapse sidebar");
  await cdp.waitFor(() => buttonWithTitle("Expand sidebar") !== null, "sidebar collapse");
  await cdp.clickButtonByTitle("Expand sidebar");
  await cdp.waitFor(() => buttonWithTitle("Collapse sidebar") !== null, "sidebar expand");
  await ensureDetailPanelOpen();
  await cdp.clickButtonByTitle("Collapse detail panel");
  await cdp.waitFor(() => buttonWithTitle("Expand detail panel") !== null, "detail collapse");
  await cdp.clickButtonByTitle("Expand detail panel");
  await cdp.waitFor(() => buttonWithTitle("Collapse detail panel") !== null, "detail expand");
  pass("settings page and sidebar/detail panel collapse/expand controls");
}
