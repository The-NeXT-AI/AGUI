import { randomUUID } from "node:crypto";
import {
  BrowserWorkflowStore,
  browserWorkflowToolName,
  normalizeBrowserWorkflowDefinition,
  safeWorkflowId,
  type BrowserWorkflowDefinition,
  type BrowserWorkflowRect,
  type BrowserWorkflowSaveInput,
  type BrowserWorkflowStep,
} from "./browser-workflow-store.js";
import type { BrowserMcpMethodInvoker } from "./browser-tool-provider.js";
import type { McpGatewayToolDefinition, McpGatewayToolProvider } from "./types.js";

export const browserWorkflowMcpProviderId = "agui_browser_workflows";

export type BrowserWorkflowMcpToolProviderOptions = {
  invokeBrowserMethod: BrowserMcpMethodInvoker;
  onCatalogChanged?: () => void;
  store: BrowserWorkflowStore;
};

export type BrowserWorkflowAnnotation = {
  createdAt: number;
  id: string;
  note: string;
  rect?: BrowserWorkflowRect;
  selector?: string;
  text?: string;
  title?: string;
  type: "element" | "region";
  url?: string;
  x?: number;
  y?: number;
};

const browserWorkflowStaticTools = new Set([
  "browser_workflow_list",
  "browser_workflow_get",
  "browser_workflow_save",
  "browser_workflow_delete",
  "browser_workflow_generate_from_annotations",
  "browser_workflow_run",
]);

export function createBrowserWorkflowMcpToolProvider(
  options: BrowserWorkflowMcpToolProviderOptions,
): McpGatewayToolProvider {
  return {
    listTools: () => browserWorkflowToolDefinitions(options.store),
    callTool: (name, args) => callBrowserWorkflowTool(options, name, args),
  };
}

export function browserWorkflowToolDefinitions(
  store: BrowserWorkflowStore,
): McpGatewayToolDefinition[] {
  return [
    ...browserWorkflowAuthoringToolDefinitions(),
    ...store
      .list()
      .filter((workflow) => workflow.enabled)
      .map(workflowToolDefinition),
  ];
}

async function callBrowserWorkflowTool(
  options: BrowserWorkflowMcpToolProviderOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!browserWorkflowStaticTools.has(name)) {
    const workflow = options.store.list().find((candidate) => candidate.toolName === name);
    if (!workflow) throw new Error(`Unknown browser workflow tool: ${name}`);
    return runBrowserWorkflow(options.invokeBrowserMethod, workflow, args);
  }

  switch (name) {
    case "browser_workflow_list":
      return ok(name, { workflows: options.store.list() });
    case "browser_workflow_get": {
      const workflow = options.store.get(requiredString(args.id ?? args.toolName, "workflow id"));
      return ok(name, { workflow: workflow ?? null });
    }
    case "browser_workflow_save": {
      const definition = recordValue(args.definition);
      const input = Object.keys(definition).length > 0 ? definition : args;
      const workflow = options.store.save(input as BrowserWorkflowSaveInput);
      options.onCatalogChanged?.();
      return ok(name, { workflow });
    }
    case "browser_workflow_delete": {
      const removed = options.store.remove(requiredString(args.id ?? args.toolName, "workflow id"));
      if (removed) options.onCatalogChanged?.();
      return ok(name, { removed });
    }
    case "browser_workflow_generate_from_annotations": {
      const generated = await generateWorkflowFromCurrentAnnotations(options, args);
      if (generated.saved) options.onCatalogChanged?.();
      return ok(name, generated);
    }
    case "browser_workflow_run": {
      const workflow = options.store.get(requiredString(args.id ?? args.toolName, "workflow id"));
      if (!workflow) throw new Error("Browser workflow was not found.");
      const nestedArgs = recordValue(args.args);
      const workflowArgs = Object.keys(nestedArgs).length > 0 ? nestedArgs : args;
      return runBrowserWorkflow(options.invokeBrowserMethod, workflow, workflowArgs);
    }
    default:
      throw new Error(`Unknown browser workflow authoring tool: ${name}`);
  }
}

