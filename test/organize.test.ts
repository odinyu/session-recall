import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetSession,
  openDb,
  SCHEMA_VERSION,
  setSessionFlag,
  unforgetSession,
  writeSession,
} from "../src/db.ts";
import type { IndexedDatabase } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { api } from "../src/server.ts";
import { facets, getSessionDetail, searchTurns } from "../src/search.ts";
import type { SearchParams } from "../src/search.ts";
import type { Adapter, ParsedSession } from "../src/adapters/types.ts";

/**
 * Session organization: star and hide are user data that lives on the session
 * row, outside everything a scan owns. These tests pin the schema migration,
 * the scan invariant, the search filtering and the HTTP surface.
 */

const dirs: string[] = [];

function freshDb(): { db: IndexedDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-recall-organize-"));
  dirs.push(dir);
  const path = join(dir, "index.db");
  return { db: openDb(path), path };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** /tmp keeps the fixture path clear of the redactor's home-directory rule. */
const PROJECT = "/tmp/organize-fixture";

function fixture(externalId: string, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    agent: "omp",
    externalId,
    projectPath: PROJECT,
    title: `fixture ${externalId}`,
    startedAt: Date.UTC(2026, 10, 13, 8),
    updatedAt: Date.UTC(2026, 10, 13, 9),
    sourceKind: "jsonl",
    sourcePath: `/tmp/${externalId}.jsonl`,
    fingerprint: "1",
    turns: [
      {
        idx: 0,
        ts: Date.UTC(2026, 10, 13, 8),
        // "共享" is two characters, so it exercises the LIKE path; the ASCII
        // identifier exercises trigram FTS and the process scope.
        userText: `共享 shared-token ${externalId}`,
        assistantText: "noted",
      },
    ],
    events: [
      {
        turnIdx: 0,
        seq: 0,
        kind: "tool",
        name: "Bash",
        input: `grep shared-token ${externalId}`,
        output: "ok",
      },
    ],
    ...overrides,
  };
}

interface FakeSource {
  adapter: Adapter;
  /** Moves every listed fingerprint at once. */
  fingerprint: string;
  sessions: Map<string, ParsedSession>;
}

function fakeSource(externalIds: string[]): FakeSource {
  const sessions = new Map(externalIds.map((id) => [id, fixture(id)]));
  const source: FakeSource = {
    fingerprint: "f1",
    sessions,
    adapter: {
      id: "omp",
      label: "fake-omp",
      list: async () =>
        [...source.sessions.keys()].map((externalId) => ({
          agent: "omp" as const,
          externalId,
          fingerprint: source.fingerprint,
          sourcePath: `/tmp/${externalId}.jsonl`,
        })),
      load: async (ref) => source.sessions.get(ref.externalId) ?? null,
    },
  };
  return source;
}

