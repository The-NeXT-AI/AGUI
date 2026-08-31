#!/usr/bin/env node
import process from "node:process";
import { NodeRuntimeServer, configuredRuntimeAuthOptions } from "@agui/runtime";
import { createServerExtensionRuntime } from "./extensions/server-extension-method.js";
import {
  createChromeBrowserService,
  chromeBrowserBackendEnabled,
} from "./chrome-browser-service.js";

async function main(): Promise<void> {
  const serverRef: { current?: NodeRuntimeServer } = {};
  const defaultWorkspace =
    process.env.AG_UI_WORKSPACE || process.env.AGUI_WORKSPACE || process.cwd();
  const { extensionMethod, extensionService } = createServerExtensionRuntime({
    defaultWorkspace,
    emit: (event) => serverRef.current?.broadcast("agui:extensions:event", event),
  });
  const browserService = chromeBrowserBackendEnabled(process.env)
    ? createChromeBrowserService({
        emit: (channel, payload) => serverRef.current?.broadcast(channel, payload),
        env: process.env,
        log: console,
      })
    : undefined;
  const server = new NodeRuntimeServer({
    auth: configuredRuntimeAuthOptions(process.env, { mode: "webauth" }),
    defaultWorkspace,
    extensionMethod,
    ...(browserService ? { browserMethod: browserService.handler } : {}),
    runtimeInfo: () => ({
      platform: process.platform,
      versions: { node: process.versions.node },
      features: {
        browserAutomation: Boolean(browserService),
        browserScreencast: Boolean(browserService?.browserScreencast),
        filePathAccess: false,
        nativeDialogs: false,
        webContentsView: false,
        webview: false,
      },
    }),
  });
  serverRef.current = server;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await server.stop();
      } finally {
        await browserService?.dispose();
        await extensionService.dispose();
      }
    })()
      .catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await server.start();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
