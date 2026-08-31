import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { APP_EXTENSION_PERMISSIONS } from "../packages/extensions/dist/index.js";
import { parseRuntimeMethodParams } from "../packages/runtime/dist/runtime-method-schema.js";
import { extractAguix } from "../packages/server/dist/extensions/extension-package.js";
import { ServerExtensionService } from "../packages/server/dist/extensions/server-extension-service.js";
import {
  isUiAsset,
  normalizeWorkspacePath,
  readExtension,
} from "../packages/server/dist/extensions/server-extension-service-helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agui-extension-contracts-"));
const fixtureSha256 = "a".repeat(64);

try {
  assert.deepEqual(
    parseRuntimeMethodParams("extensions.grant", {
      extensionId: "fixture.contract",
      permissions: [...APP_EXTENSION_PERMISSIONS],
    }).permissions,
    [...APP_EXTENSION_PERMISSIONS],
    "Every canonical extension permission must be accepted by the runtime transport.",
  );
  assert.equal(
    parseRuntimeMethodParams("extensions.install", {
      expectedSha256: fixtureSha256,
      sourceUrl: "https://example.com/fixture.contract.aguix",
      updateUrl: "https://example.com/fixture.contract.latest.aguix",
    }).sourceUrl,
    "https://example.com/fixture.contract.aguix",
    "Extension install must accept online package sources.",
  );
  assert.throws(
    () =>
      parseRuntimeMethodParams("extensions.install", {
        sourceUrl: "https://example.com/fixture.contract.aguix",
      }),
    /Remote extension installs require expectedSha256/,
  );
  assert.throws(
    () =>
      parseRuntimeMethodParams("extensions.install", {
        sourcePath: "/tmp/fixture.contract.aguix",
        sourceUrl: "https://example.com/fixture.contract.aguix",
      }),
    /Provide exactly one of sourcePath or sourceUrl/,
  );
  assert.equal(
    parseRuntimeMethodParams("extensions.update", {
      extensionId: "fixture.contract",
      expectedSha256: fixtureSha256,
      sourceUrl: "https://example.com/fixture.contract.aguix",
    }).sourceUrl,
    "https://example.com/fixture.contract.aguix",
    "Extension update must accept online package sources.",
  );
  assert.throws(
    () =>
      parseRuntimeMethodParams("extensions.update", {
        extensionId: "fixture.contract",
        sourceUrl: "https://example.com/fixture.contract.aguix",
      }),
    /Remote extension updates require expectedSha256/,
  );
  assert.throws(
    () =>
      parseRuntimeMethodParams("extensions.update", {
        extensionId: "fixture.contract",
      }),
    /Remote extension updates require expectedSha256/,
  );
  assert.throws(
    () =>
      parseRuntimeMethodParams("extensions.update", {
        extensionId: "fixture.contract",
        sourcePath: "/tmp/fixture.contract.aguix",
        sourceUrl: "https://example.com/fixture.contract.aguix",
      }),
    /Provide at most one of sourcePath or sourceUrl/,
  );
  assert.throws(
    () =>
      parseRuntimeMethodParams("extensions.update", {
        extensionId: "fixture.contract",
        sourceUrl: "http://example.com/fixture.contract.aguix",
      }),
    /must start with/,
  );

  const catalogPath = path.join(temporaryRoot, "marketplace.json");
  writeJson(catalogPath, {
    items: [
      {
        id: "fixture.no-integrity",
        name: "no-integrity",
        publisher: "fixture",
        version: "1.0.0",
        sourceUrl: "https://example.com/no-integrity.aguix",
      },
      {
        id: "fixture.integrity",
        name: "integrity",
        publisher: "fixture",
        version: "1.0.0",
        sourceUrl: "https://example.com/integrity.aguix",
        sha256: fixtureSha256,
      },
    ],
  });
  const previousCatalogSources = process.env.AG_UI_EXTENSION_MARKETPLACE_URLS;
  const previousLegacyCatalogSources = process.env.AGUI_EXTENSION_MARKETPLACE_URLS;
  process.env.AG_UI_EXTENSION_MARKETPLACE_URLS = catalogPath;
  process.env.AGUI_EXTENSION_MARKETPLACE_URLS = catalogPath;
  try {
    const service = new ServerExtensionService({
      emit() {},
      homeDir: () => path.join(temporaryRoot, "home"),
    });
    const marketplace = await service.marketplace();
    assert.deepEqual(
      marketplace.items.map((item) => item.id),
      ["fixture.integrity"],
      "Marketplace items without SHA-256 integrity metadata must be filtered out.",
    );
    assert.equal(marketplace.items[0]?.sha256, fixtureSha256);
  } finally {
    if (previousCatalogSources === undefined) delete process.env.AG_UI_EXTENSION_MARKETPLACE_URLS;
    else process.env.AG_UI_EXTENSION_MARKETPLACE_URLS = previousCatalogSources;
    if (previousLegacyCatalogSources === undefined)
      delete process.env.AGUI_EXTENSION_MARKETPLACE_URLS;
    else process.env.AGUI_EXTENSION_MARKETPLACE_URLS = previousLegacyCatalogSources;
  }

  const cssSanitizerSource = fs.readFileSync(
    path.join(root, "packages", "app", "src", "extensions", "extension-css.ts"),
    "utf8",
  );
  assert.match(cssSanitizerSource, /\^https:\\\/\\\//);
  assert.doesNotMatch(cssSanitizerSource, /\^https\?:\\\/\\\//);
  const declarativeViewSource = fs.readFileSync(
    path.join(root, "packages", "app", "src", "extensions", "DeclarativeExtensionView.tsx"),
    "utf8",
  );
  assert.match(declarativeViewSource, /parsed\.protocol === "https:"/);
  assert.doesNotMatch(declarativeViewSource, /parsed\.protocol === "http:"/);

  const codexRoot = path.join(temporaryRoot, "codex-plugin");
  writeJson(path.join(codexRoot, ".codex-plugin", "plugin.json"), {
    id: "real-plugin-id",
    name: "Real Plugin Display Name",
    version: "1.2.3",
  });
  assert.throws(() => readExtension(codexRoot, "user"), /Extension requires package\.json/);

  const legacyPanelRoot = path.join(temporaryRoot, "legacy-panel-extension");
  writeJson(path.join(legacyPanelRoot, "package.json"), {
    name: "legacy-panel",
    publisher: "fixture",
    version: "1.0.0",
    engines: { agui: "^0.2.0" },
    contributes: {
      detailPanels: [{ id: "fixture.legacy-panel.panel", title: "Legacy panel" }],
    },
  });
  assert.throws(
    () => readExtension(legacyPanelRoot, "user"),
    /Unsupported extension contribution: contributes\.detailPanels/,
  );

  const floatingRoot = path.join(temporaryRoot, "floating-widget-extension");
  writeJson(path.join(floatingRoot, "status-widget.json"), {
    type: "box",
    children: [{ type: "text", text: "Floating" }],
  });
  writeJson(path.join(floatingRoot, "package.json"), {
    name: "floating-widget",
    publisher: "fixture",
    version: "1.0.0",
    engines: { agui: "^0.2.0" },
    contributes: {
      floatingWidgets: [
        {
          id: "fixture.floating-widget.status",
          title: "Status",
          viewType: "declarative",
          entry: "./status-widget.json",
        },
      ],
    },
  });
  const floating = readExtension(floatingRoot, "user");
  assert.ok(floating.manifest.permissions.includes("ui.floatingWidget"));
  assert.ok(floating.manifest.permissions.includes("ui.render.declarative"));
  assert.equal(isUiAsset(floating.manifest, "./status-widget.json"), true);

  const source = path.join(temporaryRoot, "package-source");
  writeJson(path.join(source, "package.json"), {
    name: "package-contract",
    publisher: "fixture",
    version: "1.0.0",
    engines: { agui: "^0.2.0" },
  });
  fs.writeFileSync(path.join(source, "run.sh"), "#!/bin/sh\necho packaged\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, ".env"), "SECRET_SHOULD_NOT_BE_PACKAGED=1\n");
  const archive = path.join(temporaryRoot, "fixture.package-contract.aguix");
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "package-extension.mjs"), source, archive],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  const extractionRoot = path.join(temporaryRoot, "extracted");
  fs.mkdirSync(extractionRoot);
  const extracted = await extractAguix(archive, extractionRoot);
  assert.equal(fs.existsSync(path.join(extracted, ".env")), false);
  if (process.platform !== "win32") {
    assert.notEqual(fs.statSync(path.join(extracted, "run.sh")).mode & 0o111, 0);
  }

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(root, "scripts", "package-extension.mjs"), codexRoot],
        { cwd: root, stdio: "pipe" },
      ),
    /Missing extension package\.json/,
  );

  if (process.platform !== "win32") {
    const workspaceA = path.join(temporaryRoot, "workspace-a");
    const workspaceB = path.join(temporaryRoot, "workspace-b");
    const workspaceLink = path.join(temporaryRoot, "workspace-current");
    fs.mkdirSync(workspaceA);
    fs.mkdirSync(workspaceB);
    fs.symlinkSync(workspaceA, workspaceLink, "dir");
    assert.equal(normalizeWorkspacePath(workspaceLink), fs.realpathSync.native(workspaceA));
    fs.unlinkSync(workspaceLink);
    fs.symlinkSync(workspaceB, workspaceLink, "dir");
    assert.equal(normalizeWorkspacePath(workspaceLink), fs.realpathSync.native(workspaceB));
  }

  assert.equal(
    fs.readFileSync(path.join(root, "packages", "electron", "extension-package.ts"), "utf8"),
    fs.readFileSync(
      path.join(root, "packages", "server", "src", "extensions", "extension-package.ts"),
      "utf8",
    ),
    "Electron and server package security implementations must remain identical.",
  );

  console.log(
    "✓ extension permission, integrity, network URL, workspace identity, unsupported manifest, and package contracts",
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
