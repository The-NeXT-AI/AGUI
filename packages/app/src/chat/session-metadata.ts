import type { Session } from "./types";

export function providerSessionIdFromExtensionState(session: Session): string {
  const state = recordPayload(session.extensionState?.session);
  return (
    stringPayload(state.providerSessionId) ||
    stringPayload(state.provider_session_id) ||
    stringPayload(state.sessionId) ||
    stringPayload(state.session_id) ||
    stringPayload(state.threadId) ||
    stringPayload(state.thread_id)
  );
}

export function transcriptPathFromSession(session: Session): string {
  const state = recordPayload(session.extensionState?.session);
  const metadata = recordPayload(state.metadata);
  return (
    stringPayload(state.transcriptPath) ||
    stringPayload(state.transcript_path) ||
    stringPayload(metadata.transcriptPath) ||
    stringPayload(metadata.transcript_path) ||
    stringPayload(metadata.path)
  );
}

export function actionableProviderSessionId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  return isPlaceholderProviderSessionId(id) ? "" : id;
}

export function isPlaceholderProviderSessionId(value: string): boolean {
  return value === "claude-session" || value === "codex-thread";
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
