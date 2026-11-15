import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSessionFlag, writeSession } from "../src/db.ts";
import { parseTerms, searchTurns } from "../src/search.ts";
import type { ParsedSession } from "../src/adapters/types.ts";
import type { SearchParams } from "../src/search.ts";

/**
 * Title search (1.8.0): a session whose title matches the query terms must
 * surface as a first-class result even when no turn matches. The pass is
 * LIKE-based over `session.title` — no FTS table change, so no re-index.
 */

const dir = mkdtempSync(join(tmpdir(), "session-recall-title-"));
const db = openDb(join(dir, "index.db"));

const base: SearchParams = {
  q: "",
  agents: [],
  project: "",
  from: null,
  to: null,
  role: "all",
  scope: "qa",
  limit: 20,
  offset: 0,
};

function session(
  externalId: string,
  title: string,
  turns: ParsedSession["turns"],
): ParsedSession {
  return {
    agent: "omp",
    externalId,
    projectPath: "/tmp/project",
    title,
    startedAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
    sourceKind: "jsonl",
    sourcePath: `/tmp/${externalId}.jsonl`,
    fingerprint: "1",
    turns,
  };
}

const turn = (userText: string): ParsedSession["turns"][number] => ({
  idx: 0,
  ts: Date.UTC(2026, 9, 1),
  userText,
  assistantText: "回答内容。",
});

// Title-only: the phrase appears only in the title, nowhere in the turns.
writeSession(
  db,
  session("title-only", "区块链重构方案 v2", [turn("讨论一个普通的功能问题")]),
);
// Title and content both match: must appear exactly once.
writeSession(
  db,
  session("title-content", "区块链性能优化", [turn("区块链的 TPS 怎么提升")]),
);
// English title with a term that is only in the title.
writeSession(
  db,
  session("en-title", "websocket backoff redesign", [turn("关于缓存的问题")]),
);
// Chinese title, short term (the LIKE path for CJK).
writeSession(
  db,
  session("zh-title", "支付网关幂等改造", [turn("讨论了其他事情")]),
);
// A session that must not match any of the above.
writeSession(
  db,
  session("unrelated", "完全无关的标题", [turn("支付网关的幂等性")]),
);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a title-only match surfaces the session with matchField title", () => {
  const result = searchTurns(db, { ...base, q: "重构方案" });
  const titles = result.sessions.map((s) => s.title);
  expect(titles).toContain("区块链重构方案 v2");
  const hit = result.sessions
    .find((s) => s.title === "区块链重构方案 v2")!
    .hits[0]!;
  expect(hit.matchField).toBe("title");
  // The snippet is the title itself, which is what the result row renders.
  expect(hit.snippet).toContain("区块链重构方案");
  expect(hit.turnId).toBe(-1);
});

test("a session whose title and content both match appears exactly once", () => {
  const result = searchTurns(db, { ...base, q: "区块链" });
  const matches = result.sessions.filter((s) =>
    s.title.includes("区块链"),
  );
  const ids = matches.map((s) => s.id);
  expect(ids).toContain("omp:title-content");
  // No duplicate: the content-matched session is not re-appended by the title
  // pass, and each session appears once in the list.
  expect(ids.filter((id) => id === "omp:title-content")).toHaveLength(1);
  // The content hit still ranks the session (content match first).
  const content = matches.find((s) => s.id === "omp:title-content")!;
  expect(content.hits[0]!.matchField).not.toBe("title");
});

test("turn-matched sessions come before title-only sessions", () => {
  const result = searchTurns(db, { ...base, q: "区块链" });
  const order = result.sessions.map((s) => s.id);
  const contentIdx = order.indexOf("omp:title-content");
  const titleIdx = order.indexOf("omp:title-only");
  expect(contentIdx).toBeGreaterThanOrEqual(0);
  expect(titleIdx).toBeGreaterThanOrEqual(0);
  expect(contentIdx).toBeLessThan(titleIdx);
});

