# ASP 通用能力与扩展协议设计

本文定义 ASP 后续支持多类 coding agent 的通用方案。目标是保持 ASP core 简单稳定，同时通过可协商扩展承载 Claude Code、OpenCode、Pi、Codex 等 agent 的差异化能力。

核心信封、初始化、会话、取消、错误和双向服务以 [`core-protocol.md`](core-protocol.md) 为规范依据。

## 设计原则

1. ASP core 只保留所有 agent 都必须稳定支持的最小集合：provider、model、session、run、stream、tool event、diff、approval、question、usage。
2. 不把任一第三方协议作为新的接入层。所有 adapter 继续接入 ASP，第三方协议只在 adapter 内部转换。
3. agent 独有能力先进入 ASP extension，经过多个 adapter 验证后再考虑提升到 core。
4. extension 必须可发现、可协商、可忽略。旧 renderer 忽略未知 extension 时，基础对话仍然可用。
5. extension event 必须带显式 `fallback`。用户可见信息不能只存在 vendor payload 里；纯诊断或无损原生事件可以使用 `none`。
6. host 仍是安全边界。extension 不能绕过 ASP approval 和 workspace policy。

## Schema 边界

ASP core v1 的 client message、core event、message part、tool event、usage 和 session state 使用运行时判别联合 schema 校验。带 `asp` 与 `version` 的规范消息如果缺少必填字段、使用未知 core 枚举或字段类型错误，host 必须拒绝；未声明 ASP envelope 的第三方原生消息只能进入 adapter 兼容层，不能直接视为 core 消息。

扩展保持开放但边界明确：`extension`、`event`、`runId`、`providerSessionId` 和 `fallback` 由 core schema 校验。扩展通过 descriptor 的 `inputSchema`、`outputSchema`、`payloadSchema` 或 `schemas` 发布自己的 JSON Schema，host 会在调用、响应和事件三个方向执行校验，因此新增扩展不需要修改 core 判别联合。未知扩展仍然可协商、可忽略，并必须遵守 core fallback 与 host 权限规则。

## 分层

```text
ASP core v1
  initialize · list_models · run · run.cancel · sessions · client services
  message_delta · message_part · tool_event · approval_request · question_request

ASP standard extensions
  asp.ext.agents
  asp.ext.run-control
  asp.ext.permissions
  asp.ext.tools
  asp.ext.ui
  asp.ext.hooks
  asp.ext.session-state
  asp.ext.multimodal
  asp.ext.runtime

ASP vendor extensions
  vendor.codex.*
  vendor.claude.*
  vendor.opencode.*
  vendor.pi.*
```

core 面向通用 UI；standard extensions 面向多个 agent 共同出现的高级能力；vendor extensions 用于无法通用化但必须保真的协议能力。

## 能力协商

`AspProviderCapabilities` 增加 `extensions` 字段：

```ts
export type AspExtensionDescriptor = {
  id: string; // asp.ext.run-control, vendor.pi.rpc
  version: string; // semver
  stability: "stable" | "experimental" | "vendor";
  requiresCore?: string[]; // ["1"]
  methods?: AspExtensionMethodDescriptor[];
  events?: AspExtensionEventDescriptor[];
  schemas?: Record<string, unknown>;
  fallback: "core" | "raw" | "none";
};
```

Client 通过 `initialize` 响应中的 `capabilities` 得到扩展列表。后续 `run` 可以声明本次启用哪些扩展：

```ts
export type AspExtensionUse = {
  id: string;
  version?: string;
  options?: Record<string, unknown>;
};

export type RunInput = {
  // existing fields
  extensions?: AspExtensionUse[];
};
```

如果 renderer 不声明，adapter 可以启用安全的默认扩展，但不能启用需要额外权限的能力，例如 vendor raw passthrough、后台任务、外部目录访问。

## 通用扩展 envelope

为了避免每增加一个能力都修改 transport，扩展命令统一走 `extension.invoke`：

```json
{
  "asp": "agent-server-protocol",
  "jsonrpc": "2.0",
  "version": "1",
  "id": "req-1",
  "method": "extension.invoke",
  "params": {
    "extension": "asp.ext.run-control",
    "method": "steer",
    "runId": "run-1",
    "providerSessionId": "session-1",
    "payload": {
      "message": "先不要改文件，只分析测试失败原因"
    }
  }
}
```

扩展事件统一走 `extension.event`：

