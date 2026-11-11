import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-claude-"));
const projects = join(root, "projects");
const projectDir = join(projects, "-Users-test-project");
const sessionId = "11111111-2222-3333-4444-555555555555";
const transcript = join(projectDir, `${sessionId}.jsonl`);

mkdirSync(projectDir, { recursive: true });

const records = [
  { type: "queue-operation", operation: "enqueue", sessionId },
  {
    type: "ai-title",
    aiTitle: "Claude 解析器修复",
    sessionId,
  },
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-11-11T02:00:00.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    message: { role: "user", content: "fix the parser" },
  },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-11-11T02:00:05.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    message: {
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "thinking", thinking: "Thinking about the parser" },
        {
          type: "tool_use",
          id: "call_1",
          name: "Bash",
          input: { command: "bun test" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "u2",
    timestamp: "2026-11-11T02:00:09.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    toolUseResult: { stdout: "1 pass" },
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "1 pass", is_error: false },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-11-11T02:00:12.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    message: {
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "The parser is fixed." }],
    },
  },
  {
    type: "user",
    uuid: "u3",
    timestamp: "2026-11-11T02:10:00.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    message: { role: "user", content: "第二个问题：检查边界" },
  },
  {
    type: "user",
    uuid: "u4",
    timestamp: "2026-11-11T02:10:04.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  },
  {
    type: "assistant",
    uuid: "side",
    timestamp: "2026-11-11T02:10:06.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: true,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "SIDECHAIN-SHOULD-NOT-APPEAR" }],
    },
  },
  {
    type: "assistant",
    uuid: "a3",
    timestamp: "2026-11-11T02:10:08.000Z",
    cwd: "/Users/test/project",
    sessionId,
    isSidechain: false,
    message: {
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "边界也检查过了。" }],
    },
  },
];

writeFileSync(transcript, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = claudeCodeAdapter(projects);

test("lists Claude Code transcripts by session id", async () => {
  const refs = await adapter.list();
  expect(refs).toHaveLength(1);
  expect(refs[0]?.agent).toBe("claude-code");
  expect(refs[0]?.externalId).toBe(sessionId);
  expect(refs[0]?.sourcePath).toBe(transcript);
});

test("parses prompts, answers, tool events and skips sidechains", async () => {
  const refs = await adapter.list();
  const session = await adapter.load(refs[0] as SessionRef);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("claude-code");
  expect(session.projectPath).toBe("/Users/test/project");
  expect(session.title).toBe("Claude 解析器修复");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("fix the parser");
  expect(session.turns[0]?.assistantText).toContain("The parser is fixed.");
  expect(session.turns[0]?.assistantText).not.toContain("Thinking about");
  expect(session.turns[0]?.model).toBe("claude-test");
  expect(session.turns[1]?.userText).toContain("第二个问题");
  expect(session.turns[1]?.assistantText).toContain("边界也检查过了。");
  expect(session.turns[0]?.ts).toBe(Date.parse("2026-11-11T02:00:00.000Z"));
  expect(session.updatedAt).toBe(Date.parse("2026-11-11T02:10:08.000Z"));
  expect(session.startedAt).toBe(Date.parse("2026-11-11T02:00:00.000Z"));

  const reasoning = session.events?.find((event) => event.kind === "reasoning");
  expect(reasoning?.output).toContain("Thinking about the parser");
  const tool = session.events?.find((event) => event.kind === "tool");
  expect(tool?.name).toBe("Bash");
  expect(tool?.input).toContain("bun test");
  expect(tool?.output).toBe("1 pass");
  expect(tool?.meta).toBe("call_1|ok");
  // The sidechain assistant text never lands in a turn.
  expect(JSON.stringify(session.turns)).not.toContain("SIDECHAIN-SHOULD-NOT-APPEAR");
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, [adapter]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "边界",
      agents: ["claude-code"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]?.agent).toBe("claude-code");
  } finally {
    db.close();
  }
});
