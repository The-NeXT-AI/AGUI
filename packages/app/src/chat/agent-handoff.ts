import type {
  AspConversationArtifact,
  AspConversationContext,
  AspConversationFile,
  AspConversationContextMessage,
} from "@/asp/desktop-api";
import type { ChatBlock, Session } from "./types";

export const AGENT_HANDOFF_MAX_BLOCKS = 16;
export const AGENT_HANDOFF_MAX_CHARS = 12_000;
const AGENT_HANDOFF_CONTENT_BUDGET = AGENT_HANDOFF_MAX_CHARS - 256;
const AGENT_HANDOFF_MESSAGE_MAX_CHARS = 5_000;

type HandoffAttachment = {
  kind: "image" | "file";
  mimeType?: string;
  name: string;
  path?: string;
  size?: number;
};

export type AgentHandoffEntry = {
  attachments?: HandoffAttachment[];
  content: string;
  id: string;
  seq: number;
  role: "user" | "assistant";
  agent?: string;
  participantId?: string;
  truncated?: boolean;
};

export type AgentHandoffSelection = {
  artifacts: AspConversationArtifact[];
  entries: AgentHandoffEntry[];
  files: AspConversationFile[];
  highWatermarkSeq: number;
  omittedCount: number;
  omittedSummary?: string;
  serialized: string;
  sourceSeq: number;
  truncated: boolean;
};

type ContextItem =
  | { kind: "message"; value: AgentHandoffEntry }
  | { kind: "artifact"; value: AspConversationArtifact };

export function selectAgentHandoff(
  session: Session,
  providerId: string,
  options: {
    excludeLastUser: boolean;
    providerNames?: ReadonlyMap<string, string>;
  },
): AgentHandoffSelection | null {
  const route = session.agentSessions?.[providerId];
  if (session.providerId === providerId && session.providerSessionId && !route) return null;
  if (
    route?.providerSessionId &&
    !route.status &&
    !route.lastSyncedBlockId &&
    route.seenThroughSeq === undefined
  ) {
    return null;
  }

  const sourceSeq = agentSeenThroughSeq(session, providerId);
  const endSeq = options.excludeLastUser
    ? lastUserSequence(session.blocks)
    : Number.MAX_SAFE_INTEGER;
  const eligible = session.blocks
    .map((block, index) => ({ block, seq: blockSequence(block, index) }))
    .filter(({ seq }) => seq > sourceSeq && seq < endSeq);
  if (!eligible.length) return null;
  const files = collectHandoffFiles(eligible, session.cwd);

  const groups: ContextItem[][] = [];
  for (const { block, seq } of eligible) {
    if (block.kind === "user" || !groups.length) groups.push([]);
    const item = contextItem(block, seq, session.cwd, options.providerNames);
    if (item) groups[groups.length - 1].push(item);
  }
  const nonEmptyGroups = groups.filter((group) => group.length);
  if (!nonEmptyGroups.length) return null;

  let selected: ContextItem[] = [];
  let omittedCount = 0;
  for (let index = nonEmptyGroups.length - 1; index >= 0; index -= 1) {
    const group = nonEmptyGroups[index];
    if (selected.length + group.length > AGENT_HANDOFF_MAX_BLOCKS) {
      if (!selected.length) {
        const fitted = fitLatestGroup(group);
        selected = fitted.items;
        omittedCount += fitted.omittedCount + nonEmptyGroups.slice(0, index).flat().length;
      } else {
        omittedCount += nonEmptyGroups.slice(0, index + 1).flat().length;
      }
      break;
    }
    const candidate = [...group, ...selected];
    if (serializedItems(candidate).length <= AGENT_HANDOFF_CONTENT_BUDGET) {
      selected = candidate;
      continue;
    }
    if (!selected.length) {
      const fitted = fitLatestGroup(group);
      selected = fitted.items;
      omittedCount += fitted.omittedCount + nonEmptyGroups.slice(0, index).flat().length;
    } else {
      omittedCount += nonEmptyGroups.slice(0, index + 1).flat().length;
    }
    break;
  }

  if (!selected.length) {
    const latest = nonEmptyGroups[nonEmptyGroups.length - 1];
    const fitted = fitLatestGroup(latest);
    selected = fitted.items;
    omittedCount += fitted.omittedCount;
  }
  if (!selected.length) return null;

  const entries = selected
    .filter((item): item is Extract<ContextItem, { kind: "message" }> => item.kind === "message")
    .map((item) => item.value);
  const artifacts = selected
    .filter((item): item is Extract<ContextItem, { kind: "artifact" }> => item.kind === "artifact")
    .map((item) => item.value);
  const highWatermarkSeq = Math.max(...eligible.map(({ seq }) => seq));
  const truncated = omittedCount > 0 || selected.some((item) => item.value.truncated);
  const omittedSummary = omittedCount
    ? `${omittedCount} older context item${omittedCount === 1 ? " was" : "s were"} summarized or omitted to fit the handoff budget.`
    : undefined;
  return {
    artifacts,
    entries,
    files,
    highWatermarkSeq,
    omittedCount,
    omittedSummary,
    serialized: serializeSelection(entries, artifacts, omittedSummary),
    sourceSeq,
    truncated,
  };
}

