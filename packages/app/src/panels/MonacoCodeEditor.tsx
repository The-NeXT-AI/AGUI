import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import "monaco-editor/basic-languages/monaco.contribution";
import "monaco-editor/language/css/monaco.contribution";
import "monaco-editor/language/html/monaco.contribution";
import "monaco-editor/language/json/monaco.contribution";
import {
  javascriptDefaults,
  typescriptDefaults,
} from "monaco-editor/language/typescript/monaco.contribution";
import { desktopApi, type IdeDiagnostic } from "@/asp/desktop-api";
import { DEFAULT_CODE_FONT_STACK, useUIStore } from "@/ui/ui-store";

const MONACO_THEME = "agui-dynamic";
const MARKER_OWNER = "agui-lsp";
const SEMANTIC_TOKEN_TYPES = [
  "class",
  "enum",
  "interface",
  "namespace",
  "typeParameter",
  "type",
  "parameter",
  "variable",
  "enumMember",
  "property",
  "function",
  "method",
];
const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "static",
  "async",
  "readonly",
  "defaultLibrary",
  "local",
];

const semanticContexts = new Map<string, { root: string; filePath: string }>();
let monacoConfigured = false;

type MonacoCodeEditorProps = {
  root: string;
  tab: {
    path: string;
    language: string;
    content: string;
  };
  diagnostics: IdeDiagnostic[];
  onChange: (path: string, content: string) => void;
  onSave: (content: string) => void;
};

export function MonacoCodeEditor({
  root,
  tab,
  diagnostics,
  onChange,
  onSave,
}: MonacoCodeEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activePathRef = useRef(tab.path);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const codeFont = useUIStore((state) => state.codeFont);

  activePathRef.current = tab.path;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    configureMonaco();
    const mount = mountRef.current;
    if (!mount) return undefined;
    const editor = monaco.editor.create(mount, {
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      cursorBlinking: "smooth",
      fontFamily: codeEditorFontFamily(useUIStore.getState().codeFont),
      fontSize: 12,
      lineHeight: 20,
      minimap: { enabled: false },
      padding: { top: 10, bottom: 10 },
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      theme: MONACO_THEME,
      wordWrap: "off",
      "semanticHighlighting.enabled": true,
    });
    const updateTheme = (event?: Event) => {
      defineCurrentMonacoTheme(event);
      monaco.editor.setTheme(MONACO_THEME);
    };
    window.addEventListener("agui-theme-changed", updateTheme);
    editorRef.current = editor;
    const changeDisposable = editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      const path = activePathRef.current;
      if (!model || !path) return;
      onChangeRef.current(path, model.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current(editor.getValue());
    });
    return () => {
      changeDisposable.dispose();
      window.removeEventListener("agui-theme-changed", updateTheme);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily: codeEditorFontFamily(codeFont) });
  }, [codeFont]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = getOrCreateModel(tab.path, tab.language, tab.content, root);
    if (model.getValue() !== tab.content) {
      model.setValue(tab.content);
    }
    editor.setModel(model);
    window.requestAnimationFrame(() => editor.focus());
  }, [root, tab.content, tab.path, tab.language]);

  useEffect(() => {
    const model = monaco.editor.getModel(monaco.Uri.file(tab.path));
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      diagnostics.map((diagnostic) => toMarker(model, diagnostic)),
    );
  }, [diagnostics, tab.path]);

  return <div ref={mountRef} className="bg-code-bg min-h-0 flex-1 overflow-hidden" />;
}

function codeEditorFontFamily(font: string): string {
  return font || DEFAULT_CODE_FONT_STACK;
}

export function disposeMonacoModel(filePath: string): void {
  const uri = monaco.Uri.file(filePath);
  semanticContexts.delete(uri.toString());
  const model = monaco.editor.getModel(uri);
  if (!model) return;
  monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  model.dispose();
}

function configureMonaco(): void {
  if (monacoConfigured) return;
  monacoConfigured = true;
  (globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    },
  };
  defineCurrentMonacoTheme();
  typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.registerDocumentSemanticTokensProvider(["typescript", "javascript"], {
    getLegend: () => ({
      tokenTypes: SEMANTIC_TOKEN_TYPES,
      tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
    }),
    provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
      const context = semanticContexts.get(model.uri.toString());
      if (!context || token.isCancellationRequested) return { data: new Uint32Array() };
      const response = await desktopApi()?.ide?.semanticTokens({
        root: context.root,
        filePath: context.filePath,
        content: model.getValue(),
      });
      if (token.isCancellationRequested) return { data: new Uint32Array() };
      return { data: new Uint32Array(response?.data ?? []) };
    },
    releaseDocumentSemanticTokens: () => {},
  });
}

