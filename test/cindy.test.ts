import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cindyAdapter } from "../src/adapters/cindy.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-cindy-"));
let fixtures = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The Cindy tables this adapter reads, plus the columns it ignores. */
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT 'New CCS' NOT NULL,
  working_dir TEXT,
  model TEXT DEFAULT 'claude-sonnet-4-6' NOT NULL,
  status TEXT DEFAULT 'active' NOT NULL,
  cleared_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  parent_session_id TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agent_meta TEXT,
  rewind_at INTEGER
);
`;

interface Fixture {
  path: string;
  db: Database;
}

/**
 * `visible` has JSON/plain user rows, reasoning, a paired tool call and an
 * ask_user row. `cleared` keeps only the message after `cleared_at`.
 * `rewound` has every message hidden by `rewind_at`.
 */
function createFixture(): Fixture {
  const path = join(root, `cindy-${fixtures++}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);

  const session = db.query(
    `INSERT INTO sessions(id, title, working_dir, model, cleared_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  session.run("visible", "New CCS", "/Users/test/project", "test-model", null, 1000, 5000);
  session.run("cleared", "Cleared", "/Users/test/cleared", "test-model", 3000, 1000, 5000);
  session.run("rewound", "Rewound", "/Users/test/rewound", "test-model", null, 1000, 5000);
  session.run(
    "orca",
    "Worker · developer · test",
    "/Users/test/worktree",
    "test-model",
    null,
    1000,
    2000,
  );

  const message = db.query(
    `INSERT INTO messages(id, client_id, session_id, role, content, created_at, rewind_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const add = (
    id: string,
    sessionId: string,
    role: string,
    content: unknown,
    ts: number,
    rewindAt: number | null = null,
  ) =>
    message.run(
      id,
      `client-${id}`,
      sessionId,
      role,
      typeof content === "string" ? content : JSON.stringify(content),
      ts,
      rewindAt,
    );

  add("v1", "visible", "user", { text: "查一下配置", images: [], files: [] }, 1000);
  add("v2", "visible", "thinking", { kind: "thinking", text: "先找配置文件" }, 1100);
  add(
    "v3",
    "visible",
    "tool_use",
    { toolUseId: "call-1", toolName: "Read", input: { file_path: "/p/config.ts" } },
    1200,
  );
  add("v4", "visible", "tool_result", "export const port = 4319;", 1300);
  add(
    "v5",
    "visible",
    "ask_user",
    { requestId: "ask-1", questions: [{ question: "继续吗", header: "确认" }], status: "answered" },
    1350,
  );
  add("v6", "visible", "assistant", "配置在 config.ts", 1400);
  add("v7", "visible", "user", "再问一次", 2000);
  add("v8", "visible", "assistant", "好的", 2100);

  add("c1", "cleared", "user", { text: "清除前的问题" }, 1000);
  add("c2", "cleared", "assistant", "清除前的回答", 1100);
  add("c3", "cleared", "user", { text: "清除后的问题" }, 4000);
  add("c4", "cleared", "assistant", "清除后的回答", 4100);

  add("r1", "rewound", "user", { text: "被撤回的问题" }, 1000, 2000);
  add("r2", "rewound", "assistant", "被撤回的回答", 1100, 2000);

  // Orca workers get their task from the lead, not a typed prompt.
  add(
    "o1",
    "orca",
    "user",
    { orcaSource: "lead", content: "任务：修深链上下文" },
    1000,
  );
  add("o2", "orca", "assistant", "开始处理", 1100);

  return { path, db };
}

async function refsFor(path: string) {
  return cindyAdapter(path).list();
}

test("lists every session and exposes a fingerprint over visible messages", async () => {
  const fixture = createFixture();
  const refs = await refsFor(fixture.path);
  expect(refs.map((ref) => ref.externalId).sort()).toEqual([
    "cleared",
    "orca",
    "visible",
  ]);
  expect(refs.every((ref) => ref.agent === "cindy")).toBe(true);
  expect(refs.every((ref) => ref.sourcePath === fixture.path)).toBe(true);
  fixture.db.close();
});

test("parses turns, role-specific content, and pairs tool results", async () => {
  const fixture = createFixture();
  const ref = (await refsFor(fixture.path)).find((entry) => entry.externalId === "visible");
  const session = await cindyAdapter(fixture.path).load(ref!);
  expect(session).not.toBeNull();

  expect(session!.agent).toBe("cindy");
  expect(session!.sourceKind).toBe("sqlite");
  expect(session!.sourcePath).toBe(fixture.path);
  expect(session!.projectPath).toBe("/Users/test/project");
  // "New CCS" is Cindy's untouched placeholder; the first prompt wins.
  expect(session!.title).toBe("查一下配置");
  expect(session!.startedAt).toBe(1000);
  expect(session!.updatedAt).toBe(5000);

  expect(session!.turns).toHaveLength(2);
  expect(session!.turns[0]!.userText).toBe("查一下配置");
  expect(session!.turns[0]!.assistantText).toBe("配置在 config.ts");
  expect(session!.turns[0]!.model).toBe("test-model");
  expect(session!.turns[1]!.userText).toBe("再问一次");
  expect(session!.turns[1]!.assistantText).toBe("好的");

  const events = session!.events ?? [];
  expect(events.map((event) => event.kind)).toEqual([
    "reasoning",
    "tool",
    "tool",
  ]);
  expect(events.map((event) => event.turnIdx)).toEqual([0, 0, 0]);
  expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);

  expect(events[0]!.output).toBe("先找配置文件");
  expect(events[1]!.name).toBe("Read");
  expect(events[1]!.input).toBe(JSON.stringify({ file_path: "/p/config.ts" }));
  expect(events[1]!.output).toBe("export const port = 4319;");
  expect(events[1]!.meta).toBe("call-1");

  expect(events[2]!.name).toBe("ask_user");
  expect(events[2]!.meta).toBe("answered");

  fixture.db.close();
});

