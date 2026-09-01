import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AspConversationFile, RunInput } from "@the-next-ai/asp/types";
import type { McpGatewayToolDefinition, McpGatewayToolProvider } from "./types.js";

export const handoffFileMcpProviderId = "agui_handoff_files";

const HANDOFF_FILE_MAX_BYTES = 100 * 1024 * 1024;
const HANDOFF_READ_MAX_BYTES = 256 * 1024;

export type PreparedHandoffFile = AspConversationFile & {
  availability: "ready";
  sha256: string;
  size: number;
  snapshotPath: string;
};

export async function cleanupHandoffFiles(
  userDataPath: string,
  uiSessionId: string,
): Promise<void> {
  if (!uiSessionId) return;
  const sessionRoot = path.join(userDataPath, "handoff-files", stableKey(uiSessionId).slice(0, 24));
  await fs.promises.rm(sessionRoot, { recursive: true, force: true });
}

export async function prepareHandoffFiles(
  input: RunInput,
  userDataPath: string,
): Promise<{ files: PreparedHandoffFile[]; input: RunInput }> {
  const requested = input.conversationContext?.files ?? [];
  if (!requested.length) return { files: [], input };

  const sessionRoot = path.join(
    userDataPath,
    "handoff-files",
    stableKey(input.uiSessionId).slice(0, 24),
  );
  try {
    await fs.promises.mkdir(path.join(sessionRoot, "blobs"), { recursive: true });
    await fs.promises.mkdir(path.join(sessionRoot, "index"), { recursive: true });
  } catch {
    return unavailableHandoffFiles(input, requested);
  }

  const allowedAttachmentPaths = new Set(
    (input.attachments ?? []).flatMap((attachment) => {
      const resolved = realFilePath(attachment.path, input.cwd);
      return resolved ? [pathKey(resolved)] : [];
    }),
  );
  const preparedFiles: AspConversationFile[] = [];
  const readyFiles: PreparedHandoffFile[] = [];
  const readyById = new Map<string, PreparedHandoffFile>();
  const sourceToSnapshot = new Map<string, string>();

  for (const file of requested) {
    const prepared = await prepareHandoffFile(
      file,
      input.cwd,
      sessionRoot,
      allowedAttachmentPaths,
    ).catch(() => unavailableFile(file));
    preparedFiles.push(prepared);
    if (prepared.availability !== "ready" || !prepared.snapshotPath || !prepared.sha256) continue;
    const ready = prepared as PreparedHandoffFile;
    readyFiles.push(ready);
    readyById.set(ready.id, ready);
    if (file.sourcePath) {
      const resolved = realFilePath(file.sourcePath, input.cwd);
      if (resolved) sourceToSnapshot.set(pathKey(resolved), ready.snapshotPath);
    }
  }

  const attachments = (input.attachments ?? []).flatMap((attachment) => {
    const { handoffFileId, ...cleanAttachment } = attachment;
    if (handoffFileId) {
      const ready = readyById.get(handoffFileId);
      return ready ? [{ ...cleanAttachment, path: ready.snapshotPath }] : [];
    }
    const resolved = realFilePath(attachment.path, input.cwd);
    const snapshotPath = resolved ? sourceToSnapshot.get(pathKey(resolved)) : undefined;
    return [snapshotPath ? { ...cleanAttachment, path: snapshotPath } : cleanAttachment];
  });
  const attachedPaths = new Set(attachments.map((attachment) => pathKey(attachment.path)));
  for (const file of readyFiles) {
    if (attachedPaths.has(pathKey(file.snapshotPath))) continue;
    attachedPaths.add(pathKey(file.snapshotPath));
    attachments.push({ kind: "file", name: file.name, path: file.snapshotPath });
  }

  return {
    files: readyFiles,
    input: {
      ...input,
      attachments,
      conversationContext: input.conversationContext
        ? { ...input.conversationContext, files: preparedFiles }
        : undefined,
      additionalDeveloperInstructions: appendInstructions(
        input.additionalDeveloperInstructions,
        readyFiles.length
          ? "This run includes read-only snapshots of original handoff files. Their metadata and snapshotPath values are in conversationContext.files. Read those exact snapshots when prior file contents matter. If a snapshot path is unavailable to the provider, use MCP Gateway to resolve and call handoff_file_list or handoff_file_read."
          : "Some original handoff files are unavailable. Inspect conversationContext.files availability before relying on them.",
      ),
    },
  };
}

