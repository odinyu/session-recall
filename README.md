# session recall

A local, read-only full-text index over the coding-agent sessions on this Mac.
Search a half-remembered Chinese phrase or a code identifier and get back the
question, the answer, the agent, the project, and the date.

Built for the sessions that pile up across **omp**, **OpenCode**, **Cursor**,
**Alma**, and **Cindy**. It never writes to an agent's own storage.

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
Dark. The choice is stored by the server in `<app dir>/prefs.json` (see
`src/prefs.ts`) rather than in `localStorage`, so it survives the app restarting
on a different port; `localStorage` is only a same-origin cache for the first
paint. API: `GET /api/prefs`, and `PATCH /api/prefs` with `{"theme": …}` for
`auto`, `light` or `dark` — anything else is rejected with a 400.

## Packaged app

Build a double-clickable macOS `.app`:

```bash
bash scripts/make-app.sh
```

It builds the web UI, compiles the Bun CLI into a self-contained sidecar binary
(~63 MB, named for the host target triple), and lets Tauri bundle both:

```text
src-tauri/target/release/bundle/macos/Session Recall.app
```

The bundle is ad-hoc signed (`signingIdentity: "-"`); if you download or copy it
around, clear the quarantine flag first:

```bash
xattr -dr com.apple.quarantine "Session Recall.app"
```

**How it finds its parts.** Tauri ships the Bun CLI as an `externalBin` sidecar
at `Contents/MacOS/session-recall`, and the built web UI as a bundle resource at
`Contents/Resources/web/dist`. On launch the Rust shell
(`src-tauri/src/main.rs`):

1. reserves a free loopback port,
2. locates the sidecar — `$SESSION_RECALL_SIDECAR`, then any `session-recall*`
   file next to the main executable, then `src-tauri/binaries/` (for
   `cargo tauri dev`),
3. spawns it with `SESSION_RECALL_PORT` set to the reserved port and
   `SESSION_RECALL_WEB_DIST` pointing at the resource dir,
4. waits until the port accepts connections, then opens a `WKWebView` window on
   `http://127.0.0.1:<port>`,
5. answers `sessionrecall://` deep links (see below) by driving the UI's hash
   router, bringing the window forward if it was in the background,
6. kills the sidecar on quit, so no orphaned process is left behind.

The UI is served by Bun exactly as in `bun run serve`, so the app and the CLI
share one index at `~/Library/Application Support/session-recall/index.db` — and
so the window is purely a view over the same HTTP API. Web assets are shipped as
a bundle resource rather than embedded in the binary, so `bun run scan` still
works on a fresh clone that has no `web/dist`.

The icon lives at `src-tauri/app-icon.png`; regenerate the PNG with
`python3 scripts/make-icon.py` and the whole icon set with `cargo tauri icon`
from `src-tauri/`.

**How links find the app.** The reserved port changes on every launch, so no
`http://127.0.0.1:<port>` URL can address the app for longer than one run. The
bundle therefore registers its own URL scheme (`sessionrecall`, declared in
`tauri.conf.json` under `plugins.deep-link`, which is what puts the
`CFBundleURLTypes` entry in `Info.plist`). A link such as
`sessionrecall://session/alma%3Amwbhgpzz9n7zy56fdm` opens the app if it is not
running, focuses it if it is, and — in every case — lands on that session. A
link that arrives before the webview has finished loading is queued and applied
on the first finished page load, so a cold start cannot drop it.

`bash scripts/make-app.sh` builds for the host architecture only (arm64 on
Apple silicon, ~67 MB). `--universal` instead builds one bundle covering both
arm64 and x86_64 (~140 MB, roughly double the size because it carries two Bun
runtimes).

## What gets indexed

| Agent | Source | Extract |
|---|---|---|
| omp | `~/.omp/agent/sessions/<cwd>/*.jsonl` (plus profile roots) | user/assistant text messages; titles |
| OpenCode | `~/.local/share/opencode/opencode.db` | `session_v2` + `session_message` (falls back to the v1 `session`/`message`/`part` tables) |
| Cursor | `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` and `state.vscdb` (`composerData` + `bubbleId`) | transcripts first, KV for chats without a transcript; project path from `workspaceIdentifier` |
| Alma | `~/Library/Application Support/alma/chat_threads.db` | `chat_threads` + `chat_messages` (message JSON `parts`); project path from `workspaces.path`; threads marked `is_incognito` are never listed |
| Cindy | `~/Library/Application Support/CindyGlobal/cindy-*.db` (newest match wins) | `sessions` + `messages`: user rows are JSON `{text}`, assistant rows plain text, `thinking`/`tool_use`/`ask_user` rows become process events; project path from `working_dir`; `rewind_at` and messages before `cleared_at` are excluded |

