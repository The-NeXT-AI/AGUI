---
title: 产品定制
description: 通过集中产品配置和 UI region 定制 AGUI 品牌构建。
---

产品默认值位于 `packages/app/src/product/product-config.ts`。品牌相关的修改应在这里或下文列出的 override 机制中进行——不要直接 patch shell、store 或 i18n 代码。

## 构建期覆盖

使用 Vite 环境变量驱动品牌化构建：

| 变量                                         | 默认值         |
| -------------------------------------------- | -------------- |
| `VITE_AGUI_PRODUCT_NAME`                     | `AGUI`         |
| `VITE_AGUI_PRODUCT_DISPLAY_NAME`             | `AGUI Desktop` |
| `VITE_AGUI_STORAGE_KEY_PREFIX`               | `agui`         |
| `VITE_AGUI_DEFAULT_THEME`                    | `dark`         |
| `VITE_AGUI_DEFAULT_APPROVAL_MODE`            | `auto-edit`    |
| `VITE_AGUI_DEFAULT_MODEL`                    | `gpt-5-codex`  |
| `VITE_AGUI_DEFAULT_EFFORT`                   | `medium`       |
| `VITE_AGUI_DEFAULT_SPEED`                    | `default`      |
| `VITE_AGUI_DEFAULT_LANGUAGE`                 | `en`           |
| `VITE_AGUI_SIDEBAR_DEFAULT_OPEN`             | `true`         |
| `VITE_AGUI_SIDEBAR_WIDTH`                    | `280`          |
| `VITE_AGUI_SIDEBAR_MIN_WIDTH`                | `240`          |
| `VITE_AGUI_SIDEBAR_MAX_WIDTH`                | `480`          |
| `VITE_AGUI_DETAIL_PANEL_DEFAULT_OPEN`        | `false`        |
| `VITE_AGUI_DETAIL_PANEL_WIDTH`               | `420`          |
| `VITE_AGUI_DETAIL_PANEL_MIN_WIDTH`           | `320`          |
| `VITE_AGUI_DETAIL_PANEL_MAX_WIDTH`           | `720`          |
| `VITE_AGUI_MINIMUM_MAIN_WIDTH`               | `520`          |
| `VITE_AGUI_FEATURE_EXTENSIONS_PAGE`          | `true`         |
| `VITE_AGUI_FEATURE_SCHEDULED_TASKS`          | `true`         |
| `VITE_AGUI_FEATURE_SETTINGS_PAGE`            | `true`         |
| `VITE_AGUI_FEATURE_THEME_TOGGLE`             | `true`         |
| `VITE_AGUI_FEATURE_SIDEBAR_ADD_CONVERSATION` | `true`         |
| `VITE_AGUI_INITIAL_SIDEBAR_PANEL`            | `sessions`     |
| `VITE_AGUI_EXTENSION_DEFAULT_PANEL_ICON`     | `blocks`       |
| `VITE_AGUI_ROOT_CLASS_NAME`                  | 空             |
| `VITE_AGUI_BODY_CLASS_NAME`                  | 空             |
| `VITE_AGUI_CSS_VARIABLES_JSON`               | `{}`           |
| `VITE_AGUI_CUSTOM_CSS`                       | 空             |
| `VITE_AGUI_TEXT_OVERRIDES_JSON`              | `{}`           |
| `VITE_AGUI_TRANSLATIONS_JSON`                | `{}`           |
| `VITE_AGUI_UI_REGIONS_JSON`                  | `{}`           |

`*_JSON` 变量分别承载 CSS 变量、文案覆盖、翻译和 UI region 配置的 JSON，与下文的运行时覆盖结构一致。

## 运行时覆盖

可以在 app bundle 加载前注入 HTML 的宿主，设置 `window.__AGUI_PRODUCT_CONFIG__`：

```html
<script>
  window.__AGUI_PRODUCT_CONFIG__ = {
    app: {
      name: "Acme Agent",
      displayName: "Acme Agent Desktop",
      storageKeyPrefix: "acme-agent",
    },
    features: {
      scheduledTasks: false,
    },
    ui: {
      cssVariables: {
        "thread-max-width": "960px",
        "chat-font-size": "14px",
      },
      text: {
        "composer.placeholder": "Ask Acme Agent...",
      },
      regions: {
        "sidebar.action.schedule": { hidden: true },
        "header.sessionTitle": {
          after: {
            type: "Badge",
            tone: "accent",
            text: "Internal",
          },
        },
        "chat.emptyLanding": {
          replace: {
            type: "Stack",
            gap: 8,
            className: "flex h-full items-center justify-center text-center",
            children: [
              { type: "Heading", text: "Start an Acme workflow" },
              { type: "Text", text: "Choose a project and describe the task." },
            ],
          },
        },
      },
    },
    layout: {
      sidebar: { defaultWidth: 320 },
    },
  };
</script>
```

