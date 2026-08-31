---
title: ASP v1 核心协议
description: ASP 消息信封、能力协商、会话、运行、事件、Client 服务与错误处理。
---

ASP core v1 定义客户端与 Agent Server 完成一次编码 Agent 会话所需的最小可移植 contract。本页面向实现者进行说明；[核心规范](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/docs/core-protocol.md)与 [JSON Schema](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/schema/v1/schema.json)是规范性依据。

## 公共信封

所有新发送的 v1 消息都包含 `asp`、`version` 和 `jsonrpc`：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0"
}
```

请求还需包含唯一的字符串或数字 `id`、`method` 和方法参数。响应必须回显同一个 `id`，并且只能包含 `result` 或 `error` 其中之一。通知没有 `id`。

接收方可以兼容早期 v1 草案中缺少 `jsonrpc` 的消息，但新的发送方必须包含该字段。无效或有歧义的消息应该被拒绝，不能静默修复。

## 初始化连接

开始其他工作前，Client 发送 `initialize`，声明支持的协议版本、自身信息和能力：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "initialize",
  "supportedProtocolVersions": ["1"],
  "clientInfo": { "name": "example-client", "version": "1.0.0" },
  "clientCapabilities": {}
}
```

Server 选择一个共同版本并返回自身能力：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "id": "init-1",
  "result": {
    "protocolVersion": "1",
    "agentInfo": { "name": "example-agent", "version": "1.0.0" },
    "capabilities": { "protocolVersions": ["1"] }
  }
}
```

如果没有共同版本，连接不能继续。Capabilities 只属于当前连接，重连后必须重新协商。双方都不能调用对方未声明的能力。

## 会话模型

`providerSessionId` 是 Agent Server 命名空间中的稳定会话标识。它与客户端的 `threadId`、单次执行的 `runId` 都不同。

| 方法               | 作用                             |
| ------------------ | -------------------------------- |
| `new_session`      | 显式创建 provider session。      |
| `list_sessions`    | 列出 workspace 中可见的会话。    |
| `resume_session`   | 加载可恢复会话及其消息。         |
| `session_messages` | 读取会话历史。                   |
| `session_usage`    | 读取累计用量。                   |
| `close_session`    | 停止活动资源，但保留可恢复历史。 |
| `delete_session`   | 永久删除会话历史。               |

关闭和删除不是同一操作。`close_session` 必须幂等；会话状态为 `active`、`closed` 或 `unknown`。

## 运行生命周期

`run` 请求包含唯一 `runId`、客户端 `threadId`、工作目录、结构化输入、审批模式、所选扩展，以及可选的 `providerSessionId`。

Server 对每个接受的运行都必须：

1. 首先发出 `run_started`；
2. 发出零个或多个内容、工具、用量或状态事件；
3. 最后恰好发出一次终态 `run_finished`。

核心事件包括：

| 事件                | 含义                                                         |
| ------------------- | ------------------------------------------------------------ |
| `message_delta`     | 增量文本或 reasoning 输出。                                  |
| `message_part`      | 文本、reasoning、diff、artifact 或 status 等结构化消息部分。 |
| `tool_event`        | 工具启动、进度、结果或失败。                                 |
| `session_state`     | 更新后的 provider session 状态。                             |
| `usage`             | Token、上下文或费用用量。                                    |
| `stdout` / `stderr` | 有意暴露的原始进程输出。                                     |
| `error`             | 非终态或终态运行错误。                                       |
| `extension_event`   | 已协商的扩展事件及其 fallback。                              |
| `run_finished`      | 一次运行唯一的终态事件。                                     |

同一 item、message part 或 tool 的更新必须按发送顺序应用。终态事件报告 `success` 和 `stopReason`，其标准值为 `end_turn`、`canceled`、`error`、`timeout`、`max_tokens`、`max_turns` 或 `refusal`。

Client 使用 `run.cancel` 通知取消活动运行。取消与完成存在竞态，已经结束的运行不能被改写成 canceled。

## 双向 Client 服务

Agent Server 只能调用 `clientCapabilities.clientServices` 中标记为 `true` 的服务。每次调用都必须关联活动 `runId`，并可以包含对应的 `providerSessionId`。

| 服务类型 | 方法                                                                   |
| -------- | ---------------------------------------------------------------------- |
| 文件     | `client.fs.read_text_file`、`client.fs.write_text_file`                |
| 终端     | `client.terminal.create`、`output`、`wait_for_exit`、`kill`、`release` |
| 权限     | `client.permission.request`                                            |
| 用户输入 | `client.elicitation.create`                                            |

Client 必须把文件路径限制在已授权 workspace 内，阻止符号链接逃逸，限制 payload 大小，并按自身审批策略控制副作用。权限响应只能是 `allow`、`allow-session`、`allow-always`、`deny` 或 `cancel`。提问响应会明确区分已回答、已取消和未回答。

## 错误

错误使用 `{ code, message, data? }`。ASP 保留 JSON-RPC 错误码，并增加协议专用错误：

|     代码 | 含义                            |
| -------: | ------------------------------- |
| `-32700` | JSON 解析失败                   |
| `-32600` | 请求、状态、信封或关联标识无效  |
| `-32601` | 方法不存在                      |
| `-32602` | 参数无效或 JSON Schema 校验失败 |
| `-32603` | 内部错误                        |
| `-32800` | 请求或运行已取消                |
| `-32001` | 审批被拒绝                      |
| `-32002` | 资源不存在                      |
| `-32003` | 能力未协商                      |
| `-32004` | 协议版本不匹配                  |

`error.data` 可以携带重试与关联信息，但不能包含凭证或未脱敏的环境变量。

## 校验与兼容性

- 输入、历史消息、原生事件和扩展 payload 默认都是不可信数据。
- 在接收边界校验信封、Schema、响应 ID、`runId` 和 `providerSessionId`。
- 限制消息大小、数组长度、缓存输出、文件内容和执行时间。
- Core 的破坏性变化使用新的 `version`；v1 内新增可选字段和 capability flag 保持向后兼容。
- 代理或记录消息时保留未知字段，以便其他实现无损转发。

继续阅读 [ASP 扩展协议](/zh-cn/asp/extensions/)，了解如何在不破坏 core 的前提下增加可选能力。
