import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTemplate = "react-tailwind-plugin";

const args = process.argv.slice(2);
const nameArg = args.shift();
if (!nameArg || nameArg === "-h" || nameArg === "--help") {
  usage();
  process.exit(nameArg ? 0 : 1);
}

const options = parseOptions(args);
const pluginName = normalizeName(nameArg);
if (!pluginName) throw new Error(`Invalid extension name: ${nameArg}`);
if (pluginName.length > 64) throw new Error("Extension name must be 64 characters or fewer.");

const publisher = normalizeName(options.publisher || "agui");
if (!publisher) throw new Error(`Invalid publisher: ${options.publisher}`);
const displayName = options.displayName || titleCase(pluginName);
const description =
  options.description ||
  `${displayName} extension built from the React and Tailwind AGUI template.`;
const namespace = `${publisher}.${pluginName}`;
const targetParent = path.resolve(root, options.path || "extensions");
const target = path.resolve(options.output || path.join(targetParent, pluginName));
const templateRoot = path.join(
  root,
  "extensions",
  "templates",
  options.template || defaultTemplate,
  "template",
);

if (!fs.existsSync(templateRoot)) throw new Error(`Missing extension template: ${templateRoot}`);
if (!target.startsWith(`${targetParent}${path.sep}`) && !options.output) {
  throw new Error(`Refusing to write outside ${targetParent}`);
}
if (fs.existsSync(target) && !options.force && !options.dryRun) {
  throw new Error(`Target already exists: ${target}. Pass --force to overwrite.`);
}

const replacements = {
  __DESCRIPTION__: description,
  __DISPLAY_NAME__: displayName,
  __GLOBAL_NAME__: `Agui${pascalCase(pluginName)}`,
  __NAMESPACE__: namespace,
  __PLUGIN_NAME__: pluginName,
  __PUBLISHER__: publisher,
  __TOOL_PREFIX__: `${publisher}_${pluginName}`.replaceAll("-", "_"),
};

if (options.dryRun) {
  console.log(`Template: ${templateRoot}`);
  console.log(`Target: ${target}`);
  console.log(`Namespace: ${namespace}`);
  process.exit(0);
}

if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
copyTemplate(templateRoot, target);
if (!options.withMcp) removeMcpSupport(target);
assertNoPlaceholders(target);

console.log(`Created AGUI extension ${namespace} at ${target}`);
console.log(`Build with: pnpm --dir ${displayPath(target)} build`);
console.log(`Package with: node scripts/package-extension.mjs ${displayPath(target)}`);

function parseOptions(values) {
  const parsed = {
    description: "",
    displayName: "",
    dryRun: false,
    force: false,
    output: "",
    path: "",
    publisher: "",
    template: defaultTemplate,
    withMcp: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--with-mcp") {
      parsed.withMcp = true;
      continue;
    }
    if (arg === "--description") {
      parsed.description = requiredValue(values, ++index, arg);
      continue;
    }
    if (arg === "--display-name") {
      parsed.displayName = requiredValue(values, ++index, arg);
      continue;
    }
    if (arg === "--output") {
      parsed.output = requiredValue(values, ++index, arg);
      continue;
    }
    if (arg === "--path") {
      parsed.path = requiredValue(values, ++index, arg);
      continue;
    }
    if (arg === "--publisher") {
      parsed.publisher = requiredValue(values, ++index, arg);
      continue;
    }
    if (arg === "--template") {
      parsed.template = requiredValue(values, ++index, arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function requiredValue(values, index, option) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function copyTemplate(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const outputName = replaceAll(entry.name).replace(/\.template$/, "");
    const outputPath = path.join(destination, outputName);
    if (entry.isDirectory()) {
      copyTemplate(sourcePath, outputPath);
    } else if (entry.isFile()) {
      const content = replaceAll(fs.readFileSync(sourcePath, "utf8"));
      fs.writeFileSync(outputPath, content, "utf8");
      if (outputPath.endsWith(path.join("dist", "mcp-server.js"))) fs.chmodSync(outputPath, 0o755);
    }
  }
}

function assertNoPlaceholders(directory) {
  const remaining = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(entryPath, "utf8");
        const match = content.match(/__[A-Z0-9_]+__/);
        if (match) remaining.push(`${entryPath}: ${match[0]}`);
      }
    }
  };
  visit(directory);
  if (remaining.length) {
    throw new Error(`Unresolved template placeholders:\n${remaining.join("\n")}`);
  }
}

function removeMcpSupport(directory) {
  const packageJsonPath = path.join(directory, "package.json");
  const tsconfigPath = path.join(directory, "tsconfig.json");
  const readmePath = path.join(directory, "README.md");

  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  manifest.scripts.build = manifest.scripts.build.replace(" && node scripts/finalize-build.js", "");
  manifest.files = arrayValue(manifest.files).filter((item) => item !== "mcp.json");
  manifest.permissions = arrayValue(manifest.permissions).filter(
    (item) => item !== "agent.mcp" && item !== "process.spawn",
  );
  delete manifest.contributes.mcpServers;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
  tsconfig.include = arrayValue(tsconfig.include).filter((item) => item !== "src/mcp-server.ts");
  fs.writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

  for (const relative of ["mcp.json", "scripts/finalize-build.js", "src/mcp-server.ts"]) {
    fs.rmSync(path.join(directory, relative), { force: true });
  }

  if (fs.existsSync(readmePath)) {
    const optionalMcpNote =
      "MCP support is optional. Generate with `--with-mcp` when the agent needs private tool access\nthrough MCP Gateway.\n";
    const generatedWithoutMcpNote =
      "This extension was generated without MCP support. Recreate it with `--with-mcp` if the agent needs private tool access through MCP Gateway.\n";
    fs.writeFileSync(
      readmePath,
      fs
        .readFileSync(readmePath, "utf8")
        .replace("- `src/mcp-server.ts` exposes a minimal MCP stdio server.\n", "")
        .replace(optionalMcpNote, generatedWithoutMcpNote),
      "utf8",
    );
  }
}

function replaceAll(value) {
  return Object.entries(replacements).reduce(
    (result, [placeholder, replacement]) => result.replaceAll(placeholder, replacement),
    value,
  );
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function displayPath(value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function pascalCase(value) {
  return normalizeName(value)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function titleCase(value) {
  return normalizeName(value)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function usage() {
  console.log(`Usage:
  node scripts/create-extension-from-template.mjs <name> [options]

Options:
  --publisher <id>       Manifest publisher. Default: agui
  --display-name <name>  User-facing display name. Default: title-cased name
  --description <text>   Manifest description
  --path <dir>           Parent directory for generated extension. Default: extensions
  --output <dir>         Exact output directory
  --template <name>      Template name. Default: ${defaultTemplate}
  --with-mcp             Include an MCP stdio server and agent.mcp contribution
  --force                Replace existing output directory
  --dry-run              Print resolved paths without writing
`);
}
