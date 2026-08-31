import { useState, type ReactNode } from "react";
import { Globe } from "lucide-react";

export const BROWSER_HOME_URL = "about:blank";

export function browserViewBounds(element: HTMLElement | null): {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
} {
  if (!element) return { x: 0, y: 0, width: 0, height: 0, visible: false };
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    visible,
  };
}

export function hiddenBrowserViewBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
} {
  return { x: 0, y: 0, width: 0, height: 0, visible: false };
}

export function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`hover:bg-surface-hover hover:text-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "bg-surface-active text-accent" : "text-muted"
      }`}
    >
      {children}
    </button>
  );
}

export function BrowserHome() {
  return <div className="h-full bg-white" />;
}

export function BrowserFaviconIcon({ iconUrl }: { iconUrl?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        data-browser-address-favicon
        className="h-[13px] w-[13px] shrink-0 rounded-[2px] object-contain"
        onError={() => setFailedUrl(iconUrl)}
      />
    );
  }
  return <Globe size={13} className="text-subtle shrink-0" />;
}

export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return BROWSER_HOME_URL;
  if (value === BROWSER_HOME_URL) return value;
  if (/^https?:\/\//i.test(value)) return safeBrowserUrl(value);
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(value)) {
    return safeBrowserUrl(`http://${value}`);
  }
  if (/^[^\s]+\.[^\s]+/.test(value)) return safeBrowserUrl(`https://${value}`);
  return safeBrowserUrl(`https://www.google.com/search?q=${encodeURIComponent(value)}`);
}

export function safeBrowserUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function isExternalOpenable(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function browserTitle(value: string, newTabTitle = "New tab"): string {
  if (value === BROWSER_HOME_URL) return newTabTitle;
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function browserFaviconUrl(pageUrl: string, iconUrl?: string): string | undefined {
  if (pageUrl === BROWSER_HOME_URL) return undefined;
  const normalized = normalizeBrowserFaviconUrl(iconUrl, pageUrl);
  if (normalized) return normalized;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return new URL("/favicon.ico", parsed).toString();
  } catch {
    return undefined;
  }
}

export function normalizeBrowserFaviconUrl(
  iconUrl: string | undefined,
  pageUrl: string,
): string | undefined {
  const value = iconUrl?.trim();
  if (!value || value.length > 50_000 || /[\r\n\t\0]/.test(value)) return undefined;
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);/i.test(value)) {
    return value;
  }
  try {
    const parsed = new URL(value, pageUrl);
    const page = new URL(pageUrl);
    if (
      parsed.protocol === "http:" &&
      page.protocol === "https:" &&
      parsed.hostname === page.hostname
    ) {
      parsed.protocol = "https:";
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