export function buildAgentConversationContext(
  session: Session,
  providerId: string,
  input: {
    handoffId: string;
    workItemId: string;
    toParticipantId: string;
    objective: string;
    requestedAction?: AspConversationContext["requestedAction"];
    providerNames?: ReadonlyMap<string, string>;
  },
): AspConversationContext | null {
  const selection = selectAgentHandoff(session, providerId, {
    excludeLastUser: true,
    providerNames: input.providerNames,
  });
  if (!selection) return null;
  const messages: AspConversationContextMessage[] = selection.entries.map((entry) => ({
    id: entry.id,
    seq: entry.seq,
    role: entry.role,
    content: entry.content,
    participantId: entry.participantId,
    agentName: entry.agent,
    attachments: entry.attachments,
    truncated: entry.truncated,
  }));
  const fromParticipantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.participantId;
  const digest = handoffDigest({
    workItemId: input.workItemId,
    fromParticipantId,
    toParticipantId: input.toParticipantId,
    sourceSeq: selection.sourceSeq,
    highWatermarkSeq: selection.highWatermarkSeq,
    objective: input.objective,
    messages,
    artifacts: selection.artifacts,
    files: selection.files.map(fileDigestValue),
    omitted: selection.omittedSummary,
  });
  return {
    schemaVersion: "1",
    handoffId: input.handoffId,
    workItemId: input.workItemId,
    fromParticipantId,
    toParticipantId: input.toParticipantId,
    sourceSeq: selection.sourceSeq,
    highWatermarkSeq: selection.highWatermarkSeq,
    objective: input.objective,
    requestedAction: input.requestedAction ?? "continue",
    digest,
    messages,
    ...(selection.artifacts.length ? { artifacts: selection.artifacts } : {}),
    ...(selection.files.length ? { files: selection.files } : {}),
    ...(selection.omittedCount
      ? {
          omitted: {
            itemCount: selection.omittedCount,
            summary: selection.omittedSummary ?? "Older context was omitted.",
          },
        }
      : {}),
  };
}

function collectHandoffFiles(
  eligible: Array<{ block: ChatBlock; seq: number }>,
  cwd: string,
): AspConversationFile[] {
  const files = new Map<string, AspConversationFile>();
  for (const { block } of eligible) {
    if (block.kind === "user") {
      for (const attachment of block.attachments ?? []) {
        if (!attachment.path) continue;
        const id = `attachment:${attachment.id}`;
        addHandoffFile(files, {
          id,
          name: attachment.name || fileName(attachment.path),
          mimeType: attachment.mime,
          size: attachment.size,
          sourceBlockId: block.id,
          sourcePath: attachment.path,
          uri: handoffFileUri(id),
          availability: "pending",
        });
      }
      continue;
    }
    if (block.kind !== "diff" && block.kind !== "resource" && block.kind !== "artifact") continue;
    const candidatePath = block.path;
    const sourcePath = workspaceFilePath(candidatePath, cwd);
    if (!sourcePath) continue;
    const id = `artifact:${block.id}`;
    addHandoffFile(files, {
      id,
      name: ("name" in block && block.name) || fileName(sourcePath),
      mimeType: "mimeType" in block ? block.mimeType : undefined,
      sourceBlockId: block.id,
      sourcePath,
      uri: handoffFileUri(id),
      availability: "pending",
    });
  }
  return [...files.values()];
}