test("the agent filter applies to title matches", () => {
  writeSession(
    db,
    { ...session("cursor-title", "区块链 cursor 专用", [turn("x")]), agent: "cursor" },
  );
  const onlyOmp = searchTurns(db, { ...base, q: "区块链", agents: ["omp"] });
  const titles = onlyOmp.sessions.map((s) => s.title);
  expect(titles).toContain("区块链重构方案 v2");
  expect(titles).not.toContain("区块链 cursor 专用");
  const withCursor = searchTurns(db, {
    ...base,
    q: "区块链",
    agents: ["omp", "cursor"],
  });
  expect(
    withCursor.sessions.map((s) => s.title),
  ).toContain("区块链 cursor 专用");
});

test("the project filter applies to title matches", () => {
  const others = searchTurns(db, {
    ...base,
    q: "重构方案",
    project: "/tmp/other",
  });
  expect(others.sessions).toHaveLength(0);
  const mine = searchTurns(db, { ...base, q: "重构方案", project: "/tmp/project" });
  expect(
    mine.sessions.map((s) => s.title),
  ).toContain("区块链重构方案 v2");
});

test("the starred filter applies to title matches the same way to content", () => {
  // The starred flag is opt-in (only applied when true), matching the content
  // path; with starred: true the title-matched session survives and the
  // unstarred title-only session does not.
  expect(setSessionFlag(db, "omp", "title-content", "starred", true)).not.toBeNull();
  const starred = searchTurns(db, { ...base, q: "区块链", starred: true });
  const titles = starred.sessions.map((s) => s.title);
  expect(titles).toContain("区块链性能优化");
  expect(titles).not.toContain("区块链重构方案 v2");
  // Without the flag no starred clause is added (opt-in, same as content).
  const all = searchTurns(db, { ...base, q: "区块链" });
  expect(
    all.sessions.map((s) => s.title),
  ).toContain("区块链重构方案 v2");
  // Title matches respect hidden exclusion the same way content matches do.
  setSessionFlag(db, "omp", "title-only", "hidden", true);
  const hidden = searchTurns(db, { ...base, q: "重构方案" });
  expect(
    hidden.sessions.map((s) => s.title),
  ).not.toContain("区块链重构方案 v2");
  const shownAgain = searchTurns(db, {
    ...base,
    q: "重构方案",
    includeHidden: true,
  });
  expect(
    shownAgain.sessions.map((s) => s.title),
  ).toContain("区块链重构方案 v2");
});

test("English titles match through the same pass", () => {
  const result = searchTurns(db, { ...base, q: "backoff" });
  expect(
    result.sessions.map((s) => s.title),
  ).toContain("websocket backoff redesign");
});

test("Chinese titles and short CJK terms match (LIKE path)", () => {
  const result = searchTurns(db, { ...base, q: "支付网关" });
  expect(
    result.sessions.map((s) => s.title),
  ).toContain("支付网关幂等改造");
  const short = searchTurns(db, { ...base, q: "幂等" });
  expect(
    short.sessions.map((s) => s.title),
  ).toContain("支付网关幂等改造");
});

test("title terms use AND semantics like content terms", () => {
  const result = searchTurns(db, { ...base, q: "区块链 幂等" });
  const titles = result.sessions.map((s) => s.title);
  // 区块链重构方案 v2 has no 幂等 in the title; 支付网关幂等改造 has no 区块链.
  expect(titles).not.toContain("区块链重构方案 v2");
  expect(titles).not.toContain("支付网关幂等改造");
});

test("an empty query is unchanged: the title pass never runs", () => {
  const result = searchTurns(db, { ...base, q: "" });
  expect(result.mode).toBe("recent");
  // No hit carries the title marker: the pass only runs for a non-empty query,
  // so recent mode output is exactly what it was before this change.
  const hitFields = result.sessions.flatMap((s) => s.hits.map((h) => h.matchField));
  expect(hitFields).not.toContain("title");
});

test("parseTerms is shared by the title pass (quotes and AND)", () => {
  expect(parseTerms('"重构方案" 支付')).toEqual(["重构方案", "支付"]);
});
