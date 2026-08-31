import { desktopApi } from "@/asp/desktop-api";

export async function copyTextToClipboard(text: string): Promise<void> {
  let lastError: unknown;
  const nativeClipboard = desktopApi()?.clipboard;
  if (nativeClipboard) {
    try {
      await nativeClipboard.writeText(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (legacyCopyText(text)) return;
  throw lastError instanceof Error ? lastError : new Error("Clipboard API is unavailable.");
}

function legacyCopyText(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}