The index unit is a **turn**: one user prompt plus the assistant text that
followed it before the next prompt. Tool calls and reasoning traces are stored
separately as process events (see below); their inputs, outputs, and errors are
searchable in the **过程** scope, while reasoning text stays out of search.
Each turn also stores the model that produced its answer when the agent
records one. omp, OpenCode, Alma, and Cindy record it per turn; Cursor records
only a session-level selection (`composerData.modelConfig.modelName`), which is
stamped on every turn of that session — transcripts and KV bubbles carry no
per-turn model, and Cursor's placeholder `default` stays blank. The session
page shows the model next to the agent badge.

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
- Alma reads each `tool-<Name>` part directly: `input` is serialized as JSON and
  `output` (an object such as `{stdout, stderr, exitCode}`) is serialized as
  JSON. A call that had not produced output yet, that errored, or that the user
  denied keeps an empty output — nothing is invented — and the state shows up as
  the row's status (`ok`, `error`, `denied`, `input-available`, `input-streaming`).
- API: `GET /api/session/:id/events?turn=N` returns `{ turn, events }`.
- Search uses the same `scope` parameter as the UI: `scope=process` searches
  tool inputs, outputs, and extracted error text. It groups hits by session and
  reports `processTotal` plus each hit's `tool`, `turnIdx`, `status`, and
  `matchField` (`input`, `output`, or `error`). A result link carries the event
  sequence (`event=<seq>`), so opening it expands the turn's process, opens the
  matching event row, and scrolls that row under the sticky action bar. Reasoning
  is deliberately excluded from search. The process index is `event_search` (FTS5 `trigram` + `porter`,
  with a `LIKE` fallback for queries under three characters); it is rebuilt
  automatically when an older index is opened.

## Handoff card

Every session page has a `复制交接` button in the same sticky action bar. It copies a Markdown card meant to
be pasted into another agent or a scratchpad: project, agent, time range, resume
command (or Alma deep link), the last few prompts, the last answer (truncated
verbatim), files touched by tool calls, commands run, tool errors, and the
current Git branch/status when the project is a Git worktree. The card is
generated on demand from the local index; nothing is sent anywhere.

- API: `GET /api/session/:id/handoff` returns the Markdown (`text/markdown`).
- The UI prefetches the card when a session opens, so the copy button can write
  to the clipboard synchronously from the click (async work before
  `navigator.clipboard` loses the browser's user activation).

## Resume

omp and OpenCode session pages show a copyable continue command in a sticky action bar below the session header:

```bash
cd '/path/to/project' && omp --resume <session-uuid>
cd '/path/to/project' && opencode --session <session-id>
```

The path is shell-quoted; the omp uuid is the suffix after the timestamp in the
stored session filename. Cursor has no equivalent local resume command, so its
pages omit the block.

Alma has no shell resume command either. Instead of faking one, its session
pages show the deep link that opens the thread in the Alma app:

```text
alma://thread/<thread-id>
```

It is labelled `在 Alma 中打开` and is a link plus a copy button, not a command to
paste into a terminal.

Cindy has neither a CLI resume command nor a known deep-link scheme, so its
session pages omit the resume block entirely instead of showing an empty or
broken action.

The app addresses its own pages the same way, with the `sessionrecall://` scheme
it registers at install time:

```text
sessionrecall://session/<session-id with : percent-encoded>
```

That is the link a daily brief emits and the link the iOS-style "open in app"
gesture resolves to. It is also accepted inside the app, where it is routed
directly rather than round-tripping through the OS.

## Daily brief

Generate a Markdown work log for one local day:

```bash
bun run brief              # today
bun run brief 2026-11-10   # a specific date
```

The file is written to `<app dir>/brief/YYYY-MM-DD.md` — that is
`~/Library/Application Support/session-recall/brief/` by default, next to the
index, so the command also works from inside the packaged `.app` (whose project
directory is read-only). Override it with `SESSION_RECALL_BRIEF_DIR=/some/dir`.
It groups sessions by project and shows the day's prompts, tool/reasoning counts,
the resume command, and a deep link back to the session. Sessions with no turn
timestamps (Cursor) are included by their last-updated date and marked as recent
turns. The web UI has a date picker and `生成简报` button in the rail footer; after
generation, `在线查看` renders the brief inside the app, and `下载 .md` saves the
file.

Each session links back with a deep link, so the file works from any viewer:

```markdown
[在 session-recall 打开](sessionrecall://session/omp%3A2026-11-10T09-00-00Z_01a1c36e-f580-7210-bab7-e3f4f99b1031)
```

Clicking it opens (or focuses) the app on that session. An
`http://127.0.0.1:<port>/#/session/<id>` link used to be emitted instead; it
carried whichever port generated the brief, so it died on the next launch — and
went to the browser when clicked from outside the app. It is no longer written,
though the in-app link handling still understands old briefs that contain one.

Inside the app the link is a clickable anchor that routes through the hash
router, so no OS round trip (and no second window, or stray browser tab) happens.

API: `POST /api/brief?date=YYYY-MM-DD` generates the file and returns its
Markdown; `GET /api/brief/file?date=YYYY-MM-DD` downloads it.

## Search

- Two scopes, chosen beside the search box:
  - **问答** searches prompts and answers.
  - **过程** searches tool inputs (`path`, `command`, …), tool outputs, and
    extracted error lines.
- SQLite FTS5, over both scopes:
  - `trigram` for Chinese phrases and substring/code-identifier matching.
  - `porter` stemming as an English fallback.
- A query shorter than three characters (for example a two-character Chinese
  word) falls back to indexed `LIKE` with the same filters.
- Filters: agent, project, date range, and role (prompt / answer / both); the
  role filter is hidden in the process scope.
- Results group by session and sort by the session's last activity (newest
  first); within a session, matching turns sort newest first, with FTS rank as
  the final tie-break. A process hit links directly to its turn and opens the
  process disclosure; an answer hit scrolls to the answer rather than the start
  of the turn.
