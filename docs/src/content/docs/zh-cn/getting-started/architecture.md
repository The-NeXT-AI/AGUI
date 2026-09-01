---
title: 架构
description: AGUI 如何归一化 Agent 协议并渲染桌面体验。
---

AGUI 的 renderer contract 很窄，背后的 runtime 更丰富。Runtime 负责 provider 进程、transport、持久化、审批、提问、workspace 访问和协议适配。Renderer 只接收归一化的 ASP 事件，专注于界面状态。

## 核心链路

```text
AGUI Renderer
  -> secure IPC 或 WebSocket JSON-RPC
  -> @the-next-ai/agui-runtime
  -> @the-next-ai/asp AspManager
  -> provider adapter 或 generic ASP transport
  -> normalized ASP events
  -> chat、plan、tool、diff、artifact、resource、approval、question、usage
```

## 各包职责

| Package               | 职责                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| `packages/app`        | Renderer React UI、Shell 状态、聊天渲染、扩展 UI runtime、产品配置。                   |
| `packages/asp`        | ASP protocol 类型、transport、provider store、session manager、原生 provider adapter。 |
| `packages/runtime`    | Electron 和 Node server 模式共享的 runtime 服务。                                      |
| `packages/server`     | 纯 Web 模式的轻量 Node 入口。                                                          |
| `packages/extensions` | Extension manifest、IPC contract、声明式 UI schema 类型。                              |
| `packages/electron`   | Electron 生命周期、preload bridge、IPC、原生 dialog、嵌入式 browser view。             |

## Runtime 边界

Renderer 从不直接对接 provider 私有 API。它向 runtime 发送高层会话请求，由 runtime 将 provider 输出转换为 ASP 事件。这样 UI 保持可预期：

- `reasoning`、`plan`、`tool`、`diff`、`resource`、`artifact`、`usage` 和 status 事件共用同一套展示模型。
- 审批和提问闭环不依赖具体 provider。
- Provider 私有数据保留在 adapter 边界内，除非明确作为 metadata 暴露。

## 会话连续性

每个 provider 线路保存自己的 `providerSessionId`、capabilities、上下文用量、运行设置和同步位置。切换 Agent 只改变下一轮由谁执行——不会覆盖共享时间线，也不会把一个 provider 的会话 ID 传给另一个 provider。[多 Agent 会话](/zh-cn/guides/multi-agent/)指南详细说明了 handoff 规则。

## Web 模式

`@the-next-ai/agui-server` 在 Node 中运行共享 runtime，并通过 WebSocket 暴露 JSON-RPC。桌面专属能力不可用时会降级：原生目录选择、`WebContentsView` 浏览器嵌入、浏览器自动化、扩展安装体验和系统安全存储。

## 继续阅读

- [Provider](/zh-cn/guides/providers/)
- [多 Agent 会话](/zh-cn/guides/multi-agent/)
- [扩展开发](/zh-cn/guides/extensions/)
