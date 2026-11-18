import { expect, test } from "bun:test";
import {
  applySearch,
  buildFrame,
  decodeKeys,
  displayWidth,
  initialState,
  listCols,
  padCells,
  reduceKey,
  renderTurns,
  sessionRow,
  truncateCells,
  wrapCells,
} from "../src/tui.ts";
import type { TuiState } from "../src/tui.ts";
import type { SearchSession } from "../src/search.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (line: string) => line.replace(ANSI, "");

function sessionRowFixture(id: string, title: string): SearchSession {
  return {
    id,
    agent: "omp",
    title,
    projectPath: "/tmp/project",
    updatedAt: Date.UTC(2026, 10, 18),
    starred: false,
    hidden: false,
    hits: [],
    hitCount: 0,
    processHits: [],
    processHitCount: 0,
  };
}

function stateWith(sessions: SearchSession[], width = 80, height = 24): TuiState {
  return {
    ...initialState(width, height),
    sessions,
    totalSessions: sessions.length,
    selected: 0,
    detailId: sessions[0]?.id ?? null,
    detailLines: ["hello", "world"],
  };
}

test("counts CJK as two cells and latin as one", () => {
  expect(displayWidth("abc")).toBe(3);
  expect(displayWidth("中文")).toBe(4);
  expect(displayWidth("a中")).toBe(3);
  expect(displayWidth("")).toBe(0);
});

test("truncation never exceeds the cell budget and marks the cut", () => {
  expect(truncateCells("abcdef", 4)).toBe("abc…");
  expect(truncateCells("中文测试", 5)).toBe("中文…");
  expect(truncateCells("abc", 10)).toBe("abc");
  expect(truncateCells("abc", 0)).toBe("");
  for (const budget of [1, 2, 3, 5, 9]) {
    expect(displayWidth(truncateCells("中文abc测试", budget))).toBeLessThanOrEqual(budget);
  }
});

test("padding fills exactly the requested cells", () => {
  expect(displayWidth(padCells("abc", 6))).toBe(6);
  expect(displayWidth(padCells("中文", 7))).toBe(7);
  // Over-budget input is truncated instead of overflowing.
  expect(displayWidth(padCells("中文测试", 3))).toBeLessThanOrEqual(3);
});

