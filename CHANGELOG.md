# Changelog

Notable changes per release. Versions are tagged `vMAJOR.MINOR.PATCH`; the
release workflow builds the macOS app from the tag.

## Unreleased

- MIT license, continuous integration, and a tagged macOS release workflow.

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
