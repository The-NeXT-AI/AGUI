import { useEffect } from "react";
import { updateProductConfig, useProductConfig } from "./product-config";

const STYLE_ELEMENT_ID = "agui-product-custom-css";

export function ProductCustomizationController() {
  const productConfig = useProductConfig();

  useEffect(() => {
    const previous = window.__AGUI_UPDATE_PRODUCT_CONFIG__;
    window.__AGUI_UPDATE_PRODUCT_CONFIG__ = updateProductConfig;
    return () => {
      if (window.__AGUI_UPDATE_PRODUCT_CONFIG__ === updateProductConfig) {
        window.__AGUI_UPDATE_PRODUCT_CONFIG__ = previous;
      }
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const appliedVariables: string[] = [];
    const rootClasses = classList(productConfig.ui.rootClassName);
    const bodyClasses = classList(productConfig.ui.bodyClassName);
    const previousProductName = root.dataset.productName;
    const previousTitle = document.title;

    root.dataset.productCustomizable = "true";
    root.dataset.productName = productConfig.app.name;
    document.title = productConfig.app.displayName;
    rootClasses.forEach((className) => root.classList.add(className));
    bodyClasses.forEach((className) => body.classList.add(className));

    for (const [key, value] of Object.entries(productConfig.ui.cssVariables)) {
      const variable = cssVariableName(key);
      if (!variable) continue;
      root.style.setProperty(variable, value);
      appliedVariables.push(variable);
    }

    let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ELEMENT_ID;
      document.head.appendChild(style);
    }
    style.textContent = productConfig.ui.customCss;

    return () => {
      rootClasses.forEach((className) => root.classList.remove(className));
      bodyClasses.forEach((className) => body.classList.remove(className));
      appliedVariables.forEach((variable) => root.style.removeProperty(variable));
      if (previousProductName) {
        root.dataset.productName = previousProductName;
      } else {
        delete root.dataset.productName;
      }
      document.title = previousTitle;
      style?.remove();
    };
  }, [productConfig]);

  return null;
}

function cssVariableName(value: string): string | null {
  const key = value.trim();
  const variable = key.startsWith("--") ? key : `--${key}`;
  return /^--[a-zA-Z0-9_-]+$/.test(variable) ? variable : null;
}

function classList(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9:_/-]+$/.test(item));
}
