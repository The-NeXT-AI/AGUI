---
title: 安装与运行
description: 安装依赖、本地运行 AGUI，并预览文档站。
---

AGUI 是一个 pnpm monorepo。以下所有命令都在仓库根目录执行。

## 前置要求

- Node.js 22 或更新版本（仓库通过 `.node-version` 固定 `22.12.0`）。
- pnpm 9.15.1 —— `packageManager` 字段固定了精确版本，Corepack 会自动安装。
- 你打算驱动的 Agent CLI，例如 Codex、Claude Code、OpenCode、Pi、Grok、Kimi 或 Kilo。

## 安装依赖

```bash
pnpm install
```

`postinstall` 会修补桌面 runtime 使用的本地 `node-pty` spawn helper。

## 运行桌面应用

```bash
pnpm dev
```

该命令会启动 Vite renderer、Electron 主进程 watch，并打开 Electron 窗口。

## 运行纯 Web 模式

只启动 renderer：

```bash
pnpm dev:web
```

renderer 与 Node JSON-RPC 后端一起启动：

```bash
pnpm dev:pure-web
```

`dev:pure-web` 会启动 Vite 和 `@the-next-ai/agui-server`，前端再通过 WebSocket 连接 `/agui-rpc`。

## 构建发行版

打包前端静态产物、可部署 server 和 Electron 应用：

```bash
pnpm pack:frontend
pnpm pack:server
pnpm pack:electron
```

`pack:server` 会把可部署的 `@the-next-ai/agui-server` 目录和构建好的前端打包在一起；`pack:electron` 在 `release/electron/` 下产出 macOS DMG/ZIP、Windows NSIS 和 Linux AppImage。或者只做常规生产构建：

```bash
pnpm build:app
```

## 运行生产 server

打包完成后，`pnpm server` 会在同一进程内提供构建好的前端和 Node JSON-RPC 后端。认证、监听和 workspace root 相关环境变量见[配置参考](/zh-cn/reference/configuration/)。

## 运行文档站

用 `pnpm docs:dev` 在本地预览文档站，`pnpm docs:build` 构建，`pnpm docs:preview` 预览生产构建。

## 验证安装

按改动范围运行对应的检查：

```bash
pnpm typecheck
pnpm test:asp
pnpm test:extensions
pnpm build:app
```

## 继续阅读

- [架构](/zh-cn/getting-started/architecture/)
- [Provider](/zh-cn/guides/providers/)
- [配置参考](/zh-cn/reference/configuration/)
