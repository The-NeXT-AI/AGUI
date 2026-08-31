import { randomUUID } from "node:crypto";
import type { McpGatewayToolDefinition, McpGatewayToolProvider } from "./types.js";

export const panelMcpProviderId = "agui_panel";

export type AguiPanelTabState = {
  active?: boolean;
  createdAt?: number;
  id: string;
  ordinal?: number;
  panelId: string;
  title?: string;
};

export type AguiPanelSummaryState = {
  allowMultiple?: boolean;
  id: string;
  order?: number;
  title: string;
};

export type AguiIdePanelTabState = {
  diagnostics?: unknown[];
  diagnosticsLoading?: boolean;
  dirty?: boolean;
  error?: string;
  language?: string;
  mtimeMs?: number;
  name?: string;
  path: string;
};

export type AguiIdePanelState = {
  activeContent?: string;
  activePath?: string | null;
  root?: string;
  tabs: AguiIdePanelTabState[];
  updatedAt?: number;
};

export type AguiPanelRuntimeState = {
  activeDetailPanelId?: string | null;
  activeDetailPanelTabId?: string | null;
  detailPanelOpen: boolean;
  ide?: AguiIdePanelState;
  panels: AguiPanelSummaryState[];
  project?: {
    root?: string;
    workspaceId?: string;
  };
  tabs: AguiPanelTabState[];
  updatedAt?: number;
};

export type AguiTerminalRuntimeRecord = {
  args?: string[];
  command?: string;
  cwd?: string;
  id: string;
  kind: "process" | "session";
  outputLength: number;
  signal?: string | null;
  startedAt: number;
  status: "exited" | "running";
  updatedAt: number;
};

export type AguiTerminalOutputSnapshot = {
  id: string;
  output: string;
  truncated: boolean;
};

export type AguiPanelCommand =
  | { type: "panel.open"; allowMultiple?: boolean; panelId: string }
  | { type: "panel.selectTab"; tabId: string }
  | { type: "panel.closeTab"; tabId: string }
  | { type: "panel.setOpen"; open: boolean }
  | { type: "ide.openFile"; filePath: string; root?: string };

export type PanelMcpToolProviderOptions = {
  getPanelState(): AguiPanelRuntimeState;
  ide?: {
    readFile(input: { filePath: string; root: string }): Promise<unknown> | unknown;
    tree(input: { root: string }): Promise<unknown> | unknown;
    workspaceDiagnostics(input: { root: string }): Promise<unknown> | unknown;
    writeFile(input: {
      content: string;
      filePath: string;
      root: string;
    }): Promise<unknown> | unknown;
  };
  sendPanelCommand(command: AguiPanelCommand): Promise<unknown> | unknown;
  terminal?: {
    cancel(id: string): Promise<unknown> | unknown;
    list(): Promise<AguiTerminalRuntimeRecord[]> | AguiTerminalRuntimeRecord[];
    readOutput(input: {
      id: string;
      maxChars?: number;
    }): Promise<AguiTerminalOutputSnapshot> | AguiTerminalOutputSnapshot;
    runCommand(input: { command: string; cwd?: string; id?: string }): Promise<unknown> | unknown;
    writeInput(input: { data: string; id: string }): Promise<unknown> | unknown;
  };
};

export function createPanelMcpToolProvider(
  options: PanelMcpToolProviderOptions,
): McpGatewayToolProvider {
  return {
    listTools: () => panelToolDefinitions(options.getPanelState()),
    callTool: (name, args) => callPanelTool(options, name, args),
  };
}

export function panelToolDefinitions(state: AguiPanelRuntimeState): McpGatewayToolDefinition[] {
  const panels = new Set(state.panels.map((panel) => panel.id));
  const tools: McpGatewayToolDefinition[] = [];
  if (state.panels.length) tools.push(...detailPanelToolDefinitions());
  if (panels.has("terminal")) tools.push(...terminalToolDefinitions());
  if (panels.has("ide")) tools.push(...ideToolDefinitions());
  return tools;
}

