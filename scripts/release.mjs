#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;
const releaseRoot = path.join(root, "release");
const npmStagingRoot = path.join(releaseRoot, "npm");
const electronOutput = path.join(releaseRoot, "electron");
const defaultNpmPackageDirs = [
  "packages/extensions",
  "packages/asp",
  "packages/runtime",
  "packages/server",
];
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

if (!options.publishNpm && !options.publishElectron) {
  throw new Error("Nothing to publish. Remove --skip-npm or --skip-electron.");
}

const rootManifest = readJson(path.join(root, "package.json"));
const electronBuilderConfig = readJson(path.join(root, "electron-builder.json"));
const workspacePackages = readWorkspacePackages(defaultNpmPackageDirs);
const selectedNpmPackages = resolveNpmPackages(workspacePackages, options.npmPackages);
const version = rootManifest.version;
const tagName = options.tagName || `v${version}`;
const releaseName = options.releaseName || tagName;
const githubRepo = parseRepo(options.repo) ?? githubRepoFromElectronBuilder(electronBuilderConfig);
const releaseKind =
  options.githubReleaseKind || githubReleaseKindFromElectronBuilder(electronBuilderConfig);
const githubReleaseOptions = githubReleaseState(releaseKind);

if (options.publishElectron && !githubRepo) {
  throw new Error("Missing GitHub repository. Pass --repo owner/repo.");
}

printSummary({
  options,
  tagName,
  releaseName,
  githubRepo,
  releaseKind,
  selectedNpmPackages,
});

if (!options.dryRun && !options.allowDirty) assertGitClean();

if (!options.skipBuild) {
  if (options.publishElectron) {
    run(packageManager, ["build:app"], root);
  } else if (options.publishNpm) {
    run(packageManager, ["build"], root);
  }
} else {
  console.log("Skipping build step.");
}

let electronRelease = null;

if (options.publishElectron) {
  if (!options.skipBuild) {
    resetDirectory(electronOutput);
    run(
      nodeCommand,
      [
        "scripts/package-electron.mjs",
        "--publish",
        "never",
        "--config.directories.output=release/electron",
      ],
      root,
    );
  } else {
    assertDirectory(
      electronOutput,
      "Missing Electron output. Run without --skip-build or run pnpm pack:electron first.",
    );
  }

  const platform = electronPlatform(process.platform);
  const assets = collectElectronAssets(electronOutput, platform);
  if (!assets.length) {
    throw new Error(
      `No ${platform} Electron assets found in ${path.relative(root, electronOutput)}.`,
    );
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!options.dryRun && !token) {
    throw new Error("Set GH_TOKEN or GITHUB_TOKEN to upload Electron assets to GitHub Release.");
  }
  electronRelease = { assets, platform, token };
}

if (options.publishNpm) {
  publishNpmPackages(selectedNpmPackages, workspacePackages, options);
}

if (options.publishElectron && electronRelease) {
  if (options.dryRun) {
    console.log(
      `Dry run: would upload ${electronRelease.assets.length} ${electronRelease.platform} Electron asset(s):`,
    );
    for (const asset of electronRelease.assets) console.log(`- ${path.relative(root, asset)}`);
  } else {
    await publishElectronAssetsToGithub({
      assets: electronRelease.assets,
      clobber: options.clobber,
      releaseName,
      repo: githubRepo,
      tagName,
      targetCommitish: options.targetCommitish,
      token: electronRelease.token,
      ...githubReleaseOptions,
    });
  }
}

console.log(options.dryRun ? "Release dry run complete." : "Release complete.");

