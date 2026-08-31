---
title: 浏览器自动化与 MCP Gateway
description: 让 Agent 驱动内嵌浏览器、通过单一 Gateway 代理 MCP，并调度定时任务。
---

AGUI 在聊天之外附带了一组 runtime 服务：代理工具访问的 MCP Gateway、可被 Agent 检查和驱动的内嵌浏览器、面向 Web 客户端的远程屏幕投射、定时任务运行，以及私有草稿会话。本指南介绍每一项的功能、配置方式，以及纯 Web 模式下的降级行为。

## MCP Gateway

只需注册一次 MCP server，AGUI 就会向每个新的 Agent run 注入一个专用的 gateway MCP server。Agent 看不到已连接的工具目录——它们只能使用 `agui-mcp-gateway` server 暴露的四个元工具：

| 元工具                         | 用途                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `code_tool.resolve`            | 在已连接的 MCP 服务中搜索任务所需的最小工具集。                       |
| `code_tool.invoke`             | 调用本次会话中 `code_tool.resolve` 已返回的某个 MCP 工具。            |
| `code_tool.workflow`           | 使用 plan DSL 或 TypeScript 代码，对已解析的 MCP 工具执行多步工作流。 |
| `code_tool.request_user_input` | 打开原生输入卡片，收集结构化用户输入、确认，或展示 MCP App 界面。     |

`code_tool.resolve` 返回 `matched: false` 时，表示 Agent 应在不使用 Gateway 的情况下继续。

### 注入机制

每个 run 开始时，runtime 会在本地 Unix socket（Windows 上为命名管道）上启动一个会话级 JSON-RPC server，并向 Agent 提供一个 `stdio` MCP server 引用，其命令是一个小型桥接脚本。桥接进程通过 `AGUI_MCP_GATEWAY_SOCKET`、`AGUI_MCP_GATEWAY_TOKEN` 和 `AGUI_MCP_GATEWAY_SESSION_ID` 环境变量连回 runtime；token 每个 run 随机生成，并使用 timing-safe 比较。每个 run 还会附加开发者指令，要求 Agent 先调用 `code_tool.resolve` 再直接使用工具。

Provider adapter 会把 Gateway 与各自的原生工具语义对接：

- **Codex**：Gateway 工具被强制启用并自动批准，同时注册了下划线别名（`code_tool_resolve` 等），因为 Codex 对工具名字符集有限制。
- **Claude Code**：Gateway server 会写入临时 `mcp.json` 并通过 `--mcp-config` 传入，同时用 `--permission-mode` 和 `--permission-prompt-tool stdio` 遵循你的审批设置。

三个内置工具提供方会直接注册进 Gateway，无需任何外部 server：`agui_panel`（终端、IDE 与面板工具）、`agui_browser`（浏览器自动化）和 `agui_browser_workflows`（已保存的浏览器工作流）。浏览器提供方只有在浏览器面板标签页打开、且 runtime 报告 `features.browserAutomation` 时才会注册。

### 配置 Gateway

打开 **设置 → MCP Gateway**（`settings.section.mcpGateway`），该分区提供：

- 启用/禁用开关。启用前需要配置 **Resolve model**——即 `code_tool.resolve` 使用的 LLM（未命中时由 tree-sitter 提取工具引用兜底）。在 Resolve model 对话框中设置模型、base URL 和 API key（存在 `OPENAI_API_KEY` 兜底）。
- **Add MCP server**，支持 `http`、`sse`、`stdio` 三种 transport，可配置 headers、环境变量以及 Bearer / API key / Basic 认证。
- **JSON 导入**，接受 `mcpServers` JSON 块（兼容 `streamablehttp` transport 别名）或单个 server 对象。
- **Refresh MCP Gateway** 重新发现工具，并提供按 server 列出的端点、工具数量和发现状态。

配置持久化在 AGUI 用户数据目录下的 `mcp-gateway.json`：

```json
{
  "enabled": true,
  "llm": { "enabled": true, "model": "gpt-4.1-mini", "baseUrl": "", "apiKey": "" },
  "servers": [
    {
      "id": "docs-search",
      "name": "Docs search",
      "transport": "http",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ..." },
      "authentication": { "type": "bearer", "token": "..." }
    }
  ]
}
```

