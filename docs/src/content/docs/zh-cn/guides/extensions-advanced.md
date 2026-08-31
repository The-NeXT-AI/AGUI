---
title: 扩展进阶
description: AGUI 扩展的 surface、聊天渲染器、主题、MCP 资源、secret、workspace 信任与打包。
---

本页是[扩展开发](/zh-cn/guides/extensions/)的进阶篇：扩展贡献的 Agent UI surface、聊天渲染器、主题与样式、MCP/Skills/Prompts 注入、配置与 secret、信任模型以及打包。

## Views 详解

`project.json` 是声明式 UI 文档：

```json
{
  "type": "column",
  "gap": "sm",
  "children": [
    { "type": "text", "text": "Project: {{view.name}}", "weight": "semibold" },
    { "type": "badge", "label": "Declarative", "tone": "accent" },
    {
      "type": "button",
      "label": "Refresh",
      "command": "acme.my-extension.refresh",
      "variant": "secondary"
    }
  ]
}
```

声明式节点覆盖 `text`、`container`/`box`、`row`/`column`/`stack`、`badge`、`button`、`link`、`image`、`code`、`kv`、`list` 和 `data`。按钮只能调用本扩展命名空间内的 command；链接和图片中的远端 URL 需要 `network` 权限。

Views 还支持 VS Code 风格的 `menus["view/title"]`，可使用 `when: "view == <viewId>"` 条件、`alt` 替代命令和 submenu 分组；`views[].contextualTitle` 会作为宿主 view 的 tooltip。`viewsContainers.panel` 把容器映射到右侧 detail panel，可用 `allowMultiple` 打开多个实例，用 `retainContextWhenHidden` 控制隐藏 tab 是否保持挂载。

### Web Component 与 Webview

Web Component 是自包含 HTML，宿主把它挂到 ShadowRoot 中，组件脚本在 sandbox iframe 内运行——插件脚本永远接触不到主 renderer 或 Electron preload bridge。组件脚本可直接使用注入的局部变量 `agui`、`root`、`host`：`agui.data` 读取当前 surface 数据，`agui.command(id, args)` 调用所属扩展命名空间内的命令。未授予 `network` 时，宿主会阻止 HTML/CSS 中的远端资源引用，并通过 CSP 强制执行。Webview 是完全隔离的自定义 HTML，没有 Node、同源权限和网络访问；它通过 `window.agui.data` 读取初始数据，通过 `window.agui.command` 调用命令。

## 贡献 Agent UI surface

除 VS Code 风格 views 外，AGUI 还提供 Composer、Header 和浮动 widget surface：

```json
{
  "contributes": {
    "composerControls": [
      {
        "id": "acme.my-extension.composer",
        "title": "Composer control",
        "align": "left",
        "viewType": "web-component",
        "entry": "./composer.html"
      }
    ],
    "headerControls": [
      {
        "id": "acme.my-extension.header",
        "title": "Header control",
        "align": "right",
        "viewType": "web-component",
        "entry": "./header.html"
      }
    ],
    "floatingWidgets": [
      {
        "id": "acme.my-extension.status-widget",
        "title": "Status widget",
        "position": "bottom-right",
        "width": 320,
        "height": 160,
        "viewType": "declarative",
        "entry": "./status-widget.json"
      }
    ]
  }
}
```

这些 surface 与 views 共用三种渲染模式、同一注册表和清理生命周期。浮动 widget 渲染在 viewport 角落——`position` 支持 `top-left`、`top-right`、`bottom-left`、`bottom-right`（默认 `bottom-right`）。宿主把 widget 宽度 clamp 到 120-560px、高度 clamp 到 48-640px 且不超过 viewport，同一角落的多个 widget 按 `order` 堆叠。该 contribution 自动请求 `ui.floatingWidget` 权限。

## 贡献聊天渲染器

```json
{
  "contributes": {
    "chatRenderers": [
      {
        "id": "acme.my-extension.result-card",
        "renderer": "acme.result-card",
        "mimeType": "application/vnd.acme.result+json",
        "renderMode": "declarative",
        "entry": "./result-card.json",
        "priority": 100
      }
    ]
  }
}
```

渲染器按 `kind`、`metadata.renderer` 或 `mimeType` 匹配。Declarative 渲染器通过 `{{metadata.title}}` 绑定或 `data` 节点读取消息块数据；Web Component 通过 `agui.data` 读取。普通扩展不能覆盖核心消息类型或内置 renderer selector——确有需要必须由用户授予 `ui.overrideBuiltins`。

## 贡献主题

