import fs from "node:fs";
import path from "node:path";

export type BrowserWorkflowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserWorkflowStep = {
  clearFirst?: boolean;
  input?: string;
  note?: string;
  rect?: BrowserWorkflowRect;
  saveAs?: string;
  selector?: string;
  text?: string;
  textContains?: string;
  timeoutMs?: number;
  type: "assert" | "click" | "navigate" | "snapshot" | "submit" | "type" | "waitFor";
  url?: string;
  urlIncludes?: string;
  waitAfterMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "none";
  x?: number;
  y?: number;
};

export type BrowserWorkflowDefinition = {
  createdAt: number;
  description: string;
  enabled: boolean;
  id: string;
  inputSchema: Record<string, unknown>;
  requireConfirmation: boolean;
  sideEffect: boolean;
  steps: BrowserWorkflowStep[];
  tags: string[];
  title: string;
  toolName: string;
  updatedAt: number;
  version: 1;
};

export type BrowserWorkflowSaveInput = Partial<
  Omit<BrowserWorkflowDefinition, "createdAt" | "toolName" | "updatedAt" | "version">
> & {
  createdAt?: number;
  toolName?: string;
  updatedAt?: number;
};

type BrowserWorkflowStoreFile = {
  version?: 1;
  workflows?: unknown[];
};

