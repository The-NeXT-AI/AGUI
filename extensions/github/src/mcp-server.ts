#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const API_URL = normalizedApiUrl(process.env.AGUI_GITHUB_API_URL) || "https://api.github.com";
const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 100;

type FetchLike = typeof fetch;
type GitHubRequestOptions = {
  body?: unknown;
  method?: string;
};
type GitHubRuntimeOptions = {
  apiUrl?: string;
  fetch?: FetchLike;
  token?: string;
};
type JsonRpcMessage = {
  id?: number | string | null;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  [key: string]: unknown;
};
type JsonRpcHandler = (message: JsonRpcMessage) => Promise<unknown> | unknown;

const tools = [
  {
    name: "github_get_issue",
    title: "Get GitHub issue",
    description:
      "Read a GitHub issue, optionally including issue comments. Use repository as owner/name or provide owner and repo.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Issue number."),
        includeComments: booleanSchema("Include issue comments in the response."),
        commentsLimit: integerSchema("Maximum issue comments to return, 1-100."),
      },
      ["number"],
    ),
  },
  {
    name: "github_list_issue_comments",
    title: "List GitHub issue comments",
    description: "Read comments for a GitHub issue or pull request conversation.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Issue or pull request number."),
        limit: integerSchema("Maximum comments to return, 1-100."),
      },
      ["number"],
    ),
  },
  {
    name: "github_create_issue_comment",
    title: "Create GitHub issue or PR comment",
    description:
      "Post a comment to a GitHub issue or pull request conversation. This modifies GitHub.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Issue or pull request number."),
        body: stringSchema("Markdown comment body to post."),
      },
      ["number", "body"],
    ),
  },
  {
    name: "github_update_issue",
    title: "Update GitHub issue",
    description:
      "Update a GitHub issue title, body, state, labels, assignees, or milestone. This modifies GitHub.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Issue number."),
        title: stringSchema("New issue title."),
        body: stringSchema("New issue body markdown."),
        state: enumSchema(["open", "closed"], "Issue state."),
        labels: stringArraySchema("Complete label list to set on the issue."),
        assignees: stringArraySchema("Complete assignee list to set on the issue."),
        milestone: nullableIntegerSchema("Milestone number to set, or null to clear."),
      },
      ["number"],
    ),
  },
  {
    name: "github_add_issue_labels",
    title: "Add GitHub issue labels",
    description: "Add labels to a GitHub issue or pull request. This modifies GitHub.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Issue or pull request number."),
        labels: stringArraySchema("Labels to add."),
      },
      ["number", "labels"],
    ),
  },
  {
    name: "github_remove_issue_label",
    title: "Remove GitHub issue label",
    description: "Remove one label from a GitHub issue or pull request. This modifies GitHub.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Issue or pull request number."),
        label: stringSchema("Label to remove."),
      },
      ["number", "label"],
    ),
  },
  {
    name: "github_get_pull_request",
    title: "Get GitHub pull request",
    description:
      "Read a GitHub pull request, optionally including files and reviews. Use before reviewing or merging.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Pull request number."),
        includeFiles: booleanSchema("Include changed files in the response."),
        includeReviews: booleanSchema("Include submitted reviews in the response."),
        filesLimit: integerSchema("Maximum files to return, 1-100."),
        reviewsLimit: integerSchema("Maximum reviews to return, 1-100."),
      },
      ["number"],
    ),
  },
  {
    name: "github_list_pull_request_files",
    title: "List GitHub PR files",
    description: "List changed files for a GitHub pull request.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Pull request number."),
        limit: integerSchema("Maximum files to return, 1-100."),
      },
      ["number"],
    ),
  },
  {
    name: "github_update_pull_request",
    title: "Update GitHub pull request",
    description: "Update a pull request title, body, state, base, or maintainer edit setting.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Pull request number."),
        title: stringSchema("New pull request title."),
        body: stringSchema("New pull request body markdown."),
        state: enumSchema(["open", "closed"], "Pull request state."),
        base: stringSchema("New base branch."),
        maintainer_can_modify: booleanSchema("Whether maintainers can modify the pull request."),
      },
      ["number"],
    ),
  },
  {
    name: "github_create_pull_request_review",
    title: "Create GitHub PR review",
    description:
      "Submit a pull request review: COMMENT, APPROVE, or REQUEST_CHANGES. This modifies GitHub.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Pull request number."),
        event: enumSchema(["COMMENT", "APPROVE", "REQUEST_CHANGES"], "Review event."),
        body: stringSchema("Review body markdown."),
        commit_id: stringSchema("Optional commit SHA for the review."),
        comments: {
          type: "array",
          description: "Optional inline review comments.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: stringSchema("File path."),
              body: stringSchema("Comment body markdown."),
              position: integerSchema("Diff position for older review comment API shape."),
              line: integerSchema("Line number in the diff side."),
              side: enumSchema(["LEFT", "RIGHT"], "Diff side."),
              start_line: integerSchema("Start line for a multi-line comment."),
              start_side: enumSchema(["LEFT", "RIGHT"], "Start diff side."),
            },
            required: ["path", "body"],
          },
        },
      },
      ["number", "event"],
    ),
  },
  {
    name: "github_merge_pull_request",
    title: "Merge GitHub pull request",
    description:
      "Merge a GitHub pull request using merge, squash, or rebase. This modifies GitHub.",
    inputSchema: objectSchema(
      {
        repository: stringSchema("Repository full name, for example owner/name."),
        owner: stringSchema("Repository owner. Optional when repository is provided."),
        repo: stringSchema("Repository name. Optional when repository is provided."),
        number: integerSchema("Pull request number."),
        commit_title: stringSchema("Optional merge commit title."),
        commit_message: stringSchema("Optional merge commit message."),
        merge_method: enumSchema(["merge", "squash", "rebase"], "Merge method."),
        sha: stringSchema("Expected head SHA. GitHub rejects the merge if it changed."),
      },
      ["number"],
    ),
  },
];