test("wrapping keeps words whole and hard-cuts a single long token", () => {
  expect(wrapCells("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  expect(wrapCells("a".repeat(25), 10).length).toBe(3);
  for (const line of wrapCells("a".repeat(25), 10)) {
    expect(displayWidth(line)).toBeLessThanOrEqual(10);
  }
  // Blank lines survive, so a paragraph break is not lost.
  expect(wrapCells("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
  // A Chinese sentence wraps on cells, not on code points.
  for (const line of wrapCells("会话检索工具".repeat(4), 12)) {
    expect(displayWidth(line)).toBeLessThanOrEqual(12);
  }
});

test("decodes arrows, control keys and UTF-8 text", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  expect(decodeKeys(enc("a")).keys).toEqual([{ kind: "text", value: "a" }]);
  expect(decodeKeys(enc("\x1b[A")).keys).toEqual([{ kind: "up" }]);
  expect(decodeKeys(enc("\x1b[B")).keys).toEqual([{ kind: "down" }]);
  expect(decodeKeys(enc("\x03")).keys).toEqual([{ kind: "interrupt" }]);
  expect(decodeKeys(enc("\x12")).keys).toEqual([{ kind: "rescan" }]);
  expect(decodeKeys(enc("\x19")).keys).toEqual([{ kind: "handoff" }]);
  expect(decodeKeys(enc("\x15")).keys).toEqual([{ kind: "clear" }]);
  expect(decodeKeys(enc("\x7f")).keys).toEqual([{ kind: "backspace" }]);
  expect(decodeKeys(enc("中")).keys).toEqual([{ kind: "text", value: "中" }]);

  // A lone ESC and a half-received character are held back for the next read.
  const lone = decodeKeys(enc("\x1b"));
  expect(lone.keys).toEqual([]);
  expect(lone.rest.length).toBe(1);

  const partial = decodeKeys(new Uint8Array([0xe4, 0xb8]));
  expect(partial.keys).toEqual([]);
  expect(partial.rest.length).toBe(2);

  // A complete chunk plus a dangling prefix returns both parts.
  const mixed = decodeKeys(new Uint8Array([0x61, 0x1b]));
  expect(mixed.keys).toEqual([{ kind: "text", value: "a" }]);
  expect(mixed.rest.length).toBe(1);
});

test("typing appends to the query and asks for a new search", () => {
  const state = stateWith([sessionRowFixture("omp:1", "title")]);
  const { state: next, effect } = reduceKey(state, { kind: "text", value: "c" });
  expect(next.query).toBe("c");
  expect(next.selected).toBe(0);
  expect(effect).toEqual({ kind: "search" });
});

test("escape clears the query first, then quits", () => {
  const withQuery = { ...stateWith([]), query: "cindy" };
  const cleared = reduceKey(withQuery, { kind: "escape" });
  expect(cleared.state.query).toBe("");
  expect(cleared.state.quit).toBe(false);

  const quits = reduceKey(cleared.state, { kind: "escape" });
  expect(quits.state.quit).toBe(true);
});

test("tab flips the scope and asks for a new search", () => {
  const { state, effect } = reduceKey(stateWith([]), { kind: "tab" });
  expect(state.scope).toBe("process");
  expect(effect).toEqual({ kind: "search" });
});

test("enter opens the detail pane only when a session is selected", () => {
  const empty = reduceKey(stateWith([]), { kind: "enter" });
  expect(empty.state.focus).toBe("query");

  const one = reduceKey(stateWith([sessionRowFixture("omp:1", "t")]), { kind: "enter" });
  expect(one.state.focus).toBe("detail");
});

test("moving down loads the next session's turns and clamps at the end", () => {
  const state = stateWith([
    sessionRowFixture("omp:1", "first"),
    sessionRowFixture("omp:2", "second"),
  ]);
  const down = reduceKey(state, { kind: "down" });
  expect(down.state.selected).toBe(1);
  expect(down.effect).toEqual({ kind: "detail", id: "omp:2" });

  const past = reduceKey(down.state, { kind: "down" });
  expect(past.state.selected).toBe(1);
  expect(past.effect).toEqual({ kind: "none" });
});

test("ctrl-y asks for a handoff only when a session is selected", () => {
  expect(reduceKey(stateWith([]), { kind: "handoff" }).effect).toEqual({ kind: "none" });
  expect(
    reduceKey(stateWith([sessionRowFixture("omp:1", "t")]), { kind: "handoff" }).effect,
  ).toEqual({ kind: "handoff" });
});

test("a new result set resets the selection to the top", () => {
  const state = { ...stateWith([sessionRowFixture("omp:1", "a")]), selected: 3 };
  const next = applySearch(state, {
    sessions: [sessionRowFixture("omp:9", "z")],
    totalSessions: 1,
    tookMs: 4,
    mode: "fts",
  });
  expect(next.selected).toBe(0);
  expect(next.detailId).toBe("omp:9");
  expect(next.modeLabel).toBe("fts");
});

test("every frame line is exactly the terminal width", () => {
  const sessions = [
    sessionRowFixture("omp:1", "cindy 数据库打不开"),
    sessionRowFixture("omp:2", "a very long title that will need truncation somewhere"),
  ];
  for (const [width, height] of [
    [80, 24],
    [100, 30],
    [40, 12],
    [20, 6],
  ]) {
    const frame = buildFrame({ ...stateWith(sessions, width, height), detailScroll: 2 });
    expect(frame.length).toBe(height);
    for (const line of frame) {
      expect(displayWidth(strip(line))).toBe(width);
    }
  }
});

test("a session row fits the list column", () => {
  for (const cols of [12, 24, 40]) {
    const row = sessionRow(sessionRowFixture("omp:1", "中文标题很长很长"), cols);
    expect(displayWidth(row)).toBeLessThanOrEqual(cols);
  }
});

test("the list column never starves the detail pane", () => {
  for (const width of [30, 60, 120, 200]) {
    const side = listCols({ ...initialState(width, 24) });
    expect(side).toBeGreaterThanOrEqual(12);
    expect(width - side - 3).toBeGreaterThanOrEqual(12);
  }
});

test("rendered turns stay inside the pane and keep both speakers", () => {
  const lines = renderTurns(
    [
      { idx: 0, user_text: "问题是什么", assistant_text: "答案是中文长文本".repeat(6) },
      { idx: 1, user_text: "再问一次", assistant_text: "" },
    ],
    20,
  );
  expect(lines.some((line) => line.startsWith("u│"))).toBe(true);
  expect(lines.some((line) => line.startsWith("a│"))).toBe(true);
  for (const line of lines) {
    expect(line).not.toContain("\x1b");
    expect(displayWidth(line)).toBeLessThanOrEqual(20);
  }
});