function params(overrides: Partial<SearchParams> = {}): SearchParams {
  return {
    q: "",
    agents: [],
    project: "",
    from: null,
    to: null,
    role: "all",
    scope: "qa",
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

function flagsRow(
  db: IndexedDatabase,
  id: string,
): { starred: number; hidden: number } | null {
  return db
    .query("SELECT starred, hidden FROM session WHERE id = ?")
    .get(id) as { starred: number; hidden: number } | null;
}

function indexedFlags(
  db: IndexedDatabase,
  id: string,
): { starred: number; hidden: number } | null {
  const detail = getSessionDetail(db, id) as {
    session: { starred: number; hidden: number };
  } | null;
  return detail
    ? { starred: detail.session.starred, hidden: detail.session.hidden }
    : null;
}

/** Four sessions covering every combination of the two flags. */
function organizedDb(): IndexedDatabase {
  const { db } = freshDb();
  for (const id of ["keep", "star", "hid", "both"]) writeSession(db, fixture(id));
  setSessionFlag(db, "omp", "star", "starred", true);
  setSessionFlag(db, "omp", "hid", "hidden", true);
  setSessionFlag(db, "omp", "both", "starred", true);
  setSessionFlag(db, "omp", "both", "hidden", true);
  return db;
}

function ids(db: IndexedDatabase, overrides: Partial<SearchParams> = {}): string[] {
  return searchTurns(db, params(overrides))
    .sessions.map((session) => session.id)
    .sort();
}

const ALL = ["omp:both", "omp:hid", "omp:keep", "omp:star"];
const VISIBLE = ["omp:keep", "omp:star"];

// --- schema -----------------------------------------------------------------

test("a v5 index gains starred/hidden on upgrade and keeps its rows", () => {
  const { db, path } = freshDb();
  writeSession(db, fixture("legacy"));
  // Shape it like a real v5 index: no flag columns and no flag indexes.
  db.run("DROP INDEX IF EXISTS session_starred");
  db.run("DROP INDEX IF EXISTS session_hidden");
  db.run("ALTER TABLE session DROP COLUMN starred");
  db.run("ALTER TABLE session DROP COLUMN hidden");
  db.run("PRAGMA user_version = 5");
  db.close();

  const reopened = openDb(path);
  try {
    expect(SCHEMA_VERSION).toBe(6);
    const version = reopened.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(6);

    const columns = reopened.query("PRAGMA table_info(session)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect(byName.get("starred")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });
    expect(byName.get("hidden")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });

    // Existing rows survive and start out unflagged.
    expect(flagsRow(reopened, "omp:legacy")).toEqual({ starred: 0, hidden: 0 });

    const indexes = (
      reopened
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toContain("session_starred");
    expect(indexes).toContain("session_hidden");
  } finally {
    reopened.close();
  }
});

test("a migrated index has the same session shape as a fresh one", () => {
  const { db: upgraded, path } = freshDb();
  upgraded.run("DROP INDEX IF EXISTS session_starred");
  upgraded.run("DROP INDEX IF EXISTS session_hidden");
  upgraded.run("ALTER TABLE session DROP COLUMN starred");
  upgraded.run("ALTER TABLE session DROP COLUMN hidden");
  upgraded.run("PRAGMA user_version = 5");
  upgraded.close();

  const shape = (db: IndexedDatabase) =>
    (db.query("PRAGMA table_info(session)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[]).map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }));

  const migrated = openDb(path);
  const fresh = freshDb();
  try {
    expect(shape(migrated)).toEqual(shape(fresh.db));
  } finally {
    migrated.close();
    fresh.db.close();
  }
});

// --- mutators ---------------------------------------------------------------

test("star and hide round-trip through the session row", () => {
  const { db } = freshDb();
  try {
    writeSession(db, fixture("round"));
    expect(setSessionFlag(db, "omp", "round", "starred", true)).toEqual({
      id: "omp:round",
      value: true,
    });
    expect(flagsRow(db, "omp:round")).toEqual({ starred: 1, hidden: 0 });

    expect(setSessionFlag(db, "omp", "round", "hidden", true)).toEqual({
      id: "omp:round",
      value: true,
    });
    expect(flagsRow(db, "omp:round")).toEqual({ starred: 1, hidden: 1 });

    expect(setSessionFlag(db, "omp", "round", "starred", false)).toEqual({
      id: "omp:round",
      value: false,
    });
    expect(flagsRow(db, "omp:round")).toEqual({ starred: 0, hidden: 1 });

    // An unknown session is reported, not silently ignored.
    expect(setSessionFlag(db, "omp", "absent", "starred", true)).toBeNull();
  } finally {
    db.close();
  }
});

// --- the scan never owns these columns --------------------------------------

test("a rescan keeps starred/hidden through both the skip and the rewrite path", async () => {
  const { db } = freshDb();
  try {
    const source = fakeSource(["pinned"]);
    await scan(db, [source.adapter]);
    setSessionFlag(db, "omp", "pinned", "starred", true);
    setSessionFlag(db, "omp", "pinned", "hidden", true);

    // Same fingerprint: the scan skips the write altogether.
    await scan(db, [source.adapter]);
    expect(indexedFlags(db, "omp:pinned")).toEqual({ starred: 1, hidden: 1 });

    // A changed fingerprint rewrites the row through INSERT ... ON CONFLICT.
    source.fingerprint = "f2";
    source.sessions.set("pinned", { ...fixture("pinned"), title: "fixture pinned v2" });
    const report = await scan(db, [source.adapter]);
    expect(report.agents.omp?.updated).toBe(1);
    const detail = getSessionDetail(db, "omp:pinned") as {
      session: { title: string; starred: number; hidden: number };
    };
    expect(detail.session.title).toBe("fixture pinned v2");
    expect(detail.session.starred).toBe(1);
    expect(detail.session.hidden).toBe(1);

    // A session indexed for the first time starts from the column defaults.
    source.sessions.set("newer", fixture("newer"));
    await scan(db, [source.adapter]);
    expect(indexedFlags(db, "omp:newer")).toEqual({ starred: 0, hidden: 0 });
  } finally {
    db.close();
  }
});

// --- search -----------------------------------------------------------------

test("hidden sessions leave every search mode unless includeHidden is set", () => {
  const db = organizedDb();
  try {
    // Empty query (recent), trigram FTS, LIKE and process scope all share the
    // same base clause, so the rule has to hold in each.
    expect(ids(db)).toEqual(VISIBLE);
    expect(ids(db, { includeHidden: true })).toEqual(ALL);

    expect(ids(db, { q: "shared-token" })).toEqual(VISIBLE);
    expect(ids(db, { q: "shared-token", includeHidden: true })).toEqual(ALL);

    expect(ids(db, { q: "共享" })).toEqual(VISIBLE);
    expect(ids(db, { q: "共享", includeHidden: true })).toEqual(ALL);

    expect(ids(db, { q: "shared-token", scope: "process" })).toEqual(VISIBLE);
    expect(ids(db, { q: "shared-token", scope: "process", includeHidden: true })).toEqual(
      ALL,
    );
  } finally {
    db.close();
  }
});

test("starred narrows results without resurrecting hidden sessions", () => {
  const db = organizedDb();
  try {
    expect(ids(db, { starred: true })).toEqual(["omp:star"]);
    // `both` is starred and hidden: only an explicit includeHidden shows it.
    expect(ids(db, { starred: true, includeHidden: true })).toEqual([
      "omp:both",
      "omp:star",
    ]);
    expect(ids(db, { starred: true, q: "shared-token" })).toEqual(["omp:star"]);
    expect(ids(db, { starred: true, q: "shared-token", scope: "process" })).toEqual([
      "omp:star",
    ]);
  } finally {
    db.close();
  }
});

test("results carry the flags they were filtered on", () => {
  const db = organizedDb();
  try {
    const withHidden = searchTurns(db, params({ includeHidden: true }));
    const byId = new Map(withHidden.sessions.map((session) => [session.id, session]));
    expect(byId.get("omp:both")).toMatchObject({ starred: true, hidden: true });
    expect(byId.get("omp:hid")).toMatchObject({ starred: false, hidden: true });
    expect(byId.get("omp:star")).toMatchObject({ starred: true, hidden: false });
    expect(byId.get("omp:keep")).toMatchObject({ starred: false, hidden: false });
  } finally {
    db.close();
  }
});

test("facets count the flags while the indexed total stays whole", () => {
  const db = organizedDb();
  try {
    const result = facets(db);
    // `star` is visible and starred, so the starred filter returns 1; `both`
    // is starred but hidden and would not come back, so it is not counted.
    expect(result.starredCount).toBe(1);
    expect(result.hiddenCount).toBe(2);
    // Filter counts describe the default view ...
    expect(result.agents).toEqual([{ id: "omp", sessions: 2 }]);
    expect(result.projects).toEqual([{ path: PROJECT, sessions: 2 }]);
    // ... while the index total still counts every row.
    expect(result.total.sessions).toBe(4);
  } finally {
    db.close();
  }
});

// --- forgetting -------------------------------------------------------------

test("forgetting drops the flags and unforget does not restore them", async () => {
  const { db } = freshDb();
  try {
    const source = fakeSource(["flagged"]);
    await scan(db, [source.adapter]);
    setSessionFlag(db, "omp", "flagged", "starred", true);
    setSessionFlag(db, "omp", "flagged", "hidden", true);

    forgetSession(db, "omp", "flagged");
    expect(getSessionDetail(db, "omp:flagged")).toBeNull();
    expect(flagsRow(db, "omp:flagged")).toBeNull();
    expect(facets(db).starredCount).toBe(0);
    expect(facets(db).hiddenCount).toBe(0);

    expect(unforgetSession(db, "omp", "flagged")).toBe(true);
    // Unforgetting only clears the skip marker; the deleted row stays deleted.
    expect(getSessionDetail(db, "omp:flagged")).toBeNull();
    expect(facets(db).starredCount).toBe(0);
    expect(facets(db).hiddenCount).toBe(0);

    // The next scan re-indexes it from the source, back to the defaults.
    await scan(db, [source.adapter]);
    expect(indexedFlags(db, "omp:flagged")).toEqual({ starred: 0, hidden: 0 });
    expect(facets(db).starredCount).toBe(0);
    expect(facets(db).hiddenCount).toBe(0);
  } finally {
    db.close();
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

test("POST /api/session/:id/star flips the flag and the detail reflects it", async () => {
  const { db } = freshDb();
  try {
    writeSession(db, fixture("api"));

    const on = await callApi(db, "POST", "/api/session/omp:api/star", { starred: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ id: "omp:api", starred: true });
    expect(flagsRow(db, "omp:api")).toEqual({ starred: 1, hidden: 0 });

    const detail = await callApi(db, "GET", "/api/session/omp:api");
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { session: { starred: boolean } }).session.starred).toBe(
      true,
    );

    const off = await callApi(db, "POST", "/api/session/omp:api/star", { starred: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ id: "omp:api", starred: false });
    expect(flagsRow(db, "omp:api")).toEqual({ starred: 0, hidden: 0 });
  } finally {
    db.close();
  }
});

test("POST /api/session/:id/hide flips the flag and search follows", async () => {
  const { db } = freshDb();
  try {
    writeSession(db, fixture("api"));

    const on = await callApi(db, "POST", "/api/session/omp:api/hide", { hidden: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ id: "omp:api", hidden: true });

    const visible = await callApi(db, "GET", "/api/search?q=shared-token");
    const visibleBody = (await visible.json()) as { sessions: unknown[] };
    expect(visibleBody.sessions).toHaveLength(0);

    const all = await callApi(db, "GET", "/api/search?q=shared-token&includeHidden=1");
    const allBody = (await all.json()) as { sessions: { id: string; hidden: boolean }[] };
    expect(allBody.sessions.map((session) => session.id)).toEqual(["omp:api"]);
    expect(allBody.sessions[0]?.hidden).toBe(true);

    const counts = (await (await callApi(db, "GET", "/api/facets")).json()) as {
      starredCount: number;
      hiddenCount: number;
    };
    expect(counts.hiddenCount).toBe(1);
    expect(counts.starredCount).toBe(0);
  } finally {
    db.close();
  }
});

test("GET /api/search applies the starred filter", async () => {
  const db = organizedDb();
  try {
    const starred = (await (
      await callApi(db, "GET", "/api/search?starred=1&includeHidden=1")
    ).json()) as { sessions: { id: string }[] };
    expect(starred.sessions.map((session) => session.id).sort()).toEqual([
      "omp:both",
      "omp:star",
    ]);

    // The UI may write `true`; both spellings mean the same thing.
    const visibleOnly = (await (
      await callApi(db, "GET", "/api/search?starred=true")
    ).json()) as { sessions: { id: string }[] };
    expect(visibleOnly.sessions.map((session) => session.id)).toEqual(["omp:star"]);
  } finally {
    db.close();
  }
});

test("flag routes reject unknown ids, bad bodies and wrong methods", async () => {
  const { db } = freshDb();
  try {
    writeSession(db, fixture("api"));

    const missing = await callApi(db, "POST", "/api/session/omp:absent/star", {
      starred: true,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "session not found" });

    // Wrong key for the route, non-boolean value, malformed JSON, non-object.
    expect(
      (await callApi(db, "POST", "/api/session/omp:api/star", { hidden: true })).status,
    ).toBe(400);
    expect(
      (await callApi(db, "POST", "/api/session/omp:api/star", { starred: "yes" })).status,
    ).toBe(400);
    expect(
      (await callApi(db, "POST", "/api/session/omp:api/hide", { hidden: 1 })).status,
    ).toBe(400);
    expect(
      (await callApi(db, "POST", "/api/session/omp:api/star", "not json")).status,
    ).toBe(400);
    expect(
      (await callApi(db, "POST", "/api/session/omp:api/star", [true])).status,
    ).toBe(400);

    // A path segment that is not a session id is a client error, like /forget.
    expect(
      (await callApi(db, "POST", "/api/session/nocolon/star", { starred: true })).status,
    ).toBe(400);
    // A malformed percent escape must be a client error, not a 500.
    expect(
      (await callApi(db, "POST", "/api/session/omp:%E0%A4%A/star", { starred: true }))
        .status,
    ).toBe(400);

    expect((await callApi(db, "GET", "/api/session/omp:api/star")).status).toBe(405);
    expect((await callApi(db, "DELETE", "/api/session/omp:api/hide")).status).toBe(405);

    // No rejected request may have written anything.
    expect(flagsRow(db, "omp:api")).toEqual({ starred: 0, hidden: 0 });
  } finally {
    db.close();
  }
});
