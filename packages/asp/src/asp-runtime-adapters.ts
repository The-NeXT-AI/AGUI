import type { AspTransportConnection, ConnectAspInput } from "./asp-transport.js";
import { ClaudeRuntimeConnection } from "./runtime-adapters/claude-connection.js";
import { CodexRuntimeConnection } from "./runtime-adapters/codex-connection.js";
import { HeadlessCliRuntimeConnection } from "./runtime-adapters/headless-cli-connection.js";
import { OpenCodeRuntimeConnection } from "./runtime-adapters/open-code-connection.js";
import { PiRuntimeConnection } from "./runtime-adapters/pi-connection.js";
import { text } from "./runtime-adapters/shared.js";

export type AspRuntimeAdapterFactory = (
  input: ConnectAspInput,
) => AspTransportConnection | undefined;

const runtimeAdapterFactories = new Map<string, AspRuntimeAdapterFactory>();

export function registerRuntimeAdapter(
  ids: string | string[],
  factory: AspRuntimeAdapterFactory,
): () => void {
  const normalizedIds = [...new Set([ids].flat().map(normalizeRuntimeAdapterId).filter(Boolean))];
  const previousFactories = new Map(
    normalizedIds.map((id) => [id, runtimeAdapterFactories.get(id)]),
  );

  for (const id of normalizedIds) {
    runtimeAdapterFactories.set(id, factory);
  }

  return () => {
    for (const id of normalizedIds) {
      if (runtimeAdapterFactories.get(id) !== factory) continue;
      const previousFactory = previousFactories.get(id);
      if (previousFactory) {
        runtimeAdapterFactories.set(id, previousFactory);
      } else {
        runtimeAdapterFactories.delete(id);
      }
    }
  };
}

export function listRuntimeAdapters(): string[] {
  return [...runtimeAdapterFactories.keys()].sort();
}

export function connectRuntimeAdapter(input: ConnectAspInput): AspTransportConnection | undefined {
  const adapter = normalizeRuntimeAdapterId(input.provider.capabilities?.runtimeAdapter);
  return runtimeAdapterFactories.get(adapter)?.(input);
}

function normalizeRuntimeAdapterId(value: unknown): string {
  return text(value).trim().toLowerCase();
}

registerRuntimeAdapter("codex-app-server", (input) => new CodexRuntimeConnection(input));
registerRuntimeAdapter("claude-code-stream-json", (input) => new ClaudeRuntimeConnection(input));
registerRuntimeAdapter(
  ["opencode-server", "opencode-http-sse"],
  (input) => new OpenCodeRuntimeConnection(input),
);
registerRuntimeAdapter(
  ["pi-rpc", "pi-coding-agent-rpc"],
  (input) => new PiRuntimeConnection(input),
);
registerRuntimeAdapter(
  ["grok-cli", "grok-agent-stdio", "kimi-cli", "kimi-acp-stdio"],
  (input) => new HeadlessCliRuntimeConnection(input),
);
