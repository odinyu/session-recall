import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSavedSearch,
  listSavedSearches,
  openDb,
  SCHEMA_VERSION,
  setMeta,
} from "../src/db.ts";
import type { IndexedDatabase } from "../src/db.ts";
import { api } from "../src/server.ts";
import { recallSavedSearches } from "../src/mcp.ts";
import type { McpContext } from "../src/mcp.ts";

/**
 * Saved searches: a named query + filter bookmark the web hash router expands.
 * The server stores and validates rows; it never resolves them into results.
 */

const dirs: string[] = [];

function freshDb(): { db: IndexedDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-recall-saved-"));
  dirs.push(dir);
  const path = join(dir, "index.db");
  return { db: openDb(path), path };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// --- schema -----------------------------------------------------------------

test("a fresh index has the saved_search table and SCHEMA_VERSION is 7", () => {
  const { db } = freshDb();
  try {
    expect(SCHEMA_VERSION).toBe(7);
    const search = createSavedSearch(db, { name: "fresh", query: "q", filters: {} });
    expect(search.id).toMatch(/^ss-[0-9a-f]{8}$/);
    expect(listSavedSearches(db).map((row) => row.name)).toEqual(["fresh"]);
  } finally {
    db.close();
  }
});

test("a v6 index gains saved_search on upgrade and works right away", () => {
  const { db, path } = freshDb();
  db.run("DROP TABLE saved_search");
  db.run("PRAGMA user_version = 6");
  db.close();

  const reopened = openDb(path);
  try {
    const version = reopened.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(7);
    const search = createSavedSearch(reopened, { name: "migrated", filters: {} });
    expect(search.id).toMatch(/^ss-[0-9a-f]{8}$/);
    expect(listSavedSearches(reopened).map((row) => row.name)).toEqual(["migrated"]);
  } finally {
    reopened.close();
  }
});

// --- HTTP surface -----------------------------------------------------------

function callApi(
  db: IndexedDatabase,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://127.0.0.1${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return api(new Request(url, init), url, db);
}

test("POST /api/saved-searches creates and GET lists newest first", async () => {
  const { db } = freshDb();
  try {
    const first = await callApi(db, "POST", "/api/saved-searches", {
      name: "tvbox 调试",
      query: "tvbox",
      // Booleans travel as "1"/"0", the form a query string carries; unknown
      // keys are preserved like prefs.
      filters: { scope: "process", agents: "omp", starred: "1", custom: "kept" },
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      id: string;
      name: string;
      query: string;
      filters: Record<string, string>;
      createdAt: number;
    };
    expect(created.id).toMatch(/^ss-[0-9a-f]{8}$/);
    expect(created.name).toBe("tvbox 调试");
    expect(created.query).toBe("tvbox");
    expect(created.filters).toEqual({
      scope: "process",
      agents: "omp",
      starred: "1",
      custom: "kept",
    });
    expect(typeof created.createdAt).toBe("number");

    const second = await callApi(db, "POST", "/api/saved-searches", {
      name: "newer",
      filters: {},
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string; query: string };
    // query is optional and defaults to empty.
    expect(secondBody.query).toBe("");

    // Make the ordering deterministic: demote the first row below the second.
    db.run("UPDATE saved_search SET created_at = created_at - 1 WHERE id = ?", [
      created.id,
    ]);
    const list = await callApi(db, "GET", "/api/saved-searches");
    const body = (await list.json()) as {
      searches: { id: string; filters: Record<string, string> }[];
    };
    expect(body.searches.map((row) => row.id)).toEqual([secondBody.id, created.id]);
    // Unknown keys survive the round-trip.
    const original = body.searches.find((row) => row.id === created.id);
    expect(original?.filters.custom).toBe("kept");
  } finally {
    db.close();
  }
});

test("saved-search validation: names, filters, methods and unknown ids", async () => {
  const { db } = freshDb();
  try {
    const post = (body: unknown) => callApi(db, "POST", "/api/saved-searches", body);
    expect((await post({ name: "  ", filters: {} })).status).toBe(400);
    expect((await post({ filters: {} })).status).toBe(400);
    expect((await post({ name: "ok" })).status).toBe(400);
    expect((await post({ name: "x".repeat(201), filters: {} })).status).toBe(400);
    expect((await post({ name: "x".repeat(200), filters: {} })).status).toBe(201);
    expect((await post({ name: "ok", filters: "scope=process" })).status).toBe(400);
    expect((await post({ name: "ok", filters: [] })).status).toBe(400);
    // Strict string-only values: one canonical form, the query string.
    expect((await post({ name: "ok", filters: { starred: true } })).status).toBe(400);
    expect((await post({ name: "ok", filters: { limit: 10 } })).status).toBe(400);
    expect((await post({ name: "ok", filters: { nested: {} } })).status).toBe(400);
    expect((await post({ name: "ok", filters: { starred: null } })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post([1])).status).toBe(400);
    expect((await callApi(db, "PUT", "/api/saved-searches")).status).toBe(405);

    const created = (await (
      await post({ name: "patch me", query: "old", filters: { scope: "qa" } })
    ).json()) as { id: string };

    const renamed = await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, {
      name: "  renamed  ",
    });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as {
      name: string;
      query: string;
      filters: Record<string, string>;
      createdAt: number;
    };
    // The name is trimmed; untouched fields stay exactly as stored.
    expect(renamedBody.name).toBe("renamed");
    expect(renamedBody.query).toBe("old");
    expect(renamedBody.filters).toEqual({ scope: "qa" });
    expect(typeof renamedBody.createdAt).toBe("number");

    const refiltered = await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, {
      query: "new",
      filters: { hiddenOnly: "1" },
    });
    const refilteredBody = (await refiltered.json()) as {
      name: string;
      query: string;
      filters: Record<string, string>;
    };
    expect(refilteredBody.query).toBe("new");
    expect(refilteredBody.filters).toEqual({ hiddenOnly: "1" });
    expect(refilteredBody.name).toBe("renamed");

    expect((await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, {})).status).toBe(
      400,
    );
    expect(
      (await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, { name: "" })).status,
    ).toBe(400);
    expect(
      (await callApi(db, "PATCH", "/api/saved-searches/ss-00000000", { name: "x" })).status,
    ).toBe(404);
    // Explicit null is a client bug: fields cannot be cleared, so reject it
    // instead of silently re-storing the old value.
    expect(
      (await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, { name: null }))
        .status,
    ).toBe(400);
    expect(
      (await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, { filters: null }))
        .status,
    ).toBe(400);
    // The same string-only rule applies to patches.
    expect(
      (
        await callApi(db, "PATCH", `/api/saved-searches/${created.id}`, {
          filters: { limit: 1 },
        })
      ).status,
    ).toBe(400);
    // A malformed id is simply unknown to the store, like any other miss.
    expect(
      (await callApi(db, "PATCH", "/api/saved-searches/not-an-id", { name: "x" })).status,
    ).toBe(404);

    const removed = await callApi(db, "DELETE", `/api/saved-searches/${created.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: created.id });
    expect((await callApi(db, "DELETE", `/api/saved-searches/${created.id}`)).status).toBe(
      404,
    );
    expect((await callApi(db, "DELETE", "/api/saved-searches/ss-00000000")).status).toBe(
      404,
    );
    expect(
      (await callApi(db, "PUT", `/api/saved-searches/${created.id}`, { name: "x" })).status,
    ).toBe(405);

    // Only the long-name row created above is left.
    const list = await callApi(db, "GET", "/api/saved-searches");
    const body = (await list.json()) as { searches: { name: string }[] };
    expect(body.searches).toHaveLength(1);
    expect(body.searches[0]?.name).toBe("x".repeat(200));
  } finally {
    db.close();
  }
});

test("a corrupt saved_search row is skipped, not fatal", () => {
  const { db } = freshDb();
  try {
    createSavedSearch(db, { name: "good", filters: {} });
    db.run(
      "INSERT INTO saved_search(id, name, query, filters_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ["ss-badjson", "bad json", "", "not json", 1],
    );
    db.run(
      "INSERT INTO saved_search(id, name, query, filters_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ["ss-badname", "   ", "", "{}", 2],
    );
    db.run(
      "INSERT INTO saved_search(id, name, query, filters_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ["ss-badfilters", "bad filters", "", "[1,2]", 3],
    );
    expect(listSavedSearches(db).map((row) => row.name)).toEqual(["good"]);
  } finally {
    db.close();
  }
});

// --- CLI --------------------------------------------------------------------

const root = join(import.meta.dir, "..");
const cliDir = mkdtempSync(join(tmpdir(), "session-recall-saved-cli-"));
dirs.push(cliDir);
const cliDbPath = join(cliDir, "index.db");
openDb(cliDbPath).close();

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", "saved", ...args],
    cwd: root,
    env: { ...process.env, SESSION_RECALL_DB: cliDbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("CLI add/list/remove round-trips a saved search", () => {
  const add = runCli([
    "add",
    "tvbox 调试",
    "tvbox",
    "--filters",
    '{"scope":"process","starred":"1"}',
  ]);
  expect(add.code).toBe(0);
  const id = /ss-[0-9a-f]{8}/.exec(add.stdout)?.[0];
  expect(id).toBeDefined();

  const list = runCli(["list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain(id as string);
  expect(list.stdout).toContain("tvbox 调试");
  expect(list.stdout).toContain('"scope":"process"');
  expect(list.stdout).toContain('"starred":"1"');

  const remove = runCli(["remove", id as string]);
  expect(remove.code).toBe(0);
  expect(remove.stdout).toContain("已删除");

  const gone = runCli(["remove", id as string]);
  expect(gone.code).toBe(1);
  expect(gone.stderr).toContain("不存在");

  const empty = runCli(["list"]);
  expect(empty.code).toBe(0);
  expect(empty.stdout).toContain("没有保存的搜索");
});

test("CLI rejects bad usage and documents the commands", () => {
  expect(runCli(["add"]).code).toBe(2);
  expect(runCli(["add", "name", "query", "--filters", "not json"]).code).toBe(2);
  // Non-string filter values are rejected at write time, CLI included.
  const numeric = runCli(["add", "name", "query", "--filters", '{"limit":10}']);
  expect(numeric.code).toBe(2);
  expect(numeric.stderr).toContain("filters.limit must be a string");
  expect(runCli(["add", "name", "query", "--filters"]).code).toBe(2);
  expect(runCli(["add", "name", "query", "--filters"]).stderr).toContain(
    "--filters requires",
  );
  expect(runCli(["remove"]).code).toBe(2);
  expect(runCli(["wat"]).code).toBe(2);
  expect(runCli([]).code).toBe(2);
  expect(runCli([]).stderr).toContain("saved <list|add|remove>");

  const help = runCli(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("saved add");
  expect(help.stdout).toContain("--filters");
});

// --- MCP --------------------------------------------------------------------

function mcpContext(dbPath: string): McpContext {
  return {
    dbPath,
    maxAgeMs: 5 * 60 * 1000,
    staleLockMs: 10 * 60 * 1000,
    scanLockTimeoutMs: 1_000,
    // Never let a tool call touch the host's real agent stores.
    adapters: [],
  };
}

function payload(result: { isError?: boolean; content: { text: string }[] }): Record<
  string,
  unknown
> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("recall_saved_searches lists saved searches, read-only", () => {
  const { db, path } = freshDb();
  try {
    createSavedSearch(db, { name: "tvbox 调试", query: "tvbox", filters: { scope: "process" } });
    setMeta(db, "last_scan_ms", String(Date.now()));
  } finally {
    db.close();
  }

  const data = payload(recallSavedSearches(mcpContext(path)));
  expect(data.total).toBe(1);
  const searches = data.searches as {
    id: string;
    name: string;
    query: string;
    filters: Record<string, string>;
    date: string;
  }[];
  expect(searches[0]?.id).toMatch(/^ss-[0-9a-f]{8}$/);
  expect(searches[0]?.name).toBe("tvbox 调试");
  expect(searches[0]?.query).toBe("tvbox");
  expect(searches[0]?.filters).toEqual({ scope: "process" });
  expect(String(searches[0]?.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("recall_saved_searches reports an empty list without erroring", () => {
  const { path } = freshDb();
  const data = payload(recallSavedSearches(mcpContext(path)));
  expect(data.total).toBe(0);
  expect(data.searches).toEqual([]);
});
