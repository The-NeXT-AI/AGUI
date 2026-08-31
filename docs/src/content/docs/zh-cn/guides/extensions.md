---
title: 扩展开发
description: 使用 manifest、activation event、view、command 和 Agent resource 构建 AGUI 扩展。
---

AGUI 扩展采用类似 VS Code 的模型：manifest 声明 contribution point 和 activation event，扩展代码在隔离 host 中运行。

## 创建扩展清单

每个扩展目录都需要 `package.json`：

```json
{
  "name": "my-extension",
  "publisher": "acme",
  "version": "1.0.0",
  "displayName": "My Extension",
  "engines": { "agui": "^0.2.0" },
  "main": "./extension.mjs",
  "activationEvents": ["onCommand:acme.my-extension.hello"],
  "permissions": ["commands"],
  "contributes": {
    "commands": [{ "id": "acme.my-extension.hello", "title": "Hello" }]
  }
}
```

在入口模块中实现 `activate`：

```js
export function activate(context) {
  context.commands.registerCommand("acme.my-extension.hello", (name = "world") => {
    context.log.info("hello", name);
    return { message: `Hello ${name}` };
  });
}
```

所有 contribution ID 必须以 `publisher.name.` 或 `publisher.name/` 开头。`engines.agui` 字段是必填的——当前 engine 为 `0.2.0`，目标 engine 不兼容的 manifest 会在安装时校验失败。

## 选择 activation event

只在需要时激活：

- `onStartupFinished`
- `onAgentRun`
- `onCommand:<id>`
- `onView:<id>`
- `onConfiguration:<id>`
- `onComposer:<id>`
- `onHeader:<id>`
- `onFloatingWidget:<id>`
- `onChatRenderer:<id>`
- `*`

`activationEvents` 为空或缺失意味着扩展会在任何事件上激活——请显式声明。Sidebar surface 贡献通过 `onView:<id>` 激活（不存在 `onSidebar:<id>`）。

## 贡献 views

扩展可以贡献 VS Code 风格的 container、view、menu 和 command。View container 会映射到左侧 sidebar 或右侧 detail panel：

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "acme.my-extension.workspace",
          "title": "Acme",
          "icon": "./media/acme.svg",
          "order": 50
        }
      ]
    },
    "views": {
      "acme.my-extension.workspace": [
        {
          "id": "acme.my-extension.projectView",
          "name": "Project",
          "icon": "folder",
          "viewType": "declarative",
          "entry": "./project.json"
        }
      ]
    }
  }
}
```

## 渲染模式

| 模式            | 适用场景                                       | 权限                      |
| --------------- | ---------------------------------------------- | ------------------------- |
| `declarative`   | 列表、状态块、卡片、toolbar 项、表单、聊天块。 | `ui.render.declarative`   |
| `web-component` | 带有 scoped component 行为的可信自包含 HTML。  | `ui.webComponent.trusted` |
| `webview`       | 隔离的自定义 HTML，适合不可信或完全自定义 UI。 | `ui.webview`              |

优先使用 `declarative`。AGUI 用 React 渲染受控 JSON schema，不存在需要防范的直接 DOM 脚本访问。

## 声明权限

Contribution 会自动推导所需权限，用户授权后扩展才能启用。完整注册表：

| 权限                                                                                                    | 授予能力                                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `runtime.fullTrust`                                                                                     | 声明后端 `main` 的扩展 host。                   |
| `commands`                                                                                              | 注册和执行命令。                                |
| `theme`                                                                                                 | 贡献主题。                                      |
| `ui.render.declarative`                                                                                 | Declarative view 和 fragment。                  |
| `ui.webComponent.trusted`                                                                               | 可信 Web Component UI。                         |
| `ui.webview`                                                                                            | Sandbox webview UI。                            |
| `ui.styles`                                                                                             | 全局样式 contribution。                         |
| `ui.overrideBuiltins`                                                                                   | 覆盖内置聊天 renderer。                         |
| `ui.sessionTree`                                                                                        | Session tree contribution。                     |
| `ui.sidebar` / `ui.detailPanel` / `ui.composer` / `ui.header` / `ui.floatingWidget` / `ui.chatRenderer` | 对应的 UI surface。                             |
| `agent.skills` / `agent.mcp` / `agent.prompts`                                                          | 向 Agent run 注入 skill、MCP server 和 prompt。 |
| `agent.sessionContext`                                                                                  | 向 run 注入 session tree 上下文。               |
| `workspace.read` / `workspace.write`                                                                    | 读/写当前 workspace。                           |
| `network`                                                                                               | UI 和 MCP 中的远端 URL。                        |
| `process.spawn`                                                                                         | 命令行 MCP server。                             |
| `secrets`                                                                                               | 读取扩展 secret。                               |

未知权限会导致 manifest 校验失败。权限、workspace 信任和沙箱如何配合，见[扩展进阶](/zh-cn/guides/extensions-advanced/)。

## 扩展会话树

向左侧会话树添加虚拟文件夹和会话——例如 GitHub 扩展可以把 repository、issue 和 pull request 暴露为可导航节点。

叶子 session node 可提供：

- `title`
- `renderer`
- `initialMarkdown`
- `developerInstructions`
- `metadata`
- `providerId`
- `projectPath`
- `cwd`

`providerId`、`projectPath`、`cwd` 和动态 `command` root 需要 `agent.sessionContext` 权限；未授权时这些 Agent 上下文字段会被丢弃。即使已授权，`projectPath` 和 `cwd` 也只能指向当前 workspace——节点不能把 Agent 重定向到任意本地目录。当扩展声明了 `agent.sessionContext` 权限时，AGUI 会把该节点的 context 注入下一轮 Agent run。

## 本地化字符串

使用 `localizations` 按语言覆盖可见文案。中文宿主会依次尝试 `zh`、`zh-CN`、`zh-Hans`，英文依次尝试 `en`、`en-US`；其余 bundle key 按语言前缀匹配回退，最后使用 manifest 默认字段：

```json
{
  "displayName": "GitHub Assistant",
  "description": "Manage GitHub issues and pull requests.",
  "localizations": {
    "zh": {
      "displayName": "GitHub 助手",
      "description": "管理 GitHub issue 和 pull request。"
    }
  }
}
```

## 继续阅读

- [扩展进阶](/zh-cn/guides/extensions-advanced/)
- [产品定制](/zh-cn/guides/customization/)
- [多 Agent 会话](/zh-cn/guides/multi-agent/)
