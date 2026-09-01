# AGUI Desktop

[English](README.md)

**面向编码 Agent 的通用桌面与 Web 工作台。**

AGUI Desktop 为工程团队提供一个统一、精致、可扩展的 Agent 客户端。Codex、Claude
Code、OpenCode、Pi、Grok、Kimi、Kilo，以及任何兼容 Agent Server Protocol（ASP）的
Agent，都可以进入同一个工作区，共享会话、审批、浏览器自动化、文件、终端和扩展 UI。

> **Alpha 预览版。** AGUI Desktop 已适合开发者试用、集成验证和社区反馈，平台能力会
> 持续演进。

![AGUI Desktop 应用截图](assets/agui-desktop-screenshot.png)

![AGUI GitHub 扩展截图](assets/agui-github-extension-screenshot.jpg)

## 为什么选择 AGUI

编码 Agent 正在快速变强，团队需要一个稳定、原生、可治理、可扩展的客户端。AGUI
Desktop 将不同 Agent runtime 的能力收束成统一产品体验。

- **一个工作区接入多种 Agent**：通过 ASP 承载会话，在一致体验中切换 provider。
- **人工控制内置于流程**：命令、文件和网络审批都回到同一个对话界面。
- **桌面能力与 Web 部署兼具**：可作为 Electron 桌面应用运行，也可通过
  `@the-next-ai/server` 部署纯 Web runtime。
- **自动化紧贴聊天上下文**：把浏览器、终端和 IDE 面板能力安全提供给 Agent。
- **为扩展和品牌化准备**：支持面板、自定义聊天组件、主题、命令、MCP Server 和
  Skill。

## 适合谁

- 希望为 ASP-compatible runtime 提供客户端 Shell 的 Agent 平台团队
- 正在打造品牌化编码 Agent 产品的开发者工具团队
- 需要统一 Agent 访问、审批和 workspace policy 的内部平台团队
- 研究多 Agent UX、原生适配器和可移植 Agent 会话的协议/体验团队

## 产品亮点

### Agent 选择

AGUI 内置 Codex app-server、Claude Code stream-json、OpenCode server、Pi RPC、
Grok headless CLI 和 Kimi headless CLI 原生适配器，也支持通过 stdio、persistent
stdio、WebSocket 或 SSH 接入 Kilo 与自定义 ASP Agent。

### ASP-Native Runtime

Agent Server Protocol v1 为 renderer 提供稳定事件流，覆盖文本、reasoning、plan、
tool、diff、resource、artifact、usage、approval 和 question。同一套 contract 同时驱动
Electron 与 Node server runtime。

### 安全的操作闭环

AGUI 让敏感动作保持可见。Agent 可以请求命令执行、文件修改、网络访问和结构化用户输入，
客户端把审批动作放在工作上下文附近。

### 浏览器与工作区自动化

内置 MCP Gateway 可以把应用面板、终端、IDE 文件和应用内浏览器自动化开放给 Agent。
Provider 可以通过受控工具打开页面、读取状态、点击、输入、截图，并组织浏览器工作流。

### 可扩展的产品界面

扩展可以贡献侧边面板、自定义渲染器、UI Schema、命令、主题、MCP 资源和 Skills。AGUI
适合团队基于共享 runtime foundation 打造自己的 Agent 产品体验。

## 快速开始

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会启动 Vite renderer、Electron 主进程 TypeScript watcher 和 Electron 窗口。

运行浏览器前端预览：

```bash
pnpm dev:web
```

运行连接本地 Node runtime 的纯 Web 应用：

```bash
pnpm dev:pure-web
```

生产构建后启动 server：

```bash
pnpm server
```

## 文档站

文档位于 `docs/`，包含英文和简体中文内容。

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

## 认证

`@the-next-ai/server` 提供 WebAuth、OAuth/OIDC、共享 token 和 disabled-auth 模式，覆盖不同
部署形态。

| 模式       | 适用场景                   |
| ---------- | -------------------------- |
| `webauth`  | 使用内置登录页的简单部署   |
| `oauth`    | 外部 OAuth/OIDC 身份提供方 |
| `token`    | 反向代理后的受信单租户部署 |
| `disabled` | 本地开发和隔离内网环境     |

WebAuth 单用户部署可以从这里开始：

```bash
AG_UI_WEBAUTH_USERNAME=admin
AG_UI_WEBAUTH_PASSWORD=...
```

OAuth/OIDC 部署使用：

```bash
AG_UI_AUTH_MODE=oauth
AG_UI_PUBLIC_URL=https://agui.example.com
AG_UI_OAUTH_ISSUER=https://issuer.example.com
AG_UI_OAUTH_CLIENT_ID=...
AG_UI_OAUTH_CLIENT_SECRET=...
```

租户数据写入 `$AG_UI_USER_DATA_DIR/tenants/<tenant-key>/`。workspace roots 可通过
`AG_UI_TENANT_WORKSPACE_ROOTS` 映射，并支持 `{tenant}`、`{tenantId}`、`{user}`、
`{userId}` 和 `{emailDomain}` 模板。

## 仓库结构

```text
.
├── packages/
│   ├── app/                 Renderer React UI、ASP bridge 和产品 Shell
│   ├── asp/                 ASP 协议、传输、Provider 和适配器
│   ├── electron/            Electron Shell、IPC 和 preload
│   ├── extensions/          扩展 manifest、IPC 和 UI Schema 类型
│   ├── runtime/             Electron 与 Node server 共享 runtime
│   └── server/              纯 Web server 启动入口
├── extensions/              第一方扩展示例
├── docs/                    文档站
└── scripts/                 开发、测试、打包和发布脚本
```

常用包入口：

- `@the-next-ai/app`：前端扩展 UI API 和 contribution registry
- `@the-next-ai/asp`：`./manager`、`./protocol`、`./transport`、`./provider-store` 和
  `./types`
- `@the-next-ai/runtime`：provider 管理、会话、终端、IDE 文件、MCP Gateway 和 JSON-RPC 的共享
  runtime
- `@the-next-ai/server`：可部署的纯 Web runtime 入口

## 验证

```bash
pnpm typecheck
pnpm test:asp
pnpm test:extensions
pnpm build:app
```

`test:asp` 在本地运行，覆盖 provider 协商、reasoning、plan、tool、diff、usage、完成
事件、审批、提问和原生适配器投影。

## 打包与发布

```bash
pnpm pack:frontend
pnpm pack:server
pnpm pack:electron
```

发布产物写入 `release/`：

- `release/frontend/`：前端静态资源
- `release/server/`：包含静态资源的可部署 `@the-next-ai/server` bundle
- `release/electron/`：macOS DMG/ZIP、Windows NSIS、Linux AppImage 等平台安装包

发布 npm 包并上传当前平台 Electron 安装包到 GitHub Release：

```bash
pnpm release
pnpm release:dry-run
```

常用参数：

```bash
pnpm release -- --tag v0.1.0
pnpm release -- --skip-npm
pnpm release -- --skip-electron
pnpm release -- --npm-tag next --github-release prerelease
```

正式分发桌面安装包前建议配置平台代码签名。macOS、Windows、Linux 安装包需要分别在对应
平台生成。

## License 与商标

AGUI Desktop 使用 [MIT License](LICENSE) 发布。AGUI 是独立社区项目。兼容性引用属于
各自权利方，仅用于说明互操作背景。详见 [NOTICE](NOTICE.md)。