const workflowStoreVersion = 1;
const defaultWorkflowInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export class BrowserWorkflowStore {
  constructor(private readonly userDataPath: string) {}

  list(): BrowserWorkflowDefinition[] {
    return this.readFile().sort((left, right) => left.title.localeCompare(right.title));
  }

  get(idOrToolName: string): BrowserWorkflowDefinition | undefined {
    const key = normalizeWorkflowLookupKey(idOrToolName);
    if (!key) return undefined;
    return this.readFile().find((workflow) => {
      return workflow.id === key || workflow.toolName === key || workflow.toolName === idOrToolName;
    });
  }

  save(input: BrowserWorkflowSaveInput): BrowserWorkflowDefinition {
    const existing =
      input.id || input.toolName ? this.get(input.id || input.toolName || "") : undefined;
    const workflow = normalizeBrowserWorkflowDefinition(input, existing);
    const workflows = [
      ...this.readFile().filter((candidate) => candidate.id !== workflow.id),
      workflow,
    ].sort((left, right) => left.title.localeCompare(right.title));
    this.writeFile(workflows);
    return workflow;
  }

  remove(idOrToolName: string): boolean {
    const key = normalizeWorkflowLookupKey(idOrToolName);
    if (!key) return false;
    const workflows = this.readFile();
    const next = workflows.filter(
      (workflow) =>
        workflow.id !== key && workflow.toolName !== key && workflow.toolName !== idOrToolName,
    );
    if (next.length === workflows.length) return false;
    this.writeFile(next);
    return true;
  }

  private readFile(): BrowserWorkflowDefinition[] {
    try {
      const filePath = browserWorkflowStorePath(this.userDataPath);
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as BrowserWorkflowStoreFile;
      const workflows = Array.isArray(parsed.workflows) ? parsed.workflows : [];
      const seen = new Set<string>();
      return workflows
        .map((workflow) => normalizeBrowserWorkflowDefinition(workflow))
        .filter((workflow) => {
          if (seen.has(workflow.id)) return false;
          seen.add(workflow.id);
          return true;
        });
    } catch {
      return [];
    }
  }

  private writeFile(workflows: BrowserWorkflowDefinition[]): void {
    const filePath = browserWorkflowStorePath(this.userDataPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempFile = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tempFile,
      `${JSON.stringify({ version: workflowStoreVersion, workflows }, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(tempFile, filePath);
  }
}

export function browserWorkflowStorePath(userDataPath: string): string {
  return path.join(userDataPath, "browser-workflows.json");
}

export function browserWorkflowToolName(id: string): string {
  const normalized = safeWorkflowId(id) || "workflow";
  return `browser_workflow_${normalized.replace(/-/g, "_")}`;
}

export function safeWorkflowId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  if (!slug) return "";
  return /^[a-z][a-z0-9_-]{0,79}$/.test(slug) ? slug : `workflow_${slug}`.slice(0, 80);
}

export function normalizeBrowserWorkflowDefinition(
  value: unknown,
  existing?: BrowserWorkflowDefinition,
): BrowserWorkflowDefinition {
  const record = recordValue(value);
  const now = Date.now();
  const title = stringValue(record.title).slice(0, 160) || existing?.title || "Browser Workflow";
  const id =
    safeWorkflowId(record.id) ||
    workflowIdFromToolName(stringValue(record.toolName)) ||
    existing?.id ||
    safeWorkflowId(title) ||
    "browser_workflow";
  const sideEffect =
    record.sideEffect === undefined ? (existing?.sideEffect ?? true) : record.sideEffect === true;
  const requireConfirmation =
    record.requireConfirmation === undefined
      ? (existing?.requireConfirmation ?? sideEffect)
      : record.requireConfirmation === true;
  return {
    createdAt: finiteTimestamp(record.createdAt) || existing?.createdAt || now,
    description:
      stringValue(record.description).slice(0, 2_000) ||
      existing?.description ||
      `Execute the saved browser workflow "${title}".`,
    enabled: record.enabled === undefined ? (existing?.enabled ?? true) : record.enabled !== false,
    id,
    inputSchema:
      record.inputSchema === undefined
        ? (existing?.inputSchema ?? { ...defaultWorkflowInputSchema })
        : normalizeInputSchema(record.inputSchema),
    requireConfirmation,
    sideEffect,
    steps:
      record.steps === undefined ? (existing?.steps ?? []) : normalizeWorkflowSteps(record.steps),
    tags: record.tags === undefined ? (existing?.tags ?? []) : stringArray(record.tags, 20, 64),
    title,
    toolName: normalizeWorkflowToolName(record.toolName, id),
    updatedAt: finiteTimestamp(record.updatedAt) || now,
    version: 1,
  };
}

export function workflowIdFromToolName(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const stripped = raw.startsWith("browser_workflow_")
    ? raw.slice("browser_workflow_".length)
    : raw;
  return safeWorkflowId(stripped);
}

function normalizeWorkflowToolName(value: unknown, id: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(raw)) {
    return raw.startsWith("browser_workflow_") ? raw : `browser_workflow_${raw}`;
  }
  return browserWorkflowToolName(id);
}

function normalizeWorkflowLookupKey(value: string): string {
  return safeWorkflowId(value) || workflowIdFromToolName(value) || value.trim();
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  const schema = recordValue(value);
  if (schema.type !== "object") return { ...defaultWorkflowInputSchema };
  const properties = recordValue(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string").slice(0, 100)
    : [];
  return {
    type: "object",
    properties,
    required,
    additionalProperties: schema.additionalProperties === true,
  };
}

function normalizeWorkflowSteps(value: unknown): BrowserWorkflowStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(recordValue)
    .map(normalizeWorkflowStep)
    .filter((step): step is BrowserWorkflowStep => Boolean(step))
    .slice(0, 200);
}

function normalizeWorkflowStep(record: Record<string, unknown>): BrowserWorkflowStep | null {
  const type = stringValue(record.type);
  if (!["assert", "click", "navigate", "snapshot", "submit", "type", "waitFor"].includes(type))
    return null;
  const step: BrowserWorkflowStep = {
    clearFirst: record.clearFirst === true,
    input: stringValue(record.input).slice(0, 128) || undefined,
    note: stringValue(record.note).slice(0, 2_000) || undefined,
    rect: normalizeRect(record.rect),
    saveAs: stringValue(record.saveAs).slice(0, 128) || undefined,
    selector: stringValue(record.selector).slice(0, 32_768) || undefined,
    text: stringValue(record.text).slice(0, 200_000) || undefined,
    textContains: stringValue(record.textContains).slice(0, 8_192) || undefined,
    timeoutMs: limitedNumber(record.timeoutMs, 1_000, 10 * 60_000),
    type: type as BrowserWorkflowStep["type"],
    url: stringValue(record.url).slice(0, 16_384) || undefined,
    urlIncludes: stringValue(record.urlIncludes).slice(0, 4_096) || undefined,
    waitAfterMs: limitedNumber(record.waitAfterMs, 0, 60_000),
    waitUntil:
      record.waitUntil === "none" ||
      record.waitUntil === "domcontentloaded" ||
      record.waitUntil === "load"
        ? record.waitUntil
        : undefined,
    x: finiteNumber(record.x),
    y: finiteNumber(record.y),
  };
  return step;
}

function normalizeRect(value: unknown): BrowserWorkflowRect | undefined {
  const record = recordValue(value);
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    x,
    y,
    width: Math.max(1, finiteNumber(record.width, 1)),
    height: Math.max(1, finiteNumber(record.height, 1)),
  };
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function limitedNumber(value: unknown, min: number, max: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function finiteNumber(value: unknown, fallback = Number.NaN): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, maxItems);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
