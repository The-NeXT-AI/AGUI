---
title: Advanced Extensions
description: Surfaces, chat renderers, themes, MCP resources, secrets, workspace trust, and packaging for AGUI extensions.
---

This page extends the [Extensions](/guides/extensions/) guide with the extension-contributed agent-run UI surfaces, chat renderers, themes and styles, MCP/Skills/Prompts injection, configuration and secrets, the trust model, and packaging.

## Views in depth

`project.json` entries are declarative UI documents:

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

The declarative vocabulary covers `text`, `container`/`box`, `row`/`column`/`stack`, `badge`, `button`, `link`, `image`, `code`, `kv`, `list`, and `data`. Buttons can only invoke commands inside the extension's own namespace; remote URLs in links and images require the `network` permission.

Views can also declare VS Code-style `menus["view/title"]` entries with `when: "view == <viewId>"` conditions, `alt` commands, and submenu groups, and `views[].contextualTitle` becomes the host view's tooltip. `viewsContainers.panel` maps a container onto the right detail panel, where `allowMultiple` opens multiple instances and `retainContextWhenHidden` keeps hidden tabs mounted.

### Web components and webviews

Web components are self-contained HTML mounted into a ShadowRoot with their scripts executed inside a sandboxed iframe — extension scripts never touch the main renderer or the Electron preload bridge. Component scripts can use the injected locals `agui`, `root`, and `host`: `agui.data` reads the current surface data and `agui.command(id, args)` invokes commands in the extension's namespace. Without the `network` permission the host blocks remote resource references in the HTML/CSS and enforces it via CSP. Webviews are fully isolated custom HTML with no Node, same-origin, or network access; they read initial data through `window.agui.data` and invoke commands through `window.agui.command`.

## Contribute agent UI surfaces

Beyond VS Code-style views, AGUI exposes composer, header, and floating-widget surfaces:

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

These surfaces use the same three render modes, registry, and cleanup lifecycle as views. Floating widgets render in a viewport corner — `position` accepts `top-left`, `top-right`, `bottom-left`, and `bottom-right` (default `bottom-right`). The host clamps widget width to 120–560px and height to 48–640px without exceeding the viewport, and stacks multiple widgets per corner by `order`. The contribution requests the `ui.floatingWidget` permission.

## Contribute chat renderers

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

Renderers match on `kind`, `metadata.renderer`, or `mimeType`. Declarative renderers receive the message block as data via `{{metadata.title}}`-style bindings or `data` nodes; web components read the block through `agui.data`. Regular extensions cannot override core message types or built-in renderer selectors — doing so requires the user to grant `ui.overrideBuiltins`.

## Contribute themes

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

Theme files are pure JSON with `colors`, `terminal`, and `monaco` sections. Semantic color keys include `canvas`, `surface`, `surfaceHover`, `foreground`, `mutedForeground`, `border`, `accent`, `accentForeground`, `success`, `warning`, `danger`, `info`, `selection`, and `codeBackground`. Themes update the app, Monaco, Xterm, and Mermaid together.

## Contribute controlled styles

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

`styles` requests the `ui.styles` permission — this is high-privilege global CSS that can hide or reposition the app UI, and the grant screen says so explicitly. The host reads the CSS file, inserts a `<style>` node tagged with the extension owner, and removes it precisely when the extension is disabled, uninstalled, or its contributions change. CSS files cannot use `@import`, `javascript:`, or `expression()`; `url()` allows only `data:` unless `network` is also granted. Prefer `themes` for color changes — theme tokens pass a stricter allowlist.

## Inject MCP, Skills, and Prompts

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

`mcp.json` accepts `{ "mcpServers": { ... } }` where a server uses `command`/`args`/`env`, `url`, `type`/`transport`, and `headers`/`http_headers`. Relative commands must stay inside the extension directory. Command-line MCP requests `process.spawn`, remote MCP requests `network`, and sensitive env/headers or `${secret:NAME}` placeholders request `secrets`. MCP IDs are namespaced by the extension to avoid collisions; `${secret:NAME}` resolves from the extension secret store, and an unresolvable placeholder rejects that MCP rather than passing the placeholder to the agent.

Extension-contributed MCP servers are run-scoped agent resources: when a run carries them, the runtime temporarily starts the gateway bridge, registers the servers into that session's scope, and cleans up afterwards. The global MCP Gateway switch in Settings only controls the persistent servers the user manages there — extension UI, configuration pages, session trees, and commands should never depend on that switch.

Design MCP as an optional capability: core browsing, configuration, login, and tree loading should work through extension commands and declarative data, so the extension stays functional when the user denies MCP permissions, has no secrets configured, or a server fails to start.