function unavailableFile(file: AspConversationFile): AspConversationFile {
  return { ...file, sourcePath: undefined, availability: "missing" };
}

function unavailableHandoffFiles(
  input: RunInput,
  files: AspConversationFile[],
): { files: PreparedHandoffFile[]; input: RunInput } {
  return {
    files: [],
    input: {
      ...input,
      attachments: input.attachments?.flatMap(({ handoffFileId, ...attachment }) =>
        handoffFileId ? [] : [attachment],
      ),
      conversationContext: input.conversationContext
        ? { ...input.conversationContext, files: files.map(unavailableFile) }
        : undefined,
      additionalDeveloperInstructions: appendInstructions(
        input.additionalDeveloperInstructions,
        "Some original handoff files are unavailable. Inspect conversationContext.files availability before relying on them.",
      ),
    },
  };
}

export function createHandoffFileMcpToolProvider(
  files: PreparedHandoffFile[],
): McpGatewayToolProvider {
  const byId = new Map(files.map((file) => [file.id, file]));
  return {
    listTools: () => handoffFileToolDefinitions(),
    callTool: async (name, args) => {
      if (name === "handoff_file_list") {
        return {
          files: files.map(publicFileMetadata),
          readOnly: true,
        };
      }
      if (name !== "handoff_file_read") throw new Error(`Unknown handoff file tool: ${name}`);
      const fileId = requiredString(args.fileId, "handoff_file_read requires fileId.");
      const file = byId.get(fileId);
      if (!file) throw new Error(`Handoff file is not available: ${fileId}`);
      const offset = boundedInteger(args.offset, 0, file.size, 0);
      const maxBytes = boundedInteger(args.maxBytes, 1, HANDOFF_READ_MAX_BYTES, 64 * 1024);
      const length = Math.min(maxBytes, Math.max(0, file.size - offset));
      const handle = await fs.promises.open(file.snapshotPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        const chunk = buffer.subarray(0, bytesRead);
        const text = isTextFile(file, chunk);
        return {
          file: publicFileMetadata(file),
          offset,
          bytesRead,
          nextOffset: offset + bytesRead < file.size ? offset + bytesRead : null,
          encoding: text ? "utf8" : "base64",
          content: text ? chunk.toString("utf8") : chunk.toString("base64"),
        };
      } finally {
        await handle.close();
      }
    },
  };
}

async function prepareHandoffFile(
  file: AspConversationFile,
  cwd: string,
  sessionRoot: string,
  allowedAttachmentPaths: Set<string>,
): Promise<AspConversationFile> {
  const indexPath = path.join(sessionRoot, "index", `${stableKey(file.id)}.json`);
  const indexed = await readIndex(indexPath);
  if (indexed && (await indexedFileIsValid(indexed, file.id, sessionRoot))) {
    return { ...file, ...indexed, sourcePath: undefined, availability: "ready" };
  }

  const sourcePath = file.sourcePath ? realFilePath(file.sourcePath, cwd) : undefined;
  if (
    !sourcePath ||
    (!isPathInside(cwd, sourcePath) && !allowedAttachmentPaths.has(pathKey(sourcePath)))
  ) {
    return { ...file, sourcePath: undefined, availability: "missing" };
  }
  const stat = await fs.promises.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) return { ...file, sourcePath: undefined, availability: "missing" };
  if (stat.size > HANDOFF_FILE_MAX_BYTES) {
    return { ...file, size: stat.size, sourcePath: undefined, availability: "too_large" };
  }

  const blobsRoot = path.join(sessionRoot, "blobs");
  const temporaryPath = path.join(blobsRoot, `.tmp-${randomUUID()}`);
  let snapshotPath = "";
  let sha256 = "";
  let snapshotSize = 0;
  try {
    await fs.promises.copyFile(sourcePath, temporaryPath);
    const snapshotStat = await fs.promises.stat(temporaryPath);
    if (!snapshotStat.isFile()) return unavailableFile(file);
    if (snapshotStat.size > HANDOFF_FILE_MAX_BYTES) {
      return { ...file, size: snapshotStat.size, sourcePath: undefined, availability: "too_large" };
    }
    snapshotSize = snapshotStat.size;
    sha256 = await fileSha256(temporaryPath);
    snapshotPath = path.join(blobsRoot, sha256);
    if (!(await snapshotMatches(snapshotPath, sha256, snapshotSize))) {
      await fs.promises.unlink(snapshotPath).catch(() => undefined);
      await fs.promises.rename(temporaryPath, snapshotPath);
    }
    await fs.promises.chmod(snapshotPath, 0o444).catch(() => undefined);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
  const ready: PreparedHandoffFile = {
    ...file,
    availability: "ready",
    sha256,
    size: snapshotSize,
    snapshotPath,
    sourcePath: undefined,
  };
  await fs.promises.writeFile(
    indexPath,
    JSON.stringify({
      id: ready.id,
      sha256: ready.sha256,
      size: ready.size,
      snapshotPath: ready.snapshotPath,
    }),
    "utf8",
  );
  return ready;
}

