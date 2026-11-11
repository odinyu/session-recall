import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentId, ParsedEvent, ParsedSession } from "./adapters/types.ts";
import { capEventText, EVENT_CAPS, limitEvents } from "./util/events.ts";

const ERROR_LINE =
  /error|exception|failed|fatal|denied|rejected|失败|错误|异常|拒绝/i;

function errorSearchText(event: ParsedEvent): string {
  const output = event.output ?? "";
  if (/error|denied|fail|reject/i.test(event.meta ?? "")) {
    return capEventText(output, EVENT_CAPS.output).text;
  }
  const lines = output
    .split(/\r?\n/)
    .filter((line) => ERROR_LINE.test(line))
    .slice(0, 40);
  return capEventText(lines.join("\n"), EVENT_CAPS.output).text;
}

export type IndexedDatabase = Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  external_id TEXT NOT NULL,
  parent_id TEXT,
  project_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL DEFAULT '',
  UNIQUE (agent, external_id)
);

CREATE INDEX IF NOT EXISTS session_agent ON session(agent);
CREATE INDEX IF NOT EXISTS session_updated ON session(updated_at DESC);
CREATE INDEX IF NOT EXISTS session_project ON session(project_path);

CREATE TABLE IF NOT EXISTS turn (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  ts INTEGER NOT NULL DEFAULT 0,
  user_text TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  model TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, idx)
);

CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, idx);
CREATE INDEX IF NOT EXISTS turn_ts ON turn(ts DESC);

CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  turn_idx INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  input TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  meta TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, turn_idx, seq)
);

CREATE INDEX IF NOT EXISTS event_turn ON event(session_id, turn_idx, seq);

CREATE TABLE IF NOT EXISTS event_search (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  turn_idx INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  UNIQUE (session_id, turn_idx, seq)
);

