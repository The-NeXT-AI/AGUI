import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IDE_WORKSPACE_DIAGNOSTIC_LIMIT = 500;
const ideWorkspaceDiagnosticsCache = new Map<
  string,
  {
    expiresAt: number;
    promise: ReturnType<typeof ideWorkspaceDiagnostics>;
  }
>();

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function ideDiagnostics(
  root: string,
  filePath: string,
  content: string,
): Promise<
  Array<{
    filePath: string;
    severity: "error" | "warning" | "info" | "hint";
    message: string;
    source: string;
    code?: string;
    start: number;
    length: number;
    line: number;
    column: number;
  }>
> {
  if (!/\.[cm]?[jt]sx?$/i.test(filePath)) return [];
  try {
    const ts = await import("typescript");
    const configPath = findTsConfigInsideRoot(ts, root, path.dirname(filePath), filePath);
    const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : null;
    const parsed =
      config?.config && !config.error
        ? ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath ?? root))
        : null;
    const options = {
      ...(parsed?.options ?? {}),
      allowJs: true,
      checkJs: true,
      jsx: parsed?.options.jsx ?? ts.JsxEmit.ReactJSX,
      noEmit: true,
      skipLibCheck: true,
      target: parsed?.options.target ?? ts.ScriptTarget.ES2022,
    };
    const normalizedFilePath = path.resolve(filePath);
    const rootNames = ideTypeScriptRootNames(root, normalizedFilePath, parsed?.fileNames);
    const originalHost = ts.createCompilerHost(options, true);
    const originalGetSourceFile = originalHost.getSourceFile.bind(originalHost);
    const originalReadFile = originalHost.readFile.bind(originalHost);
    const originalFileExists = originalHost.fileExists.bind(originalHost);
    originalHost.readFile = (requestedPath) =>
      samePath(requestedPath, normalizedFilePath) ? content : originalReadFile(requestedPath);
    originalHost.fileExists = (requestedPath) =>
      samePath(requestedPath, normalizedFilePath) || originalFileExists(requestedPath);
    originalHost.getSourceFile = (
      requestedPath,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      if (samePath(requestedPath, normalizedFilePath)) {
        return ts.createSourceFile(
          requestedPath,
          content,
          languageVersion,
          true,
          scriptKindForPath(ts, requestedPath),
        );
      }
      return originalGetSourceFile(
        requestedPath,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    };
    const program = ts.createProgram(rootNames, options, originalHost);
    const sourceFile = program.getSourceFile(normalizedFilePath);
    if (!sourceFile) return [];
    return [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].map((diagnostic) => {
      const start = diagnostic.start ?? 0;
      const lineAndColumn = sourceFile.getLineAndCharacterOfPosition(start);
      return {
        filePath: normalizedFilePath,
        severity: tsDiagnosticSeverity(ts, diagnostic.category),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        source: "typescript",
        code: diagnostic.code ? String(diagnostic.code) : undefined,
        start,
        length: diagnostic.length ?? 1,
        line: lineAndColumn.line + 1,
        column: lineAndColumn.character + 1,
      };
    });
  } catch (error) {
    return [
      {
        filePath,
        severity: "warning",
        message: `TypeScript language service unavailable: ${String(error instanceof Error ? error.message : error)}`,
        source: "typescript",
        start: 0,
        length: 1,
        line: 1,
        column: 1,
      },
    ];
  }
}

async function ideWorkspaceDiagnostics(root: string): Promise<
  Array<{
    filePath: string;
    severity: "error" | "warning" | "info" | "hint";
    message: string;
    source: string;
    code?: string;
    start: number;
    length: number;
    line: number;
    column: number;
  }>