```json
{
  "asp": "agent-server-protocol",
  "jsonrpc": "2.0",
  "version": "1",
  "method": "extension.event",
  "params": {
    "extension": "asp.ext.agents",
    "event": "agent.started",
    "runId": "run-1",
    "providerSessionId": "session-1",
    "payload": {
      "agentId": "reviewer",
      "parentAgentId": "primary",
      "role": "subagent"
    },
    "fallback": {
      "type": "message_part",
      "part": {
        "id": "agent-reviewer-started",
        "type": "status",
        "title": "Reviewer",
        "content": "Subagent started"
      }
    }
  }
}
```

旧 UI 可以只渲染 `fallback`。新 UI 可以消费结构化 payload。

## 标准扩展

### asp.ext.agents

适配 primary agent、subagent、mode、persona、task agent、worktree-isolated agent。

```ts
export type AspAgentProfile = {
  id: string;
  name: string;
  role: "primary" | "subagent" | "mode" | "task";
  description?: string;
  defaultModel?: string;
  tools?: string[];
  permissions?: AspPermissionPolicy;
  mcpServers?: AspMcpServerRef[];
  isolation?: "shared" | "worktree" | "process" | "container";
  memory?: "shared" | "isolated" | "ephemeral";
  background?: boolean;
  metadata?: Record<string, unknown>;
};
```

方法：

- `list_agents`
- `select_agent`
- `invoke_agent`
- `cancel_agent`

事件：

- `agent.selected`
- `agent.started`
- `agent.message`
- `agent.tool`
- `agent.completed`
- `agent.failed`

映射：

- OpenCode：`/agent`、session prompt 的 `agent`、message part `agent`、subagent task permission。
- Claude：subagent frontmatter、Agent tool、subagent isolation/background/memory。
- Codex：未来 goal/skill/plugin/agent-like capability 可作为 agent profile 或 runtime profile 暴露。

### asp.ext.run-control

适配运行中的 steering、follow-up、queue、compaction、模型切换和状态调整。

方法：

- `steer`
- `follow_up`
- `set_queue_mode`
- `compact`
- `set_model`
- `cycle_model`
- `set_effort`
- `cycle_effort`
- `set_session_title`
- `abort_current_step`

事件：

- `queue.updated`
- `compaction.started`
- `compaction.completed`
- `model.changed`
- `effort.changed`
- `step.aborted`

映射：

- Pi：`steer`、`follow_up`、`set_steering_mode`、`set_follow_up_mode`、`compact`、`cycle_model`、`cycle_thinking_level`。
- OpenCode：session compact/summarized/status、abort。
- Claude：`--continue`、resume、部分 CLI control 能力。
- Codex：turn interrupt、future goal/continuation controls。

### asp.ext.permissions

适配复杂权限策略，而不是只靠一次性 approval。

```ts
export type AspPermissionRule = {
  effect: "allow" | "ask" | "deny";
  target:
    | { kind: "tool"; tool: string; operation?: string }
    | { kind: "command"; command?: string; pattern?: string }
    | { kind: "filesystem"; path?: string; operation?: "read" | "write" | "delete" }
    | { kind: "network"; host?: string; method?: string }
    | { kind: "agent"; agentId?: string; operation?: "select" | "invoke" }
    | { kind: "mcp"; server?: string; tool?: string };
  lifetime?: "once" | "session" | "workspace" | "always";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type AspPermissionPolicy = {
  defaultEffect?: "allow" | "ask" | "deny";
  rules: AspPermissionRule[];
};
```

映射：

- OpenCode：allow/ask/deny、auto mode、command/path/tool patterns。
- Claude：permission rules、Agent 参数匹配、tool allow/deny、permission modes。
- Pi：path protection、extension permission gates。
- Codex：sandbox/approval settings。

### asp.ext.tools

把常见 coding tool 从字符串事件提升为结构化语义。

工具类型：

- `shell`
- `file.read`
- `file.write`
- `file.edit`
- `patch.apply`
- `search.grep`
- `search.glob`
- `lsp.definition`
- `lsp.references`
- `lsp.hover`
- `lsp.symbols`
- `mcp.call`
- `web.fetch`
- `web.search`
- `agent.invoke`

`AspToolEvent` 保持兼容，同时增加可选字段：

```ts
export type AspToolSemantic = {
  toolType: string;
  operation?: string;
  schemaRef?: string;
  resultKind?: "text" | "json" | "diff" | "diagnostics" | "locations" | "artifact";
  diff?: AspMessagePart;
  artifacts?: AspMessagePart[];
};
```

