import type {
  AspMessagePart,
  AspMessageRecord,
  AspProvider,
  AspProviderSession,
  AspTokenUsage,
  AspToolEvent,
} from "@/asp/desktop-api";
import { t } from "@/lib/i18n";
import {
  claudeCodePayloadHasCliContext,
  claudeCodePayloadLabels,
  contextUsageFromSessionPayload,
  contextUsedTokensFromSessionPayload,
  contextWindowTokensForSessionPayload,
  isClaudeCodeProvider,
} from "./context-usage";
import type {
  ChatBlock,
  ContextUsage,
  DiffHunk,
  Attachment,
  InteractiveAppEmbed,
  Todo,
  ToolStatus,
  TokenUsage,
} from "./types";

type TranscriptProviderSession = AspProviderSession & {
  context?: {
    usedTokens?: number;
    windowTokens?: number;
    autoCompaction?: boolean;
  };
  usage?: AspTokenUsage;
};

type TranscriptMessageRecord = AspMessageRecord & {
  usage?: AspTokenUsage;
};

export type TranscriptSessionProjection = {
  blocks: ChatBlock[];
  contextUsage?: ContextUsage;
  providerSessionId?: string;
  sessionState?: Record<string, unknown>;
  title?: string;
  usage?: TokenUsage;
};

export function projectTranscriptSession(input: {
  messages: TranscriptMessageRecord[];
  previousContextUsage?: ContextUsage;
  providerId: string;
  providers: AspProvider[];
  session?: TranscriptProviderSession;
}): TranscriptSessionProjection {
  const blocks: ChatBlock[] = [];
  const projectedToolIds = new Set<string>();
  let nextOrder = 1;
  let latestUsage = input.session?.usage;

  const pushBlock = (block: ChatBlock, at?: number) => {
    const order = Math.max(nextOrder, finiteNumber(at) ?? 0);
    nextOrder = order + 1;
    blocks.push({ ...block, order });
  };

  for (const message of input.messages) {
    if (message.usage) latestUsage = message.usage;
    const at = finiteNumber(message.createdAt) ?? Date.now();
    if (message.role === "user") {
      pushBlock(
        {
          id: message.id,
          kind: "user",
          text: message.content || partsText(message.parts),
          attachments: transcriptAttachments(message.metadata),
          at,
        },
        at,
      );
      continue;
    }

    const before = blocks.length;
    for (const part of message.parts ?? []) {
      projectPart(part, pushBlock, projectedToolIds, at);
    }
    for (const tool of message.toolEvents ?? []) {
      if (projectedToolIds.has(tool.id)) continue;
      projectTool(tool, pushBlock, at);
      projectedToolIds.add(tool.id);
    }
    if (blocks.length === before && message.content.trim()) {
      pushBlock(
        {
          id: message.id,
          kind: "assistant",
          text: message.content,
          streaming: false,
          at,
        },
        at,
      );
    }
  }

  const sessionState = transcriptSessionState(input.session, latestUsage);
  const provider = input.providers.find((item) => item.id === input.providerId);
  const explicitContextUsed = contextUsedTokensFromSessionPayload(sessionState, {
    includePlainTokenFields: false,
  });
  const hasExplicitContextUsed =
    explicitContextUsed !== undefined || latestUsage?.contextTokens !== undefined;
  const isClaudeCode = isClaudeCodeProvider(
    provider,
    input.providerId,
    ...claudeCodePayloadLabels(sessionState),
  );
  const hasCliContext = !isClaudeCode || claudeCodePayloadHasCliContext(sessionState);
  const fallbackWindow = contextWindowTokensForSessionPayload(
    sessionState,
    input.providerId,
    input.providers,
    input.session?.model,
  );
  const projectedContextUsage = hasCliContext
    ? contextUsageFromSessionPayload(
        sessionState,
        isClaudeCode && !hasExplicitContextUsed ? undefined : input.previousContextUsage,
        isClaudeCode ? undefined : fallbackWindow,
        latestUsage?.contextTokens ?? (isClaudeCode ? undefined : latestUsage?.totalTokens),
        { includePlainTokenFields: !isClaudeCode },
      )
    : undefined;
  const contextUsage =
    isClaudeCode && projectedContextUsage
      ? { ...projectedContextUsage, source: "claude-code-cli" }
      : projectedContextUsage;

  return {
    blocks: blocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    contextUsage,
    providerSessionId: input.session?.id,
    sessionState,
    title: input.session?.title,
    usage: tokenUsage(latestUsage),
  };
}

