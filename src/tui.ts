/**
 * A terminal UI over the same index the app, the CLI and the MCP server read.
 *
 * No dependency, no server, no window: raw mode on stdin, alternate screen on
 * stdout, one full frame per change. The point is not to be pretty — it is to be
 * installable with `brew install` and usable over ssh, where a macOS app bundle
 * (and its quarantine, its notarization, its deep links) cannot go.
 *
 * The pure parts — key decoding, cell widths, state transitions, frame building
 * — carry no terminal state and are covered by test/tui.test.ts. Everything
 * touching the tty lives in {@link runTui}.
 */

import type { Database } from "bun:sqlite";
import type { AgentId } from "./adapters/types.ts";
import { openDb } from "./db.ts";
import { DB_PATH } from "./config.ts";
import { refreshInBackground } from "./freshness.ts";
import { generateHandoff } from "./handoff.ts";
import { getSessionDetail, searchTurns } from "./search.ts";
import type { SearchSession } from "./search.ts";

export type TuiScope = "qa" | "process";

export interface TuiState {
  query: string;
  scope: TuiScope;
  /** `null` searches every agent. */
  agent: AgentId | null;
  /** Index into {@link TuiState.sessions}. */
  selected: number;
  /** First session row on screen. */
  scroll: number;
  sessions: SearchSession[];
  totalSessions: number;
  tookMs: number;
  /** Which search path produced the result — `fts`, `like`, `recent`. */
  modeLabel: string;
  /** Session whose turns are shown on the right. */
  detailId: string | null;
  detailLines: string[];
  /** First detail line on screen. */
  detailScroll: number;
  focus: "query" | "list" | "detail";
  status: string;
  width: number;
  height: number;
  quit: boolean;
}

export type TuiEffect =
  | { kind: "search" }
  | { kind: "detail"; id: string }
  | { kind: "handoff" }
  | { kind: "rescan" }
  | { kind: "none" };

export type TuiKey =
  | { kind: "text"; value: string }
  | { kind: "enter" }
  | { kind: "escape" }
  | { kind: "backspace" }
  | { kind: "tab" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "pageup" }
  | { kind: "pagedown" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "clear" }
  | { kind: "rescan" }
  | { kind: "handoff" }
  | { kind: "interrupt" };

export const KEYMAP =
  "type to search · ↑↓ move · ⏎ open · esc back · tab scope · ^Y handoff · ^R rescan · ^C quit";

/* ------------------------------------------------------------------ width -- */

/** East Asian wide/fullwidth ranges, as terminal cells. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Terminal cells a string occupies. Tabs count as one, newlines are ignored. */
export function displayWidth(text: string): number {
  let cells = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") continue;
    cells += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return cells;
}

