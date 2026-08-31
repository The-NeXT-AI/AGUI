import OpenAI from "openai";
import { resolveCatalogItemName } from "./catalog.js";
import { TreeSitterToolAnalyzer } from "./tree-sitter-tool-analyzer.js";

const treeSitterToolName = "tree_sitter_collect_tool_references";
const defaultMaxTurns = 3;
const maxTurnsLimit = 6;
const defaultTimeoutMs = 60_000;
const minTimeoutMs = 8_000;
const maxTurnTimeoutMs = 60_000;
const minTurnRemainingMs = 3_500;
const minFinalAnswerTurnTimeoutMs = 8_000;
const timeoutHeadroomMs = 1_500;

type ChatMessage = {
  content?: string | null;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: Array<{
    function: {
      arguments: string;
      name: string;
    };
    id: string;
    type: "function";
  }>;
};

type ChatCompletionRequest = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "stream"
>;

type StreamingToolCall = {
  function: {
    arguments: string;
    name: string;
  };
  id?: string;
  type?: "function";
};

export type CodeToolSearchCatalogItem = {
  alias: string;
  canonicalName?: string;
  description: string;
  invocationMode: string;
  name: string;
  remoteToolName?: string;
  required?: string[];
  serverId?: string;
  serverLabel?: string;
  sideEffect: boolean;
  title: string;
};

export type CodeToolSearchInput = {
  catalog: CodeToolSearchCatalogItem[];
  code?: string;
  maxTurns?: number;
  query: string;
  stream?: boolean;
  timeoutMs?: number;
  topK?: number;
};

export type CodeToolSearchResult = {
  plannedSteps?: string[];
  referencedTokens: string[];
  selectedToolNames: string[];
  summary: string;
  usedLlm: boolean;
  workflowSketch?: string;
};

export type CodeToolSearchAgentConfig = {
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiModel?: string;
};

export class OpenAiCodeToolSearchAgent {
  constructor(
    private readonly config: CodeToolSearchAgentConfig = {},
    private readonly analyzer: TreeSitterToolAnalyzer = new TreeSitterToolAnalyzer(),
  ) {}

