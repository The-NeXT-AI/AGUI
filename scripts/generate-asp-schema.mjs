import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { aspV1JsonSchema } from "../packages/asp/dist/asp-schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "packages", "asp", "schema", "v1", "schema.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
const prettierConfig = (await resolveConfig(target)) ?? {};
const schema = await format(JSON.stringify(aspV1JsonSchema()), {
  ...prettierConfig,
  filepath: target,
});
fs.writeFileSync(target, schema, "utf8");
console.log(path.relative(root, target));