/** Cut to at most `cells` display cells, adding `…` when something was lost. */
export function truncateCells(text: string, cells: number): string {
  if (cells <= 0) return "";
  if (displayWidth(text) <= cells) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + w > cells - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** Right-pad with spaces so the line fills exactly `cells` display cells. */
export function padCells(text: string, cells: number): string {
  const pad = cells - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : truncateCells(text, cells);
}

/** Greedy word wrap on display cells; a long unbroken run is hard-cut. */
export function wrapCells(text: string, cells: number): string[] {
  if (cells <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === "") continue;
      const candidate = line + word;
      if (displayWidth(candidate) <= cells) {
        line = candidate;
        continue;
      }
      if (line.trim() !== "") {
        lines.push(line.replace(/\s+$/, ""));
        line = "";
      }
      if (displayWidth(word) > cells) {
        // A single token wider than the pane (a path, a hash): hard-cut it.
        let rest = word;
        while (displayWidth(rest) > cells) {
          const head = truncateCells(rest, cells);
          lines.push(head.slice(0, -1));
          rest = rest.slice(head.length - 1);
        }
        line = rest;
      } else {
        line = word.replace(/^\s+/, "");
      }
    }
    if (line.trim() !== "") lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

/* ------------------------------------------------------------------- keys -- */

/**
 * Decode one chunk of stdin into keys. Returns the bytes of an incomplete
 * escape sequence or multi-byte character so the caller can prepend them to the
 * next chunk.
 */
export function decodeKeys(input: Uint8Array): { keys: TuiKey[]; rest: Uint8Array } {
  const keys: TuiKey[] = [];
  let i = 0;
  while (i < input.length) {
    const byte = input[i];
    if (byte === 0x1b) {
      // Escape, or a CSI sequence. A lone ESC is a prefix of both, so wait for
      // more bytes unless the buffer plainly ends here.
      if (i + 1 >= input.length) return { keys, rest: input.slice(i) };
      const next = input[i + 1];
      if (next === 0x5b || next === 0x4f) {
        if (i + 2 >= input.length) return { keys, rest: input.slice(i) };
        const code = input[i + 2];
        const map: Record<number, TuiKey> = {
          0x41: { kind: "up" },
          0x42: { kind: "down" },
          0x48: { kind: "home" },
          0x46: { kind: "end" },
        };
        if (code >= 0x30 && code <= 0x39) {
          // Extended form: ESC [ <n> ~
          let j = i + 2;
          let digits = "";
          while (j < input.length && input[j] >= 0x30 && input[j] <= 0x39) {
            digits += String.fromCharCode(input[j]);
            j += 1;
          }
          if (j >= input.length) return { keys, rest: input.slice(i) };
          if (input[j] !== 0x7e) {
            i = j + 1;
            continue;
          }
          if (digits === "5") keys.push({ kind: "pageup" });
          else if (digits === "6") keys.push({ kind: "pagedown" });
          else if (digits === "1" || digits === "7") keys.push({ kind: "home" });
          else if (digits === "4" || digits === "8") keys.push({ kind: "end" });
          i = j + 1;
          continue;
        }
        const mapped = map[code];
        if (mapped) keys.push(mapped);
        // Left/right arrows carry no meaning here; swallow the whole sequence
        // so 0x43 / 0x44 do not reach the query as text.
        i += 3;
        continue;
      }
      keys.push({ kind: "escape" });
      i += 1;
      continue;
    }
    if (byte === 0x03) {
      keys.push({ kind: "interrupt" });
      i += 1;
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      keys.push({ kind: "enter" });
      i += 1;
      continue;
    }
    if (byte === 0x09) {
      keys.push({ kind: "tab" });
      i += 1;
      continue;
    }
    if (byte === 0x7f || byte === 0x08) {
      keys.push({ kind: "backspace" });
      i += 1;
      continue;
    }
    if (byte === 0x15) {
      keys.push({ kind: "clear" });
      i += 1;
      continue;
    }
    if (byte === 0x12) {
      keys.push({ kind: "rescan" });
      i += 1;
      continue;
    }
    if (byte === 0x19) {
      keys.push({ kind: "handoff" });
      i += 1;
      continue;
    }
    if (byte < 0x20) {
      i += 1;
      continue;
    }
    // UTF-8 character: find its length from the leading byte.
    const len =
      byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (i + len > input.length) return { keys, rest: input.slice(i) };
    const chunk = input.slice(i, i + len);
    keys.push({ kind: "text", value: new TextDecoder().decode(chunk) });
    i += len;
  }
  return { keys, rest: new Uint8Array() };
}

/* ------------------------------------------------------------------ state -- */

export function initialState(width: number, height: number): TuiState {
  return {
    query: "",
    scope: "qa",
    agent: null,
    selected: 0,
    scroll: 0,
    sessions: [],
    totalSessions: 0,
    tookMs: 0,
    modeLabel: "recent",
    detailId: null,
    detailLines: [],
    detailScroll: 0,
    focus: "query",
    status: KEYMAP,
    width,
    height,
    quit: false,
  };
}

/** Rows the session list can show: everything between the two chrome rows. */
export function listRows(state: TuiState): number {
  return Math.max(1, state.height - 5);
}

/**
 * Columns the session list gets: 38% of the inner width, bounded to 24–56, and
 * always leaving the detail pane at least one column — a narrow terminal loses
 * the split, never a frame.
 */
export function listCols(state: TuiState): number {
  const inner = Math.max(10, state.width - 2);
  const preferred = Math.min(56, Math.max(24, Math.round(inner * 0.38)));
  const maxLeft = Math.max(8, inner - 13);
  return Math.max(8, Math.min(preferred, maxLeft));
}

function clampSelection(state: TuiState): TuiState {
  if (state.sessions.length === 0) {
    return { ...state, selected: 0, scroll: 0 };
  }
  const selected = Math.max(0, Math.min(state.selected, state.sessions.length - 1));
  const rows = listRows(state);
  let scroll = state.scroll;
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + rows) scroll = selected - rows + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, state.sessions.length - rows)));
  return { ...state, selected, scroll };
}