  async search(input: CodeToolSearchInput): Promise<CodeToolSearchResult> {
    const query = input.query.trim();
    if (!query) throw new Error("Internal tool search query must be non-empty.");

    const apiKey = this.config.openAiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI API key is not configured for resolve retrieval.");

    const catalog = input.catalog;
    const topK = normalizeTopK(input.topK);
    const maxTurns = normalizeMaxTurns(input.maxTurns);
    const timeoutMs = normalizeSearchTimeout(input.timeoutMs);
    const stream = input.stream ?? true;
    const deadlineAt = Date.now() + timeoutMs;
    const model = this.config.openAiModel || process.env.CODE_TOOL_SEARCH_MODEL || "gpt-4.1-mini";
    const client = new OpenAI({
      apiKey,
      baseURL: this.config.openAiBaseUrl || process.env.OPENAI_BASE_URL,
    });

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: JSON.stringify({ query, context: input.code ?? "" }, null, 2),
      },
    ];

    let didCallTreeSitter = false;
    let treeSitterCallCount = 0;
    let summary = "";
    let workflowSketch = "";
    let plannedSteps: string[] = [];
    let llmSelectedNames: string[] = [];
    let referencedTokens: string[] = [];
    let latestResolvedFromTreeSitter: string[] = [];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const remainingMs = deadlineAt - Date.now();
      const minTurnTimeoutMs = didCallTreeSitter ? minFinalAnswerTurnTimeoutMs : minTurnRemainingMs;
      if (remainingMs <= minTurnTimeoutMs + timeoutHeadroomMs) break;

      const turnTimeoutMs = Math.min(remainingMs - timeoutHeadroomMs, maxTurnTimeoutMs);
      const responseMessage = await callOpenAiWithTools(
        client,
        model,
        buildSystemPrompt(catalog, topK),
        messages,
        turnTimeoutMs,
        stream,
      );

      const toolCalls = responseMessage.tool_calls ?? [];
      if (toolCalls.length > 0) {
        messages.push(responseMessage);
        const roundResolvedToolNames: string[] = [];
        for (const toolCall of toolCalls) {
          if (toolCall.function.name !== treeSitterToolName) {
            messages.push({
              content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
              role: "tool",
              tool_call_id: toolCall.id,
            });
            continue;
          }

          didCallTreeSitter = true;
          treeSitterCallCount += 1;
          const toolInput = parseToolArguments(toolCall.function.arguments);
          const analyzeCode = typeof toolInput.code === "string" ? toolInput.code : "";
          const references = this.analyzer.collectReferences(analyzeCode);
          const tokens = unique(references.map((item) => item.rawName));
          const resolvedToolNames = unique(
            tokens
              .map((token) => resolveCatalogItemName(catalog, token))
              .filter((name): name is string => typeof name === "string"),
          );
          referencedTokens = unique([...referencedTokens, ...tokens]);
          roundResolvedToolNames.push(...resolvedToolNames);

          messages.push({
            content: JSON.stringify({
              references: references.map((item) => ({
                column: item.column,
                line: item.line,
                rawName: item.rawName,
                source: item.source,
              })),
              resolvedToolNames,
              tokens,
            }),
            role: "tool",
            tool_call_id: toolCall.id,
          });
        }
        latestResolvedFromTreeSitter = unique(roundResolvedToolNames);
        continue;
      }

      if (!didCallTreeSitter) {
        messages.push({
          content: `You must call ${treeSitterToolName} on a TypeScript workflow sketch before your final answer.`,
          role: "user",
        });
        continue;
      }

      const contentText =
        typeof responseMessage.content === "string" ? responseMessage.content.trim() : "";
      const parsed = firstJsonObject(contentText);
      if (!parsed) {
        messages.push(responseMessage);
        messages.push({
          content:
            'Return only a valid JSON object with keys "summary", "steps", "workflowSketch", and "toolNames".',
          role: "user",
        });
        continue;
      }

      summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      workflowSketch = typeof parsed.workflowSketch === "string" ? parsed.workflowSketch : "";
      plannedSteps = toStringArray(parsed.steps);
      const workflowTokens = unique(
        this.analyzer.collectReferences(workflowSketch).map((item) => item.rawName),
      );
      const workflowResolvedNames = unique(
        workflowTokens
          .map((token) => resolveCatalogItemName(catalog, token))
          .filter((name): name is string => typeof name === "string"),
      );
      referencedTokens = unique([...referencedTokens, ...workflowTokens]);
      llmSelectedNames = unique(
        [...workflowResolvedNames, ...toStringArray(parsed.toolNames)]
          .map((name) => resolveCatalogItemName(catalog, name))
          .filter((name): name is string => typeof name === "string"),
      );
      const selectedToolNames = unique([
        ...latestResolvedFromTreeSitter,
        ...llmSelectedNames,
      ]).slice(0, topK);
      const refinementFeedback = buildRefinementFeedback({
        selectedToolNames,
        summary,
        workflowSketch,
      });
      if (refinementFeedback && turn + 1 < maxTurns) {
        messages.push(responseMessage);
        messages.push({ content: refinementFeedback, role: "user" });
        continue;
      }
      break;
    }

    if (!didCallTreeSitter || treeSitterCallCount === 0) {
      throw new Error("Resolve retrieval LLM did not complete a tree-sitter planning round.");
    }

    const selectedToolNames = unique([...latestResolvedFromTreeSitter, ...llmSelectedNames]).slice(
      0,
      topK,
    );
    if (selectedToolNames.length === 0) {
      throw new Error(
        "Resolve retrieval did not converge on any valid catalog tools after tree-sitter refinement.",
      );
    }
    if (!summary) {
      summary = "Resolved a planned end-to-end tool bundle with tree-sitter-assisted retrieval.";
    } else if (summary.toLowerCase().includes("no strong tool bundle match was found")) {
      summary = "Resolved a candidate tool bundle after iterative tree-sitter refinement.";
    }

    return {
      plannedSteps: plannedSteps.length > 0 ? plannedSteps : undefined,
      referencedTokens,
      selectedToolNames,
      summary,
      usedLlm: true,
      workflowSketch: workflowSketch || undefined,
    };
  }
}

