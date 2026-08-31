import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexRuntimeEnv } from "./codex.js";
import { readTextFile } from "./filesystem.js";
import { parseJson, record, text } from "./shared.js";

let codexSessionTitleIndexCache: { index: Map<string, string>; cacheKey: string } | undefined;
let codexTranscriptPathCache: { paths: Map<string, string>; rootsKey: string } | undefined;

export function codexTranscriptMetadata(
  item: Record<string, unknown>,
  filePath: string,
): Record<string, unknown> {
  const passthrough = record(item.internal_chat_message_metadata_passthrough);
  return {
    ...passthrough,
    source: "codex-transcript",
    transcriptPath: filePath,
  };
}

export function codexSessionIndexTitle(...ids: string[]): string {
  return codexSessionIndexTitleForEnv(process.env, ...ids);
}

export function codexSessionIndexTitleForEnv(env: CodexRuntimeEnv, ...ids: string[]): string {
  const index = codexSessionTitleIndex(env);
  for (const id of ids) {
    const title = id ? index.get(id) : undefined;
    if (title) return title;
  }
  return "";
}

export function codexSessionTitleIndex(env: CodexRuntimeEnv = process.env): Map<string, string> {
  const files = codexSessionIndexFiles(env);
  const cacheKey = files
    .map((filePath) => `${filePath}:${safeStat(filePath)?.mtimeMs ?? 0}`)
    .join("\0");
  if (codexSessionTitleIndexCache?.cacheKey === cacheKey) {
    return codexSessionTitleIndexCache.index;
  }
  const index = new Map<string, string>();
  for (const filePath of files) {
    for (const line of readTextFile(filePath).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = record(parseJson(line));
      const id =
        text(item.id) ||
        text(item.session_id) ||
        text(item.sessionId) ||
        text(item.thread_id) ||
        text(item.threadId);
      const title =
        text(item.thread_name) ||
        text(item.threadName) ||
        text(item.thread_title) ||
        text(item.threadTitle) ||
        text(item.session_title) ||
        text(item.sessionTitle) ||
        text(item.title);
      if (id && title) index.set(id, title);
    }
  }
  codexSessionTitleIndexCache = { index, cacheKey };
  return index;
}

export function removeCodexSessionIndexEntry(
  ids: string[],
  env: CodexRuntimeEnv = process.env,
): void {
  const idSet = new Set(ids.filter(Boolean));
  if (!idSet.size) return;
  for (const filePath of codexSessionIndexFiles(env)) {
    const lines = readTextFile(filePath).split(/\r?\n/);
    if (!lines.some((line) => line.trim())) continue;
    const next = lines.filter((line) => {
      if (!line.trim()) return false;
      const item = record(parseJson(line));
      const id =
        text(item.id) ||
        text(item.session_id) ||
        text(item.sessionId) ||
        text(item.thread_id) ||
        text(item.threadId);
      return !idSet.has(id);
    });
    fs.writeFileSync(filePath, next.length ? `${next.join("\n")}\n` : "");
  }
  codexSessionTitleIndexCache = undefined;
}

export function transcriptTitleFromRecord(value: unknown): string {
  const source = record(value);
  return (
    text(source.title) ||
    text(source.session_title) ||
    text(source.sessionTitle) ||
    text(source.thread_title) ||
    text(source.threadTitle) ||
    text(source.thread_name) ||
    text(source.threadName) ||
    text(source.conversation_title) ||
    text(source.conversationTitle)
  );
}

export function isTranscriptTitleEvent(type: string, payloadType: string): boolean {
  const normalized = `${type} ${payloadType}`.toLowerCase().replace(/[/_]/g, ".");
  return (
    normalized.includes("session.title") ||
    normalized.includes("thread.title") ||
    normalized.includes("conversation.title") ||
    normalized.includes("title.updated") ||
    normalized.includes("title.update")
  );
}

