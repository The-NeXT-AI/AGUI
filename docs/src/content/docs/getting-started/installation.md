---
title: Installation
description: Install dependencies, run AGUI locally, and preview the documentation site.
---

AGUI is a pnpm monorepo. Everything below runs from the repository root.

## Prerequisites

- Node.js 22 or newer (the repo pins `22.12.0` via `.node-version`).
- pnpm 9.15.1 — the exact version is pinned by the `packageManager` field, so Corepack installs it automatically.
- The agent CLIs you plan to drive, such as Codex, Claude Code, OpenCode, Pi, Grok, Kimi, or Kilo.

## Install dependencies

```bash
pnpm install
```

The postinstall step patches the local `node-pty` spawn helper used by the desktop runtime.

## Run the desktop app

```bash
pnpm dev
```

This starts the Vite renderer, the Electron main process watcher, and opens an Electron window.

## Run pure web mode

For the renderer alone:

```bash
pnpm dev:web
```

For the renderer plus the Node JSON-RPC backend:

```bash
pnpm dev:pure-web
```

`dev:pure-web` starts Vite and `@the-next-ai/agui-server`, then connects the frontend to `/agui-rpc` over WebSocket.

## Build a distribution

Package the static frontend, the deployable server, and the Electron app:

```bash
pnpm pack:frontend
pnpm pack:server
pnpm pack:electron
```

`pack:server` bundles the deployable `@the-next-ai/agui-server` directory together with the built frontend; `pack:electron` produces macOS DMG/ZIP, Windows NSIS, and Linux AppImage artifacts under `release/electron/`. Or run a plain production build:

```bash
pnpm build:app
```

## Run the production server

After packaging, `pnpm server` serves the built frontend plus the Node JSON-RPC backend from the same process. Auth, listener, and workspace-root environment variables are listed in the [Configuration Reference](/reference/configuration/).

## Run the docs site

Serve the docs locally with `pnpm docs:dev`, build them with `pnpm docs:build`, and preview a production build with `pnpm docs:preview`.

## Verify your setup

Run the focused checks that match the area you changed:

```bash
pnpm typecheck
pnpm test:asp
pnpm test:extensions
pnpm build:app
```

## Continue

- [Architecture](/getting-started/architecture/)
- [Providers](/guides/providers/)
- [Configuration Reference](/reference/configuration/)
