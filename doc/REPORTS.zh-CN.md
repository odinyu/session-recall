# 报告：日报与周报

[English](REPORTS.md) | [简体中文](REPORTS.zh-CN.md)

`brief` 如何把一天或一周的 agent 会话变成人能在 30 秒内读完（日报）或一页读完（周报）的内容。

## 当前 brief 的问题

今天的 `brief` 是一份**档案 dump**：它列出每个会话的原始提问。那是记录，不是报告。报告应该提炼、可扫读，只在需要细节时链接回原始会话。

## 原则

1. **提炼，不罗列。** 每个会话一行结论；原始提问留在 `archive` 视图。
2. **机器可读。** YAML front-matter，让周报能聚合日报，也让工具能消费任一格式。
3. **可跳转。** 每行都能带 `sessionrecall://` 深链；报告本身保持轻。
4. **确定性优先。** 默认生成不调用模型。`--summarize` flag 可以在之后把确定性草稿交给 agent，草稿始终可恢复。

## 视图

一个数据集，三种视图，用 `--format` 选择：

| 视图 | 用途 | 大小 |
| --- | --- | --- |
| `standup` | 日报默认；站会 / 自审 | 半屏 |
| `archive` | 当前完整 dump；取证 | 无上限 |
| `week` | 周报汇总 | 一页 |

应用达到同样的视图：左侧栏 footer 的 日报 / 周报 开关加日历，选择一天并就地生成。周报在 `#/brief/<week>?format=week` 打开，下载链接是 `/api/brief/file?format=week&week=<week>`。

## 日报（`--format standup`）

```markdown
---
kind: daily
date: 2026-03-12
projects: 3
sessions: 5
turns: 22
agents: [cursor, omp, pi, claude-code]
generated_at: 2026-03-12T19:30:00+08:00
---

# 日报 · 2026-03-12 周四

**一句话**：给 demo-app 加上离线缓存，修好 api-service 的分页边界。

## 进展
**demo-app**
- 离线缓存接入 IndexedDB，断网回放通过
- 缓存失效策略补了单元测试

**api-service**
- 修复 `page=0` 被当成第一页的边界错误；已提交

**web-client**
- 搜索结果空态补了骨架屏

## 决策
- 缓存只保留最近 7 天；更早的数据回源，避免无限增长

## 待续
- [ ] demo-app 缓存清理的定时任务
- [ ] api-service 分页游标迁移

## 明天第一件事
补缓存清理定时任务

## 概览
| 项目 | 会话 | 问答 | Agent |
| --- | ---: | ---: | --- |
| demo-app | 2 | 9 | omp、pi |
| api-service | 2 | 8 | claude-code |
| web-client | 1 | 5 | cursor |
```

刻意保留四个可移动部分：**进展 / 决策 / 待续 / 明天第一件事**。原始提问列表不在这里；它属于 `archive`。

## 周报（`--format week`，`--week 2026-W11`）

```markdown
---
kind: weekly
week: 2026-W11
range: 2026-03-09..2026-03-15
active_days: 4
projects: 4
sessions: 17
turns: 96
agents: [cursor, omp, pi, alma, opencode, claude-code]
---

# 周报 · 2026-W11（03-09 ~ 03-15）

**本周一句话**：把 demo-app 的离线能力从原型推进到可回放，api-service 的分页问题收尾。

## 亮点
- demo-app 离线缓存与断网回放测试落地
- api-service 分页边界修复并补了回归用例

## 按项目
**demo-app**
- 完成：缓存读写、失效策略、回放测试
- 进行中：多端同步冲突处理
- 下周：缓存压测

**api-service**
- 完成：分页边界修复
- 下周：游标分页迁移

**web-client**
- 完成：搜索空态与错误态
- 进行中：长列表虚拟滚动

## 主题与决策
- 优先保证离线可用，再评估同步冲突的自动合并策略

## 指标
| 日期 | 会话 | 问答 | 活跃项目 |
| --- | ---: | ---: | ---: |
| 03-09 | 3 | 18 | 2 |
| 03-10 | 5 | 27 | 3 |
| 03-11 | 4 | 22 | 2 |
| 03-12 | 5 | 29 | 3 |

（可选一行活跃度 sparkline：`▁▃█▅`）

## 风险 / 阻塞
- 离线缓存与多端同步的冲突策略还没定

## 下周计划
- [ ] 补缓存冲突的端到端测试
```

## 指标

保留四个：**会话数、turn 数、活跃项目、agent 构成**。工具/thinking 计数属于 `archive`，不属于周报。

## 聚合规则

- 周报**按日期范围从 DB 聚合**，不是拼接日报文件，所以没有生成日报的日子也会计入。
- 跨多天的会话只计**一次**，算在最后活跃日；周报里按项目分组。
- `active_days` = 至少有一个会话的天数。

## 推导 决策 / 待续（难的部分）

模型判断“这是不是一个决策？”噪声很大。先从确定性开始：

- **待续**：从每个会话的**最后一条助手消息**收集未勾选的 `- [ ]` 项和包含 待办 / 下一步 / TODO 的行，去重。
- **决策**：只收集标了 `<!-- decision: … -->` 的行（显式），否则省略。
- 允许用户编辑生成的文件；读取时绝不重新推导。

不要把 LLM summarizer 作为默认。`--summarize` 是 opt-in，并且必须保留确定性草稿可恢复。

## CLI

```
brief                          # today, --format standup
brief 2026-03-12               # a day
brief --format archive        # the full dump (today's behaviour)
brief --week 2026-W11         # weekly rollup
brief --summarize             # optional: polish the draft, keep the original
```

## 文件

```
brief/
  daily/2026-03-12.md
  weekly/2026-W11.md
  index.md            # last N daily + weekly entries
```

## 非目标

- 不做跨机器聚合，不做云同步。
- 默认路径不做自动“这是一个决策”的分类。
- 在 `--format` 接线前，不改变现有的单文件 `<date>.md` 输出，保证现有消费者继续工作。