function addHandoffFile(files: Map<string, AspConversationFile>, file: AspConversationFile): void {
  const key = normalizedPath(file.sourcePath) || file.id;
  if (!files.has(key)) files.set(key, file);
}

function workspaceFilePath(value: string | undefined, cwd: string): string | undefined {
  if (!value || !cwd) return undefined;
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
    if (normalized.split("/").includes("..")) return undefined;
    return `${cwd.replace(/[\\/]+$/, "")}/${value}`;
  }
  return workspaceAttachmentPath(value, cwd);
}

function normalizedPath(value: string | undefined): string {
  return value?.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() ?? "";
}

function handoffFileUri(id: string): string {
  return `agui-handoff://file/${encodeURIComponent(id)}`;
}

function fileName(value: string): string {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "file";
}

function fileDigestValue(file: AspConversationFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sourceBlockId: file.sourceBlockId,
    uri: file.uri,
  };
}

export function agentSeenThroughSeq(session: Session, providerId: string): number {
  const route = session.agentSessions?.[providerId];
  if (route?.seenThroughSeq !== undefined) return route.seenThroughSeq;
  if (!route?.lastSyncedBlockId) return 0;
  const index = session.blocks.findIndex((block) => block.id === route.lastSyncedBlockId);
  return index < 0 ? 0 : blockSequence(session.blocks[index], index);
}

function contextItem(
  block: ChatBlock,
  seq: number,
  cwd: string,
  providerNames?: ReadonlyMap<string, string>,
): ContextItem | null {
  if (block.kind === "user") {
    const bounded = boundedMessage(block.text);
    const attachments = block.attachments?.map((attachment): HandoffAttachment => ({
      kind: attachment.kind,
      mimeType: attachment.mime,
      name: attachment.name,
      ...(workspaceAttachmentPath(attachment.path, cwd)
        ? { path: workspaceAttachmentPath(attachment.path, cwd) }
        : {}),
      size: attachment.size,
    }));
    return {
      kind: "message",
      value: {
        id: block.id,
        seq,
        role: "user",
        content: bounded.content,
        ...(bounded.truncated ? { truncated: true } : {}),
        ...(attachments?.length ? { attachments } : {}),
      },
    };
  }
  if (block.kind === "assistant" && block.text.trim()) {
    const providerId = block.agentProviderId ?? stringMetadata(block, "agentProviderId");
    const bounded = boundedMessage(block.text);
    return {
      kind: "message",
      value: {
        id: block.id,
        seq,
        role: "assistant",
        agent: providerId ? (providerNames?.get(providerId) ?? providerId) : "Assistant",
        participantId:
          block.agentParticipantId ?? (providerId ? providerParticipantId(providerId) : undefined),
        content: bounded.content,
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    };
  }
  const artifact = artifactEntry(block, seq);
  return artifact ? { kind: "artifact", value: artifact } : null;
}

function artifactEntry(block: ChatBlock, seq: number): AspConversationArtifact | null {
  const base = {
    id: block.id,
    seq,
    participantId: block.agentParticipantId,
  };
  if (block.kind === "plan") {
    return {
      ...base,
      kind: "plan",
      title: "Plan",
      summary: block.todos.map((todo) => `[${todo.status}] ${todo.content}`).join("\n"),
    };
  }
  if (block.kind === "tool") {
    return {
      ...base,
      kind: "tool",
      title: block.title,
      summary: boundedSummary(`${block.status}\n${block.output}`),
    };
  }
  if (block.kind === "terminal") {
    return {
      ...base,
      kind: "terminal",
      title: block.command,
      summary: boundedSummary(`${block.status}\n${block.output}`),
      path: block.cwd,
    };
  }
  if (block.kind === "diff") {
    return {
      ...base,
      kind: "diff",
      title: block.path,
      path: block.path,
      summary: boundedSummary(
        block.hunks
          .flatMap((hunk) =>
            hunk.lines.map(
              (line) =>
                `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`,
            ),
          )
          .join("\n"),
      ),
    };
  }
  if (block.kind === "resource" || block.kind === "artifact") {
    return {
      ...base,
      kind: block.kind,
      title: block.title || block.name || block.path || block.uri || block.kind,
      summary: boundedSummary(block.content ?? ""),
      path: block.path,
      uri: block.uri,
    };
  }
  return null;
}

function fitLatestGroup(group: ContextItem[]): { items: ContextItem[]; omittedCount: number } {
  if (!group.length) return { items: [], omittedCount: 0 };
  const anchorIndexes = new Set<number>();
  const firstUser = group.findIndex(
    (item) => item.kind === "message" && item.value.role === "user",
  );
  if (firstUser >= 0) anchorIndexes.add(firstUser);
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const item = group[index];
    if (item.kind === "message" && item.value.role === "assistant") {
      anchorIndexes.add(index);
      break;
    }
  }
  if (!anchorIndexes.size) anchorIndexes.add(group.length - 1);

  const selected = new Set(anchorIndexes);
  for (let index = group.length - 1; index >= 0; index -= 1) {
    if (selected.has(index) || selected.size >= AGENT_HANDOFF_MAX_BLOCKS) continue;
    const candidateIndexes = [...selected, index].sort((left, right) => left - right);
    const candidate = candidateIndexes.map((candidateIndex) => group[candidateIndex]);
    if (serializedItems(candidate).length <= AGENT_HANDOFF_CONTENT_BUDGET) selected.add(index);
  }

  let items = [...selected].sort((left, right) => left - right).map((index) => group[index]);
  if (serializedItems(items).length > AGENT_HANDOFF_CONTENT_BUDGET) {
    const fitted: ContextItem[] = [];
    for (const item of items) {
      const remaining = AGENT_HANDOFF_CONTENT_BUDGET - serializedItems(fitted).length;
      const next = fitSingleItem(item, remaining);
      if (next) fitted.push(next);
    }
    items = fitted;
  }
  return { items, omittedCount: Math.max(0, group.length - items.length) };
}

