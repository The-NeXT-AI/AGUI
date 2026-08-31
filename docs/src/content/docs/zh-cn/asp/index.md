---
title: Agent Server Protocol（ASP）
description: 用统一开放协议连接编码 Agent 客户端与 Agent Server。
---

Agent Server Protocol（ASP）是一套连接编码 Agent 客户端与 Agent Server 的开放双向协议。它用一个稳定 contract 统一会话、流式输出、工具、审批、提问、用量以及高级 Agent 能力。

ASP 由 AGUI 项目孵化，但不是 AGUI 私有的进程接口。任何客户端或 Agent Server 都可以独立实现该协议。

## 为什么需要 ASP

不同编码 Agent 使用不同的进程模型、事件格式、会话标识和审批流程。如果缺少共同边界，每个客户端都必须直接实现所有 provider 协议。

```text
没有 ASP                            使用 ASP

客户端 A ─┬─ Codex                 客户端 A ─┐
          ├─ Claude                          ├─ ASP ─┬─ Codex adapter
          └─ OpenCode              客户端 B ─┘       ├─ Claude adapter
客户端 B ─┬─ Codex                                    ├─ OpenCode adapter
          └─ Claude                                   └─ 原生 ASP Agent
```

ASP 把可移植的交互模型与 provider 私有细节分开。无论一次运行来自原生 ASP Server，还是 Codex、Claude Code、OpenCode、Pi、Grok、Kimi 等 Agent 的 adapter，renderer 都可以消费同一套事件。

## 协议分层

ASP 分为三层：

| 层级        | 作用                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Core v1     | 初始化、能力协商、会话、运行、流式事件、取消、错误以及受控 Client 服务。                                                               |
| 标准扩展    | 多类 Agent 共享的可协商能力，例如 subagent、运行控制、权限规则、typed tools、复杂 UI、hooks、会话状态、多模态输入和 runtime metadata。 |
| Vendor 扩展 | 无法通用表达时，对 provider 私有数据进行无损保留。                                                                                     |

所有 v1 消息都使用 JSON-RPC 2.0 信封，并显式标识协议：

```json
{
  "asp": "agent-server-protocol",
  "version": "1",
  "jsonrpc": "2.0"
}
```

## 角色与生命周期

- **Client** 初始化连接，创建或恢复会话，提交运行，并且只开放自己愿意提供的 workspace 服务。
- **Agent Server** 声明能力、执行运行、发出归一化事件，也可以反向调用已经协商的 Client 服务。
- **Provider session** 保存 Agent 侧的连续上下文；**run** 是该会话中的一次执行。UI thread 属于客户端概念，三种标识不能混用。

一次典型连接遵循以下流程：

```text
Client                                      Agent Server
  │── initialize + 支持版本 ─────────────────────►│
  │◄─ 选定版本 + capabilities ────────────────────│
  │── new_session / resume_session ──────────────►│
  │── run(runId, input, extensions) ─────────────►│
  │◄─ run_started ────────────────────────────────│
  │◄─ message / tool / usage / state 事件 ────────│
  │── Client 权限或提问结果 ──────────────────────►│
  │◄─ run_finished ───────────────────────────────│
```

## 传输方式

协议语义不绑定单一部署模型。ASP v1 支持：

- **stdio**：每次运行启动一个进程；
- **persistent stdio**：在长生命周期 provider 上多路复用；
- **WebSocket**：连接本地或远程 Server；
- **SSH**：建立等价的 stdio 或 WebSocket 通道。

同一连接上的消息保持顺序。不同运行的事件可以交错，因此实现必须按 `runId` 路由，不能依赖全局“当前运行”。

## 安全边界

Host 始终是安全边界。Agent 只有在能力协商阶段得到 Client 明确开放后，才能通过 Client 服务读写文件、启动命令、请求权限或向用户提问。Client 仍然负责 workspace 路径限制、审批策略、内容大小、超时和关联标识校验。

扩展也不能绕过这些规则。具有写入能力的扩展必须先协商并获得审批；用户可见的扩展事件应尽可能提供 core fallback。

## 继续阅读

- [核心协议](/zh-cn/asp/core-protocol/)介绍初始化、会话、运行、事件、Client 服务和错误处理。
- [扩展协议](/zh-cn/asp/extensions/)介绍能力发现、调用、降级策略和标准扩展命名空间。
- 仓库中提供[规范性核心协议](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/docs/core-protocol.md)与[机器可读的 v1 JSON Schema](https://github.com/The-NeXT-AI/AGUI/blob/main/packages/asp/schema/v1/schema.json)。
