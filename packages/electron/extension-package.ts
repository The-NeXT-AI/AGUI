import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 2_000;

export type PackageFile = {
  absolute: string;
  relative: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export async function validatePackageTree(root: string): Promise<void> {
  await packageFiles(root);
}

export async function computePackageFingerprint(
  root: string,
  scope: string,
  files?: PackageFile[],
): Promise<string> {
  const packageFileList = files ?? (await packageFiles(root));
  const hash = createHash("sha256");
  hash.update(`${scope}\0`);
  for (const file of packageFileList) {
    hash.update(file.relative);
    hash.update("\0");
    const handle = await fs.promises.open(file.absolute, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < file.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, file.size - position),
          position,
        );
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function computePackageFingerprintSync(root: string, scope: string): string {
  const hash = createHash("sha256");
  hash.update(`${scope}\0`);
  for (const file of packageFilesSync(root)) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function packageFiles(root: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.includes("\0")) throw new Error("Extension paths cannot contain null bytes.");
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Extension packages cannot contain symlinks: ${path.relative(root, absolute)}`,
        );
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Unsupported extension package entry: ${path.relative(root, absolute)}`);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error(
          `Extension packages cannot contain symlinks: ${path.relative(root, absolute)}`,
        );
      if (!stat.isFile())
        throw new Error(`Unsupported extension package entry: ${path.relative(root, absolute)}`);
      totalBytes += stat.size;
      if (files.length + 1 > MAX_ARCHIVE_FILES)
        throw new Error("Extension package contains too many files.");
      if (totalBytes > MAX_ARCHIVE_BYTES)
        throw new Error("Extension package exceeds the 100 MB limit.");
      files.push({
        absolute,
        relative: path.relative(root, absolute).replaceAll(path.sep, "/"),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    }
  };
  await visit(root);
  return files;
}

export function findPackageRoot(root: string): string {
  if (fs.existsSync(path.join(root, "package.json"))) {
    return root;
  }
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (directories.length === 1) return findPackageRoot(path.join(root, directories[0]!.name));
  throw new Error("Could not find an extension manifest at the package root.");
}

export async function extractAguix(archivePath: string, temporaryRoot: string): Promise<string> {
  if (path.extname(archivePath).toLowerCase() !== ".aguix") {
    throw new Error("Extension archive must use the .aguix extension.");
  }
  if ((await fs.promises.stat(archivePath)).size > MAX_ARCHIVE_BYTES) {
    throw new Error("Extension archive exceeds the 100 MB package limit.");
  }
  const archive = await fs.promises.readFile(archivePath);
  const eocd = findZipSignature(archive, 0x06054b50);
  if (eocd < 0) throw new Error("Invalid .aguix ZIP archive.");
  if (eocd + 22 > archive.byteLength) throw new Error("Truncated ZIP end record.");
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ARCHIVE_FILES) throw new Error("Extension archive contains too many files.");
  if (centralOffset >= archive.byteLength) throw new Error("Invalid ZIP central directory offset.");
  let cursor = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.byteLength) throw new Error("Truncated ZIP central directory.");
    if (archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP central directory.");
    const compression = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const entryName = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8")
      .replaceAll("\\", "/");
    if (cursor + 46 + nameLength + extraLength + commentLength > archive.byteLength) {
      throw new Error("Truncated ZIP entry metadata.");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
    if (
      !entryName ||
      entryName.startsWith("/") ||
      entryName.split("/").includes("..") ||
      entryName.includes("\0")
    ) {
      throw new Error(`Unsafe path in extension archive: ${entryName}`);
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000)
      throw new Error("Extension archives cannot contain symlinks.");
    const destination = path.resolve(temporaryRoot, entryName);
    if (!isWithin(temporaryRoot, destination))
      throw new Error(`Archive entry escapes target: ${entryName}`);
    if (entryName.endsWith("/")) {
      await fs.promises.mkdir(destination, { recursive: true });
      continue;
    }
    extractedBytes += uncompressedSize;
    if (extractedBytes > MAX_ARCHIVE_BYTES)
      throw new Error("Extension archive exceeds the 100 MB limit.");
    if (localOffset + 30 > archive.byteLength || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Invalid ZIP local header.");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > archive.byteLength)
      throw new Error("Truncated ZIP file data.");
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content =
      compression === 0
        ? compressed
        : compression === 8
          ? await inflateRawAsync(compressed, Math.max(1, uncompressedSize))
          : (() => {
              throw new Error(`Unsupported ZIP compression method: ${compression}`);
            })();
    if (content.byteLength !== uncompressedSize) throw new Error(`Corrupt ZIP entry: ${entryName}`);
    if ((await crc32Async(content)) !== expectedCrc)
      throw new Error(`ZIP checksum mismatch: ${entryName}`);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const executableBits = unixMode & 0o111;
    await fs.promises.writeFile(destination, content, { mode: 0o644 | executableBits });
  }
  return findPackageRoot(temporaryRoot);
}

function packageFilesSync(root: string): PackageFile[] {
  const files: PackageFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.includes("\0")) throw new Error("Extension paths cannot contain null bytes.");
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Extension packages cannot contain symlinks: ${path.relative(root, absolute)}`,
        );
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Unsupported extension package entry: ${path.relative(root, absolute)}`);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(
          `Extension packages cannot contain symlinks: ${path.relative(root, absolute)}`,
        );
      if (!stat.isFile())
        throw new Error(`Unsupported extension package entry: ${path.relative(root, absolute)}`);
      totalBytes += stat.size;
      if (files.length + 1 > MAX_ARCHIVE_FILES)
        throw new Error("Extension package contains too many files.");
      if (totalBytes > MAX_ARCHIVE_BYTES)
        throw new Error("Extension package exceeds the 100 MB limit.");
      files.push({
        absolute,
        relative: path.relative(root, absolute).replaceAll(path.sep, "/"),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    }
  };
  visit(root);
  return files;
}

function inflateRawAsync(content: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(content, { maxOutputLength }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function crc32Async(buffer: Buffer): Promise<number> {
  let crc = 0xffffffff;
  for (let offset = 0; offset < buffer.length; offset += 1) {
    crc ^= buffer[offset]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    if (offset > 0 && offset % (1024 * 1024) === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findZipSignature(buffer: Buffer, signature: number): number {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