export { callTool, tools };

async function callTool(name, args = {}, options = {}) {
  switch (name) {
    case "github_get_issue":
      return getIssue(args, options);
    case "github_list_issue_comments":
      return listIssueComments(args, options);
    case "github_create_issue_comment":
      return createIssueComment(args, options);
    case "github_update_issue":
      return updateIssue(args, options);
    case "github_add_issue_labels":
      return addIssueLabels(args, options);
    case "github_remove_issue_label":
      return removeIssueLabel(args, options);
    case "github_get_pull_request":
      return getPullRequest(args, options);
    case "github_list_pull_request_files":
      return listPullRequestFiles(args, options);
    case "github_update_pull_request":
      return updatePullRequest(args, options);
    case "github_create_pull_request_review":
      return createPullRequestReview(args, options);
    case "github_merge_pull_request":
      return mergePullRequest(args, options);
    default:
      throw new Error(`Unknown GitHub MCP tool: ${name}`);
  }
}

async function getIssue(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const issue = await githubRequest(`/repos/${repo.path}/issues/${number}`, {}, options);
  const result: Record<string, unknown> = { issue: summarizeIssue(issue) };
  if (args.includeComments === true) {
    result.comments = await listIssueCommentsPayload(
      repo,
      number,
      boundedLimit(args.commentsLimit),
    );
  }
  return result;
}

async function listIssueComments(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  return {
    comments: await listIssueCommentsPayload(repo, number, boundedLimit(args.limit), options),
  };
}

async function createIssueComment(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const body = requiredString(args.body, "body");
  const comment = await githubRequest(
    `/repos/${repo.path}/issues/${number}/comments`,
    {
      method: "POST",
      body: { body },
    },
    options,
  );
  return { comment: summarizeComment(comment) };
}

async function updateIssue(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const body = pickDefined({
    title: optionalString(args.title),
    body: optionalString(args.body),
    state: optionalEnum(args.state, ["open", "closed"], "state"),
    labels: optionalStringArray(args.labels, "labels"),
    assignees: optionalStringArray(args.assignees, "assignees"),
    milestone:
      args.milestone === null
        ? null
        : args.milestone === undefined
          ? undefined
          : positiveInteger(args.milestone, "milestone"),
  });
  requireNonEmptyPatch(body, "github_update_issue");
  const issue = await githubRequest(
    `/repos/${repo.path}/issues/${number}`,
    { method: "PATCH", body },
    options,
  );
  return { issue: summarizeIssue(issue) };
}

