import type { PersistStorage, StorageValue } from "zustand/middleware";
import { desktopApi } from "@/asp/desktop-api";

const DEFAULT_NAMESPACE = "renderer";

export function createPersistentJsonStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      const raw = await readPersistentValue(name);
      return raw ? (JSON.parse(raw) as StorageValue<S>) : null;
    },
    setItem: async (name, value) => {
      await writePersistentValue(name, JSON.stringify(value));
    },
    removeItem: async (name) => {
      await removePersistentValue(name);
    },
  };
}

export async function readPersistentValue(name: string): Promise<string | null> {
  const api = desktopApi()?.storage;
  if (!api) return null;
  const stored = await api.get({ key: name, namespace: DEFAULT_NAMESPACE });
  if (stored !== null) return stored;
  return migrateLegacyLocalStorageValue(api, name);
}

export async function writePersistentValue(name: string, value: string): Promise<void> {
  const api = desktopApi()?.storage;
  if (!api) return;
  await api.set({ key: name, namespace: DEFAULT_NAMESPACE, value });
}

export async function removePersistentValue(name: string): Promise<void> {
  const api = desktopApi()?.storage;
  if (!api) return;
  await api.remove({ key: name, namespace: DEFAULT_NAMESPACE });
  removeLegacyLocalStorageValue(name);
}

async function migrateLegacyLocalStorageValue(
  api: NonNullable<ReturnType<typeof desktopApi>>["storage"],
  name: string,
): Promise<string | null> {
  const legacy = legacyLocalStorage()?.getItem(name) ?? null;
  if (legacy === null) return null;
  await api.set({ key: name, namespace: DEFAULT_NAMESPACE, value: legacy });
  removeLegacyLocalStorageValue(name);
  return legacy;
}

function removeLegacyLocalStorageValue(name: string): void {
  legacyLocalStorage()?.removeItem(name);
}

function legacyLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
