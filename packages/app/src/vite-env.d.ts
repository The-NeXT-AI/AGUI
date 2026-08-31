/// <reference types="vite/client" />

import type { AgentDesktopBridge, ExtensionThemeDefinition } from "@/asp/desktop-api";
import type { ProductConfig, ProductConfigOverride } from "@/product/product-config";

declare global {
  interface Window {
    __AGUI_PRODUCT_CONFIG__?: ProductConfigOverride;
    __AGUI_UPDATE_PRODUCT_CONFIG__?: (override: ProductConfigOverride) => ProductConfig;
    __AGUI_CURRENT_THEME__?: {
      id: string;
      type: "dark" | "light";
      definition?: ExtensionThemeDefinition;
    };
    aguiInteractiveApp?: {
      postMessage(message: unknown): void;
    };
    agentDesktop?: AgentDesktopBridge;
  }
}
