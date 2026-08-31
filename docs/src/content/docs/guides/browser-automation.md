---
title: Browser automation and MCP Gateway
description: Drive the embedded browser from agents, proxy MCP through one gateway, and schedule recurring runs.
---

AGUI ships a set of runtime services that sit beside the chat: an MCP Gateway that proxies tool access, an embedded browser that agents can inspect and drive, remote screencasting for web clients, scheduled task runs, and private scratch sessions. This guide covers what each one does, how to configure it, and what degrades in pure web mode.

## MCP Gateway

Register MCP servers once, then AGUI injects one exclusive gateway MCP server into every new agent run. Agents never see the underlying catalogs — they only get four meta-tools exposed by the `agui-mcp-gateway` server:

| Meta tool                      | Purpose                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `code_tool.resolve`            | Search connected MCP services for the minimal tool bundle needed by a task.                      |
| `code_tool.invoke`             | Invoke one MCP tool that was already returned by `code_tool.resolve` in this session.            |
| `code_tool.workflow`           | Execute a multi-step workflow against resolved MCP tools using a plan DSL or TypeScript code.    |
| `code_tool.request_user_input` | Open the native input card to collect structured user input, a confirmation, or an MCP App view. |

A `matched: false` result from `code_tool.resolve` means the agent should continue without the gateway.

### How injection works

Per run, the runtime starts a session-scoped JSON-RPC server on a local Unix socket (named pipe on Windows) and hands the agent a `stdio` MCP server reference whose command is a small bridge script. The bridge connects back to the runtime using `AGUI_MCP_GATEWAY_SOCKET`, `AGUI_MCP_GATEWAY_TOKEN`, and `AGUI_MCP_GATEWAY_SESSION_ID` environment variables; the token is random per run and compared timing-safe. Developer instructions appended to each run tell the agent to call `code_tool.resolve` before reaching for tools directly.

Provider adapters integrate the gateway with their native tool semantics:

- **Codex**: gateway tools are force-enabled and auto-approved, and underscore aliases (`code_tool_resolve` and friends) are registered because Codex restricts tool-name character sets.
- **Claude Code**: the gateway server is written to a temporary `mcp.json` passed via `--mcp-config`, with `--permission-mode` and `--permission-prompt-tool stdio` honoring your approval settings.

Three built-in tool providers register into the gateway without any external server: `agui_panel` (terminal, IDE, and panel tools), `agui_browser` (browser automation), and `agui_browser_workflows` (saved browser workflows). The browser provider only registers when a browser panel tab is open and the runtime reports `features.browserAutomation`.

### Configure the gateway

Open **Settings → MCP Gateway** (`settings.section.mcpGateway`). The section offers:

- An enable/disable switch. Enabling requires a **Resolve model** — the LLM used by `code_tool.resolve` before tree-sitter extracts tool references as a fallback. Set the model, base URL, and API key in the Resolve model dialog (an `OPENAI_API_KEY` fallback applies).
- **Add MCP server** with transports `http`, `sse`, or `stdio`, optional headers, environment, and Bearer / API key / Basic authentication.
- **JSON import** that accepts an `mcpServers` JSON block (including `streamablehttp` transport aliases) or a single server object.
- **Refresh MCP Gateway** to re-discover tools, plus a per-server list showing endpoint, tool count, and discovery status.

Settings persist in `mcp-gateway.json` under the AGUI user data directory:

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

Under WebAuth or OAuth multi-tenant mode, each tenant reads and writes its own file inside `tenants/<tenant-key>/` of the user data directory. See [Configuration](/reference/configuration/) for the shared environment variables. Extensions can also contribute MCP servers to the gateway — see [Advanced extensions](/guides/extensions-advanced/).

## Browser automation tools

When the browser provider is registered, agents get these tools through the gateway:

| Group               | Tools                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs and navigation | `browser_list_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_navigate`, `browser_reload`, `browser_stop`, `browser_go_back`, `browser_go_forward` |
| Interaction         | `browser_click` (CSS selector or viewport coordinates), `browser_type`, `browser_execute_script`                                                            |
| Reading             | `browser_snapshot` (visible text, optionally HTML), `browser_screenshot` (PNG/JPEG), `browser_inspect_element`                                              |
| DevTools Protocol   | `browser_cdp_command`, `browser_cdp_start_capture`, `browser_cdp_events`, `browser_cdp_stop_capture`                                                        |
| Annotations         | `browser_set_annotation_mode`, `browser_list_annotations`, `browser_add_annotation`, `browser_delete_annotation`, `browser_clear_annotations`               |

The CDP surface is sanitized: methods must match `Domain.method`, params are size-capped, and event capture is restricted to the CSS, DOM, Log, Network, Page, Performance, Runtime, and Tracing domains. Navigation accepts only `http:`, `https:`, and `about:blank`. The same panel tool provider also exposes `panel_*`, `terminal_*`, and `ide_*` tools for driving AGUI's own panels and workspaces.

## Browser annotations

Annotation mode turns the browser into a way to point at problems. Toggle **Add annotation** in the Browser panel toolbar, then click or drag on the page: AGUI creates an **element** annotation (via CSS selector) or a **region** annotation (via a viewport rectangle), together with your note and captured context — selector, tag name, text, viewport rect, URL, and computed styles.

Annotations attach to the composer as context for the next prompt, and agents can read and extend them with `browser_list_annotations` and `browser_add_annotation`.

### Generate workflows from annotations

