import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiCliAdapter } from "../src/adapters/gemini-cli.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-gemini-"));
const projectDir = join(root, "project-a");
const chats = join(projectDir, "chats");
const sessionId = "session-2026-11-13T02-00-abc12345";
const transcript = join(chats, `${sessionId}.jsonl`);
const legacy = join(chats, "session-legacy.json");

mkdirSync(chats, { recursive: true });
mkdirSync(join(chats, "parent-session"), { recursive: true });
writeFileSync(join(projectDir, ".project_root"), "/Users/test/gemini-project\n");

const jsonl = [
  {
    sessionId: "gem-1",
    projectHash: "project-a",
    startTime: "2026-11-13T02:00:00.000Z",
    lastUpdated: "2026-11-13T02:05:00.000Z",
  },
  {
    id: "m1",
    timestamp: "2026-11-13T02:00:00.000Z",
    type: "user",
    content: [{ text: "add a /health endpoint" }],
  },
  {
    id: "m2",
    timestamp: "2026-11-13T02:00:06.000Z",
    type: "gemini",
    model: "gemini-test",
    content: [{ text: "I will add it." }],
    thoughts: [
      { subject: "Planning", description: "Check the router", timestamp: "2026-11-13T02:00:03.000Z" },
    ],
    toolCalls: [
      {
        id: "c1",
        name: "write_file",
        args: { path: "src/server.ts" },
        result: [{ text: "wrote 12 lines" }],
        status: "success",
        timestamp: "2026-11-13T02:00:05.000Z",
      },
    ],
  },
  {
    id: "m3",
    timestamp: "2026-11-13T02:00:09.000Z",
    type: "info",
    content: "Tool acknowledged",
  },
  {
    id: "m4",
    timestamp: "2026-11-13T02:01:00.000Z",
    type: "user",
    content: "now cover it with a test",
  },
  {
    id: "m5",
    timestamp: "2026-11-13T02:01:05.000Z",
    type: "gemini",
    model: "gemini-test",
    content: [{ text: "Added a smoke test for 健康检查." }],
  },
  { $patch: { id: "m5", content: [{ text: "patched" }] } },
];

writeFileSync(transcript, `${jsonl.map((row) => JSON.stringify(row)).join("\n")}\n`);

// Older releases wrote a whole `ConversationRecord` document instead.
writeFileSync(
  legacy,
  JSON.stringify({
    sessionId: "gem-legacy",
    projectHash: "project-a",
    startTime: "2026-11-12T01:00:00.000Z",
    lastUpdated: "2026-11-12T01:01:00.000Z",
    messages: [
      {
        id: "l1",
        timestamp: "2026-11-12T01:00:00.000Z",
        type: "user",
        content: [{ text: "legacy prompt about parsing" }],
      },
      {
        id: "l2",
        timestamp: "2026-11-12T01:00:30.000Z",
        type: "gemini",
        model: "gemini-legacy",
        content: "legacy answer",
      },
    ],
  }),
);

// Subagent transcripts nest under the parent session and must not be listed.
writeFileSync(
  join(chats, "parent-session", "child.jsonl"),
  `${JSON.stringify({ sessionId: "child", projectHash: "project-a" })}\n`,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = geminiCliAdapter(root);

test("lists main chat files and skips nested subagent transcripts", async () => {
  const refs = await adapter.list();
  const ids = refs.map((ref) => ref.externalId).sort();
  expect(ids).toEqual([sessionId, "session-legacy"]);
  expect(refs[0]?.agent).toBe("gemini-cli");
  expect(refs.find((ref) => ref.externalId === sessionId)?.sourcePath).toBe(transcript);
});

test("parses the append-only JSONL conversation", async () => {
  const refs = await adapter.list();
  const ref = refs.find((entry) => entry.externalId === sessionId) as SessionRef;
  const session = await adapter.load(ref);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("gemini-cli");
  expect(session.externalId).toBe(sessionId);
  expect(session.projectPath).toBe("/Users/test/gemini-project");
  // No recorded title: the first prompt names the session.
  expect(session.title).toBe("add a /health endpoint");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("add a /health endpoint");
  expect(session.turns[0]?.assistantText).toBe("I will add it.");
  expect(session.turns[0]?.model).toBe("gemini-test");
  expect(session.turns[1]?.userText).toBe("now cover it with a test");
  expect(session.turns[1]?.assistantText).toContain("健康检查");
  expect(session.turns[1]?.ts).toBe(Date.parse("2026-11-13T02:01:00.000Z"));
  expect(session.startedAt).toBe(Date.parse("2026-11-13T02:00:00.000Z"));
  expect(session.updatedAt).toBe(Date.parse("2026-11-13T02:01:05.000Z"));

  // `info` notices and `$patch` edits never become turns.
  expect(JSON.stringify(session.turns)).not.toContain("Tool acknowledged");
  expect(JSON.stringify(session.turns)).not.toContain("patched");

  const reasoning = session.events?.find((event) => event.kind === "reasoning");
  expect(reasoning?.output).toContain("Check the router");
  expect(session.turns[0]?.assistantText).not.toContain("Check the router");

  const tool = session.events?.find((event) => event.kind === "tool");
  expect(tool?.name).toBe("write_file");
  expect(tool?.input).toContain("src/server.ts");
  expect(tool?.output).toBe("wrote 12 lines");
  expect(tool?.meta).toBe("c1|success");
});

test("parses a legacy whole-file JSON session", async () => {
  const refs = await adapter.list();
  const ref = refs.find((entry) => entry.externalId === "session-legacy") as SessionRef;
  const session = await adapter.load(ref);
  expect(session).not.toBeNull();
  if (!session) return;
  expect(session.projectPath).toBe("/Users/test/gemini-project");
  expect(session.title).toBe("legacy prompt about parsing");
  expect(session.turns).toHaveLength(1);
  expect(session.turns[0]?.assistantText).toBe("legacy answer");
  expect(session.turns[0]?.model).toBe("gemini-legacy");
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, [adapter]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "健康检查",
      agents: ["gemini-cli"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]?.agent).toBe("gemini-cli");
  } finally {
    db.close();
  }
});

test("a missing root lists nothing and does not throw", async () => {
  const missing = geminiCliAdapter(join(root, "does-not-exist"));
  expect(await missing.list()).toEqual([]);
});