在 WebAuth 或 OAuth 多租户模式下，每个租户读写用户数据目录 `tenants/<tenant-key>/` 中自己的文件。共享环境变量见[配置参考](/zh-cn/reference/configuration/)。扩展也可以向 Gateway 贡献 MCP server——见[扩展进阶](/zh-cn/guides/extensions-advanced/)。

## 浏览器自动化工具

浏览器提供方注册后，Agent 通过 Gateway 获得以下工具：

| 分组          | 工具                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标签页与导航  | `browser_list_tabs`、`browser_open_tab`、`browser_close_tab`、`browser_navigate`、`browser_reload`、`browser_stop`、`browser_go_back`、`browser_go_forward` |
| 交互          | `browser_click`（CSS 选择器或视口坐标）、`browser_type`、`browser_execute_script`                                                                           |
| 读取          | `browser_snapshot`（可见文本，可选 HTML）、`browser_screenshot`（PNG/JPEG）、`browser_inspect_element`                                                      |
| DevTools 协议 | `browser_cdp_command`、`browser_cdp_start_capture`、`browser_cdp_events`、`browser_cdp_stop_capture`                                                        |
| 标注          | `browser_set_annotation_mode`、`browser_list_annotations`、`browser_add_annotation`、`browser_delete_annotation`、`browser_clear_annotations`               |

CDP 接口经过安全过滤：方法必须匹配 `Domain.method` 格式，参数有大小上限，事件捕获仅限 CSS、DOM、Log、Network、Page、Performance、Runtime 和 Tracing 域。导航只接受 `http:`、`https:` 和 `about:blank`。同一个面板工具提供方还会暴露 `panel_*`、`terminal_*`、`ide_*` 工具，用于驱动 AGUI 自己的面板与工作区。

## 浏览器标注

标注模式让你直接在页面上圈出问题。在浏览器面板工具栏打开 **Add annotation**，然后在页面上点击或拖拽：AGUI 会创建一个 **element** 标注（基于 CSS 选择器）或 **region** 标注（基于视口矩形），同时记录你的备注和上下文——选择器、标签名、文本、视口矩形、URL 和计算样式。

标注会作为上下文附加到输入框，供下一次提问使用；Agent 也可以通过 `browser_list_annotations` 读取、通过 `browser_add_annotation` 补充标注。

### 从标注生成工作流

`browser_workflow_generate_from_annotations` 读取当前标注并生成工作流草稿：备注包含 `type` / `fill` / `input` 的生成输入步骤；包含 `verify` / `check` / `wait` / `assert` 的生成等待或断言步骤；其余生成点击步骤。工作流支持 `click`、`type`、`navigate`、`submit`、`snapshot`、`waitFor`、`assert` 步骤，保存在用户数据目录的 `browser-workflows.json` 中；保存后还会作为独立的 `browser_workflow_<id>` 固定工具注入，Agent 可以直接重放。通过 `browser_workflow_list`、`browser_workflow_get`、`browser_workflow_save`、`browser_workflow_delete` 和 `browser_workflow_run` 进行列表、读取、保存、删除和运行。

## 远程浏览器屏幕投射

AGUI Desktop 在原生 `WebContentsView` 中渲染内嵌浏览器。通过 Remote Access 连接的 Web 客户端则以屏幕投射方式接收浏览器画面：桌面端以 base64 JPEG 帧流式输出（约每秒 10 帧，基于 ack 的流控，上限 1600×1200、质量 72），远程端把指针、滚轮、键盘和粘贴输入转成 CDP 事件回传。每次输入都会触发立即的帧刷新，因此画面保持实时。

屏幕投射与原始输入都要求 Remote Access 处于启用状态，否则 runtime 方法会拒绝并提示"Browser remote control is only available while AGUI Remote Access is running"。使用 `AG_UI_RPC_TOKEN`、`AG_UI_WEB_HOST` 和 `AG_UI_WEB_PORT` 配置，详见[配置参考](/zh-cn/reference/configuration/)。远程查看不需要桌面端预先打开浏览器标签页；AGUI 会在导航时自动创建标签页并启动投射。

### 纯 Web 模式连接真实 Chrome

Node server 可以自行启动 Chrome（或连接已有实例）并通过 CDP 投射画面，因此没有 Electron 也能使用浏览器自动化。通过后端变量指向可用的 Chrome 可执行文件即可启用：

