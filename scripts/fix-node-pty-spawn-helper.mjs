import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmRoot = path.join(root, "node_modules", ".pnpm");
if (!fs.existsSync(pnpmRoot)) process.exit(0);

for (const entry of fs.readdirSync(pnpmRoot)) {
  if (!entry.startsWith("node-pty@")) continue;
  const prebuildRoot = path.join(pnpmRoot, entry, "node_modules", "node-pty", "prebuilds");
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const helper = path.join(prebuildRoot, arch, "spawn-helper");
    if (!fs.existsSync(helper)) continue;
    const mode = fs.statSync(helper).mode;
    fs.chmodSync(helper, mode | 0o755);
  }
}
