import type { ApprovalMode } from "@/chat/types";
import type { AspProvider } from "./desktop-api";

type AspAgent = AspProvider;

export const APPROVAL_MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

const APPROVAL_MODE_LABEL_KEYS: Record<ApprovalMode, string> = {
  suggest: "settings.approval.suggest",
  "auto-edit": "settings.approval.autoEdit",
  "full-auto": "settings.approval.fullAuto",
};

const APPROVAL_MODE_HINT_KEYS: Record<ApprovalMode, string> = {
  suggest: "settings.approval.suggestHint",
  "auto-edit": "settings.approval.autoEditHint",
  "full-auto": "settings.approval.fullAutoHint",
};

export function approvalModeLabelKeyForAgent(mode: ApprovalMode, agent?: AspAgent): string {
  return mode === "auto-edit" && isClaudeCodeAgent(agent)
    ? "settings.approval.claudeAuto"
    : APPROVAL_MODE_LABEL_KEYS[mode];
}

export function approvalModeHintKeyForAgent(mode: ApprovalMode, agent?: AspAgent): string {
  return mode === "auto-edit" && isClaudeCodeAgent(agent)
    ? "settings.approval.claudeAutoHint"
    : APPROVAL_MODE_HINT_KEYS[mode];
}

export function isClaudeCodeAgent(agent: AspAgent | undefined): boolean {
  if (!agent) return false;
  const capabilities = (agent.capabilities ?? {}) as Record<string, unknown>;
  const runtimeSignals = [capabilities.runtimeAdapter, capabilities.wireProtocol].map((value) =>
    String(value ?? "").toLowerCase(),
  );
  if (
    runtimeSignals.some((value) => value === "claude-code-stream-json" || value === "claude-code")
  ) {
    return true;
  }

  const commandName = executableName(agent.command);
  const identitySignals = [agent.id, agent.name, commandName].map((value) =>
    String(value ?? "").toLowerCase(),
  );
  return identitySignals.some(
    (value) =>
      value === "claude" ||
      value === "claude-code" ||
      value.includes("claude code") ||
      value.includes("claude-code"),
  );
}

function executableName(command: string | undefined): string {
  return (
    String(command ?? "")
      .split(/[\\/]/)
      .pop() ?? ""
  );
}
