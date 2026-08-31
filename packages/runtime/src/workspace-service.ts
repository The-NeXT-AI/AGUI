import fs from "node:fs";
import path from "node:path";

export type IdeTreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: IdeTreeNode[];
};

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
};

export type WorkspaceDirectoryListing = {
  entries: WorkspaceDirectoryEntry[];
  parentPath: string | null;
  path: string;
  roots: WorkspaceDirectoryEntry[];
};

const IDE_TREE_MAX_DEPTH = 6;
const IDE_TREE_MAX_NODES = 1_800;
export const IDE_FILE_MAX_BYTES = 1024 * 1024;
export const IDE_WRITE_MAX_BYTES = 2 * 1024 * 1024;
const IDE_IGNORED_NAMES = new Set([
  ".git",
  ".pnpm-store",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "reference",
  "target",
]);

export function safeIdeRoot(value?: string): string {
  if (typeof value !== "string" || !value) throw new Error("Missing workspace root.");
  const root = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(root).isDirectory()) throw new Error("Workspace root is not a directory.");
  return root;
}

export function safeIdePath(rootValue: string, value?: string): string {
  if (typeof value !== "string" || !value) throw new Error("Missing file path.");
  const root = safeIdeRoot(rootValue);
  const candidate = path.resolve(value);
  if (!isPathInside(root, candidate)) throw new Error("File is outside the workspace.");

  const existingPath = fs.existsSync(candidate) ? fs.realpathSync(candidate) : null;
  if (existingPath && !isPathInside(root, existingPath)) {
    throw new Error("File resolves outside the workspace.");
  }
  const parent = fs.realpathSync(path.dirname(candidate));
  if (!isPathInside(root, parent)) throw new Error("File parent resolves outside the workspace.");
  return existingPath ?? candidate;
}

export function buildIdeTree(rootValue: string): IdeTreeNode {
  const root = safeIdeRoot(rootValue);
  let visited = 0;
  const children = readIdeDirectory(root, root, 0, () => {
    visited += 1;
    return visited <= IDE_TREE_MAX_NODES;
  });
  return { name: path.basename(root) || root, path: root, type: "directory", children };
}

export function readIdeFile(filePath: string): {
  path: string;
  name: string;
  content: string;
  language: string;
  mtimeMs: number;
} {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > IDE_FILE_MAX_BYTES)
    throw new Error("File is too large to open in the IDE panel.");
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("\u0000"))
    throw new Error("Binary files are not supported in the IDE panel.");
  return {
    path: filePath,
    name: path.basename(filePath),
    content,
    language: languageForPath(filePath),
    mtimeMs: stat.mtimeMs,
  };
}

export function readWorkspaceDirectories(directory: string): WorkspaceDirectoryEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !IDE_IGNORED_NAMES.has(entry.name) && entry.name !== ".DS_Store",
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => workspaceDirectoryEntry(path.join(directory, entry.name)));
}

export function workspaceDirectoryEntry(directory: string): WorkspaceDirectoryEntry {
  return { name: path.basename(directory) || directory, path: directory };
}

export function configuredWorkspaceRoots(
  value: string[] | (() => string[]) | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  if (typeof value === "function") return value().map(String);
  if (Array.isArray(value)) return value.map(String);
  const raw = env.AG_UI_WORKSPACE_ROOTS ?? env.AGUI_WORKSPACE_ROOTS ?? "";
  return raw
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readIdeDirectory(
  root: string,
  directory: string,
  depth: number,
  canVisit: () => boolean,
): IdeTreeNode[] {
  if (depth >= IDE_TREE_MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: IdeTreeNode[] = [];
  for (const entry of entries
    .filter((item) => !IDE_IGNORED_NAMES.has(item.name) && !item.name.startsWith(".DS_Store"))
    .filter((item) => item.isDirectory() || item.isFile())
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })) {
    if (!canVisit()) break;
    const entryPath = path.join(directory, entry.name);
    if (!isPathInside(root, entryPath)) continue;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: entryPath,
        type: "directory",
        children: readIdeDirectory(root, entryPath, depth + 1, canVisit),
      });
    } else {
      nodes.push({ name: entry.name, path: entryPath, type: "file" });
    }
  }
  return nodes;
}

function languageForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".md":
    case ".mdx":
      return "markdown";
    default: {
      const extension = path.extname(filePath).toLowerCase();
      return extension ? extension.slice(1) : "plaintext";
    }
  }
}

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
