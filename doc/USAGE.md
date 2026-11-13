# CLI usage

[English](USAGE.md) | [Chinese](USAGE.zh-CN.md)

Search the local session index from a shell, a script, or an agent with shell
access. No server is required — the CLI opens the same `index.db` the UI uses.

This is the command-line form of roadmap item **A** in
[POSITIONING.md](POSITIONING.md): let a person *or an agent* look up how
something was solved before.

## Before you start

The index must exist. Build it once (and re-run whenever sessions change — the
`serve`/app refreshes every 90 s, the CLI never scans on its own):

```bash
bun run scan
```

Index location: `~/Library/Application Support/session-recall/index.db`.
Override it with `SESSION_RECALL_DB=/path/to/index.db`.

## Quick start

```bash
bun run sr "websocket" --limit 3        # `sr` is an alias of the search subcommand
bun run sr "websocket" --agent omp --json
bun run sr "ENOENT" --scope process
```

`bun run sr …` is shorthand for `bun run src/cli.ts search …`; either works. In
the packaged app, the same logic is available through the sidecar binary as
`session-recall search …`.

## Options

| Option | Meaning |
| --- | --- |
| `<query>` | One or more bare terms (ANDed), or `"an exact phrase"`. Omit → exit 2. |
| `--limit <n>` | Max **sessions** returned (not turns). 1–5000, default 10. |
| `--agent <id>` | Restrict to agents: `omp`, `pi`, `opencode`, `cursor`, `alma`, `cindy`, `claude-code`, `codex`. Repeatable or comma-separated (`--agent omp,pi`). |
| `--scope qa\|process` | `qa` (default) searches prompts and answers; `process` searches tool inputs, tool outputs, and extracted error lines. |
| `--json` | Machine-readable output (see below). |
| `-h`, `--help` | Print usage and exit 0. |
| `--` | End of options; everything after is part of the query. |

`--flag=value` and `--flag value` are both accepted.

## Text output

```
query "websocket" · 50 hit(s) in 3 session(s) · 14.6 ms · scope: qa · mode: fts

1. cindy:a3764542-066a-4e16-9a64-ce173d1b9325  [cindy]  2026-11-11
   ~/projects/example
   · Q  Where is the websocket reconnect implemented?
     A  Read `/Users/you/projects/example/README.md`; the reconnect logic is in `src/socket.ts`…
```

- One block per session; sessions sort by last activity (newest first), matching
  turns newest first within a session.
- Each hit prints the question and the answer that followed it, clipped. In
  `process` scope a hit prints the tool name, status, and the matched fragment.
- Project paths under `$HOME` are shown as `~/…`.

## JSON output

```json
{
  "query": "frontmatter",
  "scope": "qa",
  "mode": "fts",
  "limit": 1,
  "agents": [],
  "tookMs": 27.2,
  "totalTurns": 5,
  "totalSessions": 5,
  "returned": 1,
  "results": [
    {
      "sessionId": "omp:2026-11-11T07-24-53-192Z_01a1c97e-…",
      "agent": "omp",
      "project": "/Users/you/projects/example",
      "date": "2026-11-11",
      "updatedAt": 1794384516436,
      "title": "📰 ART: Investigate inconsistent article display in app",
      "hits": [
        {
          "turnIdx": 1,
          "ts": 1794383882500,
          "date": "2026-11-11",
          "matchField": "assistant",
          "snippet": "Done. The editor now collapses the document's leading `---…---` into a separate `FrontMatter` block…",
          "question": "Re \"should we add front-matter parsing support to the editor…\": yes",
          "answer": "Done. The editor now collapses the document's leading `---…---` …",
          "tool": "",
          "status": ""
        }
      ]
    }
  ]
}
```

Top-level fields: `query`, `scope`, `mode` (`fts` / `like`), `limit`, `agents`,
`tookMs`, `totalTurns`, `totalSessions`, `returned`, `results[]`.