function browserWorkflowAuthoringToolDefinitions(): McpGatewayToolDefinition[] {
  return [
    {
      name: "browser_workflow_list",
      title: "List Browser Workflows",
      description:
        "List saved browser workflows that are injected into MCP Gateway as fixed browser automation tools.",
      inputSchema: objectSchema({}, []),
    },
    {
      name: "browser_workflow_get",
      title: "Get Browser Workflow",
      description: "Read one saved browser workflow definition by id or toolName.",
      inputSchema: objectSchema(
        {
          id: { type: "string", description: "Workflow id or toolName." },
          toolName: { type: "string", description: "Workflow toolName." },
        },
        [],
      ),
    },
    {
      name: "browser_workflow_save",
      title: "Save Browser Workflow",
      description:
        "Create or update a fixed browser workflow MCP tool. Use this after reading browser annotations and converting them into navigate/click/type/submit/wait/assert steps.",
      inputSchema: workflowSaveSchema(),
    },
    {
      name: "browser_workflow_delete",
      title: "Delete Browser Workflow",
      description: "Delete a saved browser workflow MCP tool by id or toolName.",
      inputSchema: objectSchema(
        {
          id: { type: "string", description: "Workflow id or toolName." },
          toolName: { type: "string", description: "Workflow toolName." },
        },
        [],
      ),
    },
    {
      name: "browser_workflow_generate_from_annotations",
      title: "Generate Browser Workflow From Annotations",
      description:
        "Read current Browser annotations and generate a workflow draft or save it as a fixed MCP tool. Notes containing type/fill/input create type steps; notes containing verify/check/wait/assert create wait/assert steps; other notes create clicks.",
      inputSchema: objectSchema(
        {
          description: { type: "string" },
          id: { type: "string" },
          save: { type: "boolean", description: "Save the generated workflow. Defaults to false." },
          title: { type: "string" },
          browserId: { type: "string", description: "Optional Browser tab id." },
        },
        [],
      ),
    },
    {
      name: "browser_workflow_run",
      title: "Run Browser Workflow",
      description:
        "Execute a saved browser workflow by id or toolName. Prefer calling the fixed workflow tool directly when it is visible in Gateway catalog.",
      inputSchema: objectSchema(
        {
          args: { type: "object", additionalProperties: true },
          browserId: { type: "string" },
          confirmed: { type: "boolean" },
          dryRun: { type: "boolean" },
          id: { type: "string" },
          toolName: { type: "string" },
        },
        [],
      ),
    },
  ];
}

