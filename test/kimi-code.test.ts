import { createHash } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiCodeAdapter } from "../src/adapters/kimi-code.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-kimi-"));
const projectPath = "/Users/test/kimi-project";
const digest = createHash("md5").update(projectPath, "utf8").digest("hex");
const sessionId = "kimi-session-1";
const sessionDir = join(root, "sessions", digest, sessionId);
const transcript = join(sessionDir, "wire.jsonl");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(root, "sessions", digest, "kimi-subagent", "agents", "main"), { recursive: true });

writeFileSync(
  join(root, "kimi.json"),
  JSON.stringify({ work_dirs: [{ path: projectPath, kaos: "local", last_session_id: sessionId }] }),
);
writeFileSync(join(sessionDir, "state.json"), JSON.stringify({ version: 1, custom_title: "Kimi 会话" }));

const lines = [
  { type: "metadata", protocol_version: "1.7" },
  {
    timestamp: 1763000000,
    message: { type: "TurnBegin", payload: { user_input: [{ type: "text", text: "重构会话存储" }] } },
  },
  { timestamp: 1763000001, message: { type: "StepBegin", payload: { n: 1 } } },
  {
    timestamp: 1763000002,
    message: { type: "ContentPart", payload: { type: "think", think: "先看现有实现" } },
  },
  { timestamp: 1763000002.5, message: { type: "ContentPart", payload: { type: "text", text: "我先" } } },
  { timestamp: 1763000002.6, message: { type: "ContentPart", payload: { type: "text", text: "读一下代码。" } } },
  {
    timestamp: 1763000003,
    message: {
      type: "ToolCall",
      payload: {
        type: "function",
        id: "t1",
        function: { name: "ReadFile", arguments: "{\"path\":\"src/store.ts\"}" },
        extras: null,
      },
    },
  },
  {
    timestamp: 1763000004,
    message: {
      type: "ToolResult",
      payload: {
        tool_call_id: "t1",
        return_value: {
          is_error: false,
          output: [{ type: "text", text: "export const store = {}" }],
          message: "",
          display: [],
        },
      },
    },
  },
  {
    timestamp: 1763000004.5,
    message: { type: "ContentPart", payload: { type: "text", text: "现在改存储。" } },
  },
  { timestamp: 1763000005, message: { type: "StepBegin", payload: { n: 2 } } },
  { timestamp: 1763000006, message: { type: "ContentPart", payload: { type: "text", text: "重构完成。" } } },
  { timestamp: 1763000007, message: { type: "TurnEnd", payload: {} } },
  { timestamp: 1763000009, message: { type: "TurnBegin", payload: { user_input: "跑一下测试" } } },
  { timestamp: 1763000010, message: { type: "ContentPart", payload: { type: "text", text: "全部通过。" } } },
];

writeFileSync(transcript, `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`);
// Subagent wire logs live under `agents/` and must not be listed.
writeFileSync(
  join(root, "sessions", digest, "kimi-subagent", "agents", "main", "wire.jsonl"),
  `${JSON.stringify({ timestamp: 1763000000, message: { type: "TurnBegin", payload: { user_input: "subagent" } } })}\n`,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = kimiCodeAdapter(root);

test("lists main session wire logs", async () => {
  const refs = await adapter.list();
  expect(refs).toHaveLength(1);
  expect(refs[0]?.agent).toBe("kimi-code");
  expect(refs[0]?.externalId).toBe(sessionId);
  expect(refs[0]?.sourcePath).toBe(transcript);
});

test("parses wire turns, streamed text, reasoning and tool calls", async () => {
  const refs = await adapter.list();
  const session = await adapter.load(refs[0] as SessionRef);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("kimi-code");
  expect(session.projectPath).toBe(projectPath);
  expect(session.title).toBe("Kimi 会话");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("重构会话存储");
  // Stream chunks inside one step concatenate; the next step starts a paragraph.
  expect(session.turns[0]?.assistantText).toBe(
    "我先读一下代码。\n\n现在改存储。\n\n重构完成。",
  );
  expect(session.turns[1]?.userText).toBe("跑一下测试");
  expect(session.turns[1]?.assistantText).toBe("全部通过。");
  expect(session.startedAt).toBe(1763000000000);
  expect(session.updatedAt).toBe(1763000010000);

  expect(session.turns[0]?.assistantText).not.toContain("先看现有实现");
  const reasoning = session.events?.find((event) => event.kind === "reasoning");
  expect(reasoning?.output).toBe("先看现有实现");

  const tool = session.events?.find((event) => event.kind === "tool");
  expect(tool?.name).toBe("ReadFile");
  expect(tool?.input).toBe("{\"path\":\"src/store.ts\"}");
  expect(tool?.output).toBe("export const store = {}");
  expect(tool?.meta).toBe("t1|ok");
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, [adapter]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "重构会话存储",
      agents: ["kimi-code"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]?.agent).toBe("kimi-code");
  } finally {
    db.close();
  }
});

test("a missing root lists nothing and does not throw", async () => {
  const missing = kimiCodeAdapter(join(root, "does-not-exist"));
  expect(await missing.list()).toEqual([]);
});
