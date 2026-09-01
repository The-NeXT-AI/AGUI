import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Workspace alias so the "built-in extension" packages can be imported
      // the same way downstream extensions will.
      "@the-next-ai/agui-app": path.resolve(process.cwd(), "packages/app/src/runtime/index.ts"),
      "@": path.resolve(process.cwd(), "packages/app/src"),
    },
  },
});
