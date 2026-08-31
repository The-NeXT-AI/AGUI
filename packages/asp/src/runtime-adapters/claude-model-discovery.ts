import path from "node:path";
import { splitProviderCommand } from "../provider-store.js";
import type { AspModel } from "../types.js";
import {
  array,
  asError,
  nestedText,
  parseJson,
  rawText,
  record,
  runtimeEnvironment,
} from "./shared.js";

const CLAUDE_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies NonNullable<AspModel["supportedReasoningEfforts"]>;
const DEFAULT_SPEEDS = ["default"] as const satisfies NonNullable<AspModel["supportedSpeeds"]>;

export type ClaudeModelCliInput = {
  cwd: string;
  env?: Record<string, string>;
  provider: {
    args?: string[];
    command: string;
    env?: Record<string, string>;
  };
  runEnvironment?: Record<string, string | undefined>;
};

export async function claudeCliModels(input: ClaudeModelCliInput): Promise<AspModel[]> {
  return claudeInteractiveModelPickerModels(input);
}

async function claudeInteractiveModelPickerModels(input: ClaudeModelCliInput): Promise<AspModel[]> {
  const spawn = claudeModelDiscoverySpawn(input, ["--ax-screen-reader"]);
  if (!spawn) return [];
  const pty = await import("node-pty");
  const env = claudePtyEnvironment(input);
  return new Promise((resolve, reject) => {
    const child = pty.spawn(spawn.command, spawn.args, {
      cols: 240,
      cwd: input.cwd,
      env,
      name: "xterm-256color",
      rows: 80,
    });
    let output = "";
    let settled = false;
    const cleanupHandles: {
      dataDisposable?: { dispose(): void };
      exitDisposable?: { dispose(): void };
      retryTimer?: ReturnType<typeof setInterval>;
      submitTimer?: ReturnType<typeof setTimeout>;
      timeout?: ReturnType<typeof setTimeout>;
    } = {};
    const modelCommands = ["/models", "/model"];
    let modelCommandIndex = 0;
    let modelCommandAttempts = 0;
    let modelCommandOutputOffset = 0;
    let malformedModelCommandRecoveries = 0;
    let trustPromptAnswered = false;
    const cleanup = () => {
      if (cleanupHandles.submitTimer) clearTimeout(cleanupHandles.submitTimer);
      if (cleanupHandles.retryTimer) clearInterval(cleanupHandles.retryTimer);
      if (cleanupHandles.timeout) clearTimeout(cleanupHandles.timeout);
      cleanupHandles.dataDisposable?.dispose();
      cleanupHandles.exitDisposable?.dispose();
      try {
        child.write("\x1b");
      } catch {
        // The process may already be gone.
      }
      terminatePtyProcessGroup(child.pid);
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
    };
    const resolveOnce = (models: AspModel[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(models);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const parsePicker = () => {
      try {
        const models = claudeModelsFromInteractiveModelOutput(output);
        if (!models.length)
          throw new Error("Claude Code interactive model picker did not report any models.");
        resolveOnce(models);
      } catch (error) {
        rejectOnce(asError(error));
      }
    };
    const answerWorkspaceTrustPrompt = () => {
      if (trustPromptAnswered || !claudeWorkspaceTrustPromptVisible(output)) return false;
      trustPromptAnswered = true;
      modelCommandAttempts = 0;
      modelCommandOutputOffset = output.length;
      try {
        child.write("y\r");
        return true;
      } catch (error) {
        rejectOnce(asError(error));
        return true;
      }
    };
    const sendModelCommand = () => {
      if (settled || modelCommandAttempts >= 4) return;
      if (answerWorkspaceTrustPrompt()) return;
      if (!claudePromptReady(output)) return;
      const cleaned = claudeStripTerminalControl(output.slice(modelCommandOutputOffset));
      if (/^Select model$/im.test(cleaned)) return;
      const activeCommand = modelCommands[modelCommandIndex] ?? "/model";
      if (claudeUnknownModelSlashCommand(cleaned, activeCommand) && modelCommandIndex === 0) {
        modelCommandIndex = 1;
        modelCommandAttempts = 0;
        modelCommandOutputOffset = output.length;
      } else if (claudeModelPromptSubmitted(cleaned, activeCommand)) {
        if (malformedModelCommandRecoveries >= 2) return;
        malformedModelCommandRecoveries += 1;
        modelCommandAttempts = 0;
        modelCommandOutputOffset = output.length;
        try {
          child.write("\x1b");
          child.write("\x15");
        } catch (error) {
          rejectOnce(asError(error));
        }
        return;
      } else if (claudeModelSlashCommandSubmitted(cleaned, activeCommand)) {
        return;
      }
      modelCommandAttempts += 1;
      try {
        child.write("\x15");
        child.write(`${modelCommands[modelCommandIndex] ?? "/model"}\r`);
      } catch (error) {
        rejectOnce(asError(error));
      }
    };
    cleanupHandles.submitTimer = setTimeout(sendModelCommand, 1_500);
    cleanupHandles.retryTimer = setInterval(() => {
      if (claudeInteractiveModelPickerComplete(output)) return;
      sendModelCommand();
    }, 2_000);
    cleanupHandles.timeout = setTimeout(() => {
      rejectOnce(new Error("Claude Code interactive model picker timed out."));
    }, 40_000);
    cleanupHandles.dataDisposable = child.onData((chunk) => {
      output += chunk;
      if (answerWorkspaceTrustPrompt()) return;
      if (claudeInteractiveModelPickerComplete(output)) parsePicker();
    });
    cleanupHandles.exitDisposable = child.onExit(() => {
      if (settled) return;
      const models = claudeModelsFromInteractiveModelOutput(output);
      if (models.length) resolveOnce(models);
      else
        rejectOnce(
          new Error("Claude Code interactive model picker exited before reporting models."),
        );
    });
  });
}

function terminatePtyProcessGroup(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group may already be gone.
    }
  }, 1_000);
  killTimer.unref?.();
}

