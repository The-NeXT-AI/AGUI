---
title: Customization
description: Brand AGUI builds with centralized product configuration and UI regions.
---

Product defaults live in `packages/app/src/product/product-config.ts`. Make branding changes there or through the override mechanisms below — never by patching shell, store, or i18n code directly.

## Build-time overrides

Drive branded builds with Vite environment variables:

| Variable                                     | Default        |
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
| `VITE_AGUI_ROOT_CLASS_NAME`                  | empty          |
| `VITE_AGUI_BODY_CLASS_NAME`                  | empty          |
| `VITE_AGUI_CSS_VARIABLES_JSON`               | `{}`           |
| `VITE_AGUI_CUSTOM_CSS`                       | empty          |
| `VITE_AGUI_TEXT_OVERRIDES_JSON`              | `{}`           |
| `VITE_AGUI_TRANSLATIONS_JSON`                | `{}`           |
| `VITE_AGUI_UI_REGIONS_JSON`                  | `{}`           |

The `*_JSON` variables carry JSON for CSS variables, text overrides, translations, and UI region config respectively, mirroring the runtime override shape below.

## Runtime overrides

Hosts that can inject HTML before the app bundle loads set `window.__AGUI_PRODUCT_CONFIG__`:

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

Runtime overrides merge on top of environment defaults. Hosts can also apply later updates through `window.__AGUI_UPDATE_PRODUCT_CONFIG__`, which merges the same override shape imperatively after the app has loaded.

## UI regions

Every region accepts:

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

Region ids by group:

- App: `app.keybindings`, `app.shell`, `app.floatingWidgets`, `app.commandPalette`, `app.searchChatsDialog`, `app.toaster`, `app.confirmDialog`
- Shell: `shell.compactHeader`, `shell.chromeControls`, `shell.sidebar`, `shell.sidebarSash`, `shell.main`, `shell.conversation`, `shell.header`, `shell.chat`, `shell.composer`, `shell.detailPanelSash`, `shell.detailPanel`
- Pages: `page.settings`, `page.extensions`, `page.schedule`
- Sidebar: `sidebar.titlebar`, `sidebar.projectSwitcher`, `sidebar.primaryActions`, `sidebar.action.newSession`, `sidebar.action.extensions`, `sidebar.action.schedule`, `sidebar.registeredPanels`, `sidebar.conversationList`, `sidebar.account`, `sidebar.footer`, `sidebar.footer.settings`, `sidebar.footer.workspaceIndicator`, `sidebar.footer.addWorkspace`
- Header: `header.leftControls`, `header.sessionTitle`, `header.rightControls`, `header.sessionMenu` plus `header.sessionMenu.pin`, `.rename`, `.archive`, `.openSideChat`, `.copy`, `.branch`, `.schedule`, `.openCompactWindow`, `.openWindow`
- Composer: `composer.slashMenu`, `composer.mentionMenu`, `composer.interactions`, `composer.readiness`, `composer.card`, `composer.attachments`, `composer.queue`, `composer.textarea`, `composer.toolbar`, `composer.attachButton`, `composer.leftControls`, `composer.rightControls`, `composer.contextIndicator`, `composer.voiceButton`, `composer.voiceRecorder`, `composer.stopButton`, `composer.sendButton`
- Chat: `chat.findBar`, `chat.scrollRoot`, `chat.thread`, `chat.loading`, `chat.emptyLanding`, `chat.thinking`, `chat.userNavRail`, `chat.selectionMenu`, `chat.agentProcess`, `chat.extensionContext`, `chat.blocks`, `chat.block`, and `chat.block.<kind>` for each block kind — `user`, `reasoning`, `assistant`, `plan`, `tool`, `terminal`, `diff`, `image`, `resource`, `artifact`, `raw`, `error`
- Detail panel: `detailPanel.noRegisteredTools`, `detailPanel.tabs`, `detailPanel.tab`, `detailPanel.addMenu`, `detailPanel.empty`, `detailPanel.content`
- Settings: `settings.nav`, `settings.nav.<sectionId>`, `settings.section.general`, `settings.section.remoteAccess`, `settings.section.agents`, `settings.section.mcpGateway`, `settings.section.about`

## Fragment render modes

`ProductUIRenderable` is either a declarative fragment or a trusted Web Component fragment:

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

Prefer `declarative` for small labels, badges, block replacements, toolbar fragments, and lists: the host renders the schema with React and no custom DOM script. Web Component HTML is scoped inside a ShadowRoot, but its scripts run in the host page — only load trusted HTML there. For untrusted custom HTML, use extension `webview`.

## Replace message blocks

Product configuration can replace all blocks with `chat.block`, or one kind with `chat.block.<kind>`. For example, replacing tool-call blocks:

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

For plugin-owned chat renderers, use a `chatRenderers` contribution instead — an extension replacing built-in kinds such as `user`, `assistant`, or `tool` needs the `ui.overrideBuiltins` permission.

## Continue

- [Extensions](/guides/extensions/)
- [Configuration Reference](/reference/configuration/)
