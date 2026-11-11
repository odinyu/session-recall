# Reports: daily and weekly

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

## Daily (`--format standup`)

```markdown
---
kind: daily
date: 2026-11-11
projects: 6
sessions: 8
turns: 36
agents: [cindy, omp, alma, opencode]
generated_at: 2026-11-11T19:30:00+08:00
---

# 日报 · 2026-11-11 周二

**一句话**：给 session-recall 加了 MCP server 与跨进程扫描锁，修好 blog-desk 的 front-matter 高亮。

## 进展
**session-recall**
- 新增 stdio MCP server（5 工具）+ 扫描锁；测试 59→80
- CLI `search`/`sr` 与 USAGE.md 已提交推送

**blog-desk**
- 修 front-matter 被当成 setext 标题；已提交推送

## 决策
- App 与 MCP 共用同一 index.db：App 长驻写、MCP 只读，扫描靠文件锁互斥

## 待续
- [ ] 深链 `?turn` 定位（web + Rust 路由）
- [ ] Claude Code / Codex 适配器

## 明天第一件事
补深链 turn 定位

## 概览
| 项目 | 会话 | 问答 | Agent |
| --- | ---: | ---: | --- |
| session-recall | 2 | 11 | omp、Alma |
```

Deliberately four movable parts: **进展 / 决策 / 待续 / 明天第一件事**. The raw
prompt list is not here; it belongs to `archive`.

## Weekly (`--format week`, `--week 2026-W46`)

```markdown
---
kind: weekly
week: 2026-W46
range: 2026-11-09..2026-11-15
active_days: 4
projects: 8
sessions: 23
turns: 210
agents: [cindy, omp, alma, opencode, cursor]
---

# 周报 · 2026-W46（11-09 ~ 11-15）

**本周一句话**：把 session-recall 从「跨 agent 检索」推进到「agent 可直接调用的记忆层」。

## 亮点
- MCP server + 扫描锁落地，App/CLI/MCP 可并发
- 新增 Claude Code / Codex 两个数据源

## 按项目
**session-recall**
- 完成：MCP、跨进程锁、CLI、文档
- 进行中：深链 turn 定位、跨 agent 接力
- 下周：语义检索评估

## 主题与决策
- 定位收敛为「本地、跨 agent 的记忆层」；详见 POSITIONING.md

## 指标
| 日期 | 会话 | 问答 | 活跃项目 |
| --- | ---: | ---: | ---: |
| 11-09 | 3 | 28 | 2 |
| 11-10 | 6 | 41 | 4 |
| 11-11 | 8 | 36 | 6 |

（可选一行活跃度 sparkline：`▁▃█▅`）

## 风险 / 阻塞
- 适配器随 agent 格式变化会漂移

## 下周计划
- [ ] 补 `?turn` 深链定位
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
brief 2026-11-11               # a day
brief --format archive        # the full dump (today's behaviour)
brief --week 2026-W46         # weekly rollup
brief --summarize             # optional: polish the draft, keep the original
```

## Files

```
brief/
  daily/2026-11-11.md
  weekly/2026-W46.md
  index.md            # last N daily + weekly entries
```

## Non-goals

- No cross-machine aggregation, no cloud sync.
- No automatic "this was a decision" classification in the default path.
- No change to the existing single-file `<date>.md` output until `--format` is
  wired, so current consumers keep working.