function workflowToolDefinition(workflow: BrowserWorkflowDefinition): McpGatewayToolDefinition {
  return {
    name: workflow.toolName,
    title: workflow.title,
    description: [
      workflow.description,
      "This is a saved fixed browser workflow generated from user-guided browser annotations or interactions.",
      workflow.requireConfirmation
        ? "Pass confirmed=true only after explicit user confirmation."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    inputSchema: workflowExecutionSchema(workflow),
    tags: ["browser", "workflow", ...workflow.tags],
  };
}

async function runBrowserWorkflow(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  workflow: BrowserWorkflowDefinition,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (workflow.requireConfirmation && args.confirmed !== true) {
    throw new Error(
      `Browser workflow ${workflow.id} requires explicit confirmation. Call it with confirmed=true only after the user confirms this side-effecting browser automation.`,
    );
  }
  const browserId = await ensureBrowserTab(invokeBrowserMethod, workflow, args);
  if (args.dryRun === true) {
    return ok(workflow.toolName, {
      browserId,
      dryRun: true,
      steps: workflow.steps.map((step) => renderStepPreview(step, args)),
      workflow: workflowSummary(workflow),
    });
  }

  const context: Record<string, unknown> = {};
  let lastTarget: unknown;
  for (const [index, step] of workflow.steps.entries()) {
    lastTarget = await runBrowserWorkflowStep(invokeBrowserMethod, browserId, step, args, context);
    context[`step_${index + 1}`] = lastTarget;
    if (step.saveAs) context[step.saveAs] = lastTarget;
    if (step.waitAfterMs) await delay(step.waitAfterMs);
  }

  const snapshot = recordValue(
    await Promise.resolve(invokeBrowserMethod("browser.snapshot", { id: browserId })).catch(
      () => undefined,
    ),
  );
  return ok(workflow.toolName, {
    browserId,
    final: compactSnapshot(snapshot),
    lastStep: lastTarget,
    stepCount: workflow.steps.length,
    workflow: workflowSummary(workflow),
  });
}

async function runBrowserWorkflowStep(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  browserId: string,
  step: BrowserWorkflowStep,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<unknown> {
  switch (step.type) {
    case "navigate":
      return invokeBrowserMethod("browser.navigate", {
        id: browserId,
        timeoutMs: step.timeoutMs,
        url: renderTemplate(requiredStepString(step.url, "navigate.url"), args, context),
        waitUntil: step.waitUntil ?? "load",
      });
    case "click":
      return clickWorkflowTarget(invokeBrowserMethod, browserId, step);
    case "submit":
      return submitWorkflowTarget(invokeBrowserMethod, browserId, step);
    case "type": {
      const text =
        step.input && args[step.input] !== undefined
          ? stringifyInput(args[step.input])
          : renderTemplate(requiredStepString(step.text, "type.text or type.input"), args, context);
      if (step.clearFirst && step.selector) {
        await invokeBrowserMethod("browser.evaluate", {
          awaitPromise: true,
          expression: clearBrowserElementExpression(step.selector),
          id: browserId,
        });
      }
      if (!step.selector && step.rect) {
        await clickPageRect(invokeBrowserMethod, browserId, step.rect);
      }
      return invokeBrowserMethod("browser.type", {
        id: browserId,
        selector: step.selector,
        text,
      });
    }
    case "waitFor":
      return waitForWorkflowCondition(invokeBrowserMethod, browserId, step, args, context);
    case "assert":
      return waitForWorkflowCondition(
        invokeBrowserMethod,
        browserId,
        {
          ...step,
          timeoutMs: step.timeoutMs ?? 5_000,
        },
        args,
        context,
      );
    case "snapshot":
      return invokeBrowserMethod("browser.snapshot", { id: browserId });
    default:
      throw new Error(`Unsupported browser workflow step: ${(step as BrowserWorkflowStep).type}`);
  }
}

async function submitWorkflowTarget(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  browserId: string,
  step: BrowserWorkflowStep,
): Promise<unknown> {
  return invokeBrowserMethod("browser.evaluate", {
    awaitPromise: true,
    expression: `(() => {
      const selector = ${JSON.stringify(step.selector || "")};
      const rect = ${JSON.stringify(step.rect || null)};
      let element = selector ? document.querySelector(selector) : null;
      if (!element && rect) {
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        window.scrollTo({
          left: Math.max(0, centerX - window.innerWidth / 2),
          top: Math.max(0, centerY - window.innerHeight / 2),
          behavior: "instant"
        });
        element = document.elementFromPoint(centerX - window.scrollX, centerY - window.scrollY);
      }
      if (!element) return { submitted: false, reason: "target_not_found" };
      element.scrollIntoView?.({ block: "center", inline: "center" });
      element.focus?.();
      const form = element instanceof HTMLFormElement ? element : element.closest?.("form");
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        return { submitted: true, selector, url: location.href };
      }
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
      return { submitted: false, fallback: "enter", selector, url: location.href };
    })()`,
    id: browserId,
  });
}

async function clickWorkflowTarget(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  browserId: string,
  step: BrowserWorkflowStep,
): Promise<unknown> {
  if (step.selector) {
    try {
      return await invokeBrowserMethod("browser.click", { id: browserId, selector: step.selector });
    } catch (error) {
      if (!step.rect) throw error;
    }
  }
  if (step.rect) return clickPageRect(invokeBrowserMethod, browserId, step.rect);
  return invokeBrowserMethod("browser.click", { id: browserId, x: step.x, y: step.y });
}

async function clickPageRect(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  browserId: string,
  rect: BrowserWorkflowRect,
): Promise<unknown> {
  const result = recordValue(
    await invokeBrowserMethod("browser.evaluate", {
      awaitPromise: true,
      expression: `(() => {
        const rect = ${JSON.stringify(rect)};
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        window.scrollTo({
          left: Math.max(0, centerX - window.innerWidth / 2),
          top: Math.max(0, centerY - window.innerHeight / 2),
          behavior: "instant"
        });
        return {
          x: Math.round(centerX - window.scrollX),
          y: Math.round(centerY - window.scrollY)
        };
      })()`,
      id: browserId,
    }),
  );
  const point = recordValue(result.value);
  return invokeBrowserMethod("browser.click", {
    id: browserId,
    x: finiteNumber(point.x),
    y: finiteNumber(point.y),
  });
}

async function waitForWorkflowCondition(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  browserId: string,
  step: BrowserWorkflowStep,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<unknown> {
  const timeoutMs = step.timeoutMs ?? 15_000;
  const startedAt = Date.now();
  const expectedText = step.textContains
    ? renderTemplate(step.textContains, args, context)
    : undefined;
  const expectedUrl = step.urlIncludes
    ? renderTemplate(step.urlIncludes, args, context)
    : undefined;
  let lastSnapshot: Record<string, unknown> = {};
  while (Date.now() - startedAt <= timeoutMs) {
    if (step.selector) {
      const inspection = recordValue(
        await Promise.resolve(
          invokeBrowserMethod("browser.inspectElement", {
            id: browserId,
            selector: step.selector,
          }),
        ).catch(() => undefined),
      );
      const element = recordValue(inspection.element);
      if (expectedText && stringValue(element.text).includes(expectedText)) {
        return ok("browser_workflow_wait_for", { element, matched: true });
      }
      if (!expectedText && Object.keys(element).length > 0) {
        return ok("browser_workflow_wait_for", { element, matched: true });
      }
    }
    lastSnapshot = recordValue(
      await Promise.resolve(invokeBrowserMethod("browser.snapshot", { id: browserId })).catch(
        () => undefined,
      ),
    );
    const text = stringValue(lastSnapshot.text);
    const url = stringValue(lastSnapshot.url);
    if (expectedText && text.includes(expectedText)) {
      return ok("browser_workflow_wait_for", {
        matched: true,
        snapshot: compactSnapshot(lastSnapshot),
      });
    }
    if (expectedUrl && url.includes(expectedUrl)) {
      return ok("browser_workflow_wait_for", {
        matched: true,
        snapshot: compactSnapshot(lastSnapshot),
      });
    }
    if (!expectedText && !expectedUrl && !step.selector) {
      return ok("browser_workflow_wait_for", {
        matched: true,
        snapshot: compactSnapshot(lastSnapshot),
      });
    }
    await delay(300);
  }
  throw new Error(
    `Browser workflow condition timed out after ${timeoutMs}ms: ${JSON.stringify({
      selector: step.selector,
      textContains: expectedText,
      urlIncludes: expectedUrl,
      last: compactSnapshot(lastSnapshot),
    })}`,
  );
}

async function ensureBrowserTab(
  invokeBrowserMethod: BrowserMcpMethodInvoker,
  workflow: BrowserWorkflowDefinition,
  args: Record<string, unknown>,
): Promise<string> {
  const requested = optionalString(args.browserId) || optionalString(args.id);
  if (requested) return requested;
  const tabs = await Promise.resolve(invokeBrowserMethod("browser.list", undefined)).catch(
    () => undefined,
  );
  const latest = Array.isArray(tabs)
    ? tabs
        .map(recordValue)
        .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
        .map((tab) => optionalString(tab.id))
        .find(Boolean)
    : undefined;
  if (latest) return latest;
  const id = `workflow-${workflow.id}-${randomUUID()}`;
  await invokeBrowserMethod("browser.create", { id, title: workflow.title });
  return id;
}

async function generateWorkflowFromCurrentAnnotations(
  options: BrowserWorkflowMcpToolProviderOptions,
  args: Record<string, unknown>,
): Promise<{
  annotations: BrowserWorkflowAnnotation[];
  saved: boolean;
  workflow: BrowserWorkflowDefinition;
}> {
  const result = recordValue(
    await options.invokeBrowserMethod("browser.listAnnotations", {
      id: optionalString(args.browserId) || optionalString(args.id),
    }),
  );
  const annotations = normalizeAnnotations(result.annotations);
  const workflow = workflowFromAnnotations({
    annotations,
    description: optionalString(args.description),
    id: optionalString(args.id),
    title: optionalString(args.title),
  });
  if (args.save === true) {
    return { annotations, saved: true, workflow: options.store.save(workflow) };
  }
  return { annotations, saved: false, workflow };
}

export function workflowFromAnnotations(input: {
  annotations: BrowserWorkflowAnnotation[];
  description?: string;
  id?: string;
  title?: string;
}): BrowserWorkflowDefinition {
  const annotations = input.annotations
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt);
  const title = input.title || annotations[0]?.note?.slice(0, 80) || "Annotated Browser Workflow";
  const id = safeWorkflowId(input.id) || safeWorkflowId(title) || `workflow_${Date.now()}`;
  const inputProperties: Record<string, unknown> = {};
  const requiredInputs = new Set<string>();
  const steps: BrowserWorkflowStep[] = [];
  let currentUrl = "";

  for (const annotation of annotations) {
    if (annotation.url && annotation.url !== currentUrl) {
      steps.push({ type: "navigate", url: annotation.url, waitUntil: "load" });
      currentUrl = annotation.url;
    }
    const step = workflowStepFromAnnotation(annotation, inputProperties, requiredInputs);
    if (step) steps.push(step);
  }

  return normalizeBrowserWorkflowDefinition({
    description:
      input.description ||
      `Generated from ${annotations.length} browser annotation${annotations.length === 1 ? "" : "s"}.`,
    enabled: true,
    id,
    inputSchema: {
      type: "object",
      properties: inputProperties,
      required: [...requiredInputs],
      additionalProperties: false,
    },
    requireConfirmation: true,
    sideEffect: true,
    steps,
    tags: ["annotated"],
    title,
    toolName: browserWorkflowToolName(id),
  });
}

function workflowStepFromAnnotation(
  annotation: BrowserWorkflowAnnotation,
  inputProperties: Record<string, unknown>,
  requiredInputs: Set<string>,
): BrowserWorkflowStep | null {
  const note = annotation.note || "";
  const lower = note.toLowerCase();
  const base = {
    note,
    rect: annotation.rect,
    selector: annotation.selector,
  };
  if (/\b(type|enter|fill|input)\b|输入|填写|填入/.test(lower)) {
    const placeholder =
      extractPlaceholder(note) ||
      safeWorkflowId(note).slice(0, 40) ||
      `value_${Object.keys(inputProperties).length + 1}`;
    inputProperties[placeholder] = {
      type: "string",
      description: note || `Value for ${annotation.selector || annotation.text || "field"}.`,
    };
    requiredInputs.add(placeholder);
    return {
      ...base,
      clearFirst: true,
      input: placeholder,
      type: "type",
    };
  }
  if (/\b(assert|verify|check|wait|expect)\b|检查|确认|等待|验证|校验/.test(lower)) {
    return {
      ...base,
      textContains: annotation.text || quotedText(note) || note,
      timeoutMs: 15_000,
      type: "waitFor",
    };
  }
  return {
    ...base,
    type: "click",
    waitAfterMs: 300,
  };
}

function workflowExecutionSchema(workflow: BrowserWorkflowDefinition): Record<string, unknown> {
  const schema = recordValue(workflow.inputSchema);
  const properties = {
    ...recordValue(schema.properties),
    browserId: { type: "string", description: "Optional Browser tab id. Defaults to latest tab." },
    confirmed: {
      type: "boolean",
      description: "Required for side-effecting workflows after explicit user confirmation.",
    },
    dryRun: { type: "boolean", description: "Preview rendered steps without executing them." },
  };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  if (workflow.requireConfirmation && !required.includes("confirmed")) required.push("confirmed");
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function workflowSaveSchema(): Record<string, unknown> {
  return objectSchema(
    {
      definition: {
        type: "object",
        description:
          "Workflow definition. You may also pass these fields at the top level. Steps support navigate, click, type, submit, waitFor, assert, and snapshot.",
        additionalProperties: true,
      },
      description: { type: "string" },
      enabled: { type: "boolean" },
      id: { type: "string" },
      inputSchema: { type: "object", additionalProperties: true },
      requireConfirmation: { type: "boolean" },
      sideEffect: { type: "boolean" },
      steps: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
      tags: { type: "array", items: { type: "string" } },
      title: { type: "string" },
      toolName: { type: "string" },
    },
    [],
  );
}

function clearBrowserElementExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    if ("value" in element) {
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      element.textContent = "";
    }
    return true;
  })()`;
}

function renderStepPreview(
  step: BrowserWorkflowStep,
  args: Record<string, unknown>,
): BrowserWorkflowStep {
  const context: Record<string, unknown> = {};
  return {
    ...step,
    text: step.text ? renderTemplate(step.text, args, context) : step.text,
    textContains: step.textContains
      ? renderTemplate(step.textContains, args, context)
      : step.textContains,
    url: step.url ? renderTemplate(step.url, args, context) : step.url,
    urlIncludes: step.urlIncludes
      ? renderTemplate(step.urlIncludes, args, context)
      : step.urlIncludes,
  };
}

function renderTemplate(
  template: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(args, key)) return stringifyInput(args[key]);
    if (Object.prototype.hasOwnProperty.call(context, key)) return stringifyInput(context[key]);
    return "";
  });
}

function compactSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    id: optionalString(snapshot.id),
    text: truncate(stringValue(snapshot.text), 4_000),
    title: optionalString(snapshot.title),
    url: optionalString(snapshot.url),
  };
}

function workflowSummary(workflow: BrowserWorkflowDefinition): Record<string, unknown> {
  return {
    id: workflow.id,
    title: workflow.title,
    toolName: workflow.toolName,
  };
}

function normalizeAnnotations(value: unknown): BrowserWorkflowAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.map(recordValue).map((annotation) => ({
    createdAt: finiteNumber(annotation.createdAt, Date.now()),
    id: stringValue(annotation.id),
    note: stringValue(annotation.note),
    rect: normalizeRect(annotation.rect),
    selector: optionalString(annotation.selector),
    text: optionalString(annotation.text),
    title: optionalString(annotation.title),
    type: annotation.type === "region" ? "region" : "element",
    url: optionalString(annotation.url),
  }));
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

function ok(tool: string, data: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, tool, ...data };
}

function requiredStepString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Browser workflow step requires ${field}.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Missing ${label}.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringifyInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  return JSON.stringify(value);
}

function finiteNumber(value: unknown, fallback = Number.NaN): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractPlaceholder(value: string): string {
  const match = value.match(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/);
  return match?.[1] ?? "";
}

function quotedText(value: string): string {
  const match = value.match(/["'“”‘’]([^"'“”‘’]{1,200})["'“”‘’]/);
  return match?.[1]?.trim() ?? "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[truncated]` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
