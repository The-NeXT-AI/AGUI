import type { ChatBlock, InteractiveAppEmbed, SessionEvent } from "./types";

const INTERNAL_RAW_EXTENSION_LABELS = [
  "asp.ext.session-state:",
  "asp.ext.run-control:",
  "asp.ext.agents:",
  "asp.ext.hooks:",
  "asp.ext.permissions:",
  "asp.ext.runtime:",
];

export function isInternalProtocolRawBlock(block: ChatBlock): boolean {
  return (
    block.kind === "raw" &&
    typeof block.label === "string" &&
    INTERNAL_RAW_EXTENSION_LABELS.some((prefix) => block.label?.startsWith(prefix))
  );
}

export function isEmptyReasoningToolBlock(block: ChatBlock): boolean {
  if (block.kind !== "tool") return false;
  const kind = block.toolKind?.trim().toLowerCase();
  const title = block.title.trim().toLowerCase();
  const isReasoning = kind === "reasoning" || kind === "thinking" || title === "reasoning";
  return (
    isReasoning &&
    !block.output?.trim() &&
    block.rawInput == null &&
    block.rawOutput == null &&
    !block.locations?.length
  );
}

export function isEmptyAssistantBlock(block: ChatBlock): boolean {
  return block.kind === "assistant" && !block.text.trim();
}

export function isEmptyReasoningBlock(block: ChatBlock): boolean {
  return block.kind === "reasoning" && !block.text.trim();
}

/**
 * Reduces a normalized ASP event into the rendering model. Starts are
 * intentionally idempotent because some agents repeat full tool state.
 */