/**
 * Apply one key. Returns the next state and the side effect the caller must
 * run (a search, a detail load, a clipboard copy, a rescan). Pure: no tty, no
 * database, no clock.
 */
export function reduceKey(
  current: TuiState,
  key: TuiKey,
): { state: TuiState; effect: TuiEffect } {
  const state = current;
  switch (key.kind) {
    case "interrupt":
      return { state: { ...state, quit: true }, effect: { kind: "none" } };
    case "text":
      if (state.focus !== "query") {
        // In list/detail, "j"/"k" move like vim; anything else returns to typing.
        if (key.value === "j" && state.focus === "detail") {
          return {
            state: { ...state, detailScroll: state.detailScroll + 1 },
            effect: { kind: "none" },
          };
        }
        if (key.value === "k" && state.focus === "detail") {
          return {
            state: { ...state, detailScroll: Math.max(0, state.detailScroll - 1) },
            effect: { kind: "none" },
          };
        }
        return {
          state: { ...state, focus: "query", query: state.query + key.value, selected: 0 },
          effect: { kind: "search" },
        };
      }
      return {
        state: { ...state, query: state.query + key.value, selected: 0, scroll: 0 },
        effect: { kind: "search" },
      };
    case "backspace":
      if (state.focus !== "query") {
        return { state: { ...state, focus: "query" }, effect: { kind: "none" } };
      }
      return {
        state: { ...state, query: [...state.query].slice(0, -1).join(""), selected: 0, scroll: 0 },
        effect: { kind: "search" },
      };
    case "clear":
      if (state.query === "") return { state, effect: { kind: "none" } };
      return { state: { ...state, query: "", selected: 0, scroll: 0 }, effect: { kind: "search" } };
    case "escape":
      if (state.focus === "detail") {
        return { state: { ...state, focus: "list", detailScroll: 0 }, effect: { kind: "none" } };
      }
      if (state.query !== "") {
        return { state: { ...state, query: "", selected: 0, scroll: 0 }, effect: { kind: "search" } };
      }
      return { state: { ...state, quit: true }, effect: { kind: "none" } };
    case "tab": {
      const scope: TuiScope = state.scope === "qa" ? "process" : "qa";
      return {
        state: { ...state, scope, selected: 0, scroll: 0, status: `scope: ${scope}` },
        effect: { kind: "search" },
      };
    }
    case "enter": {
      const session = state.sessions[state.selected];
      if (!session) return { state, effect: { kind: "none" } };
      if (state.focus === "detail") return { state, effect: { kind: "none" } };
      return { state: { ...state, focus: "detail", detailScroll: 0 }, effect: { kind: "none" } };
    }
    case "up":
    case "down": {
      if (state.focus === "detail") {
        const delta = key.kind === "up" ? -1 : 1;
        return {
          state: {
            ...state,
            detailScroll: Math.max(0, state.detailScroll + delta),
          },
          effect: { kind: "none" },
        };
      }
      const delta = key.kind === "up" ? -1 : 1;
      const next = clampSelection({ ...state, selected: state.selected + delta });
      const id = next.sessions[next.selected]?.id ?? null;
      return {
        state: { ...next, detailId: id, detailScroll: 0 },
        effect: id && id !== state.detailId ? { kind: "detail", id } : { kind: "none" },
      };
    }
    case "pageup":
    case "pagedown": {
      const page = listRows(state);
      const delta = key.kind === "pageup" ? -page : page;
      if (state.focus === "detail") {
        return {
          state: { ...state, detailScroll: Math.max(0, state.detailScroll + delta) },
          effect: { kind: "none" },
        };
      }
      const next = clampSelection({ ...state, selected: state.selected + delta });
      const id = next.sessions[next.selected]?.id ?? null;
      return {
        state: { ...next, detailId: id, detailScroll: 0 },
        effect: id && id !== state.detailId ? { kind: "detail", id } : { kind: "none" },
      };
    }
    case "home":
      if (state.focus === "detail") {
        return { state: { ...state, detailScroll: 0 }, effect: { kind: "none" } };
      }
      return { state: clampSelection({ ...state, selected: 0 }), effect: { kind: "none" } };
    case "end":
      if (state.focus === "detail") {
        return {
          state: { ...state, detailScroll: Math.max(0, state.detailLines.length - 1) },
          effect: { kind: "none" },
        };
      }
      return {
        state: clampSelection({ ...state, selected: state.sessions.length - 1 }),
        effect: { kind: "none" },
      };
    case "rescan":
      return { state: { ...state, status: "scanning…" }, effect: { kind: "rescan" } };
    case "handoff":
      if (!state.sessions[state.selected]) return { state, effect: { kind: "none" } };
      return { state, effect: { kind: "handoff" } };
    default:
      return { state, effect: { kind: "none" } };
  }
}