function projectPart(
  part: AspMessagePart,
  pushBlock: (block: ChatBlock, at?: number) => void,
  projectedToolIds: Set<string>,
  at: number,
): void {
  switch (part.type) {
    case "text":
      if (!part.content.trim()) return;
      pushBlock(
        {
          id: part.id,
          kind: "assistant",
          text: part.content,
          streaming: false,
          at,
        },
        at,
      );
      return;
    case "reasoning":
      if (!part.content?.trim()) return;
      pushBlock(
        {
          id: part.id,
          kind: "reasoning",
          text: part.content,
          streaming: false,
        },
        at,
      );
      return;
    case "plan":
      pushBlock(
        {
          id: part.id,
          kind: "plan",
          todos: planTodos(part),
        },
        at,
      );
      return;
    case "tool":
      projectTool(part.toolEvent, pushBlock, at);
      projectedToolIds.add(part.toolEvent.id);
      return;
    case "diff":
      pushBlock(
        {
          id: part.id,
          kind: "diff",
          path: part.path || part.oldPath || part.title || t("diff.changes"),
          hunks: parseUnifiedDiff(part.content),
          status: "success",
          review: "accepted",
        },
        at,
      );
      return;
    case "status":
    case "citation": {
      const text =
        part.type === "citation" && part.uri
          ? `[${part.content || part.uri}](${part.uri})`
          : part.content;
      if (!text?.trim()) return;
      pushBlock(
        {
          id: part.id,
          kind: "assistant",
          text,
          streaming: false,
          at,
        },
        at,
      );
      return;
    }
    case "resource":
      pushBlock(
        {
          id: part.id,
          kind: "resource",
          title: part.title,
          name: part.name,
          uri: part.uri,
          path: part.path,
          mimeType: part.mimeType,
          content: part.content,
          app: interactiveAppFromPart(part),
          metadata: part.metadata,
        },
        at,
      );
      return;
    case "artifact":
      pushBlock(
        {
          id: part.id,
          kind: "artifact",
          artifactId: part.artifactId,
          title: part.title,
          name: part.name,
          uri: part.uri,
          path: part.path,
          mimeType: part.mimeType,
          content: part.content,
          app: interactiveAppFromPart(part),
          metadata: part.metadata,
        },
        at,
      );
      return;
    case "raw":
      pushBlock(
        {
          id: part.id,
          kind: "raw",
          label: part.label,
          value: part.value,
          metadata: part.metadata,
        },
        at,
      );
      return;
  }
}

function projectTool(
  tool: AspToolEvent,
  pushBlock: (block: ChatBlock, at?: number) => void,
  at: number,
): void {
  pushBlock(
    {
      id: tool.id,
      kind: "tool",
      title: tool.name,
      toolKind: tool.kind,
      output: tool.output ?? "",
      rawInput: tool.input,
      rawOutput: tool.error,
      locations: toolLocations(tool),
      status: toolStatus(tool),
    },
    at,
  );
  const diff = tool.semantic?.diff;
  if (diff?.type === "diff") {
    pushBlock(
      {
        id: `${tool.id}-diff`,
        kind: "diff",
        path: diff.path || diff.oldPath || diff.title || tool.name,
        hunks: parseUnifiedDiff(diff.content),
        status: toolStatus(tool) === "error" ? "error" : "success",
        review: "accepted",
      },
      at,
    );
  }
  for (const artifact of tool.semantic?.artifacts ?? []) {
    if (artifact.type === "resource" || artifact.type === "artifact") {
      projectPart(artifact, pushBlock, new Set(), at);
    }
  }
  for (const child of tool.children ?? []) projectTool(child, pushBlock, at);
}

