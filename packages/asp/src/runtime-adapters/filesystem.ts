import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, record, splitList } from "./shared.js";

export function claudeSettingsFiles(cwd: string): string[] {
  return [
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
  ].filter((filePath) => fs.existsSync(filePath));
}

export function markdownFiles(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

export function markdownFilesRecursive(directories: string[]): string[] {
  const files: string[] = [];
  for (const directory of directories) {
    walkDirectory(directory, (filePath) => {
      if (/\.md$/i.test(filePath)) files.push(filePath);
    });
  }
  return files;
}

export function walkDirectory(
  directory: string,
  visit: (filePath: string) => void,
  depth = 0,
): void {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkDirectory(filePath, visit, depth + 1);
    else if (entry.isFile()) visit(filePath);
  }
}

export function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return record(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return {};
  }
}

export function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function ancestorFiles(cwd: string, fileName: string): string[] {
  const files: string[] = [];
  let current = path.resolve(cwd);
  for (let index = 0; index < 20; index += 1) {
    const candidate = path.join(current, fileName);
    if (fs.existsSync(candidate)) files.push(candidate);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

export function skillDirectories(directories: string[]): Array<Record<string, unknown>> {
  const skills: Array<Record<string, unknown>> = [];
  for (const directory of directories) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(directory, entry.name);
      const manifest = path.join(skillPath, "SKILL.md");
      const content = readTextFile(manifest);
      const { frontmatter } = parseFrontmatter(content);
      skills.push({
        id: entry.name,
        name: frontmatter.name || entry.name,
        description: frontmatter.description || undefined,
        path: skillPath,
        source: skillPath.includes(`${path.sep}.codex${path.sep}`) ? "codex" : "workspace",
      });
    }
  }
  return skills;
}

export function parseTomlSummary(content: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let section = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[+([^\]]+)\]+$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = `${section ? `${section}.` : ""}${line.slice(0, index).trim()}`;
    values[key] = parseTomlScalar(line.slice(index + 1).trim());
  }
  return values;
}

export function parseTomlHookSummary(content: string): Record<string, unknown> {
  const values = parseTomlSummary(content);
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => key.toLowerCase().includes("hook")),
  );
}

export function parseTomlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (/^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\[.*\]$/.test(trimmed)) return splitList(trimmed);
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

export function mergeRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = record(next[key]);
    const incoming = record(value);
    next[key] =
      Object.keys(current).length && Object.keys(incoming).length && !Array.isArray(value)
        ? mergeRecords(current, incoming)
        : value;
  }
  return next;
}
