---
title: Provider
description: 配置内置和自定义编码 Agent provider。
---

Provider 是具体 Agent 实现与 AGUI 所渲染的 ASP 事件流之间的桥。先选择一个内置 provider 上手，或注册自己的 ASP 兼容 Agent。

## 内置 Provider

| Provider    | Runtime 策略                                                                         |
| ----------- | ------------------------------------------------------------------------------------ |
| Codex       | 启动 app server，将 JSONL 通知、审批和结果映射为 ASP。                               |
| Claude Code | 启动 stream-json SDK 模式，将内容块、工具和 control request 映射为 ASP。             |
| OpenCode    | 启动或连接 `opencode serve`，消费 session history、HTTP API、SSE 事件和 permission。 |
| Pi          | 启动 `pi --mode rpc`，映射 RPC JSONL 命令、模型设置、推理等级、消息和工具。          |
| Grok        | 启动 headless CLI 流式 JSON 消息运行，并读取本地会话历史。                           |
| Kimi        | 启动 headless CLI stream-json 输出运行，并读取本地会话历史。                         |
| Kilo        | 使用 generic ASP stdio provider 入口。                                               |

## 自定义 Provider

自定义定义保存在 AGUI user data directory 下的 `asp-providers.json`，按以下顺序解析：

1. `AG_UI_USER_DATA_DIR`
2. `AGUI_USER_DATA_DIR`
3. `AG_UI_HOME`
4. `AGUI_HOME`
5. `~/.agui`

**Settings** 页支持在该文件中新增、编辑、删除和测试自定义 Agent。

## ASP 请求接口

自定义 Agent 应实现 ASP v1 请求方法：

- `capabilities`
- `list_models`
- `run`
- `list_sessions`
- `session_messages`
- `resume_session`
- `session_usage`
- `delete_session`

`run` 启动一轮执行；`abort` 不是请求方法，而是携带 `type: "abort"` 的独立 notification。审批与提问通过 `approval_result` / `question_result` 响应闭合，协商过扩展协议的 Agent 还会收到 `extension.invoke`。`delete_session` 与 `session_usage` 支撑 AGUI 的远端清理和用量展示，按需实现即可。

Transport 可选 stdio、persistent stdio、WebSocket 或 SSH。如果 provider 受益于进程复用或 warm state，优先选择 persistent transport。

尽早且清晰地失败：如果 Agent 无法协商 capabilities、列出模型或开始运行，应直接报错而不是停滞。

## 运行安全

Provider 执行受 workspace path、approval mode 和所选 transport 约束。adapter 输出必须走普通 ASP 事件——绝不允许 provider 私有配置绕过 AGUI 的审批和提问处理。

## 继续阅读

- [多 Agent 会话](/zh-cn/guides/multi-agent/)
- [配置参考](/zh-cn/reference/configuration/)