| 变量（同样接受 AGUI_ 别名）      | 用途                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `AG_UI_BROWSER_BACKEND`          | 未设置或为真值（`1`、`true`、`cdp`、`chrome` 等）时启用；`0`、`false`、`none` 禁用。 |
| `AG_UI_CHROME_EXECUTABLE_PATH`   | Chrome/Chromium 路径。`CHROME_PATH` 为兜底；两者都没有时后端不可用。                 |
| `AG_UI_CHROME_CDP_ENDPOINT`      | 连接已有 CDP 端点，而不是启动新 Chrome。                                             |
| `AG_UI_CHROME_CDP_AUTHORIZATION` | CDP 端点的 Authorization 头。                                                        |
| `AG_UI_CHROME_USER_DATA_DIR`     | Profile 目录；默认使用临时 `agui-chrome-*` 目录。                                    |
| `AG_UI_CHROME_LAUNCH_TIMEOUT_MS` | 启动超时，默认 15000 毫秒。                                                          |
| `AG_UI_CHROME_HEADLESS`          | 未设为假值时以 `--headless=new` 启动。                                               |
| `AG_UI_CHROME_NO_SANDBOX`        | 添加 `--no-sandbox`（以 root 运行时自动启用）。                                      |
| `AG_UI_CHROME_ARGS`              | 额外启动参数，JSON 数组或空格分隔字符串。                                            |

### 各环境能力对照

| 环境                                    | 浏览器嵌入方式         | Agent 浏览器工具         |
| --------------------------------------- | ---------------------- | ------------------------ |
| 桌面（Electron）                        | 原生 `WebContentsView` | 完整工具集               |
| 纯 Web + Chrome 后端 + Remote Access    | 屏幕投射帧             | 完整工具集               |
| 纯 Web 无 Chrome（例如 `pnpm dev:web`） | 沙箱 iframe            | 无（不注册浏览器提供方） |

纯 Web 模式下降级的桌面专属功能总览见[架构](/zh-cn/getting-started/architecture/)。

## 定时任务

定时任务按日期或周期自动运行一个 prompt，前提是 AGUI 处于打开状态。每次运行都会以任务配置的 provider、model、effort、speed 和审批模式（默认 `auto-edit`）启动一个真实的 ASP 会话，并像普通会话一样出现在侧边栏。

可以从侧边栏的 **Schedule** 按钮、Schedule 页面的 **New task** 按钮，或会话菜单中的 **Add scheduled task…**（用当前会话预填表单）创建任务。

### 调度类型

不使用 cron 语法——四种周期覆盖所有选项：

| 类型       | 字段                          |
| ---------- | ----------------------------- |
| `once`     | `date`、`time`                |
| `daily`    | `time`                        |
| `weekly`   | `weekdays`（0–6）、`time`     |
| `interval` | `intervalMinutes`（1–525600） |

调度器在进程内每 30 秒轮询一次。AGUI 重新打开时会补跑错过的任务（标记为 `catch_up` 并记录错过次数）；失败按默认 5 分钟退避、重试 1 次的策略处理，上限为 7 天内 5 次尝试。每个任务保留最近 20 条运行历史，状态为 `running`、`success`、`failed` 或 `canceled`，原因为 `scheduled`、`manual`、`retry` 或 `catch_up`。

任务存储在 runtime 键值存储中（默认 SQLite，可通过 `AG_UI_STORAGE_BACKEND` 切换 Postgres），在 WebAuth/OAuth 模式下按租户隔离。UI 开关 `VITE_AGUI_FEATURE_SCHEDULED_TASKS`（默认 `true`）控制该界面是否出现。JSON-RPC 接口为 `scheduledTasks.list`、`add`、`update`、`remove`、`setEnabled` 和 `runNow`。

## 私有会话

没有关联项目的对话不会运行在共享目录中。AGUI 会在用户数据目录下为其分配独立的草稿工作区 `private-sessions/<YYYY-MM-DD>/<sessionId>`（多租户认证下按租户隔离），侧边栏将这些对话归入"AGUI 私有会话"分组。应用可通过 `workspace.privateRoot` 和 `workspace.privateSession` 这两个 runtime 方法解析这些路径；没有项目路径的定时任务也会在每次运行时获得全新的私有会话目录。

## 继续阅读

- [扩展进阶](/zh-cn/guides/extensions-advanced/) — 扩展贡献的 MCP server、Gateway 注入与工作区信任。
- [配置参考](/zh-cn/reference/configuration/) — Remote Access、存储后端与租户变量。
- [Provider](/zh-cn/guides/providers/) — Agent run 与审批模式如何与 Gateway 自动批准配合。
