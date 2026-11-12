# Design

## Direction

A working archive, not a chat dashboard. The interface behaves like a card
catalog for past work: a fixed index rail on the left, a single oversized query
line, and result entries separated by hairlines instead of nested cards. The
content is the evidence; the chrome recedes.

Mode: **Operate**. Precision and restraint over expression.

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f2f3ef` | `#141715` | page ground, cool paper |
| `--surface` | `#fbfbf8` | `#1b1f1c` | prompt block |
| `--surface-2` | `#eaede5` | `#232824` | hover, code chrome |
| `--ink` | `#1d201d` | `#e6eae3` | body text |
| `--muted` | `#5f665e` | `#a2aaa0` | secondary text |
| `--faint` | `#7b837a` | `#858e83` | labels, metadata |
| `--line` | `#d9dcd3` | `#2c322d` | hairlines |
| `--accent` | `#2f6b58` | `#7cc4a7` | links, focus, active |
| `--accent-soft` | `#e0ebe5` | `#22352c` | selected filter |
| `--mark` | `#cfe4d8` | `#2f4a3d` | search hit |
| `--agent-cursor` | `#2f5f9e` | `#8ab4f8` | Cursor |
| `--agent-opencode` | `#276b45` | `#7cc9a0` | OpenCode |
| `--agent-omp` | `#63499c` | `#b9a4ff` | omp |

Color strategy: restrained. Neutral ground, one green accent, agent hues only
on dots and labels.

## Type

- UI and body: system sans (`-apple-system`, `PingFang SC`, `Microsoft YaHei`).
- Metadata, counts, labels: system mono (`SF Mono`, `ui-monospace`).
- Scale: 10.5px labels, 12px meta, 14.5px body, 16.5px session title, 28px page
  title, 22px query line, 30px transcript title.
- Body measure stays under 75ch inside the 920px content column.

Known drift: `web/styles.css` still carries several off-scale sizes (9.5, 10,
11, 11.5, 12.5, 13, 13.5, 15, 18–24 …) on top of the seven above. Consolidating
onto the scale is an open cleanup; new UI should use one of the seven sizes
instead of adding another.

## Composition

- 272px index rail, sticky, with its own scroll and a footer for index stats.
- Main column max 920px, 40px gutters; 18px on mobile.
- Results are full-width rows with a top hairline; no card grid.
- A transcript is a 44px number gutter plus one column of prompts and answers.
- Prompts sit in a bordered surface; answers are open text with Markdown.

## Components

- Agent badge: 8px dot + mono name, colored by agent.
- Report controls: a 日报 / 周报 segmented control above the date row in the rail
  footer. In 周报 the date button shows the ISO week range the chosen day falls
  in (`11/09–11/15`) and 生成 writes `<app dir>/brief/weekly/<week>.md`; the
  generated report opens in-app at `#/brief/<week>?format=week`.
- Date picker: a self-drawn calendar popover rather than `<input type="date">`,
  whose popup belongs to the OS/browser and cannot follow the theme. Monday-first
  (matching ISO weeks), 42 cells, today outlined, selection filled with the
  accent, arrows navigate months, PageUp/PageDown jump months, Home/End go to the
  week's ends, Enter picks, Escape closes and returns focus to the button.
- Theme switch: a three-state segmented control (Auto / Light / Dark) in the
  rail footer. Auto follows the system; the choice persists server-side in
  `<app dir>/prefs.json`, so it survives the port changing between launches
  (`localStorage` is only a first-paint cache for the current origin).
- Segmented control: 1px border, 2px inner padding, active fill `--surface-3`.
- Search scope: a two-state segmented control next to the query (`问答` / `过程`);
  process mode hides the role filter and relabels each hit with its match field,
  tool name, and status (`bash · error`).
- Results sort by session last activity, newest first; within a session, newest
  matching turn first. When the loaded row window covers only part of the
  sessions, the footer offers `显示更多` rather than hiding the remainder.
- A result hit that matched an answer scrolls to the answer block, not merely
  the top of its turn; the matched block gets an accent label.
- Project filter: a custom combobox — a `role="combobox"` trigger button plus a
  `role="listbox"` panel, because a native `<select>` popup cannot be styled.
  Full keyboard support (arrows, Home/End, Enter, Escape) and one clean focus
  ring, hugging the control instead of floating outside its border.
- Back to top: a floating button pinned to the bottom-right of the content
  column, shown once the page is scrolled past ~400px. Sessions open on a
  matched turn, so this is the way back up.
- Hit: 12px radius hover surface; mono `提问` / `回答` labels; 2-line answer
  clamp. The `回答` label carries the agent name and, when the index recorded
  one, the model that produced the answer in faint small text.
- Process disclosure: one hairline `过程 N 项` toggle per turn, opened lazily;
  inside, one full-width hairline card per reasoning block or tool call.
  Reasoning and tool rows start collapsed; inputs and outputs use mono `pre`.
  A process-search hit deep-links to its event sequence, opens that row, outlines
  it in accent, and scrolls it below the sticky action bar.
- Sticky action bar: the resume command and handoff button live in a thin bar
  directly below the session header; it pins under the query bar while scrolling
  so a jumped-to answer cannot push them out of view. The top offset follows the
  measured topbar height.
- Resume command: a bordered mono row in the action bar with a copy button;
  shown only when the agent has a local resume command (omp, OpenCode).
- Handoff button: a small mono button beside the resume row; it is disabled
  while the card is prefetched, then copies the Markdown card on click.
- Daily brief: a date input plus `生成简报` in the rail footer; success becomes
  `在线查看` (rendered in the content column) and `下载 .md`.
- Empty state: dashed hairline box, direct recovery copy.
- Focus: 2px accent outline, offset 2px.
- Scrollbars: thin, palette-tinted, 2px transparent border.

## Motion

One authored moment: the result list appears without choreography; skeletons
breathe while a query runs. All transitions respect `prefers-reduced-motion`.

## States

- Empty index: tells the owner to run `bun run scan`.
- No results: suggests shorter terms, the role toggle, and clearing filters.
- Loading: skeleton lines; the query status reads `搜索中…`.
- Error: names the failure and offers retry.
- Truncated transcript: says the index cut the text.
