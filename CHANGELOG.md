# Changelog

Notable changes per release. Versions are tagged `vMAJOR.MINOR.PATCH`; the
release workflow builds the macOS app from the tag.

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
- 「忘记会话」: `forget` / `unforget` via the CLI, `POST /api/session/:id/forget`
  and a button on the session page (with an undo in the status line). A
  forgotten id is dropped from the index and its FTS rows, then skipped by later
  scans; the command lists generated briefs that still mention it, because plain
  Markdown copies are not rewritten.
- UI: visible focus ring on the search field, focus preserved across filter and
  theme re-renders, drawer `aria-expanded` with a focus trap, highlighted
  matches escaped after matching (searching `amp` no longer breaks entities),
  `resultLimit` reset when the query changes, agent dots coloured per agent.
- Reports: a 日报 / 周报 switch in the sidebar footer with a self-drawn,
  theme-aware calendar; weekly reports open in-app at
  `#/brief/<week>?format=week`.
- Deep links carry their search: `sessionrecall://session/<id>?turn=3&q=…` now
  highlights the terms in prompts, answers and code blocks, adds a 「来自搜索」
  strip, points 「返回搜索」 at those results, and centres the target turn. Links
  without `q` behave as before.
- First paint and failed searches: the content pane shows a skeleton on the
  first search instead of staying blank, and a failed request keeps the results
  on screen with a `role="alert"` error bar and a 重试 button.
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
