import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { almaAdapter } from "../src/adapters/alma.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { searchTurns } from "../src/search.ts";
import { scan } from "../src/scan.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-alma-"));
let fixtures = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The Alma tables this adapter reads, plus the columns it ignores. */
const SCHEMA = `
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_incognito INTEGER DEFAULT 0,
  parent_thread_id TEXT,
  workspace_id TEXT
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  parent_id TEXT,
  slot_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parent_tool_call_id TEXT
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  is_temporary INTEGER NOT NULL DEFAULT 0,
  show_in_list INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  is_session INTEGER NOT NULL DEFAULT 0,
  remote_host_id TEXT
);
`;

function message(id: string, role: string, parts: unknown[]): string {
  return JSON.stringify({ id, role, parts });
}

/**
 * One visible thread (two turns, the first of them two consecutive assistant
 * messages), one workspace-less thread, and one incognito thread. The incognito
 * thread carries a marker phrase that must never reach the index.
 */
function createFixture(): { path: string; db: Database } {
  const path = join(root, `alma-${fixtures++}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  db.run(
    "INSERT INTO workspaces(id, path, name) VALUES ('ws1', '/Users/test/project', 'project')",
  );
  const thread = db.query(
    `INSERT INTO chat_threads(id, title, model, created_at, updated_at, is_incognito, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  thread.run(
    "visible",
    "Visible thread",
    "provider-1:loomy/Test-Model",
    "2026-11-11T02:00:00.000Z",
    "2026-11-11T02:10:00.000Z",
    0,
    "ws1",
  );
  thread.run(
    "secret",
    "秘密会话",
    "provider-1:loomy/Test-Model",
    "2026-11-11T03:00:00.000Z",
    "2026-11-11T03:10:00.000Z",
    1,
    null,
  );
  thread.run(
    "orphan",
    "Orphan room",
    null,
    "2026-11-11T04:00:00.000Z",
    "2026-11-11T04:10:00.000Z",
    0,
    "gone",
  );

  const insert = db.query(
    `INSERT INTO chat_messages(id, thread_id, parent_id, slot_id, depth, message, timestamp, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const add = (id: string, threadId: string, ts: string, body: string) =>
    insert.run(id, threadId, null, id, 0, body, ts, ts, ts);

  add("visible--u1", "visible", "2026-11-11T02:00:01.000Z", message("visible--u1", "user", [
    { type: "text", text: "如何配置检索范围" },
  ]));
  add("visible--a1", "visible", "2026-11-11T02:01:00.000Z", message("visible--a1", "assistant", [
    { type: "step-start" },
    { type: "reasoning", text: "先看配置项", state: "done" },
    { type: "text", text: "按角色范围控制", state: "done" },
    {
      type: "tool-Bash",
      toolCallId: "call-bash",
      state: "output-available",
      input: { command: "ls -la" },
      output: { stdout: "a\nb", stderr: "", exitCode: 0 },
      approvalDecision: { action: "allow_once", decidedAt: 1 },
    },
    // Unfinished call: no output recorded yet, and none may be invented.
    { type: "tool-Task", toolCallId: "call-task", state: "input-available", input: { description: "pending" } },
    // Denied call: no output either.
    {
      type: "tool-Edit",
      toolCallId: "call-edit",
      state: "input-available",
      input: { file_path: "/tmp/never.ts" },
      approvalDecision: { action: "deny", decidedAt: 2 },
    },
    // Errored call: only `rawInput` + `errorText` are present.
    {
      type: "tool-Read",
      toolCallId: "call-read",
      state: "output-error",
      rawInput: { file_path: "/tmp/missing.jpg" },
      errorText: "AI_NoSuchToolError: unavailable tool 'Read'",
    },
  ]));
  add("visible--a1b", "visible", "2026-11-11T02:02:00.000Z", message("visible--a1b", "assistant", [
    { type: "text", text: "补充说明", state: "done" },
  ]));
  add("visible--u2", "visible", "2026-11-11T02:05:00.000Z", message("visible--u2", "user", [
    { type: "text", text: "再问一次" },
  ]));
  add("visible--a2", "visible", "2026-11-11T02:06:00.000Z", message("visible--a2", "assistant", [
    { type: "text", text: "好的，已完成", state: "done" },
  ]));

  add("secret--u1", "secret", "2026-11-11T03:00:01.000Z", message("secret--u1", "user", [
    { type: "text", text: "绝密标记短语zzq 不应被索引" },
  ]));
  add("secret--a1", "secret", "2026-11-11T03:01:00.000Z", message("secret--a1", "assistant", [
    { type: "text", text: "秘密回答" },
  ]));

  add("orphan--u1", "orphan", "2026-11-11T04:00:01.000Z", message("orphan--u1", "user", [
    { type: "text", text: "孤儿工作区" },
  ]));
  add("orphan--a1", "orphan", "2026-11-11T04:01:00.000Z", message("orphan--a1", "assistant", [
    { type: "text", text: "ok" },
  ]));

  return { path, db };
}

async function refsFor(path: string): Promise<SessionRef[]> {
  const refs = await almaAdapter(path).list();
  return refs;
}

test("lists every thread except the incognito ones", async () => {
  const fixture = createFixture();
  const refs = await refsFor(fixture.path);
  const ids = refs.map((ref) => ref.externalId).sort();
  // Dropping `WHERE t.is_incognito = 0` adds "secret" here and fails.
  expect(ids).toEqual(["orphan", "visible"]);
  expect(refs.every((ref) => ref.agent === "alma")).toBe(true);
  expect(refs.every((ref) => ref.sourcePath === fixture.path)).toBe(true);
  fixture.db.close();
});

test("refuses to load an incognito thread by id", async () => {
  const fixture = createFixture();
  const session = await almaAdapter(fixture.path).load({
    agent: "alma",
    externalId: "secret",
    fingerprint: "x",
    sourcePath: fixture.path,
  });
  expect(session).toBeNull();
  fixture.db.close();
});

test("parses turns, consecutive assistant messages, reasoning and tool events", async () => {
  const fixture = createFixture();
  const refs = await refsFor(fixture.path);
  const ref = refs.find((entry) => entry.externalId === "visible");
  expect(ref).toBeTruthy();
  const session = await almaAdapter(fixture.path).load(ref!);
  expect(session).not.toBeNull();

  expect(session!.agent).toBe("alma");
  expect(session!.sourceKind).toBe("sqlite");
  expect(session!.sourcePath).toBe(fixture.path);
  expect(session!.projectPath).toBe("/Users/test/project");
  expect(session!.title).toBe("Visible thread");
  expect(session!.startedAt).toBe(Date.parse("2026-11-11T02:00:00.000Z"));
  expect(session!.updatedAt).toBe(Date.parse("2026-11-11T02:10:00.000Z"));

  // Two prompts → two turns; the second assistant message folds into the first.
  expect(session!.turns).toHaveLength(2);
  expect(session!.turns[0]!.userText).toBe("如何配置检索范围");
  expect(session!.turns[0]!.assistantText).toBe("按角色范围控制\n\n补充说明");
  expect(session!.turns[0]!.model).toBe("loomy/Test-Model");
  expect(session!.turns[1]!.userText).toBe("再问一次");
  expect(session!.turns[1]!.assistantText).toBe("好的，已完成");

  const events = session!.events ?? [];
  expect(events.map((event) => event.kind)).toEqual([
    "reasoning",
    "tool",
    "tool",
    "tool",
    "tool",
  ]);
  expect(events.map((event) => event.turnIdx)).toEqual([0, 0, 0, 0, 0]);
  expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);

  expect(events[0]!.name).toBeUndefined();
  expect(events[0]!.output).toBe("先看配置项");

  const bash = events[1]!;
  expect(bash.name).toBe("Bash");
  expect(bash.meta).toBe("ok");
  expect(bash.input).toBe(JSON.stringify({ command: "ls -la" }));
  expect(bash.output).toBe(
    JSON.stringify({ stdout: "a\nb", stderr: "", exitCode: 0 }),
  );

  // Unfinished, denied and errored calls all keep an empty output.
  expect(events[2]!.name).toBe("Task");
  expect(events[2]!.output).toBe("");
  expect(events[2]!.meta).toBe("input-available");

  expect(events[3]!.name).toBe("Edit");
  expect(events[3]!.output).toBe("");
  expect(events[3]!.meta).toBe("denied");

  // `Read` records only `rawInput`; the input still shows up, the output does not.
  expect(events[4]!.name).toBe("Read");
  expect(events[4]!.meta).toBe("error");
  expect(events[4]!.output).toBe("");
  expect(events[4]!.input).toBe(JSON.stringify({ file_path: "/tmp/missing.jpg" }));

  fixture.db.close();
});

test("leaves projectPath empty when the workspace is gone", async () => {
  const fixture = createFixture();
  const refs = await refsFor(fixture.path);
  const ref = refs.find((entry) => entry.externalId === "orphan");
  const session = await almaAdapter(fixture.path).load(ref!);
  expect(session!.projectPath).toBe("");
  // No model on the thread → no model on the turns.
  expect(session!.turns[0]!.model).toBeUndefined();
  fixture.db.close();
});

test("fingerprint changes when a thread gains a message", async () => {
  const fixture = createFixture();
  const before = await refsFor(fixture.path);
  const first = before.find((ref) => ref.externalId === "visible")!.fingerprint;

  const ts = "2026-11-11T02:07:00.000Z";
  fixture.db
    .query(
      `INSERT INTO chat_messages(id, thread_id, parent_id, slot_id, depth, message, timestamp, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visible--a2b",
      "visible",
      null,
      "visible--a2b",
      0,
      message("visible--a2b", "assistant", [{ type: "text", text: "又补充", state: "done" }]),
      ts,
      ts,
      ts,
    );

  const after = await refsFor(fixture.path);
  const second = after.find((ref) => ref.externalId === "visible")!.fingerprint;
  expect(second).not.toBe(first);
  fixture.db.close();
});

test("an incognito thread never reaches the search index", async () => {
  const fixture = createFixture();
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  const report = await scan(db, [almaAdapter(fixture.path)]);

  expect(report.agents.alma?.refs).toBe(2);
  expect(report.sessions).toBe(2);

  const leaked = searchTurns(db, {
    q: "绝密标记短语zzq",
    agents: [],
    project: "",
    from: null,
    to: null,
    role: "all",
    scope: "qa",
    limit: 20,
    offset: 0,
  });
  expect(leaked.sessions).toHaveLength(0);

  const found = searchTurns(db, {
    q: "检索范围",
    agents: [],
    project: "",
    from: null,
    to: null,
    role: "all",
    scope: "qa",
    limit: 20,
    offset: 0,
  });
  expect(found.sessions.map((session) => session.id)).toEqual(["alma:visible"]);

  db.close();
  fixture.db.close();
});
