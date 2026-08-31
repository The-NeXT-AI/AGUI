import { useEffect } from "react";
import { sanitizeExtensionCss } from "@/extensions/extension-css";
import { useRegistryStore } from "./registry-store.js";

const STYLE_MARKER = "agui-extension-style-managed";

export function ExtensionStyleHost() {
  const styles = useRegistryStore((state) => state.styles);

  useEffect(() => {
    const activeIds = new Set(styles.map((style) => style.id));
    for (const node of managedStyleNodes()) {
      const id = node.dataset.aguiExtensionStyleId;
      if (!id || !activeIds.has(id)) node.remove();
    }

    for (const style of [...styles].sort(styleOrder)) {
      let node = managedStyleNodes().find((item) => item.dataset.aguiExtensionStyleId === style.id);
      if (!node) {
        node = document.createElement("style");
        node.setAttribute(`data-${STYLE_MARKER}`, "true");
        node.dataset.aguiExtensionStyleId = style.id;
        document.head.appendChild(node);
      } else if (node.parentElement !== document.head) {
        document.head.appendChild(node);
      }
      node.dataset.aguiExtensionStyleOwner = style.owner ?? "";
      node.media = style.media ?? "";
      try {
        node.textContent = sanitizeExtensionCss(style.css, style.allowNetwork === true);
      } catch (error) {
        console.warn(
          `Extension style skipped: ${style.id}`,
          error instanceof Error ? error.message : error,
        );
        node.textContent = "";
      }
      document.head.appendChild(node);
    }
  }, [styles]);

  useEffect(() => () => managedStyleNodes().forEach((node) => node.remove()), []);

  return null;
}

function managedStyleNodes(): HTMLStyleElement[] {
  return Array.from(
    document.querySelectorAll<HTMLStyleElement>(`style[data-${STYLE_MARKER}="true"]`),
  );
}

function styleOrder(a: { order?: number; id: string }, b: { order?: number; id: string }): number {
  const order = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
  return order || a.id.localeCompare(b.id);
}
