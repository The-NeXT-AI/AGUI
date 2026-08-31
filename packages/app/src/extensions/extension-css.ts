const MAX_EXTENSION_CSS_BYTES = 512 * 1024;

export function sanitizeExtensionCss(css: string, allowNetwork: boolean): string {
  if (new Blob([css]).size > MAX_EXTENSION_CSS_BYTES) {
    throw new Error("Extension CSS exceeds the 512 KB limit.");
  }
  if (/\bexpression\s*\(/i.test(css) || /javascript\s*:/i.test(css)) {
    throw new Error("Extension CSS contains blocked script-like syntax.");
  }
  if (/@import\b/i.test(css)) {
    throw new Error("Extension CSS cannot use @import.");
  }
  for (const url of cssUrls(css)) {
    if (url.startsWith("data:")) continue;
    if (!allowNetwork) throw new Error("Extension CSS url() requires the network permission.");
    if (!/^https:\/\//i.test(url)) {
      throw new Error("Extension CSS url() may only reference HTTPS or data URLs.");
    }
  }
  return css;
}

function cssUrls(css: string): string[] {
  const urls: string[] = [];
  const pattern = /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  for (const match of css.matchAll(pattern)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value) urls.push(value);
  }
  return urls;
}
