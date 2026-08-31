import { z } from "zod";
import { ASP_NAME, ASP_VERSION } from "./types.js";

const identifierSchema = z.string().trim().min(1).max(256);
const optionalIdentifierSchema = identifierSchema.optional();
const metadataSchema = z.record(z.string(), z.unknown());
const jsonSchema = z.record(z.string(), z.unknown());
const jsonRpcVersionSchema = z.literal("2.0").optional();
const stopReasonSchema = z.enum([
  "end_turn",
  "canceled",
  "error",
  "timeout",
  "max_tokens",
  "max_turns",
  "refusal",
]);

export const aspExtensionMethodDescriptorSchema = z.looseObject({
  name: identifierSchema,
  description: z.string().max(8_192).optional(),
  inputSchema: jsonSchema.optional(),
  outputSchema: jsonSchema.optional(),
  requiresRun: z.boolean().optional(),
  safety: z.enum(["read", "write", "approval_required"]).optional(),
});

export const aspExtensionEventDescriptorSchema = z.looseObject({
  name: identifierSchema,
  description: z.string().max(8_192).optional(),
  payloadSchema: jsonSchema.optional(),
});

export const aspExtensionDescriptorSchema = z.looseObject({
  id: identifierSchema,
  version: identifierSchema,
  stability: z.enum(["stable", "experimental", "vendor"]),
  requiresCore: z.array(identifierSchema).max(64).optional(),
  methods: z.array(aspExtensionMethodDescriptorSchema).max(256).optional(),
  events: z.array(aspExtensionEventDescriptorSchema).max(256).optional(),
  schemas: jsonSchema.optional(),
  fallback: z.enum(["core", "raw", "none"]).optional(),
  metadata: metadataSchema.optional(),
});

const extensionUseSchema = z.looseObject({
  id: identifierSchema,
  version: identifierSchema.optional(),
  options: metadataSchema.optional(),
});

const attachmentSchema = z.looseObject({
  kind: z.enum(["directory", "file", "other"]),
  name: z.string().max(8_192),
  path: z.string().max(32_768),
});

const approvalDecisionSchema = z.enum(["allow", "allow-session", "allow-always", "deny", "cancel"]);

const tokenUsageSchema = z.looseObject({
  contextTokens: z.number().nonnegative().optional(),
  contextWindowTokens: z.number().positive().optional(),
  inputCachedTokens: z.number().nonnegative().optional(),
  inputTokens: z.number().nonnegative(),
  outputCachedTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
});

const toolSemanticSchema = z.looseObject({
  toolType: identifierSchema,
  operation: z.string().max(256).optional(),
  schemaRef: z.string().max(2_048).optional(),
  resultKind: z.enum(["text", "json", "diff", "diagnostics", "locations", "artifact"]).optional(),
});

export const aspToolEventSchema: z.ZodType = z.lazy(() =>
  z.looseObject({
    children: z.array(aspToolEventSchema).max(1_000).optional(),
    error: z.string().max(1_000_000).optional(),
    id: identifierSchema,
    input: z.unknown().optional(),
    kind: identifierSchema,
    metadata: metadataSchema.optional(),
    name: z.string().min(1).max(8_192),
    output: z.string().max(16_000_000).optional(),
    parentId: optionalIdentifierSchema,
    phase: z.enum(["started", "updated", "delta", "completed"]),
    semantic: toolSemanticSchema.optional(),
    status: z.string().max(1_024).optional(),
  }),
);

const interactiveAppSchema = z.looseObject({
  title: z.string().max(8_192).optional(),
  html: z.string().max(16_000_000).optional(),
  src: z.string().max(16_384).optional(),
  uri: z.string().max(16_384).optional(),
  resourceUri: z.string().max(16_384).optional(),
  height: z.number().nonnegative().max(20_000).optional(),
  toolInput: z.unknown().optional(),
  toolOutput: z.unknown().optional(),
  toolResponseMetadata: z.unknown().optional(),
  widgetState: z.unknown().optional(),
  metadata: metadataSchema.optional(),
});

