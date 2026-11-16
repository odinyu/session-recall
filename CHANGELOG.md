# Changelog

This is the **developer-facing** record: every functional change, fix and
refactor. The short text users see in the app's update dialog lives in
`RELEASE-NOTES.md`, matched by version.

Notable changes per release. Versions are tagged `vMAJOR.MINOR.PATCH`; the
release workflow builds the macOS app from the tag.

## 1.8.1 — 2026-11-16

- **A File menu holds the update entries.** `Check for Updates…` (⌘U) and
  `View Changelog` moved out of the application menu into a **File** submenu,
  followed by Close Window, where macOS users look for them; the application
  menu keeps About, Hide/Show All and Quit (⌘Q). Both update entries still work
  while the window is hidden. The app menu is now an explicit submenu — macOS
  only renders submenus in the menu bar, so the predefined items previously sat
  at the top level and disappeared, taking ⌘Q with them.

- **Check for Updates… answers visibly.** "No update" and a failed check used
  to be silent, because the drawer only announces available updates; the menu
  now shows a native alert (as a sheet on the window, so it is actually
  visible): *Session Recall 1.8.0 is the latest version.* or the error text. A
  hidden window is brought forward for it, and the alert follows the stored
  language preference (then the system locale).

- **No accent focus rings anywhere.** The global `:focus-visible` outline and
  every per-control accent ring are gone: keyboard focus now reads as the same
  tint or text-colour change hover uses (`project-trigger`, `date-cell`,
  `resume-option`, `role-chip` get the hover tint; icon and link buttons get the
  hover accent colour; the two text inputs keep their resting border). The
  calendar's Escape-restore therefore no longer paints a border around the date
  button.

- **Every shortcut is bindable in the drawer.** The shortcuts group lists each
  action as a row with its name, command id and keycap chips instead of a text
  input. Each row reveals `+` on hover while it has no binding and `×` once it
  has one; `+` captures the next combination (Escape or a click elsewhere
  abandons it) and `×` clears it. The global hotkey, **focus search field**
  (⌘K / `/` by default) and **quick search palette** (⌘⇧K) are all editable,
  and two bindings on one action are joined by `or`. In-app binds reject bare
  letters/digits (they would swallow typing) and a combination already bound to
  another action. Changes apply without a restart: `POST /api/hotkey` writes the
  shell's request file, the shell re-registers on its next poll (≈2 s) and the
  drawer shows **Applying…** until it does; `/`-style bindings stop working
  while an input has focus, and the topbar hint follows the configured
  focus-search binding.

- **The palette no longer opens on an ordinary refocus.** The shell now bumps a
  summon counter (`GET /api/summon`) only when the global hotkey brings the
  window forward; the webview polls it and opens the quick-search palette only
  for an increase. Cmd-Tab back into the app leaves the palette closed, and a
  summon while the settings or update dialog is open just raises the window.

- **The filter popups draw no accent outlines.** The agent popup's search field,
  its selected/keyboard-active rows and the Clear filters button now rely on
  their tint (and the caret, the checkmark) instead of a border or focus ring;
  the project list drops its inset outline for the same reason.

- **No accent rings on the search inputs.** The topbar search bar no longer
  draws a focus outline around the field, and the quick-search palette's input
  drops its ring too; the caret and the search icon carry the focus cue.
- **Local app builds need no release key.** `make-app.sh` now skips the updater
  artifacts (and says so) when `TAURI_SIGNING_PRIVATE_KEY` is unset, instead of
  failing after the .app was assembled; CI still signs them from its secrets.

- **A wrapped Chinese phrase is searchable as written.** Transcripts wrap long
  lines, so a prompt can store 「使用不同的模型协同」 as 「使用不 同的模型协同」.
  The LIKE fallback now also compares whitespace-stripped columns against the
  query with CJK-internal spaces removed, so the correct spelling finds it (the
  wrapped spelling still matches through FTS). English word boundaries are
  untouched, and no re-index is needed.
