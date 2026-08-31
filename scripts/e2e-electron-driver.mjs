import assert from "node:assert/strict";
import net from "node:net";
import { pageHelperScript } from "./e2e-electron-state.mjs";

export function findAppFrameId(node) {
  if (!node) return null;
  const url = String(node.frame?.url ?? "");
  if (url.includes("/dist/index.html")) return node.frame?.id ?? null;
  for (const child of node.childFrames ?? []) {
    const id = findAppFrameId(child);
    if (id) return id;
  }
  return null;
}

export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.mainContextId = null;
    this.mainFrameId = null;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleEvent(message);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
      setTimeout(() => reject(new Error("CDP websocket open timeout")), 10_000);
    });
    return new Cdp(socket);
  }

  async captureMainFrame() {
    const frameTree = await this.call("Page.getFrameTree");
    this.mainFrameId =
      findAppFrameId(frameTree?.frameTree) ?? frameTree?.frameTree?.frame?.id ?? null;
    this.mainContextId = null;
    await this.ensureMainContext();
  }

  handleEvent(message) {
    if (message.method === "Inspector.targetCrashed") {
      console.error(`CDP target crashed: ${JSON.stringify(message.params ?? {})}`);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      console.error(
        `Renderer exception: ${JSON.stringify(message.params?.exceptionDetails ?? {})}`,
      );
      return;
    }
    if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry;
      if (entry?.level === "error")
        console.error(`Renderer log error: ${entry.text ?? JSON.stringify(entry)}`);
      return;
    }
    if (message.method === "Page.frameNavigated") {
      const frame = message.params?.frame;
      if (frame && !frame.parentId && (!this.mainFrameId || frame.id === this.mainFrameId)) {
        this.mainFrameId = frame.id ?? this.mainFrameId;
        this.mainContextId = null;
      }
      return;
    }
    if (
      message.method === "Runtime.executionContextDestroyed" &&
      message.params?.executionContextId === this.mainContextId
    ) {
      this.mainContextId = null;
      return;
    }
    if (message.method === "Runtime.executionContextsCleared") {
      this.mainContextId = null;
      return;
    }
  }

  async ensureMainContext() {
    const frameTree = await this.call("Page.getFrameTree");
    this.mainFrameId =
      findAppFrameId(frameTree?.frameTree) ??
      this.mainFrameId ??
      frameTree?.frameTree?.frame?.id ??
      null;
    if (!this.mainFrameId) return;
    const world = await this.call("Page.createIsolatedWorld", {
      frameId: this.mainFrameId,
      worldName: "agui-e2e-main",
      grantUniveralAccess: true,
    });
    this.mainContextId = world.executionContextId ?? null;
    if (this.mainContextId) {
      await this.call("Runtime.evaluate", {
        contextId: this.mainContextId,
        expression: pageHelperScript,
        awaitPromise: false,
        returnByValue: true,
      });
    }
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, ...args) {
    const argJson = args.map((arg) => JSON.stringify(arg)).join(",");
    const source = args.length ? `((...__args) => (${expression}))(${argJson})` : expression;
    if (!this.mainContextId) await this.ensureMainContext();
    const params = {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
    };
    if (this.mainContextId) params.contextId = this.mainContextId;
    let result;
    try {
      result = await this.call("Runtime.evaluate", {
        ...params,
      });
    } catch (error) {
      if (!String(error?.message ?? error).includes("Cannot find context with specified id")) {
        throw error;
      }
      this.mainContextId = null;
      await this.ensureMainContext();
      if (this.mainContextId) params.contextId = this.mainContextId;
      else delete params.contextId;
      result = await this.call("Runtime.evaluate", {
        ...params,
      });
    }
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime.evaluate failed";
      throw new Error(detail);
    }
    return result.result.value;
  }

  async evaluateMainWorld(expression, ...args) {
    const argJson = args.map((arg) => JSON.stringify(arg)).join(",");
    const source = args.length ? `((...__args) => (${expression}))(${argJson})` : expression;
    const result = await this.call("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime.evaluate failed";
      throw new Error(detail);
    }
    return result.result.value;
  }

  async waitFor(predicate, description, timeoutMs = 10_000, ...args) {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.evaluate(`(${predicate.toString()})(...${JSON.stringify(args)})`);
        if (ok) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(
      `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
    );
  }

  async waitForMainWorld(predicate, description, timeoutMs = 10_000, ...args) {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.evaluateMainWorld(
          `(${predicate.toString()})(...${JSON.stringify(args)})`,
        );
        if (ok) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(
      `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
    );
  }

  async text() {
    return this.evaluate("document.body.innerText");
  }

  async rectFor(expression) {
    return this.evaluate(`(() => {
      const el = ${expression};
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
  }

  async clickExpression(expression) {
    const rect = await this.rectFor(expression);
    assert.ok(
      rect && rect.width > 0 && rect.height > 0,
      `Could not click expression: ${expression}`,
    );
    await this.mouse(rect.x, rect.y, "mouseMoved");
    await this.mouse(rect.x, rect.y, "mousePressed", { button: "left", buttons: 1, clickCount: 1 });
    await this.mouse(rect.x, rect.y, "mouseReleased", {
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  async clickMainWorldExpression(expression, description) {
    const clicked = await this.evaluateMainWorld(`(() => {
      const el = ${expression};
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      el.scrollIntoView({ block: "center", inline: "center" });
      const nextRect = el.getBoundingClientRect();
      const x = nextRect.left + nextRect.width / 2;
      const y = nextRect.top + nextRect.height / 2;
      if (typeof el.focus === "function") {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      }
      const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
      el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: 1 }));
      return true;
    })()`);
    assert.ok(clicked, `Could not click ${description}`);
  }

  async clickSelector(selector) {
    await this.clickExpression(`document.querySelector(${JSON.stringify(selector)})`);
  }

  async hoverSelector(selector) {
    await this.hoverExpression(
      `document.querySelector(${JSON.stringify(selector)})`,
      `selector: ${selector}`,
    );
  }

  async hoverText(text) {
    await this.hoverExpression(`findByText(${JSON.stringify(text)})`, `text: ${text}`);
  }

  async hoverTextIn(selector, text) {
    await this.hoverExpression(
      `findByTextIn(${JSON.stringify(selector)}, ${JSON.stringify(text)})`,
      `text in ${selector}: ${text}`,
    );
  }

  async hoverMessage(role, text) {
    await this.hoverExpression(
      `messageByText(${JSON.stringify(role)}, ${JSON.stringify(text)})`,
      `${role} message: ${text}`,
    );
  }

  async hoverExpression(expression, description) {
    const rect = await this.rectFor(expression);
    assert.ok(rect, `Could not hover ${description}`);
    await this.mouse(rect.x, rect.y, "mouseMoved");
    await this.evaluate(`(() => {
      const el = ${expression};
      if (!el) return;
      el.dispatchEvent(new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        clientX: ${JSON.stringify(rect.x)},
        clientY: ${JSON.stringify(rect.y)},
        screenX: ${JSON.stringify(rect.x)},
        screenY: ${JSON.stringify(rect.y)}
      }));
    })()`);
  }

  async clickButtonByTitle(title) {
    await this.clickMainWorldExpression(
      `Array.from(document.querySelectorAll("button[title], button[aria-label]")).find((button) => {
        const label = button.title || button.getAttribute("aria-label") || "";
        if (label !== ${JSON.stringify(title)}) return false;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })`,
      `button title: ${title}`,
    );
  }

  async clickButtonByText(text) {
    await this.clickMainWorldExpression(
      `Array.from(document.querySelectorAll("button")).find((button) => {
        const content = button.textContent?.trim() ?? "";
        const label = button.title || button.getAttribute("aria-label") || "";
        return (content.includes(${JSON.stringify(text)}) || label.includes(${JSON.stringify(text)})) && window.__aguiE2e.isVisible(button);
      })`,
      `button text: ${text}`,
    );
  }

  async clickButtonByExactText(text, selector = "button") {
    await this.clickExpression(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((button) => button.textContent?.trim() === ${JSON.stringify(text)} && window.__aguiE2e.isVisible(button))`,
    );
  }

  async clickMenuItem(text) {
    await this.clickExpression(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => {
        const content = item.textContent?.trim() || "";
        return (content === ${JSON.stringify(text)} || content.includes(${JSON.stringify(text)})) && window.__aguiE2e.isVisible(item);
      })`,
    );
  }

  async setTextarea(value) {
    const textareaSelector = "textarea[placeholder]";
    const editorSelector =
      "textarea[placeholder], .composer-editor[role='textbox'], [role='textbox'][aria-multiline='true']";
    const hasTextarea = await this.evaluate(
      `document.querySelector(${JSON.stringify(textareaSelector)}) !== null`,
    );
    if (hasTextarea) {
      await this.clickSelector(textareaSelector);
      await this.evaluate(`(() => {
        const textarea = document.querySelector("textarea[placeholder]");
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, ${JSON.stringify(value)});
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
      })()`);
    } else {
      await this.clickSelector(editorSelector);
      await this.hotkey("Meta", "KeyA");
      await this.press("Backspace");
      await this.call("Input.insertText", { text: value });
      await this.waitFor(
        (expected, selector) =>
          Array.from(document.querySelectorAll(selector)).some((element) =>
            element.textContent?.includes(expected),
          ),
        "composer editor text",
        5_000,
        value,
        editorSelector,
      );
    }
    await this.waitFor(() => {
      const send = buttonWithTitle("Send");
      return Boolean(send && !send.disabled);
    }, "composer send enabled");
  }

  async setInputValueByLabel(label, value) {
    await this.evaluate(`(() => {
      const input = Array.from(document.querySelectorAll("input, textarea")).find(
        (element) =>
          element.getAttribute("aria-label") === ${JSON.stringify(label)} &&
          window.__aguiE2e.isVisible(element),
      );
      if (!input) throw new Error("Input not found: ${label}");
      input.focus();
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
    })()`);
  }

  async typeText(text) {
    for (const char of text) {
      if (char === "\n") {
        await this.press("Enter");
        continue;
      }
      await this.call("Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        unmodifiedText: char,
      });
    }
  }

  async typeKeyEvents(text) {
    for (const char of text) {
      if (char === "\n") {
        await this.press("Enter");
        continue;
      }
      const mapped = keyMap(char);
      await this.call("Input.dispatchKeyEvent", { type: "keyDown", ...mapped });
      await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...mapped });
    }
  }

  async press(key) {
    const mapped = keyMap(key);
    await this.call("Input.dispatchKeyEvent", { type: "keyDown", ...mapped });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...mapped });
  }

  async hotkey(modifier, key) {
    const modifiers =
      modifier === "Alt" ? 1 : modifier === "Meta" ? 4 : modifier === "Control" ? 2 : 0;
    const mapped = keyMap(key);
    await this.call("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...keyMap(modifier),
      modifiers,
    });
    await this.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...mapped, modifiers });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...mapped, modifiers });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...keyMap(modifier) });
  }

  mouse(x, y, type, extra = {}) {
    return this.call("Input.dispatchMouseEvent", { type, x, y, ...extra });
  }

  async close() {
    this.socket.close();
  }
}

export class JsonRpc {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        this.listeners.get(message.method)?.forEach((listener) => listener(message.params));
      }
    };
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
      setTimeout(() => reject(new Error("JSON-RPC websocket open timeout")), 10_000);
    });
    return new JsonRpc(socket);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

export function keyMap(key) {
  const aliases = {
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
    Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
    Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  };
  if (aliases[key]) return aliases[key];
  if (/^Key[A-Z]$/.test(key)) {
    const letter = key.slice(3).toLowerCase();
    return { key: letter, code: key, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0) };
  }
  if (key.length === 1) {
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
  }
  return { key, code: key };
}

export async function waitForCdpPage(port, options = {}) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const pages = targets.filter(
        (target) => target.type === "page" && target.webSocketDebuggerUrl,
      );
      const page = options.preferApp
        ? pages.find((target) => String(target.url ?? "").includes("/dist/index.html"))
        : pages[0];
      if (page) return page;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for Electron CDP page.");
}

export async function waitForHealth(port) {
  const endpoint = `http://127.0.0.1:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const health = await fetch(endpoint).then((response) => response.json());
      if (health.ok) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for JSON-RPC runtime health.");
}

export async function waitUntil(predicate, description, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
