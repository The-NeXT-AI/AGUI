import assert from "node:assert/strict";
import http from "node:http";
import { cdp, pageHelperScript, rpc } from "./e2e-electron-state.mjs";
import { waitUntil } from "./e2e-electron-driver.mjs";

export async function setRendererWorkspace(workspacePath) {
  const aspKey = "agui-asp-preferences";
  const aspValue = await persistentStoreValue(aspKey, { state: {}, version: 0 });
  aspValue.state = { ...(aspValue.state || {}), workspacePath };
  await rpc.request("storage.set", {
    key: aspKey,
    namespace: "renderer",
    value: JSON.stringify(aspValue),
  });

  const now = Date.now();
  const workspacesKey = "agui-workspaces";
  const workspacesValue = await persistentStoreValue(workspacesKey, { state: {}, version: 1 });
  const state = workspacesValue.state || {};
  const current = Array.isArray(state.workspaces) ? state.workspaces : [];
  const defaults = {
    id: "default",
    name: "Default workspace",
    color: "#3b82f6",
    disabledMcpServers: [],
    disabledSkills: [],
    disabledPrompts: [],
    createdAt: now,
    updatedAt: now,
  };
  const existing = current.find((workspace) => workspace?.id === "default");
  const nextDefault = {
    ...defaults,
    ...(existing || {}),
    id: "default",
    projectPath: workspacePath,
    updatedAt: now,
  };
  workspacesValue.version = 1;
  workspacesValue.state = {
    ...state,
    activeWorkspaceId: "default",
    workspaces: [nextDefault, ...current.filter((workspace) => workspace?.id !== "default")],
  };
  await rpc.request("storage.set", {
    key: workspacesKey,
    namespace: "renderer",
    value: JSON.stringify(workspacesValue),
  });

  await cdp.evaluate(`(() => {
    localStorage.removeItem("agui-asp-preferences");
    localStorage.removeItem("agui-workspaces");
  })()`);
  await cdp.call("Page.reload", { ignoreCache: true });
  await cdp.waitFor(
    () => document.body.innerText.includes("How can I help today?"),
    `workspace reload ${workspacePath}`,
  );
  await cdp.evaluate(pageHelperScript);
}

async function persistentStoreValue(key, fallback) {
  const value = await rpc.request("storage.get", { key, namespace: "renderer" });
  if (typeof value !== "string" || !value) return structuredClone(fallback);
  try {
    return JSON.parse(value);
  } catch {
    return structuredClone(fallback);
  }
}

export async function ensureDetailPanelOpen() {
  if (await cdp.evaluate(`buttonWithTitle("Collapse detail panel") !== null`)) return;
  await cdp.clickButtonByTitle("Expand detail panel");
  await cdp.waitFor(() => buttonWithTitle("Collapse detail panel") !== null, "detail panel open");
}

export async function ensureSidebarOpen() {
  if (await cdp.evaluate(`buttonWithTitle("Collapse sidebar") !== null`)) return;
  await cdp.clickButtonByTitle("Expand sidebar");
  await cdp.waitFor(() => buttonWithTitle("Collapse sidebar") !== null, "sidebar open");
}

export async function clickSidebarNewSession() {
  await ensureSidebarOpen();
  await cdp.clickMainWorldExpression(
    `document.querySelector('[data-ui-region="sidebar.action.newSession"] button')`,
    "sidebar new session",
  );
}

