import { APP_EXTENSION_PERMISSIONS } from "@agui/extensions";
import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const localId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const extensionId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const workspaceId = z.union([z.literal(""), id.max(512)]).optional();
const text = (max: number) => z.string().max(max);
const filePath = text(32_768);
const httpsUrl = text(8_192).url().startsWith("https://");
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/);
const noParams = z.undefined();
const stringMap = z.record(z.string().min(1).max(256), z.string().max(1_000_000));
const storageKey = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const storageNamespace = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();

const provider = z.strictObject({
  id,
  name: text(1_024).min(1),
  description: text(8_192).optional(),
  command: text(32_768),
  args: z.array(text(32_768)).max(1_000),
  env: stringMap,
  enabled: z.boolean(),
  transport: z.enum(["stdio", "persistent-stdio", "websocket", "ssh"]),
  url: text(16_384).optional(),
  installCommand: text(65_536).optional(),
  timeoutMs: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 60 * 60 * 1_000)
    .optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  models: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
});

const conversationContext = z.looseObject({
  schemaVersion: z.literal("1"),
  handoffId: id,
  workItemId: id,
  fromParticipantId: id.optional(),
  toParticipantId: id,
  sourceSeq: z.number().int().nonnegative(),
  highWatermarkSeq: z.number().int().nonnegative(),
  objective: text(2_000_000),
  requestedAction: z.enum(["continue", "review", "investigate", "take_over"]),
  digest: text(256),
  messages: z.array(z.record(z.string(), z.unknown())).max(10_000),
  artifacts: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
  files: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
  omitted: z.record(z.string(), z.unknown()).optional(),
});

const runInput = z.strictObject({
  uiSessionId: id,
  clientRequestId: id.optional(),
  providerId: id,
  providerSessionId: id.optional(),
  cwd: filePath.min(1),
  prompt: text(16_000_000),
  conversationContext: conversationContext.optional(),
  attachments: z
    .array(
      z.strictObject({
        kind: z.enum(["directory", "file", "other"]),
        name: text(8_192),
        path: filePath,
        handoffFileId: id.optional(),
      }),
    )
    .max(1_000)
    .optional(),
  inputParts: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
  approvalMode: z.enum(["suggest", "auto-edit", "full-auto"]),
  model: text(1_024).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  speed: z.enum(["default", "fast"]).optional(),
  additionalDeveloperInstructions: text(2_000_000).optional(),
  extensions: z
    .array(
      z.looseObject({
        id,
        version: text(256).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(256)
    .optional(),
  mcpServers: z.unknown().optional(),
  skills: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
  enabledAppExtensions: z.array(extensionId).max(1_000).optional(),
  preserveNativeEvents: z.boolean().optional(),
});

const scheduledTaskSchedule = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("once"),
    date: text(32),
    time: text(16),
  }),
  z.strictObject({
    type: z.literal("daily"),
    time: text(16),
  }),
  z.strictObject({
    type: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    time: text(16),
  }),
  z.strictObject({
    type: z.literal("interval"),
    intervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(365 * 24 * 60),
  }),
]);

const scheduledTaskInput = z.strictObject({
  approvalMode: z.enum(["suggest", "auto-edit", "full-auto"]).optional(),
  cwd: filePath.nullable().optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  enabled: z.boolean(),
  model: text(1_024).optional(),
  projectPath: filePath.nullable(),
  prompt: text(16_000_000),
  providerId: id,
  schedule: scheduledTaskSchedule,
  speed: z.enum(["default", "fast"]).optional(),
  title: text(1_024),
  workspaceId: id.max(512).optional(),
});

const pair = (...keys: string[]) =>
  z.strictObject(Object.fromEntries(keys.map((key) => [key, id])));
const workspaceRoot = z.strictObject({ root: filePath.min(1) });
const ideFile = workspaceRoot.extend({ filePath: filePath.min(1) });
const ideContent = ideFile.extend({ content: text(2_000_000) });
const browserId = localId.optional();
const browserBounds = z.strictObject({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
  visible: z.boolean().optional(),
});
const browserRect = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
});
const browserWait = z.enum(["load", "domcontentloaded", "none"]).optional();
const browserTimeout = z
  .number()
  .int()
  .min(0)
  .max(10 * 60_000)
  .optional();
