# Reports: daily and weekly

[English](REPORTS.md) | [简体中文](REPORTS.zh-CN.md)

How `brief` should turn a day or week of agent sessions into something a person
can read in 30 seconds (daily) or one page (weekly).

## The problem with the current brief

Today's `brief` is an **archive dump**: it lists every session's raw prompts. It
is a record, not a report. A report should be distilled, skimmable, and link
back to the raw sessions only when you need detail.

## Principles

1. **Distill, don't list.** One line of conclusion per session; raw prompts stay
   in the `archive` view.
2. **Machine-readable.** A YAML front-matter block so a weekly report can
   aggregate daily ones and tools can consume either.
3. **Jumpable.** Every line can carry a `sessionrecall://` deep link; the report
   itself stays thin.
4. **Deterministic first.** Default generation makes no model calls. A
   `--summarize` flag may hand the deterministic draft to an agent afterwards,
   and the draft is always recoverable.

## Views

One dataset, three views, selected with `--format`:

| View | Use | Size |
| --- | --- | --- |
| `standup` | daily default; standup / self-review | half a screen |
| `archive` | the current full dump; forensics | unbounded |
| `week` | weekly rollup | one page |

The app reaches the same views: the rail footer's 日报 / 周报 switch plus the
calendar pick a day and generate it in place. A weekly report opens at
`#/brief/<week>?format=week`, and its download link is
`/api/brief/file?format=week&week=<week>`.

## Daily (`--format standup`)

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

Deliberately four movable parts: **进展 / 决策 / 待续 / 明天第一件事**. The raw
prompt list is not here; it belongs to `archive`.

## Weekly (`--format week`, `--week 2026-W11`)

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

## Metrics

Keep four: **sessions, turns, active projects, agent mix**. Tool/thinking counts
belong in `archive`, not the weekly.

## Aggregation rules

- The weekly aggregates **from the DB by date range**, not by concatenating
  daily files, so a day with no brief still counts.
- A session spanning several days is counted **once**, attributed to its last
  activity day; in the weekly it is grouped by its project.
- `active_days` = days with at least one session.

## Deriving 决策 / 待续 (the hard part)

Model judgement of "was this a decision?" is noisy. Start deterministic:

- **待续**: collect unchecked `- [ ]` items and lines containing
  待办 / 下一步 / TODO from each session's **last assistant message**, dedupe.
- **决策**: collect lines marked `<!-- decision: … -->` (explicit), else omit.
- Allow the user to edit the generated file; never re-derive on read.

Do not ship an LLM summarizer as the default. `--summarize` is opt-in and must
keep the deterministic draft recoverable.

## CLI

```
brief                          # today, --format standup
brief 2026-03-12               # a day
brief --format archive        # the full dump (today's behaviour)
brief --week 2026-W11         # weekly rollup
brief --summarize             # optional: polish the draft, keep the original
```

## Files

```
brief/
  daily/2026-03-12.md
  weekly/2026-W11.md
  index.md            # last N daily + weekly entries
```

## Non-goals

- No cross-machine aggregation, no cloud sync.
- No automatic "this was a decision" classification in the default path.
- No change to the existing single-file `<date>.md` output until `--format` is
  wired, so current consumers keep working.
