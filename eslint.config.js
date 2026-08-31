import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const browserGlobals = {
  CSSStyleSheet: "readonly",
  CustomEvent: "readonly",
  DOMParser: "readonly",
  Event: "readonly",
  EventSource: "readonly",
  File: "readonly",
  FileReader: "readonly",
  HTMLDivElement: "readonly",
  HTMLIFrameElement: "readonly",
  HTMLInputElement: "readonly",
  HTMLTextAreaElement: "readonly",
  HTMLElement: "readonly",
  Image: "readonly",
  KeyboardEvent: "readonly",
  MouseEvent: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
  Worker: "readonly",
  atob: "readonly",
  btoa: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  crypto: "readonly",
  document: "readonly",
  fetch: "readonly",
  localStorage: "readonly",
  navigator: "readonly",
  requestAnimationFrame: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  window: "readonly",
};

const nodeGlobals = {
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  global: "readonly",
  globalThis: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/coverage/**",
      "**/.vite/**",
      "**/.astro/**",
      "**/*.tsbuildinfo",
      "reference/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,cts,mts}"],
    languageOptions: {
      globals: {
        ...browserGlobals,
        ...nodeGlobals,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-control-regex": "off",
      "no-undef": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      sourceType: "module",
    },
    rules: {
      "no-control-regex": "off",
      "no-undef": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["packages/app/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-refresh/only-export-components": "off",
    },
  },
);
