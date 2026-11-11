import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, writeSession } from "../src/db.ts";
import { generateHandoff } from "../src/handoff.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-handoff-"));
const db = openDb(join(dir, "index.db"));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const session: ParsedSession = {
  agent: "omp",
  externalId: "2026-11-11T09-00-00-000Z_01a1b2c3",
  projectPath: "/Users/test/project",
  title: "Parser fix",
  startedAt: Date.UTC(2026, 10, 11, 9),
  updatedAt: Date.UTC(2026, 10, 11, 10),
  sourceKind: "jsonl",
  sourcePath: "/tmp/handoff.jsonl",
  fingerprint: "handoff-fixture",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 10, 11, 9),
      userText: "Fix the parser and run the tests",
      assistantText: "Changed the parser.",
    },
    {
      idx: 1,
      ts: Date.UTC(2026, 10, 11, 9, 30),
      userText: "Now check the failing edge case",
      assistantText: "The edge case still fails.",
    },
  ],
  events: [
    {
      turnIdx: 0,
      seq: 0,
      kind: "tool",
      name: "read",
      input: JSON.stringify({ path: "src/parser.ts" }),
      output: "export function parse() {}",
      meta: "ok",
    },
    {
      turnIdx: 0,
      seq: 1,
      kind: "tool",
      name: "bash",
      input: JSON.stringify({ command: "bun test src/parser.test.ts" }),
      output: "1 pass",
      meta: "ok",
    },
    {
      turnIdx: 1,
      seq: 0,
      kind: "tool",
      name: "edit",
      input: JSON.stringify({ path: "/Users/test/project/src/parser.ts" }),
      output: "permission denied",
      meta: "ok|denied",
    },
    {
      turnIdx: 1,
      seq: 1,
      kind: "tool",
      name: "bash",
      input: JSON.stringify({ command: "bun test" }),
      output: "error: expected token",
      meta: "ok|error",
    },
  ],
};

writeSession(db, session);

test("builds a handoff card with resume state and evidence", () => {
  const card = generateHandoff(db, "omp:2026-11-11T09-00-00-000Z_01a1b2c3");
  expect(card).not.toBeNull();
  expect(card).toContain("# 交接：Parser fix");
  expect(card).toContain("`/Users/test/project`");
  expect(card).toContain("omp --resume 01a1b2c3");
  expect(card).toContain("Fix the parser");
  expect(card).toContain("Now check the failing edge case");
  expect(card).toContain("The edge case still fails.");
  expect(card).toContain("src/parser.ts");
  expect(card).toContain("bun test src/parser.test.ts");
  expect(card).toContain("denied");
  expect(card).toContain("error: expected token");
});

test("returns null for an unknown session", () => {
  expect(generateHandoff(db, "omp:missing")).toBeNull();
});

test("includes the Git branch and dirty files", () => {
  const repo = mkdtempSync(join(tmpdir(), "session-recall-git-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C", repo,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-qm", "init",
    ]);
    appendFileSync(join(repo, "tracked.txt"), "two\n");

    const gitSession: ParsedSession = {
      ...session,
      externalId: "git-session",
      projectPath: repo,
      title: "Git handoff",
      turns: [],
      events: [],
    };
    writeSession(db, gitSession);
    const card = generateHandoff(db, "omp:git-session");
    expect(card).toContain("## Git 状态");
    expect(card).toContain("未提交改动");
    expect(card).toContain("tracked.txt");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("continues in another agent with that agent's new-session command", () => {
  const card = generateHandoff(db, "omp:2026-11-11T09-00-00-000Z_01a1b2c3", {
    targetAgent: "claude-code",
  });
  expect(card).toContain("## 在 Claude Code 中继续");
  expect(card).toContain("cd '/Users/test/project' && claude");
  expect(card).toContain("新开一个会话");
  expect(card).not.toContain("## 继续");

  const cursor = generateHandoff(db, "omp:2026-11-11T09-00-00-000Z_01a1b2c3", {
    targetAgent: "cursor",
  });
  expect(cursor).toContain("## 在 Cursor 中继续");
  expect(cursor).toContain("cursor '/Users/test/project'");
  expect(cursor).toContain("在 Cursor 中打开项目");
});

test("keeps the exact resume when the target is the source agent", () => {
  const card = generateHandoff(db, "omp:2026-11-11T09-00-00-000Z_01a1b2c3", {
    targetAgent: "omp",
  });
  expect(card).toContain("## 在 omp 中继续");
  expect(card).toContain("omp --resume 01a1b2c3");
});

test("explains a target without a shell entry point instead of failing", () => {
  const card = generateHandoff(db, "omp:2026-11-11T09-00-00-000Z_01a1b2c3", {
    targetAgent: "alma",
  });
  expect(card).toContain("## 在 Alma 中继续");
  expect(card).toContain("在 Alma 中新建会话并粘贴交接卡");
  expect(card).not.toContain("```bash");
});