- The first screen loads 200 matching rows. If that covers only part of the
  sessions, the list footer offers `显示更多` instead of telling you to narrow
  the filters; the UI can raise the limit up to 5,000 rows.
- Query syntax: bare terms, or `"an exact phrase"`; multi-term queries are ANDed.
- API: `GET /api/search?q=…&scope=qa|process&agent=…&project=…&from=…&to=…&role=…`;
  results carry `totalSessions`, `totalTurns`/`processTotal`, grouped sessions,
  and either `hits` or `processHits`.

## Index and privacy

- Index: `~/Library/Application Support/session-recall/index.db` (SQLite WAL).
- Preferences: `<app dir>/prefs.json`, currently the theme. It is written
  atomically (temp file + rename) and merged on write; a missing or corrupt file
  just means the defaults.
- Everything runs on `127.0.0.1`; there are no network calls, accounts, or
  telemetry.
- Agent databases are opened with `readonly: true` and a busy timeout. Nothing
  in the source folders is modified or copied.
- Alma threads with `is_incognito = 1` are excluded in SQL before their messages
  are read, so an incognito conversation is never listed, indexed, or searchable.
- Override the index location with `SESSION_RECALL_DB=/path/to/index.db`, the
  app dir with `SESSION_RECALL_HOME=/some/dir`, the port with
  `SESSION_RECALL_PORT=4319`, the brief dir with `SESSION_RECALL_BRIEF_DIR`, and
  the served UI directory with `SESSION_RECALL_WEB_DIST=/path/to/web/dist`.
  Alma's store is read from `SESSION_RECALL_ALMA_DB`, which defaults to
  `~/Library/Application Support/alma/chat_threads.db`. Cindy's directory and
  database can be pinned with `SESSION_RECALL_CINDY_DIR` and
  `SESSION_RECALL_CINDY_DB`; the default directory is
  `~/Library/Application Support/CindyGlobal`.

## Project layout

```text
src/
  adapters/       omp, OpenCode, Cursor, Alma, Cindy parsers
  brief.ts        daily Markdown brief generation
  config.ts       paths and port (APP_DIR honours SESSION_RECALL_HOME)
  db.ts           schema, FTS triggers, upserts
  handoff.ts      session handoff card generation
  prefs.ts        prefs.json: defaults, merge-on-write, atomic writes
  scan.ts         incremental scan orchestration
  search.ts       query building, ranking, facets
  server.ts       Bun.serve API + static UI
  util/resume.ts  shell resume commands and app deep links
web/
  app.ts          hash-routed UI
  markdown.ts     safe Markdown renderer
  links.ts        in-app link (deep link, loopback) -> hash route mapping
  styles.css      design tokens and components
src-tauri/
  src/main.rs     shell: reserve port, spawn sidecar, open window, deep links
  tauri.conf.json bundle config; sidecar, web assets, deep-link scheme
scripts/
  build.ts        Bun.build bundle
  make-app.sh     package the macOS .app
  make-icon.py    render app-icon.png (PIL, mirrors web/favicon.svg)
test/             markdown, search, process search, events, brief, handoff, links, prefs, Alma, Cindy tests
brief/            generated daily briefs (git-ignored)
```

## Development

```bash
bun test          # 52 tests: markdown, search, process events, daily brief, links, prefs, Alma, Cindy
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
- **Alma edited / regenerated branches**: Alma can edit or regenerate a message,
  which leaves several sibling messages per slot (`parent_id`/`slot_id`/`depth`).
  The Alma adapter does not resolve the active branch — it flattens every message
  into linear `(timestamp, id)` order. An edited or regenerated branch therefore
  shows up as additional turns rather than replacing the message you actually
  kept. The newest copy is not preferred; the adapter has no notion of "active".
- **Alma subagent transcripts** live in the same `chat_messages` table as the
  parent thread (depth 0, no parent), so their assistant text is folded into the
  surrounding turn like any other consecutive assistant message.
- **Cindy tool pairing**: `tool_result` rows carry no tool id, so outputs are
  attached to the oldest unanswered `tool_use` in arrival order. Parallel calls
  almost always resolve in call order; an interleaved result would land on the
  wrong row's output but never on a different turn.
- **Cindy hidden messages**: `messages.rewind_at` (edit/rewind) and rows older
  than `sessions.cleared_at` are filtered in SQL, matching what the Cindy UI
  shows. Forked sessions keep their `parent_session_id` in the index.
