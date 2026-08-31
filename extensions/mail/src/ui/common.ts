import { useEffect, useState } from "react";

type AguiApi = {
  data: unknown;
  command(command: string, args?: unknown[]): Promise<unknown>;
};

declare global {
  interface Window {
    agui?: AguiApi;
  }
}

export function useAguiData(): unknown {
  const [data, setData] = useState<unknown>(() => window.agui?.data ?? null);

  useEffect(() => {
    const listener = (event: Event) => {
      setData((event as CustomEvent<unknown>).detail ?? null);
    };
    window.addEventListener("agui:data", listener);
    return () => window.removeEventListener("agui:data", listener);
  }, []);

  return data;
}

export function aguiCommand(command: string, args: unknown[] = []): Promise<unknown> {
  if (!window.agui) return Promise.reject(new Error("AGUI bridge is not available."));
  return window.agui.command(command, args);
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value ?? fallback);
  return Number.isFinite(result) ? result : fallback;
}

export function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function mailLanguage(value: unknown): "en" | "zh" {
  return stringValue(value) === "zh" ? "zh" : "en";
}