async function addIssueLabels(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const labels = requiredStringArray(args.labels, "labels");
  const result = await githubRequest(
    `/repos/${repo.path}/issues/${number}/labels`,
    { method: "POST", body: { labels } },
    options,
  );
  return { labels: arrayValue(result).map(summarizeLabel) };
}

async function removeIssueLabel(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const label = requiredString(args.label, "label");
  const result = await githubRequest(
    `/repos/${repo.path}/issues/${number}/labels/${encodeURIComponent(label)}`,
    { method: "DELETE" },
    options,
  );
  return { labels: arrayValue(result).map(summarizeLabel) };
}

async function getPullRequest(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const pullRequest = await githubRequest(`/repos/${repo.path}/pulls/${number}`, {}, options);
  const result: Record<string, unknown> = { pullRequest: summarizePullRequest(pullRequest) };
  if (args.includeFiles === true) {
    result.files = await listPullRequestFilesPayload(
      repo,
      number,
      boundedLimit(args.filesLimit),
      options,
    );
  }
  if (args.includeReviews === true) {
    result.reviews = await listPullRequestReviewsPayload(
      repo,
      number,
      boundedLimit(args.reviewsLimit),
      options,
    );
  }
  return result;
}

async function listPullRequestFiles(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  return {
    files: await listPullRequestFilesPayload(repo, number, boundedLimit(args.limit), options),
  };
}

async function updatePullRequest(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const body = pickDefined({
    title: optionalString(args.title),
    body: optionalString(args.body),
    state: optionalEnum(args.state, ["open", "closed"], "state"),
    base: optionalString(args.base),
    maintainer_can_modify: optionalBoolean(args.maintainer_can_modify, "maintainer_can_modify"),
  });
  requireNonEmptyPatch(body, "github_update_pull_request");
  const pullRequest = await githubRequest(
    `/repos/${repo.path}/pulls/${number}`,
    { method: "PATCH", body },
    options,
  );
  return { pullRequest: summarizePullRequest(pullRequest) };
}

async function createPullRequestReview(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const body = pickDefined({
    event: requiredEnum(args.event, ["COMMENT", "APPROVE", "REQUEST_CHANGES"], "event"),
    body: optionalString(args.body),
    commit_id: optionalString(args.commit_id),
    comments: optionalReviewComments(args.comments),
  });
  if (
    (body.event === "REQUEST_CHANGES" || body.event === "COMMENT") &&
    !body.body &&
    !body.comments
  ) {
    throw new Error(`${body.event} reviews require body or comments.`);
  }
  const review = await githubRequest(
    `/repos/${repo.path}/pulls/${number}/reviews`,
    { method: "POST", body },
    options,
  );
  return { review: summarizeReview(review) };
}

async function mergePullRequest(args, options) {
  const repo = repositoryArgs(args);
  const number = positiveInteger(args.number, "number");
  const body = pickDefined({
    commit_title: optionalString(args.commit_title),
    commit_message: optionalString(args.commit_message),
    merge_method: optionalEnum(args.merge_method, ["merge", "squash", "rebase"], "merge_method"),
    sha: optionalString(args.sha),
  });
  const result = await githubRequest(
    `/repos/${repo.path}/pulls/${number}/merge`,
    { method: "PUT", body },
    options,
  );
  return { merge: result };
}

async function listIssueCommentsPayload(repo, number, limit = DEFAULT_PAGE_LIMIT, options = {}) {
  const result = await githubRequest(
    `/repos/${repo.path}/issues/${number}/comments?per_page=${limit}`,
    {},
    options,
  );
  return arrayValue(result).map(summarizeComment);
}

async function listPullRequestFilesPayload(repo, number, limit = DEFAULT_PAGE_LIMIT, options = {}) {
  const result = await githubRequest(
    `/repos/${repo.path}/pulls/${number}/files?per_page=${limit}`,
    {},
    options,
  );
  return arrayValue(result).map(summarizePullRequestFile);
}

async function listPullRequestReviewsPayload(
  repo,
  number,
  limit = DEFAULT_PAGE_LIMIT,
  options = {},
) {
  const result = await githubRequest(
    `/repos/${repo.path}/pulls/${number}/reviews?per_page=${limit}`,
    {},
    options,
  );
  return arrayValue(result).map(summarizeReview);
}

