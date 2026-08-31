declare module "monaco-editor/basic-languages/monaco.contribution";
declare module "monaco-editor/language/css/monaco.contribution";
declare module "monaco-editor/language/html/monaco.contribution";
declare module "monaco-editor/language/json/monaco.contribution";

declare module "monaco-editor/language/typescript/monaco.contribution" {
  type DiagnosticsOptions = {
    noSemanticValidation?: boolean;
    noSyntaxValidation?: boolean;
    noSuggestionDiagnostics?: boolean;
  };
  type LanguageServiceDefaults = {
    setDiagnosticsOptions(options: DiagnosticsOptions): void;
  };
  export const javascriptDefaults: LanguageServiceDefaults;
  export const typescriptDefaults: LanguageServiceDefaults;
}
