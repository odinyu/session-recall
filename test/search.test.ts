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
  expect(result.sessions.length).toBe(2);
  expect(result.sessions.every((session) => session.hits.length === 1)).toBe(true);
});