const optionalBrowserTarget = z.strictObject({ id: browserId }).optional();
const browserElementTarget = z.strictObject({
  id: browserId,
  selector: text(32_768).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});
const browserWorkflowStep = z.looseObject({
  clearFirst: z.boolean().optional(),
  input: text(128).optional(),
  note: text(2_000).optional(),
  rect: browserRect.optional(),
  saveAs: text(128).optional(),
  selector: text(32_768).optional(),
  text: text(200_000).optional(),
  textContains: text(8_192).optional(),
  timeoutMs: browserTimeout,
  type: z.enum(["assert", "click", "navigate", "snapshot", "submit", "type", "waitFor"]),
  url: text(16_384).optional(),
  urlIncludes: text(4_096).optional(),
  waitAfterMs: z.number().int().min(0).max(60_000).optional(),
  waitUntil: browserWait,
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});
const browserWorkflowSaveInput = z.looseObject({
  description: text(2_000).optional(),
  enabled: z.boolean().optional(),
  id: text(160).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  requireConfirmation: z.boolean().optional(),
  sideEffect: z.boolean().optional(),
  steps: z.array(browserWorkflowStep).max(200).optional(),
  tags: z.array(text(64)).max(20).optional(),
  title: text(160).optional(),
  toolName: text(128).optional(),
});
const browserCdpDomain = z.enum([
  "CSS",
  "DOM",
  "Log",
  "Network",
  "Page",
  "Performance",
  "Runtime",
  "Tracing",
]);
const browserCdpMethod = text(160).regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/);
const browserCdpMethods = z.array(browserCdpMethod).max(128).optional();
const panelState = z.strictObject({
  activeDetailPanelId: id.nullable().optional(),
  activeDetailPanelTabId: id.nullable().optional(),
  detailPanelOpen: z.boolean(),
  panels: z
    .array(
      z.strictObject({
        allowMultiple: z.boolean().optional(),
        id,
        order: z.number().finite().optional(),
        title: text(1_024),
      }),
    )
    .max(200),
  project: z
    .strictObject({
      root: filePath.optional(),
      workspaceId,
    })
    .optional(),
  tabs: z
    .array(
      z.strictObject({
        active: z.boolean().optional(),
        createdAt: z.number().finite().optional(),
        id,
        ordinal: z.number().finite().optional(),
        panelId: id,
        title: text(1_024).optional(),
      }),
    )
    .max(200),
  updatedAt: z.number().finite().optional(),
});
const idePanelState = z.strictObject({
  activeContent: text(1_000_000).optional(),
  activePath: filePath.nullable().optional(),
  root: filePath.optional(),
  tabs: z
    .array(
      z.strictObject({
        diagnostics: z.array(z.unknown()).max(500).optional(),
        diagnosticsLoading: z.boolean().optional(),
        dirty: z.boolean().optional(),
        error: text(8_192).optional(),
        language: text(256).optional(),
        mtimeMs: z.number().finite().optional(),
        name: text(1_024).optional(),
        path: filePath,
      }),
    )
    .max(200),
  updatedAt: z.number().finite().optional(),
});

const mcpAuthentication = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), token: text(65_536) }),
  z.strictObject({
    type: z.literal("api-key"),
    headerName: text(256).optional(),
    value: text(65_536),
  }),
  z.strictObject({ type: z.literal("basic"), username: text(8_192), password: text(65_536) }),
]);

const mcpServer = z.strictObject({
  args: z.array(text(32_768)).max(1_000).optional(),
  authentication: mcpAuthentication.optional(),
  command: text(32_768).optional(),
  enabled: z.boolean(),
  env: stringMap.optional(),
  headers: stringMap.optional(),
  id: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  label: text(1_024).optional(),
  type: z.enum(["http", "sse", "stdio"]).optional(),
  url: text(16_384).optional(),
});

