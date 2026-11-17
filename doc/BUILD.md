# Building and running from source

This page is for developing Session Recall or building your own `.app`. If you
just want to use the app, download a build from
[releases](https://github.com/odinyu/session-recall/releases) — the packaged app
carries its own runtime and needs nothing else installed.

## Requirements

- macOS 11 or later.
- Bun 1.3+ for the build and the source CLI.
- A Rust toolchain and the Tauri CLI for the desktop shell:
  `cargo install tauri-cli --version "^2.12"`.

## Run from a checkout

```bash
git clone https://github.com/odinyu/session-recall.git
cd session-recall
bun run scan                       # build the index (first run: a few seconds)
bun run sr "websocket" --limit 3   # search from the shell
bun run start                      # build the UI and serve http://127.0.0.1:4319
```

`bun run start` also scans on boot and refreshes the index every 90 seconds.
Preferences live in `<app dir>/prefs.json` (see `src/prefs.ts`) rather than in
`localStorage`, so they survive the dev server restarting on another port;
`localStorage` is only a same-origin cache for the first paint.

## Build the macOS app

```bash
bash scripts/make-app.sh
```

The script builds the web UI, compiles the Bun CLI into a self-contained sidecar
binary (~61 MB, named for the host target triple), and lets Tauri bundle both:

```text
src-tauri/target/release/bundle/macos/Session Recall.app
```

The bundle is ad-hoc signed (`signingIdentity: "-"`). A build you copy around
needs its quarantine flag cleared before the first launch:

```bash
xattr -dr com.apple.quarantine "Session Recall.app"
```

`bash scripts/make-app.sh` builds for the host architecture only (arm64 on
Apple silicon, ~72 MB). `--arch aarch64-apple-darwin` / `--arch
x86_64-apple-darwin` build one specific slice, cross-compiling the sidecar if
needed; `--universal` builds one bundle covering both arm64 and x86_64 (~141 MB,
roughly double the size because it carries two Bun runtimes).

**How the app finds its parts.** Tauri ships the Bun CLI as an `externalBin`
sidecar at `Contents/MacOS/session-recall`, and the built web UI as a bundle
resource at `Contents/Resources/web/dist`. On launch the Rust shell
(`src-tauri/src/main.rs`):

1. reserves a free loopback port;
2. locates the sidecar — `$SESSION_RECALL_SIDECAR`, then any `session-recall*`
   file next to the main executable, then `src-tauri/binaries/` (for
   `cargo tauri dev`);
3. spawns it with `SESSION_RECALL_PORT` set to the reserved port and
   `SESSION_RECALL_WEB_DIST` pointing at the resource dir;
4. waits until the port accepts connections, then opens a `WKWebView` window on
   `http://127.0.0.1:<port>`;
5. answers `sessionrecall://` deep links by driving the UI's hash router,
   bringing the window forward if it was in the background;
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

## Development

```bash
bun test          # 284 tests across 37 files
bun run build     # bundle web/app.ts -> web/dist
```

No runtime dependencies. `bun:sqlite` provides FTS5 with both tokenizers.

## Project layout

```text
src/
  adapters/       omp/pi, OpenCode, Cursor, Alma, Cindy, Claude Code, Codex,
                  Gemini CLI, Qwen Code, Goose parsers, plus custom.ts for
                  declarative sources.json sources
  brief.ts        daily standup / archive / weekly / monthly report generation
  cli-search.ts   search subcommand: arg parsing, text/JSON output
  config.ts       paths and port (APP_DIR honours SESSION_RECALL_HOME)
  freshness.ts    indexAgeMs, scanIfStale, background refresh
  index-read.ts   read-only index open with schema-version checks
  mcp.ts          stdio MCP server: JSON-RPC, compact tools, deep links
  db.ts           schema, FTS triggers, upserts
  handoff.ts      session handoff card generation
  prefs.ts        prefs.json: defaults, merge-on-write, atomic writes
  scan.ts         incremental scan orchestration
  scan-lock.ts    cross-process scan lock (O_EXCL + stale takeover)
  search.ts       query building, ranking, facets
  server.ts       Bun.serve API + static UI
  util/resume.ts  shell resume commands and app deep links
  util/redact.ts  write-time redaction of secrets and PII
web/
  app.ts          hash-routed UI
  handoff.ts      handoff card cache key, bounded cache and bounded wait
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
test/             markdown, search, process search, events, brief/reports,
                  handoff, links, prefs, web app and adapter tests
brief/            generated reports (git-ignored)
doc/              long-form docs, each in English and zh-CN
```

## Documentation

- [`../README.md`](../README.md) — what the app does and how to use it.
- [`USAGE.md`](USAGE.md) — every CLI and MCP option, JSON schemas, exit codes and recipes.
- [`MCP.md`](MCP.md) — how the app and a stdio MCP client share one index.
- [`REPORTS.md`](REPORTS.md) — the daily, weekly and monthly report templates.
- [`DESIGN.md`](DESIGN.md) — layout, type scale, tokens and interaction rules.
- [`PRODUCT.md`](PRODUCT.md) — what the app is, who it is for, and what it deliberately is not.
- [`POSITIONING.md`](POSITIONING.md) — where it sits next to other agent-memory tools, and the roadmap.

## License

MIT — see [LICENSE](../LICENSE).