function publishNpmPackages(selectedPackages, allPackages, releaseOptions) {
  resetDirectory(npmStagingRoot);
  const workspaceVersions = new Map(
    allPackages.map((pkg) => [pkg.manifest.name, pkg.manifest.version]),
  );
  const preparedPackages = selectedPackages.map((pkg) => prepareNpmPackage(pkg, workspaceVersions));

  for (const pkg of preparedPackages) {
    const args = ["publish", "--access", releaseOptions.npmAccess, "--tag", releaseOptions.npmTag];
    if (releaseOptions.dryRun) args.push("--dry-run");
    if (releaseOptions.npmProvenance) args.push("--provenance");
    if (releaseOptions.otp) args.push("--otp", releaseOptions.otp);

    console.log(
      `${releaseOptions.dryRun ? "Dry run: " : ""}Publishing ${pkg.name}@${pkg.version} from ${path.relative(root, pkg.directory)}`,
    );
    run(npmCommand, args, pkg.directory, npmPublishEnv());
  }
}

function prepareNpmPackage(pkg, workspaceVersions) {
  const target = path.join(npmStagingRoot, stagingDirectoryName(pkg.manifest.name));
  resetDirectory(target);

  const publishManifest = sanitizeNpmManifest(pkg.manifest, workspaceVersions);
  writeJson(path.join(target, "package.json"), publishManifest);
  copyPackageFiles(pkg.directory, target, pkg.manifest.files ?? ["dist/**"]);
  copyRootMetadata(target);
  normalizeBinPermissions(target, publishManifest);

  assertFile(
    path.join(target, "dist", "index.js"),
    `Missing dist/index.js for ${pkg.manifest.name}.`,
  );
  return {
    directory: target,
    name: publishManifest.name,
    version: publishManifest.version,
  };
}

function sanitizeNpmManifest(manifest, workspaceVersions) {
  const next = structuredClone(manifest);
  delete next.private;

  if (typeof next.repository?.url === "string" && next.repository.url.startsWith("https://")) {
    next.repository.url = `git+${next.repository.url}`;
  }
  next.bin = normalizeBinManifest(next.bin);

  for (const field of dependencyFields) {
    if (!next[field]) continue;
    next[field] = rewriteWorkspaceDependencies(next[field], workspaceVersions, next.name);
  }

  return next;
}

function normalizeBinManifest(bin) {
  if (typeof bin === "string") return normalizeBinPath(bin);
  if (!bin || typeof bin !== "object") return bin;
  return Object.fromEntries(
    Object.entries(bin).map(([name, value]) => [name, normalizeBinPath(value)]),
  );
}

function normalizeBinPath(value) {
  return typeof value === "string" ? value.replace(/^\.\//, "") : value;
}

function rewriteWorkspaceDependencies(dependencies, workspaceVersions, packageName) {
  const rewritten = {};
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) {
      rewritten[name] = specifier;
      continue;
    }

    const version = workspaceVersions.get(name);
    if (!version) {
      throw new Error(
        `${packageName} depends on ${name} via ${specifier}, but it is not in the release set.`,
      );
    }

    const range = specifier.slice("workspace:".length);
    rewritten[name] =
      range === "*" || range === ""
        ? version
        : range === "^" || range === "~"
          ? `${range}${version}`
          : range;
  }
  return rewritten;
}

