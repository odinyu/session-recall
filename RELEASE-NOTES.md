# Release notes (what users see)

This file is the **user-facing** update text. The in-app update dialog and the
"What's new" block on the GitHub release page are both built from the section
whose heading matches the tag being released (`## <version> — <date>`).

Rules for an entry:

- Write for people who *use* the app, not for people reading the diff.
- Match the size of the change: a UI-polish release says so in one line.
- One or two lines. No file names, no internal plumbing, no dependency bumps.
- Bilingual: the Chinese line first, then the English line, separated by a blank
  line (the dialog renders this text as-is).
- A release fails in CI if this file has no section for the tag, so add the
  section in the same commit as the version bump.

The developer-facing record — every functional change, fix and refactor — lives
in `CHANGELOG.md` and is never shown to users.

## 1.8.0 — 2026-11-15

现在可以按标题搜索会话了；新增 ⌘⇧K 快速搜索浮窗；报告新增月报与周期对比。

You can search sessions by their title now, there is a ⌘⇧K quick-search
palette, and the reports gained monthly summaries with period comparisons.

## 1.7.3 — 2026-11-14

界面微调：日报/周报移到侧栏左下，去掉重复的会话计数，文案与命名统一。

UI polish: the daily/weekly report controls moved to the bottom-left of the
sidebar, the duplicated session counts are gone, and naming is consistent.

## 1.7.2 — 2026-11-14

界面变化较多：侧栏顺序重排、设置改为居中窗口、菜单补全，新增「有新版本」提示窗。

A bigger interface update: the sidebar was reordered, settings became a centered
window, the macOS menu gained Check for Updates…, and a dialog now announces new
versions.