/** State after a search returns: new rows, selection reset to the top. */
export function applySearch(
  state: TuiState,
  result: {
    sessions: SearchSession[];
    totalSessions: number;
    tookMs: number;
    mode: "fts" | "like" | "recent" | "process";
  },
): TuiState {
  const next = {
    ...state,
    sessions: result.sessions,
    totalSessions: result.totalSessions,
    tookMs: result.tookMs,
    modeLabel: result.mode,
    selected: 0,
    scroll: 0,
    status: KEYMAP,
  };
  const id = result.sessions[0]?.id ?? null;
  return { ...next, detailId: id, detailScroll: 0 };
}

/* ----------------------------------------------------------------- render -- */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";
const CYAN = "\x1b[36m";

function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One session row: `MM-DD  agent  Title`, cut to the pane width. */
export function sessionRow(session: SearchSession, cols: number): string {
  const date = isoDay(session.updatedAt);
  const agent = padCells(session.agent, 9);
  const text = `${date}  ${agent} ${session.title}`;
  return truncateCells(text, cols);
}

/**
 * A whole screen as lines, each exactly `width` cells. The caller writes them
 * top to bottom; nothing here touches stdout.
 */
export function buildFrame(state: TuiState): string[] {
  const width = Math.max(20, state.width);
  const height = Math.max(6, state.height);
  const inner = width - 2;
  const rows: string[] = [];

  const title = ` session-recall `;
  const meta = `${state.totalSessions} sessions · ${Math.round(state.tookMs)}ms · ${state.modeLabel} · ${state.scope} `;
  const titleBar = `┌${title}${"─".repeat(Math.max(0, inner - displayWidth(title) - displayWidth(meta)))}${meta}┐`;
  rows.push(padCells(titleBar, width));

  const prompt = `> ${state.query}`;
  const caret = state.focus === "query" ? "_" : " ";
  rows.push(`│${padCells(`${prompt}${caret}`, inner)}│`);

  const left = listCols(state);
  const right = Math.max(1, inner - left - 1);
  // Five chrome rows: header, prompt, separator, status, bottom border.
  const bodyRows = Math.max(1, height - 5);

  // Colour is applied AFTER the cell maths: an escape sequence is zero cells
  // wide, but counting its bytes as characters would shift every column.
  const listLines: string[] = [];
  for (let i = state.scroll; i < Math.min(state.sessions.length, state.scroll + bodyRows); i += 1) {
    const session = state.sessions[i];
    const isSelected = i === state.selected;
    const plain = padCells(` ${sessionRow(session, left - 2)}`, left);
    listLines.push(isSelected ? REVERSE + plain + RESET : DIM + plain + RESET);
  }
  if (listLines.length === 0) listLines.push(DIM + padCells("  no sessions", left) + RESET);

  const detail: string[] = state.detailLines;

  for (let row = 0; row < bodyRows; row += 1) {
    const lineIndex = row + state.detailScroll;
    const leftCell = listLines[row] ?? " ".repeat(left);
    const plainRight = padCells(detail[lineIndex] ?? "", right);
    rows.push(`│${leftCell}│${CYAN}${plainRight}${RESET}│`);
  }

  const separator = `├${"─".repeat(left)}┴${"─".repeat(right)}┤`;
  rows.push(padCells(separator, width));

  const status = state.status || KEYMAP;
  rows.push(`│${padCells(` ${status}`, inner)}│`);
  rows.push(padCells(`└${"─".repeat(inner)}┘`, width));

  return rows.slice(0, height);
}

/**
 * The right pane for one session, already wrapped to `cols` cells. Plain text
 * only — {@link buildFrame} pads to width first and colours second.
 */
export function renderTurns(
  turns: { idx: number; user_text: string; assistant_text: string }[],
  cols: number,
): string[] {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(`── turn ${turn.idx + 1} ──`);
    for (const line of wrapCells(turn.user_text ?? "", cols - 2)) lines.push(`u│ ${line}`);
    for (const line of wrapCells(turn.assistant_text ?? "", cols - 2)) lines.push(`a│ ${line}`);
    lines.push("");
  }
  return lines;
}

