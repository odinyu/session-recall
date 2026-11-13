# Positioning & Roadmap

[English](POSITIONING.md) | [Chinese](POSITIONING.zh-CN.md)

## One line

**A local, cross-agent memory layer for coding agents. You search it; your agents can too.**

## What it actually is

Not another session browser. The value is the combination:

1. **One index across agents.** omp, pi, OpenCode, Cursor, Alma, and Cindy sessions
   land in the same turn-level index. Each agent can only search its own
   history; almost nobody can search across all of them.
2. **Local, read-only, offline.** No network, no telemetry, no accounts. Agent
   stores are opened read-only; the index lives under
   `~/Library/Application Support/session-recall`. This is the privacy moat that
   cloud history tools cannot copy.
3. **Chinese + English retrieval that works.** Trigram FTS with a LIKE fallback
   for short CJK queries. Most comparable tools are English-first and tokenize
   CJK poorly.
4. **Question/answer pairs, not files or token totals.** The question is
   "where did I solve this?", so results are the prompt and the answer that
   followed it — not a file list or a usage chart.

## Pain points it hits

| Pain | How this tool answers it |
| --- | --- |
| History is siloed per agent — no way to find "where did I fix this last week" across tools | One turn-level index over every adapter |
| Cloud history tools require uploading prompts | Local-only, read-only, zero network |
| English-centric search, poor CJK handling | Trigram FTS + LIKE fallback tuned for Chinese |
| Agent history is dead data — a passive UI nobody reopens | Expose it to agents as a tool they can call (roadmap A) |
| Usage dashboards measure cost, not recall | Results are answer-bearing question/answer pairs |

## Differentiation, ranked

The wedge is **A + B**: make history queryable *by agents*, and cover the agents
people actually use.

## Roadmap

Ordered by leverage. Effort is a rough relative estimate.

| # | Direction | What | Value | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| **A** | Agent-accessible recall (CLI / MCP) | `sr "query"` CLI and an MCP server so Claude Code / omp / Codex can search past sessions themselves | ★★★★★ | M | **shipped** — `sr` CLI (USAGE.md) and a stdio MCP server (MCP.md) |
| **B** | Adapters: Claude Code, Codex | Biggest reach gap for open source | ★★★★★ | M | **shipped** — thirteen adapters, see "What gets indexed" in the README |
| **C** | Semantic / hybrid search | Optional local embeddings so fuzzy phrasing ("that websocket reconnect fix") matches | ★★★★ | H | not started |
| **D** | Cross-agent handoff | Package a session into a portable card and continue it in another agent | ★★★★ | M | **shipped** — handoff card plus `sessionrecall://` resume links |
| **E** | Global launcher | Cmd+K palette / menu-bar quick search on top of the packaged app | ★★★ | L | not started (Cmd+K only focuses the in-app search) |
| **F** | Timeline / topic views | "What did I do this week", grouped by topic rather than project | ★★ | M | partial — daily/weekly reports cover the question, no timeline view |

### A — the near-term wedge

Shipped. `bun run sr "query"` returns top question/answer pairs with session id,
agent, project and date (`--json`, `--agent`, `--limit`, role/scope), and
`session-recall mcp` exposes the same search over stdio so an agent can look up
how something was solved before. Both reuse `src/search.ts` and neither mutates
the index or the adapters.

## Open-source readiness

State as of 2026-11-13. Done:

- **LICENSE** — MIT.
- **Distribution** — a tagged release workflow builds two single-architecture
  macOS `.app`s (one Apple silicon, one Intel), zips each with a SHA-256
  checksum, also publishes version-less aliases and their checksums for the
  landing page, and attaches all eight files to the GitHub Release. Ad-hoc
  signed, not notarized (documented in the release notes).
- **CI** — `bun test` and `bun run build` on every push and pull request.
- **README** — screenshots generated from synthetic sessions, plus the
  "What gets indexed" table of supported agents.

Still open:

- A brew tap (or a single-file binary) so installing does not mean unzipping.
- Documenting the adapter interface so new agents are easy to contribute.

## Risks / honest limits

- **Adapter maintenance** is the long-term cost — every agent changes its
  on-disk format. Document the interface and invite PRs.
- **Bun dependency** narrows the audience; at minimum provide a prebuilt binary.
- **"Just another history browser"** is the failure mode. Without A (agents can
  query it), it is easily dwarfed by each agent's built-in history.
