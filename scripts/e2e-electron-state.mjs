import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workspaceName = path.basename(root);
export const electronBin = path.join(root, "node_modules", ".bin", "electron");
export const fakeAgent = path.join(root, "scripts", "fake-asp-agent.mjs");
export const fakeCodexAgent = path.join(root, "scripts", "fake-codex-app-server.mjs");
export const showcaseExtension = path.join(root, "scripts", "fixtures", "showcase-extension");
export const providerId = `agui-e2e-fake-${process.pid}`;
export const codexReasoningProviderId = `agui-e2e-codex-reasoning-${process.pid}`;
export const rpcToken = `e2e-${process.pid}-${Date.now()}`;
export const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-e2e-profile-"));
export const aguiHomeDir = path.join(userDataDir, ".agui");
export const userExtensionsDir = path.join(aguiHomeDir, "extensions");
export const extensionStatePath = path.join(aguiHomeDir, "extensions-state.json");
export const showcaseArchive = path.join(userDataDir, "fixture.showcase.aguix");
export const generatedFixturesRoot = path.join(userDataDir, "extension-fixtures");
export const showcaseUpgradeSource = path.join(generatedFixturesRoot, "showcase-upgrade");
export const showcaseUpgradeArchive = path.join(userDataDir, "fixture.showcase-1.1.0.aguix");
export const corruptShowcaseArchive = path.join(userDataDir, "fixture.showcase-corrupt.aguix");
export const zipSlipArchive = path.join(userDataDir, "zip-slip.aguix");
export const invalidEngineExtension = path.join(generatedFixturesRoot, "invalid-engine");
export const invalidNamespaceExtension = path.join(generatedFixturesRoot, "invalid-namespace");
export const invalidUiSchemaExtension = path.join(generatedFixturesRoot, "invalid-ui-schema");
export const escapingPathExtension = path.join(generatedFixturesRoot, "escaping-path");
export const crashingExtension = path.join(generatedFixturesRoot, "crashing-extension");
export const exitingExtension = path.join(generatedFixturesRoot, "exiting-extension");
export const hangingExtension = path.join(generatedFixturesRoot, "hanging-extension");
export const staleSecretV1Extension = path.join(generatedFixturesRoot, "stale-secret-v1");
export const staleSecretV2Extension = path.join(generatedFixturesRoot, "stale-secret-v2");
export const securityUiExtension = path.join(generatedFixturesRoot, "security-ui-extension");
export const unsupportedCodexPlugin = path.join(generatedFixturesRoot, "unsupported-codex-plugin");
export const oversizedDirectoryExtension = path.join(
  generatedFixturesRoot,
  "oversized-directory-extension",
);
export const workspaceFixtureRoot = path.join(generatedFixturesRoot, "workspace");

export let cdpPort = 0;
export let rpcPort = 0;
export let electron;
export let cdp;
export let rpc;
export let shuttingDown = false;

export function setPorts(nextCdpPort, nextRpcPort) {
  cdpPort = nextCdpPort;
  rpcPort = nextRpcPort;
}

export function setElectron(nextElectron) {
  electron = nextElectron;
}

export function setCdp(nextCdp) {
  cdp = nextCdp;
}

export function setRpc(nextRpc) {
  rpc = nextRpc;
}

export const results = [];
export const pageHelperScript = String.raw`
(() => {
  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function buttonWithTitle(title) {
    const buttons = Array.from(document.querySelectorAll("button")).filter((button) => button.title === title || button.getAttribute("aria-label") === title);
    return buttons.find(isVisible) ?? buttons[0] ?? null;
  }

  function buttonWithText(text) {
    return Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ?? null;
  }

  function visibleButton(title) {
    return Array.from(document.querySelectorAll("button")).some((button) => {
      return (button.title === title || button.getAttribute("aria-label") === title) && isVisible(button);
    });
  }

  function findByText(text, root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (!(element instanceof HTMLElement)) continue;
      if (element.children.length > 0) continue;
      if (element.textContent?.includes(text)) return element;
    }
    return null;
  }

  function findByTextIn(selector, text) {
    const root = document.querySelector(selector);
    return root ? findByText(text, root) : null;
  }

  function messageByText(role, text) {
    const message = Array.from(document.querySelectorAll('[data-chat-message="' + role + '"]')).find((element) => element.textContent?.includes(text)) ?? null;
    return role === "assistant" ? (message?.closest("[data-chat-block-id]") ?? message) : message;
  }

  window.__aguiE2e = { isVisible, buttonWithTitle, buttonWithText, visibleButton, findByText, findByTextIn, messageByText };
  window.buttonWithTitle = buttonWithTitle;
  window.buttonWithText = buttonWithText;
  window.visibleButton = visibleButton;
  window.findByText = findByText;
  window.findByTextIn = findByTextIn;
  window.messageByText = messageByText;
})();
`;

export function pass(message) {
  results.push(message);
  console.log(`✓ ${message}`);
}

export async function stopElectron() {
  if (!electron || electron.exitCode !== null) return;
  shuttingDown = true;
  electron.kill("SIGINT");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    electron.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (electron.exitCode === null) electron.kill("SIGTERM");
}