const mcpGatewayScope = z.strictObject({
  workspacePath: filePath.optional(),
  workspaceId,
});

const extensionPermission = z.enum(APP_EXTENSION_PERMISSIONS);

const schemas: Record<string, z.ZodType> = {
  "runtime.info": noParams,
  "providers.list": noParams,
  "providers.save": provider,
  "providers.remove": id,
  "providers.test": provider,
  "providers.capabilities": z.strictObject({ providerId: id, cwd: filePath.min(1) }),
  "providers.detect": noParams,
  "workspace.choose": filePath.optional(),
  "workspace.getDefault": noParams,
  "workspace.listDirectories": z.strictObject({ path: filePath.optional() }).optional(),
  "workspace.privateRoot": noParams,
  "workspace.privateSession": z.strictObject({
    sessionId: id,
    createdAt: z.number().finite().optional(),
  }),
  "mcpGateway.getSettings": mcpGatewayScope.optional(),
  "mcpGateway.setEnabled": mcpGatewayScope.extend({ enabled: z.boolean() }),
  "mcpGateway.setLlm": mcpGatewayScope.extend({
    apiKey: text(65_536).optional(),
    baseUrl: text(16_384).optional(),
    enabled: z.boolean(),
    model: text(1_024).optional(),
  }),
  "mcpGateway.saveServer": mcpServer.extend({
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "mcpGateway.removeServer": mcpGatewayScope.extend({ id }),
  "mcpGateway.refresh": mcpGatewayScope.optional(),
  "browserWorkflows.list": noParams,
  "browserWorkflows.get": z.strictObject({
    id: text(160).optional(),
    toolName: text(128).optional(),
  }),
  "browserWorkflows.save": browserWorkflowSaveInput,
  "browserWorkflows.remove": z.strictObject({
    id: text(160).optional(),
    toolName: text(128).optional(),
  }),
  "browserWorkflows.generateFromAnnotations": z.strictObject({
    browserId,
    description: text(2_000).optional(),
    id: text(160).optional(),
    save: z.boolean().optional(),
    title: text(160).optional(),
  }),
  "scheduledTasks.list": noParams,
  "scheduledTasks.add": scheduledTaskInput,
  "scheduledTasks.update": z.strictObject({ id, task: scheduledTaskInput }),
  "scheduledTasks.remove": z.strictObject({ id }),
  "scheduledTasks.setEnabled": z.strictObject({ id, enabled: z.boolean() }),
  "scheduledTasks.runNow": z.strictObject({ id }),
  "storage.get": z.strictObject({ key: storageKey, namespace: storageNamespace }),
  "storage.set": z.strictObject({
    key: storageKey,
    namespace: storageNamespace,
    value: text(32 * 1024 * 1024),
  }),
  "storage.remove": z.strictObject({ key: storageKey, namespace: storageNamespace }),
  "storage.list": z
    .strictObject({
      namespace: storageNamespace,
      prefix: storageKey.optional(),
    })
    .optional(),
  "sessions.run": runInput,
  "sessions.cancel": id,
  "sessions.cleanupHandoffFiles": id,
  "sessions.invokeExtension": z.strictObject({
    uiSessionId: id,
    extension: extensionId,
    method: id,
    runId: id.optional(),
    providerSessionId: id.optional(),
    payload: z.unknown().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(10 * 60_000)
      .optional(),
  }),
  "sessions.list": z.strictObject({ providerId: id, cwd: filePath.min(1) }),
  "sessions.create": z.strictObject({
    providerId: id,
    cwd: filePath.min(1),
    title: text(8_192).optional(),
  }),
  "sessions.close": pair("providerId", "providerSessionId").extend({
    cwd: filePath.min(1),
  }),
  "sessions.messages": pair("providerId", "providerSessionId"),
  "sessions.usage": pair("providerId", "providerSessionId"),
  "sessions.resume": pair("providerId", "providerSessionId").extend({ cwd: filePath.min(1) }),
  "sessions.hydrateTranscript": z.strictObject({
    cwd: filePath.min(1),
    previousContextUsage: z
      .strictObject({
        used: z.number().nonnegative(),
        usedKnown: z.boolean().optional(),
        size: z.number().nonnegative(),
        source: z.string().max(256).optional(),
        cost: z
          .strictObject({ amount: z.number().finite(), currency: text(32).min(1) })
          .nullable()
          .optional(),
      })
      .optional(),
    providerId: id,
    providerSessionId: id,
    providers: z.array(provider).max(1_000).optional(),
    transcriptPath: filePath.optional(),
  }),
  "sessions.delete": pair("providerId", "providerSessionId").extend({
    cwd: filePath.min(1),
    transcriptPath: filePath.optional(),
  }),
  "interactions.respondApproval": z.strictObject({
    requestId: id,
    decision: z.enum(["allow", "allow-session", "allow-always", "deny", "cancel"]),
    message: text(1_000_000).optional(),
  }),
  "interactions.respondQuestion": z.strictObject({
    requestId: id,
    response: z.looseObject({
      answers: z.array(z.unknown()).max(1_000).optional(),
      canceled: z.boolean().optional(),
      unanswered: z.boolean().optional(),
      result: z.unknown().optional(),
    }),
  }),
  "interactions.pending": noParams,
  "panel.syncState": panelState,
  "panel.syncIdeState": idePanelState,
  "terminal.run": z.strictObject({
    id: localId,
    command: text(8_192).min(1),
    cwd: filePath.optional(),
  }),
  "terminal.exec": z.strictObject({
    id: localId,
    command: text(1_024).min(1),
    args: z.array(text(8_192)).max(100).optional(),
    cwd: filePath.optional(),
  }),
  "terminal.cancel": localId,
  "terminal.create": z.strictObject({ id: localId, cwd: filePath.optional() }),
  "terminal.write": z.strictObject({ id: localId, data: text(8_192) }),
  "terminal.resize": z.strictObject({
    id: localId,
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  "terminal.dispose": localId,
  "ide.tree": workspaceRoot,
  "ide.readFile": ideFile,
  "ide.writeFile": ideContent,
  "ide.diagnostics": ideContent,
  "ide.workspaceDiagnostics": workspaceRoot,
  "ide.semanticTokens": ideContent,
  "browser.list": noParams,
  "browser.unregister": localId,
  "browser.releaseFocus": noParams,
  "browser.create": z.strictObject({
    id: localId,
    url: text(16_384).optional(),
    title: text(8_192).optional(),
    bounds: browserBounds.optional(),
  }),
  "browser.register": z.strictObject({
    id: localId,
    webContentsId: z.number().int().positive(),
    title: text(8_192).optional(),
    url: text(16_384).optional(),
  }),
  "browser.setBounds": z.strictObject({ id: localId, bounds: browserBounds }),
  "browser.navigate": z.strictObject({
    id: browserId,
    url: text(16_384).min(1),
    waitUntil: browserWait,
    timeoutMs: browserTimeout,
  }),
  "browser.reload": z
    .strictObject({ id: browserId, waitUntil: browserWait, timeoutMs: browserTimeout })
    .optional(),
  "browser.stop": optionalBrowserTarget,
  "browser.goBack": optionalBrowserTarget,
  "browser.goForward": optionalBrowserTarget,
  "browser.evaluate": z.strictObject({
    id: browserId,
    expression: text(2_000_000).min(1),
    awaitPromise: z.boolean().optional(),
  }),
  "browser.click": z.strictObject({
    id: browserId,
    selector: text(32_768).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  }),
  "browser.type": z.strictObject({
    id: browserId,
    selector: text(32_768).optional(),
    text: text(2_000_000),
  }),
  "browser.snapshot": optionalBrowserTarget,
  "browser.screenshot": z
    .strictObject({
      id: browserId,
      format: z.enum(["png", "jpeg"]).optional(),
      quality: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
  "browser.setAnnotationMode": z.strictObject({
    id: browserId,
    enabled: z.boolean(),
  }),
  "browser.setWorkflowRecordingMode": z.strictObject({
    id: browserId,
    enabled: z.boolean(),
  }),
  "browser.listAnnotations": optionalBrowserTarget,
  "browser.clearAnnotations": optionalBrowserTarget,
  "browser.addAnnotation": z.strictObject({
    id: browserId,
    annotationId: text(256).optional(),
    type: z.enum(["element", "region"]).optional(),
    note: text(20_000).min(1),
    selector: text(32_768).optional(),
    rect: browserRect.optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().optional(),
    height: z.number().finite().optional(),
  }),
  "browser.deleteAnnotation": z.strictObject({
    id: browserId,
    annotationId: text(256).min(1),
  }),
  "browser.inspectElement": browserElementTarget,
  "browser.cdpCommand": z.strictObject({
    id: browserId,
    method: browserCdpMethod,
    params: z.record(z.string().min(1).max(256), z.unknown()).optional(),
  }),
  "browser.cdpStartCapture": z
    .strictObject({
      id: browserId,
      domains: z.array(browserCdpDomain).max(16).optional(),
      methods: browserCdpMethods,
      maxEvents: z.number().int().min(1).max(10_000).optional(),
      clear: z.boolean().optional(),
    })
    .optional(),
  "browser.cdpEvents": z
    .strictObject({
      id: browserId,
      methods: browserCdpMethods,
      methodPrefix: text(160)
        .regex(/^[A-Za-z0-9.]+$/)
        .optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
      clear: z.boolean().optional(),
    })
    .optional(),
  "browser.cdpStopCapture": optionalBrowserTarget,
  "browser.screencastStart": z
    .strictObject({
      id: browserId,
      format: z.enum(["png", "jpeg"]).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      maxWidth: z.number().int().min(1).max(4096).optional(),
      maxHeight: z.number().int().min(1).max(4096).optional(),
      everyNthFrame: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  "browser.screencastAck": z.strictObject({
    id: browserId,
    sessionId: z.number().int().nonnegative(),
  }),
  "browser.screencastStop": optionalBrowserTarget,
  "browser.dispatchMouse": z.strictObject({
    id: browserId,
    type: z.enum(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(["none", "left", "middle", "right", "back", "forward"]).optional(),
    buttons: z.number().int().min(0).max(31).optional(),
    clickCount: z.number().int().min(0).max(10).optional(),
    deltaX: z.number().finite().optional(),
    deltaY: z.number().finite().optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  "browser.dispatchKey": z.strictObject({
    id: browserId,
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: text(128).optional(),
    code: text(128).optional(),
    text: text(4_096).optional(),
    unmodifiedText: text(4_096).optional(),
    windowsVirtualKeyCode: z.number().int().nonnegative().optional(),
    nativeVirtualKeyCode: z.number().int().nonnegative().optional(),
    autoRepeat: z.boolean().optional(),
    isKeypad: z.boolean().optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  "browser.insertText": z.strictObject({
    id: browserId,
    text: text(200_000),
  }),
  "interactiveApp.create": z.strictObject({
    id: localId,
    bridge: z.boolean().optional(),
    bridgeScript: text(2_000_000).optional(),
    html: text(16_000_000).optional(),
    url: text(16_384).optional(),
    bounds: browserBounds.optional(),
    title: text(8_192).optional(),
    userAgent: text(500).optional(),
    userStyle: text(10_000).optional(),
  }),
  "interactiveApp.destroy": localId,
  "interactiveApp.setBounds": z.strictObject({ id: localId, bounds: browserBounds }),
  "interactiveApp.postMessage": z.strictObject({ id: localId, message: z.unknown() }),
  "extensions.list": z
    .strictObject({
      workspacePath: filePath.optional(),
      workspaceId,
      extensionIds: z.array(extensionId).max(1_000).optional(),
    })
    .optional(),
  "extensions.audit": z
    .strictObject({
      extensionId: extensionId.optional(),
      limit: z.number().int().min(1).max(200).optional(),
      workspacePath: filePath.optional(),
      workspaceId,
    })
    .optional(),
  "extensions.marketplace": z
    .strictObject({
      includePrerelease: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      query: text(512).optional(),
      workspacePath: filePath.optional(),
      workspaceId,
    })
    .optional(),
  "extensions.chooseInstall": noParams,
  "extensions.chooseUpdate": noParams,
  "extensions.install": z
    .strictObject({
      expectedSha256: sha256.optional(),
      sourcePath: filePath.min(1).optional(),
      sourceUrl: httpsUrl.optional(),
      updateUrl: httpsUrl.optional(),
      workspacePath: filePath.optional(),
      workspaceId,
    })
    .refine((input) => Boolean(input.sourcePath) !== Boolean(input.sourceUrl), {
      message: "Provide exactly one of sourcePath or sourceUrl.",
    })
    .refine((input) => !input.sourceUrl || Boolean(input.expectedSha256), {
      message: "Remote extension installs require expectedSha256.",
      path: ["expectedSha256"],
    }),
  "extensions.update": z
    .strictObject({
      extensionId,
      expectedSha256: sha256.optional(),
      sourcePath: filePath.min(1).optional(),
      sourceUrl: httpsUrl.optional(),
      workspacePath: filePath.optional(),
      workspaceId,
    })
    .refine((input) => !(input.sourcePath && input.sourceUrl), {
      message: "Provide at most one of sourcePath or sourceUrl.",
    })
    .refine((input) => Boolean(input.sourcePath) || Boolean(input.expectedSha256), {
      message: "Remote extension updates require expectedSha256.",
      path: ["expectedSha256"],
    }),
  "extensions.uninstall": z.union([
    extensionId,
    z.strictObject({ extensionId, workspacePath: filePath.optional(), workspaceId }),
  ]),
  "extensions.setEnabled": z.strictObject({
    extensionId,
    enabled: z.boolean(),
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "extensions.grant": z.strictObject({
    extensionId,
    permissions: z.array(extensionPermission).max(64),
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "extensions.setWorkspaceTrust": z.strictObject({
    workspacePath: filePath.min(1),
    workspaceId,
    trusted: z.boolean(),
  }),
  "extensions.workspaceTrusted": z.strictObject({ workspacePath: filePath.min(1) }),
  "extensions.readAsset": z.strictObject({
    extensionId,
    path: filePath.min(1),
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "extensions.activate": z.strictObject({
    extensionId,
    event: text(1_024).min(1),
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "extensions.executeCommand": z.strictObject({
    extensionId,
    command: id,
    args: z.array(z.unknown()).max(100).optional(),
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "extensions.resolveAgent": z.strictObject({
    workspacePath: filePath.min(1),
    workspaceId,
    extensionIds: z.array(extensionId).max(1_000).optional(),
  }),
  "extensions.getConfiguration": z.strictObject({
    extensionId,
    workspacePath: filePath.optional(),
    workspaceId,
  }),
  "extensions.updateConfiguration": z.strictObject({
    extensionId,
    values: z.record(z.string(), z.unknown()),
    workspacePath: filePath.optional(),
    workspaceId,
  }),
};

export type RuntimeMethod = keyof typeof schemas;

export class RuntimeMethodValidationError extends Error {
  constructor(
    readonly method: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Invalid parameters for ${method}: ${z.prettifyError(new z.ZodError(issues))}`);
    this.name = "RuntimeMethodValidationError";
  }
}

export function parseRuntimeMethodParams(method: string, params: unknown): unknown {
  const schema = schemas[method];
  if (!schema) throw new Error(`Unknown runtime method: ${method}`);
  const result = schema.safeParse(params);
  if (!result.success) throw new RuntimeMethodValidationError(method, result.error.issues);
  return result.data;
}

export function isRuntimeMethod(method: string): method is RuntimeMethod {
  return Object.prototype.hasOwnProperty.call(schemas, method);
}
