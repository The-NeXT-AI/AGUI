import path from "node:path";
import type {
  AppStorageBackend,
  AppStorageGetInput,
  AppStorageListInput,
  AppStorageOptions,
  AppStorageSetInput,
} from "./types.js";
import { DEFAULT_APP_STORAGE_NAMESPACE } from "./types.js";

const KEY_MAX_LENGTH = 1024;
const NAMESPACE_MAX_LENGTH = 128;
const VALUE_MAX_BYTES = 32 * 1024 * 1024;

export function configuredStorageBackend(
  options: Pick<AppStorageOptions, "backend" | "env">,
): AppStorageBackend {
  const env = options.env ?? process.env;
  const value = (
    options.backend ??
    env.AG_UI_STORAGE_BACKEND ??
    env.AGUI_STORAGE_BACKEND ??
    "sqlite"
  )
    .toString()
    .trim()
    .toLowerCase();
  if (value === "postgres" || value === "postgresql") return "postgres";
  return "sqlite";
}

export function configuredSqlitePath(options: AppStorageOptions): string {
  const env = options.env ?? process.env;
  const configured = options.sqlitePath ?? env.AG_UI_SQLITE_PATH ?? env.AGUI_SQLITE_PATH;
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.join(configuredUserDataPath(options.userDataPath), "agui.sqlite3");
}

export function configuredPostgresUrl(options: AppStorageOptions): string {
  const env = options.env ?? process.env;
  const url =
    options.postgresUrl ??
    env.AG_UI_POSTGRES_URL ??
    env.AGUI_POSTGRES_URL ??
    env.POSTGRES_URL ??
    env.DATABASE_URL;
  if (!url?.trim()) {
    throw new Error(
      "Postgres storage requires AG_UI_POSTGRES_URL, AGUI_POSTGRES_URL, POSTGRES_URL, or DATABASE_URL.",
    );
  }
  return url.trim();
}

export function normalizeGetInput(
  input: AppStorageGetInput,
  defaultNamespace?: string,
): Required<AppStorageGetInput> {
  const namespace = normalizeNamespace(input.namespace, defaultNamespace);
  const key = normalizeStorageKey(input.key);
  return { key, namespace };
}

export function normalizeSetInput(
  input: AppStorageSetInput,
  defaultNamespace?: string,
): Required<AppStorageSetInput> {
  const normalized = normalizeGetInput(input, defaultNamespace);
  if (typeof input.value !== "string") throw new Error("Storage value must be a string.");
  if (Buffer.byteLength(input.value, "utf8") > VALUE_MAX_BYTES) {
    throw new Error("Storage value exceeds the 32 MB limit.");
  }
  return { ...normalized, value: input.value };
}

export function normalizeListInput(
  input: AppStorageListInput | undefined,
  defaultNamespace?: string,
): Required<AppStorageListInput> {
  const namespace = normalizeNamespace(input?.namespace, defaultNamespace);
  const prefix = typeof input?.prefix === "string" ? input.prefix : "";
  if (prefix.length > KEY_MAX_LENGTH) throw new Error("Storage key prefix is too long.");
  return { namespace, prefix };
}

function normalizeNamespace(value: string | undefined, defaultNamespace?: string): string {
  const namespace = (value || defaultNamespace || DEFAULT_APP_STORAGE_NAMESPACE).trim();
  if (
    !namespace ||
    namespace.length > NAMESPACE_MAX_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(namespace)
  ) {
    throw new Error("Storage namespace must be 1-128 safe characters.");
  }
  return namespace;
}

function normalizeStorageKey(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > KEY_MAX_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error("Storage key must be 1-1024 printable characters.");
  }
  return value;
}

function configuredUserDataPath(value: string | (() => string)): string {
  const resolved = typeof value === "function" ? value() : value;
  if (!resolved.trim()) throw new Error("Storage requires a user data path.");
  return path.resolve(resolved);
}
