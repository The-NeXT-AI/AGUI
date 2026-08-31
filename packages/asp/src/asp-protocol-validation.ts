import {
  assertAspClientMessage,
  assertAspCoreEvent,
  assertAspExtensionEvent,
  assertAspRpcResponse,
} from "./asp-schema.js";

const coreEventTypes = new Set([
  "run_started",
  "message_delta",
  "message_part",
  "tool_event",
  "session_state",
  "approval_request",
  "question_request",
  "extension_event",
  "usage",
  "stdout",
  "stderr",
  "error",
  "run_finished",
]);

export function isCoreEventType(value: string): boolean {
  return coreEventTypes.has(value);
}

export function assertCanonicalAspEvent(event: Record<string, unknown>): void {
  const type = typeof event.type === "string" ? event.type : String(event.type ?? "");
  if (!isCoreEventType(type)) return;
  if (type === "extension_event") {
    assertAspExtensionEvent(event);
    return;
  }
  assertAspCoreEvent(event);
}

export function validatedClientMessage(message: Record<string, unknown>): Record<string, unknown> {
  if (
    !message.type &&
    (Object.prototype.hasOwnProperty.call(message, "result") ||
      Object.prototype.hasOwnProperty.call(message, "error"))
  ) {
    assertAspRpcResponse(message);
  } else {
    assertAspClientMessage(message);
  }
  return message;
}
