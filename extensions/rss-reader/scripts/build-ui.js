import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const surfaces = [
  {
    entry: "configuration",
    file: "configuration.html",
    globalName: "AguiRssReaderConfiguration",
    view: "rss-reader-configuration",
  },
  {
    entry: "item-renderer",
    file: "item-renderer.html",
    globalName: "AguiRssReaderItemRenderer",
    view: "rss-reader-item-renderer",
  },
];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const surface of surfaces) {
  const temp = path.join(dist, `.ui-${surface.entry}`);
  await build({
    build: {
      cssCodeSplit: false,
      emptyOutDir: true,
      lib: {
        entry: path.join(root, "src", "ui", `${surface.entry}.tsx`),
        fileName: () => "bundle.js",
        formats: ["iife"],
        name: surface.globalName,
      },
      minify: "esbuild",
      outDir: temp,
      rollupOptions: {
        output: {
          assetFileNames: "bundle[extname]",
        },
      },
      sourcemap: false,
    },
    configFile: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    envFile: false,
    logLevel: "warn",
    mode: "production",
    plugins: [react(), tailwindcss()],
    publicDir: false,
    root,
  });

  const js = readSingleFile(temp, ".js");
  const css = readFiles(temp, ".css").join("\n");
  fs.writeFileSync(path.join(dist, surface.file), htmlDocument(surface.view, js, css), "utf8");
  fs.rmSync(temp, { recursive: true, force: true });
}

function htmlDocument(view, js, css) {
  return `<!doctype html>
<html lang="en" data-surface="${view}">
  <head>
    <meta charset="utf-8" />
    <meta name="agui-extension-view" content="${view}" />
    <style>
${css}
    </style>
  </head>
  <body data-surface="${view}">
    <div id="root"></div>
    <script>
${escapeScript(js)}
    </script>
  </body>
</html>
`;
}

function readSingleFile(directory, extension) {
  const matches = readFiles(directory, extension);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${extension} file in ${directory}, found ${matches.length}.`);
  }
  return matches[0];
}

function readFiles(directory, extension) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...readFiles(absolute, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(fs.readFileSync(absolute, "utf8"));
    }
  }
  return results;
}

function escapeScript(value) {
  return value.replace(/<\/script/gi, "<\\/script");
}
