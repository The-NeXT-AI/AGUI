# Agent Server Protocol（ASP）v1 核心规范

状态：由 AGUI 项目孵化的开放协议草案。ASP 不是 AGUI 的私有进程接口；任何客户端和 Agent Server 都可以独立实现本规范。

本文中的“必须（MUST）”“不得（MUST NOT）”“应该（SHOULD）”和“可以（MAY）”具有规范性含义。机器可读的规范是 [`../schema/v1/schema.json`](../schema/v1/schema.json)。两者冲突时，实现必须拒绝有歧义的消息并报告 `-32600`，不得静默猜测。

## 1. 角色与传输

- Client：发起初始化、会话和运行请求，并向 Agent 提供受控的文件、终端、权限和提问服务。
- Agent Server：实现 Agent 能力，产生标准事件，也可以反向调用已协商的 Client 服务。
- 一条连接承载双向请求、响应、通知和事件。stdio/persistent-stdio 使用一行一个 UTF-8 JSON 对象；WebSocket 每帧承载一个 JSON 对象；SSH 只负责建立等价的 stdio 通道。
- 同一连接上的消息顺序必须保持。不同 `runId` 的事件可以交错；接收方必须按 `runId` 路由，不能依赖全局当前运行。

## 2. 公共信封和 RPC