function buildSystemPrompt(catalog: CodeToolSearchCatalogItem[], topK: number): string {
  return [
    "You are the MCP Gateway resolve planner and retrieval agent.",
    "Your job is to return the complete anticipated MCP tool bundle for the user task, not just the first tool.",
    "You must think ahead about the next likely steps needed to finish the task end-to-end.",
    `You MUST call ${treeSitterToolName} before your final answer.`,
    "Workflow you must follow:",
    "1. Plan the likely execution steps.",
    "2. Draft a short TypeScript workflow sketch that uses exact catalog tool names or aliases.",
    '2a. Prefer string literal calls such as callTool("<exact catalog tool name>", {...}) or tools.call("<exact catalog tool name>", {...}).',
    "3. Call the tree-sitter tool on that sketch.",
    "4. Inspect the tree-sitter result and check whether the bundle is complete end-to-end.",
    "5. If it is incomplete, revise the sketch and call the tree-sitter tool again.",
    "6. Return final JSON only after the bundle is complete.",
    `Return at most ${topK} tool names.`,
    "Final answer MUST be a JSON object with this shape:",
    '{ "summary": string, "steps": string[], "workflowSketch": string, "toolNames": string[] }',
    "Rules:",
    "- toolNames must be exact catalog names or aliases.",
    "- In workflowSketch, prefer string-literal tool calls over reconstructed member chains whenever possible.",
    "- Include prerequisite and downstream tools you will likely need after the first action.",
    "- Never invent tool names.",
    "- For lookup tasks, do not stop at opening or navigating. Include tools needed to read or extract the answer.",
    "- If the catalog has no strong match, return an empty toolNames array.",
    "",
    "Tool catalog:",
    JSON.stringify(catalog, null, 2),
  ].join("\n");
}

function buildRefinementFeedback(input: {
  selectedToolNames: string[];
  summary: string;
  workflowSketch: string;
}): string | undefined {
  const issues: string[] = [];
  if (!input.workflowSketch.trim()) issues.push("workflowSketch is empty.");
  if (input.selectedToolNames.length === 0)
    issues.push("Your current answer resolved to zero valid catalog tools.");
  if (input.summary.trim().toLowerCase().includes("no strong tool bundle match was found")) {
    issues.push(
      "Your summary says the bundle is weak; revise the workflow sketch and search again.",
    );
  }
  if (issues.length === 0) return undefined;
  return [
    "Your last candidate tool bundle is incomplete.",
    ...issues.map((issue, index) => `${index + 1}. ${issue}`),
    `Revise the workflow sketch, call ${treeSitterToolName} again, and then return updated JSON only.`,
  ].join("\n");
}

