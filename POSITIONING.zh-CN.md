# 定位与路线图

[English](POSITIONING.md) | [简体中文](POSITIONING.zh-CN.md)

## 一句话

**面向 coding agent 的本地跨 agent 记忆层。你搜它，你的 agent 也能搜它。**

## 它到底是什么

不是又一个会话浏览器。价值是组合：

1. **一个跨 agent 的索引。** omp、pi、OpenCode、Cursor、Alma 和 Cindy 的会话都落到同一个 turn 级索引里。每个 agent 只能搜自己的历史；几乎没人能跨所有 agent 搜。
2. **本地、只读、离线。** 没有网络、没有 telemetry、没有账号。Agent 存储以只读方式打开；索引在 `~/Library/Application Support/session-recall` 下。这是云历史工具复制不了的隐私护城河。
3. **中文 + 英文都搜得动。** Trigram FTS 加短 CJK 查询的 LIKE 回退。多数同类工具英文优先，CJK 分词很差。
4. **问答对，不是文件或 token 总量。** 问题是“我在哪里解决过这个？”，所以结果是提问和紧随其后的回答——不是文件列表或用量图表。

## 它击中的痛点

| 痛点 | 这个工具如何回答 |
| --- | --- |
| 历史按 agent 孤岛化——没法跨工具找“我上周在哪里修过这个” | 所有适配器之上一个 turn 级索引 |
| 云历史工具要求上传提问 | 本地、只读、零网络 |
| 英文中心搜索，CJK 处理差 | 为中文调过的 Trigram FTS + LIKE 回退 |
| Agent 历史是死数据——没人再打开的被动词 UI | 作为 agent 可调用的工具暴露（路线图 A） |
| 用量仪表盘衡量成本，不是回忆 | 结果是带答案的问答对 |

## 差异化，按优先级

楔子是 **A + B**：让历史*被 agent* 查询，并覆盖人们真正在用的 agent。

## 路线图

按杠杆排序。工作量是粗略相对估计。

| # | 方向 | 内容 | 价值 | 工作量 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **A** | Agent 可访问的回忆（CLI / MCP） | `sr "query"` CLI 和 MCP server，让 Claude Code / omp / Codex 自己搜过去会话 | ★★★★★ | M | **已发布**——`sr` CLI（USAGE.md）和 stdio MCP server（MCP.md） |
| **B** | 适配器：Claude Code、Codex | 开源最大的覆盖面缺口 | ★★★★★ | M | **已发布**——八个适配器，见 README 的“索引哪些内容” |
| **C** | 语义 / 混合搜索 | 可选本地 embedding，让模糊说法（“那个 websocket 重连修复”）也能匹配 | ★★★★ | H | 未开始 |
| **D** | 跨 agent 交接 | 把会话打包成可移植卡片，在另一个 agent 继续 | ★★★★ | M | **已发布**——交接卡加 `sessionrecall://` 恢复链接 |
| **E** | 全局启动器 | 打包应用之上的 Cmd+K 面板 / 菜单栏快速搜索 | ★★★ | L | 未开始（Cmd+K 只聚焦应用内搜索） |
| **F** | 时间线 / 主题视图 | “我这周做了什么”，按主题而不是项目分组 | ★★ | M | 部分——日报/周报覆盖这个问题，没有时间线视图 |

### A —— 近期楔子

已发布。`bun run sr "query"` 返回带 session id、agent、项目、日期的顶部问答对（`--json`、`--agent`、`--limit`、role/scope），`session-recall mcp` 通过 stdio 暴露同样的搜索，让 agent 查以前是怎么解决的。两者都复用 `src/search.ts`，都不修改索引或适配器。

## 开源准备度

状态截至 2026-11-13。已完成：

- **LICENSE**——MIT。
- **分发**——带 tag 的 release workflow 构建两个单架构 macOS `.app`（一个 Apple silicon，一个 Intel），各自打 zip 并附 SHA-256 checksum，四个文件都挂到 GitHub Release。ad-hoc 签名，未公证（release notes 里已说明）。
- **CI**——每次 push 和 pull request 跑 `bun test` 和 `bun run build`。
- **README**——截图由合成会话生成，并且有支持 agent 的“索引哪些内容”表。

仍待完成：

- brew tap（或单文件二进制），让安装不必先解压。
- 记录适配器接口，让新 agent 容易贡献。

## 风险 / 诚实限制

- **适配器维护**是长期成本——每个 agent 都会改磁盘格式。记录接口并欢迎 PR。
- **Bun 依赖**缩小受众；至少提供预构建二进制。
- **“又一个历史浏览器”**是失败模式。没有 A（agent 能查询它），它很容易被每个 agent 自带的历史功能淹没。
