import { randomUUID } from "node:crypto";
import type { McpGatewayToolDefinition, McpGatewayToolProvider } from "./types.js";

export const browserMcpProviderId = "agui_browser";

export type BrowserMcpMethodInvoker = (
  method: string,
  params: Record<string, unknown> | string | undefined,
) => Promise<unknown> | unknown;

export type BrowserMcpToolProviderOptions = {
  invokeBrowserMethod: BrowserMcpMethodInvoker;
};

const defaultSnapshotTextLimit = 200_000;
const defaultSnapshotHtmlLimit = 0;
const maxSnapshotTextLimit = 1_000_000;
const maxSnapshotHtmlLimit = 1_000_000;

export function createBrowserMcpToolProvider(
  options: BrowserMcpToolProviderOptions,
): McpGatewayToolProvider {
  return {
    listTools: () => browserToolDefinitions(),
    callTool: (name, args) => callBrowserTool(options.invokeBrowserMethod, name, args),
  };
}

export function browserToolDefinitions(): McpGatewayToolDefinition[] {
  return [
    {
      name: "browser_list_tabs",
      title: "List Browser Tabs",
      description:
        "List AGUI in-app Browser automation tabs, including URL, title, loading state and navigation state.",
      inputSchema: objectSchema({}, []),
    },
    {
      name: "browser_open_tab",
      title: "Open Browser Tab",
      description:
        "Create a new AGUI in-app Browser automation tab and optionally navigate it to an HTTP or HTTPS URL. This creates and updates browser state.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description: "Optional stable tab id. A safe id is generated when omitted.",
          },
          title: { type: "string", description: "Optional title used before the page loads." },
          url: { type: "string", description: "Optional HTTP or HTTPS URL to open." },
          waitUntil: browserWaitUntilSchema(),
          timeoutMs: timeoutSchema(),
        },
        [],
      ),
    },
    {
      name: "browser_close_tab",
      title: "Close Browser Tab",
      description:
        "Remove an AGUI Browser automation tab. This closes browser state for the selected tab.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is closed.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_navigate",
      title: "Navigate Browser",
      description:
        "Navigate an AGUI Browser tab to an HTTP or HTTPS URL. This updates the current page.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          url: { type: "string", description: "HTTP or HTTPS URL to load." },
          waitUntil: browserWaitUntilSchema(),
          timeoutMs: timeoutSchema(),
        },
        ["url"],
      ),
    },
    {
      name: "browser_reload",
      title: "Reload Browser",
      description: "Reload an AGUI Browser tab. This updates the current page.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          waitUntil: browserWaitUntilSchema(),
          timeoutMs: timeoutSchema(),
        },
        [],
      ),
    },
    {
      name: "browser_stop",
      title: "Stop Browser Loading",
      description: "Stop the current AGUI Browser tab load. This updates browser loading state.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_go_back",
      title: "Browser Back",
      description:
        "Navigate the AGUI Browser tab backward in history. This updates the current page.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_go_forward",
      title: "Browser Forward",
      description:
        "Navigate the AGUI Browser tab forward in history. This updates the current page.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_click",
      title: "Click Browser Element",
      description:
        "Click a visible element in an AGUI Browser tab by CSS selector or viewport coordinates. This may submit forms or update page state.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          selector: { type: "string", description: "CSS selector for the element to click." },
          x: {
            type: "number",
            description: "Viewport x coordinate, used when selector is omitted.",
          },
          y: {
            type: "number",
            description: "Viewport y coordinate, used when selector is omitted.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_type",
      title: "Type In Browser",
      description:
        "Write text into the focused element or a selected element in an AGUI Browser tab. This updates page state.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          selector: {
            type: "string",
            description: "Optional CSS selector to focus before typing.",
          },
          text: { type: "string", description: "Text to insert." },
        },
        ["text"],
      ),
    },
    {
      name: "browser_snapshot",
      title: "Snapshot Browser Page",
      description:
        "Read the current AGUI Browser page URL, title and visible text. HTML is omitted by default to keep results compact.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          includeHtml: {
            type: "boolean",
            description: "Include document HTML in the response. Defaults to false.",
          },
          maxTextLength: {
            type: "number",
            description: "Maximum visible text characters. Defaults to 200000.",
          },
          maxHtmlLength: {
            type: "number",
            description: "Maximum HTML characters when includeHtml is true. Defaults to 0.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_screenshot",
      title: "Screenshot Browser Page",
      description:
        "Capture a PNG or JPEG screenshot of the current AGUI Browser tab for visual inspection.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            description: "Screenshot format. Defaults to png.",
          },
          quality: { type: "number", description: "JPEG quality from 1 to 100." },
        },
        [],
      ),
    },
    {
      name: "browser_set_annotation_mode",
      title: "Set Browser Annotation Mode",
      description:
        "Enable or disable the in-page Browser annotation layer so a user can click elements or drag regions and leave implementation feedback.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          enabled: { type: "boolean", description: "Whether annotation mode should be active." },
        },
        ["enabled"],
      ),
    },
    {
      name: "browser_list_annotations",
      title: "List Browser Annotations",
      description:
        "Read Browser annotations left on the page, including comments, selected selectors, regions, text, and computed style snapshots.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_clear_annotations",
      title: "Clear Browser Annotations",
      description: "Clear annotations from the selected AGUI Browser tab.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_add_annotation",
      title: "Add Browser Annotation",
      description:
        "Programmatically add a Browser annotation to an element selector or viewport region. This updates Browser annotation state.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          annotationId: { type: "string", description: "Optional stable annotation id." },
          height: { type: "number", description: "Viewport region height." },
          note: { type: "string", description: "Annotation note." },
          rect: { type: "object", description: "Viewport rect with x, y, width, and height." },
          selector: { type: "string", description: "CSS selector for element annotations." },
          type: { type: "string", enum: ["element", "region"] },
          width: { type: "number", description: "Viewport region width." },
          x: { type: "number", description: "Viewport x coordinate." },
          y: { type: "number", description: "Viewport y coordinate." },
        },
        ["note"],
      ),
    },
    {
      name: "browser_delete_annotation",
      title: "Delete Browser Annotation",
      description: "Delete one Browser annotation by id.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          annotationId: { type: "string", description: "Annotation id to delete." },
        },
        ["annotationId"],
      ),
    },
    {
      name: "browser_inspect_element",
      title: "Inspect Browser Element",
      description:
        "Inspect a Browser element by CSS selector or viewport coordinates, returning DOM attributes, text, rect, and key computed styles.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          selector: { type: "string", description: "CSS selector for the element to inspect." },
          x: {
            type: "number",
            description: "Viewport x coordinate, used when selector is omitted.",
          },
          y: {
            type: "number",
            description: "Viewport y coordinate, used when selector is omitted.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_cdp_command",
      title: "Send Browser CDP Command",
      description:
        "Send a Chrome DevTools Protocol command to the selected Browser tab, such as DOM.getDocument, CSS.getComputedStyleForNode, Performance.getMetrics, or Tracing.start.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          method: { type: "string", description: "CDP method in Domain.method form." },
          params: { type: "object", description: "Optional CDP command parameters." },
        },
        ["method"],
      ),
    },
    {
      name: "browser_cdp_start_capture",
      title: "Start Browser CDP Capture",
      description:
        "Start buffering CDP events for console, network, page, runtime, DOM/CSS, or performance inspection.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          domains: {
            type: "array",
            items: {
              type: "string",
              enum: ["CSS", "DOM", "Log", "Network", "Page", "Performance", "Runtime", "Tracing"],
            },
            description: "CDP domains to enable. Defaults to Runtime, Log, Network, and Page.",
          },
          methods: {
            type: "array",
            items: { type: "string" },
            description: "Optional event method allowlist, such as Network.responseReceived.",
          },
          maxEvents: { type: "number", description: "Maximum buffered events. Defaults to 2000." },
          clear: {
            type: "boolean",
            description: "Clear existing buffered events. Defaults to true.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_cdp_events",
      title: "Read Browser CDP Events",
      description:
        "Read buffered CDP events, optionally filtering by exact event methods or a method prefix such as Network. or Runtime.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          methods: {
            type: "array",
            items: { type: "string" },
            description: "Optional exact CDP event methods to return.",
          },
          methodPrefix: {
            type: "string",
            description: "Optional CDP event prefix, such as Network. or Runtime.",
          },
          limit: { type: "number", description: "Maximum events to return. Defaults to 500." },
          clear: { type: "boolean", description: "Clear the buffer after reading." },
        },
        [],
      ),
    },
    {
      name: "browser_cdp_stop_capture",
      title: "Stop Browser CDP Capture",
      description: "Stop buffering CDP events for the selected Browser tab.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
        },
        [],
      ),
    },
    {
      name: "browser_execute_script",
      title: "Execute Browser JavaScript",
      description:
        "Execute JavaScript in an AGUI Browser tab for inspection or automation. This can update page state, so use the smallest script needed.",
      inputSchema: objectSchema(
        {
          id: {
            type: "string",
            description:
              "Browser tab id. If omitted, the most recently active automation tab is used.",
          },
          expression: {
            type: "string",
            description: "JavaScript expression to evaluate in the page.",
          },
          awaitPromise: {
            type: "boolean",
            description: "Await a returned promise. Defaults to true.",
          },
        },
        ["expression"],
      ),
    },
  ];
}

