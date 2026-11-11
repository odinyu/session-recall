import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "../src/adapters/codex.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

/**
 * Fixtures follow the documented Codex rollout format. No real Codex sessions
 * existed on the development machine, so these are handwritten against the
 * schema rather than captured.
 */

const root = mkdtempSync(join(tmpdir(), "session-recall-codex-"));
const sessions = join(root, "sessions");
const day = join(sessions, "2026", "11", "11");
const rollout = join(
  day,
  "rollout-2026-11-11T02-00-00-11111111-2222-3333-4444-555555555555.jsonl",
);
mkdirSync(day, { recursive: true });
writeFileSync(join(sessions, "history.jsonl"), "{}\n");

function line(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type, payload });
}

const records = [
  line("2026-11-11T02:00:00.000Z", "session_meta", {
    id: "11111111-2222-3333-4444-555555555555",
    timestamp: "2026-11-11T02:00:00.000Z",
    cwd: "/Users/test/codex",
    originator: "codex_cli_rs",
  }),
  line("2026-11-11T02:00:01.000Z", "turn_context", {
    cwd: "/Users/test/codex",
    model: "gpt-5-codex",
    approval_policy: "on-failure",
  }),
  line("2026-11-11T02:00:02.000Z", "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "fix the codex parser" }],
  }),
  line("2026-11-11T02:00:02.100Z", "event_msg", {
    type: "user_message",
    message: "fix the codex parser",
  }),
  line("2026-11-11T02:00:03.000Z", "response_item", {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Reasoning sample" }],
  }),
  line("2026-11-11T02:00:04.000Z", "response_item", {
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["bun", "test"] }),
    call_id: "call_1",
  }),
  line("2026-11-11T02:00:09.000Z", "response_item", {
    type: "function_call_output",
    call_id: "call_1",
    output: "2 pass",
  }),
  line("2026-11-11T02:00:10.000Z", "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Parser fixed." }],
  }),
  line("2026-11-11T02:00:10.100Z", "event_msg", {
    type: "agent_message",
    message: "Parser fixed.",
  }),
  line("2026-11-11T02:05:00.000Z", "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "second question" }],
  }),
  line("2026-11-11T02:05:04.000Z", "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "second answer" }],
  }),
];

writeFileSync(rollout, `${records.join("\n")}\n`);

const fallback = join(day, "rollout-2026-11-10T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
writeFileSync(
  fallback,
  [
    line("2026-11-10T00:00:00.000Z", "session_meta", {
      cwd: "/Users/test/old-codex",
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }),
    line("2026-11-10T00:00:01.000Z", "event_msg", {
      type: "user_message",
      message: "only event messages",
    }),
    line("2026-11-10T00:00:02.000Z", "event_msg", {
      type: "agent_message",
      message: "fallback answer",
    }),
  ].join("\n") + "\n",
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = codexAdapter(sessions);

test("lists only rollout files, recursively", async () => {
  const refs = await adapter.list();
  expect(refs.map((ref) => ref.sourcePath).sort()).toEqual([fallback, rollout].sort());
  expect(refs.every((ref) => ref.agent === "codex")).toBe(true);
});

test("parses response_item turns without duplicating event_msg", async () => {
  const refs = await adapter.list();
  const ref = refs.find((row) => row.sourcePath === rollout) as SessionRef;
  const session = await adapter.load(ref);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("codex");
  expect(session.projectPath).toBe("/Users/test/codex");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("fix the codex parser");
  expect(session.turns[0]?.assistantText).toBe("Parser fixed.");
  expect(session.turns[0]?.model).toBe("gpt-5-codex");
  expect(session.turns[1]?.userText).toBe("second question");
  expect(session.turns[1]?.assistantText).toBe("second answer");
  expect(session.startedAt).toBe(Date.parse("2026-11-11T02:00:00.000Z"));
  expect(session.updatedAt).toBe(Date.parse("2026-11-11T02:05:04.000Z"));

  const reasoning = session.events?.find((event) => event.kind === "reasoning");
  expect(reasoning?.output).toContain("Reasoning sample");
  const tool = session.events?.find((event) => event.kind === "tool");
  expect(tool?.name).toBe("shell");
  expect(tool?.input).toContain("bun");
  expect(tool?.output).toBe("2 pass");
});

test("falls back to event_msg when a rollout has no response_item messages", async () => {
  const refs = await adapter.list();
  const ref = refs.find((row) => row.sourcePath === fallback) as SessionRef;
  const session = await adapter.load(ref);
  expect(session).not.toBeNull();
  if (!session) return;
  expect(session.turns).toHaveLength(1);
  expect(session.turns[0]?.userText).toBe("only event messages");
  expect(session.turns[0]?.assistantText).toBe("fallback answer");
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, [adapter]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "second question",
      agents: ["codex"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]?.agent).toBe("codex");
  } finally {
    db.close();
  }
});