`browser_workflow_generate_from_annotations` reads the current annotations and drafts a workflow. Notes containing `type` / `fill` / `input` become type steps; notes containing `verify` / `check` / `wait` / `assert` become wait or assert steps; other notes become clicks. Workflows support `click`, `type`, `navigate`, `submit`, `snapshot`, `waitFor`, and `assert` steps, save to `browser-workflows.json` in the user data directory, and — once saved — are additionally injected as their own fixed `browser_workflow_<id>` tools so an agent can replay them directly. List, fetch, save, delete, and run them through `browser_workflow_list`, `browser_workflow_get`, `browser_workflow_save`, `browser_workflow_delete`, and `browser_workflow_run`.

## Remote browser screencasting

AGUI Desktop renders the embedded browser in a native `WebContentsView`. Web clients connected over Remote Access instead receive the browser as a screencast: the desktop app streams base64 JPEG frames (roughly 10 per second, ack-based flow control, capped at 1600×1200 quality 72), and the remote surface forwards pointer, wheel, keyboard, and paste input back as CDP events. Each input triggers an immediate frame refresh, so the view stays responsive.

Screencasting and raw input are gated on Remote Access being enabled — the runtime method is rejected with "Browser remote control is only available while AGUI Remote Access is running" otherwise. Configure it with `AG_UI_RPC_TOKEN`, `AG_UI_WEB_HOST`, and `AG_UI_WEB_PORT` as described in [Configuration](/reference/configuration/). No browser panel tab on the desktop side is required for remote viewing; AGUI creates the tab and starts the screencast automatically on navigation.

### Pure web mode with a real Chrome

The Node server can spawn its own Chrome (or attach to an existing one) and screencast it over CDP, so browser automation works without Electron. It is enabled by pointing the backend variable at a usable Chrome executable:

| Variable (AGUI_ aliases also work) | Purpose                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AG_UI_BROWSER_BACKEND`            | Unset or a truthy value (`1`, `true`, `cdp`, `chrome`, …) enables; `0`, `false`, `none` disables. |
| `AG_UI_CHROME_EXECUTABLE_PATH`     | Path to Chrome/Chromium. `CHROME_PATH` is a fallback; without one, the backend is unavailable.    |
| `AG_UI_CHROME_CDP_ENDPOINT`        | Attach to an existing CDP endpoint instead of spawning Chrome.                                    |
| `AG_UI_CHROME_CDP_AUTHORIZATION`   | Authorization header for the CDP endpoint.                                                        |
| `AG_UI_CHROME_USER_DATA_DIR`       | Profile directory; defaults to a temporary `agui-chrome-*` directory.                             |
| `AG_UI_CHROME_LAUNCH_TIMEOUT_MS`   | Launch timeout, default 15000 ms.                                                                 |
| `AG_UI_CHROME_HEADLESS`            | Launches `--headless=new` unless set to a falsy value.                                            |
| `AG_UI_CHROME_NO_SANDBOX`          | Adds `--no-sandbox` (also enabled automatically when running as root).                            |
| `AG_UI_CHROME_ARGS`                | Extra launch args as a JSON array or whitespace-separated string.                                 |

### What each environment can do

| Environment                                          | Browser embedding        | Agent browser tools                         |
| ---------------------------------------------------- | ------------------------ | ------------------------------------------- |
| Desktop (Electron)                                   | Native `WebContentsView` | Full tool set                               |
| Pure web + Chrome backend + Remote Access            | Screencast frames        | Full tool set                               |
| Pure web without Chrome (for example `pnpm dev:web`) | Sandboxed iframe         | None (browser providers are not registered) |

See [Architecture](/getting-started/architecture/) for the general list of desktop-only features that degrade in pure web mode.

## Scheduled tasks

Scheduled tasks run a prompt automatically on a date or recurring cadence while AGUI is open. Each run spawns a real ASP session with the task's provider, model, effort, speed, and approval mode (default `auto-edit`), appearing in the sidebar like any other conversation.

Create tasks from the sidebar **Schedule** button, the **New task** button on the Schedule page, or **Add scheduled task…** in a conversation's session menu, which prefills the form from the current session.

### Schedule types

There is no cron syntax — four cadences cover the options:

| Type       | Fields                       |
| ---------- | ---------------------------- |
| `once`     | `date`, `time`               |
| `daily`    | `time`                       |
| `weekly`   | `weekdays` (0–6), `time`     |
| `interval` | `intervalMinutes` (1–525600) |

The scheduler polls every 30 seconds in-process. Missed runs are caught up when AGUI reopens (marked with reason `catch_up` and a missed-run count), and failures retry after a default 5-minute backoff with one retry, capped at 5 attempts within 7 days. Each task keeps a run history of the last 20 entries with status `running`, `success`, `failed`, or `canceled`, and reason `scheduled`, `manual`, `retry`, or `catch_up`.

Tasks are stored in the runtime key-value store (SQLite by default, Postgres via `AG_UI_STORAGE_BACKEND`) and are per-tenant under WebAuth/OAuth mode. The UI flag `VITE_AGUI_FEATURE_SCHEDULED_TASKS` (default `true`) controls whether the surface appears. The JSON-RPC surface is `scheduledTasks.list`, `add`, `update`, `remove`, `setEnabled`, and `runNow`.

## Private sessions

A conversation without an attached project does not run in a shared directory. AGUI assigns it a dedicated scratch workspace at `private-sessions/<YYYY-MM-DD>/<sessionId>` under the user data directory (per-tenant under multi-tenant auth), and the sidebar groups these conversations under the "AGUI private sessions" sidebar group. Apps resolve these paths through the `workspace.privateRoot` and `workspace.privateSession` runtime methods, and scheduled tasks without a project path get a fresh private session directory for each run.

## Continue

- [Advanced extensions](/guides/extensions-advanced/) — extension-contributed MCP servers, gateway injection, and workspace trust.
- [Configuration reference](/reference/configuration/) — Remote Access, storage backend, and tenant variables.
- [Providers](/guides/providers/) — how agent runs and approval modes interact with gateway auto-approval.
