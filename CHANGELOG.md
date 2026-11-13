# Changelog

Notable changes per release. Versions are tagged `vMAJOR.MINOR.PATCH`; the
release workflow builds the macOS app from the tag.

## 1.5.0 — 2026-11-13

- Five more agent sources, all read-only: Gemini CLI, Qwen Code, Kimi Code, GitHub
  Copilot CLI and Goose — thirteen in total. Each adapter was written against the
  format its agent actually writes, and records it does not understand are
  skipped rather than guessed.
- Download links on the landing page are version-less (`/releases/latest/download/`),
  so a release no longer needs a URL edit; the workflow publishes stable-named
  aliases and their checksums beside the versioned assets.

## 1.4.0 — 2026-11-13

- Bilingual report templates: daily, weekly and archive reports follow the interface language, the CLI accepts `--lang zh|en`, the front matter records `lang:`, and to-do extraction also recognises `next step`.

## 1.3.1 — 2026-11-13

- Fixed the first click on the session page's “Copy handoff” button failing:
  the card is now prefetched when the session opens, the button stays at
  “Preparing…” until the prefetch finishes, and the slow path says “Handoff
  card ready — click again” instead of “Copy failed”.
- Fixed `format2 is not a function` when viewing a daily or weekly report in
  the app: `renderBrief`'s parameter no longer shadows the `format` helper.
- Made it explicit that “Forget this session” only removes the local index
  entry and does not delete the agent's original storage; the web and CLI copy
  now match.
- Added tests for web app parameter shadowing and the handoff state machine;
  the suite is now 152 tests.

## 1.3.0 — 2026-11-13

- UI language switch: Chinese / English, persisted in `prefs.json` alongside the theme; `auto` follows the browser language. All interface chrome is localized while session content stays verbatim.
- Bilingual documentation: README plus USAGE, MCP, DESIGN, POSITIONING, PRODUCT and REPORTS, each with an English original and a `.zh-CN.md` counterpart and a language switch at the top.
- The long-form docs moved to `doc/`; the repository root now keeps only the README pair, `CHANGELOG.md` and `LICENSE`.
- Screenshots are generated in matching languages under `docs/screenshots/en/` and `docs/screenshots/zh/` from synthetic English and Chinese sessions; the README links each language to its own set.
- `test/i18n.test.ts` pins the two dictionaries together: same keys, same `{placeholder}` names per key, and no Chinese text in the English copy, because `bun run build` strips types without checking them.

## 1.2.2 — 2026-11-13

- Fixed the “Clear filters” button in the filter rail: after selecting an
  agent, project or time range it is no longer clipped by the scroll area and
  scrollbar; it is pinned below the filter list and shows the current filter
  count.

## 1.2.1 — 2026-11-13

- Codex sessions now come from Cindy's own home too: the adapter scans
  `CindyGlobal/codex-home/sessions` and `archived_sessions` alongside
  `~/.codex/sessions`, so work done by Cindy-launched Codex workers is indexed.
- New `pi` adapter for official pi sessions under Cindy's `pi-agent-home`,
  `pi-package-home`, and a direct `~/.pi/agent/sessions`. It shares omp's JSONL
  parser, gets its own agent filter, title, and `pi --session <uuid>` resume.
- Cindy's adapter reads Orca lead messages (`{orcaSource, content}`) as prompts,
  so worker sessions whose only user turns came from the lead are no longer
  dropped; titles also skip injected environment/language/ready prompts.

## 1.2.0 — 2026-11-12

- MIT license, continuous integration, and a tagged macOS release workflow that
  attaches one Apple silicon and one Intel `.app` zip (plus SHA-256 checksums)
  to each release.
- Write-time redaction of secrets and PII: API keys, bearer and `Authorization`
  tokens, JWTs, PEM blocks, `KEY=value` credentials, database URLs with credentials,
  e-mail addresses and Chinese mobile numbers are stored as
  `[REDACTED:<kind>]` placeholders, so the index, FTS tables, MCP results and
  generated briefs all agree. Raising `REDACTION_VERSION` makes the next scan
  rewrite existing rows.
- “Forget session”: `forget` / `unforget` via the CLI, `POST /api/session/:id/forget`
  and a button on the session page (with an undo in the status line). A
  forgotten id is dropped from the index and its FTS rows, then skipped by later
  scans; the command lists generated briefs that still mention it, because plain
  Markdown copies are not rewritten.
- UI: visible focus ring on the search field, focus preserved across filter and
  theme re-renders, drawer `aria-expanded` with a focus trap, highlighted
  matches escaped after matching (searching `amp` no longer breaks entities),
  `resultLimit` reset when the query changes, agent dots coloured per agent.
- Reports: a Daily / Weekly switch in the sidebar footer with a self-drawn,
  theme-aware calendar; weekly reports open in-app at
  `#/brief/<week>?format=week`.
- Deep links carry their search: `sessionrecall://session/<id>?turn=3&q=…` now
  highlights the terms in prompts, answers and code blocks, adds a “From the
  search” strip, points “Back to search” at those results, and centres the
  target turn. Links without `q` behave as before.
- First paint and failed searches: the content pane shows a skeleton on the
  first search instead of staying blank, and a failed request keeps the results
  on screen with a `role="alert"` error bar and a Retry button.
- Type scale consolidated onto the seven sizes DESIGN.md defines, and `--faint`
  adjusted so 10.5px labels pass WCAG AA in both themes.

## 1.1.1 — 2026-11-11

- Size the app icon to Apple's macOS grid.

## 1.1.0 — 2026-11-11

- Package as a double-clickable macOS `.app` (Tauri shell + Bun CLI sidecar).
- Add the Alma adapter and remember the theme choice server-side.
- Generate daily briefs and render them in the app.

## 1.0.0 — 2026-11-10

- First release: read-only index over omp, OpenCode, Cursor, Alma, Cindy,
  Claude Code and Codex sessions, with FTS5 search, daily briefs and a stdio
  MCP server.
