# Positioning & Roadmap

## One line

**A local, cross-agent memory layer for coding agents. You search it; your agents can too.**

## What it actually is

Not another session browser. The value is the combination:

1. **One index across agents.** omp, OpenCode, Cursor, Alma, and Cindy sessions
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

| # | Direction | What | Value | Effort |
| --- | --- | --- | --- | --- |
| **A** | Agent-accessible recall (CLI / MCP) | `sr "query"` CLI and an MCP server so Claude Code / omp / Codex can search past sessions themselves | ★★★★★ | M |
| **B** | Adapters: Claude Code, Codex | Currently deferred for lack of local data to verify. Biggest reach gap for open source | ★★★★★ | M |
| **C** | Semantic / hybrid search | Optional local embeddings so fuzzy phrasing ("that websocket reconnect fix") matches | ★★★★ | H |
| **D** | Cross-agent handoff | Package a session into a portable card and continue it in another agent (handoff already exists as a card) | ★★★★ | M |
| **E** | Global launcher | Cmd+K palette / menu-bar quick search on top of the packaged app | ★★★ | L |
| **F** | Timeline / topic views | "What did I do this week", grouped by topic rather than project | ★★ | M |

### A — the near-term wedge

Ship the **CLI** first (`sr "query"` → top question/answer pairs with session id,
agent, project, date; `--json`, `--agent`, `--limit`, role/scope). It is cheap,
works in shells and scripts, and is the fastest way to test whether agents will
actually query history. Add the MCP server once demand is shown. The CLI must
reuse the existing search layer (`src/search.ts`) and must not mutate the index
or adapters.

## Open-source readiness

Required before promotion:

- **Add a LICENSE.** The repo currently has none; without one it is not
  open-source in practice.
- Distribution: brew tap and/or a single-file GitHub Release binary.
- README: real screenshots and a 30-second demo; add a "supported agents" table.
- Document the adapter interface so new agents are easy to contribute.

## Risks / honest limits

- **Adapter maintenance** is the long-term cost — every agent changes its
  on-disk format. Document the interface and invite PRs.
- **Bun dependency** narrows the audience; at minimum provide a prebuilt binary.
- **"Just another history browser"** is the failure mode. Without A (agents can
  query it), it is easily dwarfed by each agent's built-in history.
