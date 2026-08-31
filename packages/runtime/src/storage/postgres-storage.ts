import { createRequire } from "node:module";
import type pg from "pg";
import type {
  AppStorage,
  AppStorageGetInput,
  AppStorageListInput,
  AppStorageOptions,
  AppStorageRecord,
  AppStorageSetInput,
} from "./types.js";
import {
  configuredPostgresUrl,
  normalizeGetInput,
  normalizeListInput,
  normalizeSetInput,
} from "./storage-utils.js";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof pg;

type PostgresRow = {
  key: string;
  namespace: string;
  updated_at: string | number;
  value: string;
};

export class PostgresAppStorage implements AppStorage {
  readonly backend = "postgres" as const;
  private readonly namespace: string | undefined;
  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;

  constructor(options: AppStorageOptions) {
    this.namespace = options.namespace;
    this.pool = new Pool({ connectionString: configuredPostgresUrl(options) });
    this.ready = this.initialize();
  }

  async get(input: AppStorageGetInput): Promise<string | null> {
    await this.ready;
    const { key, namespace } = normalizeGetInput(input, this.namespace);
    const result = await this.pool.query<Pick<PostgresRow, "value">>(
      "SELECT value FROM agui_kv WHERE namespace = $1 AND key = $2",
      [namespace, key],
    );
    return result.rows[0]?.value ?? null;
  }

  async set(input: AppStorageSetInput): Promise<boolean> {
    await this.ready;
    const { key, namespace, value } = normalizeSetInput(input, this.namespace);
    await this.pool.query(
      `INSERT INTO agui_kv(namespace, key, value, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [namespace, key, value, Date.now()],
    );
    return true;
  }

  async remove(input: AppStorageGetInput): Promise<boolean> {
    await this.ready;
    const { key, namespace } = normalizeGetInput(input, this.namespace);
    const result = await this.pool.query("DELETE FROM agui_kv WHERE namespace = $1 AND key = $2", [
      namespace,
      key,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async list(input?: AppStorageListInput): Promise<AppStorageRecord[]> {
    await this.ready;
    const { namespace, prefix } = normalizeListInput(input, this.namespace);
    const result = prefix
      ? await this.pool.query<PostgresRow>(
          `SELECT namespace, key, value, updated_at
           FROM agui_kv
           WHERE namespace = $1 AND key LIKE $2 ESCAPE '\\'
           ORDER BY key`,
          [namespace, `${escapeLike(prefix)}%`],
        )
      : await this.pool.query<PostgresRow>(
          `SELECT namespace, key, value, updated_at
           FROM agui_kv
           WHERE namespace = $1
           ORDER BY key`,
          [namespace],
        );
    return result.rows.map((row) => ({
      key: row.key,
      namespace: row.namespace,
      updatedAt: Number(row.updated_at),
      value: row.value,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agui_kv (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS agui_kv_namespace_updated_at
        ON agui_kv(namespace, updated_at);
    `);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