export const aspMessagePartSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("text"),
    id: identifierSchema,
    content: z.string().max(16_000_000),
    format: z.enum(["markdown", "plain"]).optional(),
    metadata: metadataSchema.optional(),
    title: z.string().max(8_192).optional(),
  }),
  z.looseObject({
    type: z.enum(["reasoning", "status", "citation"]),
    id: identifierSchema,
    content: z.string().max(16_000_000).optional(),
    metadata: metadataSchema.optional(),
    status: z.string().max(1_024).optional(),
    title: z.string().max(8_192).optional(),
    uri: z.string().max(16_384).optional(),
  }),
  z.looseObject({
    type: z.literal("plan"),
    id: identifierSchema,
    content: z.string().max(16_000_000).optional(),
    items: z.array(z.string().max(1_000_000)).max(10_000).optional(),
    metadata: metadataSchema.optional(),
    title: z.string().max(8_192).optional(),
  }),
  z.looseObject({
    type: z.enum(["resource", "artifact"]),
    id: identifierSchema,
    artifactId: optionalIdentifierSchema,
    app: interactiveAppSchema.optional(),
    content: z.string().max(16_000_000).optional(),
    metadata: metadataSchema.optional(),
    mimeType: z.string().max(256).optional(),
    name: z.string().max(8_192).optional(),
    path: z.string().max(32_768).optional(),
    title: z.string().max(8_192).optional(),
    uri: z.string().max(16_384).optional(),
  }),
  z.looseObject({
    type: z.literal("diff"),
    id: identifierSchema,
    content: z.string().max(16_000_000),
    language: z.string().max(256).optional(),
    metadata: metadataSchema.optional(),
    oldPath: z.string().max(32_768).optional(),
    path: z.string().max(32_768).optional(),
    title: z.string().max(8_192).optional(),
  }),
  z.looseObject({
    type: z.literal("raw"),
    id: identifierSchema,
    label: z.string().max(8_192).optional(),
    metadata: metadataSchema.optional(),
    value: z.unknown(),
  }),
  z.looseObject({
    type: z.literal("tool"),
    id: identifierSchema,
    toolEvent: aspToolEventSchema,
  }),
]);

const checkpointSchema = z.looseObject({
  id: identifierSchema,
  title: z.string().max(8_192).optional(),
  createdAt: z.number().nonnegative().optional(),
  metadata: metadataSchema.optional(),
});

const sessionStateSchema = z.looseObject({
  providerSessionId: optionalIdentifierSchema,
  title: z.string().max(8_192).optional(),
  cwd: z.string().max(32_768).optional(),
  model: z.string().max(1_024).optional(),
  effort: z.string().max(256).optional(),
  streaming: z.boolean().optional(),
  queue: z
    .looseObject({
      pending: z.number().int().nonnegative(),
      mode: z.string().max(256).optional(),
    })
    .optional(),
  context: z
    .looseObject({
      usedTokens: z.number().nonnegative().optional(),
      windowTokens: z.number().positive().optional(),
      autoCompaction: z.boolean().optional(),
    })
    .optional(),
  parentSessionId: optionalIdentifierSchema,
  checkpoints: z.array(checkpointSchema).max(10_000).optional(),
  metadata: metadataSchema.optional(),
});

const extensionFallbackSchema = z.union([
  z.literal("none"),
  z.looseObject({ type: z.literal("message_delta"), data: z.string().max(16_000_000) }),
  z.looseObject({ type: z.literal("message_part"), part: aspMessagePartSchema }),
  z.looseObject({ type: z.literal("tool_event"), toolEvent: aspToolEventSchema }),
  z.looseObject({
    type: z.literal("usage"),
    usage: tokenUsageSchema,
    model: z.string().max(1_024).optional(),
  }),
  z.looseObject({ type: z.enum(["stdout", "stderr"]), data: z.string().max(16_000_000) }),
  z.looseObject({ type: z.literal("error"), message: z.string().min(1).max(1_000_000) }),
]);

export const aspExtensionEventSchema = z.looseObject({
  extension: identifierSchema,
  event: identifierSchema,
  runId: optionalIdentifierSchema,
  providerSessionId: optionalIdentifierSchema,
  payload: z.unknown().optional(),
  fallback: extensionFallbackSchema,
  metadata: metadataSchema.optional(),
});

const runEventBase = {
  runId: identifierSchema,
  providerSessionId: optionalIdentifierSchema,
};

const interactiveRunEventBase = {
  runId: optionalIdentifierSchema,
  providerSessionId: optionalIdentifierSchema,
};

