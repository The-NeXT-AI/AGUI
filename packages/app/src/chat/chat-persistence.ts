import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { AspProvider, AspProviderCapabilities } from "@/asp/desktop-api";
import {
  readPersistentValue,
  removePersistentValue,
  writePersistentValue,
} from "@/storage/persistent-storage";
import { recordPayload } from "./chat-run-helpers";
import { providerSessionIdFromExtensionState, transcriptPathFromSession } from "./session-metadata";
import type { Attachment, ChatBlock, Session } from "./types";

const CHAT_PERSIST_DEBOUNCE_MS = 750;
const MAX_PERSISTED_DATA_URL_CHARS = 512 * 1024;

type DeferredPersistStorage<S> = PersistStorage<S> & { flush: () => void };

export function createDeferredJsonStorage<S>(): DeferredPersistStorage<S> | undefined {
  let pendingName: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    if (pendingName === null || pendingValue === null) return;
    clearTimer();
    const name = pendingName;
    const value = pendingValue;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      console.error("Chat state could not be serialized for persistence.", error);
      pendingName = null;
      pendingValue = null;
      return;
    }
    pendingName = null;
    pendingValue = null;
    void writePersistentValue(name, serialized).catch((error) => {
      console.error("Chat state persistence failed.", error);
    });
  };

  const scheduleFlush = () => {
    clearTimer();
    timer = setTimeout(flush, CHAT_PERSIST_DEBOUNCE_MS);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  return {
    getItem: async (name) => {
      const value = await readPersistentValue(name);
      return value ? (JSON.parse(value) as StorageValue<S>) : null;
    },
    setItem: (name, value) => {
      pendingName = name;
      pendingValue = value;
      scheduleFlush();
    },
    removeItem: (name) => {
      if (pendingName === name) {
        pendingName = null;
        pendingValue = null;
        clearTimer();
      }
      void removePersistentValue(name);
    },
    flush,
  };
}

export function providerSupportsTranscriptHistory(provider: AspProvider | undefined): boolean {
  return capabilitiesSupportTranscriptHistory(provider?.capabilities);
}

export function capabilitiesSupportTranscriptHistory(
  capabilities: AspProviderCapabilities | undefined,
): boolean {
  return Boolean(
    capabilities?.resumeSession || capabilities?.sessionHistory || capabilities?.sessions,
  );
}

export function sessionUsesTranscriptSource(session: Session, providers: AspProvider[]): boolean {
  const provider = providers.find((item) => item.id === session.providerId);
  return Boolean(
    (session.providerSessionId ||
      providerSessionIdFromExtensionState(session) ||
      transcriptPathFromSession(session)) &&
    (capabilitiesSupportTranscriptHistory(session.capabilities) ||
      capabilitiesSupportTranscriptHistory(provider?.capabilities)),
  );
}

export function persistableSession(session: Session, providers: AspProvider[]): Session {
  const baseSession = {
    ...session,
    transcriptLoading: undefined,
    blocks: persistableBlocks(session.blocks),
  };
  if (!sessionUsesTranscriptSource(baseSession, providers)) return baseSession;
  const providerSessionId =
    session.providerSessionId ||
    providerSessionIdFromExtensionState(session) ||
    transcriptPathFromSession(session);
  const extensionState = { ...(baseSession.extensionState ?? {}) };
  delete extensionState.events;
  return {
    ...baseSession,
    extensionState: {
      ...extensionState,
      session: {
        ...recordPayload(baseSession.extensionState?.session),
        providerSessionId,
        title: baseSession.title,
        cwd: baseSession.cwd,
      },
    },
  };
}

export function persistableBlocks(blocks: ChatBlock[]): ChatBlock[] {
  return blocks.map((block) => {
    if (block.kind === "user") {
      return {
        ...block,
        attachments: block.attachments?.map(persistableAttachment),
      };
    }
    if (block.kind === "image") {
      return {
        ...block,
        urls: block.urls.filter((url) => !isLargeDataImageUrl(url)),
      };
    }
    return block;
  });
}

export function persistableAttachment(attachment: Attachment): Attachment {
  if (!attachment.url || !isLargeDataImageUrl(attachment.url)) return attachment;
  const next = { ...attachment };
  delete next.url;
  return next;
}

export function isLargeDataImageUrl(value: string): boolean {
  return value.startsWith("data:image/") && value.length > MAX_PERSISTED_DATA_URL_CHARS;
}