function claudeModelDiscoverySpawn(
  input: ClaudeModelCliInput,
  runtimeArgs: string[],
): { command: string; args: string[] } | null {
  const commandParts = splitProviderCommand(input.provider.command);
  const command = commandParts[0] ?? "";
  if (!command) return null;
  return { command, args: claudeModelDiscoveryArguments(input.provider, runtimeArgs) };
}

function claudePtyEnvironment(input: ClaudeModelCliInput): Record<string, string> {
  const environment = runtimeEnvironment(input.provider.env, input.env, input.runEnvironment);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function claudeRuntimeArguments(
  provider: ClaudeModelCliInput["provider"],
  runtimeArgs: string[],
): string[] {
  const providerArgs = provider.args ?? [];
  if (!isCcrAppClaudeProvider(provider)) return [...providerArgs, ...runtimeArgs];
  const commandArgs = splitProviderCommand(provider.command).slice(1);
  const hasAgentArgumentSeparator = commandArgs.includes("--") || providerArgs.includes("--");
  return [...providerArgs, ...(hasAgentArgumentSeparator ? [] : ["--"]), ...runtimeArgs];
}

function claudeSpawnArguments(
  provider: ClaudeModelCliInput["provider"],
  runtimeArgs: string[],
): string[] {
  const commandArgs = splitProviderCommand(provider.command).slice(1);
  return [...commandArgs, ...claudeRuntimeArguments(provider, runtimeArgs)];
}

function claudeModelDiscoveryArguments(
  provider: ClaudeModelCliInput["provider"],
  runtimeArgs: string[],
): string[] {
  const commandArgs = splitProviderCommand(provider.command).slice(1);
  if (!isCcrAppClaudeProvider(provider))
    return [...commandArgs, ...claudeRuntimeArguments(provider, runtimeArgs)];
  return ccrAppClaudeModelDiscoveryArguments(commandArgs, provider.args ?? [], runtimeArgs);
}

function ccrAppClaudeModelDiscoveryArguments(
  commandArgs: string[],
  providerArgs: string[],
  runtimeArgs: string[],
): string[] {
  const args = [...commandArgs, ...providerArgs.map(String)];
  const separator = args.indexOf("--");
  const launcherArgs = separator >= 0 ? args.slice(0, separator) : args;
  const agentArgs = separator >= 0 ? args.slice(separator + 1) : [];
  const cliLauncherArgs = ccrAppCliLauncherArguments(launcherArgs);
  return [...cliLauncherArgs, "--", ...agentArgs, ...runtimeArgs];
}

function ccrAppCliLauncherArguments(args: string[]): string[] {
  let hasSurface = false;
  const result = args.map((arg) => {
    if (arg === "app") {
      hasSurface = true;
      return "cli";
    }
    if (arg === "--app") {
      hasSurface = true;
      return "--cli";
    }
    if (arg === "cli" || arg === "--cli") hasSurface = true;
    return arg;
  });
  return hasSurface ? result : [...result, "cli"];
}

function isCcrAppClaudeProvider(provider: ClaudeModelCliInput["provider"]): boolean {
  const command = splitProviderCommand(provider.command)[0] ?? "";
  const executable = path.basename(command).replace(/\.(?:cjs|js|mjs|exe)$/i, "");
  return executable.endsWith("ccr-app");
}

function claudeInteractiveModelPickerComplete(output: string): boolean {
  return /Enter selection \[\d+-\d+\],\s*or Escape to cancel:/i.test(
    claudeStripTerminalControl(output),
  );
}

function claudeUnknownModelSlashCommand(output: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Unknown command:\\s*${escaped}\\b`, "i").test(output);
}

function claudeModelSlashCommandSubmitted(output: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`you:\\s*${escaped}\\b`, "i").test(output);
}

function claudeModelPromptSubmitted(output: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`you:\\s*${escaped}\\S`, "i").test(output);
}

function claudePromptReady(output: string): boolean {
  const cleaned = claudeStripTerminalControl(output);
  if (!/Claude Code v\d/i.test(cleaned)) return false;
  return (
    /\besc to interrupt\b/i.test(cleaned) ||
    /\bmanual mode on\b/i.test(cleaned) ||
    /\beffort:\s*\w+\s+·\s+\/effort\b/i.test(cleaned) ||
    /(?:^|\n)\s*[$›>]\s*$/m.test(cleaned)
  );
}

function claudeWorkspaceTrustPromptVisible(output: string): boolean {
  const cleaned = claudeStripTerminalControl(output);
  return (
    /Permission Required:\s*Accessing workspace:/i.test(cleaned) &&
    /Is this a project .* you trust\?/i.test(cleaned) &&
    /Enter y\/n:/i.test(cleaned)
  );
}

function claudeModelsFromInteractiveModelOutput(output: string): AspModel[] {
  const cleaned = claudeStripTerminalControl(output)
    .replace(/\r/g, "\n")
    .split("\n")
    .map(claudeNormalizeInteractiveLine)
    .filter(Boolean);
  const entries = claudeInteractiveModelEntries(cleaned, true);
  const fallbackEntries = entries.length ? entries : claudeInteractiveModelEntries(cleaned, false);
  const hasSelectedEntry = fallbackEntries.some((entry) => entry.selected);
  const seen = new Set<string>();
  const models = fallbackEntries
    .map((entry) => {
      const model = claudeInteractiveModelId(entry.displayName);
      return {
        ...(entry.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: entry.contextWindowTokens }),
        ...claudeInteractiveModelCapabilities(),
        id: model,
        model,
        displayName: entry.displayName,
        isDefault: entry.selected || (!hasSelectedEntry && model === "default"),
      };
    })
    .filter((model) => !seen.has(model.model) && seen.add(model.model));
  return fillMissingModelContextWindows(models);
}

function claudeInteractiveModelCapabilities(): Pick<
  AspModel,
  "defaultReasoningEffort" | "supportedReasoningEfforts" | "supportedSpeeds"
> {
  return {
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [...CLAUDE_REASONING_EFFORTS],
    supportedSpeeds: [...DEFAULT_SPEEDS],
  };
}

function claudeNormalizeInteractiveLine(line: string): string {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function claudeInteractiveModelEntries(
  lines: string[],
  requirePickerMarker: boolean,
): Array<{ contextWindowTokens?: number; displayName: string; selected: boolean }> {
  const entries: Array<{ contextWindowTokens?: number; displayName: string; selected: boolean }> =
    [];
  let inPicker = !requirePickerMarker;
  for (const line of lines) {
    if (/^Select model$/i.test(line)) {
      inPicker = true;
      continue;
    }
    if (!inPicker) continue;
    if (/^Enter selection \[\d+-\d+\]/i.test(line)) break;
    const match = line.match(/^\d+\.\s+(.+)$/);
    if (!match) continue;
    const rawLabel = (match[1] ?? "").trim();
    const selected = /^\(selected\)\s+/i.test(rawLabel);
    const label = rawLabel.replace(/^\(selected\)\s+/i, "");
    const displayName = claudeInteractiveModelDisplayName(label);
    if (displayName) {
      const contextWindowTokens = claudeInteractiveModelContextWindowTokens(label);
      entries.push({
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        displayName,
        selected,
      });
    }
  }
  return entries;
}

function claudeInteractiveModelDisplayName(label: string): string {
  return (
    label
      .split(/\s+[—–]\s+/)[0]
      ?.split(/\s+·\s+/)[0]
      ?.trim() ?? ""
  );
}

function claudeInteractiveModelId(displayName: string): string {
  const oneMillion = /\s+\(1M context\)$/i.test(displayName);
  const baseDisplayName = displayName.replace(/\s+\(1M context\)$/i, "").trim();
  const builtin = claudeBuiltinInteractiveModelAlias(baseDisplayName, oneMillion);
  if (builtin) return builtin;
  return displayName;
}

function claudeBuiltinInteractiveModelAlias(baseDisplayName: string, oneMillion: boolean): string {
  if (/^default(?:\s+\(recommended\))?$/i.test(baseDisplayName)) return "default";
  if (/^best$/i.test(baseDisplayName)) return "best";
  if (/^opus\s+plan\b/i.test(baseDisplayName)) return oneMillion ? "opusplan[1m]" : "opusplan";
  if (/^opus\b/i.test(baseDisplayName)) return oneMillion ? "opus[1m]" : "opus";
  if (/^sonnet\b/i.test(baseDisplayName)) return oneMillion ? "sonnet[1m]" : "sonnet";
  if (/^haiku\b/i.test(baseDisplayName)) return oneMillion ? "haiku[1m]" : "haiku";
  if (/^fable\b/i.test(baseDisplayName)) return oneMillion ? "fable[1m]" : "fable";
  return "";
}

function claudeInteractiveModelContextWindowTokens(label: string): number | undefined {
  const normalized = label.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
  const explicit = firstContextWindowMatch(
    normalized,
    /\bcontext(?:\s+window|\s+limit)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*([kKmMbB])\b/,
    /\b(\d+(?:\.\d+)?)\s*([kKmMbB])\s+context\s+window\b/,
    /\b(\d+(?:\.\d+)?)\s*([kKmMbB])\s*(?:tokens?|context)\b/,
  );
  if (explicit !== undefined) return explicit;
  const model = claudeInteractiveModelId(claudeInteractiveModelDisplayName(label)).toLowerCase();
  if (model.endsWith("[1m]")) return 1_000_000;
  if (/^(best|default|fable|haiku|opus|opusplan|sonnet)(?:\[1m\])?$/.test(model)) {
    return 200_000;
  }
  return undefined;
}

function fillMissingModelContextWindows(models: AspModel[]): AspModel[] {
  const windowByBaseName = new Map<string, number>();
  for (const model of models) {
    if (!model.contextWindowTokens) continue;
    for (const value of modelIdentityValues(model)) {
      const key = modelContextBaseName(value);
      if (key && !windowByBaseName.has(key)) windowByBaseName.set(key, model.contextWindowTokens);
    }
  }
  return models.map((model) => {
    if (model.contextWindowTokens) return model;
    const contextWindowTokens = modelIdentityValues(model)
      .map((value) => windowByBaseName.get(modelContextBaseName(value)))
      .find((value) => value !== undefined);
    return contextWindowTokens ? { ...model, contextWindowTokens } : model;
  });
}

function modelIdentityValues(model: AspModel): string[] {
  return [model.id, model.model, model.displayName].filter((value): value is string =>
    Boolean(value),
  );
}

function modelContextBaseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\bcontext\b[^)]*\)/gi, "")
    .replace(/\b\d+(?:\.\d+)?\s*[kmb]\s+context\s+window\b/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstContextWindowMatch(value: string, ...patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const parsed = match ? scaledTokenCount(match[1] ?? "", match[2] ?? "") : undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function scaledTokenCount(value: string, unit: string): number | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const normalizedUnit = unit.toLowerCase();
  const multiplier =
    normalizedUnit === "b" ? 1_000_000_000 : normalizedUnit === "m" ? 1_000_000 : 1_000;
  return Math.round(amount * multiplier);
}

function claudeStripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b/g, "");
}

export function claudeErrorMessage(message: Record<string, unknown>): string {
  const errors = array(message.errors)
    .map(
      (item) =>
        diagnosticText(rawText(item)) ||
        diagnosticText(nestedText(item, "error", "message")) ||
        diagnosticText(nestedText(item, "message", "content")),
    )
    .filter(Boolean);
  if (errors.length) return errors.join("; ");
  const details =
    diagnosticText(rawText(message.result)) ||
    diagnosticText(nestedText(message, "message", "content")) ||
    diagnosticText(nestedText(message, "message", "error")) ||
    diagnosticText(nestedText(message, "error", "message"));
  if (details) return details;
  const error = diagnosticText(rawText(message.error));
  if (error && !isClaudeGenericErrorCode(error)) return error;
  return diagnosticText(rawText(message.message)) || error || "";
}

function diagnosticText(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return /^(unknown|undefined|null)$/i.test(trimmed) ? "" : trimmed;
}

function isClaudeGenericErrorCode(value: string): boolean {
  return /^(authentication_failed|invalid_request|max_output_tokens|rate_limit|server_error|unknown)$/i.test(
    value.trim(),
  );
}

export function claudeTextDiagnosticError(chunk: string): string {
  const text = chunk.trim();
  if (!text) return "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJson(trimmed);
    if (parsed && typeof parsed === "object") {
      const message = claudeErrorMessage(record(parsed));
      if (message && (isClaudeAuthenticationError(message) || record(parsed).is_error === true)) {
        return message;
      }
    }
    if (isClaudeAuthenticationError(trimmed)) return trimmed;
  }
  return "";
}

export function isClaudeAuthenticationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\b401\b/.test(normalized) ||
    /\b403\b/.test(normalized) ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("api key is missing") ||
    normalized.includes("missing api key") ||
    normalized.includes("identity token file") ||
    normalized.includes("failed to read identity token") ||
    normalized.includes("authentication failed") ||
    normalized.includes("auth failed") ||
    normalized.includes("invalid token")
  );
}

export function sanitizeClaudeDiagnostic(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(api[_-]?key|apikey|authorization|x-api-key)(["'\s:=]+)([^"'\s,}]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,})\b/g, "[REDACTED]")
    .trim();
}
