import type { Database } from "bun:sqlite";
import type { AgentId } from "./adapters/types.ts";
import { getMeta, indexStats } from "./db.ts";
import { escapeLike } from "./util/values.ts";

export type SearchRole = "all" | "user" | "assistant";

export interface SearchParams {
  q: string;
  agents: AgentId[];
  project: string;
  from: number | null;
  to: number | null;
  role: SearchRole;
  limit: number;
  offset: number;
}

export interface SearchHit {
  turnId: number;
  idx: number;
  ts: number;
  matchField: "user" | "assistant";
  snippet: string;
  userText: string;
  assistantSnippet: string;
}

export interface SearchSession {
  id: string;
  agent: AgentId;
  title: string;
  projectPath: string;
  updatedAt: number;
  hits: SearchHit[];
  hitCount: number;
}

export interface SearchResult {
  q: string;
  terms: string[];
  mode: "fts" | "like" | "recent";
  tookMs: number;
  totalTurns: number;
  totalSessions: number;
  sessions: SearchSession[];
}

interface TurnRow {
  turnId: number;
  session_id: string;
  idx: number;
  ts: number;
  user_text: string;
  assistant_text: string;
  agent: AgentId;
  title: string;
  project_path: string;
  updated_at: number;
  session_hits: number;
}

export function parseTerms(q: string): string[] {
  const terms: string[] = [];
  const matcher = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(q)) !== null) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (term) terms.push(term);
  }
  return terms;
}