async function callBrowserTool(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "browser_list_tabs":
      return ok("browser_list_tabs", {
        tabs: await invokeBrowserMethod("browser.list", undefined),
      });
    case "browser_open_tab":
      return openBrowserTab(invokeBrowserMethod, args);
    case "browser_close_tab":
      return closeBrowserTab(invokeBrowserMethod, args);
    case "browser_navigate":
      return ok("browser_navigate", {
        target: await invokeBrowserMethod("browser.navigate", {
          id: readOptionalString(args.id),
          timeoutMs: readOptionalNumber(args.timeoutMs),
          url: readRequiredString(args.url, "browser_navigate requires url."),
          waitUntil: readBrowserWaitUntil(args.waitUntil),
        }),
      });
    case "browser_reload":
      return ok("browser_reload", {
        target: await invokeBrowserMethod("browser.reload", {
          id: readOptionalString(args.id),
          timeoutMs: readOptionalNumber(args.timeoutMs),
          waitUntil: readBrowserWaitUntil(args.waitUntil),
        }),
      });
    case "browser_stop":
      return ok("browser_stop", {
        target: await invokeBrowserMethod("browser.stop", { id: readOptionalString(args.id) }),
      });
    case "browser_go_back":
      return ok("browser_go_back", {
        target: await invokeBrowserMethod("browser.goBack", { id: readOptionalString(args.id) }),
      });
    case "browser_go_forward":
      return ok("browser_go_forward", {
        target: await invokeBrowserMethod("browser.goForward", { id: readOptionalString(args.id) }),
      });
    case "browser_click":
      return ok("browser_click", {
        target: await invokeBrowserMethod("browser.click", {
          id: readOptionalString(args.id),
          selector: readOptionalString(args.selector),
          x: readOptionalNumber(args.x),
          y: readOptionalNumber(args.y),
        }),
      });
    case "browser_type":
      return ok("browser_type", {
        target: await invokeBrowserMethod("browser.type", {
          id: readOptionalString(args.id),
          selector: readOptionalString(args.selector),
          text: readRequiredString(args.text, "browser_type requires text."),
        }),
      });
    case "browser_snapshot":
      return browserSnapshot(invokeBrowserMethod, args);
    case "browser_screenshot":
      return ok("browser_screenshot", {
        screenshot: await invokeBrowserMethod("browser.screenshot", {
          id: readOptionalString(args.id),
          format: readScreenshotFormat(args.format),
          quality: readOptionalNumber(args.quality),
        }),
      });
    case "browser_set_annotation_mode":
      return ok("browser_set_annotation_mode", {
        state: await invokeBrowserMethod("browser.setAnnotationMode", {
          enabled: args.enabled === true,
          id: readOptionalString(args.id),
        }),
      });
    case "browser_list_annotations":
      return ok("browser_list_annotations", {
        annotations: await invokeBrowserMethod("browser.listAnnotations", {
          id: readOptionalString(args.id),
        }),
      });
    case "browser_clear_annotations":
      return ok("browser_clear_annotations", {
        result: await invokeBrowserMethod("browser.clearAnnotations", {
          id: readOptionalString(args.id),
        }),
      });
    case "browser_add_annotation":
      return ok("browser_add_annotation", {
        result: await invokeBrowserMethod("browser.addAnnotation", {
          annotationId: readOptionalString(args.annotationId),
          height: readOptionalNumber(args.height),
          id: readOptionalString(args.id),
          note: readRequiredString(args.note, "browser_add_annotation requires note."),
          rect: readOptionalRecord(args.rect),
          selector: readOptionalString(args.selector),
          type: readOptionalString(args.type),
          width: readOptionalNumber(args.width),
          x: readOptionalNumber(args.x),
          y: readOptionalNumber(args.y),
        }),
      });
    case "browser_delete_annotation":
      return ok("browser_delete_annotation", {
        result: await invokeBrowserMethod("browser.deleteAnnotation", {
          annotationId: readRequiredString(
            args.annotationId,
            "browser_delete_annotation requires annotationId.",
          ),
          id: readOptionalString(args.id),
        }),
      });
    case "browser_inspect_element":
      return ok("browser_inspect_element", {
        result: await invokeBrowserMethod("browser.inspectElement", {
          id: readOptionalString(args.id),
          selector: readOptionalString(args.selector),
          x: readOptionalNumber(args.x),
          y: readOptionalNumber(args.y),
        }),
      });
    case "browser_cdp_command":
      return ok("browser_cdp_command", {
        result: await invokeBrowserMethod("browser.cdpCommand", {
          id: readOptionalString(args.id),
          method: readRequiredString(args.method, "browser_cdp_command requires method."),
          params: readOptionalRecord(args.params),
        }),
      });
    case "browser_cdp_start_capture":
      return ok("browser_cdp_start_capture", {
        result: await invokeBrowserMethod("browser.cdpStartCapture", {
          clear: args.clear === undefined ? undefined : args.clear === true,
          domains: readOptionalStringArray(args.domains),
          id: readOptionalString(args.id),
          maxEvents: readOptionalNumber(args.maxEvents),
          methods: readOptionalStringArray(args.methods),
        }),
      });
    case "browser_cdp_events":
      return ok("browser_cdp_events", {
        result: await invokeBrowserMethod("browser.cdpEvents", {
          clear: args.clear === undefined ? undefined : args.clear === true,
          id: readOptionalString(args.id),
          limit: readOptionalNumber(args.limit),
          methodPrefix: readOptionalString(args.methodPrefix),
          methods: readOptionalStringArray(args.methods),
        }),
      });
    case "browser_cdp_stop_capture":
      return ok("browser_cdp_stop_capture", {
        result: await invokeBrowserMethod("browser.cdpStopCapture", {
          id: readOptionalString(args.id),
        }),
      });
    case "browser_execute_script":
      return ok("browser_execute_script", {
        result: await invokeBrowserMethod("browser.evaluate", {
          awaitPromise: args.awaitPromise !== false,
          expression: readRequiredString(
            args.expression,
            "browser_execute_script requires expression.",
          ),
          id: readOptionalString(args.id),
        }),
      });
    default:
      throw new Error(`Unknown AGUI Browser tool: ${name}`);
  }
}