export const aspCoreEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("run_started"), ...runEventBase }),
  z.looseObject({
    type: z.literal("message_delta"),
    ...runEventBase,
    data: z.string().max(16_000_000),
    itemId: optionalIdentifierSchema,
  }),
  z.looseObject({ type: z.literal("message_part"), ...runEventBase, part: aspMessagePartSchema }),
  z.looseObject({ type: z.literal("tool_event"), ...runEventBase, toolEvent: aspToolEventSchema }),
  z.looseObject({ type: z.literal("session_state"), ...runEventBase, state: sessionStateSchema }),
  z.looseObject({
    type: z.literal("approval_request"),
    ...interactiveRunEventBase,
    approvalId: optionalIdentifierSchema,
    title: z.string().min(1).max(8_192).optional(),
    method: identifierSchema,
    scope: z.string().max(1_024).optional(),
    params: z.unknown().optional(),
    options: z.array(approvalDecisionSchema).max(32).optional(),
  }),
  z.looseObject({
    type: z.literal("question_request"),
    ...interactiveRunEventBase,
    questionId: optionalIdentifierSchema,
    title: z.string().max(8_192).optional(),
    question: z.string().max(1_000_000).optional(),
    instructions: z.string().max(1_000_000).optional(),
    questions: z.array(z.unknown()).max(1_000).optional(),
    app: interactiveAppSchema.optional(),
    metadata: metadataSchema.optional(),
  }),
  z.looseObject({
    type: z.literal("extension_event"),
    runId: optionalIdentifierSchema,
    providerSessionId: optionalIdentifierSchema,
    extension: identifierSchema,
    event: identifierSchema,
    payload: z.unknown().optional(),
    fallback: extensionFallbackSchema,
    metadata: metadataSchema.optional(),
  }),
  z.looseObject({
    type: z.literal("usage"),
    ...runEventBase,
    usage: tokenUsageSchema,
    model: z.string().max(1_024).optional(),
  }),
  z.looseObject({
    type: z.enum(["stdout", "stderr"]),
    ...runEventBase,
    data: z.string().max(16_000_000),
  }),
  z.looseObject({
    type: z.literal("error"),
    ...runEventBase,
    message: z.string().min(1).max(1_000_000),
  }),
  z.looseObject({
    type: z.literal("run_finished"),
    ...runEventBase,
    durationMs: z.number().nonnegative(),
    exitCode: z.number().int().nullable(),
    success: z.boolean(),
    stopReason: stopReasonSchema.optional(),
    usage: tokenUsageSchema.optional(),
  }),
]);

const envelopeSchema = z.looseObject({
  asp: z.literal(ASP_NAME),
  jsonrpc: jsonRpcVersionSchema,
  version: z.literal(ASP_VERSION),
});

const runInputPartSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text"), text: z.string().max(16_000_000) }),
  z.looseObject({
    type: z.literal("file_ref"),
    path: z.string().min(1).max(32_768),
    mimeType: z.string().max(256).optional(),
  }),
  z.looseObject({ type: z.literal("directory_ref"), path: z.string().min(1).max(32_768) }),
  z.looseObject({
    type: z.literal("image_ref"),
    path: z.string().min(1).max(32_768),
    mimeType: z.string().max(256).optional(),
  }),
  z.looseObject({
    type: z.literal("image_base64"),
    data: z.string().max(32_000_000),
    mimeType: z.string().min(1).max(256),
  }),
  z.looseObject({
    type: z.literal("uri"),
    uri: z.string().min(1).max(16_384),
    mimeType: z.string().max(256).optional(),
  }),
  z.looseObject({ type: z.literal("raw"), protocol: identifierSchema, value: z.unknown() }),
]);

const runMessageSchema = envelopeSchema.extend({
  type: z.literal("run"),
  method: z.literal("run"),
  runId: identifierSchema,
  providerId: identifierSchema,
  threadId: identifierSchema,
  cwd: z.string().min(1).max(32_768),
  prompt: z.string().max(16_000_000),
  conversationContext: z.record(z.string(), z.unknown()).optional(),
  approvalMode: z.enum(["request", "auto", "full"]),
  additionalDeveloperInstructions: z.string().max(2_000_000).optional(),
  attachments: z.array(attachmentSchema).max(1_000),
  clientCapabilities: z.record(z.string(), z.unknown()),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  extensions: z.array(extensionUseSchema).max(256),
  enabledAppExtensions: z.array(identifierSchema).max(1_000).optional(),
  input: z.looseObject({
    attachments: z.array(z.unknown()).max(1_000),
    parts: z.array(runInputPartSchema).max(10_000),
    messages: z.array(z.unknown()).max(10_000),
  }),
  mcpServers: z.unknown().optional(),
  model: z.string().max(1_024).optional(),
  providerSessionId: optionalIdentifierSchema,
  skills: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
  speed: z.enum(["default", "fast"]).optional(),
  preserveNativeEvents: z.boolean().optional(),
});