function runeLength(value: string): number {
  return [...value].length;
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function ftsTerm(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function likePattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

interface Clause {
  sql: string;
  params: (string | number)[];
}

function baseClause(params: SearchParams): Clause {
  const clauses = ["1 = 1"];
  const values: (string | number)[] = [];
  if (params.agents.length > 0) {
    clauses.push(`s.agent IN (${params.agents.map(() => "?").join(", ")})`);
    values.push(...params.agents);
  }
  if (params.project) {
    clauses.push("s.project_path = ?");
    values.push(params.project);
  }
  if (params.from !== null) {
    clauses.push("COALESCE(NULLIF(t.ts, 0), s.updated_at) >= ?");
    values.push(params.from);
  }
  if (params.to !== null) {
    clauses.push("COALESCE(NULLIF(t.ts, 0), s.updated_at) <= ?");
    values.push(params.to);
  }
  return { sql: clauses.join(" AND "), params: values };
}

function likeClause(term: string, role: SearchRole): Clause {
  const pattern = likePattern(term);
  if (role === "user") {
    return { sql: "t.user_text LIKE ? ESCAPE '\\'", params: [pattern] };
  }
  if (role === "assistant") {
    return { sql: "t.assistant_text LIKE ? ESCAPE '\\'", params: [pattern] };
  }
  return {
    sql: "(t.user_text LIKE ? ESCAPE '\\' OR t.assistant_text LIKE ? ESCAPE '\\')",
    params: [pattern, pattern],
  };
}

function ftsMatch(terms: string[], role: SearchRole): string {
  const core =
    terms.length === 1
      ? ftsTerm(terms[0])
      : `(${terms.map(ftsTerm).join(" AND ")})`;
  if (role === "user") return `user_text : ${core}`;
  if (role === "assistant") return `assistant_text : ${core}`;
  return core;
}

function rowQuery(ftsTable: string | null): string {
  const source = ftsTable
    ? `${ftsTable} JOIN turn t ON t.id = ${ftsTable}.rowid`
    : `turn t`;
  const rank = ftsTable ? `bm25(${ftsTable}) AS rank` : `0 AS rank`;
  return `SELECT t.id AS turnId, t.session_id, t.idx, t.ts, t.user_text, t.assistant_text,
                 s.agent, s.title, s.project_path, s.updated_at,
                 0 AS session_hits, ${rank}
          FROM ${source}
          JOIN session s ON s.id = t.session_id`;
}

function windowSnippet(text: string, term: string): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ");
  const index = flat.toLowerCase().indexOf(term.toLowerCase());
  if (index < 0) return flat.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(flat.length, index + term.length + 160);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function pickHit(row: TurnRow, terms: string[], role: SearchRole): SearchHit {
  let field: "user" | "assistant" =
    role === "user" ? "user" : role === "assistant" ? "assistant" : "user";
  let best = Number.POSITIVE_INFINITY;
  if (role === "all") {
    for (const term of terms) {
      const userIndex = row.user_text.toLowerCase().indexOf(term.toLowerCase());
      if (userIndex >= 0 && userIndex < best) {
        best = userIndex;
        field = "user";
      }
      const assistantIndex = row.assistant_text.toLowerCase().indexOf(term.toLowerCase());
      if (assistantIndex >= 0 && assistantIndex < best) {
        best = assistantIndex;
        field = "assistant";
      }
    }
    if (best === Number.POSITIVE_INFINITY && !row.user_text && row.assistant_text) {
      field = "assistant";
    }
  }
  const text = field === "user" ? row.user_text : row.assistant_text;
  const snippet = terms.length > 0 ? windowSnippet(text, terms[0]) : text.slice(0, 240);
  return {
    turnId: row.turnId,
    idx: row.idx,
    ts: row.ts,
    matchField: field,
    snippet,
    userText: row.user_text.slice(0, 800),
    assistantSnippet:
      field === "user" && row.assistant_text
        ? row.assistant_text.replace(/\s+/g, " ").slice(0, 260)
        : "",
  };
}

function groupRows(rows: TurnRow[], terms: string[], params: SearchParams): SearchSession[] {
  const sessions: SearchSession[] = [];
  const byId = new Map<string, SearchSession>();
  for (const row of rows) {
    let session = byId.get(row.session_id);
    if (!session) {
      session = {
        id: row.session_id,
        agent: row.agent,
        title: row.title,
        projectPath: row.project_path,
        updatedAt: row.updated_at,
        hits: [],
        hitCount: row.session_hits,
      };
      byId.set(row.session_id, session);
      sessions.push(session);
    }
    if (session.hits.length < 3) {
      session.hits.push(pickHit(row, terms, params.role));
    }
  }
  return sessions;
}

function fillSessionCounts(
  db: Database,
  ftsTable: string | null,
  rows: TurnRow[],
  where: string,
  bound: (string | number)[],
): void {
  if (rows.length === 0) return;
  const ids = [...new Set(rows.map((row) => row.session_id))];
  const source = ftsTable
    ? `${ftsTable} JOIN turn t ON t.id = ${ftsTable}.rowid`
    : `turn t`;
  const placeholders = ids.map(() => "?").join(", ");
  const counts = db
    .query(
      `SELECT t.session_id AS id, count(*) AS n
       FROM ${source} JOIN session s ON s.id = t.session_id
       WHERE ${where} AND t.session_id IN (${placeholders})
       GROUP BY t.session_id`,
    )
    .all(...bound, ...ids) as { id: string; n: number }[];
  const byId = new Map(counts.map((row) => [row.id, row.n]));
  for (const row of rows) row.session_hits = byId.get(row.session_id) ?? 0;
}

function countQuery(ftsTable: string | null, where: string): string {
  const source = ftsTable
    ? `${ftsTable} JOIN turn t ON t.id = ${ftsTable}.rowid`
    : `turn t`;
  return `SELECT count(*) AS turns, count(DISTINCT t.session_id) AS sessions
          FROM ${source} JOIN session s ON s.id = t.session_id
          WHERE ${where}`;
}

function executeFts(
  db: Database,
  params: SearchParams,
  terms: string[],
  table: "turn_fts" | "turn_fts_en",
  shortTerms: string[],
  limit: number,
): { rows: TurnRow[]; totalTurns: number; totalSessions: number } {
  const base = baseClause(params);
  const clauses = [base.sql, `${table} MATCH ?`];
  const match = ftsMatch(terms, params.role);
  const bound: (string | number)[] = [match, ...base.params];
  for (const term of shortTerms) {
    const clause = likeClause(term, params.role);
    clauses.push(clause.sql);
    bound.push(...clause.params);
  }
  const where = clauses.join(" AND ");
  const count = db.query(countQuery(table, where)).get(...bound) as {
    turns: number;
    sessions: number;
  };
  const rows = db
    .query(
      `${rowQuery(table)}
       WHERE ${where}
       ORDER BY rank ASC, COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC
       LIMIT ?`,
    )
    .all(...bound, limit) as TurnRow[];
  fillSessionCounts(db, table, rows, where, bound);
  return { rows, totalTurns: count.turns, totalSessions: count.sessions };
}

function executeRecent(
  db: Database,
  params: SearchParams,
  limit: number,
): { rows: TurnRow[]; totalTurns: number; totalSessions: number } {
  const base = baseClause(params);
  const column = params.role === "assistant" ? "assistant_text" : "user_text";
  const where = `${base.sql} AND t.${column} <> '' AND t.id = (
    SELECT t2.id FROM turn t2 JOIN session s2 ON s2.id = t2.session_id
    WHERE t2.session_id = t.session_id AND t2.${column} <> ''
    ORDER BY COALESCE(NULLIF(t2.ts, 0), s2.updated_at) DESC, t2.idx DESC
    LIMIT 1
  )`;
  const count = db
    .query(
      `SELECT count(*) AS turns, count(DISTINCT t.session_id) AS sessions
       FROM turn t JOIN session s ON s.id = t.session_id
       WHERE ${base.sql} AND t.${column} <> ''`,
    )
    .get(...base.params) as { turns: number; sessions: number };
  const rows = db
    .query(
      `${rowQuery(null)}
       WHERE ${where}
       ORDER BY COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC
       LIMIT ?`,
    )
    .all(...base.params, limit) as TurnRow[];
  for (const row of rows) row.session_hits = 1;
  return { rows, totalTurns: count.turns, totalSessions: count.sessions };
}

function executeLike(
  db: Database,
  params: SearchParams,
  terms: string[],
  limit: number,
): { rows: TurnRow[]; totalTurns: number; totalSessions: number } {
  const base = baseClause(params);
  const clauses = [base.sql];
  const values: (string | number)[] = [...base.params];
  for (const term of terms) {
    const clause = likeClause(term, params.role);
    clauses.push(clause.sql);
    values.push(...clause.params);
  }
  if (terms.length === 0) {
    if (params.role === "assistant") clauses.push("t.assistant_text <> ''");
    else clauses.push("t.user_text <> ''");
  }
  if (params.role === "user") clauses.push("t.user_text <> ''");
  if (params.role === "assistant") clauses.push("t.assistant_text <> ''");
  const where = clauses.join(" AND ");
  const count = db.query(countQuery(null, where)).get(...values) as {
    turns: number;
    sessions: number;
  };
  const rows = db
    .query(
      `${rowQuery(null)}
       WHERE ${where}
       ORDER BY COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC
       LIMIT ?`,
    )
    .all(...values, limit) as TurnRow[];
  fillSessionCounts(db, null, rows, where, values);
  return { rows, totalTurns: count.turns, totalSessions: count.sessions };
}

export function searchTurns(db: Database, params: SearchParams): SearchResult {
  const startedAt = performance.now();
  const terms = parseTerms(params.q);
  const requestedLimit = Number.isFinite(params.limit) ? params.limit : 120;
  const requestedOffset = Number.isFinite(params.offset) ? params.offset : 0;
  const limit = Math.max(1, Math.min(500, requestedLimit));
  const offset = Math.max(0, requestedOffset);

  let mode: "fts" | "like" | "recent" = "recent";
  let outcome: { rows: TurnRow[]; totalTurns: number; totalSessions: number };

  if (terms.length === 0) {
    mode = "recent";
    outcome = executeRecent(db, params, limit + offset);
  } else {
    const longTerms = terms.filter((term) => runeLength(term) >= 3);
    const shortTerms = terms.filter((term) => runeLength(term) < 3);
    const asciiOnly = terms.every((term) => !hasCjk(term));

    if (longTerms.length > 0) {
      mode = "fts";
      outcome = executeFts(db, params, longTerms, "turn_fts", shortTerms, limit + offset);
      if (outcome.rows.length === 0 && asciiOnly) {
        outcome = executeFts(db, params, longTerms, "turn_fts_en", shortTerms, limit + offset);
      }
    } else {
      mode = "like";
      outcome = executeLike(db, params, terms, limit + offset);
    }

    if (outcome.rows.length === 0 && mode !== "like") {
      mode = "like";
      outcome = executeLike(db, params, terms, limit + offset);
    }
  }

  const sliced =
    offset > 0 ? outcome.rows.slice(offset, offset + limit) : outcome.rows.slice(0, limit);
  const sessions = groupRows(sliced, terms, params).slice(0, limit);

  return {
    q: params.q,
    terms,
    mode,
    tookMs: Math.round((performance.now() - startedAt) * 10) / 10,
    totalTurns: outcome.totalTurns,
    totalSessions: outcome.totalSessions,
    sessions,
  };
}

export function getSessionDetail(db: Database, id: string): unknown {
  const session = db.query("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return null;
  const turns = db
    .query(
      `SELECT idx, ts, user_text, assistant_text, model, truncated
       FROM turn WHERE session_id = ? ORDER BY idx`,
    )
    .all(id);
  return { session, turns };
}

export interface FacetResult {
  agents: { id: AgentId; sessions: number }[];
  projects: { path: string; sessions: number }[];
  total: { sessions: number; turns: number; chars: number };
  lastScanMs: number;
  lastScanTookMs: number;
  errors: { source: string; message: string; at: number }[];
}

export function facets(db: Database): FacetResult {
  const agents = db
    .query("SELECT agent AS id, count(*) AS sessions FROM session GROUP BY agent ORDER BY sessions DESC")
    .all() as { id: AgentId; sessions: number }[];
  const projects = db
    .query(
      `SELECT project_path AS path, count(*) AS sessions
       FROM session WHERE project_path <> ''
       GROUP BY project_path ORDER BY sessions DESC, path ASC LIMIT 300`,
    )
    .all() as { path: string; sessions: number }[];
  const errors = db
    .query("SELECT source, message, at FROM scan_error ORDER BY at DESC LIMIT 20")
    .all() as { source: string; message: string; at: number }[];
  return {
    agents,
    projects,
    total: indexStats(db),
    lastScanMs: Number(getMeta(db, "last_scan_ms") ?? 0),
    lastScanTookMs: Number(getMeta(db, "last_scan_took_ms") ?? 0),
    errors,
  };
}