async function openBrowserTab(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = readOptionalString(args.id) || `agent-browser-${randomUUID()}`;
  const title = readOptionalString(args.title) || "Agent Browser";
  const created = await invokeBrowserMethod("browser.create", { id, title });
  const url = readOptionalString(args.url);
  if (!url) return ok("browser_open_tab", { target: created });
  return ok("browser_open_tab", {
    target: await invokeBrowserMethod("browser.navigate", {
      id,
      timeoutMs: readOptionalNumber(args.timeoutMs),
      url,
      waitUntil: readBrowserWaitUntil(args.waitUntil),
    }),
  });
}

async function closeBrowserTab(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = readOptionalString(args.id) ?? (await latestBrowserTabId(invokeBrowserMethod));
  if (!id) throw new Error("browser_close_tab requires id when no Browser tabs are registered.");
  return ok("browser_close_tab", {
    closed: await invokeBrowserMethod("browser.unregister", id),
    id,
  });
}

async function browserSnapshot(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  args: Record<string, unknown>,
): Promise<unknown> {
  const snapshot = recordValue(
    await invokeBrowserMethod("browser.snapshot", {
      id: readOptionalString(args.id),
    }),
  );
  const maxTextLength = readLimitedNumber(
    args.maxTextLength,
    defaultSnapshotTextLimit,
    0,
    maxSnapshotTextLimit,
  );
  const includeHtml = args.includeHtml === true;
  const maxHtmlLength = includeHtml
    ? readLimitedNumber(args.maxHtmlLength, defaultSnapshotHtmlLimit, 0, maxSnapshotHtmlLimit)
    : 0;
  return ok("browser_snapshot", {
    snapshot: {
      html:
        includeHtml && maxHtmlLength > 0
          ? truncateString(readOptionalString(snapshot.html), maxHtmlLength)
          : undefined,
      id: readOptionalString(snapshot.id),
      text: truncateString(readOptionalString(snapshot.text), maxTextLength),
      title: readOptionalString(snapshot.title),
      url: readOptionalString(snapshot.url),
    },
  });
}

