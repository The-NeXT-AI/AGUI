import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "dist", "mcp-server.js");

if (!fs.existsSync(server)) throw new Error("Missing compiled MCP server.");
fs.chmodSync(server, 0o755);
