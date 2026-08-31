import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const server = path.join(dist, "mcp-server.js");

if (!fs.existsSync(server)) throw new Error("Missing compiled MCP server.");
fs.chmodSync(server, 0o755);
fs.copyFileSync(
  path.join(root, "src", "ui", "composer-actions-placement.css"),
  path.join(dist, "composer-actions.css"),
);