async function githubRequest(
  pathname,
  options: GitHubRequestOptions = {},
  runtime: GitHubRuntimeOptions = {},
) {
  const token = runtime.token ?? process.env.AGUI_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GitHub MCP server is not configured with AGUI_GITHUB_TOKEN.");
  const url = `${runtime.apiUrl || API_URL}${pathname}`;
  const response = await (runtime.fetch ?? fetch)(url, {
    method: options.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "AGUI GitHub MCP",
      "x-github-api-version": "2022-11-28",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const message =
      recordValue(payload).message ||
      text.slice(0, 500) ||
      `GitHub API request failed with ${response.status}`;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
  return payload;
}

function startMcpServer() {
  const transport = new StdioTransport(async (message) => {
    if (message.method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agui-github-mcp", version: "0.1.0" },
      };
    }
    if (message.method === "tools/list") return { tools };
    if (message.method === "tools/call") {
      const params = recordValue(message.params);
      const name = requiredString(params.name, "name");
      const result = await callTool(name, recordValue(params.arguments));
      return toolResult(result);
    }
    if (message.method === "ping") return {};
    throw new Error(`Unsupported MCP method: ${message.method}`);
  });
  transport.start();
}

class StdioTransport {
  private buffer: Buffer;
  private readonly handler: JsonRpcHandler;

  constructor(handler: JsonRpcHandler) {
    this.handler = handler;
    this.buffer = Buffer.alloc(0);
  }

  start(): void {
    process.stdin.on("data", (chunk) => this.handleData(chunk));
    process.stdin.resume();
  }

  handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const message = this.readFrame();
      if (!message) break;
      void this.handleMessage(message);
    }
  }

  readFrame(): JsonRpcMessage | undefined {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match?.[1]) {
        this.buffer = Buffer.alloc(0);
        return undefined;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (this.buffer.length < bodyEnd) return undefined;
      const raw = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      return JSON.parse(raw) as JsonRpcMessage;
    }
    const newline = this.buffer.indexOf("\n");
    if (newline < 0) return undefined;
    const raw = this.buffer.subarray(0, newline).toString("utf8").trim();
    this.buffer = this.buffer.subarray(newline + 1);
    return raw ? (JSON.parse(raw) as JsonRpcMessage) : undefined;
  }

  async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (!message || message.jsonrpc !== "2.0" || !message.method) return;
    if (message.id === undefined) return;
    try {
      const result = await this.handler(message);
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  write(payload: unknown): void {
    const json = JSON.stringify(payload);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }
}

function toolResult(value) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
}

