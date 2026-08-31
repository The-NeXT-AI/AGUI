import { useMemo, type ReactNode } from "react";
import type { ExtensionDeclarativeNode } from "@/asp/desktop-api";
import { cn } from "@/ui/cn";
import { backendExtensionHost } from "./extension-backend-host";

const MAX_DECLARATIVE_NODES = 200;
const MAX_DECLARATIVE_DEPTH = 10;

type RenderBudget = {
  count: number;
};

type DeclarativeRenderContext = {
  extensionId: string;
  data: unknown;
  allowNetwork: boolean;
  executeCommand?: (command: string, args: unknown[]) => unknown | Promise<unknown>;
  budget: RenderBudget;
};

export function DeclarativeExtensionView({
  extensionId,
  schema,
  data,
  allowNetwork,
  compact = false,
  className,
  executeCommand,
}: {
  extensionId: string;
  schema: ExtensionDeclarativeNode;
  data?: unknown;
  allowNetwork: boolean;
  compact?: boolean;
  className?: string;
  executeCommand?: (command: string, args: unknown[]) => unknown | Promise<unknown>;
}) {
  const content = useMemo(
    () =>
      renderDeclarativeNode(schemaRoot(schema), {
        extensionId,
        data,
        allowNetwork,
        executeCommand,
        budget: { count: 0 },
      }),
    [allowNetwork, data, executeCommand, extensionId, schema],
  );
  return (
    <div
      data-extension-id={extensionId}
      data-extension-isolation="host-declarative"
      className={cn(
        "text-fg min-w-0 text-[13px]",
        compact ? "max-h-8 overflow-hidden" : "h-full min-h-0 overflow-auto",
        className,
      )}
    >
      {content}
    </div>
  );
}

export function parseDeclarativeSchema(source: string): ExtensionDeclarativeNode {
  const parsed = JSON.parse(source) as unknown;
  return schemaRoot(parsed);
}

function renderDeclarativeNode(
  node: ExtensionDeclarativeNode,
  context: DeclarativeRenderContext,
  depth = 0,
  key = "root",
): ReactNode {
  if (depth > MAX_DECLARATIVE_DEPTH) return null;
  if (context.budget.count++ > MAX_DECLARATIVE_NODES) return null;
  if (node == null || node === false) return null;
  if (Array.isArray(node)) {
    return (
      <div key={key} className="flex min-w-0 flex-col gap-1.5">
        {node.map((item, index) =>
          renderDeclarativeNode(item, context, depth + 1, `${key}:${index}`),
        )}
      </div>
    );
  }
  if (typeof node !== "object") {
    return <span key={key}>{interpolate(String(node), context.data)}</span>;
  }

  const item = node as unknown as Record<string, unknown>;
  const type = stringValue(item.type) || "text";
  if (type === "text") return renderText(item, context, key);
  if (type === "badge") return renderBadge(item, context, key);
  if (type === "button") return renderButton(item, context, key);
  if (type === "link") return renderLink(item, context, key);
  if (type === "image") return renderImage(item, context, key);
  if (type === "code") return renderCode(item, context, key);
  if (type === "divider") return <hr key={key} className="border-border-subtle my-2" />;
  if (type === "kv") return renderKeyValue(item, context, key);
  if (type === "list") return renderList(item, context, depth, key);
  if (type === "data") return renderData(item, context, key);
  if (type === "row") return renderContainer(item, context, depth, key, "row");
  if (type === "column" || type === "stack" || type === "container" || type === "box") {
    return renderContainer(item, context, depth, key, type);
  }
  return renderText(item, context, key);
}

function renderText(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  const value = textFromItem(item, context);
  return (
    <span
      key={key}
      className={cn(
        "min-w-0 break-words whitespace-pre-wrap",
        toneClass(item.tone),
        textSizeClass(item.size),
        weightClass(item.weight),
      )}
    >
      {value}
    </span>
  );
}

function renderBadge(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  return (
    <span
      key={key}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-[6px] border px-1.5 py-0.5 text-[11px] font-medium",
        badgeToneClass(item.tone),
      )}
    >
      <span className="truncate">{textFromItem(item, context)}</span>
    </span>
  );
}