function buildChatCompletionRequest(
  model: string,
  system: string,
  messages: ChatMessage[],
): ChatCompletionRequest {
  return {
    messages: [
      { content: system, role: "system" },
      ...messages,
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    model,
    temperature: 0,
    tool_choice: "auto",
    tools: [
      {
        function: {
          description:
            "Analyze a short TypeScript workflow sketch and extract exact tool references used in the sketch.",
          name: treeSitterToolName,
          parameters: {
            additionalProperties: false,
            properties: {
              code: {
                description: "TypeScript workflow sketch that references MCP Gateway tools.",
                type: "string",
              },
            },
            required: ["code"],
            type: "object",
          },
        },
        type: "function",
      },
    ],
  };
}

async function callOpenAiWithTools(
  client: OpenAI,
  model: string,
  system: string,
  messages: ChatMessage[],
  timeoutMs: number,
  stream: boolean,
): Promise<ChatMessage> {
  const request = buildChatCompletionRequest(model, system, messages);
  if (!stream) return callOpenAiWithToolsNonStreaming(client, request, timeoutMs);
  try {
    return await callOpenAiWithToolsStreaming(client, request, timeoutMs);
  } catch (streamingError) {
    try {
      return await callOpenAiWithToolsNonStreaming(client, request, timeoutMs);
    } catch (fallbackError) {
      throw new Error(
        `OpenAI streaming resolve retrieval failed (${formatErrorMessage(streamingError)}); non-streaming fallback also failed (${formatErrorMessage(fallbackError)}).`,
      );
    }
  }
}

async function callOpenAiWithToolsNonStreaming(
  client: OpenAI,
  request: ChatCompletionRequest,
  timeoutMs: number,
): Promise<ChatMessage> {
  const response = await withAbortTimeout(
    (signal) =>
      client.chat.completions.create({ ...request, stream: false }, { signal, timeout: timeoutMs }),
    timeoutMs,
    `Resolve retrieval non-streaming turn timed out after ${timeoutMs}ms.`,
  );
  return normalizeAssistantMessage(response.choices[0]?.message);
}

async function callOpenAiWithToolsStreaming(
  client: OpenAI,
  request: ChatCompletionRequest,
  timeoutMs: number,
): Promise<ChatMessage> {
  return withAbortTimeout(
    async (signal) => {
      const stream = await client.chat.completions.create(
        { ...request, stream: true },
        { signal, timeout: timeoutMs },
      );
      const toolCalls = new Map<number, StreamingToolCall>();
      let content = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string") content += delta.content;
        for (const toolCallDelta of delta.tool_calls ?? []) {
          if (typeof toolCallDelta.index !== "number") {
            throw new Error(
              "OpenAI streaming resolve retrieval returned a tool call delta without an index.",
            );
          }
          const current = toolCalls.get(toolCallDelta.index) ?? {
            function: { arguments: "", name: "" },
            type: "function" as const,
          };
          if (toolCallDelta.id) current.id = toolCallDelta.id;
          if (toolCallDelta.type) current.type = toolCallDelta.type;
          if (toolCallDelta.function?.name) current.function.name += toolCallDelta.function.name;
          if (toolCallDelta.function?.arguments)
            current.function.arguments += toolCallDelta.function.arguments;
          toolCalls.set(toolCallDelta.index, current);
        }
      }
      const normalizedToolCalls = [...toolCalls.entries()]
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .filter(
          ([, toolCall]) =>
            toolCall.type === "function" && Boolean(toolCall.id) && Boolean(toolCall.function.name),
        )
        .map(([, toolCall]) => ({
          function: {
            arguments: toolCall.function.arguments,
            name: toolCall.function.name,
          },
          id: toolCall.id as string,
          type: "function" as const,
        }));
      if (toolCalls.size > 0 && normalizedToolCalls.length !== toolCalls.size) {
        throw new Error("OpenAI streaming resolve retrieval returned incomplete tool calls.");
      }
      return {
        content,
        role: "assistant",
        tool_calls: normalizedToolCalls.length ? normalizedToolCalls : undefined,
      };
    },
    timeoutMs,
    `Resolve retrieval streaming turn timed out after ${timeoutMs}ms.`,
  );
}

function normalizeAssistantMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
): ChatMessage {
  if (!message) throw new Error("OpenAI resolve retrieval returned no assistant message.");
  return {
    content: message.content ?? "",
    role: "assistant",
    tool_calls: message.tool_calls
      ?.filter(
        (toolCall): toolCall is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
          toolCall.type === "function",
      )
      .map((toolCall) => ({
        function: {
          arguments: toolCall.function.arguments,
          name: toolCall.function.name,
        },
        id: toolCall.id,
        type: "function",
      })),
  };
}

async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operationPromise = operation(controller.signal);
    void operationPromise.catch(() => undefined);
    return await Promise.race([
      operationPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Fall through to substring extraction.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toPositiveIntOrDefault(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeTopK(value: unknown): number {
  return Math.min(Math.max(toPositiveIntOrDefault(value, 5), 1), 20);
}

function normalizeMaxTurns(value: unknown): number {
  return Math.min(Math.max(toPositiveIntOrDefault(value, defaultMaxTurns), 1), maxTurnsLimit);
}

function normalizeSearchTimeout(value: unknown): number {
  return Math.max(toPositiveIntOrDefault(value, defaultTimeoutMs), minTimeoutMs);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
