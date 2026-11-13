import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotCliAdapter } from "../src/adapters/copilot-cli.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-copilot-"));
const stateDir = join(root, "session-state");
const sessionDir = join(stateDir, "sess-001");
const sessionFile = join(sessionDir, "events.jsonl");

mkdirSync(sessionDir, { recursive: true });

/** Only `name` and `cwd` are read from the sidecar. */
writeFileSync(
  join(sessionDir, "workspace.yaml"),
  [
    'cwd: "/Users/test/copilot"',
    'name: "Copilot 交接修复"',
    "git_root: /Users/test/copilot",
    "branch: main",
    "",
  ].join("\n"),
);

const records = [
  {
    type: "session.start",
    timestamp: "2026-11-12T01:00:00.000Z",
    data: {
      sessionId: "sess-001",
      copilotVersion: "1.0.80",
      selectedModel: "gpt-5",
      context: { cwd: "/Users/test/copilot" },
      startTime: "2026-11-12T01:00:00.000Z",
    },
  },
  {
    type: "user.message",
    timestamp: "2026-11-12T01:00:01.000Z",
    data: {
      content: "修复 copilot 解析器",
      attachments: ["/tmp/parser.ts"],
    },
  },
  {
    type: "assistant.message",
    timestamp: "2026-11-12T01:00:05.000Z",
    data: {
      content: "Changed the parser.",
      model: "gpt-5",
      toolRequests: [
        {
          toolCallId: "call_1",
          name: "bash",
          arguments: { command: "bun test" },
        },
      ],
    },
  },
  {
    type: "tool.execution_start",
    timestamp: "2026-11-12T01:00:05.100Z",
    data: { toolCallId: "call_1", toolName: "bash", arguments: { command: "bun test" } },
  },
  {
    type: "tool.execution_complete",
    timestamp: "2026-11-12T01:00:06.000Z",
    data: { toolCallId: "call_1", success: true, result: { content: "1 pass\n" } },
  },
  // A tool-only assistant record carries no text and must not add one.
  {
    type: "assistant.message",
    timestamp: "2026-11-12T01:00:07.000Z",
    data: {
      content: "",
      model: "gpt-5",
      toolRequests: [
        { toolCallId: "call_2", name: "view", arguments: { path: "src/parser.ts" } },
      ],
    },
  },
  {
    type: "tool.execution_complete",
    timestamp: "2026-11-12T01:00:08.000Z",
    data: {
      toolCallId: "call_2",
      success: false,
      result: { content: "permission denied" },
    },
  },
  {
    type: "assistant.reasoning",
    timestamp: "2026-11-12T01:00:09.000Z",
    data: { content: "REASONING-SHOULD-NOT-APPEAR" },
  },
  {
    type: "subagent.started",
    timestamp: "2026-11-12T01:00:10.000Z",
    data: { agentName: "reviewer", agentId: "agent-1", parentToolCallId: "call_9" },
  },
  {
    type: "session.shutdown",
    timestamp: "2026-11-12T01:00:11.000Z",
    data: { modelMetrics: {}, totalNanoAiu: 1 },
  },
  {
    type: "user.message",
    timestamp: "2026-11-12T01:10:00.000Z",
    data: { content: "再检查一次边界" },
  },
  {
    type: "assistant.message",
    timestamp: "2026-11-12T01:10:04.000Z",
    data: { content: "边界检查通过。", model: "gpt-5" },
  },
];

writeFileSync(
  sessionFile,
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);