async function callPanelTool(
  options: PanelMcpToolProviderOptions,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<unknown> {
  const state = options.getPanelState();
  if (!panelToolDefinitions(state).some((tool) => tool.name === name)) {
    throw new Error(`AGUI panel tool is unavailable for the current right panel set: ${name}`);
  }
  const args = isRecord(rawArgs) ? rawArgs : {};
  switch (name) {
    case "panel_list":
      return ok(name, { state });
    case "panel_open": {
      const panelId = requiredString(args.panelId, "panel_open requires panelId.");
      requirePanel(state, panelId);
      const result = await options.sendPanelCommand({
        type: "panel.open",
        panelId,
        allowMultiple: optionalBoolean(args.allowMultiple),
      });
      return ok(name, { command: "panel.open", panelId, result });
    }
    case "panel_select_tab": {
      const tabId = requiredString(args.tabId, "panel_select_tab requires tabId.");
      if (!state.tabs.some((tab) => tab.id === tabId))
        throw new Error(`Unknown panel tab: ${tabId}`);
      const result = await options.sendPanelCommand({ type: "panel.selectTab", tabId });
      return ok(name, { command: "panel.selectTab", result, tabId });
    }
    case "panel_close_tab": {
      const tabId = requiredString(args.tabId, "panel_close_tab requires tabId.");
      if (!state.tabs.some((tab) => tab.id === tabId))
        throw new Error(`Unknown panel tab: ${tabId}`);
      const result = await options.sendPanelCommand({ type: "panel.closeTab", tabId });
      return ok(name, { command: "panel.closeTab", result, tabId });
    }
    case "terminal_list":
      return ok(name, { terminals: await requireTerminal(options).list() });
    case "terminal_read_output": {
      const id = requiredString(args.id, "terminal_read_output requires id.");
      const maxChars = optionalNumber(args.maxChars);
      return ok(name, { output: await requireTerminal(options).readOutput({ id, maxChars }) });
    }
    case "terminal_write_input": {
      const id = requiredString(args.id, "terminal_write_input requires id.");
      const data = requiredString(args.data, "terminal_write_input requires data.");
      return ok(name, { written: await requireTerminal(options).writeInput({ id, data }) });
    }
    case "terminal_run_command": {
      const command = requiredString(args.command, "terminal_run_command requires command.");
      const id =
        optionalString(args.id) || `agent.terminal.${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const cwd = optionalString(args.cwd) || state.project?.root || undefined;
      return ok(name, {
        terminal: await requireTerminal(options).runCommand({ id, command, cwd }),
      });
    }
    case "terminal_cancel": {
      const id = requiredString(args.id, "terminal_cancel requires id.");
      return ok(name, { canceled: await requireTerminal(options).cancel(id) });
    }
    case "ide_panel_state":
      return ok(name, { ide: state.ide ?? { tabs: [] } });
    case "ide_open_file": {
      const root = ideRoot(state, args);
      const filePath = requiredString(args.filePath, "ide_open_file requires filePath.");
      const result = await options.sendPanelCommand({ type: "ide.openFile", root, filePath });
      const file = await requireIde(options).readFile({ root, filePath });
      return ok(name, { command: "ide.openFile", file, result });
    }
    case "ide_workspace_tree": {
      const root = ideRoot(state, args);
      return ok(name, { tree: await requireIde(options).tree({ root }) });
    }
    case "ide_read_file": {
      const root = ideRoot(state, args);
      const filePath = requiredString(args.filePath, "ide_read_file requires filePath.");
      return ok(name, { file: await requireIde(options).readFile({ root, filePath }) });
    }
    case "ide_write_file": {
      const root = ideRoot(state, args);
      const filePath = requiredString(args.filePath, "ide_write_file requires filePath.");
      const content = requiredString(args.content, "ide_write_file requires content.");
      const file = await requireIde(options).writeFile({ root, filePath, content });
      return ok(name, { file });
    }
    case "ide_workspace_diagnostics": {
      const root = ideRoot(state, args);
      return ok(name, { diagnostics: await requireIde(options).workspaceDiagnostics({ root }) });
    }
    default:
      throw new Error(`Unknown AGUI panel tool: ${name}`);
  }
}

function detailPanelToolDefinitions(): McpGatewayToolDefinition[] {
  return [
    {
      name: "panel_list",
      title: "List AGUI Right Panels",
      description:
        "Read the AGUI right-side detail panel state, including available panels, open tabs, active tab and current project root.",
      inputSchema: objectSchema({}, []),
    },
    {
      name: "panel_open",
      title: "Open Right Panel",
      description:
        "Open or create an AGUI right-side detail panel tab. This updates the app shell UI.",
      inputSchema: objectSchema(
        {
          allowMultiple: { type: "boolean", description: "Create a new tab when supported." },
          panelId: { type: "string", description: "Right panel id to open." },
        },
        ["panelId"],
      ),
    },
    {
      name: "panel_select_tab",
      title: "Select Right Panel Tab",
      description: "Select an existing AGUI right-side detail panel tab. This updates UI state.",
      inputSchema: objectSchema(
        { tabId: { type: "string", description: "Existing detail panel tab id." } },
        ["tabId"],
      ),
    },
    {
      name: "panel_close_tab",
      title: "Close Right Panel Tab",
      description: "Close an existing AGUI right-side detail panel tab. This updates UI state.",
      inputSchema: objectSchema(
        { tabId: { type: "string", description: "Existing detail panel tab id." } },
        ["tabId"],
      ),
    },
  ];
}

function terminalToolDefinitions(): McpGatewayToolDefinition[] {
  return [
    {
      name: "terminal_list",
      title: "List AGUI Terminals",
      description:
        "List AGUI terminal sessions and command processes known to the right-side Terminal panel runtime.",
      inputSchema: objectSchema({}, []),
    },
    {
      name: "terminal_read_output",
      title: "Read AGUI Terminal Output",
      description: "Read the buffered output from an AGUI terminal or command process.",
      inputSchema: objectSchema(
        {
          id: { type: "string", description: "Terminal id." },
          maxChars: { type: "number", description: "Maximum trailing characters to return." },
        },
        ["id"],
      ),
    },
    {
      name: "terminal_write_input",
      title: "Write AGUI Terminal Input",
      description:
        "Write input to an existing AGUI terminal session or command process. This updates terminal state.",
      inputSchema: objectSchema(
        {
          data: { type: "string", description: "Input bytes/text to send." },
          id: { type: "string", description: "Terminal id." },
        },
        ["id", "data"],
      ),
    },
    {
      name: "terminal_run_command",
      title: "Run AGUI Terminal Command",
      description:
        "Run a shell command through the AGUI terminal runtime. This creates a command process; read output with terminal_read_output.",
      inputSchema: objectSchema(
        {
          command: { type: "string", description: "Shell command to run." },
          cwd: {
            type: "string",
            description: "Working directory. Defaults to active project root.",
          },
          id: { type: "string", description: "Optional stable terminal process id." },
        },
        ["command"],
      ),
    },
    {
      name: "terminal_cancel",
      title: "Cancel AGUI Terminal",
      description:
        "Cancel an AGUI terminal session or command process. This updates terminal state.",
      inputSchema: objectSchema({ id: { type: "string", description: "Terminal id." } }, ["id"]),
    },
  ];
}

function ideToolDefinitions(): McpGatewayToolDefinition[] {
  return [
    {
      name: "ide_panel_state",
      title: "Read AGUI IDE Panel State",
      description:
        "Read the AGUI right-side IDE panel state, including open tabs, active path, dirty flags, diagnostics and active unsaved content when available.",
      inputSchema: objectSchema({}, []),
    },
    {
      name: "ide_open_file",
      title: "Open File In AGUI IDE",
      description:
        "Open a workspace file in the AGUI right-side IDE panel and return the file content.",
      inputSchema: ideFileSchema("File path to open in the IDE panel."),
    },
    {
      name: "ide_workspace_tree",
      title: "Read AGUI IDE Workspace Tree",
      description: "Read the workspace tree used by the AGUI right-side IDE panel.",
      inputSchema: objectSchema(
        { root: { type: "string", description: "Workspace root. Defaults to active IDE root." } },
        [],
      ),
    },
    {
      name: "ide_read_file",
      title: "Read AGUI IDE File",
      description: "Read a workspace file through the AGUI IDE runtime.",
      inputSchema: ideFileSchema("File path to read."),
    },
    {
      name: "ide_write_file",
      title: "Write AGUI IDE File",
      description: "Write a workspace file through the AGUI IDE runtime. This updates file state.",
      inputSchema: objectSchema(
        {
          content: { type: "string", description: "New UTF-8 file content." },
          filePath: { type: "string", description: "File path to write." },
          root: { type: "string", description: "Workspace root. Defaults to active IDE root." },
        },
        ["filePath", "content"],
      ),
    },
    {
      name: "ide_workspace_diagnostics",
      title: "Read AGUI IDE Workspace Diagnostics",
      description: "Read workspace diagnostics from the AGUI IDE runtime.",
      inputSchema: objectSchema(
        { root: { type: "string", description: "Workspace root. Defaults to active IDE root." } },
        [],
      ),
    },
  ];
}

function ideFileSchema(filePathDescription: string): Record<string, unknown> {
  return objectSchema(
    {
      filePath: { type: "string", description: filePathDescription },
      root: { type: "string", description: "Workspace root. Defaults to active IDE root." },
    },
    ["filePath"],
  );
}

function requirePanel(state: AguiPanelRuntimeState, panelId: string): void {
  if (!state.panels.some((panel) => panel.id === panelId)) {
    throw new Error(`Right panel is not available: ${panelId}`);
  }
}

function requireTerminal(
  options: PanelMcpToolProviderOptions,
): NonNullable<PanelMcpToolProviderOptions["terminal"]> {
  if (!options.terminal) throw new Error("AGUI terminal runtime is unavailable.");
  return options.terminal;
}

function requireIde(
  options: PanelMcpToolProviderOptions,
): NonNullable<PanelMcpToolProviderOptions["ide"]> {
  if (!options.ide) throw new Error("AGUI IDE runtime is unavailable.");
  return options.ide;
}

function ideRoot(state: AguiPanelRuntimeState, args: Record<string, unknown>): string {
  const root = optionalString(args.root) || state.ide?.root || state.project?.root || "";
  if (!root) throw new Error("IDE workspace root is unavailable.");
  return root;
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function ok(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, tool, ...result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, message: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(message);
  return text;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