function copyPackageFiles(source, target, files) {
  for (const pattern of files) {
    const topLevel = topLevelPublishPath(pattern);
    const sourcePath = path.join(source, topLevel);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing publish file path: ${path.relative(root, sourcePath)}`);
    }
    fs.cpSync(sourcePath, path.join(target, topLevel), { recursive: true });
  }
  removeBuildInfoFiles(target);
}

function topLevelPublishPath(pattern) {
  if (pattern.includes("*")) {
    const wildcardIndex = pattern.indexOf("*");
    const prefix = pattern.slice(0, wildcardIndex).replace(/\/+$/, "");
    if (!prefix || prefix.includes("*")) {
      throw new Error(`Unsupported package files pattern: ${pattern}`);
    }
    return prefix;
  }
  return pattern;
}

function copyRootMetadata(target) {
  for (const file of ["README.md", "LICENSE", "NOTICE.md"]) {
    const source = path.join(root, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, file));
  }
}

function normalizeBinPermissions(target, manifest) {
  const entries =
    typeof manifest.bin === "string"
      ? [manifest.bin]
      : manifest.bin && typeof manifest.bin === "object"
        ? Object.values(manifest.bin)
        : [];

  for (const relativeBin of entries) {
    if (typeof relativeBin !== "string") continue;
    const binPath = path.join(target, relativeBin);
    if (fs.existsSync(binPath)) fs.chmodSync(binPath, 0o755);
  }
}

function removeBuildInfoFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeBuildInfoFiles(target);
    } else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      fs.rmSync(target);
    }
  }
}

async function publishElectronAssetsToGithub(input) {
  const release = await getOrCreateGithubRelease(input);
  const existingAssets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));

  for (const assetPath of input.assets) {
    const name = path.basename(assetPath);
    const existing = existingAssets.get(name);
    if (existing) {
      if (!input.clobber) {
        throw new Error(
          `Release asset already exists: ${name}. Re-run with default clobber behavior.`,
        );
      }
      await githubRequest({
        method: "DELETE",
        path: `/repos/${input.repo.owner}/${input.repo.repo}/releases/assets/${existing.id}`,
        token: input.token,
      });
      console.log(`Deleted existing GitHub Release asset ${name}.`);
    }

    await uploadGithubReleaseAsset({
      file: assetPath,
      release,
      token: input.token,
    });
    console.log(`Uploaded ${name} to GitHub Release ${input.tagName}.`);
  }
}

async function getOrCreateGithubRelease(input) {
  const releasePath = `/repos/${input.repo.owner}/${input.repo.repo}/releases/tags/${encodeURIComponent(
    input.tagName,
  )}`;
  const existing = await githubRequest({
    allow404: true,
    method: "GET",
    path: releasePath,
    token: input.token,
  });
  if (existing) {
    console.log(`Using existing GitHub Release ${input.tagName}.`);
    return existing;
  }

  const body = {
    draft: input.draft,
    generate_release_notes: true,
    name: input.releaseName,
    prerelease: input.prerelease,
    tag_name: input.tagName,
  };
  if (input.targetCommitish) body.target_commitish = input.targetCommitish;

  console.log(`Creating GitHub Release ${input.tagName}.`);
  return githubRequest({
    body,
    method: "POST",
    path: `/repos/${input.repo.owner}/${input.repo.repo}/releases`,
    token: input.token,
  });
}

async function uploadGithubReleaseAsset({ file, release, token }) {
  const stat = fs.statSync(file);
  const name = path.basename(file);
  const uploadBase = release.upload_url.split("{", 1)[0];
  const response = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    body: fs.createReadStream(file),
    duplex: "half",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Length": String(stat.size),
      "Content-Type": contentTypeForAsset(name),
      "User-Agent": "agui-release-script",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    method: "POST",
  });

  await readGithubResponse(response, `upload ${name}`);
}

async function githubRequest({ allow404 = false, body, method, path: apiPath, token }) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      "User-Agent": "agui-release-script",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    method,
  });

  if (allow404 && response.status === 404) return null;
  return readGithubResponse(response, `${method} ${apiPath}`);
}

async function readGithubResponse(response, label) {
  const text = await response.text();
  if (!response.ok) {
    const detail = text ? ` ${text}` : "";
    throw new Error(`GitHub ${label} failed with ${response.status}.${detail}`);
  }
  if (response.status === 204 || !text) return null;
  return JSON.parse(text);
}

function collectElectronAssets(directory, platform) {
  return fs
    .readdirSync(directory)
    .filter((name) => isUploadableElectronAsset(name, platform))
    .map((name) => path.join(directory, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function isUploadableElectronAsset(name, platform) {
  if (name === "builder-debug.yml" || name === "builder-effective-config.yaml") return false;

  if (platform === "mac") {
    return (
      name === "latest-mac.yml" ||
      name.endsWith(".dmg") ||
      name.endsWith(".zip") ||
      name.endsWith(".blockmap")
    );
  }

  if (platform === "win") {
    return (
      name === "latest.yml" ||
      name.endsWith(".exe") ||
      name.endsWith(".msi") ||
      name.endsWith(".msix") ||
      name.endsWith(".blockmap")
    );
  }

  return (
    name === "latest-linux.yml" ||
    name.endsWith(".AppImage") ||
    name.endsWith(".deb") ||
    name.endsWith(".rpm") ||
    name.endsWith(".snap") ||
    name.endsWith(".tar.gz") ||
    name.endsWith(".blockmap")
  );
}

function contentTypeForAsset(name) {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (name.endsWith(".msi")) return "application/x-msi";
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "text/yaml";
  if (name.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (name.endsWith(".rpm")) return "application/x-rpm";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/octet-stream";
}

function parseArgs(argv) {
  const parsed = {
    allowDirty: false,
    clobber: true,
    dryRun: false,
    githubReleaseKind: "",
    help: false,
    npmAccess: "public",
    npmPackages: [],
    npmProvenance: false,
    npmTag: "latest",
    otp: "",
    publishElectron: true,
    publishNpm: true,
    releaseName: "",
    repo: "",
    skipBuild: false,
    tagName: "",
    targetCommitish: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitArg(argv[index]);
    const value = () => inlineValue ?? requiredValue(argv, ++index, flag);

    switch (flag) {
      case "--":
        break;
      case "--allow-dirty":
        parsed.allowDirty = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--github-release":
        parsed.githubReleaseKind = githubReleaseKind(value());
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--no-clobber":
        parsed.clobber = false;
        break;
      case "--npm-access":
        parsed.npmAccess = value();
        break;
      case "--npm-package":
        parsed.npmPackages.push(...splitList(value()));
        break;
      case "--npm-provenance":
        parsed.npmProvenance = true;
        break;
      case "--npm-tag":
        parsed.npmTag = value();
        break;
      case "--otp":
        parsed.otp = value();
        break;
      case "--release-name":
        parsed.releaseName = value();
        break;
      case "--repo":
        parsed.repo = value();
        break;
      case "--skip-build":
        parsed.skipBuild = true;
        break;
      case "--skip-electron":
        parsed.publishElectron = false;
        break;
      case "--skip-npm":
        parsed.publishNpm = false;
        break;
      case "--tag":
        parsed.tagName = value();
        break;
      case "--target-commitish":
        parsed.targetCommitish = value();
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return parsed;
}

function splitArg(arg) {
  const equalIndex = arg.indexOf("=");
  if (equalIndex === -1) return [arg, undefined];
  return [arg.slice(0, equalIndex), arg.slice(equalIndex + 1)];
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readWorkspacePackages(packageDirs) {
  return packageDirs.map((relativeDir) => {
    const directory = path.join(root, relativeDir);
    const manifest = readJson(path.join(directory, "package.json"));
    return { directory, manifest, relativeDir };
  });
}

function resolveNpmPackages(workspacePackages, selectedNames) {
  if (!selectedNames.length) return workspacePackages;

  const lookup = new Map();
  for (const pkg of workspacePackages) {
    lookup.set(pkg.manifest.name, pkg);
    lookup.set(path.basename(pkg.relativeDir), pkg);
  }

  return selectedNames.map((name) => {
    const pkg = lookup.get(name);
    if (!pkg) {
      throw new Error(
        `Unknown npm package ${name}. Known packages: ${workspacePackages
          .map((item) => item.manifest.name)
          .join(", ")}`,
      );
    }
    return pkg;
  });
}

function githubRepoFromElectronBuilder(config) {
  const githubPublish = Array.isArray(config.publish)
    ? config.publish.find((item) => item?.provider === "github")
    : undefined;
  if (!githubPublish?.owner || !githubPublish?.repo) return null;
  return { owner: githubPublish.owner, repo: githubPublish.repo };
}

function githubReleaseKindFromElectronBuilder(config) {
  const githubPublish = Array.isArray(config.publish)
    ? config.publish.find((item) => item?.provider === "github")
    : undefined;
  return githubReleaseKind(githubPublish?.releaseType ?? "draft");
}

function githubReleaseKind(value) {
  if (value === "draft" || value === "published" || value === "prerelease") return value;
  throw new Error(`Invalid GitHub release type: ${value}. Use draft, published, or prerelease.`);
}

function githubReleaseState(kind) {
  return {
    draft: kind === "draft",
    prerelease: kind === "prerelease",
  };
}

function parseRepo(value) {
  if (!value) return null;
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`Invalid --repo value: ${value}. Expected owner/repo.`);
  return { owner: match[1], repo: match[2] };
}

function electronPlatform(platform) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported Electron release platform: ${platform}`);
}