```json
{
  "contributes": {
    "themes": [
      {
        "id": "acme.my-extension.ocean",
        "label": "Ocean",
        "type": "dark",
        "path": "./ocean.json"
      }
    ]
  }
}
```

主题文件是纯 JSON，可包含 `colors`、`terminal` 和 `monaco`。语义色键包括 `canvas`、`surface`、`surfaceHover`、`foreground`、`mutedForeground`、`border`、`accent`、`accentForeground`、`success`、`warning`、`danger`、`info`、`selection` 和 `codeBackground`。主题会同步更新应用、Monaco、Xterm 和 Mermaid。

## 贡献受控样式

```json
{
  "contributes": {
    "styles": [
      {
        "id": "acme.my-extension.compact-shell",
        "path": "./compact.css",
        "media": "(min-width: 900px)",
        "order": 50
      }
    ]
  }
}
```

`styles` 会请求 `ui.styles` 权限——这是能够隐藏或重排应用界面的高权限全局 CSS，授权页面会明确披露。宿主读取 CSS 文件，插入带扩展 owner 标记的 `<style>` 节点，并在扩展禁用、卸载或 contribution 变化时精确移除。CSS 不能使用 `@import`、`javascript:` 或 `expression()`；`url()` 默认只允许 `data:`，同时授予 `network` 后才允许远端 URL。改配色优先用 `themes`——主题 token 经过更严格的白名单校验。

## 注入 MCP、Skills 与 Prompts

```json
{
  "permissions": ["agent.mcp", "agent.skills", "agent.prompts"],
  "contributes": {
    "mcpServers": "./mcp.json",
    "skills": "./skills",
    "prompts": [
      {
        "id": "acme.my-extension.review",
        "title": "Acme review",
        "path": "./prompts/review.md",
        "autoInclude": true
      }
    ]
  }
}
```

`mcp.json` 接受 `{ "mcpServers": { ... } }`，server 可使用 `command`/`args`/`env`、`url`、`type`/`transport` 和 `headers`/`http_headers`。相对命令必须留在扩展目录内。命令型 MCP 会请求 `process.spawn`，远端 MCP 会请求 `network`，敏感 env/header 或 `${secret:NAME}` 占位符会请求 `secrets`。MCP ID 会加扩展命名空间避免冲突；`${secret:NAME}` 从扩展 secret 存储解析，无法解析时该 MCP 会被拒绝，不会把占位符传给 Agent。

扩展贡献的 MCP server 是 run-scoped Agent 资源：本轮 run 携带它们时，runtime 会临时启动 gateway bridge，把这些 server 注册进当前会话 scope，run 结束后清理。设置里的全局 MCP Gateway 开关只控制用户管理的持久 server——插件自己的 UI、配置页、session tree 和 command 不应依赖这个开关。

设计上把 MCP 当作可选能力：核心浏览、配置、登录、树节点加载应通过扩展 command 和声明式数据完成，即使用户拒绝 MCP 权限、没有配置 secret 或某个 server 启动失败，插件 UI 仍可正常工作。

`skills` 指向包含单个 `SKILL.md` 的目录，或包含多个 skill 子目录的根目录。Prompt 可以内联 `content` 或使用包内 `path`。`autoInclude: true` 的 Prompt 默认作为 developer instructions 注入，用户可在 Agent Tools 中关闭；未设置 `autoInclude` 的 Prompt 只列为可用资源，用户选中后才注入后续 run。用户可在 Agent Tools 中分别启停 MCP、Skill 和 Prompt。Codex、Claude 和通用 ASP adapter 会保留资源与来源信息。

## 配置、Secret 与扩展状态

配置由 manifest 声明，宿主负责校验、持久化和渲染：

```json
{
  "contributes": {
    "configuration": {
      "title": "Acme settings",
      "properties": {
        "acme.my-extension.mode": {
          "type": "string",
          "default": "safe",
          "enum": ["safe", "fast"]
        },
        "ACME_TOKEN": {
          "type": "string",
          "secret": true
        }
      }
    }
  }
}
```

Secret 不会通过配置读取 API 返回，也不会明文写入状态文件。Electron 使用系统安全存储；纯 Web 模式优先使用 `AG_UI_EXTENSION_SECRET_KEY`，未配置时会在 AGUI home 中生成权限为 `0600` 的随机 `extension-secret.key`。声明 Secret 会自动推导 `secrets` 权限，只有获授权的 Extension Host 能通过 `context.secrets.get` 读取。扩展还拥有隔离、限额、只接受 JSON 的全局和工作区状态：

```js
export function activate(context) {
  context.commands.registerCommand("acme.my-extension.inspect", async () => {
    const runs = context.globalState.get("runs", 0) + 1;
    await context.globalState.update("runs", runs);
    return {
      mode: context.configuration.get("acme.my-extension.mode", "safe"),
      tokenConfigured: Boolean(context.secrets.get("ACME_TOKEN")),
      runs,
    };
  });
}
```