`skills` points at a directory containing a single `SKILL.md`, or a root directory of skill subdirectories. Prompts can inline `content` or reference a packaged `path`. `autoInclude: true` prompts are injected as developer instructions by default and the user can turn them off in Agent Tools; without `autoInclude` the prompt is listed as an available resource until the user selects it. Users can toggle MCP servers, skills, and prompts independently in Agent Tools. The Codex, Claude, and generic ASP adapters preserve resource and provenance information.

## Configuration, secrets, and extension state

Configuration is declared in the manifest; the host validates, persists, and renders it:

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

Secrets never come back through configuration read APIs and are never written in plaintext to state files. Electron uses the OS secure store; server mode prefers `AG_UI_EXTENSION_SECRET_KEY` and otherwise generates a random `extension-secret.key` with `0600` permissions in the AGUI home directory. Declaring a secret implies the `secrets` permission, and only an authorized extension host can read it through `context.secrets.get`. Extensions also get isolated, quota-limited, JSON-only global and workspace state:

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

Limits: 64 KB per state value, 512 KB per extension across all state, 256 KB per configuration, 8 KB per secret. Updating an executable extension's configuration destroys its process and reactivates on demand so stale configuration never lingers.

## Workspace trust and the permission model

The settings page installs user extensions scoped to the current workspace: the default workspace (or no workspace) uses the compatibility directory `$AG_UI_HOME/extensions`, other workspaces use `$AG_UI_HOME/workspaces/<workspace-id-sha256>/extensions`, and `$AG_UI_HOME` defaults to `~/.agui`. Each non-default workspace can install different extensions — or different versions of the same extension ID — with independent enablement, grants, configuration, secrets, and state; within one workspace an extension ID is single-version and replaced atomically. Project extensions are discovered from `<workspace>/.agui/extensions`. Untrusted projects load no MCP/Skills and never execute extension main-process code. Declaring `untrustedWorkspaces.supported: "limited"` permits only static contributions such as declarative UI and sandbox webviews — it does not make executable code trusted.

Extension main-process code is trusted code, as in VS Code desktop: the permission confirmation is an explicit trust boundary, not an OS sandbox. All backend capabilities flow through the Extension Host/Broker behind permission-checked APIs, and both `web-component` and `webview` UI run in sandbox iframes. Hosts expose granted permissions through `context.permissions` and the workspace through `context.workspace` as `{ root, canRead, canWrite }` (with `root` present only when `workspace.read`/`workspace.write` was granted). A `runtime.fullTrust` process on Electron still has the real file access of the OS account — treat these fields as the portable API contract, not a desktop sandbox.

In server mode, the host only runs extensions whose `extensionKind` is unset or includes `"workspace"`; extensions declared `extensionKind: ["ui"]` provide static/UI contributions only. The server Extension Host does not inherit the full `process.env` — only a minimal allowlist plus `AGUI_EXTENSION_*` context variables. On runtimes with the Node Permission Model it starts with `--experimental-permission`: extension package and host code are always readable; workspace read/write requires the corresponding permission; child processes require `process.spawn`. `AG_UI_EXTENSION_HOST_NODE_PERMISSIONS=0` disables that restriction, `AG_UI_EXTENSION_HOST_ENV_ALLOWLIST` overrides the environment allowlist, and `AG_UI_EXTENSION_HOST_MAX_OLD_SPACE_MB` adjusts the per-host heap cap. The Node Permission Model is in-process protection — it does not replace containers, unprivileged users, or network egress policy.

## Package, install, and upgrade

From the repository root:

```bash
pnpm extension:pack -- ./path/to/extension ./my-extension.aguix
```

The generated `.aguix` is a ZIP with path, file-count, and size protections. The packager honors the `files` allowlist in `package.json` and a root `.aguixignore`, and skips common sensitive files (`.env`, `.npmrc`, private keys, certificates) unless `files` includes them explicitly. Unix executable bits are preserved and no extra write permissions are restored on unpack. Install extension directories or `.aguix` files from Settings → Extensions. Remote `.aguix` installs and updates must provide valid SHA-256 integrity metadata through the caller or marketplace catalog; marketplace entries without integrity metadata are ignored. A new version of the same `publisher.name` replaces the old one atomically, starts disabled, and re-requests permission confirmation.

A complete example and end-to-end fixture live in `scripts/fixtures/showcase-extension/`.

## Test end to end

```bash
pnpm test:extensions
```

The suite builds and launches the real Electron app against a temporary user directory and verifies manifest/engine/namespace/path validation, ZIP Slip and CRC checks, permission denials, enable/disable, configuration/encrypted-secret/state persistence, atomic upgrades, extension host crash isolation, workspace trust and limited mode, sidebar/detail-panel/composer/header surfaces, web components, sandbox webviews with CSP and the command bridge, chat renderers, theme tokens, MCP/Skill/Prompt controls, real ASP run injection, and final uninstall with contribution cleanup.

## Continue

- [Providers](/guides/providers/)
- [Customization](/guides/customization/)