> {
  try {
    const ts = await import("typescript");
    const candidates = [
      "tsconfig.json",
      "tsconfig.app.json",
      "tsconfig.electron.json",
      "tsconfig.node.json",
    ]
      .map((name) => path.join(root, name))
      .filter(
        (candidate, index, values) =>
          fs.existsSync(candidate) && values.indexOf(candidate) === index,
      );
    if (!candidates.length) return [];
    const output: Awaited<ReturnType<typeof ideWorkspaceDiagnostics>> = [];
    const seen = new Set<string>();
    for (const configPath of candidates) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error) continue;
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
      const rootNames = parsed.fileNames
        .map((fileName) => path.resolve(fileName))
        .filter((fileName) => isPathInside(root, fileName))
        .slice(0, 5_000);
      if (!rootNames.length) continue;
      const program = ts.createProgram(rootNames, {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
      });
      for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        const sourceFile = diagnostic.file;
        if (!sourceFile || !isPathInside(root, sourceFile.fileName)) continue;
        const start = diagnostic.start ?? 0;
        const position = sourceFile.getLineAndCharacterOfPosition(start);
        const item = {
          filePath: path.resolve(sourceFile.fileName),
          severity: tsDiagnosticSeverity(ts, diagnostic.category),
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          source: "typescript",
          code: diagnostic.code ? String(diagnostic.code) : undefined,
          start,
          length: diagnostic.length ?? 1,
          line: position.line + 1,
          column: position.character + 1,
        };
        const identity = `${item.filePath}:${item.start}:${item.code ?? ""}:${item.message}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        output.push(item);
        if (output.length >= IDE_WORKSPACE_DIAGNOSTIC_LIMIT) return output;
      }
    }
    return output;
  } catch (error) {
    throw new Error(
      `Unable to analyze workspace diagnostics: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function cachedIdeWorkspaceDiagnostics(
  root: string,
): ReturnType<typeof ideWorkspaceDiagnostics> {
  const cached = ideWorkspaceDiagnosticsCache.get(root);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = ideWorkspaceDiagnostics(root);
  ideWorkspaceDiagnosticsCache.set(root, { expiresAt: Date.now() + 3_000, promise });
  void promise.catch(() => {
    if (ideWorkspaceDiagnosticsCache.get(root)?.promise === promise) {
      ideWorkspaceDiagnosticsCache.delete(root);
    }
  });
  return promise;
}

export async function ideSemanticTokens(
  root: string,
  filePath: string,
  content: string,
): Promise<{ data: number[] }> {
  if (!/\.[cm]?[jt]sx?$/i.test(filePath)) return { data: [] };
  try {
    const ts = await import("typescript");
    const configPath = findTsConfigInsideRoot(ts, root, path.dirname(filePath), filePath);
    const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : null;
    const parsed =
      config?.config && !config.error
        ? ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath ?? root))
        : null;
    const options = {
      ...(parsed?.options ?? {}),
      allowJs: true,
      checkJs: true,
      jsx: parsed?.options.jsx ?? ts.JsxEmit.ReactJSX,
      noEmit: true,
      skipLibCheck: true,
      target: parsed?.options.target ?? ts.ScriptTarget.ES2022,
    };
    const normalizedFilePath = path.resolve(filePath);
    const rootNames = ideTypeScriptRootNames(root, normalizedFilePath, parsed?.fileNames);
    const host: import("typescript").LanguageServiceHost = {
      getCompilationSettings: () => options,
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      getScriptFileNames: () => rootNames,
      getScriptKind: (requestedPath) => scriptKindForPath(ts, requestedPath),
      getScriptSnapshot: (requestedPath) => {
        if (samePath(requestedPath, normalizedFilePath)) {
          return ts.ScriptSnapshot.fromString(content);
        }
        try {
          if (!fs.existsSync(requestedPath)) return undefined;
          return ts.ScriptSnapshot.fromString(fs.readFileSync(requestedPath, "utf8"));
        } catch {
          return undefined;
        }
      },
      getScriptVersion: () => "1",
      readFile: ts.sys.readFile,
      fileExists: ts.sys.fileExists,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const classifications = service.getEncodedSemanticClassifications(
      normalizedFilePath,
      { start: 0, length: content.length },
      ts.SemanticClassificationFormat.TwentyTwenty,
    );
    const sourceFile = ts.createSourceFile(
      normalizedFilePath,
      content,
      options.target ?? ts.ScriptTarget.ES2022,
      true,
      scriptKindForPath(ts, normalizedFilePath),
    );
    service.dispose();
    return { data: monacoSemanticTokenData(ts, sourceFile, classifications.spans) };
  } catch {
    return { data: [] };
  }
}

function monacoSemanticTokenData(
  ts: typeof import("typescript"),
  sourceFile: import("typescript").SourceFile,
  spans: number[],
): number[] {
  const result: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  const sortedSpans = [];
  for (let index = 0; index < spans.length; index += 3) {
    sortedSpans.push({
      start: spans[index] ?? 0,
      length: spans[index + 1] ?? 0,
      encoded: spans[index + 2] ?? 0,
    });
  }
  sortedSpans.sort((left, right) => left.start - right.start);
  for (const span of sortedSpans) {
    const tokenType = (span.encoded >> 8) - 1;
    const tokenModifiers = span.encoded & 255;
    if (tokenType < 0 || tokenType > 11 || span.length <= 0) continue;
    const start = sourceFile.getLineAndCharacterOfPosition(span.start);
    const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
    if (end.line !== start.line) continue;
    const deltaLine = start.line - previousLine;
    const deltaCharacter = deltaLine === 0 ? start.character - previousCharacter : start.character;
    if (deltaLine < 0 || deltaCharacter < 0) continue;
    result.push(deltaLine, deltaCharacter, span.length, tokenType, tokenModifiers);
    previousLine = start.line;
    previousCharacter = start.character;
  }
  return result;
}

function ideTypeScriptRootNames(
  root: string,
  filePath: string,
  configFileNames?: string[],
): string[] {
  const names = (configFileNames ?? [])
    .map((name) => path.resolve(name))
    .filter((name) => isPathInside(root, name));
  if (!names.some((name) => samePath(name, filePath))) {
    names.push(filePath);
  }
  return names;
}

function findTsConfigInsideRoot(
  ts: typeof import("typescript"),
  root: string,
  startDirectory: string,
  filePath: string,
): string | undefined {
  const relative = path.relative(root, filePath);
  const preferredConfig =
    relative === "src" || relative.startsWith(`src${path.sep}`)
      ? path.join(root, "tsconfig.app.json")
      : relative === path.join("packages", "electron") ||
          relative.startsWith(`packages${path.sep}electron${path.sep}`)
        ? path.join(root, "tsconfig.electron.json")
        : null;
  if (preferredConfig && fs.existsSync(preferredConfig)) return preferredConfig;
  return ts.findConfigFile(
    startDirectory,
    (candidate) => isPathInside(root, path.resolve(candidate)) && fs.existsSync(candidate),
    "tsconfig.json",
  );
}

function scriptKindForPath(
  ts: typeof import("typescript"),
  filePath: string,
): import("typescript").ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function tsDiagnosticSeverity(
  ts: typeof import("typescript"),
  category: import("typescript").DiagnosticCategory,
): "error" | "warning" | "info" | "hint" {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  if (category === ts.DiagnosticCategory.Suggestion) return "hint";
  return "info";
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
