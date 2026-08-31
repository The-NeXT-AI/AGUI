import type { AppStorage, AppStorageOptions } from "./types.js";
import { PostgresAppStorage } from "./postgres-storage.js";
import { SqliteAppStorage } from "./sqlite-storage.js";
import { configuredStorageBackend } from "./storage-utils.js";

export * from "./types.js";

export function createAppStorage(options: AppStorageOptions): AppStorage {
  const backend = configuredStorageBackend(options);
  if (backend === "postgres") return new PostgresAppStorage(options);
  return new SqliteAppStorage(options);
}
