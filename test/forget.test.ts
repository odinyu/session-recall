import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetSession,
  forgottenIds,
  fingerprintsFor,
  openDb,
  SCHEMA_VERSION,
  splitSessionId,
  unforgetSession,
  writeSession,
} from "../src/db.ts";
import type { IndexedDatabase } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { facets, getSessionDetail, searchTurns } from "../src/search.ts";
import type { SearchParams } from "../src/search.ts";
import type { Adapter, ParsedSession, SessionRef } from "../src/adapters/types.ts";

/**
 * Forgetting a session: it leaves every read path, and no later scan brings it
 * back — not even when the source is still on disk with a newer fingerprint.
 */

const dirs: string[] = [];

function freshDb(): { db: IndexedDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-recall-forget-"));
  dirs.push(dir);
  const path = join(dir, "index.db");
  return { db: openDb(path), path };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function params(q: string): SearchParams {
  return {
    q,
    agents: [],
    project: "",
    from: null,
    to: null,
    role: "all",
    scope: "qa",
    limit: 20,
    offset: 0,
  };
}

interface StoredDetail {
  session: { id: string; project_path: string };
  turns: { user_text: string; assistant_text: string }[];
}

function detail(db: IndexedDatabase, id: string): StoredDetail | null {
  return getSessionDetail(db, id) as StoredDetail | null;
}

/** /tmp keeps the fixture path clear of the redactor's home-directory rule. */
const PROJECT = "/tmp/forget-fixture";

function fixture(externalId: string, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    agent: "omp",
    externalId,
    projectPath: PROJECT,
    title: `fixture ${externalId}`,
    startedAt: Date.UTC(2026, 10, 12, 8),
    updatedAt: Date.UTC(2026, 10, 12, 9),
    sourceKind: "jsonl",
    sourcePath: `/tmp/${externalId}.jsonl`,
    fingerprint: "1",
    turns: [
      {
        idx: 0,
        ts: Date.UTC(2026, 10, 12, 8),
        userText: `forget marker ${externalId}`,
        assistantText: "acknowledged",
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
  const refs: SessionRef[] = externalIds.map((externalId) => ({
    agent: "omp",
    externalId,
    fingerprint: "f1",
    sourcePath: `/tmp/${externalId}.jsonl`,
  }));
  const source: FakeSource = {
    fingerprint: "f1",
    sessions,
    adapter: {
      id: "omp",
      label: "fake-omp",
      list: async () =>
        refs.map((ref) => ({ ...ref, fingerprint: source.fingerprint })),
      load: async (ref) => source.sessions.get(ref.externalId) ?? null,
    },
  };
  return source;
}

test("writeSession redacts secrets before they reach the index", () => {
  const { db } = freshDb();
  try {
    // Built from readable parts so this file holds no credential-like literal.
    const b64 = (text: string) => Buffer.from(text).toString("base64url");
    const key = ["sk", "live", b64("forget-test-secret")].join("-");
    const bearer = [b64('{"alg":"none"}'), b64('{"sub":"forget"}'), b64("forget-signature")].join(
      ".",
    );
    writeSession(
      db,
      fixture("secret", {
        turns: [
          {
            idx: 0,
            ts: Date.UTC(2026, 10, 12, 8),
            userText: `export OPENAI_API_KEY=${key}`,
            assistantText: `curl -H 'Authorization: Bearer ${bearer}'`,
          },
        ],
      }),
    );

    const stored = detail(db, "omp:secret");
    expect(stored).not.toBeNull();
    const text = stored?.turns
      .map((turn) => `${turn.user_text}\n${turn.assistant_text}`)
      .join("\n");
    expect(text).not.toContain(key);
    expect(text).not.toContain(bearer);
    // The key name stays, so the transcript is still readable and searchable.
    expect(text).toContain("export OPENAI_API_KEY=");
    expect(searchTurns(db, params("9f2c7d41e5b3a6c8")).sessions).toHaveLength(0);
    expect(searchTurns(db, params("OPENAI_API_KEY")).sessions.map((row) => row.id)).toEqual([
      "omp:secret",
    ]);
  } finally {
    db.close();
  }
});

test("forget removes the session from every read path", () => {
  const { db } = freshDb();
  try {
    writeSession(db, fixture("kept"));
    writeSession(db, fixture("forgotten"));

    expect(detail(db, "omp:forgotten")).not.toBeNull();
    expect(searchTurns(db, params("forgotten")).sessions.map((row) => row.id)).toEqual([
      "omp:forgotten",
    ]);
    expect(facets(db).total.sessions).toBe(2);

    const outcome = forgetSession(db, "omp", "forgotten");
    expect(outcome).toEqual({ id: "omp:forgotten", removed: true, already: false });

    expect(detail(db, "omp:forgotten")).toBeNull();
    expect(searchTurns(db, params("forgotten")).sessions).toHaveLength(0);
    expect(forgottenIds(db).has("omp:forgotten")).toBe(true);

    const left = facets(db);
    expect(left.total.sessions).toBe(1);
    expect(left.total.turns).toBe(1);
    expect(left.agents).toEqual([{ id: "omp", sessions: 1 }]);
    expect(left.projects).toEqual([{ path: PROJECT, sessions: 1 }]);

    // Forgetting again keeps the marker and reports the session as already gone.
    expect(forgetSession(db, "omp", "forgotten")).toEqual({
      id: "omp:forgotten",
      removed: false,
      already: true,
    });
  } finally {
    db.close();
  }
});

test("a forget survives rescans even after the fingerprint changes", async () => {
  const { db } = freshDb();
  try {
    const source = fakeSource(["rescan"]);
    await scan(db, [source.adapter]);
    expect(detail(db, "omp:rescan")).not.toBeNull();

    forgetSession(db, "omp", "rescan");
    expect(detail(db, "omp:rescan")).toBeNull();

    // The source still lists the session and its content moved on; an index-only
    // delete would have put it straight back on the next scan.
    source.fingerprint = "f2";
    source.sessions.set("rescan", { ...fixture("rescan"), title: "fixture rescan v2" });
    await scan(db, [source.adapter]);
    expect(detail(db, "omp:rescan")).toBeNull();

    source.fingerprint = "f3";
    const report = await scan(db, [source.adapter]);
    expect(report.sessions).toBe(0);
    expect(detail(db, "omp:rescan")).toBeNull();
    expect(searchTurns(db, params("rescan")).sessions).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("a fingerprint from before the redaction revision is re-read and rewritten", async () => {
  const { db } = freshDb();
  try {
    const source = fakeSource(["legacy"]);
    const b64 = (text: string) => Buffer.from(text).toString("base64url");
    const key = ["sk", "live", b64("old-index-secret")].join("-");
    // The source holds a secret; the index row is what an older build left
    // behind: raw text and a fingerprint without the redaction revision.
    source.sessions.set("legacy", {
      ...fixture("legacy"),
      turns: [
        {
          idx: 0,
          ts: Date.UTC(2026, 10, 12, 8),
          userText: `export OPENAI_API_KEY=${key}`,
          assistantText: "ok",
        },
      ],
    });
    writeSession(db, fixture("legacy"));
    db.run("UPDATE turn SET user_text = ? WHERE session_id = ?", [`stored ${key}`, "omp:legacy"]);
    db.run("UPDATE session SET source_fingerprint = ? WHERE id = ?", ["f1:v1", "omp:legacy"]);
    expect(detail(db, "omp:legacy")?.turns[0]?.user_text).toContain(key);

    await scan(db, [source.adapter]);

    const rewritten = detail(db, "omp:legacy");
    expect(rewritten?.turns[0]?.user_text).not.toContain(key);
    expect(rewritten?.turns[0]?.user_text).toContain("export OPENAI_API_KEY=");
    expect(fingerprintsFor(db, "omp").get("omp:legacy")).toBe("f1:v1:r1");
    expect(searchTurns(db, params(key)).sessions).toHaveLength(0);
    expect(searchTurns(db, params("OPENAI_API_KEY")).sessions.map((row) => row.id)).toEqual([
      "omp:legacy",
    ]);
  } finally {
    db.close();
  }
});

test("scan drops residual rows when every listed ref is forgotten", async () => {
  const { db } = freshDb();
  try {
    const source = fakeSource(["gone"]);
    await scan(db, [source.adapter]);
    expect(detail(db, "omp:gone")).not.toBeNull();

    // A crash between writing the marker and deleting the rows leaves exactly
    // this state: the ref list filters down to nothing, and the rows still go.
    db.run("INSERT INTO forgotten_session(id, at) VALUES (?, ?)", ["omp:gone", Date.now()]);
    const report = await scan(db, [source.adapter]);
    expect(report.agents.omp?.removed).toBe(1);
    expect(detail(db, "omp:gone")).toBeNull();
    expect(searchTurns(db, params("gone")).sessions).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("an empty listing keeps the index but still drops a forgotten session", async () => {
  const { db } = freshDb();
  try {
    writeSession(db, fixture("kept"));
    writeSession(db, fixture("gone"));
    db.run("INSERT INTO forgotten_session(id, at) VALUES (?, ?)", ["omp:gone", Date.now()]);

    const empty: Adapter = {
      id: "omp",
      label: "empty-omp",
      list: async () => [],
      load: async () => null,
    };
    const report = await scan(db, [empty]);

    // An empty listing reads as a source outage, so the rest of the index is
    // protected ...
    expect(detail(db, "omp:kept")).not.toBeNull();
    // ... while a forgotten session must never survive a scan.
    expect(detail(db, "omp:gone")).toBeNull();
    expect(report.agents.omp?.removed).toBe(1);
    expect(searchTurns(db, params("gone")).sessions).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("unforget lets the next scan index the session again", async () => {
  const { db } = freshDb();
  try {
    const source = fakeSource(["again"]);
    await scan(db, [source.adapter]);
    forgetSession(db, "omp", "again");
    expect(detail(db, "omp:again")).toBeNull();

    expect(unforgetSession(db, "omp", "again")).toBe(true);
    expect(unforgetSession(db, "omp", "again")).toBe(false);
    expect(forgottenIds(db).size).toBe(0);

    await scan(db, [source.adapter]);
    expect(detail(db, "omp:again")).not.toBeNull();
    expect(searchTurns(db, params("again")).sessions.map((row) => row.id)).toEqual(["omp:again"]);
  } finally {
    db.close();
  }
});

test("opening a v4 index upgrades it to v5 without losing rows", () => {
  const { db: legacy, path } = freshDb();
  writeSession(legacy, fixture("legacy"));
  // A real v4 index has no marker table at all.
  legacy.run("DROP TABLE forgotten_session");
  legacy.run("PRAGMA user_version = 4");
  legacy.close();

  const reopened = openDb(path);
  try {
    expect(SCHEMA_VERSION).toBe(5);
    const row = reopened.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(5);
    expect(detail(reopened, "omp:legacy")).not.toBeNull();
    expect(forgottenIds(reopened).size).toBe(0);
    // The migration created the marker table, so forgetting works right away.
    expect(forgetSession(reopened, "omp", "legacy").removed).toBe(true);
    expect(detail(reopened, "omp:legacy")).toBeNull();
  } finally {
    reopened.close();
  }
});

test("splitSessionId parses <agent>:<external-id> and rejects the rest", () => {
  expect(splitSessionId("omp:2026-11-10T01-13-16-427Z_01a1c304")).toEqual({
    agent: "omp",
    externalId: "2026-11-10T01-13-16-427Z_01a1c304",
  });
  expect(splitSessionId("cindy:a:b")).toEqual({ agent: "cindy", externalId: "a:b" });
  expect(splitSessionId("nope:abc")).toBeNull();
  expect(splitSessionId("omp")).toBeNull();
  expect(splitSessionId(":abc")).toBeNull();
  expect(splitSessionId("omp:")).toBeNull();
});