function renderButton(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  const command = stringValue(item.command);
  const args = Array.isArray(item.args) ? item.args : [];
  const safeCommand = context.executeCommand
    ? Boolean(command)
    : commandAllowed(context.extensionId, command);
  const execute =
    context.executeCommand ??
    ((nextCommand: string, nextArgs: unknown[]) =>
      backendExtensionHost.executeCommand(context.extensionId, nextCommand, nextArgs));
  return (
    <button
      key={key}
      type="button"
      disabled={!safeCommand}
      title={safeCommand ? undefined : "Declarative UI buttons can only call this extension."}
      onClick={() => {
        if (!safeCommand) return;
        void Promise.resolve(execute(command, args)).catch((error) => {
          console.warn(
            `Declarative extension command failed: ${context.extensionId}:${command}`,
            error,
          );
        });
      }}
      className={cn(
        "inline-flex h-7 max-w-full items-center justify-center rounded-[7px] px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        buttonVariantClass(item.variant),
      )}
    >
      <span className="truncate">{textFromItem(item, context)}</span>
    </button>
  );
}

function renderLink(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  const href = safeUrl(stringValue(item.href), context.allowNetwork, "link");
  if (!href) return renderText(item, context, key);
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent hover:text-accent/80 min-w-0 truncate underline-offset-2 hover:underline"
    >
      {textFromItem(item, context) || href}
    </a>
  );
}

function renderImage(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  const src = safeUrl(stringValue(item.src), context.allowNetwork, "image");
  if (!src) return null;
  return (
    <img
      key={key}
      src={src}
      alt={boundedText(stringValue(item.alt), 160)}
      className="border-border-subtle bg-surface max-h-48 max-w-full rounded-[6px] border object-contain"
      loading="lazy"
      decoding="async"
    />
  );
}

function renderCode(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  return (
    <pre
      key={key}
      className="border-border-subtle bg-surface text-fg max-w-full overflow-auto rounded-[6px] border px-2 py-1.5 font-mono text-[12px]"
    >
      <code>{textFromItem(item, context)}</code>
    </pre>
  );
}

function renderKeyValue(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  return (
    <div key={key} className="grid min-w-0 grid-cols-[minmax(80px,0.42fr)_1fr] gap-2 text-[12px]">
      <span className="text-muted min-w-0 truncate">
        {interpolate(stringValue(item.label), context.data)}
      </span>
      <span className="text-fg min-w-0 break-words">{textFromItem(item, context)}</span>
    </div>
  );
}

function renderList(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  depth: number,
  key: string,
): ReactNode {
  const items = childrenFrom(item.items).slice(0, 50);
  const ordered = item.ordered === true;
  const ListTag = ordered ? "ol" : "ul";
  return (
    <ListTag
      key={key}
      className={cn("min-w-0 space-y-1 pl-5 text-[13px]", ordered ? "list-decimal" : "list-disc")}
    >
      {items.map((child, index) => (
        <li key={`${key}:item:${index}`} className="min-w-0 break-words">
          {renderDeclarativeNode(child, context, depth + 1, `${key}:${index}`)}
        </li>
      ))}
    </ListTag>
  );
}

function renderData(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  key: string,
): ReactNode {
  const value = valueForItem(item, context);
  return (
    <span key={key} className={cn("min-w-0 break-words", toneClass(item.tone))}>
      {displayValue(value, stringValue(item.fallback))}
    </span>
  );
}

function renderContainer(
  item: Record<string, unknown>,
  context: DeclarativeRenderContext,
  depth: number,
  key: string,
  type: string,
): ReactNode {
  const children = childrenFrom(item.children);
  const isRow = type === "row";
  return (
    <div
      key={key}
      className={cn(
        "min-w-0",
        isRow ? "flex items-center" : "flex flex-col",
        alignClass(item.align, isRow),
        gapClass(item.gap),
        paddingClass(item.padding),
        item.wrap === true && "flex-wrap",
        type === "box" && "border-border-subtle bg-surface/60 rounded-[8px] border",
      )}
    >
      {children.map((child, index) =>
        renderDeclarativeNode(child, context, depth + 1, `${key}:child:${index}`),
      )}
    </div>
  );
}

function schemaRoot(value: unknown): ExtensionDeclarativeNode {
  if (Array.isArray(value)) return value as ExtensionDeclarativeNode[];
  const source = recordValue(value);
  if (typeof source.type === "string") return source as unknown as ExtensionDeclarativeNode;
  if (Array.isArray(source.body))
    return { type: "column", children: source.body as ExtensionDeclarativeNode[] };
  if (Array.isArray(source.children))
    return { type: "column", children: source.children as ExtensionDeclarativeNode[] };
  if (source.schema !== undefined) return schemaRoot(source.schema);
  return value as ExtensionDeclarativeNode;
}