export function reduceEvent(
  blocks: ChatBlock[],
  event: SessionEvent,
  autoAccept = true,
): ChatBlock[] {
  switch (event.type) {
    case "user_message":
      return insertBlock(
        blocks,
        withOrder(event, {
          id: event.id,
          kind: "user",
          text: event.text,
          attachments: event.attachments,
          at: event.at,
          agentParticipantId: event.agentParticipantId,
          agentProviderId: event.agentProviderId,
          runId: event.runId,
          workItemId: event.workItemId,
        }),
      );
    case "reasoning_start":
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, { id: event.blockId, kind: "reasoning", text: "", streaming: true }),
        (block) => (block.kind === "reasoning" ? { ...block, streaming: true } : block),
      );
    case "reasoning_delta":
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, {
          id: event.blockId,
          kind: "reasoning",
          text: event.text,
          streaming: true,
        }),
        (block) =>
          block.kind === "reasoning" ? { ...block, text: block.text + event.text } : block,
      );
    case "reasoning_end":
      return patch(blocks, event.blockId, (block) =>
        block.kind === "reasoning" ? { ...block, streaming: false } : block,
      );
    case "assistant_start":
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, {
          id: event.blockId,
          kind: "assistant",
          text: "",
          streaming: true,
          at: event.at,
        }),
        (block) =>
          block.kind === "assistant"
            ? { ...block, streaming: true, at: block.at ?? event.at }
            : block,
      );
    case "assistant_delta":
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, {
          id: event.blockId,
          kind: "assistant",
          text: event.text,
          streaming: true,
          at: event.at,
        }),
        (block) =>
          block.kind === "assistant" ? { ...block, text: block.text + event.text } : block,
      );
    case "assistant_end":
      return patch(blocks, event.blockId, (block) =>
        block.kind === "assistant" ? { ...block, streaming: false, at: event.at } : block,
      );
    case "plan_update":
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, { id: event.blockId, kind: "plan", todos: event.todos }),
        (block) => (block.kind === "plan" ? { ...block, todos: event.todos } : block),
      );
    case "tool_start":
      return upsert(
        blocks,
        event.toolId,
        withOrder(event, {
          id: event.toolId,
          kind: "tool",
          title: event.title,
          toolKind: event.toolKind,
          output: event.output ?? "",
          rawInput: event.rawInput,
          locations: event.locations,
          status: event.status,
        }),
        (block) =>
          block.kind === "tool"
            ? {
                ...block,
                title: event.title,
                toolKind: event.toolKind ?? block.toolKind,
                output: event.output ?? block.output,
                rawInput: event.rawInput ?? block.rawInput,
                locations: event.locations ?? block.locations,
                status: event.status,
              }
            : block,
      );
    case "tool_update":
      return patch(blocks, event.toolId, (block) =>
        block.kind === "tool"
          ? {
              ...block,
              title: event.title ?? block.title,
              status: event.status ?? block.status,
              output: event.output ?? block.output,
              rawOutput: event.rawOutput ?? block.rawOutput,
              locations: event.locations ?? block.locations,
            }
          : block,
      );
    case "tool_start_terminal":
      return upsert(
        blocks,
        event.toolId,
        withOrder(event, {
          id: event.toolId,
          kind: "terminal",
          terminalId: event.terminalId,
          command: event.command,
          cwd: event.cwd,
          output: event.output ?? "",
          status: "running",
          streaming: true,
        }),
        (block) =>
          block.kind === "terminal"
            ? {
                ...block,
                command: event.command || block.command,
                cwd: event.cwd ?? block.cwd,
                output: event.output ?? block.output,
                streaming: true,
              }
            : block,
      );
    case "tool_start_diff":
      return upsert(
        blocks,
        event.toolId,
        withOrder(event, {
          id: event.toolId,
          kind: "diff",
          path: event.path,
          hunks: event.hunks,
          status: "running",
          review: event.review ?? (autoAccept ? "accepted" : "pending"),
        }),
        (block) =>
          block.kind === "diff" ? { ...block, path: event.path, hunks: event.hunks } : block,
      );
    case "tool_delta":
      return patch(blocks, event.toolId, (block) =>
        block.kind === "terminal"
          ? { ...block, output: block.output + event.chunk }
          : block.kind === "tool"
            ? { ...block, output: block.output + event.chunk }
            : block,
      );
    case "tool_end":
      return patch(blocks, event.toolId, (block) => {
        if (block.kind === "terminal") {
          return { ...block, status: event.status, streaming: false };
        }
        if (block.kind === "diff" || block.kind === "tool") {
          return { ...block, status: event.status };
        }
        return block;
      });
    case "image":
      return insertBlock(
        blocks,
        withOrder(event, {
          id: event.blockId,
          kind: "image",
          urls: event.urls,
          prompt: event.prompt,
        }),
      );
    case "resource": {
      const app =
        event.app ?? interactiveAppFromEvent(event.metadata, event.content, event.mimeType);
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, {
          id: event.blockId,
          kind: "resource",
          title: event.title,
          name: event.name,
          uri: event.uri,
          path: event.path,
          mimeType: event.mimeType,
          content: event.content,
          app,
          metadata: event.metadata,
        }),
        (block) =>
          block.kind === "resource"
            ? {
                ...block,
                title: event.title ?? block.title,
                name: event.name ?? block.name,
                uri: event.uri ?? block.uri,
                path: event.path ?? block.path,
                mimeType: event.mimeType ?? block.mimeType,
                content: event.content ?? block.content,
                app: app ?? block.app,
                metadata: event.metadata ?? block.metadata,
              }
            : block,
      );
    }
    case "artifact": {
      const app =
        event.app ?? interactiveAppFromEvent(event.metadata, event.content, event.mimeType);
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, {
          id: event.blockId,
          kind: "artifact",
          artifactId: event.artifactId,
          title: event.title,
          name: event.name,
          uri: event.uri,
          path: event.path,
          mimeType: event.mimeType,
          content: event.content,
          app,
          metadata: event.metadata,
        }),
        (block) =>
          block.kind === "artifact"
            ? {
                ...block,
                artifactId: event.artifactId ?? block.artifactId,
                title: event.title ?? block.title,
                name: event.name ?? block.name,
                uri: event.uri ?? block.uri,
                path: event.path ?? block.path,
                mimeType: event.mimeType ?? block.mimeType,
                content: event.content ?? block.content,
                app: app ?? block.app,
                metadata: event.metadata ?? block.metadata,
              }
            : block,
      );
    }
    case "raw":
      return upsert(
        blocks,
        event.blockId,
        withOrder(event, {
          id: event.blockId,
          kind: "raw",
          label: event.label,
          value: event.value,
          metadata: event.metadata,
        }),
        (block) =>
          block.kind === "raw"
            ? {
                ...block,
                label: event.label ?? block.label,
                value: event.value,
                metadata: event.metadata ?? block.metadata,
              }
            : block,
      );
    case "error":
      return insertBlock(
        blocks,
        withOrder(event, { id: event.id, kind: "error", message: event.message }),
      );
    case "turn_complete":
      return blocks;
  }
}