function assertGitClean() {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git status failed with exit code ${result.status ?? 1}`);
  }
  if (result.stdout.trim()) {
    throw new Error("Git working tree is dirty. Commit changes or pass --allow-dirty.");
  }
}

function resetDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved !== releaseRoot && !resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error(`Refusing to reset directory outside release/: ${directory}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function assertDirectory(directory, message) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error(message);
}

function assertFile(file, message) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stagingDirectoryName(packageName) {
  return packageName.replace(/^@/, "").replaceAll("/", "-");
}

function npmPublishEnv() {
  return {
    ...process.env,
    NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? path.join(releaseRoot, ".npm-cache"),
  };
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function printSummary({
  githubRepo,
  options: releaseOptions,
  releaseKind,
  releaseName,
  selectedNpmPackages,
  tagName,
}) {
  console.log("Release plan:");
  console.log(`- Version tag: ${tagName}`);
  console.log(`- Mode: ${releaseOptions.dryRun ? "dry-run" : "publish"}`);
  console.log(`- Build: ${releaseOptions.skipBuild ? "skipped" : "enabled"}`);
  if (releaseOptions.publishNpm) {
    console.log(
      `- npm packages: ${selectedNpmPackages.map((pkg) => pkg.manifest.name).join(", ")}`,
    );
    console.log(`- npm dist-tag/access: ${releaseOptions.npmTag}/${releaseOptions.npmAccess}`);
  } else {
    console.log("- npm packages: skipped");
  }
  if (releaseOptions.publishElectron) {
    console.log(`- Electron platform: ${electronPlatform(process.platform)}`);
    console.log(
      `- GitHub release: ${githubRepo.owner}/${githubRepo.repo} ${releaseName} (${releaseKind})`,
    );
  } else {
    console.log("- Electron GitHub Release assets: skipped");
  }
}

function printUsage() {
  console.log(`Usage: pnpm release -- [options]

Publishes npm packages and uploads the current platform's Electron artifacts to GitHub Release.

Options:
  --dry-run                 Run npm publish --dry-run and only list GitHub uploads.
  --skip-build              Reuse existing dist/ and release/electron outputs.
  --skip-npm                Do not publish npm packages.
  --skip-electron           Do not package/upload Electron artifacts.
  --tag <tag>               Release tag. Defaults to v<root package version>.
  --release-name <name>     GitHub release name. Defaults to the tag.
  --github-release <type>   draft, published, or prerelease. Defaults to electron-builder config.
  --repo <owner/repo>       GitHub repository. Defaults to electron-builder config.
  --target-commitish <ref>  Ref used when creating a missing GitHub Release.
  --no-clobber              Fail if an uploaded Electron asset already exists.
  --allow-dirty             Allow publishing with a dirty git working tree.
  --npm-package <name>      Publish one package, repeatable or comma-separated.
  --npm-tag <tag>           npm dist-tag. Defaults to latest.
  --npm-access <access>     npm access. Defaults to public.
  --npm-provenance          Pass --provenance to npm publish.
  --otp <code>              npm two-factor authentication code.
  -h, --help                Show this help.

Required credentials for a real release:
  npm: npm login or NPM_TOKEN in npm config.
  GitHub: GH_TOKEN or GITHUB_TOKEN with contents:write.
`);
}