function textFromItem(item: Record<string, unknown>, context: DeclarativeRenderContext): string {
  const explicit =
    item.text !== undefined ? item.text : item.label !== undefined ? item.label : item.value;
  if (explicit !== undefined) return interpolate(displayValue(explicit), context.data);
  return displayValue(valueForItem(item, context), stringValue(item.fallback));
}

function valueForItem(item: Record<string, unknown>, context: DeclarativeRenderContext): unknown {
  const path = stringValue(item.path);
  if (!path) return item.value;
  const value = valueAtPath(context.data, path);
  return value === undefined ? item.fallback : value;
}

function interpolate(value: string, data: unknown): string {
  return boundedText(
    value.replace(/\{\{\s*([a-zA-Z0-9_.-]{1,200})\s*\}\}/g, (_match, path: string) =>
      displayValue(valueAtPath(data, path)),
    ),
    32 * 1024,
  );
}

function valueAtPath(source: unknown, path: string): unknown {
  if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(path)) return undefined;
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (!part) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    const record = recordValue(current);
    if (!(part in record)) return undefined;
    current = record[part];
  }
  return current;
}

function displayValue(value: unknown, fallback = ""): string {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") return boundedText(value, 32 * 1024);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return boundedText(JSON.stringify(value, null, 2), 32 * 1024);
  } catch {
    return fallback;
  }
}

function childrenFrom(value: unknown): ExtensionDeclarativeNode[] {
  return Array.isArray(value) ? (value as ExtensionDeclarativeNode[]) : [];
}

function commandAllowed(extensionId: string, command: string): boolean {
  return Boolean(
    command && (command.startsWith(`${extensionId}.`) || command.startsWith(`${extensionId}/`)),
  );
}

function safeUrl(value: string, allowNetwork: boolean, kind: "image" | "link"): string {
  if (!value) return "";
  if (kind === "image" && value.startsWith("data:image/")) return value;
  if (kind === "link" && value.startsWith("#")) return value;
  try {
    const parsed = new URL(value);
    if (allowNetwork && parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return "";
  }
  return "";
}

function toneClass(value: unknown): string {
  if (value === "muted") return "text-muted";
  if (value === "accent") return "text-accent";
  if (value === "success") return "text-success";
  if (value === "warning") return "text-warning";
  if (value === "danger") return "text-danger";
  return "text-fg";
}

function badgeToneClass(value: unknown): string {
  if (value === "accent") return "border-accent/30 bg-accent/10 text-accent";
  if (value === "success") return "border-success/30 bg-success/10 text-success";
  if (value === "warning") return "border-warning/30 bg-warning/10 text-warning";
  if (value === "danger") return "border-danger/30 bg-danger/10 text-danger";
  return "ui-badge";
}

function textSizeClass(value: unknown): string {
  if (value === "xs") return "text-[11px]";
  if (value === "md") return "text-[14px]";
  return "text-[13px]";
}

function weightClass(value: unknown): string {
  if (value === "semibold") return "font-semibold";
  if (value === "medium") return "font-medium";
  return "font-normal";
}

function buttonVariantClass(value: unknown): string {
  if (value === "ghost") return "text-muted hover:bg-surface-hover hover:text-fg";
  if (value === "danger") return "bg-danger text-white hover:bg-danger/90";
  if (value === "secondary")
    return "border-border-subtle bg-surface hover:bg-surface-hover border text-fg";
  return "bg-accent text-white hover:bg-accent/90";
}

function gapClass(value: unknown): string {
  if (value === "none") return "gap-0";
  if (value === "xs") return "gap-1";
  if (value === "md") return "gap-3";
  return "gap-2";
}

function paddingClass(value: unknown): string {
  if (value === "none") return "p-0";
  if (value === "xs") return "p-1";
  if (value === "md") return "p-3";
  return "p-2";
}

function alignClass(value: unknown, row: boolean): string {
  if (row) {
    if (value === "center") return "items-center";
    if (value === "end") return "items-end";
    return "items-start";
  }
  if (value === "center") return "items-center";
  if (value === "end") return "items-end";
  return "items-stretch";
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? boundedText(value.trim(), 32 * 1024) : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
