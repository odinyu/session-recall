import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qwenCodeAdapter } from "../src/adapters/qwen-code.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-qwen-"));
const chats = join(root, "projects", "-Users-test-qwen", "chats");
const sessionId = "qwen-session-1";
const transcript = join(chats, `${sessionId}.jsonl`);

mkdirSync(chats, { recursive: true });
// A file outside the `projects/<project>/chats` shape must not be listed.
mkdirSync(join(root, "projects", "-Users-test-qwen", "other"), { recursive: true });

const records = [
  {
    uuid: "u0",
    parentUuid: null,
    sessionId,
    timestamp: "2026-11-13T03:00:00.000Z",
    type: "system",
    subtype: "custom_title",
    cwd: "/Users/test/qwen-project",
    systemPayload: { customTitle: "Qwen 会话标题", titleSource: "manual" },
  },
  {
    uuid: "u1",
    parentUuid: "u0",
    sessionId,
    timestamp: "2026-11-13T03:00:10.000Z",
    type: "user",
    provenance: "real_user",
    cwd: "/Users/test/qwen-project",
    message: { role: "user", parts: [{ text: "检查契约是否稳定" }] },
  },
  {
    uuid: "a1",
    parentUuid: "u1",
    sessionId,
    timestamp: "2026-11-13T03:00:12.000Z",
    type: "assistant",
    model: "qwen-test",
    cwd: "/Users/test/qwen-project",
    message: {
      role: "model",
      parts: [
        { text: "先读一下实现", thought: true },
        { text: "契约是稳定的。" },
      ],
    },
  },
  {
    uuid: "t1",
    parentUuid: "a1",
    sessionId,
    timestamp: "2026-11-13T03:00:14.000Z",
    type: "assistant",
    model: "qwen-test",
    cwd: "/Users/test/qwen-project",
    message: {
      role: "model",
      parts: [{ functionCall: { id: "read-1", name: "read_file", args: { path: "src/api.ts" } } }],
    },
  },
  {
    uuid: "r1",
    parentUuid: "t1",
    sessionId,
    timestamp: "2026-11-13T03:00:16.000Z",
    type: "tool_result",
    cwd: "/Users/test/qwen-project",
    message: {
      role: "user",
      parts: [{ functionResponse: { id: "read-1", name: "read_file", response: { output: "export {}" } } }],
    },
    toolCallResult: { callId: "read-1", status: "success" },
  },
  {
    uuid: "s1",
    parentUuid: "r1",
    sessionId,
    timestamp: "2026-11-13T03:00:18.000Z",
    type: "user",
    subtype: "agent_bootstrap",
    provenance: "system",
    cwd: "/Users/test/qwen-project",
    message: { role: "user", parts: [{ text: "AGENT BOOTSTRAP SHOULD NOT APPEAR" }] },
  },
  {
    uuid: "u2",
    parentUuid: "r1",
    sessionId,
    timestamp: "2026-11-13T03:05:00.000Z",
    type: "user",
    cwd: "/Users/test/qwen-project",
    message: { role: "user", parts: [{ text: "再补一个回归测试" }] },
  },
  {
    uuid: "a2",
    parentUuid: "u2",
    sessionId,
    timestamp: "2026-11-13T03:05:05.000Z",
    type: "assistant",
    model: "qwen-test",
    cwd: "/Users/test/qwen-project",
    message: { role: "model", parts: [{ text: "回归测试已加入。" }] },
  },
];

writeFileSync(transcript, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
writeFileSync(
  join(root, "projects", "-Users-test-qwen", "other", "noise.jsonl"),
  `${JSON.stringify(records[1])}\n`,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = qwenCodeAdapter(root);

test("lists only projects/<project>/chats JSONL files", async () => {
  const refs = await adapter.list();
  expect(refs).toHaveLength(1);
  expect(refs[0]?.agent).toBe("qwen-code");
  expect(refs[0]?.externalId).toBe(sessionId);
  expect(refs[0]?.sourcePath).toBe(transcript);
});

test("parses prompts, answers, reasoning and tool calls", async () => {
  const refs = await adapter.list();
  const session = await adapter.load(refs[0] as SessionRef);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("qwen-code");
  expect(session.projectPath).toBe("/Users/test/qwen-project");
  expect(session.title).toBe("Qwen 会话标题");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("检查契约是否稳定");
  expect(session.turns[0]?.assistantText).toBe("契约是稳定的。");
  expect(session.turns[0]?.model).toBe("qwen-test");
  expect(session.turns[1]?.userText).toBe("再补一个回归测试");
  expect(session.turns[1]?.assistantText).toBe("回归测试已加入。");
  expect(session.startedAt).toBe(Date.parse("2026-11-13T03:00:00.000Z"));
  expect(session.updatedAt).toBe(Date.parse("2026-11-13T03:05:05.000Z"));

  // Thought parts stay out of the answer text and become reasoning events.
  expect(session.turns[0]?.assistantText).not.toContain("先读一下实现");
  const reasoning = session.events?.find((event) => event.kind === "reasoning");
  expect(reasoning?.output).toBe("先读一下实现");

  const tool = session.events?.find((event) => event.kind === "tool");
  expect(tool?.name).toBe("read_file");
  expect(tool?.input).toContain("src/api.ts");
  expect(tool?.output).toContain("export {}");
  expect(tool?.meta).toBe("read-1|success");

  // Synthetic system-provenance user records are not prompts.
  expect(JSON.stringify(session.turns)).not.toContain("AGENT BOOTSTRAP");
  expect(session.turns).toHaveLength(2);
});

test("falls back to the first prompt when no custom title is recorded", async () => {
  const altChats = join(root, "alt", "projects", "p", "chats");
  mkdirSync(altChats, { recursive: true });
  const copy = join(altChats, "no-title.jsonl");
  writeFileSync(
    copy,
    `${records
      .filter((row) => row.subtype !== "custom_title")
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  const session = await adapter.load({
    agent: "qwen-code",
    externalId: "no-title",
    fingerprint: "1:1",
    sourcePath: copy,
  });
  expect(session?.title).toBe("检查契约是否稳定");
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, [adapter]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "稳定",
      agents: ["qwen-code"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions.length).toBeGreaterThanOrEqual(1);
    expect(found.sessions[0]?.agent).toBe("qwen-code");
  } finally {
    db.close();
  }
});

test("a missing root lists nothing and does not throw", async () => {
  const missing = qwenCodeAdapter(join(root, "does-not-exist"));
  expect(await missing.list()).toEqual([]);
});