CREATE INDEX IF NOT EXISTS event_search_session ON event_search(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  name,
  input,
  error_text,
  content='event_search',
  content_rowid='id',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts_en USING fts5(
  name,
  input,
  error_text,
  content='event_search',
  content_rowid='id',
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS event_search_ai AFTER INSERT ON event_search BEGIN
  INSERT INTO event_fts(rowid, name, input, error_text)
    VALUES (new.id, new.name, new.input, new.error_text);
  INSERT INTO event_fts_en(rowid, name, input, error_text)
    VALUES (new.id, new.name, new.input, new.error_text);
END;

CREATE TRIGGER IF NOT EXISTS event_search_ad AFTER DELETE ON event_search BEGIN
  INSERT INTO event_fts(event_fts, rowid, name, input, error_text)
    VALUES ('delete', old.id, old.name, old.input, old.error_text);
  INSERT INTO event_fts_en(event_fts_en, rowid, name, input, error_text)
    VALUES ('delete', old.id, old.name, old.input, old.error_text);
END;

CREATE TRIGGER IF NOT EXISTS event_search_au AFTER UPDATE ON event_search BEGIN
  INSERT INTO event_fts(event_fts, rowid, name, input, error_text)
    VALUES ('delete', old.id, old.name, old.input, old.error_text);
  INSERT INTO event_fts_en(event_fts_en, rowid, name, input, error_text)
    VALUES ('delete', old.id, old.name, old.input, old.error_text);
  INSERT INTO event_fts(rowid, name, input, error_text)
    VALUES (new.id, new.name, new.input, new.error_text);
  INSERT INTO event_fts_en(rowid, name, input, error_text)
    VALUES (new.id, new.name, new.input, new.error_text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
  user_text,
  assistant_text,
  content='turn',
  content_rowid='id',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts_en USING fts5(
  user_text,
  assistant_text,
  content='turn',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS turn_ai AFTER INSERT ON turn BEGIN
  INSERT INTO turn_fts(rowid, user_text, assistant_text)
    VALUES (new.id, new.user_text, new.assistant_text);
  INSERT INTO turn_fts_en(rowid, user_text, assistant_text)
    VALUES (new.id, new.user_text, new.assistant_text);
END;

CREATE TRIGGER IF NOT EXISTS turn_ad AFTER DELETE ON turn BEGIN
  INSERT INTO turn_fts(turn_fts, rowid, user_text, assistant_text)
    VALUES ('delete', old.id, old.user_text, old.assistant_text);
  INSERT INTO turn_fts_en(turn_fts_en, rowid, user_text, assistant_text)
    VALUES ('delete', old.id, old.user_text, old.assistant_text);
END;

CREATE TRIGGER IF NOT EXISTS turn_au AFTER UPDATE ON turn BEGIN
  INSERT INTO turn_fts(turn_fts, rowid, user_text, assistant_text)
    VALUES ('delete', old.id, old.user_text, old.assistant_text);
  INSERT INTO turn_fts_en(turn_fts_en, rowid, user_text, assistant_text)
    VALUES ('delete', old.id, old.user_text, old.assistant_text);
  INSERT INTO turn_fts(rowid, user_text, assistant_text)
    VALUES (new.id, new.user_text, new.assistant_text);
  INSERT INTO turn_fts_en(rowid, user_text, assistant_text)
    VALUES (new.id, new.user_text, new.assistant_text);
END;

CREATE TABLE IF NOT EXISTS scan_error (
  source TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

const SCHEMA_VERSION = 4;

function numberField(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const record = value as Record<string, unknown>;
  const field = record[key];
  return typeof field === "number" ? field : null;
}

/** Keep the index and its WAL sidecars private to the owner. */
export function secureIndexFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(`${path}${suffix}`, 0o600);
    } catch {
      // A missing sidecar or an exotic filesystem is not an error here.
    }
  }
}

export function openDb(path: string): IndexedDatabase {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // ignore filesystems that do not support POSIX modes
  }
  const db = new Database(path, { create: true });
  secureIndexFiles(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  secureIndexFiles(path);

  const versionRow = db.query("PRAGMA user_version").get();
  const version = numberField(versionRow, "user_version") ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`index schema ${version} is newer than this build (${SCHEMA_VERSION})`);
  }
  if (version < SCHEMA_VERSION) {
    db.run(SCHEMA);
    if (version < 3) {
      // Existing installs already have the event table; populate the narrower
      // search projection instead of forcing a full source rescan.
      db.run(
        `INSERT OR REPLACE INTO event_search
           (session_id, turn_idx, seq, name, input, error_text, status)
         SELECT session_id, turn_idx, seq,
                COALESCE(name, ''), input,
                CASE
                  WHEN instr(lower(COALESCE(meta, '')), 'error') > 0
                    OR instr(lower(COALESCE(meta, '')), 'denied') > 0
                    OR instr(lower(COALESCE(meta, '')), 'fail') > 0
                    OR instr(lower(COALESCE(meta, '')), 'reject') > 0
                  THEN output
                  ELSE ''
                END,
                COALESCE(meta, '')
         FROM event WHERE kind = 'tool'`,
      );
    }
    if (version < 4) {
      // v3 only copied output for tools whose status looked like an error.
      // Successful tools can still print an error line; backfill those so a
      // process search for the message finds the call.
      db.run(
        `UPDATE event_search
         SET error_text = (
           SELECT e.output FROM event e
           WHERE e.session_id = event_search.session_id
             AND e.turn_idx = event_search.turn_idx
             AND e.seq = event_search.seq
         )
         WHERE error_text = ''
           AND EXISTS (
             SELECT 1 FROM event e
             WHERE e.session_id = event_search.session_id
               AND e.turn_idx = event_search.turn_idx
               AND e.seq = event_search.seq
               AND (
                 instr(lower(e.output), 'error') > 0
                 OR instr(lower(e.output), 'exception') > 0
                 OR instr(lower(e.output), 'failed') > 0
                 OR instr(lower(e.output), 'fatal') > 0
                 OR instr(lower(e.output), 'denied') > 0
                 OR instr(lower(e.output), 'rejected') > 0
                 OR instr(e.output, '失败') > 0
                 OR instr(e.output, '错误') > 0
                 OR instr(e.output, '异常') > 0
                 OR instr(e.output, '拒绝') > 0
               )
           )`,
      );
    }
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

export interface StoredFingerprint {
  id: string;
  fingerprint: string;
}

export function fingerprintsFor(db: IndexedDatabase, agent: AgentId): Map<string, string> {
  const rows = db
    .query("SELECT id, source_fingerprint AS fingerprint FROM session WHERE agent = ?")
    .all(agent) as StoredFingerprint[];
  return new Map(rows.map((row) => [row.id, row.fingerprint]));
}

export function existingIds(db: IndexedDatabase, agent: AgentId): Set<string> {
  const rows = db.query("SELECT id FROM session WHERE agent = ?").all(agent) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function writeSession(db: IndexedDatabase, session: ParsedSession): void {
  const id = `${session.agent}:${session.externalId}`;
  const insertTurn = db.query(
    "INSERT INTO turn(session_id, idx, ts, user_text, assistant_text, model, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.query(
    "INSERT INTO event(session_id, turn_idx, seq, kind, name, input, output, meta, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEventSearch = db.query(
    "INSERT INTO event_search(session_id, turn_idx, seq, name, input, error_text, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const events = limitEvents(session.events ?? []);

  const write = db.transaction(() => {
    db.run(
      `INSERT INTO session(
         id, agent, external_id, parent_id, project_path, title,
         started_at, updated_at, turn_count, source_kind, source_path, source_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parent_id = excluded.parent_id,
         project_path = excluded.project_path,
         title = excluded.title,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         turn_count = excluded.turn_count,
         source_kind = excluded.source_kind,
         source_path = excluded.source_path,
         source_fingerprint = excluded.source_fingerprint`,
      [
        id,
        session.agent,
        session.externalId,
        session.parentId ?? null,
        session.projectPath,
        session.title,
        session.startedAt,
        session.updatedAt,
        session.turns.length,
        session.sourceKind,
        session.sourcePath,
        session.fingerprint,
      ],
    );

    db.run("DELETE FROM event_search WHERE session_id = ?", [id]);
    db.run("DELETE FROM event WHERE session_id = ?", [id]);
    db.run("DELETE FROM turn WHERE session_id = ?", [id]);
    for (const turn of session.turns) {
      insertTurn.run(
        id,
        turn.idx,
        turn.ts,
        turn.userText,
        turn.assistantText,
        turn.model ?? null,
        turn.truncated ? 1 : 0,
      );
    }

    for (const event of events) {
      let input = "";
      let output = "";
      let truncated = false;
      if (event.kind === "reasoning") {
        const capped = capEventText(event.output ?? event.input ?? "", EVENT_CAPS.reasoning);
        output = capped.text;
        truncated = capped.truncated || event.truncated === true;
      } else {
        const cappedInput = capEventText(event.input ?? "", EVENT_CAPS.input);
        const cappedOutput = capEventText(event.output ?? "", EVENT_CAPS.output);
        input = cappedInput.text;
        output = cappedOutput.text;
        truncated =
          cappedInput.truncated ||
          cappedOutput.truncated ||
          event.truncated === true;
      }
      insertEvent.run(
        id,
        event.turnIdx,
        event.seq,
        event.kind,
        (event.name ?? "").slice(0, 120),
        input,
        output,
        (event.meta ?? "").slice(0, 300),
        truncated ? 1 : 0,
      );
      if (event.kind === "tool") {
        insertEventSearch.run(
          id,
          event.turnIdx,
          event.seq,
          (event.name ?? "").slice(0, 120),
          input,
          errorSearchText(event),
          (event.meta ?? "").slice(0, 300),
        );
      }
    }
  });

  write();
}

export function deleteSession(db: IndexedDatabase, agent: AgentId, externalId: string): void {
  const id = `${agent}:${externalId}`;
  const remove = db.transaction(() => {
    db.run("DELETE FROM event_search WHERE session_id = ?", [id]);
    db.run("DELETE FROM event WHERE session_id = ?", [id]);
    db.run("DELETE FROM turn WHERE session_id = ?", [id]);
    db.run("DELETE FROM session WHERE id = ?", [id]);
  });
  remove();
}

export function recordScanError(db: IndexedDatabase, source: string, message: string): void {
  db.run(
    `INSERT INTO scan_error(source, message, at) VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET message = excluded.message, at = excluded.at`,
    [source, message, Date.now()],
  );
}

export function clearScanError(db: IndexedDatabase, source: string): void {
  db.run("DELETE FROM scan_error WHERE source = ?", [source]);
}

export function setMeta(db: IndexedDatabase, key: string, value: string): void {
  db.run(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export function getMeta(db: IndexedDatabase, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export interface IndexStats {
  sessions: number;
  turns: number;
  chars: number;
}

export function indexStats(db: IndexedDatabase): IndexStats {
  const row = db
    .query(
      `SELECT
         (SELECT count(*) FROM session) AS sessions,
         (SELECT count(*) FROM turn) AS turns,
         (SELECT COALESCE(sum(length(user_text) + length(assistant_text)), 0) FROM turn) AS chars`,
    )
    .get() as IndexStats;
  return row;
}

export interface StoredEvent {
  seq: number;
  kind: string;
  name: string | null;
  input: string;
  output: string;
  meta: string | null;
  truncated: number;
}

export function eventCountsFor(
  db: IndexedDatabase,
  sessionId: string,
): Map<number, number> {
  const rows = db
    .query(
      "SELECT turn_idx AS turnIdx, count(*) AS n FROM event WHERE session_id = ? GROUP BY turn_idx",
    )
    .all(sessionId) as { turnIdx: number; n: number }[];
  return new Map(rows.map((row) => [row.turnIdx, row.n]));
}

export function eventsForTurn(
  db: IndexedDatabase,
  sessionId: string,
  turnIdx: number,
): StoredEvent[] {
  return db
    .query(
      `SELECT seq, kind, name, input, output, meta, truncated
       FROM event WHERE session_id = ? AND turn_idx = ?
       ORDER BY seq`,
    )
    .all(sessionId, turnIdx) as StoredEvent[];
}

export const MAX_TURN_CHARS = 200_000;

export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TURN_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TURN_CHARS), truncated: true };
}