/** The pre-1.0.11 layout: one flat JSONL file per session, no workspace.yaml. */
const legacyFile = join(stateDir, "legacy-001.jsonl");
writeFileSync(
  legacyFile,
  `${[
    { type: "user.message", timestamp: "2026-11-11T05:00:00.000Z", data: { content: "旧布局的问题" } },
    {
      type: "assistant.message",
      timestamp: "2026-11-11T05:00:02.000Z",
      data: { content: "旧布局的回答", model: "claude-sonnet-4" },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = copilotCliAdapter(root);

test("lists both session layouts by session id", async () => {
  const refs = await adapter.list();
  expect(refs).toHaveLength(2);
  const current = refs.find((ref) => ref.externalId === "sess-001");
  const legacy = refs.find((ref) => ref.externalId === "legacy-001");
  expect(current?.agent).toBe("copilot-cli");
  expect(current?.sourcePath).toBe(sessionFile);
  expect(legacy?.sourcePath).toBe(legacyFile);
  expect(current?.fingerprint).toMatch(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/);
});

test("parses prompts, answers and tool events from the event log", async () => {
  const refs = await adapter.list();
  const ref = refs.find((entry) => entry.externalId === "sess-001") as SessionRef;
  const session = await adapter.load(ref);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("copilot-cli");
  expect(session.projectPath).toBe("/Users/test/copilot");
  expect(session.title).toBe("Copilot 交接修复");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("修复 copilot 解析器");
  expect(session.turns[0]?.assistantText).toBe("Changed the parser.");
  expect(session.turns[0]?.model).toBe("gpt-5");
  expect(session.turns[1]?.userText).toBe("再检查一次边界");
  expect(session.turns[1]?.assistantText).toBe("边界检查通过。");
  expect(session.turns[0]?.ts).toBe(Date.parse("2026-11-12T01:00:01.000Z"));
  expect(session.startedAt).toBe(Date.parse("2026-11-12T01:00:00.000Z"));
  expect(session.updatedAt).toBe(Date.parse("2026-11-12T01:10:04.000Z"));

  const bash = session.events?.find((event) => event.name === "bash");
  expect(bash?.kind).toBe("tool");
  expect(bash?.input).toContain("bun test");
  expect(bash?.output).toBe("1 pass\n");
  expect(bash?.meta).toBe("ok");
  const view = session.events?.find((event) => event.name === "view");
  expect(view?.output).toBe("permission denied");
  expect(view?.meta).toBe("error");
  // Reasoning and subagent bookkeeping are not indexed as conversation.
  expect(JSON.stringify(session.turns)).not.toContain("REASONING-SHOULD-NOT-APPEAR");
  expect(session.events?.some((event) => event.kind === "reasoning")).toBe(false);
});

test("falls back to the first prompt for the legacy layout", async () => {
  const refs = await adapter.list();
  const ref = refs.find((entry) => entry.externalId === "legacy-001") as SessionRef;
  const session = await adapter.load(ref);
  expect(session).not.toBeNull();
  if (!session) return;
  expect(session.title).toBe("旧布局的问题");
  expect(session.projectPath).toBe("");
  expect(session.turns).toHaveLength(1);
  expect(session.turns[0]?.model).toBe("claude-sonnet-4");
});

test("a missing Copilot home lists nothing and does not throw", async () => {
  const missing = copilotCliAdapter(join(root, "missing"));
  expect(await missing.list()).toEqual([]);
});

test("prefers the directory layout when a migrated store keeps both", async () => {
  const duplicate = mkdtempSync(join(root, "dup-"));
  const dir = join(duplicate, "session-state", "same-id");
  mkdirSync(dir, { recursive: true });
  const events = [
    { type: "user.message", timestamp: "2026-11-10T01:00:00.000Z", data: { content: "新布局" } },
    { type: "assistant.message", timestamp: "2026-11-10T01:00:01.000Z", data: { content: "答" } },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  writeFileSync(join(dir, "events.jsonl"), `${events}\n`);
  writeFileSync(join(duplicate, "session-state", "same-id.jsonl"), `${events}\n`);

  const refs = await copilotCliAdapter(duplicate).list();
  expect(refs).toHaveLength(1);
  expect(refs[0]?.externalId).toBe("same-id");
  expect(refs[0]?.sourcePath).toBe(join(dir, "events.jsonl"));
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, [copilotCliAdapter(root)]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "解析器",
      agents: ["copilot-cli"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]?.agent).toBe("copilot-cli");
  } finally {
    db.close();
  }
});