export async function selectTheme(themeId) {
  await cdp.evaluateMainWorld(`(() => {
    const themeId = ${JSON.stringify(themeId)};
    const select = Array.from(document.querySelectorAll("select")).find((candidate) =>
      Array.from(candidate.options).some((option) => option.value === themeId),
    );
    if (!select) throw new Error("Theme selector is not visible: " + themeId);
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (valueSetter) valueSetter.call(select, themeId);
    else select.value = themeId;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

export async function openSidePanelPlugin(label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cdp.evaluateMainWorld(`(() => {
      const labels = new Set(["Open a detail panel tool", "Open side panel plugin"]);
      const trigger = Array.from(document.querySelectorAll("button[title], button[aria-label]"))
        .find((button) => labels.has(button.title) || labels.has(button.getAttribute("aria-label") || ""));
      if (!trigger) throw new Error("Detail panel tool trigger is not visible");
      trigger.scrollIntoView({ block: "center", inline: "center" });
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    })()`);
    try {
      await cdp.waitFor(
        (wanted) =>
          Array.from(document.querySelectorAll('[role="menuitem"]')).some(
            (item) => item.textContent?.trim() === wanted,
          ),
        `side panel menu ${label}`,
        3_000,
        label,
      );
      await cdp.clickMenuItem(label);
      return;
    } catch (error) {
      lastError = error;
      await cdp.press("Escape");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

export async function waitForBrowserPanel() {
  try {
    await cdp.waitFor(
      () =>
        document.querySelector('[data-panel-id="browser"]:not([hidden]) [data-browser-id]') !==
        null,
      "browser tab",
    );
  } catch (error) {
    const debug = await cdp.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerText.slice(0, 200),
      tabs: Array.from(document.querySelectorAll('[data-side-panel-tab]')).map((tab) => ({
        id: tab.getAttribute('data-side-panel-tab'),
        plugin: tab.getAttribute('data-side-panel-plugin'),
        selected: tab.getAttribute('aria-selected'),
        text: tab.textContent?.trim(),
      })),
      panels: Array.from(document.querySelectorAll('[data-panel-id]')).map((panel) => ({
        id: panel.getAttribute('data-panel-id'),
        hidden: panel.hasAttribute('hidden'),
        text: panel.textContent?.trim().slice(0, 120),
        hasBrowserId: panel.querySelector('[data-browser-id]') !== null,
      })),
      buttons: Array.from(document.querySelectorAll('button[title], button[aria-label]')).map((button) => button.title || button.getAttribute('aria-label')).filter(Boolean),
    }))()`);
    console.error(`browser tab debug: ${JSON.stringify(debug, null, 2)}`);
    throw error;
  }
}

export async function waitForBrowserAutomationTarget(targetId) {
  try {
    await waitUntil(async () => {
      const targets = await rpc.request("browser.list");
      return Array.isArray(targets) && targets.some((target) => target.id === targetId);
    }, "browser CDP automation target");
  } catch (error) {
    const targets = await rpc.request("browser.list").catch((listError) => ({
      error: listError instanceof Error ? listError.message : String(listError),
    }));
    const debug = await cdp.evaluate(`(() => {
      const panel = document.querySelector('[data-panel-id="browser"]:not([hidden])');
      const root = panel?.querySelector('[data-browser-id]');
      return {
        url: location.href,
        title: document.title,
        panelText: panel?.textContent?.trim().slice(0, 300),
        browserId: root?.getAttribute('data-browser-id'),
        automation: root?.getAttribute('data-browser-automation'),
        address: panel?.querySelector('input[placeholder="Search or enter URL"]')?.value,
        nativeViewPlaceholder: panel?.querySelector('[data-browser-native-view]') !== null,
        panels: Array.from(document.querySelectorAll('[data-panel-id]')).map((item) => ({
          id: item.getAttribute('data-panel-id'),
          hidden: item.hasAttribute('hidden'),
          text: item.textContent?.trim().slice(0, 80),
        })),
        mountHtml: root?.outerHTML.slice(0, 500),
      };
    })()`);
    console.error(`browser automation debug: ${JSON.stringify({ targets, debug }, null, 2)}`);
    throw error;
  }
}