const requestIdSchema = z.union([z.string(), z.number()]);
const requestFields = {
  ...envelopeSchema.shape,
  clientCapabilities: z.record(z.string(), z.unknown()),
  id: requestIdSchema,
  providerId: identifierSchema,
};
const requestSchema = <Method extends string>(
  method: Method,
  fields: Record<string, z.ZodType> = {},
) =>
  z.looseObject({
    ...requestFields,
    ...fields,
    type: z.literal(method),
    method: z.literal(method),
  });

export const aspClientMessageSchema = z.union([
  runMessageSchema,
  z.union([
    envelopeSchema.extend({
      type: z.literal("abort"),
      method: z.literal("run.cancel").optional(),
      params: z
        .looseObject({ runId: identifierSchema, reason: z.string().max(8_192).optional() })
        .optional(),
      reason: z.string().max(8_192).optional(),
      runId: identifierSchema,
    }),
    envelopeSchema.extend({
      type: z.literal("abort").optional(),
      method: z.literal("run.cancel"),
      params: z.looseObject({
        runId: identifierSchema,
        reason: z.string().max(8_192).optional(),
      }),
      reason: z.string().max(8_192).optional(),
      runId: optionalIdentifierSchema,
    }),
  ]),
  envelopeSchema.extend({
    type: z.literal("approval_result"),
    approvalId: optionalIdentifierSchema,
    decision: approvalDecisionSchema,
    message: z.string().max(1_000_000).optional(),
    method: identifierSchema,
  }),
  envelopeSchema.extend({
    type: z.literal("question_result"),
    method: identifierSchema.optional(),
    questionId: optionalIdentifierSchema,
    result: z.unknown(),
  }),
  envelopeSchema.extend({
    type: z.literal("extension_invoke"),
    method: z.literal("extension.invoke"),
    clientCapabilities: z.record(z.string(), z.unknown()),
    id: requestIdSchema,
    params: z.looseObject({
      extension: identifierSchema,
      method: identifierSchema,
      payload: z.unknown().optional(),
      providerSessionId: optionalIdentifierSchema,
      runId: optionalIdentifierSchema,
    }),
  }),
  requestSchema("capabilities"),
  requestSchema("initialize", {
    clientInfo: z
      .looseObject({
        name: identifierSchema,
        version: identifierSchema,
        title: z.string().max(8_192).optional(),
        url: z.string().max(16_384).optional(),
      })
      .optional(),
    supportedProtocolVersions: z.array(identifierSchema).min(1).max(64),
  }),
  requestSchema("list_models"),
  requestSchema("new_session", {
    cwd: z.string().min(1).max(32_768),
    projectPath: z.string().max(32_768).optional(),
    title: z.string().max(8_192).optional(),
  }),
  requestSchema("list_sessions", {
    cwd: z.string().max(32_768).optional(),
    projectPath: z.string().max(32_768).optional(),
  }),
  requestSchema("session_messages", { providerSessionId: identifierSchema }),
  requestSchema("resume_session", {
    cwd: z.string().max(32_768).optional(),
    projectPath: z.string().max(32_768).optional(),
    providerSessionId: identifierSchema,
  }),
  requestSchema("delete_session", {
    cwd: z.string().max(32_768).optional(),
    projectPath: z.string().max(32_768).optional(),
    providerSessionId: identifierSchema,
    transcriptPath: z.string().max(32_768).optional(),
  }),
  requestSchema("session_usage", { providerSessionId: identifierSchema }),
  requestSchema("close_session", { providerSessionId: identifierSchema }),
  envelopeSchema.extend({
    id: requestIdSchema,
    method: z.never().optional(),
    result: z.unknown(),
    type: z.never().optional(),
  }),
]);

const clientServiceContextSchema = z.looseObject({
  providerSessionId: optionalIdentifierSchema,
  runId: identifierSchema,
});

const clientServiceRequestSchema = <Method extends string>(method: Method, params: z.ZodType) =>
  envelopeSchema.extend({
    id: requestIdSchema,
    method: z.literal(method),
    params: z.intersection(clientServiceContextSchema, params),
  });

