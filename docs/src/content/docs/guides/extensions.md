---
title: Extensions
description: Build AGUI extensions with manifests, activation events, views, commands, and agent resources.
---

AGUI extensions work like VS Code extensions: a manifest declares contribution points and activation events, while extension code runs in an isolated host.

## Create the manifest

Every extension directory needs a `package.json`:

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

Implement `activate` in the entry module:

```js
export function activate(context) {
  context.commands.registerCommand("acme.my-extension.hello", (name = "world") => {
    context.log.info("hello", name);
    return { message: `Hello ${name}` };
  });
}
```

All contribution IDs must start with `publisher.name.` or `publisher.name/`. The `engines.agui` field is required — the current engine is `0.2.0`, and manifests targeting an unsupported engine fail validation at install time.

## Choose activation events

Activate only when needed:

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

An empty or missing `activationEvents` list means the extension activates on any event — declare events explicitly. Sidebar surface contributions activate through `onView:<id>` (there is no `onSidebar:<id>`).

## Contribute views

Extensions can add VS Code-style containers, views, menus, and commands. View containers map to the left sidebar or the right detail panel:

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

## Rendering modes

| Mode            | Use for                                                         | Permission                |
| --------------- | --------------------------------------------------------------- | ------------------------- |
| `declarative`   | Lists, status blocks, cards, toolbar items, forms, chat blocks. | `ui.render.declarative`   |
| `web-component` | Trusted self-contained HTML with scoped component behavior.     | `ui.webComponent.trusted` |
| `webview`       | Isolated custom HTML for untrusted or fully custom UI.          | `ui.webview`              |

Prefer `declarative`. AGUI renders its controlled JSON schema with React, so there is no direct DOM script access to defend against.

## Declare permissions

Contributions derive the permissions they need automatically, and an extension only enables after the user grants them. The full registry:

| Permission                                                                                              | Grants                                                   |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `runtime.fullTrust`                                                                                     | Extension host with backend `main` code.                 |
| `commands`                                                                                              | Register and run commands.                               |
| `theme`                                                                                                 | Contribute themes.                                       |
| `ui.render.declarative`                                                                                 | Declarative views and fragments.                         |
| `ui.webComponent.trusted`                                                                               | Trusted Web Component UI.                                |
| `ui.webview`                                                                                            | Sandbox webview UI.                                      |
| `ui.styles`                                                                                             | Global stylesheet contributions.                         |
| `ui.overrideBuiltins`                                                                                   | Override built-in chat renderers.                        |
| `ui.sessionTree`                                                                                        | Session tree contributions.                              |
| `ui.sidebar` / `ui.detailPanel` / `ui.composer` / `ui.header` / `ui.floatingWidget` / `ui.chatRenderer` | Corresponding UI surfaces.                               |
| `agent.skills` / `agent.mcp` / `agent.prompts`                                                          | Inject skills, MCP servers, and prompts into agent runs. |
| `agent.sessionContext`                                                                                  | Inject session tree context into runs.                   |
| `workspace.read` / `workspace.write`                                                                    | Read/write the current workspace.                        |
| `network`                                                                                               | Remote URLs from UI and MCP.                             |
| `process.spawn`                                                                                         | Command-line MCP servers.                                |
| `secrets`                                                                                               | Read extension secrets.                                  |

Unknown permissions fail manifest validation. See [Advanced Extensions](/guides/extensions-advanced/) for how permissions, workspace trust, and sandboxing interact.

## Extend the session tree

Add virtual folders and sessions to the left session tree — a GitHub extension can expose repositories, issues, and pull requests as navigable nodes.

Leaf session nodes provide:

- `title`
- `renderer`
- `initialMarkdown`
- `developerInstructions`
- `metadata`
- `providerId`
- `projectPath`
- `cwd`

`providerId`, `projectPath`, `cwd`, and dynamic `command` roots require `agent.sessionContext`; without it those agent-context fields are dropped. Even when granted, `projectPath` and `cwd` may only point at the current workspace — a node cannot redirect the agent to an arbitrary local directory. When the extension declares `agent.sessionContext`, AGUI injects that node's context into the next agent run.

## Localize strings

Override visible strings per language with `localizations`. For Chinese the host tries `zh`, `zh-CN`, then `zh-Hans`; for English `en`, then `en-US`; remaining bundle keys fall back by language-prefix match before using manifest defaults:

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

## Continue

- [Advanced Extensions](/guides/extensions-advanced/)
- [Customization](/guides/customization/)
- [Multi-agent Sessions](/guides/multi-agent/)