function defineCurrentMonacoTheme(event?: Event): void {
  const eventDetail =
    event instanceof CustomEvent
      ? (event.detail as {
          definition?: {
            monaco?: {
              base?: monaco.editor.BuiltinTheme;
              colors?: Record<string, string>;
              rules?: monaco.editor.ITokenThemeRule[];
            };
          };
        })
      : undefined;
  const detail = eventDetail ?? window.__AGUI_CURRENT_THEME__;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme !== "light";
  const monacoTheme = detail?.definition?.monaco;
  const extensionRules = monacoTheme?.rules as monaco.editor.ITokenThemeRule[] | undefined;
  monaco.editor.defineTheme(MONACO_THEME, {
    base: monacoTheme?.base ?? (dark ? "vs-dark" : "vs"),
    inherit: true,
    rules: extensionRules?.length
      ? extensionRules
      : [
          { token: "class", foreground: "4ec9b0" },
          { token: "enum", foreground: "4ec9b0" },
          { token: "interface", foreground: "4ec9b0" },
          { token: "namespace", foreground: "4ec9b0" },
          { token: "type", foreground: "4ec9b0" },
          { token: "typeParameter", foreground: "4ec9b0" },
          { token: "parameter", foreground: "9cdcfe" },
          { token: "variable", foreground: "9cdcfe" },
          { token: "property", foreground: "9cdcfe" },
          { token: "enumMember", foreground: "b5cea8" },
          { token: "function", foreground: "dcdcaa" },
          { token: "method", foreground: "dcdcaa" },
        ],
    colors: {
      "editor.background": token("--code-bg", dark ? "#1e1e1e" : "#f6f6f6"),
      "editor.foreground": token("--fg-primary", dark ? "#d4d4d4" : "#1f2328"),
      "editor.lineHighlightBackground": token("--bg-surface-hover", dark ? "#2a2d2e" : "#f0f0f0"),
      "editor.selectionBackground": token("--selection-bg", dark ? "#264f78" : "#add6ff"),
      "editorCursor.foreground": token("--fg-primary", dark ? "#aeafad" : "#1f2328"),
      "editorLineNumber.foreground": token("--fg-tertiary", "#858585"),
      "editorLineNumber.activeForeground": token("--fg-secondary", dark ? "#c6c6c6" : "#57606a"),
      "editorGutter.background": token("--code-bg", dark ? "#1e1e1e" : "#f6f6f6"),
      "editorMarkerNavigation.background": token("--bg-surface", dark ? "#252526" : "#ffffff"),
      ...(monacoTheme?.colors ?? {}),
    },
  });
}

function getOrCreateModel(
  filePath: string,
  language: string,
  content: string,
  root: string,
): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(filePath);
  const languageId = monacoLanguage(language, filePath);
  semanticContexts.set(uri.toString(), { root, filePath });
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getLanguageId() !== languageId) {
      monaco.editor.setModelLanguage(existing, languageId);
    }
    return existing;
  }
  return monaco.editor.createModel(content, languageId, uri);
}

function monacoLanguage(language: string, filePath: string): string {
  if (language === "typescriptreact") return "typescript";
  if (language === "javascriptreact") return "javascript";
  if (language === "plaintext") return "plaintext";
  if (language) return language;
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "ts" || extension === "tsx") return "typescript";
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") {
    return "javascript";
  }
  return "plaintext";
}

function toMarker(
  model: monaco.editor.ITextModel,
  diagnostic: IdeDiagnostic,
): monaco.editor.IMarkerData {
  const start = Math.max(0, diagnostic.start);
  const end = Math.min(model.getValueLength(), start + Math.max(1, diagnostic.length));
  const startPosition = model.getPositionAt(start);
  const endPosition = model.getPositionAt(end);
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: markerSeverity(diagnostic.severity),
    source: diagnostic.source,
    startLineNumber: startPosition.lineNumber,
    startColumn: startPosition.column,
    endLineNumber: endPosition.lineNumber,
    endColumn: Math.max(endPosition.column, startPosition.column + 1),
  };
}

function markerSeverity(severity: IdeDiagnostic["severity"]): monaco.MarkerSeverity {
  if (severity === "error") return monaco.MarkerSeverity.Error;
  if (severity === "warning") return monaco.MarkerSeverity.Warning;
  if (severity === "hint") return monaco.MarkerSeverity.Hint;
  return monaco.MarkerSeverity.Info;
}