function handoffFileToolDefinitions(): McpGatewayToolDefinition[] {
  return [
    {
      name: "handoff_file_list",
      title: "List Original Handoff Files",
      description:
        "List the read-only original file snapshots attached to the current agent handoff.",
      inputSchema: objectSchema({}, []),
    },
    {
      name: "handoff_file_read",
      title: "Read Original Handoff File",
      description:
        "Read an exact read-only handoff file snapshot by fileId. Text is UTF-8 and binary data is base64. Use offset and maxBytes for large files.",
      inputSchema: objectSchema(
        {
          fileId: { type: "string", description: "File id returned by handoff_file_list." },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: HANDOFF_READ_MAX_BYTES,
            description: "Maximum bytes to read. Defaults to 65536.",
          },
          offset: { type: "integer", minimum: 0, description: "Byte offset. Defaults to 0." },
        },
        ["fileId"],
      ),
    },
  ];
}

function publicFileMetadata(file: PreparedHandoffFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    sourceBlockId: file.sourceBlockId,
    snapshotPath: file.snapshotPath,
    uri: file.uri,
  };
}

function isTextFile(file: PreparedHandoffFile, buffer: Buffer): boolean {
  if (
    file.mimeType?.startsWith("text/") ||
    /json|xml|yaml|javascript|typescript/.test(file.mimeType ?? "")
  ) {
    return true;
  }
  return !buffer.includes(0);
}

async function readIndex(indexPath: string): Promise<PreparedHandoffFile | null> {
  try {
    return JSON.parse(await fs.promises.readFile(indexPath, "utf8")) as PreparedHandoffFile;
  } catch {
    return null;
  }
}

async function indexedFileIsValid(
  indexed: PreparedHandoffFile,
  fileId: string,
  sessionRoot: string,
): Promise<boolean> {
  if (
    indexed.id !== fileId ||
    !/^[a-f0-9]{64}$/.test(indexed.sha256) ||
    !Number.isSafeInteger(indexed.size) ||
    indexed.size < 0 ||
    indexed.size > HANDOFF_FILE_MAX_BYTES ||
    !isPathInside(path.join(sessionRoot, "blobs"), indexed.snapshotPath) ||
    path.basename(indexed.snapshotPath) !== indexed.sha256
  ) {
    return false;
  }
  return snapshotMatches(indexed.snapshotPath, indexed.sha256, indexed.size);
}

async function snapshotMatches(
  snapshotPath: string,
  sha256: string,
  expectedSize: number,
): Promise<boolean> {
  const stat = await fs.promises.stat(snapshotPath).catch(() => null);
  return Boolean(
    stat?.isFile() &&
    stat.size === expectedSize &&
    (await fileSha256(snapshotPath).catch(() => "")) === sha256,
  );
}

function realFilePath(value: string, cwd: string): string | undefined {
  try {
    const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    const real = fs.realpathSync(resolved);
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function appendInstructions(existing: string | undefined, addition: string): string {
  return existing?.trim() ? `${existing.trim()}\n\n${addition}` : addition;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(message);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}