运行时覆盖会叠加在环境默认值之上。应用加载后，宿主还可以通过 `window.__AGUI_UPDATE_PRODUCT_CONFIG__` 以相同结构做增量更新。

## UI Region

每个 region 支持：

```ts
{
  hidden?: boolean;
  className?: string;
  before?: ProductUIRenderable;
  after?: ProductUIRenderable;
  replace?: ProductUIRenderable;
  data?: Record<string, unknown>;
  allowNetwork?: boolean;
}
```

Region 分组如下：

- App：`app.keybindings`、`app.shell`、`app.floatingWidgets`、`app.commandPalette`、`app.searchChatsDialog`、`app.toaster`、`app.confirmDialog`
- Shell：`shell.compactHeader`、`shell.chromeControls`、`shell.sidebar`、`shell.sidebarSash`、`shell.main`、`shell.conversation`、`shell.header`、`shell.chat`、`shell.composer`、`shell.detailPanelSash`、`shell.detailPanel`
- 页面：`page.settings`、`page.extensions`、`page.schedule`
- Sidebar：`sidebar.titlebar`、`sidebar.projectSwitcher`、`sidebar.primaryActions`、`sidebar.action.newSession`、`sidebar.action.extensions`、`sidebar.action.schedule`、`sidebar.registeredPanels`、`sidebar.conversationList`、`sidebar.account`、`sidebar.footer`、`sidebar.footer.settings`、`sidebar.footer.workspaceIndicator`、`sidebar.footer.addWorkspace`
- Header：`header.leftControls`、`header.sessionTitle`、`header.rightControls`、`header.sessionMenu` 及 `header.sessionMenu.pin`、`.rename`、`.archive`、`.openSideChat`、`.copy`、`.branch`、`.schedule`、`.openCompactWindow`、`.openWindow`
- Composer：`composer.slashMenu`、`composer.mentionMenu`、`composer.interactions`、`composer.readiness`、`composer.card`、`composer.attachments`、`composer.queue`、`composer.textarea`、`composer.toolbar`、`composer.attachButton`、`composer.leftControls`、`composer.rightControls`、`composer.contextIndicator`、`composer.voiceButton`、`composer.voiceRecorder`、`composer.stopButton`、`composer.sendButton`
- Chat：`chat.findBar`、`chat.scrollRoot`、`chat.thread`、`chat.loading`、`chat.emptyLanding`、`chat.thinking`、`chat.userNavRail`、`chat.selectionMenu`、`chat.agentProcess`、`chat.extensionContext`、`chat.blocks`、`chat.block`，以及每种块类型对应的 `chat.block.<kind>`——`user`、`reasoning`、`assistant`、`plan`、`tool`、`terminal`、`diff`、`image`、`resource`、`artifact`、`raw`、`error`
- Detail panel：`detailPanel.noRegisteredTools`、`detailPanel.tabs`、`detailPanel.tab`、`detailPanel.addMenu`、`detailPanel.empty`、`detailPanel.content`
- Settings：`settings.nav`、`settings.nav.<sectionId>`、`settings.section.general`、`settings.section.remoteAccess`、`settings.section.agents`、`settings.section.mcpGateway`、`settings.section.about`

## 片段渲染模式

`ProductUIRenderable` 可以是 declarative fragment 或可信 Web Component fragment：

```ts
{
  renderMode: "declarative";
  schema: ExtensionDeclarativeNode;
  allowNetwork?: boolean;
}

{
  renderMode: "web-component";
  html: string;
  allowNetwork?: boolean;
}
```

小标签、badge、块替换、toolbar 片段和列表优先使用 `declarative`：宿主用 React 渲染 schema，没有自定义 DOM 脚本。Web Component 的 CSS 限定在 ShadowRoot 内，但脚本运行在宿主页面上——只加载可信 HTML。不可信的自定义 HTML 应使用 extension `webview`。

## 替换消息块

产品配置可以用 `chat.block` 替换全部块，或用 `chat.block.<kind>` 替换某一类。例如替换工具调用块：

```js
window.__AGUI_PRODUCT_CONFIG__ = {
  ui: {
    regions: {
      "chat.block.tool": {
        replace: {
          renderMode: "declarative",
          schema: {
            type: "box",
            gap: "xs",
            children: [
              { type: "text", text: "{{block.title}}", weight: "semibold" },
              { type: "badge", label: "{{block.status}}", tone: "accent" },
              { type: "code", path: "block.output" },
            ],
          },
        },
      },
    },
  },
};
```

插件侧的聊天渲染器应改用 `chatRenderers` contribution——扩展替换 `user`、`assistant`、`tool` 等内置类型时需要 `ui.overrideBuiltins` 权限。

## 继续阅读

- [扩展开发](/zh-cn/guides/extensions/)
- [配置参考](/zh-cn/reference/configuration/)
