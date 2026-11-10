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

## Composition

- 272px index rail, sticky, with its own scroll and a footer for index stats.
- Main column max 920px, 40px gutters; 18px on mobile.
- Results are full-width rows with a top hairline; no card grid.
- A transcript is a 44px number gutter plus one column of prompts and answers.
- Prompts sit in a bordered surface; answers are open text with Markdown.

## Components

- Agent badge: 8px dot + mono name, colored by agent.
- Theme switch: a three-state segmented control (Auto / Light / Dark) in the
  rail footer. Auto follows the system; the choice persists in `localStorage`.
- Segmented control: 1px border, 2px inner padding, active fill `--surface-3`.
- Project filter: native `<select>` styled with a CSS chevron.
- Hit: 12px radius hover surface; mono `提问` / `回答` labels; 2-line answer
  clamp.
- Process disclosure: one hairline `过程 N 项` toggle per turn, opened lazily;
  inside, one full-width hairline card per reasoning block or tool call.
  Reasoning and tool rows start collapsed; inputs and outputs use mono `pre`.
- Resume command: a bordered mono row under the session meta with a copy button;
  shown only when the agent has a local resume command (omp, OpenCode).
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
