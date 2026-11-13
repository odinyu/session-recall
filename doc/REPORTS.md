# Reports: daily and weekly

[English](REPORTS.md) | [Chinese](REPORTS.zh-CN.md)

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

The app reaches the same views: the rail footer's Daily / Weekly switch plus
the calendar pick a day and generate it in place. A weekly report opens at
`#/brief/<week>?format=week`, and its download link is
`/api/brief/file?format=week&week=<week>`.

The template language follows the interface (Chinese or English), and the
front matter records it as `lang:`; `brief --lang zh|en` overrides the stored
preference, and when nothing decides it the report is Chinese. `brief/index.md` uses
language-neutral `## Daily` and `## Weekly` group headings.

## Daily (`--format standup`)

```markdown
---
kind: daily
lang: en
date: 2026-03-12
projects: 3
sessions: 5
turns: 22
agents: [cursor, omp, pi, claude-code]
generated_at: 2026-03-12T19:30:00+08:00
---

# Daily · Thu, Mar 12, 2026

**One line**: add offline caching to demo-app and fix the paging boundary in api-service.

## Progress
**demo-app**
- Offline cache wired into IndexedDB; offline replay passes
- Added unit tests for the cache invalidation strategy

**api-service**
- Fixed the `page=0` boundary bug that treated it as the first page; committed

**web-client**
- Added a skeleton screen to the empty search state

## Decisions
- Keep only the last 7 days of cache; older data is fetched from the source, so it cannot grow without bound

## Open threads
- [ ] Scheduled cache-cleanup job for demo-app
- [ ] Pagination cursor migration for api-service

## First task tomorrow
Add the scheduled cache-cleanup job

## Overview
| Project | Sessions | Turns | Agent |
| --- | ---: | ---: | --- |
| demo-app | 2 | 9 | omp, pi |
| api-service | 2 | 8 | claude-code |
| web-client | 1 | 5 | cursor |
```

Deliberately four movable parts: **Progress / Decisions / Open threads / First
task tomorrow**. The raw prompt list is not here; it belongs to `archive`.

## Weekly (`--format week`, `--week 2026-W11`)

```markdown
---
kind: weekly
lang: en
week: 2026-W11
range: 2026-03-09..2026-03-15
active_days: 4
projects: 4
sessions: 17
turns: 96
agents: [cursor, omp, pi, alma, opencode, claude-code]
---

# Weekly · 2026-W11 · 03/09–03/15

**Week in one line**: took demo-app's offline support from prototype to replayable, and wrapped up the paging issue in api-service.

## Highlights
- demo-app offline cache and offline-replay tests landed
- api-service paging boundary fixed, with regression cases added

## By project
**demo-app**
- Done: cache reads and writes, invalidation strategy, replay tests
- In progress: multi-device sync conflict handling
- Next week: cache load testing

**api-service**
- Done: paging boundary fix
- Next week: cursor-based pagination migration

**web-client**
- Done: search empty and error states
- In progress: long-list virtual scrolling

## Themes and decisions
- Prioritise offline availability first, then evaluate automatic merge of sync conflicts

## Metrics
| Date | Sessions | Turns | Active projects |
| --- | ---: | ---: | ---: |
| 03-09 | 3 | 18 | 2 |
| 03-10 | 5 | 27 | 3 |
| 03-11 | 4 | 22 | 2 |
| 03-12 | 5 | 29 | 3 |

(optional one-line activity sparkline: `▁▃█▅`)

## Risks
- The conflict strategy between the offline cache and multi-device sync is still undecided

## Next week
- [ ] End-to-end tests for cache conflicts
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

## Deriving Decisions / Open threads (the hard part)

Model judgement of "was this a decision?" is noisy. Start deterministic:

- **Open threads**: collect unchecked `- [ ]` items and lines containing
  `TODO` or one of the localized to-do / next-step markers the generator
  recognizes (see `src/brief.ts`) from each session's **last assistant
  message**; dedupe.
- **Decisions**: collect lines marked `<!-- decision: … -->` (explicit), else
  omit.
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