所有 v1 消息必须包含：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0"
}
```

请求必须包含唯一的字符串或数字 `id`、`method` 和方法参数。响应必须回显完全相同的 `id`，并且恰好包含 `result` 或 `error` 之一。通知没有 `id`。为读取早期 v1 草案，接收方可以接受缺失的 `jsonrpc`；新发送方必须发送它。

错误对象为 `{ code, message, data? }`。标准代码：

|   代码 | 名称                      | 含义                              |
| -----: | ------------------------- | --------------------------------- |
| -32700 | Parse error               | JSON 无法解析                     |
| -32600 | Invalid request           | 信封、状态或关联标识无效          |
| -32601 | Method not found          | 方法未实现                        |
| -32602 | Invalid params            | 参数或声明的 JSON Schema 校验失败 |
| -32603 | Internal error            | 未分类的实现错误                  |
| -32800 | Canceled                  | 请求或运行已取消                  |
| -32001 | Approval denied           | 用户或策略拒绝副作用              |
| -32002 | Resource not found        | 会话、文件或终端不存在            |
| -32003 | Capability not negotiated | 调用了未协商能力                  |
| -32004 | Protocol version mismatch | 无共同协议版本                    |

`error.data` 可以携带 `retryable`、`details`、`method`、`runId` 和 `providerSessionId`。实现不得把凭证或未脱敏环境变量放入错误数据。

## 3. 初始化与能力协商

每次新连接开始工作前，Client 必须发送 `initialize`：

```json
{
  "method": "initialize",
  "id": "1",
  "supportedProtocolVersions": ["1"],
  "clientInfo": { "name": "example", "version": "1.0.0" },
  "clientCapabilities": {}
}
```

Agent 必须选择一个共同版本并返回：

```json
{
  "id": "1",
  "result": {
    "protocolVersion": "1",
    "agentInfo": { "name": "example-agent", "version": "1.0.0" },
    "capabilities": { "protocolVersions": ["1"] }
  }
}
```

没有共同版本时必须返回 `-32004`。双方只能调用双方已声明的能力。能力快照只对当前连接有效；重连必须重新协商。`capabilities` 方法保留给早期 v1 实现探测，但规范实现必须支持 `initialize`。

扩展描述符必须声明 `id`、`version`、`stability` 和回退模式。方法应该提供 `inputSchema`/`outputSchema`，事件应该提供 `payloadSchema`；声明后，发送方和接收方都必须按 JSON Schema 2020-12 校验。未知扩展必须通过其 `fallback` 降级，不能伪装成核心事件。

## 4. 会话模型

`providerSessionId` 是 Agent 命名空间中的稳定会话标识，与 UI 的 `threadId` 和单次运行的 `runId` 不同。

- `new_session`：显式创建会话，要求 `createSession: true`，返回 `AspProviderSession`。
- `list_sessions`：列出工作区可见会话。
- `resume_session`：读取可继续的会话与消息。
- `session_messages` / `session_usage`：读取历史和用量。
- `close_session`：终止活动资源但保留可恢复历史，要求 `closeSession: true`。
- `delete_session`：永久删除会话历史，要求 `deleteSession: true`。

关闭与删除不是同义操作。`close_session` 必须幂等；对已关闭会话再次关闭应该返回成功。会话状态为 `active`、`closed` 或 `unknown`。

## 5. 运行生命周期

`run` 请求包含唯一 `runId`、`threadId`、工作目录、结构化输入、审批模式、所选扩展和可选 `providerSessionId`。Agent 必须先发 `run_started`，随后发送零个或多个内容/工具/状态事件，最后恰好发送一次 `run_finished`。

核心事件包括：`message_delta`、`message_part`、`tool_event`、`session_state`、`usage`、`stdout`、`stderr`、`error`、`extension_event` 和 `run_finished`。同一 `itemId`、part id 或 tool id 的更新必须按发送顺序应用。

`run_finished.stopReason` 的标准值为：`end_turn`、`canceled`、`error`、`timeout`、`max_tokens`、`max_turns`、`refusal`。`success: false` 不得缺省成 `end_turn`。

取消使用 `run.cancel` 通知，同时保留 `type: "abort"` 供早期 v1 读取方识别。Agent 收到取消后应尽快停止副作用，并以 `success: false`、`stopReason: "canceled"` 完成运行；取消具有竞态，已完成的运行不应被改写为取消。

## 6. 双向 Client 服务

Agent 只能调用 `clientCapabilities.clientServices` 中值为 `true` 的服务。每个请求必须包含活动 `runId`，可包含 `providerSessionId`：

- `client.fs.read_text_file` / `client.fs.write_text_file`
- `client.terminal.create` / `output` / `wait_for_exit` / `kill` / `release`
- `client.permission.request`
- `client.elicitation.create`

Client 必须把文件路径限制在已授权工作区内，阻止符号链接逃逸并限制内容大小。写文件、启动命令和终止进程必须经过审批策略；未批准返回 `-32001`。终端句柄至少在所属运行内唯一，`release` 只释放已退出终端的缓存资源。

权限请求返回规范化 decision：`allow`、`allow-session`、`allow-always`、`deny` 或 `cancel`。提问响应必须明确表示答案、取消或未回答，不能把空答案解释为同意。

## 7. 扩展与无损语义

核心事件是跨 Agent 的可移植语义层。适配器归一化事件时可能无法表达原始供应商载荷；Client 在 `run.preserveNativeEvents: true` 时请求无损副通道。支持它的适配器必须同时发出所属 `vendor.*` 扩展的 `native.event`，其 `payload` 是原始 JSON 对象，`fallback` 为 `none`。该事件不能代替核心事件，也不能绕过审批。

扩展事件的 `fallback` 是必填字段：可为 `none`，或一个等价的核心 `message_delta`、`message_part`、`tool_event`、`usage`、`stdout`、`stderr`、`error`。不理解扩展的 Client 必须应用回退；`none` 表示可以安全忽略。

## 8. 安全、限制和一致性

- 输入数据、历史消息、原生事件和扩展载荷默认不可信。
- 实现必须限制消息、数组、文件、输出缓存和超时；参考 Schema 给出了 v1 上限。
- 响应 id、`runId` 和 `providerSessionId` 必须关联验证。来自旧运行或其他渲染方的响应必须忽略或拒绝。
- 声明为 `approval_required` 的扩展方法必须在执行前获得审批。
- 接收方遇到无效信封或 Schema 不匹配必须返回标准错误；不得静默修复会改变语义的数据。

## 9. 兼容性

核心破坏性变化使用新的 `version`。v1 中新增可选字段和能力位属于向后兼容变化。扩展独立采用语义化版本；同一主版本可以兼容新增可选字段，主版本变化必须重新协商。实现应保留未知字段，以便代理或日志系统无损转发。