export async function startBrowserAutomationServer() {
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2563eb"/><path d="M9 22h14v3H9zm2-15h10l4 13H7L11 7zm3 3-2 7h8l-2-7h-4z" fill="#fff"/></svg>`;
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
      response.end(favicon);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head>
          <title>AGUI Browser CDP Fixture</title>
          <link rel="icon" href="/favicon.svg" type="image/svg+xml">
          <style>
            body { font-family: system-ui, sans-serif; padding: 24px; }
            button, input { font: inherit; margin: 8px 0; padding: 6px 8px; }
          </style>
        </head>
        <body>
          <h1>Browser CDP fixture</h1>
          <p id="status">idle</p>
          <button id="count" onclick="this.dataset.count = String((Number(this.dataset.count || '0') + 1)); document.querySelector('#status').textContent = 'clicked:' + this.dataset.count;">Click through CDP</button>
          <label>Input <input id="name" value="" /></label>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

export async function stopHttpServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

export async function openIdePath(parts) {
  for (const part of parts) {
    await cdp.waitFor(
      (wanted) =>
        Array.from(document.querySelectorAll('[data-panel-id="ide"] button')).some(
          (button) => button.textContent?.trim() === wanted && window.__aguiE2e.isVisible(button),
        ),
      `IDE tree item ${part}`,
      10_000,
      part,
    );
    await cdp.clickButtonByExactText(part, '[data-panel-id="ide"] button');
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

export async function sessionCountInStorage() {
  const stored = await persistentStoreValue("agui-asp-sessions", { state: {} });
  return (stored.state?.sessions || []).filter(
    (session) => !session.extensionState?.sessionTree?.hideInSessionList,
  ).length;
}

export async function clickSessionRowAction(title, action) {
  const clicked = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll("button[title]"))
      .filter((button) => button.title === ${JSON.stringify(title)} && button.textContent?.includes(${JSON.stringify(title)}))
      .map((button) => button.closest("[data-sidebar-tree-item='true']"))
      .filter(Boolean);
    const row = rows.find((candidate) =>
      Array.from(candidate.querySelectorAll("button[title], button[aria-label]"))
        .some((item) => (item.title || item.getAttribute("aria-label") || "") === ${JSON.stringify(action)}),
    );
    const button = Array.from(row?.querySelectorAll("button[title], button[aria-label]") || [])
      .find((item) => (item.title || item.getAttribute("aria-label") || "") === ${JSON.stringify(action)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(clicked, `Could not click session row action ${action}: ${title}`);
}

export async function waitForDeleteConfirmation(description) {
  await cdp.waitFor(() => document.body.innerText.includes("Remove session?"), description);
}

export async function waitForProjectDraftState() {
  await cdp.waitFor(
    () =>
      document.body.innerText.includes("How can I help today?") &&
      document.querySelector('[aria-current="page"]') === null,
    "project draft state",
  );
}

export async function clickDetailPanelTabClose(pluginId) {
  const clicked = await cdp.evaluate(`(() => {
    const tab = document.querySelector(${JSON.stringify(`[data-side-panel-plugin="${pluginId}"]`)});
    const container = tab?.closest(".group\\\\/tab");
    const close = Array.from(container?.querySelectorAll("button[title], button[aria-label]") || [])
      .find((button) => {
        const label = button.title || button.getAttribute("aria-label") || "";
        return label.startsWith("Close ");
      });
    if (!close) return false;
    close.click();
    return true;
  })()`);
  assert.ok(clicked, `Could not close detail panel tab for ${pluginId}`);
}

export async function closeDetailPanelTabs(pluginId) {
  const selector = `[data-side-panel-plugin="${pluginId}"]`;
  for (;;) {
    const { count, tabId } = await cdp.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      return { count: tabs.length, tabId: tabs[0]?.getAttribute("data-side-panel-tab") || "" };
    })()`);
    if (!count) return;
    await clickDetailPanelTabClose(pluginId);
    await cdp.waitFor(
      (query, expectedCount) => document.querySelectorAll(query).length < expectedCount,
      `close ${pluginId} detail panel tab`,
      5_000,
      selector,
      count,
    );
    if (pluginId === "browser" && tabId) {
      await waitUntil(async () => {
        const targets = await rpc.request("browser.list");
        return !Array.isArray(targets) || !targets.some((target) => target.id === tabId);
      }, `browser target ${tabId} closed`);
    }
  }
}

export async function commandPaletteOpen() {
  return cdp.evaluate(`document.querySelector('input[placeholder^="Type a command"]') !== null`);
}

export async function runCommandPaletteCommand(query) {
  await cdp.hotkey("Meta", "KeyK");
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!(await commandPaletteOpen())) {
    await cdp.hotkey("Control", "KeyK");
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!(await commandPaletteOpen())) {
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))`,
    );
  }
  await cdp.waitFor(
    () => document.querySelector('input[placeholder^="Type a command"]') !== null,
    "command palette",
  );
  await cdp.typeText(query);
  await cdp.waitFor(
    (text) =>
      Array.from(document.querySelectorAll("#command-palette-results button")).some((button) =>
        button.textContent?.includes(text),
      ),
    `command palette result ${query}`,
    5_000,
    query,
  );
  await cdp.clickMainWorldExpression(
    `Array.from(document.querySelectorAll("#command-palette-results button")).find((button) => button.textContent?.includes(${JSON.stringify(query)}))`,
    `command palette result ${query}`,
  );
}

export async function waitForToolbar(predicate, description) {
  try {
    await cdp.waitFor(predicate, description);
  } catch (error) {
    const debug = await cdp.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button[title], button[aria-label]'))
        .filter((button) => ["Copy message", "Copy agent messages", "Edit message", "Branch from here"].includes(button.title || button.getAttribute("aria-label") || ""))
        .map((button) => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return {
            title: button.title || button.getAttribute("aria-label"),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            parentClass: button.parentElement?.className ?? "",
            groupHover: Boolean(button.closest(".group\\\\/user:hover, .group\\\\/assistant:hover")),
          };
        });
      return {
        hoverMedia: matchMedia("(hover: hover)").matches,
        pointerMedia: matchMedia("(pointer: fine)").matches,
        hoveredText: document.querySelector("main :hover")?.textContent?.slice(0, 80) ?? "",
        buttons,
      };
    })()`);
    console.error(`${description} debug: ${JSON.stringify(debug, null, 2)}`);
    throw error;
  }
}
