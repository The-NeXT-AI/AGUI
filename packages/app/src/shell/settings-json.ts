import { t as translateText } from "@/lib/i18n";

export function parseJsonObject(value: string, label: string): Record<string, unknown> | Error {
  try {
    const parsed = JSON.parse(value.trim() || "{}") as unknown;
    if (!isPlainRecord(parsed)) {
      return new Error(translateText("settings.mcpGateway.error.jsonObject", { label }));
    }
    return parsed;
  } catch (error) {
    return new Error(
      error instanceof Error
        ? error.message
        : translateText("settings.mcpGateway.error.invalidJsonLabel", { label }),
    );
  }
}

export function parseJsonArray(value: string, label: string): unknown[] | Error {
  try {
    const parsed = JSON.parse(value.trim() || "[]") as unknown;
    if (!Array.isArray(parsed)) {
      return new Error(translateText("settings.mcpGateway.error.arrayRequired", { label }));
    }
    return parsed;
  } catch (error) {
    return new Error(
      error instanceof Error
        ? error.message
        : translateText("settings.mcpGateway.error.invalidJsonLabel", { label }),
    );
  }
}

export function parseStringRecordJson(
  value: string,
  label: string,
): Record<string, string> | Error {
  try {
    const parsed = JSON.parse(value.trim() || "{}") as unknown;
    if (!isPlainRecord(parsed)) {
      return new Error(translateText("settings.mcpGateway.error.jsonObject", { label }));
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]));
  } catch (error) {
    return new Error(
      error instanceof Error
        ? error.message
        : translateText("settings.mcpGateway.error.invalidJsonLabel", { label }),
    );
  }
}

export function stringArrayFromUnknown(value: unknown, label: string): string[] | Error {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    return new Error(translateText("settings.mcpGateway.error.arrayRequired", { label }));
  return value.map((entry) => String(entry));
}

export function stringRecordFromUnknown(
  value: unknown,
  label: string,
): Record<string, string> | Error {
  if (value === undefined) return {};
  if (!isPlainRecord(value))
    return new Error(translateText("settings.mcpGateway.error.jsonObject", { label }));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