- **Cindy's scratch directories are no longer projects.** Cindy records its own
  per-dialogue directory (`owners/<owner>/dialogues/<date>/<id>`) and
  `learn/staging/<id>` as the session's `working_dir`, and agents it launched
  inherited the same cwd — so the project filter filled with raw dialogue ids.
  Project paths are now normalized once at the index write boundary: those
  directories index as "no project", real folders are unchanged. Adapter
  versions were bumped so the next scan rewrites the affected rows.
- **Shortcut rows read as rows, not cards.** The rows' rounded bottom borders
  no longer bend into an outline around each row: separators are straight
  hairlines. The clear affordance on hover is the reference's red circular ×,
  the empty row shows a bordered +, and Reset to default is a quiet muted action
  instead of the accent-underlined link.
- **Escape closes both rail dropdowns, quietly.** The agent and project lists
  now close on Escape from anywhere on the page (a macOS webview does not focus
  a clicked button, so the trigger-only handler missed the project list), and
  focus returns to the trigger without drawing its focus ring; a second Escape
  changes nothing.
- **One report-toolbar layout in both languages.** The rail's mode switch now
  owns a full row and the date and Generate buttons share the next one, all at
  the same 30 px height; the English labels no longer wrap Generate onto a
  third line or truncate the date.

## 1.8.0 — 2026-11-15

- **Searchable titles.** The index only covered turn text, so a renamed session
  could not be found by its new name unless the same words also appeared in the
  conversation. Titles are now matched through the LIKE path (no FTS change, so
  **no re-index**: the existing index answers on the next query) and returned as
  first-class hits with `matchField: "title"`. Content hits keep their
  order, a session is never listed twice, and the agent / project / starred /
  hidden / date filters apply to title hits too. The UI marks them as
  「标题命中」/ “Title match” instead of inventing a question/answer pair.
- **Quick search palette.** Cmd-Shift-K — or summoning the window with the global
  hotkey while it is hidden — opens a Spotlight-style overlay that searches as
  you type (120 ms debounce against the existing `/api/search`), with
  up/down/Home/End navigation, Enter to open, Cmd-Enter to copy the deep link,
  Esc to close and restore focus, and Tab contained. Cmd-K still focuses the
  topbar search box.
- **Monthly reports and period comparisons.** `sr brief --format month [YYYY-MM]`
  writes `monthly/YYYY-MM.md`; weekly and monthly reports now carry a
  comparison with the previous period (sessions, turns, active projects,
  per-agent share, biggest movers — or an explicit “no previous period data”
  line) plus index-only rankings (top projects by turns, agents by sessions,
  busiest days and hours).
- **Scheduled reports, local only.** `briefSchedule` (`off` |
  `daily` | `weekly`, default `off`) makes the sidecar write the
  current report on its own timer — at most once per period per day, no network,
  no daemon outside the app.
- **MCP:** new read-only `recall_brief` tool returns a generated report's
  Markdown so an agent can read it.
- Release assets keep the `Session-Recall_…` names; a release still carries
  seven assets with no duplicate bytes.

## 1.7.3 — 2026-11-14

- The sidebar's bottom-left slot now holds the daily/weekly report controls (type
  switch, date, Generate) instead of a second copy of the session and turn counts:
  the topbar status line already reports those numbers, with the search timing.
  Generating a report and opening the date picker both work from the new spot.
- The product name is capitalized everywhere it is displayed — the rail wordmark,
  the window title and the page title all read "Session Recall".
- Release assets are named `Session-Recall_...` (the manual-download zips and
  the signed updater archives), and a release still carries seven assets, with no
  asset a byte-for-byte copy of another.

## 1.7.2 — 2026-11-14

- The sidebar now reads in the order the app is meant to be used: the scope
  switch (Q&A / process) sits at the top of the rail, the daily/weekly report
  block moved below the time filter, and the settings gear lives in the brand
  row next to the wordmark. Settings itself is a centered modal now, the
  read-only source list is gone, and so is every update control.