export const aspClientServiceRequestSchema = z.union([
  clientServiceRequestSchema(
    "client.fs.read_text_file",
    z.looseObject({
      path: z.string().min(1).max(32_768),
      line: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(100_000).optional(),
    }),
  ),
  clientServiceRequestSchema(
    "client.fs.write_text_file",
    z.looseObject({
      path: z.string().min(1).max(32_768),
      content: z.string().max(16_000_000),
    }),
  ),
  clientServiceRequestSchema(
    "client.terminal.create",
    z.looseObject({
      id: identifierSchema,
      command: z.string().min(1).max(8_192),
      args: z.array(z.string().max(8_192)).max(1_000).optional(),
      cwd: z.string().max(32_768).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  ),
  clientServiceRequestSchema(
    "client.terminal.output",
    z.looseObject({ id: identifierSchema, maxChars: z.number().int().positive().optional() }),
  ),
  clientServiceRequestSchema(
    "client.terminal.wait_for_exit",
    z.looseObject({ id: identifierSchema, timeoutMs: z.number().int().positive().optional() }),
  ),
  clientServiceRequestSchema("client.terminal.kill", z.looseObject({ id: identifierSchema })),
  clientServiceRequestSchema("client.terminal.release", z.looseObject({ id: identifierSchema })),
  clientServiceRequestSchema(
    "client.permission.request",
    z.looseObject({
      method: identifierSchema,
      title: z.string().max(8_192).optional(),
      scope: z.string().max(1_024).optional(),
      options: z.array(approvalDecisionSchema).max(32).optional(),
      input: z.unknown().optional(),
    }),
  ),
  clientServiceRequestSchema(
    "client.elicitation.create",
    z.looseObject({
      title: z.string().max(8_192).optional(),
      message: z.string().max(1_000_000),
      questions: z.array(z.unknown()).max(1_000).optional(),
      metadata: metadataSchema.optional(),
    }),
  ),
]);

export const aspRpcErrorSchema = z.strictObject({
  code: z.number().int(),
  message: z.string().min(1).max(1_000_000),
  data: z
    .looseObject({
      retryable: z.boolean().optional(),
      details: z.unknown().optional(),
      method: z.string().max(256).optional(),
      runId: optionalIdentifierSchema,
      providerSessionId: optionalIdentifierSchema,
    })
    .optional(),
});

export const aspRpcResponseSchema = z.union([
  envelopeSchema.extend({ id: requestIdSchema, result: z.unknown(), error: z.never().optional() }),
  envelopeSchema.extend({
    id: requestIdSchema,
    error: aspRpcErrorSchema,
    result: z.never().optional(),
  }),
]);

export const aspWireMessageSchema = z.union([
  aspClientMessageSchema,
  aspClientServiceRequestSchema,
  aspRpcResponseSchema,
  z.intersection(envelopeSchema, aspCoreEventSchema),
]);

export class AspSchemaError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(context: string, error: z.ZodError) {
    super(`${context}: ${z.prettifyError(error)}`);
    this.name = "AspSchemaError";
    this.issues = error.issues;
  }
}

export function assertAspClientMessage(value: unknown): asserts value is Record<string, unknown> {
  const result = aspClientMessageSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP client message", result.error);
}

export function assertAspCoreEvent(value: unknown): asserts value is Record<string, unknown> {
  const result = aspCoreEventSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP core event", result.error);
}

export function assertAspExtensionEvent(value: unknown): asserts value is Record<string, unknown> {
  const result = aspExtensionEventSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP extension event", result.error);
}

export function assertAspExtensionDescriptor(value: unknown): void {
  const result = aspExtensionDescriptorSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP extension descriptor", result.error);
}

export function assertAspEnvelope(value: unknown): asserts value is Record<string, unknown> {
  const result = envelopeSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP envelope", result.error);
}

export function assertAspClientServiceRequest(
  value: unknown,
): asserts value is Record<string, unknown> {
  const result = aspClientServiceRequestSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP client service request", result.error);
}

export function assertAspRpcResponse(value: unknown): asserts value is Record<string, unknown> {
  const result = aspRpcResponseSchema.safeParse(value);
  if (!result.success) throw new AspSchemaError("Invalid ASP RPC response", result.error);
}

export function assertJsonSchemaValue(
  schema: Record<string, unknown> | undefined,
  value: unknown,
  context: string,
): void {
  if (!schema) return;
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema);
  } catch (error) {
    throw new Error(`${context} publishes an invalid JSON Schema: ${String(error)}`);
  }
  const result = validator.safeParse(value);
  if (!result.success) throw new AspSchemaError(context, result.error);
}

export function aspV1JsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(aspWireMessageSchema, {
      target: "draft-2020-12",
      unrepresentable: "any",
    }),
    $id: "https://agui.dev/schemas/asp/v1/schema.json",
    title: "Agent Server Protocol v1",
    description: "Canonical wire messages for Agent Server Protocol version 1.",
  } as Record<string, unknown>;
}
