import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, writeSession } from "../src/db.ts";
import { parseTerms, searchTurns } from "../src/search.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-test-"));
const db = openDb(join(dir, "index.db"));

const base = {
  q: "",
  agents: [] as ("omp" | "opencode" | "cursor")[],
  project: "",
  from: null,
  to: null,
  role: "all" as const,
  scope: "qa" as const,
  limit: 20,
  offset: 0,
};

function session(id: string, turns: ParsedSession["turns"]): ParsedSession {
  return {
    agent: "omp",
    externalId: id,
    projectPath: "/tmp/project",
    title: id,
    startedAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
    sourceKind: "jsonl",
    sourcePath: `/tmp/${id}.jsonl`,
    fingerprint: "1",
    turns,
  };
}

writeSession(
  db,
  session("alpha", [
    {
      idx: 0,
      ts: Date.UTC(2026, 9, 1),
      userText: "common 目录范围怎么控制",
      assistantText: "通过角色范围控制",
    },
  ]),
);
const beta = session("beta", [
  {
    idx: 0,
    ts: Date.UTC(2026, 9, 2),
    userText: "common findFileByName 查询",
    assistantText: "按名称模糊匹配",
  },
]);
beta.updatedAt = Date.UTC(2026, 9, 3);
writeSession(db, beta);

// A line-wrapped transcript: the phrase carries a space the user would not type.
writeSession(
  db,
  session("gamma", [
    {
      idx: 0,
      ts: Date.UTC(2026, 9, 4),
      userText: "worker 使用不 同的模型协同工作",
      assistantText: "按角色分配模型",
    },
  ]),
);
// The same wrap inside the answer, for the role filter.
writeSession(
  db,
  session("delta", [
    {
      idx: 0,
      ts: Date.UTC(2026, 9, 5),
      userText: "怎么做",
      assistantText: "可以 使用 不 同的模型协同",
    },
  ]),
);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("parses quoted and bare terms", () => {
  expect(parseTerms('"目录 范围" find')).toEqual(["目录 范围", "find"]);
});

test("trigram search finds Chinese phrases", () => {
  const result = searchTurns(db, { ...base, q: "目录范围" });
  expect(result.sessions.length).toBe(1);
  expect(result.sessions[0]?.id).toBe("omp:alpha");
});

test("a Chinese run the phrase search misses is retried word by word", () => {
  const cjkDir = mkdtempSync(join(tmpdir(), "session-recall-cjk-"));
  const cjkDb = openDb(join(cjkDir, "index.db"));
  writeSession(
    cjkDb,
    session("gamma", [
      {
        idx: 0,
        ts: Date.UTC(2026, 9, 1),
        userText: "cindy 那个数据库一直打不开，最后发现是路径变了",
        assistantText: "先看 cindy 的路径",
      },
    ]),
  );

  // The index stores 数据库 and 打不开 apart; the six-rune run is one phrase
  // the text never contains, so the plain trigram pass comes up empty.
  const relaxed = searchTurns(cjkDb, { ...base, q: "数据库打不开" });
  expect(relaxed.sessions.length).toBe(1);
  // The echo stays what the user typed, not the chunks that matched.
  expect(relaxed.terms).toEqual(["数据库打不开"]);

  expect(searchTurns(cjkDb, { ...base, q: "cindy 数据库打不开" }).sessions.length).toBe(1);

  // Splitting must not turn into a match-anything: a word that is absent
  // still rules the session out.
  expect(searchTurns(cjkDb, { ...base, q: "cindy 数据库打不开 zzzqqq" }).sessions.length).toBe(0);

  cjkDb.close();
  rmSync(cjkDir, { recursive: true, force: true });
});

test("two-character Chinese falls back to LIKE", () => {
  const result = searchTurns(db, { ...base, q: "目录" });
  expect(result.mode).toBe("like");
  expect(result.sessions.length).toBe(1);
});

test("identifier search works", () => {
  const result = searchTurns(db, { ...base, q: "findFileByName" });
  expect(result.sessions.length).toBe(1);
  expect(result.sessions[0]?.id).toBe("omp:beta");
});

test("orders sessions by last activity", () => {
  const result = searchTurns(db, { ...base, q: "common" });
  expect(result.sessions.map((session) => session.id)).toEqual([
    "omp:beta",
    "omp:alpha",
  ]);
});

test("role filter searches only prompts", () => {
  const miss = searchTurns(db, { ...base, q: "角色范围", role: "user" });
  expect(miss.sessions.length).toBe(0);
  const hit = searchTurns(db, { ...base, q: "角色范围", role: "all" });
  expect(hit.sessions.length).toBe(1);
});

test("empty query lists one prompt per session", () => {
  const result = searchTurns(db, { ...base, q: "" });
  expect(result.mode).toBe("recent");
  expect(result.sessions.length).toBe(4);
  expect(result.sessions.every((session) => session.hits.length === 1)).toBe(true);
});

test("combines an agent filter with a trigram FTS query", () => {
  const hit = searchTurns(db, { ...base, q: "findFileByName", agents: ["omp"] });
  expect(hit.mode).toBe("fts");
  expect(hit.sessions.map((session) => session.id)).toEqual(["omp:beta"]);

  const miss = searchTurns(db, { ...base, q: "findFileByName", agents: ["cursor"] });
  expect(miss.sessions).toHaveLength(0);
});

test("combines a project filter with a trigram FTS query", () => {
  const hit = searchTurns(db, { ...base, q: "findFileByName", project: "/tmp/project" });
  expect(hit.sessions.map((session) => session.id)).toEqual(["omp:beta"]);
});

test("an unspaced Chinese phrase finds the line-wrapped spelling", () => {
  const result = searchTurns(db, { ...base, q: "使用不同的模型协同" });
  expect(result.sessions.map((session) => session.id)).toContain("omp:gamma");
});

test("the wrapped spelling keeps working too", () => {
  const result = searchTurns(db, { ...base, q: "使用不 同的模型协同" });
  expect(result.sessions.map((session) => session.id)).toContain("omp:gamma");
});

test("the wrap-tolerant pass honours the role filter", () => {
  const assistant = searchTurns(db, {
    ...base,
    q: "使用不同的模型协同",
    role: "assistant",
  });
  expect(assistant.sessions.map((session) => session.id)).toContain("omp:delta");
  expect(assistant.sessions.map((session) => session.id)).not.toContain("omp:gamma");

  const user = searchTurns(db, { ...base, q: "使用不同的模型协同", role: "user" });
  expect(user.sessions.map((session) => session.id)).toContain("omp:gamma");
  expect(user.sessions.map((session) => session.id)).not.toContain("omp:delta");
});