- The “continue in” picker is no longer the OS-native `select`: it is a
  custom popup with the same keyboard and accessibility behaviour as the project
  and agent pickers, and it still starts exactly one handoff prefetch per target.
- When a background check finds a new version the app shows a dialog with the
  version, its release notes, a changelog link and Update now / Later — without
  opening settings. “Later” is remembered per check, so a fresh check re-arms it,
  and the app menu’s Check for Updates… (⌘U) summons the window when it is hidden.
- The macOS app menu regains the standard Edit, Window and Help groups.
- Fixed the changelog link: `window.open` is a silent no-op in the Tauri
  webview, so the link is now handed to the shell through the request-file channel.
- Fixed `[hidden]` being defeated by component `display` rules, which
  painted an empty pill under the search box and left the Update now button
  visible in the “not checked yet” state.
- Releases now ship seven assets instead of eleven: the manual-download zips use
  their stable, version-less names directly, so no asset is a byte-for-byte copy
  of another.

## 1.7.1 — 2026-11-14

- UI fixes from first real use: the agent combobox highlights the selected rows
  (and the keyboard row follows the one you operate on), the session action bar
  fits all six controls on one line, each turn gains separate “copy question”
  and “copy answer” buttons alongside “copy Q&A”, the settings drawer is now a
  centered modal opened from the topbar gear, the daily/weekly report controls
  moved to the top of the sidebar, the role filter control is gone from the UI
  (the `role` parameter stays for CLI, MCP and saved searches), and the search
  placeholder now says “Search anything…”.

## 1.7.0 — 2026-11-14

- Saved searches: save any filter combination with a name from the rail, manage
  them in the settings drawer, and restore a full view in one click. Also
  available via the CLI (`saved list|add|remove`) and a read-only MCP tool.
- Copy Q&A: copy a single turn or the whole conversation as Markdown, with a
  200 KB cap that notes the truncation.
- In-app updates: the app checks for new releases in the background (every
  launch, ~10 s after the window opens; disable with the `checkUpdates`
  preference), shows the new version and its highlights in the settings drawer,
  and installs them with one click — no more manual download to upgrade.

## 1.6.0 — 2026-11-14

- Star and hide sessions, the P0 organization features: schema v6 adds
  `starred`/`hidden` columns with indexes (an `ALTER TABLE` migration that never
  triggers a re-scan, and scans preserve the flags), `POST /api/session/:id/star`
  and `/hide` set them, search excludes hidden sessions by default with
  `starred` and `includeHidden` parameters, facets report `starredCount` and
  `hiddenCount`, the CLI (`sr`) and the MCP tool take the same filters and
  `--json` output carries the flags, and daily, weekly and archive reports skip
  hidden sessions entirely. A hidden session is not deleted: it still opens by
  id, so handoff cards keep working.
- Global shortcut that summons the window from any app: `⌥⌘R` by default,
  configurable through the `hotkey` preference (`null` disables it), with the
  effective value resolvable through `GET /api/hotkey` — `hotkey`, `registered`
  and, on failure, the shell's error with a macOS hint. Registration happens
  once per launch and never blocks the boot; a key changed while the app runs
  applies after a restart. Closing the window with ⌘W now hides it, so the dock
  icon and the shortcut both bring it back. Registration failures (another app
  owns the combination, macOS withholds it) are reported instead of fatal.
- The agent filter is a searchable combobox: typing narrows a long agent list,
  Tab cycling stays inside the popover, moving focus to the system layer no
  longer closes it, and the selected count is singular/plural aware.
- Settings drawer: theme, language, re-index, the last scan time and a read-only
  list of the thirteen sources moved into a slide-over panel opened from a gear
  in the sidebar footer (focus trap, Escape closes, focus restored); session and
  turn counts stay in the sidebar.
- Agent-neutral copy: the interface and the page description say “AI agent”
  instead of “coding agent”.
- The test suite is now 224 tests.

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
