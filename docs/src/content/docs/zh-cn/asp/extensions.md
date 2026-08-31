---
title: ASP 扩展协议
description: 能力协商、标准扩展命名空间、vendor passthrough 与兼容降级。
---

ASP 保持 core 小而稳定。可选或 Agent 私有能力通过可发现的扩展发布，在每次运行中协商，并通过统一 envelope 传输。

扩展不会成为隐式的第二套协议。它必须声明版本、Schema、安全要求和 fallback 行为，同时 Host 继续执行 workspace 与审批策略。

## 发现并选择扩展

Server 在初始化后的 capabilities 中发布扩展描述符。描述符标识扩展，并说明它支持的方法和事件：

```ts
type AspExtensionDescriptor = {
  id: string;
  version: string;
  stability: "stable" | "experimental" | "vendor";
  requiresCore?: string[];
  methods?: AspExtensionMethodDescriptor[];
  events?: AspExtensionEventDescriptor[];
  schemas?: Record<string, unknown>;
  fallback: "core" | "raw" | "none";
};
```

Client 为一次具体运行选择扩展：

```json
{
  "runId": "run-1",
  "extensions": [
    { "id": "asp.ext.run-control", "version": "1.0.0" },
    { "id": "asp.ext.tools", "version": "1.0.0" }
  ]
}
```

实现必须拒绝没有声明或协商的方法。Raw vendor passthrough、后台运行等需要额外权限的扩展不能被静默启用。

## 调用扩展

所有扩展命令都使用 `extension.invoke`，新增能力不需要修改 transport framing：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "extension.invoke",
  "params": {
    "extension": "asp.ext.run-control",
    "method": "steer",
    "runId": "run-1",
    "providerSessionId": "session-1",
    "payload": {
      "message": "先分析失败原因，不要修改文件。"
    }
  }
}
```

如果描述符提供 `inputSchema` 或 `outputSchema`，发送方与接收方都必须使用 JSON Schema 2020-12 校验 payload。

## 接收扩展事件

事件使用 `extension.event` 方法，并携带 core fallback：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0",
  "method": "extension.event",
  "params": {
    "extension": "asp.ext.agents",
    "event": "agent.started",
    "runId": "run-1",
    "payload": {
      "agentId": "reviewer",
      "parentAgentId": "primary",
      "role": "subagent"
    },
    "fallback": {
      "type": "message_part",
      "part": {
        "id": "reviewer-started",
        "type": "status",
        "title": "Reviewer",
        "content": "Subagent started"
      }
    }
  }
}
```

理解该扩展的 Client 渲染结构化 payload；旧 Client 应用 fallback。当某个事件只用于诊断或无损保留原生数据，并且忽略它不会影响用户时，可以使用 `fallback: "none"`。

## 标准扩展

| 命名空间                | 能力                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `asp.ext.agents`        | Agent profile、选择、subagent 调用、隔离方式与生命周期。                          |
| `asp.ext.run-control`   | Steering、follow-up queue、compaction、模型或 effort 切换以及中止当前步骤。       |
| `asp.ext.permissions`   | 面向工具、命令、文件、网络、Agent 和 MCP 的可复用 allow、ask、deny 规则。         |
| `asp.ext.tools`         | Shell、文件、patch、搜索、LSP、MCP、Web 和 Agent 工具的 typed semantic。          |
| `asp.ext.mcp-apps`      | MCP App 发现、调用、UI resource、状态和 Host 交互。                               |
| `asp.ext.ui`            | Form、editor、select、progress、toast、custom view 与 TUI control。               |
| `asp.ext.hooks`         | 受控的 session、run、tool、file、Agent 和 approval 生命周期 hook。                |
| `asp.ext.session-state` | Queue、context、父会话、checkpoint、compaction 与 message state。                 |
| `asp.ext.multimodal`    | Text、file、directory、image、URI 与显式标识协议的 raw input part。               |
| `asp.ext.runtime`       | MCP Server、auth、workspace policy、后台任务、goal 和 skill 等 runtime metadata。 |

这些命名空间表达多类 Agent 共有的能力，不会照搬某个 vendor 的 wire format。

## Vendor 扩展

Provider 私有能力放在 `vendor.codex.app-server`、`vendor.claude.cli`、`vendor.opencode.server`、`vendor.pi.rpc` 等命名空间下。它们保留标准扩展无法表达的信息，但仍受以下约束：

1. Capability 必须声明 Schema 或原生协议版本。
2. 具有写入能力的 passthrough 默认关闭。
3. 文件写入、命令、网络访问和 subagent 调用仍受 ASP approval 控制。
4. 用户可见状态同时提供 core fallback。

通过 `preserveNativeEvents` 请求的原生事件只是归一化 core 事件的补充，不能取代 core 事件。

## 兼容降级

Fallback 是协议 contract 的一部分：

- 不支持 `asp.ext.agents` 时，subagent 活动降级为 status 和嵌套 tool event。
- 不支持 `asp.ext.run-control` 时，Client 隐藏 steering 和 compaction 控件，但仍可启动或取消运行。
- 不支持 `asp.ext.permissions` 时，Client 保留 core 的单次审批，并隐藏规则编辑。
- 不支持 `asp.ext.tools` 时，结果按普通 `tool_event` payload 渲染。
- 不支持 `asp.ext.ui` 时，复杂交互降级为 core question 或 status event。
- 不支持 vendor 扩展时，adapter 不发送 native passthrough，可移植的基础对话仍然可用。

扩展版本独立于 core 使用语义化版本。新的 major version 需要显式重新协商；同一 major version 内新增可选字段保持向后兼容。

共享消息格式与生命周期规则请返回 [ASP v1 核心协议](/zh-cn/asp/core-protocol/)。