Per result: `sessionId`, `agent`, `project`, `date`, `updatedAt` (epoch ms),
`title`, `hits[]`. Each hit: `turnIdx`, `ts`, `date`, `matchField`
(`user`/`assistant`/`tool`/`input`/`error`), `snippet`, `question`, `answer`,
`tool`, `status`. In `qa` scope `tool`/`status` are empty; in `process` scope
`question`/`answer` are empty.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Results printed, **or** a valid query with no matches. |
| `1` | Index missing or unreadable (`index not found: …`). |
| `2` | Invalid arguments (missing query, bad `--limit`/`--agent`/`--scope`, unknown option). |

## Recipes

```bash
# newest places a phrase shows up
bun run sr "directory scope" --limit 5

# only search one agent, as JSON, then keep just session ids
bun run sr "websocket" --agent omp --json | jq -r '.results[].sessionId'

# find where a command/tool ran or a path appeared (not in prompts)
bun run sr "ENOENT" --scope process --limit 20

# error lines from a specific project's recent work
bun run sr "Cannot find module" --scope process --json \
  | jq '.results[] | select(.project|contains("example"))'

# feed the top answer into a new prompt
bun run sr "setext heading" --json --limit 1 | jq -r '.results[0].hits[0].answer'
```

## Using it from an agent

An agent with shell access can call the CLI directly; `--json` gives it stable
fields. A minimal wrapper to hand an agent:

```bash
# recall "query" [--agent id] [--scope qa|process]
bun run sr "$@" --json --limit 5
```

Because `search` is read-only and offline, it is safe to let an agent call it:
it never scans, mutates the index, or touches an agent's own store. (`forget` /
`unforget`, below, are the only commands that write, so do not hand those to an
agent you would not trust with the index.)

## Reports

`brief` writes the daily standup, the legacy archive dump or a weekly rollup:

```bash
bun run src/cli.ts brief [YYYY-MM-DD] [--format standup|archive|week] [--week YYYY-Www] [--lang zh|en]
```

`--lang` picks the Chinese or English template, and the front matter records it
as `lang:`. Without it the CLI uses the stored language preference; `auto` means
Chinese.

## Forgetting a session

Removing a session from the index does not touch the original transcript:

```bash
bun run src/cli.ts forget omp:2026-11-10T01-13-16-427Z_01a1c304
bun run src/cli.ts unforget omp:2026-11-10T01-13-16-427Z_01a1c304
```

The id is the `<agent>:<id>` form that search output and the JSON fields use.
`forget` deletes the session's rows and FTS entries, rebuilds and compacts the
index, and records the id in `forgotten_session` so every later scan keeps
skipping it. `unforget` clears that mark; the next scan indexes the session
again. Both take the shared scan lock and refuse to run while a scan is in
progress.

Generated briefs are plain Markdown and are never rewritten, so `forget` lists
the files that still mention the session — regenerate or delete them yourself.
In the app the same action is a “Forget this session” button on the session
page, with “Undo” offered in the status line.

## Notes and limits

- **Read-only search.** `search` only calls `searchTurns` from `src/search.ts`;
  it never scans, writes the index, or opens an agent's store for writing.
- **Chinese content.** Chinese prompts, answers and queries are indexed and
  searchable like any other text; the examples in this doc are English for
  readability.
- **Short / CJK queries.** A query under three characters (e.g. a two-character
  Chinese word) falls back to indexed `LIKE` with the same filters; `mode`
  reports `like`.
- **Index is a snapshot** of the last `bun run scan` (or the last 90 s refresh
  when `serve`/the app is running). Run `bun run scan` if a very recent session
  is missing.
- **Session-level limit.** `--limit` counts sessions, not hits; each session can
  contain several matching turns.
- **No filtering by project/date yet.** The CLI exposes `--agent` and `--scope`;
  project and date filters exist in the HTTP API and UI but not on the command
  line.
