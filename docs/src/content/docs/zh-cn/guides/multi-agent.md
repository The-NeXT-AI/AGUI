---
title: 多 Agent 会话
description: 在一条 AGUI 共享会话中切换不同 provider。
---

一条会话可以在同一条共享时间线中切换 Codex、Claude Code、OpenCode 或其他任何 provider。切换下一个执行的 Agent 不需要复制消息，也不需要新建会话。

## 在会话中途切换 Agent

1. 从输入框打开运行设置。
2. 在 **Agent** 子菜单中选择下一个要执行的 Agent。
3. 发送消息。AGUI 会恢复该 Agent 的头像、模型、推理强度、速度和审批设置，选中的 Agent 收到它上次参与之后的共享对话增量。
4. 阅读输出——它会附带产出 Agent 的头像和名称显示。

运行期间禁止切换到其他 Agent（重新选择当前 Agent 不受限制），确保事件永远不会路由给错误的 Agent。AGUI 还会先检查目标 provider 是否可用，检查通过后才提交选择，因此不可用的 Agent 不会替换当前 Agent。

## 每个 Provider 的状态

每条 AGUI 会话包含：

| 状态       | 用途                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| 共享时间线 | 用户可见的用户消息与 Agent 输出有序列表。                                          |
| Agent 线路 | 每个 provider 的 `providerSessionId`、capabilities、设置、状态、usage 和同步位置。 |
| 已退役线路 | 编辑或重新生成后保留的旧 provider 线程，随 AGUI 会话一起清理。                     |

## 上下文 Handoff

某个 Agent 没看过最近的会话块时，AGUI 会发送结构化且有界的 handoff 上下文：

- 可以同步用户消息、非空 assistant 回答，以及精简后的 plan、tool、terminal、diff、resource 和 artifact 摘要；reasoning 和原始噪声事件会被排除。当前这条用户输入仍按原始 prompt 发送，不会重复进入 handoff。
- Handoff 上限为 16 个上下文项、约 12,000 字符。如果仅最新工作单元就超出预算，AGUI 会保留开头的用户请求和最终 assistant 回答，再用剩余预算装入最新的有效产物。
- 其他 Agent 的回答会被视为不可信引用输出。
- 只有成功且未取消的运行才会推进 handoff 游标；失败或取消不会丢弃待同步上下文，后续运行仍可重试。
- 每次运行都携带客户端请求 ID，旧运行的迟到事件会在更新新 Agent 的投影前被拒绝。

### 原始文件

文件访问不占用文本摘要预算。即使相关消息或工具输出被截断，AGUI 仍会从历史附件和具有文件路径的产物中独立收集文件清单。

Runtime 会校验每个源路径，并为不超过 100 MB 的文件创建按内容寻址的只读快照。上下文交给 provider 前会移除源路径；同一文件 ID 第一次生成的快照会保持稳定，即使之后工作区文件发生变化。原生 adapter 会直接收到快照路径，Agent 也可以通过本次运行专属的 `handoff_file_list` 与 `handoff_file_read` MCP 工具发现并读取完全相同的字节。文件缺失或过大时只会标记为不可用，不会暴露可变的源路径；移除本地 AGUI 会话时也会一并删除对应快照。

## 历史分叉

编辑较早的用户消息或重新生成回答会产生分叉。AGUI 会退役当前活动的 provider 线路，并从可见时间线开始下一轮运行，因此隐藏的 provider context 无法跨分支泄露。

## 删除行为

删除多 Agent 会话时，AGUI 会枚举每一个活动和已退役 provider 线程并尝试远端清理，删除对话框会展示实际线程数量。如果某个 provider 无法远端删除，AGUI 会列出它，并保留"仅从本地列表移除"的选择。部分线程删除成功、部分失败时，只移除已成功线程的记录并保留会话，可以安全重试，不会重复删除已完成的线程。

## 继续阅读

- [Provider](/zh-cn/guides/providers/)
- [架构](/zh-cn/getting-started/architecture/)
