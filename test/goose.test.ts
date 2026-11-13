import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gooseAdapter } from "../src/adapters/goose.ts";
import type { SessionRef } from "../src/adapters/types.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-goose-"));
let fixtures = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The Goose tables and columns this adapter reads. */
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  model_config_json TEXT,
  parent_session_id TEXT,
  archived_at TIMESTAMP
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT
);
`;

function newDb(name: string): { path: string; db: Database } {
  const path = join(root, `${name}-${fixtures++}.db`);
  const db = new Database(path, { create: true });
  return { path, db };
}

function block(contents: unknown[]): string {
  return JSON.stringify(contents);
}

const base = Date.UTC(2026, 10, 12, 2, 0, 0);

/** One session with a tool round-trip, an agent-only message and a second turn. */
function createFixture(): string {
  const { path, db } = newDb("goose");
  db.run(SCHEMA);
  db.run(
    `INSERT INTO sessions(id, name, description, working_dir, created_at, updated_at,
                          model_config_json, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-1",
      "Goose 会话标题",
      "描述",
      "/Users/test/goose-project",
      "2026-11-12 02:00:00",
      "2026-11-12 02:10:05",
      JSON.stringify({ model_name: "gpt-5" }),
      null,
    ],
  );

  const insert = db.query(
    `INSERT INTO messages(session_id, role, content_json, created_timestamp, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(
    "sess-1",
    "user",
    block([{ type: "text", text: "修复 goose 适配器" }]),
    base / 1000,
    null,
  );
  insert.run(
    "sess-1",
    "assistant",
    block([
      { type: "thinking", thinking: "先看 schema", signature: "sig" },
      { type: "text", text: "Changed it." },
      {
        type: "toolRequest",
        id: "call_1",
        toolCall: {
          status: "success",
          value: { name: "shell", arguments: { command: "bun test" } },
        },
      },
    ]),
    base / 1000 + 5,
    null,
  );
  // Tool results arrive as a user-role message; they must not start a turn.
  insert.run(
    "sess-1",
    "user",
    block([
      {
        type: "toolResponse",
        id: "call_1",
        toolResult: {
          status: "success",
          value: { content: [{ type: "text", text: "1 pass" }], isError: false },
        },
      },
    ]),
    base / 1000 + 6,
    null,
  );
  insert.run(
    "sess-1",
    "assistant",
    block([{ type: "text", text: "Tests pass." }]),
    base / 1000 + 7,
    null,
  );
  insert.run(
    "sess-1",
    "user",
    block([{ type: "text", text: "第二个问题" }]),
    base / 1000 + 60,
    null,
  );
  insert.run(
    "sess-1",
    "assistant",
    block([{ type: "text", text: "回答二" }]),
    base / 1000 + 61,
    null,
  );
  // Agent-only context: never user-visible, never searchable.
  insert.run(
    "sess-1",
    "user",
    block([{ type: "text", text: "HIDDEN-SHOULD-NOT-APPEAR" }]),
    base / 1000 + 70,
    JSON.stringify({ userVisible: false, agentVisible: true }),
  );
  db.close();
  return path;
}

const database = createFixture();
const adapter = gooseAdapter(database);

test("lists Goose sessions with a message-aware fingerprint", async () => {
  const refs = await adapter.list();
  expect(refs).toHaveLength(1);
  expect(refs[0]?.agent).toBe("goose");
  expect(refs[0]?.externalId).toBe("sess-1");
  expect(refs[0]?.sourcePath).toBe(database);
  // updated_at, then message count, then the newest message stamp.
  expect(refs[0]?.fingerprint.startsWith("2026-11-12 02:10:05:7:")).toBe(true);
});

test("maps messages into turns and keeps tool results out of user turns", async () => {
  const refs = await adapter.list();
  const session = await adapter.load(refs[0] as SessionRef);
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.agent).toBe("goose");
  expect(session.projectPath).toBe("/Users/test/goose-project");
  expect(session.title).toBe("Goose 会话标题");
  expect(session.turns).toHaveLength(2);
  expect(session.turns[0]?.userText).toBe("修复 goose 适配器");
  expect(session.turns[0]?.assistantText).toBe("Changed it.\n\nTests pass.");
  expect(session.turns[0]?.model).toBe("gpt-5");
  expect(session.turns[1]?.userText).toBe("第二个问题");
  expect(session.turns[1]?.assistantText).toBe("回答二");
  expect(session.turns[0]?.ts).toBe(base);
  expect(session.startedAt).toBe(Date.parse("2026-11-12T02:00:00.000Z"));
  expect(session.updatedAt).toBe(Date.parse("2026-11-12T02:10:05.000Z"));

  const tool = session.events?.find((event) => event.kind === "tool");
  expect(tool?.name).toBe("shell");
  expect(tool?.input).toContain("bun test");
  expect(tool?.output).toBe("1 pass");
  expect(tool?.meta).toBe("ok");
  const reasoning = session.events?.find((event) => event.kind === "reasoning");
  expect(reasoning?.output).toBe("先看 schema");
  expect(JSON.stringify(session.turns)).not.toContain("HIDDEN-SHOULD-NOT-APPEAR");
});

test("tolerates the older column set and a text timestamp", async () => {
  const path = (() => {
    const { path: file, db } = newDb("goose-legacy");
    db.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        description TEXT,
        working_dir TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);
    db.run(
      `INSERT INTO sessions(id, description, working_dir, created_at, updated_at)
       VALUES ('legacy-1', '旧描述', '/tmp/legacy-project', '2026-11-10 01:00:00', '2026-11-10 01:05:00')`,
    );
    db.run(
      `INSERT INTO messages(session_id, role, content_json, timestamp)
       VALUES ('legacy-1', 'user', ?, '2026-11-10 01:00:00')`,
      [block([{ type: "text", text: "旧版本的问题" }])],
    );
    db.run(
      `INSERT INTO messages(session_id, role, content_json, timestamp)
       VALUES ('legacy-1', 'assistant', ?, '2026-11-10 01:00:05')`,
      [block([{ type: "text", text: "旧版本的回答" }])],
    );
    db.close();
    return file;
  })();

  const legacy = gooseAdapter(path);
  try {
    const refs = await legacy.list();
    expect(refs).toHaveLength(1);
    const session = await legacy.load(refs[0] as SessionRef);
    expect(session).not.toBeNull();
    if (!session) return;
    expect(session.title).toBe("旧描述");
    expect(session.projectPath).toBe("/tmp/legacy-project");
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.userText).toBe("旧版本的问题");
    expect(session.turns[0]?.assistantText).toBe("旧版本的回答");
    expect(session.startedAt).toBe(Date.parse("2026-11-10T01:00:00.000Z"));
    expect(session.updatedAt).toBe(Date.parse("2026-11-10T01:05:00.000Z"));
    expect(await legacy.list()).toHaveLength(1);
  } finally {
    legacy.close?.();
  }
});

test("a store without the messages schema reports no sessions", async () => {
  const { path, db } = newDb("goose-empty");
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  db.run("INSERT INTO sessions(id) VALUES ('only-1')");
  db.close();
  const empty = gooseAdapter(path);
  expect(await empty.list()).toEqual([]);
  expect(await empty.load({
    agent: "goose",
    externalId: "only-1",
    fingerprint: "0",
    sourcePath: path,
  })).toBeNull();
  empty.close?.();
});

test("a missing database lists nothing and does not throw", async () => {
  const missing = gooseAdapter(join(root, "missing", "sessions.db"));
  expect(await missing.list()).toEqual([]);
  missing.close?.();
});

test("reaches the search index through scan", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  const scanner = gooseAdapter(database);
  try {
    const report = await scan(db, [scanner]);
    expect(report.errors).toHaveLength(0);
    const found = searchTurns(db, {
      q: "适配器",
      agents: ["goose"],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 10,
      offset: 0,
    });
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]?.agent).toBe("goose");
  } finally {
    db.close();
  }
});