export function transcriptVisibleUserText(value: string): string {
  let content = value.replace(/\r\n/g, "\n").trim();
  if (!content) return "";
  if (isInjectedTranscriptUserText(content)) return "";
  for (const tag of [
    "<subagent-guidance>",
    "<environment_context>",
    "<recommended_plugins>",
    "<app-context>",
    "<skills_instructions>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<apps_instructions>",
    "<plugins_instructions>",
    "<local-command-caveat>",
    "<command-name>",
    "<system-reminder>",
  ]) {
    const index = content.indexOf(tag);
    if (index > 0) content = content.slice(0, index).trim();
  }
  return content;
}

export function isInjectedTranscriptUserText(value: string): boolean {
  const normalized = value.trimStart();
  return [
    "<recommended_plugins>",
    "<environment_context>",
    "<app-context>",
    "<skills_instructions>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<apps_instructions>",
    "<plugins_instructions>",
    "<local-command-caveat>",
    "<command-name>",
    "<system-reminder>",
  ].some((prefix) => normalized.startsWith(prefix));
}

export function summarizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function codexTranscriptFileId(filePath: string): string {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i.exec(
    filePath,
  );
  return match?.[1] ?? "";
}

export function codexTranscriptFileForSession(
  sessionId: string,
  env: CodexRuntimeEnv,
): string | undefined {
  if (isReadableTranscriptPath(sessionId)) return sessionId;
  const expectedId = codexTranscriptFileId(sessionId);
  if (!expectedId) return undefined;
  const paths = codexTranscriptPathIndex(env);
  const cached = paths.get(expectedId);
  if (cached && fs.existsSync(cached)) return cached;
  codexTranscriptPathCache = undefined;
  return codexTranscriptPathIndex(env).get(expectedId);
}

export function codexTranscriptPathIndex(env: CodexRuntimeEnv): Map<string, string> {
  const roots = codexTranscriptRoots(env);
  const rootsKey = roots.join("\0");
  if (codexTranscriptPathCache?.rootsKey === rootsKey) return codexTranscriptPathCache.paths;
  const paths = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of safeReadDir(directory)) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && filePath.endsWith(".jsonl")) {
        const id = codexTranscriptFileId(filePath);
        if (id && !paths.has(id)) paths.set(id, filePath);
      }
    }
  };
  for (const root of roots) walk(root);
  codexTranscriptPathCache = { paths, rootsKey };
  return paths;
}

export function codexSessionIndexFiles(env: CodexRuntimeEnv): string[] {
  return codexHomeCandidates(env)
    .map((home) => path.join(home, "session_index.jsonl"))
    .filter((filePath, index, files) => files.indexOf(filePath) === index)
    .filter((filePath) => safeStat(filePath)?.isFile() === true);
}

export function codexTranscriptRoots(env: CodexRuntimeEnv): string[] {
  const roots = codexHomeCandidates(env).flatMap((home) => [
    path.join(home, "sessions"),
    path.join(home, "archived_sessions"),
  ]);
  return roots
    .filter((root, index) => roots.indexOf(root) === index)
    .filter((root) => safeStat(root)?.isDirectory() === true);
}

export function codexHomeCandidates(env: CodexRuntimeEnv): string[] {
  const candidates = [env.CODEX_HOME, path.join(os.homedir(), ".codex")];
  const homes: string[] = [];
  for (const candidate of candidates) {
    const home = candidate ? path.resolve(candidate) : "";
    if (home && !homes.includes(home)) homes.push(home);
  }
  return homes;
}

export function readFilePrefix(filePath: string, byteLimit: number): string {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(byteLimit);
      const bytesRead = fs.readSync(fd, buffer, 0, byteLimit, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function safeReadDir(directory: string) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function safeStat(filePath: string) {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

export function isReadableTranscriptPath(value: string): boolean {
  if (!value || !path.isAbsolute(value) || !value.endsWith(".jsonl")) return false;
  return safeStat(value)?.isFile() === true;
}