function ok(tool: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    tool,
    ...data,
  };
}

async function latestBrowserTabId(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
): Promise<string | undefined> {
  const tabs = await invokeBrowserMethod("browser.list", undefined);
  if (!Array.isArray(tabs)) return undefined;
  return tabs
    .map(recordValue)
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
    .map((tab) => readOptionalString(tab.id))
    .find(Boolean);
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function browserWaitUntilSchema(): Record<string, unknown> {
  return {
    type: "string",
    enum: ["none", "domcontentloaded", "load"],
    description: "Navigation wait condition. Defaults to load.",
  };
}

function timeoutSchema(): Record<string, unknown> {
  return {
    type: "number",
    description: "Timeout in milliseconds. Browser runtime clamps this to a safe range.",
  };
}

function readRequiredString(value: unknown, message: string): string {
  const result = readOptionalString(value);
  if (!result) throw new Error(message);
  return result;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim())
    .slice(0, 128);
  return result.length ? result : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  const record = recordValue(value);
  return Object.keys(record).length ? record : undefined;
}

function readLimitedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = readOptionalNumber(value);
  if (numberValue === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}

function readBrowserWaitUntil(value: unknown): "none" | "domcontentloaded" | "load" | undefined {
  return value === "none" || value === "domcontentloaded" || value === "load" ? value : undefined;
}

function readScreenshotFormat(value: unknown): "png" | "jpeg" | undefined {
  return value === "png" || value === "jpeg" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truncateString(value: string | undefined, maxLength: number): string {
  if (!value || maxLength <= 0) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[truncated]` : value;
}