test("filters rewound messages and everything before cleared_at", async () => {
  const fixture = createFixture();
  const refs = await refsFor(fixture.path);

  const cleared = await cindyAdapter(fixture.path).load(
    refs.find((entry) => entry.externalId === "cleared")!,
  );
  expect(cleared!.turns).toHaveLength(1);
  expect(cleared!.turns[0]!.userText).toBe("清除后的问题");

  const rewound = await cindyAdapter(fixture.path).load({
    agent: "cindy",
    externalId: "rewound",
    fingerprint: "x",
    sourcePath: fixture.path,
  });
  expect(rewound).toBeNull();

  fixture.db.close();
});

test("reads an Orca lead message as the worker's prompt", async () => {
  const fixture = createFixture();
  const ref = (await refsFor(fixture.path)).find((entry) => entry.externalId === "orca");
  const session = await cindyAdapter(fixture.path).load(ref!);

  expect(session).not.toBeNull();
  expect(session!.turns).toHaveLength(1);
  expect(session!.turns[0]!.userText).toBe("任务：修深链上下文");
  expect(session!.turns[0]!.assistantText).toBe("开始处理");
  expect(session!.title).toBe("Worker · developer · test");

  fixture.db.close();
});

test("fingerprint changes when a session gains a message", async () => {
  const fixture = createFixture();
  const first = (await refsFor(fixture.path)).find(
    (ref) => ref.externalId === "visible",
  )!.fingerprint;

  fixture.db
    .query(
      `INSERT INTO messages(id, client_id, session_id, role, content, created_at)
       VALUES ('v9', 'client-v9', 'visible', 'assistant', '补充', 2200)`,
    )
    .run();

  const second = (await refsFor(fixture.path)).find(
    (ref) => ref.externalId === "visible",
  )!.fingerprint;
  expect(second).not.toBe(first);
  fixture.db.close();
});

test("Cindy sessions reach the search index without hidden rows", async () => {
  const fixture = createFixture();
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  const report = await scan(db, [cindyAdapter(fixture.path)]);

  expect(report.agents.cindy?.refs).toBe(3);
  expect(report.sessions).toBe(3);

  const params = {
    q: "",
    agents: [],
    project: "",
    from: null,
    to: null,
    role: "all" as const,
    scope: "qa" as const,
    limit: 20,
    offset: 0,
  };
  const found = searchTurns(db, { ...params, q: "配置" });
  expect(found.sessions.map((session) => session.id)).toEqual(["cindy:visible"]);

  const cleared = searchTurns(db, { ...params, q: "清除前" });
  expect(cleared.sessions).toHaveLength(0);
  const rewound = searchTurns(db, { ...params, q: "被撤回" });
  expect(rewound.sessions).toHaveLength(0);

  db.close();
  fixture.db.close();
});