adapter 仍然发送 core `tool_event`，但把 `semantic` 塞进 metadata 或扩展事件，方便 UI 做 LSP 结果、patch、diagnostics、MCP call 的专用渲染。

### asp.ext.ui

支持 agent 或 extension 发起复杂 UI，而不是把所有交互都压成 question。

请求类型：

- `confirm`
- `select`
- `multi_select`
- `input`
- `editor`
- `form`
- `toast`
- `progress`
- `custom_view`
- `tui.control`

core `question_request` 和 `approval_request` 是 `confirm/select/input` 的兼容子集。复杂组件必须带 fallback question/status。

映射：

- Pi：extension UI request、fire-and-forget UI、custom rendering。
- OpenCode：`/tui/*` control、toast、command UI。
- Claude：hooks menu、output style 或 future interactive controls。

### asp.ext.hooks

支持 agent 生命周期钩子描述和 host-side hook 注册。

生命周期：

- `session.start`
- `session.end`
- `run.start`
- `run.end`
- `tool.before`
- `tool.after`
- `file.before_write`
- `file.after_write`
- `agent.start`
- `agent.end`
- `approval.before`

hook handler 类型：

- `shell`
- `http`
- `mcp`
- `prompt`
- `agent`
- `extension`

安全规则：hook 注册必须经过 host policy；agent 只能声明希望使用的 hook，不能自行扩大权限。

映射：

- Claude：native hooks。
- Pi：extension lifecycle hooks。
- OpenCode：tool/permission/session event automation。
- Codex：future skills/workflows/automation。

### asp.ext.session-state

统一会话状态、队列、上下文、父子会话、checkpoint 和 compaction 信息。

核心 run event 也支持直接发送 `session_state`，用于 agent 在会话启动或标题生成后立即更新 host 会话标题：

```ts
type AspRunEvent = {
  type: "session_state";
  runId: string;
  state: AspSessionState;
  providerSessionId?: string;
};
```

Host 同时会从 `asp.ext.session-state:state.updated` 提取同一份状态，以兼容已经通过扩展事件广播 state 的 native adapter。

```ts
export type AspSessionState = {
  providerSessionId: string;
  title?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  streaming?: boolean;
  queue?: {
    pending: number;
    mode?: string;
  };
  context?: {
    usedTokens?: number;
    windowTokens?: number;
    autoCompaction?: boolean;
  };
  parentSessionId?: string;
  checkpoints?: AspCheckpoint[];
  metadata?: Record<string, unknown>;
};
```

映射：

- Pi：`get_state`、`get_messages`、parent session、auto compaction。
- OpenCode：sessions/messages/compact/summarized/diff。
- Claude：stream-json session id/title、resume/continue metadata。
- Codex：thread/turn status/history/title。

### asp.ext.multimodal

扩展输入从 `prompt + file path attachments` 到真正 content parts。

```ts
export type AspInputPart =
  | { type: "text"; text: string }
  | { type: "file_ref"; path: string; mimeType?: string }
  | { type: "directory_ref"; path: string }
  | { type: "image_ref"; path: string; mimeType?: string }
  | { type: "image_base64"; data: string; mimeType: string }
  | { type: "uri"; uri: string; mimeType?: string }
  | { type: "raw"; protocol: string; value: unknown };
```

映射：

- Pi：RPC image object 可以直接从 `image_base64` 映射，而不是只靠文件路径。
- Claude：stream-json content blocks。
- OpenCode：prompt parts。
- Codex：local image/file input。

### asp.ext.runtime

承载运行环境、MCP、auth、workspace isolation、background task、goal/task 等跨 agent 但不总是对话消息的能力。

字段：

- `mcpServers`
- `authProviders`
- `workspacePolicy`
- `environment`
- `backgroundTasks`
- `goals`
- `skills`

映射：

- Codex：MCP、skills、goal/workflow、browser/computer-use 类 runtime capability。
- Claude：mcpServers、skills、background、worktree isolation。
- OpenCode：config/provider/auth/MCP。
- Pi：extensions、session directory、background integrations。

## vendor 扩展

不能通用化的能力通过 vendor namespace 暴露：

- `vendor.pi.rpc`
- `vendor.opencode.server`
- `vendor.claude.cli`
- `vendor.codex.app-server`

vendor invoke/event 的 payload 保留 native protocol 字段，但必须满足：

