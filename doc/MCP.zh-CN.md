# MCP 集成

[English](MCP.md) | [简体中文](MCP.zh-CN.md)

**应用**和 **MCP server** 如何在同一个本地索引上共存。

## 原则

一个索引。一个写入者。多个读取者。应用和 MCP 是同一核心上的两个前端，不是两个需要同步的系统。

- **应用** = 长驻、面向人：浏览、读完整会话、展开过程、导出交接、日报。
- **MCP** = 短驻（由 agent 客户端启动）、面向 agent：紧凑、低延迟的任务中检索。
- 两者调用同一套 `searchTurns` / session-detail / facets / handoff 代码。

共享索引是 `~/Library/Application Support/session-recall/index.db`（SQLite WAL）：多个读取者 + 一个写入者。`SESSION_RECALL_DB` 可以覆盖它。

## 场景

| | 应用（人） | MCP（agent） |
| --- | --- | --- |
| 触发 | 用户打开 | 任务进行中 |
| 目标 | 深入：完整会话、多轮、对比 | 即时回忆：以前解决过吗 |
| 输出 | 大 | 紧凑：排名 + 问答 + session id + 深链 |
| 延迟 | 几秒可以 | 最好 100ms 内 |
| 典型 | 过滤、切换主题、导出交接、报告 | `recall_search`，必要时 `recall_session` |

Agent context 很贵：**MCP 默认紧凑**，深入查看用 `recall_session` 或应用。

## 写入者 / 读取者模型

- 应用 sidecar 是长驻写入者（它已经每 90 秒重扫）。
- MCP 是**只读**读取者，没有写工具；CLI 的 `search` 也是只读。`forget` / `unforget` 是唯一会改变索引的 CLI 命令，它们会拿共享扫描锁。两者都直接打开 DB，所以应用关着也能用——都不依赖应用的随机端口。
- **共享扫描锁**（索引旁的锁文件，例如 `index.db.scan.lock`）保证同一时间只有一个进程扫描。应用、CLI 和 MCP 写入前都会拿锁。
- 过期扫描：读取者可以检查“上次扫描时间 vs 最新会话 mtime”，如果过期，就在**持有锁的情况下**重扫；其他人读当前索引。绝不在每次查询时同步扫描。

## 新鲜度

- 每个结果都带 `indexAgeMs`（现在 − 上次成功扫描），agent 可以判断是否可能缺少最近几分钟。
- `recall_scan` 触发显式刷新并返回扫描统计。

## MCP 工具面（刻意很小）

MCP server：`session-recall mcp`，通过 **stdio**，只读，无网络。

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `recall_search` | `query`、可选 `agent`、`scope`（`qa`/`process`）、`project`、`from`、`to`、`limit`（默认 5） | 紧凑结果：`sessionId`、`agent`、`project`、`date`、`title`、`question`、`answer`（截断）、`deepLink`、`indexAgeMs`、`totalSessions` |
| `recall_session` | `sessionId`、可选 `turn` | 一个 turn 或整个会话的 turn |
| `recall_facets` | — | 带计数的 agent 和项目 |
| `recall_handoff` | `sessionId`、可选 `targetAgent` | Markdown 交接卡；带 `targetAgent` 时包含该 agent 的恢复或新会话命令 |
| `recall_scan` | — | 刷新索引，返回统计 |

设计规则：默认紧凑、截断回答、总是附带 `deepLink`、包含 `indexAgeMs`、保持总 payload 小。

## 深链（“同时使用两者”的粘合剂）

应用已经注册 `sessionrecall://` scheme。MCP 命中带 `sessionrecall://session/<id>`（可选 `?turn=<n>`）。流程：

- agent 找到 → 人点击链接 → 应用打开到该 turn 验证或继续。
- 人在应用里找到 → 导出交接 → 粘到新的 agent 会话。

## 风险

- **并发扫描**——扫描锁是必须的。
- **Schema 偏移**——旧 MCP 对着新索引必须给出清晰的 schema 版本错误，而不是损坏数据。
- **Payload 膨胀**——默认紧凑；绝不 dump 整个会话。
- **暴露面**——MCP 只走本地 stdio。绝不要通过网络端口暴露会话内容。

## 落地顺序

1. Recall 核心 + 共享扫描锁 + 过期扫描 helper。
2. `src/mcp.ts` stdio server（`recall_search` / `recall_session` / `recall_facets` / `recall_handoff`），只读、深链、`indexAgeMs`。
3. 应用：深链已存在；可选的“最近回忆”本地面板。
4. 然后做适配器（Claude Code、Codex）——纯增量，独立于 MCP。
