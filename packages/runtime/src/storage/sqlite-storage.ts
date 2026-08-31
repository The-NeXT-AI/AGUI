import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type sqlite3 from "sqlite3";
import type {
  AppStorage,
  AppStorageGetInput,
  AppStorageListInput,
  AppStorageOptions,
  AppStorageRecord,
  AppStorageSetInput,
} from "./types.js";
import {
  configuredSqlitePath,
  normalizeGetInput,
  normalizeListInput,
  normalizeSetInput,
} from "./storage-utils.js";

const require = createRequire(import.meta.url);
const Sqlite3 = require("sqlite3") as typeof sqlite3;
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

type SqliteRow = {
  key: string;
  namespace: string;
  updated_at: number;
  value: string;
};

type RunResult = {
  changes: number;
  lastID: number;
};

type SharedSqliteConnection = {
  db: sqlite3.Database;
  filePath: string;
  ready: Promise<void>;
  refs: number;
  closing?: Promise<void>;
};

const sqliteConnections = new Map<string, SharedSqliteConnection>();

export class SqliteAppStorage implements AppStorage {
  readonly backend = "sqlite" as const;
  private readonly connection: SharedSqliteConnection;
  private readonly db: sqlite3.Database;
  private readonly namespace: string | undefined;
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(options: AppStorageOptions) {
    const filePath = configuredSqlitePath(options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.connection = acquireSqliteConnection(filePath);
    this.db = this.connection.db;
    this.namespace = options.namespace;
    this.ready = this.connection.ready;
  }

  async get(input: AppStorageGetInput): Promise<string | null> {
    await this.ready;
    const { key, namespace } = normalizeGetInput(input, this.namespace);
    const row = await this.getRow<Pick<SqliteRow, "value">>(
      "SELECT value FROM agui_kv WHERE namespace = ? AND key = ?",
      [namespace, key],
    );
    return row?.value ?? null;
  }

  async set(input: AppStorageSetInput): Promise<boolean> {
    await this.ready;
    const { key, namespace, value } = normalizeSetInput(input, this.namespace);
    await this.run(
      `INSERT INTO agui_kv(namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [namespace, key, value, Date.now()],
    );
    return true;
  }

  async remove(input: AppStorageGetInput): Promise<boolean> {
    await this.ready;
    const { key, namespace } = normalizeGetInput(input, this.namespace);
    const result = await this.run("DELETE FROM agui_kv WHERE namespace = ? AND key = ?", [
      namespace,
      key,
    ]);
    return result.changes > 0;
  }

  async list(input?: AppStorageListInput): Promise<AppStorageRecord[]> {
    await this.ready;
    const { namespace, prefix } = normalizeListInput(input, this.namespace);
    const rows = prefix
      ? await this.all<SqliteRow>(
          `SELECT namespace, key, value, updated_at
           FROM agui_kv
           WHERE namespace = ? AND key LIKE ? ESCAPE '\\'
           ORDER BY key`,
          [namespace, `${escapeLike(prefix)}%`],
        )
      : await this.all<SqliteRow>(
          `SELECT namespace, key, value, updated_at
           FROM agui_kv
           WHERE namespace = ?
           ORDER BY key`,
          [namespace],
        );
    return rows.map((row) => ({
      key: row.key,
      namespace: row.namespace,
      updatedAt: row.updated_at,
      value: row.value,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await releaseSqliteConnection(this.connection);
  }

  private run(sql: string, params: unknown[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (this: RunResult, error: Error | null) {
        if (error) reject(error);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  private getRow<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (error, row: T | undefined) =>
        error ? reject(error) : resolve(row),
      );
    });
  }

  private all<T>(sql: string, params: unknown[]): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (error, rows: T[]) => (error ? reject(error) : resolve(rows)));
    });
  }
}

function acquireSqliteConnection(filePath: string): SharedSqliteConnection {
  const existing = sqliteConnections.get(filePath);
  if (existing && !existing.closing) {
    existing.refs += 1;
    return existing;
  }

  const db = new Sqlite3.Database(filePath);
  db.configure("busyTimeout", SQLITE_BUSY_TIMEOUT_MS);
  db.serialize();
  const connection: SharedSqliteConnection = {
    db,
    filePath,
    ready: initializeSqliteDatabase(db),
    refs: 1,
  };
  sqliteConnections.set(filePath, connection);
  return connection;
}

async function releaseSqliteConnection(connection: SharedSqliteConnection): Promise<void> {
  connection.refs -= 1;
  if (connection.refs > 0) return;
  if (!connection.closing) {
    connection.closing = connection.ready
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            connection.db.close((error) => (error ? reject(error) : resolve()));
          }),
      )
      .finally(() => {
        if (sqliteConnections.get(connection.filePath) === connection) {
          sqliteConnections.delete(connection.filePath);
        }
      });
  }
  await connection.closing;
}

async function initializeSqliteDatabase(db: sqlite3.Database): Promise<void> {
  await execSqlite(
    db,
    `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agui_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS agui_kv_namespace_updated_at
      ON agui_kv(namespace, updated_at);
  `,
  );
}

function execSqlite(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