/* -------------------------------------------------------------------- tty -- */

function out(text: string): void {
  Bun.write(Bun.stdout, text);
}

function render(state: TuiState): void {
  const frame = buildFrame(state);
  // Home, then each line followed by an erase so a shorter line cannot leave
  // the tail of a longer previous one behind.
  out(`\x1b[H${frame.map((line, i) => (i === 0 ? line : line)).join("\x1b[K\r\n")}\x1b[K`);
}

function copyToClipboard(text: string): boolean {
  const candidates =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  for (const cmd of candidates) {
    try {
      const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface RunTuiOptions {
  dbPath?: string;
  width?: number;
  height?: number;
}

/** Run the TUI until the user quits. Owns the terminal for the whole time. */
export async function runTui(options: RunTuiOptions = {}): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("tui: needs a terminal (run it directly, not through a pipe)");
    return 1;
  }

  const dbPath = options.dbPath ?? DB_PATH;
  const db = openDb(dbPath);
  // A pty can report 0 columns (under `script`, some CI shells). Fall back to
  // the conventional 80x24 rather than rendering a 20-column frame, and let
  // SESSION_RECALL_TUI_SIZE force a size for screenshots and tests.
  const size = () => {
    const forced = process.env.SESSION_RECALL_TUI_SIZE;
    if (forced) {
      const [w, h] = forced.split("x").map(Number);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    return {
      width: options.width ?? (process.stdout.columns || 80),
      height: options.height ?? (process.stdout.rows || 24),
    };
  };
  let state = initialState(size().width, size().height);

  const search = (current: TuiState): TuiState => {
    const result = searchTurns(db, {
      q: current.query,
      agents: current.agent ? [current.agent] : [],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: current.scope,
      limit: Math.max(20, listRows(current)),
      offset: 0,
    });
    const next = applySearch(current, result);
    if (next.detailId) return { ...next, ...loadDetail(next, next.detailId) };
    return { ...next, detailLines: [] };
  };

  const loadDetail = (current: TuiState, id: string): Partial<TuiState> => {
    const detail = getSessionDetail(db, id) as
      | { turns: { idx: number; user_text: string; assistant_text: string }[] }
      | null;
    const cols = Math.max(10, current.width - listCols(current) - 3);
    // The newest turns are the ones worth reading when picking up old work.
    const recent = detail ? detail.turns.slice(-40) : [];
    return { detailLines: renderTurns(recent, cols) };
  };

  const restore = () => {
    out("\x1b[?25h\x1b[?1049l");
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      // The terminal may already be gone; nothing to restore.
    }
  };

  out("\x1b[?1049h\x1b[?25l");
  process.on("SIGWINCH", () => {
    const s = size();
    state = { ...state, width: s.width, height: s.height };
    render(state);
  });

  // Paint the chrome before the first query: a cold index can take a few
  // hundred milliseconds, and a blank screen looks like a hang.
  state = { ...state, status: "reading the index…" };
  render(state);
  state = search(state);
  render(state);

  const reader = Bun.stdin.stream().getReader();
  let pending = new Uint8Array();

  try {
    process.stdin.setRawMode?.(true);
    while (!state.quit) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending);
      merged.set(value, pending.length);
      const { keys, rest } = decodeKeys(merged);
      pending = rest;
      for (const key of keys) {
        const { state: next, effect } = reduceKey(state, key);
        state = next;
        if (effect.kind === "search") {
          state = search(state);
        } else if (effect.kind === "detail") {
          state = { ...state, ...loadDetail(state, effect.id) };
        } else if (effect.kind === "handoff") {
          const session = state.sessions[state.selected];
          const card = session ? generateHandoff(db, session.id) : null;
          const ok = card ? copyToClipboard(card) : false;
          state = {
            ...state,
            status: ok ? "handoff card copied to clipboard" : "could not copy handoff card",
          };
        } else if (effect.kind === "rescan") {
          // Fire-and-forget scan; the lock decides whether one really starts.
          const started = refreshInBackground(dbPath, { ageMs: null });
          state = {
            ...state,
            status:
              started === "started"
                ? "rescanning… results update as you keep typing"
                : "a scan is already running",
          };
        }
        if (state.quit) break;
      }
      render(state);
    }
  } finally {
    reader.releaseLock();
    restore();
    db.close();
  }
  return 0;
}
