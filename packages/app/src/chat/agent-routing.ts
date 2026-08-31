import type { Session, SessionEvent } from "./types";

/** Resolve an event to the run that owned it; `null` means it belongs to a stale run. */
export function providerIdForSessionEvent(session: Session, event: SessionEvent): string | null {
  if (event.runId && event.runId !== session.activeRunId) return null;
  return event.agentProviderId ?? session.activeRunProviderId ?? session.providerId;
}
