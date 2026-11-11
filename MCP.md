# MCP integration

How the **app** and an **MCP server** coexist over one local index.

## Principle

One index. One writer. Many readers. The app and MCP are two front-ends over the
same core, not two systems that sync.

- **App** = long-lived, human-facing: browses, reads full sessions, expands
  process, exports handoff, daily brief.
- **MCP** = short-lived (spawned by the agent client), agent-facing: compact,
  low-latency recall mid-task.
- Both call the same `searchTurns` / session-detail / facets / handoff code.

The shared index is `~/Library/Application Support/session-recall/index.db`
(SQLite WAL): multiple readers + one writer. `SESSION_RECALL_DB` overrides it.

## Scenarios

| | App (human) | MCP (agent) |
| --- | --- | --- |
| Trigger | user opens it | task mid-flight |
| Goal | deep dive: full session, multi-turn, compare | instant recall: was this solved before |
| Output | large | compact: rank + Q/A + session id + deep link |
| Latency | seconds ok | sub-100ms preferred |
| Typical | filter, switch topic, export handoff, brief | `recall_search` then maybe `recall_session` |

Agent context is expensive: **MCP is compact by default**, deep dive via
`recall_session` or the app.

## Writer / reader model

- The app sidecar is the long-lived writer (it already rescans every 90 s).
- MCP and the CLI are **read-only** readers that open the DB directly. MCP must
  work with the app closed — it does not depend on the app's random port.
- A **shared scan lock** (a lock file next to the index, e.g.
  `index.db.scan.lock`) ensures only one process scans at a time. App, CLI and
  MCP all take it before writing.
- Scan-on-stale: a reader may check "last scan time vs newest session mtime" and,
  if stale, rescan **while holding the lock**; others read the current index.
  Never scan synchronously on every query.

## Freshness

- Every result carries `indexAgeMs` (now − last successful scan) so the agent can
  judge whether it might be missing the last few minutes.
- `recall_scan` triggers an explicit refresh and returns scan stats.

## MCP tool surface (deliberately small)

MCP server: `session-recall mcp` over **stdio**, read-only, no network.

| Tool | Input | Output |
| --- | --- | --- |
| `recall_search` | `query`, optional `agent`, `scope` (`qa`/`process`), `project`, `from`, `to`, `limit` (default 5) | compact results: `sessionId`, `agent`, `project`, `date`, `title`, `question`, `answer` (clipped), `deepLink`, `indexAgeMs`, `totalSessions` |
| `recall_session` | `sessionId`, optional `turn` | one turn or the whole session's turns |
| `recall_facets` | — | agents and projects with counts |
| `recall_handoff` | `sessionId` | Markdown handoff card |
| `recall_scan` | — | refresh the index, return stats |

Design rules: default compact, clip answers, always attach a `deepLink`, include
`indexAgeMs`, and keep total payload small.

## Deep links (the glue for "use both")

The app already registers the `sessionrecall://` scheme. MCP hits carry
`sessionrecall://session/<id>` (optionally `?turn=<n>`). Flow:

- agent finds → human clicks the link → app opens at that turn to verify or
  continue.
- human finds in the app → export handoff → paste into a new agent session.

## Risks

- **Concurrent scans** — the scan lock is mandatory.
- **Schema skew** — an old MCP against a newer index must fail with a clear
  schema-version error, not corrupt data.
- **Payload bloat** — compact by default; never dump whole sessions.
- **Exposure** — MCP is local stdio only. Never expose session content over a
  network port.

## Rollout

1. Recall core + shared scan lock + stale-scan helper.
2. `src/mcp.ts` stdio server (`recall_search` / `recall_session` / `recall_facets`
   / `recall_handoff`), read-only, deep links, `indexAgeMs`.
3. App: deep link already exists; optional "recent recalls" local panel.
4. Then adapters (Claude Code, Codex) — pure increment, independent of MCP.
