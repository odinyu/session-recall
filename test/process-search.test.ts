import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, writeSession } from "../src/db.ts";
import { searchTurns } from "../src/search.ts";
import type { SearchParams } from "../src/search.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-process-"));
const dbPath = join(dir, "index.db");
const db = openDb(dbPath);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const params = (q: string): SearchParams => ({
  q,
  agents: [],
  project: "",
  from: null,
  to: null,
  role: "all",
  scope: "process",
  limit: 20,
  offset: 0,
});

const session: ParsedSession = {
  agent: "omp",
  externalId: "process-search",
  projectPath: "/Users/test/project",
  title: "Process search fixture",
  startedAt: Date.UTC(2026, 10, 11, 9),
  updatedAt: Date.UTC(2026, 10, 11, 10),
  sourceKind: "jsonl",
  sourcePath: "/tmp/process-search.jsonl",
  fingerprint: "1",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 10, 11, 9),
      userText: "检查构建",
      assistantText: "构建已检查",
    },
  ],
  events: [
    {
      turnIdx: 0,
      seq: 0,
      kind: "reasoning",
      output: "只应该出现在过程详情里，不参与过程搜索",
    },
    {
      turnIdx: 0,
      seq: 1,
      kind: "tool",
      name: "bash",
      input: JSON.stringify({ command: "bun test src/SomeFile.ts" }),
      output: "13 pass",
      meta: "ok",
    },
    {
      turnIdx: 0,
      seq: 2,
      kind: "tool",
      name: "read",
      input: JSON.stringify({ path: "/Users/test/project/SomeFile.java" }),
      output: "Exception: boom in parser (错误)",
      meta: "error",
    },
    {
      turnIdx: 0,
      seq: 3,
      kind: "tool",
      name: "bash",
      input: JSON.stringify({ command: "tool --check" }),
      output: "warning: deprecated\nError: bad flag",
      meta: "ok",
    },
  ],
};

writeSession(db, session);

test("finds a file path from tool input", () => {
  const result = searchTurns(db, params("SomeFile.java"));
  expect(result.scope).toBe("process");
  expect(result.totalSessions).toBe(1);
  expect(result.processTotal).toBe(1);
  const hit = result.sessions[0]?.processHits[0];
  expect(hit?.tool).toBe("read");
  expect(hit?.matchField).toBe("input");
  expect(hit?.turnIdx).toBe(0);
});

test("finds a command from tool input", () => {
  const result = searchTurns(db, params("bun test"));
  expect(result.sessions[0]?.processHits[0]?.tool).toBe("bash");
  expect(result.sessions[0]?.processHits[0]?.snippet).toContain("bun test");
});

test("finds error text, including errors from successful tool status", () => {
  const failure = searchTurns(db, params("boom"));
  expect(failure.sessions[0]?.processHits[0]?.matchField).toBe("error");
  expect(failure.sessions[0]?.processHits[0]?.status).toBe("error");

  const warning = searchTurns(db, params("bad flag"));
  expect(warning.sessions[0]?.processHits[0]?.snippet).toContain("bad flag");
});

test("does not search reasoning text", () => {
  const result = searchTurns(db, params("只应该"));
  expect(result.sessions).toHaveLength(0);
});

test("falls back to LIKE for short Chinese terms", () => {
  const result = searchTurns(db, params("错误"));
  expect(result.sessions[0]?.processHits[0]?.matchField).toBe("error");
});

test("backfills event_search from existing events on migration", () => {
  const legacyPath = join(dir, "legacy.db");
  const legacy = openDb(legacyPath);
  writeSession(legacy, { ...session, externalId: "legacy" });
  // Simulate a v2 index: the event rows exist, but the projection does not.
  legacy.run("DELETE FROM event_search");
  legacy.run("PRAGMA user_version = 2");
  legacy.close();

  const reopened = openDb(legacyPath);
  try {
    const result = searchTurns(reopened, params("SomeFile.java"));
    expect(result.sessions.map((row) => row.id)).toEqual(["omp:legacy"]);
    const errorLine = searchTurns(reopened, params("bad flag"));
    expect(errorLine.sessions[0]?.processHits[0]?.matchField).toBe("error");
  } finally {
    reopened.close();
  }
});

test("an empty process query returns sessions, not a slice of one busy session", () => {
  // The regression: the recent path ordered the raw event stream and limited
  // that, so one session with thousands of events ate the whole budget and 472
  // sessions came back as 11.
  const recentDir = mkdtempSync(join(tmpdir(), "session-recall-process-recent-"));
  const recentDb = openDb(join(recentDir, "index.db"));

  const withEvents = (id: string, events: number, minute: number): ParsedSession => ({
    agent: "omp",
    externalId: id,
    projectPath: "/Users/test/project",
    title: id,
    startedAt: Date.UTC(2026, 10, 11, 9),
    updatedAt: Date.UTC(2026, 10, 11, 9, minute),
    sourceKind: "jsonl",
    sourcePath: `/tmp/${id}.jsonl`,
    fingerprint: "1",
    turns: [
      {
        idx: 0,
        ts: Date.UTC(2026, 10, 11, 9, minute),
        userText: "工作",
        assistantText: "好",
      },
    ],
    events: Array.from({ length: events }, (_, seq) => ({
      turnIdx: 0,
      seq,
      kind: "tool" as const,
      name: "bash",
      input: `command ${seq}`,
      output: `out ${seq}`,
    })),
  });

  try {
    writeSession(recentDb, withEvents("busy", 60, 0));
    writeSession(recentDb, withEvents("quiet-a", 1, 10));
    writeSession(recentDb, withEvents("quiet-b", 1, 20));

    const result = searchTurns(recentDb, { ...params(""), limit: 3 });
    expect(result.totalSessions).toBe(3);
    expect(result.sessions).toHaveLength(3);
    // One row per session: the newest event of each, not 60 rows of one.
    // (`processHitCount` still reports the session's whole hit count.)
    for (const session of result.sessions) {
      expect(session.processHits).toHaveLength(1);
    }
    // Newest session first.
    expect(result.sessions[0]?.id).toBe("omp:quiet-b");
  } finally {
    recentDb.close();
    rmSync(recentDir, { recursive: true, force: true });
  }
});

test("combines agent and project filters with process FTS", () => {
  const hit = searchTurns(db, {
    ...params("SomeFile.java"),
    agents: ["omp"],
    project: "/Users/test/project",
  });
  expect(hit.sessions).toHaveLength(1);

  const miss = searchTurns(db, { ...params("SomeFile.java"), agents: ["cursor"] });
  expect(miss.sessions).toHaveLength(0);
});