1. capability 中明确声明 schema 或 protocol version。
2. 默认关闭写入型 vendor passthrough。
3. 写文件、跑命令、联网、调用 subagent 等仍走 ASP approval。
4. 对用户可见的状态必须同时提供 core fallback。

示例：

```json
{
  "method": "extension.invoke",
  "params": {
    "extension": "vendor.pi.rpc",
    "method": "raw_command",
    "payload": {
      "command": "get_available_thinking_levels"
    }
  }
}
```

## agent 适配矩阵

| Agent       | Core                                              | Standard extensions                                                                 | Vendor extensions         |
| ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| Codex       | run、thread/turn、plan、tool、diff、approval      | `runtime`、`session-state`、`tools`、`permissions`                                  | `vendor.codex.app-server` |
| Claude Code | stream-json、tool_use、thinking、control request  | `agents`、`hooks`、`permissions`、`tools`、`session-state`、`runtime`、`multimodal` | `vendor.claude.cli`       |
| OpenCode    | server session、SSE、message/tool/diff/permission | `agents`、`run-control`、`permissions`、`tools`、`ui`、`session-state`、`runtime`   | `vendor.opencode.server`  |
| Pi          | RPC prompt、message/thinking/tool、extension UI   | `run-control`、`session-state`、`ui`、`multimodal`、`permissions`、`runtime`        | `vendor.pi.rpc`           |

## 降级策略

1. 不支持 `asp.ext.agents`：subagent 事件降级为 status + nested tool event。
2. 不支持 `asp.ext.run-control`：renderer 禁用 steer/follow-up/compact 控件，只允许新 run 或 abort。
3. 不支持 `asp.ext.permissions`：只展示 core approval；规则编辑 UI 不显示。
4. 不支持 `asp.ext.tools`：工具输出按普通 tool_event 渲染。
5. 不支持 `asp.ext.ui`：复杂 UI 降级为 question/status/raw。
6. 不支持 vendor extension：adapter 不暴露 native passthrough，避免形成隐式协议依赖。

## 落地计划

### Phase 1：协议骨架

- 在 `types.ts` 增加 extension descriptor、extension invoke/event、run extension options。
- 在 `AspManager` 增加 `invokeExtension` 和 extension event 分发。
- Renderer 对未知 extension event 使用 fallback 渲染。
- fake ASP agent 增加 extension negotiation 测试。

### Phase 2：Pi 优先

- 修复 Pi JSONL reader，按 LF byte/char 边界实现，不再依赖 Node `readline`。
- 接入 `asp.ext.run-control`：`steer`、`follow_up`、queue mode、`compact`。
- 接入 `asp.ext.session-state`：`get_state`、`get_messages`。
- 接入 `asp.ext.multimodal`：base64 image。
- 接入 `asp.ext.ui`：fire-and-forget UI、custom rendering fallback。

### Phase 3：OpenCode

- 接入 `asp.ext.agents`：agent list、select、invoke、subagent lifecycle。
- 接入 `asp.ext.permissions`：allow/ask/deny rule 映射。
- 接入 `asp.ext.tools`：LSP、MCP、webfetch/websearch、patch semantic。
- 接入 `asp.ext.ui`：TUI control、command UI、toast。

### Phase 4：Claude

- 接入 `asp.ext.agents`：subagent profile、Agent tool、isolation/background/memory。
- 接入 `asp.ext.hooks`：hook discovery/registration/status。
- 接入 `asp.ext.permissions`：permission rule、mode、tool restrictions。
- 接入 `asp.ext.runtime`：skills、MCP、background tasks。

### Phase 5：Codex

- 类型层暴露 `mcpServers`，不要只在 adapter 内部读未声明字段。
- 接入 `asp.ext.session-state`：thread history、turn status。
- 接入 `asp.ext.runtime`：skills/goals/browser/computer-use 等 runtime capability。
- 对 app-server native 字段通过 `vendor.codex.app-server` 做保真转发。

## 测试要求

每个 extension 至少有三层测试：

1. protocol test：capabilities 协商、invoke、event、fallback、未知 extension 忽略。
2. adapter fake test：fake Pi/OpenCode/Claude/Codex 覆盖 native 协议映射。
3. renderer state test：未知 extension 不崩溃；已知 extension 正确更新 UI state。

关键兼容性断言：

- 所有 extension event 都有 fallback 或明确标记 `fallback: "none"`。
- 未协商 extension 的写入型 invoke 必须失败。
- approval 相关 vendor payload 不得绕过 ASP approval。
- adapter 输出 core event 的顺序仍符合现有 run lifecycle。
