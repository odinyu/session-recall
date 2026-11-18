# Session Recall

[English](README.md) | [Chinese](README.zh-CN.md)

[![License: MIT](https://img.shields.io/github/license/odinyu/session-recall?label=license)](LICENSE)
[![CI](https://github.com/odinyu/session-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/odinyu/session-recall/actions/workflows/ci.yml)

**You already solved this last month. Find it again in one keystroke.**

A local, read-only search over every coding-agent session on this Mac — in the
terminal, where you already are. Type half a question, a file name, or the error
string you half-remember, and jump back to the session where it happened.
Across 8 agents, no account, no network call.

<img src="docs/tui-demo.gif" alt="The terminal UI: search as you type, sessions on the left, turns on the right" width="980">

> *"How did we fix the websocket reconnect?"* → the session where you did, with
> the answer and the dead end you tried first.

## Install

```bash
brew tap odinyu/tap
brew trust odinyu/tap          # one-time: Homebrew 7 asks before loading a tap
brew install session-recall
session-recall scan            # build the index from what's already on disk
session-recall tui             # the terminal UI
```

One self-contained binary (~22 MB): the **terminal UI**, the CLI and the **MCP
server**. A formula download is not quarantined, so there is no notarization and
no `xattr` step. Linux builds ship on the same release page; the index lands in
`~/Library/Application Support/session-recall/` and refreshes on its own.

Prefer a window? The macOS app is a separate cask (ad-hoc signed, so it needs a
one-time quarantine clear):

```bash
brew install --cask session-recall-app
xattr -dr com.apple.quarantine "/Applications/Session Recall.app"
```

## The terminal UI

Everything is one keystroke away, and nothing hides behind a menu:

- **Type to search.** Results update on every keystroke — a query across 588
  sessions takes a few milliseconds.
- **`↑↓`** moves through sessions; the right pane shows the turns, newest last.
- **`Tab`** switches scope: *qa* searches questions and answers, *process*
  searches tool commands, inputs and error text — where a debugging session
  actually lives.
- **`^A`** cycles the agent filter (omp, Claude Code, Cursor, …) and shows it in
  the header.
- **`^Y`** copies a **handoff card** for the selected session: project, resume
  command, last prompts, last answer, files touched, tool errors — paste it into
  a new agent and keep working.
- **`^R`** rescans in the background; **`^C`** quits.

Chinese works like you'd type it: 数据库打不开 is searched as 数据库 AND 打不开,
not as one literal string. Half a phrase is usually enough.

## Why not just grep the session files?

grep finds strings. It does not know a turn from a tool call, does not rank by
relevance, and cannot tell you which question an answer belongs to. Session
Recall indexes turns and tool events separately, so a hit inside a stack trace
takes you to the question that provoked it — and the answer that resolved it.

## What it does

- **Nothing to set up.** First launch indexes what is already on disk: no
  account, no cloud, no API key, no config file.
- **Never writes.** Agent transcripts are opened read-only with a busy timeout;
  the only thing it creates is its own index.
- **Chinese and code in one query.** A trigram index, so 半句中文 and
  `reconnect_backoff` both land, in the same box.
- **Eight agents, one index.** omp · pi · OpenCode · Cursor · Alma · Cindy ·
  Claude Code · Codex — plus any other agent you add with two lines of JSON (see
  *Adding your own agent* below).
- **Reports, not just search.** Daily standups, weekly and monthly reports, and a
  handoff card that carries the context into a new agent session.
- **Your agents can use it too.** A stdio MCP server and a portable skill;
  `setup` wires both into the agents installed here.

## The macOS app

The GUI is the same index with a window: quick search from any app on `⌥⌘R`,
session pages with deep links, reports in a sidebar, and **Copy handoff** on
every session. Install it from the cask above or grab a zip:

| Mac | Download |
| --- | --- |
| Apple silicon (M1/M2/M3/M4…) | [`Session-Recall_macos-arm64.zip`](https://github.com/odinyu/session-recall/releases/latest/download/Session-Recall_macos-arm64.zip) — 27.2 MB |
| Intel | [`Session-Recall_macos-intel.zip`](https://github.com/odinyu/session-recall/releases/latest/download/Session-Recall_macos-intel.zip) — 29.9 MB |

On first launch it builds the same index the TUI reads — whichever you install
first, the other sees it immediately.

## Adding your own agent

Eight agents ship with a hand-written parser. For anything else, add two lines to
`~/Library/Application Support/session-recall/sources.json`:

```json
{
  "sources": [
    { "id": "mytool", "root": "~/.mytool/sessions" }
  ]
}
```

That is the whole declaration. Everything else has a fallback:

- **Format** comes from the file extension — `.jsonl` is one message per line,
  `.json` is one document with the array under `messages`.
- **Role** is read from `role`, `sender`, `who`, `author`, `type` or `from`, and
  matched against `user`/`human`/`prompt` and
  `assistant`/`agent`/`ai`/`model`/`bot`.
- **Text** is read from `content`, `text`, `message`, `body`, `parts` or
  `payload`, as a string or as a list of blocks with a `text` field.
- **Time** is read from `timestamp`, `time`, `created_at`, `createdAt`, `ts`,
  `sentAt` or `date`, as epoch seconds, milliseconds or an ISO string.
- **Project and title** come from `cwd`/`working_dir`/`project` and
  `title`/`name`/`summary`.

If the store uses none of those names, name them yourself — every default has an
override (`role`, `text`, `time`, `title`, `cwd`, `messages`, `format`,
`userRoles`, `assistantRoles`), documented with a full example in
[`doc/sources.example.json`](doc/sources.example.json).

The next scan picks it up, `--agent mytool` filters by it, and
`session-recall doctor` reports a broken declaration instead of quietly indexing
nothing. Two limits: the `id` cannot collide with a built-in agent, and a SQLite
store still needs an adapter in `src/adapters/`.

## Screenshots

Every screenshot is rendered from invented sessions in a throwaway index; the
real index is never read.

![Search results for a WebSocket reconnect query](docs/screenshots/en/search-results.png)

A query across every indexed agent: the rail filters by agent, project and time,
and each hit shows the question, the answer, and where the terms matched.

![One session, deep-linked to a single highlighted question](docs/screenshots/en/session-detail.png)

One session, opened through a `?turn=` deep link: the addressed question is
highlighted, its answer follows, and the continue-in strip carries the resume
command.

![Process search for a tool error](docs/screenshots/en/process-search.png)

Process search looks past the prose into tool calls, commands and error output,
which is how a failing run behind a conversation gets found.

## Handoff card

Every session page has **Copy handoff** in the sticky action bar. It copies a
Markdown card for another agent or a scratchpad: project, agent, time range,
resume command (or Alma deep link), the last few prompts, the last answer, files
touched, commands run, tool errors, and the current Git branch/status. The card
is generated from the local index and never uploaded.

**Continue in** creates the same context for another agent. Five agents have an
exact in-place resume command — omp, pi, OpenCode, Claude Code and Codex — and
Alma opens its own threads with `alma://thread/<id>`. Every other agent gets a
command that starts a new session (or opens the project) plus the handoff card
to paste as context.

## Reports

The sidebar footer generates **daily** and **weekly** reports: pick a day, choose
Daily or Weekly, press **Generate**. A report opens in the content pane and can
be downloaded as Markdown.

Monthly reports and period comparisons come from the command-line tool bundled
inside the app:

```bash
session-recall brief --month 2026-11
```

Reports are written under `~/Library/Application Support/session-recall/brief/`
(`daily/`, `weekly/`, `monthly/`). `briefSchedule` in `prefs.json` can generate
the current daily or weekly report on a local timer; the Settings drawer does not
expose it yet.

<details>
<summary><b>Search</b> — scopes, filters, sorting and the API</summary>

- **Q&A** searches prompts, answers and session titles. **Process** searches
  tool inputs (`path`, `command`, …), tool outputs and extracted error lines.
  Reasoning stays out of search.
- SQLite FTS5 with a `trigram` index for Chinese phrases and substring/code
  identifiers, plus `porter` stemming for English. Queries under three
  characters fall back to indexed `LIKE`.
- <kbd>⌘⇧K</kbd> opens quick search from anywhere in the app (rebindable):
  <kbd>↑↓</kbd> move, <kbd>Enter</kbd> opens, <kbd>⌘↵</kbd> copies the deep link,
  <kbd>Esc</kbd> closes.
- Filters: agent, project, date range, role (prompt / answer / both), starred
  and hidden. The role filter is hidden in the process scope.
- Results group by session and sort by the session's last activity, newest
  first. A process hit opens its turn and expands the matching tool row; an
  answer hit scrolls to the answer.
- The first screen loads 200 rows; the footer offers **Show more** up to 5,000.
- API: `GET /api/search?q=…&scope=qa|process&agent=…&project=…&from=…&to=…&role=…`.

</details>

<details>
<summary><b>What gets indexed</b> — 8 agents and their local stores</summary>

| Agent | Source | Extract |
|---|---|---|
| omp | `~/.omp/agent/sessions/<cwd>/*.jsonl` (plus profile roots) | user/assistant text; titles |
| pi | `~/Library/Application Support/CindyGlobal/pi-agent-home/sessions/*.jsonl`, `.../pi-package-home/sessions/*.jsonl`, `~/.pi/agent/sessions/*.jsonl` | pi shares omp's JSONL format: turns, thinking and tool calls become text + process events |
| OpenCode | `~/.local/share/opencode/opencode.db` | `session_v2` + `session_message` (falls back to the v1 tables) |
| Cursor | `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` and `state.vscdb` | transcripts first, KV for chats without one; project from `workspaceIdentifier` |
| Alma | `~/Library/Application Support/alma/chat_threads.db` | `chat_threads` + `chat_messages`; incognito threads never listed |
| Cindy | `~/Library/Application Support/CindyGlobal/cindy-*.db` | `sessions` + `messages`; thinking/tool rows become process events; rewound and cleared messages excluded |
| Claude Code | `~/.claude/projects/<project-slug>/<sessionId>.jsonl` | text, thinking and tool calls; `tool_result` attaches to its call; subagent sidechains skipped |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus Cindy's `codex-home` | `session_meta` + `turn_context`; response items, calls and reasoning become turns + process events |


The index unit is a **turn**: one prompt plus the assistant text before the next
prompt. Tool calls and reasoning live as process events under that turn. Each
turn also stores the model when the agent records one; Cursor's limitations are
listed under Known limits.

</details>

<details>
<summary><b>Process events</b> — tool calls, commands and errors</summary>

When a turn has tool calls or reasoning, its row shows a **Process**
disclosure. Opening it loads that turn's events lazily; each reasoning block and
tool call is a collapsed row, and inputs/outputs are plain text.

- Events are keyed by `(session_id, turn_idx, seq)` and capped at 30 per turn,
  1,200 per session; reasoning 2,000 characters, input 1,000, output 2,000.
- omp/pi pair results by id; OpenCode reads tool state; Cursor transcripts
  usually carry no results; Alma reads `tool-<Name>` parts and shows status
  (`ok`, `error`, `denied`, `input-available`, `input-streaming`).
- API: `GET /api/session/:id/events?turn=N`.
- Process search links carry `event=<seq>`, so opening a hit expands the turn,
  opens the matching row and scrolls it under the sticky action bar.

</details>

<details>
<summary><b>Resume commands</b> — exact commands for the five supported agents</summary>

```bash
cd '/path/to/project' && omp --resume <session-uuid>
cd '/path/to/project' && opencode --session <session-id>
cd '/path/to/project' && claude --resume <session-id>
cd '/path/to/project' && pi --session <session-uuid>
cd '/path/to/project' && codex resume <session-uuid>
alma://thread/<thread-id>
```

Paths are shell-quoted. For omp and pi the id is the uuid after the timestamp in
the stored filename; for Codex it is the trailing rollout uuid. Cross-agent
handoff cannot transfer a session id — the target starts a new session and the
handoff card supplies the context.

</details>

<details>
<summary><b>Connect your agents</b> — one command, two channels</summary>

The app ships a stdio MCP server and an agent skill. Point both at every agent
on this machine:

```bash
session-recall setup --dry-run   # show the plan, write nothing
session-recall setup             # write the MCP entry and the skill (backups included)
session-recall doctor            # verify - including a real MCP initialize + tools/list
```

`setup` writes the MCP entry only for clients whose config shape is verified
(Cursor, Alma, Claude Code, Gemini CLI, Qwen Code, OpenCode) and prints a
paste-ready snippet for the rest. The skill is the portable channel: the same
`SKILL.md` lands in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`,
`~/.cursor/skills` and `~/.config/opencode/skills`, so agents with shell access
can use the CLI even when they cannot take an MCP entry.

Neither channel touches your transcripts. Every config file is backed up before
it is edited, a file that is not valid JSON is reported and left alone, and
`setup --remove` takes back only what it installed.

Tools: `recall_search`, `recall_session`, `recall_facets`, `recall_handoff`,
`recall_scan`, `recall_saved_searches`, `recall_brief`. Read tools open the index
read-only and refresh it in the background when the last scan is older than five
minutes; every reply reports `refresh` and `indexAgeMs`.

</details>

<details>
<summary><b>Privacy and the index</b></summary>

- Index: `~/Library/Application Support/session-recall/index.db` (SQLite WAL).
- Preferences: `<app dir>/prefs.json` — theme, language, hotkey, in-app
  shortcuts, update check and report schedule; written atomically.
- Agent databases are opened `readonly: true` with a busy timeout. Nothing in
  their folders is modified or copied. Incognito Alma threads are excluded in
  SQL before their messages are read.
- Indexing, search, reports, handoff cards and MCP make no network calls and
  need no account. The only outbound request is the GitHub update check (launch,
  every six hours, and **Check for Updates…**); set `"checkUpdates": false` in
  `prefs.json` to stop it.
- Secrets are redacted before rows are written: API keys, Bearer tokens, JWTs,
  PEM private keys, `KEY=value` credentials, connection strings with embedded
  credentials, e-mail addresses and Chinese mobile numbers become placeholders
  such as `[REDACTED:api-key]`.
- Override paths with `SESSION_RECALL_DB`, `SESSION_RECALL_HOME`,
  `SESSION_RECALL_PORT`, `SESSION_RECALL_BRIEF_DIR` and
  `SESSION_RECALL_WEB_DIST`.

Drop a session without touching its transcript:

```bash
session-recall forget omp:2026-11-10T01-13-16-427Z_01a1c304    # rows + FTS
session-recall unforget omp:2026-11-10T01-13-16-427Z_01a1c304  # undo
```

The same action is **Forget this session** on the session page, with Undo in the
status line.

</details>

<details>
<summary><b>Known limits</b></summary>

- **Cursor tool results**: transcripts usually have calls but no results, so
  Cursor process rows show input without output.
- **Cursor timestamps**: project transcripts carry no top-level timestamps, so
  activity falls back to file modification time. Chats whose project no longer
  exists are indexed without a project path.
- **Alma branches**: edit/regenerate leaves sibling messages; the adapter
  flattens them by time instead of resolving the active branch. Alma subagent
  transcripts fold into the surrounding turn.
- **Cindy pairing**: results carry no tool id, so outputs attach to the oldest
  unanswered call in arrival order.
- **Claude Code subagents**: `isSidechain` records are skipped and their work is
  not indexed separately.
- **Codex format**: follows the documented rollout format; field names may drift
  between Codex releases.
- **WorkBuddy** stores metadata only, so it is not indexed.
- **Archived chats** are included; there is no archive filter yet.

</details>

<details>
<summary><b>Documentation and building from source</b></summary>

- [`doc/BUILD.md`](doc/BUILD.md) — build the `.app`, run tests, project layout.
- [`doc/USAGE.md`](doc/USAGE.md) — every CLI and MCP option, JSON schemas, exit codes.
- [`doc/MCP.md`](doc/MCP.md) — sharing one index with a stdio MCP client.
- [`doc/REPORTS.md`](doc/REPORTS.md) — daily, weekly and monthly templates.
- [`doc/DESIGN.md`](doc/DESIGN.md) — layout, type scale, tokens, interactions.
- [`doc/PRODUCT.md`](doc/PRODUCT.md) — what Session Recall is and is not.
- [`doc/POSITIONING.md`](doc/POSITIONING.md) — the landscape and roadmap.

</details>

## License

MIT — see [LICENSE](LICENSE).
