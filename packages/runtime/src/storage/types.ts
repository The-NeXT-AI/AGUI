export type AppStorageBackend = "sqlite" | "postgres";

export type AppStorageRecord = {
  key: string;
  namespace: string;
  updatedAt: number;
  value: string;
};

export type AppStorageGetInput = {
  key: string;
  namespace?: string;
};

export type AppStorageSetInput = AppStorageGetInput & {
  value: string;
};

export type AppStorageListInput = {
  namespace?: string;
  prefix?: string;
};

export type AppStorageOptions = {
  backend?: AppStorageBackend;
  env?: NodeJS.ProcessEnv;
  namespace?: string;
  postgresUrl?: string;
  sqlitePath?: string;
  userDataPath: string | (() => string);
};

export interface AppStorage {
  backend: AppStorageBackend;
  close(): Promise<void> | void;
  get(input: AppStorageGetInput): Promise<string | null>;
  list(input?: AppStorageListInput): Promise<AppStorageRecord[]>;
  remove(input: AppStorageGetInput): Promise<boolean>;
  set(input: AppStorageSetInput): Promise<boolean>;
}

export const DEFAULT_APP_STORAGE_NAMESPACE = "app";
