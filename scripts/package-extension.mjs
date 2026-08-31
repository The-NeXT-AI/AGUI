import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const source = path.resolve(process.argv[2] || ".");
const packagePath = path.join(source, "package.json");
if (!fs.existsSync(packagePath)) throw new Error(`Missing extension package.json in ${source}`);
const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const publisher = manifest.publisher;
const name = manifest.name;
const version = manifest.version || "";
for (const [key, value] of Object.entries({ publisher, name, version })) {
  if (typeof value !== "string" || !value) throw new Error(`Extension manifest requires ${key}.`);
}
if (!manifest.engines?.agui) throw new Error("Extension manifest requires engines.agui.");

const defaultName = `${publisher}.${name}-${version}.aguix`;
const output = path.resolve(process.argv[3] || path.join(process.cwd(), defaultName));
const files = collectFiles(source, output, manifest);
if (files.length > 2_000) throw new Error("Extension contains more than 2,000 files.");

const localParts = [];
const centralParts = [];
let offset = 0;
let totalBytes = 0;
for (const file of files) {
  const name = Buffer.from(file.relative.replaceAll(path.sep, "/"), "utf8");
  const content = fs.readFileSync(file.absolute);
  totalBytes += content.length;
  if (totalBytes > 100 * 1024 * 1024)
    throw new Error("Extension exceeds the 100 MB unpacked limit.");
  const checksum = crc32(content);
  const { time, date } = dosTime(file.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, name, content);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  const archiveMode = 0o100644 | (file.mode & 0o111);
  central.writeUInt32LE((archiveMode * 0x10000) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);
  offset += local.length + name.length + content.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([...localParts, centralDirectory, end]));
console.log(`Packed ${publisher}.${name} ${version} -> ${output}`);

function collectFiles(root, outputPath, packageManifest) {
  const collected = [];
  const explicitFiles = Array.isArray(packageManifest.files)
    ? packageManifest.files.filter((item) => typeof item === "string" && item.trim())
    : [];
  const ignorePath = path.join(root, ".aguixignore");
  const ignorePatterns = fs.existsSync(ignorePath)
    ? fs
        .readFileSync(ignorePath, "utf8")
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter((item) => item && !item.startsWith("#"))
    : [];
  const skippedSensitive = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (path.resolve(absolute) === outputPath) continue;
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (relative === ".aguixignore" || ignoredByPatterns(relative, ignorePatterns)) continue;
      if (!includedByManifest(relative, explicitFiles, entry.isDirectory())) continue;
      if (sensitivePackagePath(relative) && !explicitlyIncluded(relative, explicitFiles)) {
        skippedSensitive.push(relative);
        continue;
      }
      if (entry.isSymbolicLink())
        throw new Error(`Extension packages cannot contain symlinks: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        collected.push({ absolute, relative, mtime: stat.mtime, mode: stat.mode });
      }
    }
  };
  visit(root);
  if (skippedSensitive.length) {
    console.warn(`Skipped sensitive files: ${skippedSensitive.sort().join(", ")}`);
  }
  return collected.sort((a, b) => a.relative.localeCompare(b.relative));
}

function includedByManifest(relative, patterns, directory) {
  if (!patterns.length) return true;
  if (relative === "package.json") return true;
  return patterns.some((pattern) => {
    const normalized = normalizePattern(pattern);
    return (
      matchesPattern(relative, normalized) ||
      (directory && normalized.startsWith(`${relative}/`)) ||
      relative.startsWith(`${normalized.replace(/\/+$/, "")}/`)
    );
  });
}

function explicitlyIncluded(relative, patterns) {
  return patterns.some((pattern) => matchesPattern(relative, normalizePattern(pattern)));
}

function ignoredByPatterns(relative, patterns) {
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = normalizePattern(negated ? raw.slice(1) : raw);
    if (matchesPattern(relative, pattern) || relative.startsWith(`${pattern}/`)) {
      ignored = !negated;
    }
  }
  return ignored;
}

function normalizePattern(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
}

function matchesPattern(value, pattern) {
  if (!pattern) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped.replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
  return new RegExp(`^(?:${expression})(?:/.*)?$`).test(value);
}

function sensitivePackagePath(relative) {
  const parts = relative.toLowerCase().split("/");
  const basename = parts.at(-1) || "";
  if (parts.some((part) => part === ".git" || part === ".ssh" || part === ".aws")) return true;
  if (basename === ".ds_store" || basename === ".npmrc" || basename === ".pypirc") return true;
  if (
    basename === ".env" ||
    (basename.startsWith(".env.") && !/\.(example|sample)$/.test(basename))
  ) {
    return true;
  }
  return /\.(?:pem|key|p12|pfx)$/.test(basename);
}

function dosTime(value) {
  const dateValue = value.getFullYear() < 1980 ? new Date(1980, 0, 1) : value;
  return {
    time:
      (dateValue.getHours() << 11) |
      (dateValue.getMinutes() << 5) |
      Math.floor(dateValue.getSeconds() / 2),
    date:
      ((dateValue.getFullYear() - 1980) << 9) |
      ((dateValue.getMonth() + 1) << 5) |
      dateValue.getDate(),
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