function transcriptSessionState(
  session: TranscriptProviderSession | undefined,
  usage: AspTokenUsage | undefined,
): Record<string, unknown> {
  if (!session) return usage ? { usage } : {};
  return {
    providerSessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    model: session.model,
    context: session.context,
    usage,
    metadata: session.metadata,
  };
}

function tokenUsage(usage: AspTokenUsage | undefined): TokenUsage | undefined {
  return usage ? { input: usage.inputTokens, output: usage.outputTokens } : undefined;
}

function planTodos(part: Extract<AspMessagePart, { type: "plan" }>): Todo[] {
  const items = part.items?.length
    ? part.items
    : (part.content ?? "")
        .split(/\r?\n/)
        .map((item) => item.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
  return items.map((item) => {
    const match = /^\[(pending|in_progress|completed|done|todo|doing)\]\s*(.*)$/i.exec(item);
    const rawStatus = match?.[1]?.toLowerCase();
    return {
      content: (match?.[2] || item).trim(),
      status:
        rawStatus === "completed" || rawStatus === "done"
          ? "completed"
          : rawStatus === "in_progress" || rawStatus === "doing"
            ? "in_progress"
            : "pending",
    };
  });
}

function toolStatus(tool: AspToolEvent): ToolStatus {
  const status = (tool.status ?? "").toLowerCase();
  if (tool.error || ["error", "failed", "failure", "denied"].includes(status)) return "error";
  if (tool.phase === "completed" || ["success", "completed", "done", "finished"].includes(status)) {
    return "success";
  }
  return "running";
}

function toolLocations(
  tool: AspToolEvent,
): Array<{ path: string; line?: number | null }> | undefined {
  const metadata = tool.metadata ?? {};
  const raw = metadata.locations;
  if (Array.isArray(raw)) {
    const locations = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as Record<string, unknown>;
      return typeof source.path === "string"
        ? [
            {
              path: source.path,
              line: typeof source.line === "number" ? source.line : undefined,
            },
          ]
        : [];
    });
    if (locations.length) return locations;
  }
  const path = metadata.path;
  return typeof path === "string" ? [{ path }] : undefined;
}

function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) current.lines.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ type: "del", text: line.slice(1) });
    else current.lines.push({ type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return hunks.length
    ? hunks
    : [
        {
          oldStart: 1,
          newStart: 1,
          lines: diff.split(/\r?\n/).map((text) => ({ type: "ctx", text })),
        },
      ];
}

function interactiveAppFromPart(
  part: Extract<AspMessagePart, { type: "resource" | "artifact" }>,
): InteractiveAppEmbed | undefined {
  const app = part.app ?? metadataInteractiveApp(part.metadata);
  if (!app) return undefined;
  const html = stringPayload(app.html) || htmlContentForApp(part.content, part.mimeType);
  return {
    ...app,
    ...(html ? { html } : {}),
    renderer: "mcp-app",
  };
}

function metadataInteractiveApp(
  metadata: Record<string, unknown> | undefined,
): Partial<InteractiveAppEmbed> | undefined {
  const app = metadata?.app;
  return app && typeof app === "object" && !Array.isArray(app)
    ? (app as Partial<InteractiveAppEmbed>)
    : undefined;
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

function partsText(parts: AspMessagePart[] | undefined): string {
  return (parts ?? [])
    .map((part) => ("content" in part ? (part.content ?? "") : ""))
    .filter(Boolean)
    .join("");
}

function transcriptAttachments(
  metadata: Record<string, unknown> | undefined,
): Attachment[] | undefined {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) return undefined;
  const attachments = raw.flatMap((item): Attachment[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const path = stringPayload(source.path);
    const url = stringPayload(source.url);
    if (!path && !url) return [];
    const name =
      stringPayload(source.name) || (path ? path.split(/[\\/]/).pop() || "Image" : "Image");
    return [
      {
        id: stringPayload(source.id) || `${path || url}`,
        kind: source.kind === "file" ? "file" : "image",
        name,
        ...(path ? { path } : {}),
        ...(url ? { url } : {}),
        ...(stringPayload(source.mime) ? { mime: stringPayload(source.mime) } : {}),
        ...(typeof source.size === "number" ? { size: source.size } : {}),
      },
    ];
  });
  return attachments.length ? attachments : undefined;
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
