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

## 1.9.1 — 2026-11-18

内置 agent 精简为 8 个真正在用的，其他 agent 现在两行 JSON 就能自己加；Homebrew 安装说明补上了必须清除 quarantine 的那一行，Cindy 的会话库也不会再挑到残包。

The built-in agent list is trimmed to the eight that actually have data here, and any other agent can now be added with two lines of JSON. The Homebrew instructions include the quarantine step that is genuinely required, and Cindy's session store is picked reliably.

## 1.9.0 — 2026-11-17

现在一条命令就能把你本机的 agent 接上：`setup` 写入 MCP 配置和 skill，`doctor` 逐项自检并真的和 MCP 服务握手。也支持 `brew install --cask odinyu/tap/session-recall`，命令行工具会进 PATH。

One command now connects the agents on your Mac: `setup` writes the MCP config and the skill, and `doctor` checks everything, including a real handshake with the MCP server. You can also `brew install --cask odinyu/tap/session-recall`, which puts the CLI on your PATH.

## 1.8.1 — 2026-11-16

修复 macOS 菜单栏缺少应用菜单和 ⌘Q；「检查更新」在已是最新或失败时也会给出提示，快捷键可以逐项改绑。中文短语被换行拆开时仍能搜到，项目筛选不再混入 Cindy 的临时目录，界面细节继续打磨。

The macOS menu bar has its app menu and ⌘Q again; Check for Updates now answers even when you are current or the check fails, and shortcuts can be rebound per action. Wrapped Chinese phrases stay searchable, Cindy's scratch folders no longer appear as projects, and interface details are polished.

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