function fitSingleItem(item: ContextItem, budget: number): ContextItem | null {
  if (budget < 256) return null;
  const source = item.kind === "message" ? item.value.content : (item.value.summary ?? "");
  let low = 0;
  let high = source.length;
  let best: ContextItem | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value =
      item.kind === "message"
        ? { ...item.value, content: source.slice(0, middle), truncated: true }
        : { ...item.value, summary: source.slice(0, middle), truncated: true };
    const candidate = { ...item, value } as ContextItem;
    if (serializedItems([candidate]).length <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function serializeSelection(
  entries: AgentHandoffEntry[],
  artifacts: AspConversationArtifact[],
  omittedSummary?: string,
): string {
  return JSON.stringify({
    messages: entries,
    ...(artifacts.length ? { artifacts } : {}),
    ...(omittedSummary ? { omittedSummary } : {}),
  });
}

function serializedItems(items: ContextItem[]): string {
  return serializeSelection(
    items
      .filter((item): item is Extract<ContextItem, { kind: "message" }> => item.kind === "message")
      .map((item) => item.value),
    items
      .filter(
        (item): item is Extract<ContextItem, { kind: "artifact" }> => item.kind === "artifact",
      )
      .map((item) => item.value),
  );
}

function lastUserSequence(blocks: ChatBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === "user") return blockSequence(blocks[index], index);
  }
  return Number.MAX_SAFE_INTEGER;
}

function blockSequence(block: ChatBlock, index: number): number {
  return block.conversationSeq ?? index + 1;
}

function workspaceAttachmentPath(value: string | undefined, cwd: string): string | undefined {
  if (!value || !cwd) return undefined;
  const path = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return path === root || path.startsWith(`${root}/`) ? value : undefined;
}

function stringMetadata(block: ChatBlock, key: string): string | undefined {
  if (!("metadata" in block)) return undefined;
  const value = block.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedSummary(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= 1_600 ? normalized : `${normalized.slice(0, 1_600)}…`;
}

function boundedMessage(value: string): { content: string; truncated: boolean } {
  return value.length <= AGENT_HANDOFF_MESSAGE_MAX_CHARS
    ? { content: value, truncated: false }
    : { content: `${value.slice(0, AGENT_HANDOFF_MESSAGE_MAX_CHARS)}…`, truncated: true };
}

function handoffDigest(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function providerParticipantId(providerId: string): string {
  return `provider:${encodeURIComponent(providerId)}`;
}