function patch(
  blocks: ChatBlock[],
  id: string,
  update: (block: ChatBlock) => ChatBlock,
): ChatBlock[] {
  const index = blocks.findIndex((block) => block.id === id);
  if (index === -1) return blocks;
  const next = update(blocks[index]!);
  if (next === blocks[index]) return blocks;
  const updated = blocks.slice();
  updated[index] = next;
  return updated;
}

function upsert(
  blocks: ChatBlock[],
  id: string,
  initial: ChatBlock,
  update: (block: ChatBlock) => ChatBlock,
): ChatBlock[] {
  const initialOrder = blockOrder(initial);
  const index = blocks.findIndex((block) => block.id === id);
  if (index === -1) return insertBlock(blocks, initial);
  const next = update(blocks[index]!);
  const ordered =
    blockOrder(next) === undefined && initialOrder !== undefined
      ? { ...next, order: initialOrder }
      : next;
  if (ordered === blocks[index]) return blocks;
  const updated = blocks.slice();
  updated[index] = ordered;
  return updated;
}

function insertBlock(blocks: ChatBlock[], initial: ChatBlock): ChatBlock[] {
  const order = blockOrder(initial);
  if (order === undefined) return [...blocks, initial];
  const index = blocks.findIndex((block) => {
    const existing = blockOrder(block);
    return existing !== undefined && existing > order;
  });
  return index === -1
    ? [...blocks, initial]
    : [...blocks.slice(0, index), initial, ...blocks.slice(index)];
}

function withOrder<T extends ChatBlock>(event: SessionEvent, block: T): T {
  const order = eventOrder(event);
  return order === undefined ? block : { ...block, order };
}

function eventOrder(event: SessionEvent): number | undefined {
  if (typeof event.order === "number" && Number.isFinite(event.order)) return event.order;
  return typeof event.at === "number" && Number.isFinite(event.at) ? event.at : undefined;
}

export function blockOrder(block: ChatBlock): number | undefined {
  if (typeof block.order === "number" && Number.isFinite(block.order)) return block.order;
  return "at" in block && typeof block.at === "number" && Number.isFinite(block.at)
    ? block.at
    : undefined;
}

function interactiveAppFromEvent(
  metadata: Record<string, unknown> | undefined,
  content: string | undefined,
  mimeType: string | undefined,
): InteractiveAppEmbed | undefined {
  const app = recordPayload(recordPayload(metadata).app);
  if (!Object.keys(app).length) return undefined;
  const html = stringPayload(app.html) || htmlContentForApp(content, mimeType);
  return {
    ...(app as Partial<InteractiveAppEmbed>),
    ...(html ? { html } : {}),
    renderer: "mcp-app",
  };
}

function htmlContentForApp(
  content: string | undefined,
  mimeType: string | undefined,
): string | undefined {
  const html = stringPayload(content);
  if (!html) return undefined;
  if (stringPayload(mimeType).toLowerCase().includes("html")) return html;
  return /^\s*<!doctype\s+html\b|^\s*<html[\s>]/i.test(html) ? html : undefined;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
