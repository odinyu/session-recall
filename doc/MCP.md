# MCP integration

[English](MCP.md) | [Chinese](MCP.zh-CN.md)

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
- MCP is a **read-only** reader and has no write tools; the CLI's `search` is
  read-only too. `forget` / `unforget` are the only CLI commands that change the
  index, and they take the shared scan lock. Both open the DB directly, so they
  work with the app closed — neither depends on the app's random port.
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

## Connecting a client

`setup` writes the `session-recall` entry into the MCP config of every agent
found on this machine, and `doctor` checks the result - including a real
`initialize` + `tools/list` handshake, so "configured" means the server
actually answered.

```bash
sr="/Applications/Session Recall.app/Contents/MacOS/session-recall"
"$sr" setup --dry-run   # show the plan, write nothing
"$sr" setup             # confirm, then write (a backup lands next to each file)
"$sr" doctor            # self-check; every non-ok line carries a fix
```

Two channels, because one is not enough:

- **MCP** - writes the `session-recall` entry into each client config. Gives
  the agent structured tools.
- **Skill** - writes one `SKILL.md` into every agent skill folder found
  (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`,
  `~/.cursor/skills`, `~/.config/opencode/skills`). Same bytes everywhere, so
  there is no per-client schema to maintain, and it reaches clients we cannot
  write an MCP entry for at all. `--no-skill` installs MCP only; `--no-mcp`
  installs the skill only.

A managed skill copy carries `.session-recall.json` beside it. A `SKILL.md`
without that marker is treated as the user's own and is never overwritten.

What the command guarantees:

- **Config files only.** Agent transcripts are never opened for writing; the
  read-only promise covers setup too.
- **Verified shapes only.** Cursor, Alma, Claude Code, Gemini CLI, Qwen Code
  and OpenCode are written automatically. Codex is TOML and could not be
  confirmed from a live file, so it gets a paste-ready snippet instead of a
  guess.
- **Reversible.** Every write copies the file to
  `<file>.session-recall.bak-<timestamp>` first and renames atomically. A file
  that is not valid JSON is reported and left byte-identical. `setup --remove`
  takes only our entry out and leaves every other server in place.

Writing it by hand stays possible: `mcpServers` -> `session-recall` ->
`{ "command": "<binary>", "args": ["mcp"] }` for every client above.
OpenCode nests one level deeper, under `mcp.servers`, with `"type": "local"`
and a single `command` array.

## MCP tool surface (deliberately small)

MCP server: `session-recall mcp` over **stdio**, read-only, no network.

| Tool | Input | Output |
| --- | --- | --- |
| `recall_search` | `query`, optional `agent`, `scope` (`qa`/`process`), `project`, `from`, `to`, `limit` (default 5) | compact results: `sessionId`, `agent`, `project`, `date`, `title`, `question`, `answer` (clipped), `deepLink`, `indexAgeMs`, `totalSessions` |
| `recall_session` | `sessionId`, optional `turn` | one turn or the whole session's turns |
| `recall_facets` | — | agents and projects with counts |
| `recall_handoff` | `sessionId`, optional `targetAgent` | Markdown handoff card; with `targetAgent`, the card carries that agent's resume or new-session command |
| `recall_scan` | — | refresh the index, return stats |
| `recall_saved_searches` | — | the bookmarked searches (name, query, filters) |
| `recall_brief` | `format` (`standup`/`archive`/`week`/`month`), optional `date`/`week`/`month` | Markdown of a report that was already generated |

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
