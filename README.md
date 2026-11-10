# session recall

A local, read-only full-text index over the coding-agent sessions on this Mac.
Search a half-remembered Chinese phrase or a code identifier and get back the
question, the answer, the agent, the project, and the date.

Built for the sessions that pile up across **omp**, **OpenCode**, and **Cursor**.
It never writes to an agent's own storage.

## Quick start

Requires macOS and Bun 1.3+.

```bash
git clone https://github.com/odinyu/session-recall.git
cd session-recall
bun run scan      # build the index (first run: a few seconds)
bun run start     # build the UI and serve http://127.0.0.1:4319
```

`bun run start` also scans on boot and refreshes the index every 90 seconds.
The rail footer switches the theme between Auto (follows macOS), Light, and
Dark; the choice is saved in `localStorage`.

## What gets indexed

| Agent | Source | Extract |
|---|---|---|
| omp | `~/.omp/agent/sessions/<cwd>/*.jsonl` (plus profile roots) | user/assistant text messages; titles |
| OpenCode | `~/.local/share/opencode/opencode.db` | `session_v2` + `session_message` (falls back to the v1 `session`/`message`/`part` tables) |
| Cursor | `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` and `state.vscdb` (`composerData` + `bubbleId`) | transcripts first, KV for chats without a transcript; project path from `workspaceIdentifier` |

The index unit is a **turn**: one user prompt plus the assistant text that
followed it before the next prompt. Tool calls and reasoning traces are stored
separately as process events (see below), not in the search index; binary
content is skipped.

## Process

When a turn has tool calls or reasoning, its transcript row shows a `过程`
disclosure. Opening it lazily loads that turn's events; each reasoning block and
tool call is its own collapsed row, and tool inputs/outputs are displayed as
plain text.

- Events live in the `event` table keyed by `(session_id, turn_idx, seq)`.
- Limits keep the index bounded: 30 events per turn, 1,200 per session;
  reasoning is capped at 2,000 characters, tool input at 1,000, and tool output
  at 2,000. Long values keep a head and a tail and are marked truncated.
- omp attaches `toolResult` messages to their `toolCall` by id; OpenCode reads
  the tool state's `input`/`output`; Cursor transcripts expose tool calls but
  usually not their results.
- API: `GET /api/session/:id/events?turn=N` returns `{ turn, events }`.

## Resume

omp and OpenCode session pages show a copyable continue command in the header:

```bash
cd '/path/to/project' && omp --resume <session-uuid>
cd '/path/to/project' && opencode --session <session-id>
```

The path is shell-quoted; the omp uuid is the suffix after the timestamp in the
stored session filename. Cursor has no equivalent local resume command, so its
pages omit the block.

## Search

- SQLite FTS5, two indexes over the same turns:
  - `trigram` for Chinese phrases and substring/code-identifier matching.
  - `porter` stemming as an English fallback.
- A query shorter than three characters (for example a two-character Chinese
  word) falls back to indexed `LIKE` with the same filters.
- Filters: agent, project, date range, and role (prompt / answer / both).
- Results group by session, showing the best matching turns with context.
- Query syntax: bare terms, or `"an exact phrase"`; multi-term queries are ANDed.

## Index and privacy

- Index: `~/Library/Application Support/session-recall/index.db` (SQLite WAL).
- Everything runs on `127.0.0.1`; there are no network calls, accounts, or
  telemetry.
- Agent databases are opened with `readonly: true` and a busy timeout. Nothing
  in the source folders is modified or copied.
- Override the index location with `SESSION_RECALL_DB=/path/to/index.db` and the
  port with `SESSION_RECALL_PORT=4319`.

## Project layout

```text
src/
  adapters/       omp, OpenCode, Cursor parsers
  db.ts           schema, FTS triggers, upserts
  scan.ts         incremental scan orchestration
  search.ts       query building, ranking, facets
  server.ts       Bun.serve API + static UI
web/
  app.ts          hash-routed UI
  markdown.ts     safe Markdown renderer
  styles.css      design tokens and components
scripts/build.ts  Bun.build bundle
test/             markdown and search tests
```

## Development

```bash
bun test          # 13 tests: markdown, search, process event storage/caps
bun run build     # bundle web/app.ts -> web/dist
```

No runtime dependencies. `bun:sqlite` provides FTS5 with both tokenizers.

## Known limits

- **Cursor tool results**: transcript files contain `tool_use` calls but usually
  no `tool_result` blocks, so Cursor process rows show the call and input
  without output.
- **WorkBuddy**: its local SQLite stores session metadata only; transcripts are
  cloud-side, so it is not indexed yet.
- **Claude Code / Codex**: adapters are planned but there was no local data on
  this machine to verify them.
- **Cursor timestamps**: project transcripts carry no top-level timestamps, so
  their activity date falls back to the file modification time.
- **Unresolved Cursor projects**: a chat whose project no longer exists on disk
  is indexed without a project path.
- **Archived chats** are included; there is no archive filter yet.