function repositoryArgs(args) {
  const repository = optionalString(args.repository);
  if (repository) {
    const [owner, repo, ...extra] = repository.split("/");
    if (!owner || !repo || extra.length) {
      throw new Error("repository must use the owner/name format.");
    }
    return {
      owner,
      repo,
      path: `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      fullName: `${owner}/${repo}`,
    };
  }
  const owner = requiredString(args.owner, "owner");
  const repo = requiredString(args.repo, "repo");
  return {
    owner,
    repo,
    path: `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    fullName: `${owner}/${repo}`,
  };
}

function summarizeIssue(issue) {
  const record = recordValue(issue);
  return {
    id: record.id,
    number: record.number,
    title: record.title,
    state: record.state,
    locked: record.locked,
    user: summarizeUser(record.user),
    labels: arrayValue(record.labels).map(summarizeLabel),
    assignees: arrayValue(record.assignees).map(summarizeUser),
    milestone: summarizeMilestone(record.milestone),
    comments: record.comments,
    html_url: record.html_url,
    created_at: record.created_at,
    updated_at: record.updated_at,
    closed_at: record.closed_at,
    body: record.body,
    pull_request: record.pull_request,
  };
}

function summarizePullRequest(pr) {
  const record = recordValue(pr);
  return {
    id: record.id,
    number: record.number,
    title: record.title,
    state: record.state,
    draft: record.draft,
    merged: record.merged,
    mergeable: record.mergeable,
    mergeable_state: record.mergeable_state,
    user: summarizeUser(record.user),
    base: summarizeBranch(record.base),
    head: summarizeBranch(record.head),
    comments: record.comments,
    review_comments: record.review_comments,
    commits: record.commits,
    additions: record.additions,
    deletions: record.deletions,
    changed_files: record.changed_files,
    html_url: record.html_url,
    diff_url: record.diff_url,
    patch_url: record.patch_url,
    created_at: record.created_at,
    updated_at: record.updated_at,
    closed_at: record.closed_at,
    merged_at: record.merged_at,
    body: record.body,
  };
}

function summarizeComment(comment) {
  const record = recordValue(comment);
  return {
    id: record.id,
    user: summarizeUser(record.user),
    body: record.body,
    html_url: record.html_url,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function summarizePullRequestFile(file) {
  const record = recordValue(file);
  return {
    filename: record.filename,
    status: record.status,
    additions: record.additions,
    deletions: record.deletions,
    changes: record.changes,
    blob_url: record.blob_url,
    raw_url: record.raw_url,
    patch: record.patch,
  };
}

function summarizeReview(review) {
  const record = recordValue(review);
  return {
    id: record.id,
    user: summarizeUser(record.user),
    state: record.state,
    body: record.body,
    commit_id: record.commit_id,
    html_url: record.html_url,
    submitted_at: record.submitted_at,
  };
}

function summarizeUser(user) {
  const record = recordValue(user);
  return record.login
    ? { login: record.login, id: record.id, html_url: record.html_url, type: record.type }
    : null;
}

function summarizeLabel(label) {
  const record = recordValue(label);
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    description: record.description,
  };
}

function summarizeMilestone(milestone) {
  const record = recordValue(milestone);
  return record.number
    ? {
        number: record.number,
        title: record.title,
        state: record.state,
        html_url: record.html_url,
      }
    : null;
}

function summarizeBranch(branch) {
  const record = recordValue(branch);
  const repo = recordValue(record.repo);
  return {
    ref: record.ref,
    sha: record.sha,
    repo: repo.full_name,
  };
}

function optionalReviewComments(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("comments must be an array.");
  return value.map((item, index) => {
    const record = recordValue(item);
    return pickDefined({
      path: requiredString(record.path, `comments[${index}].path`),
      body: requiredString(record.body, `comments[${index}].body`),
      position:
        record.position === undefined
          ? undefined
          : positiveInteger(record.position, `comments[${index}].position`),
      line:
        record.line === undefined
          ? undefined
          : positiveInteger(record.line, `comments[${index}].line`),
      side: optionalEnum(record.side, ["LEFT", "RIGHT"], `comments[${index}].side`),
      start_line:
        record.start_line === undefined
          ? undefined
          : positiveInteger(record.start_line, `comments[${index}].start_line`),
      start_side: optionalEnum(
        record.start_side,
        ["LEFT", "RIGHT"],
        `comments[${index}].start_side`,
      ),
    });
  });
}

function boundedLimit(value) {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  const parsed = positiveInteger(value, "limit");
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, parsed));
}

function positiveInteger(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function requiredString(value, name) {
  const text = optionalString(value);
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredStringArray(value, name) {
  const list = optionalStringArray(value, name);
  if (!list?.length) throw new Error(`${name} requires at least one value.`);
  return list;
}

function optionalStringArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
  return value.map((item) => requiredString(item, `${name}[]`));
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function requiredEnum(value, values, name) {
  const text = requiredString(value, name);
  if (!values.includes(text)) throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  return text;
}

function optionalEnum(value, values, name) {
  if (value === undefined) return undefined;
  return requiredEnum(value, values, name);
}

function requireNonEmptyPatch(value, toolName) {
  if (!Object.keys(value).length)
    throw new Error(`${toolName} requires at least one update field.`);
}

function pickDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function recordValue(value): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizedApiUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "";
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringSchema(description) {
  return { type: "string", description };
}

function integerSchema(description) {
  return { type: "integer", minimum: 1, description };
}

function nullableIntegerSchema(description) {
  return { type: ["integer", "null"], minimum: 1, description };
}

function booleanSchema(description) {
  return { type: "boolean", description };
}

function enumSchema(values, description) {
  return { type: "string", enum: values, description };
}

function stringArraySchema(description) {
  return {
    type: "array",
    items: { type: "string" },
    description,
  };
}

if (isMainModule()) {
  startMcpServer();
}