限额：单个状态值 64 KB，每个扩展全部状态 512 KB，配置 256 KB，单个 Secret 8 KB。更新可执行扩展的配置后，宿主会销毁其进程并按需重新激活，避免旧配置残留。

## Workspace 信任与权限模型

设置页安装的是当前 workspace 的用户扩展：默认 workspace（或无 workspace）使用兼容目录 `$AG_UI_HOME/extensions`，其它 workspace 写入 `$AG_UI_HOME/workspaces/<workspace-id-sha256>/extensions`，未配置时 `$AG_UI_HOME` 默认为 `~/.agui`。每个非默认 workspace 可以安装不同扩展——或同一扩展 ID 的不同版本——并拥有独立的启用、授权、配置、Secret 和状态；同一 workspace 内同一扩展 ID 保持单版本原子替换。项目扩展从 `<workspace>/.agui/extensions` 发现。未信任项目不加载 MCP/Skills，也不执行扩展主进程代码。声明 `untrustedWorkspaces.supported: "limited"` 只允许声明式 UI 和 sandbox webview 这类静态贡献，不代表可执行代码获得信任。

扩展主进程代码与 VS Code 桌面扩展一样属于受信代码：权限确认是显式信任边界，不是 OS 级沙箱。所有后端能力都经过 Extension Host/Broker 的权限受控 API，`web-component` 和 `webview` UI 都运行在 sandbox iframe 中。宿主通过 `context.permissions` 暴露已授权权限，通过 `context.workspace` 暴露 `{ root, canRead, canWrite }`（只有授予 `workspace.read`/`workspace.write` 时才提供 `root`）。Electron 上 `runtime.fullTrust` 进程仍拥有当前系统账号的真实文件访问能力——把这些字段当作可移植 API 契约，而不是桌面沙箱。

纯 Web 模式的 Extension Host 只运行未声明 `extensionKind` 或声明包含 `"workspace"` 的扩展后端；显式 `extensionKind: ["ui"]` 的扩展只提供静态/UI 贡献。server Extension Host 默认不继承完整 `process.env`，只传最小环境白名单和 `AGUI_EXTENSION_*` 上下文变量。在支持 Node Permission Model 的运行时中默认启用 `--experimental-permission`：扩展包和 host 代码始终可读；读写 workspace 需要对应权限；子进程需要 `process.spawn`。可用 `AG_UI_EXTENSION_HOST_NODE_PERMISSIONS=0` 关闭该限制，用 `AG_UI_EXTENSION_HOST_ENV_ALLOWLIST` 覆盖环境白名单，用 `AG_UI_EXTENSION_HOST_MAX_OLD_SPACE_MB` 调整单个 host 的堆上限。Node Permission Model 是进程内防护，不替代容器、低权限用户或网络 egress policy。

## 打包、安装与升级

在仓库根目录运行：

```bash
pnpm extension:pack -- ./path/to/extension ./my-extension.aguix
```

生成的 `.aguix` 是带路径、文件数和体积保护的 ZIP 包。打包器支持 `package.json` 的 `files` 白名单和根目录 `.aguixignore`，默认跳过 `.env`、`.npmrc`、私钥/证书等常见敏感文件（`files` 明确包含时除外）。Unix 可执行位会被保留，解包不会恢复额外写权限。在 Settings → Extensions 中安装扩展目录或 `.aguix`。远程 `.aguix` 安装和更新必须由调用方或 marketplace catalog 提供有效 SHA-256 完整性元数据；缺少完整性元数据的市场条目会被忽略。同一 `publisher.name` 的新版本原子替换旧版本，重新安装后默认禁用并要求重新确认权限。

完整示例和端到端夹具位于 `scripts/fixtures/showcase-extension/`。

## 端到端测试

```bash
pnpm test:extensions
```

该命令会构建并启动真实 Electron 应用，使用临时用户目录验证：manifest/engine/命名空间/path 校验、ZIP Slip 和 CRC、权限拒绝、启停、配置/加密 Secret/状态持久化、原子升级、Extension Host 异常隔离、workspace 信任与 limited 模式、Sidebar/右侧栏/Composer/Header surface、Web Component、sandbox Webview/CSP/命令桥、聊天渲染器、主题 token、MCP/Skill/Prompt 控制、真实 ASP run 注入，以及最终卸载和贡献清理。

## 继续阅读

- [Provider](/zh-cn/guides/providers/)
- [产品定制](/zh-cn/guides/customization/)
