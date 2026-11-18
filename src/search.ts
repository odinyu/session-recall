import type { Database } from "bun:sqlite";
import type { AgentId } from "./adapters/types.ts";
import { getMeta, indexStats } from "./db.ts";
import { compactCjkWhitespace } from "./util/cjk.ts";
import { escapeLike } from "./util/values.ts";

export type SearchRole = "all" | "user" | "assistant";
export type SearchScope = "qa" | "process";

export interface SearchParams {
  q: string;
  agents: AgentId[];
  project: string;
  from: number | null;
  to: number | null;
  role: SearchRole;
  scope: SearchScope;
  limit: number;
  offset: number;
  /** Only sessions the user starred. */
  starred?: boolean;
  /** Include sessions the user hid; hidden ones are excluded by default. */
  includeHidden?: boolean;
  /** Only hidden sessions; overrides the two flags above. */
  hiddenOnly?: boolean;
}

export interface SearchHit {
  turnId: number;
  idx: number;
  ts: number;
  matchField: "user" | "assistant" | "title";
  snippet: string;
  userText: string;
  assistantSnippet: string;
}

export interface ProcessHit {
  turnIdx: number;
  seq: number;
  ts: number;
  tool: string;
  status: string;
  matchField: "tool" | "input" | "error";
  snippet: string;
}

export interface SearchSession {
  id: string;
  agent: AgentId;
  title: string;
  projectPath: string;
  updatedAt: number;
  starred: boolean;
  hidden: boolean;
  hits: SearchHit[];
  hitCount: number;
  processHits: ProcessHit[];
  processHitCount: number;
}

export interface SearchResult {
  q: string;
  terms: string[];
  scope: SearchScope;
  mode: "fts" | "like" | "recent" | "process";
  tookMs: number;
  totalTurns: number;
  totalSessions: number;
  processTotal: number;
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
  starred: number;
  hidden: number;
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

const SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * Chunk one term the way a reader of Chinese would. ICU knows the words
 * (数据 / 库 / 打不开); the trigram index needs at least 3 runes, so short
 * pieces are carried into the next chunk and a short tail folds back into the
 * previous one. "数据库打不开" becomes 数据库 + 打不开, which is what the query
 * meant, instead of one 6-rune phrase the text never contains verbatim.
 * Latin terms come back untouched.
 */
function cjkChunks(term: string): string[] {
  if (!hasCjk(term)) return [term];
  const parts = [...SEGMENTER.segment(term)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
  if (parts.length <= 1) return [term];
  const chunks: string[] = [];
  let pending = "";
  for (const part of parts) {
    pending += part;
    if (runeLength(pending) >= 3) {
      chunks.push(pending);
      pending = "";
    }
  }
  if (pending) {
    if (chunks.length > 0) chunks[chunks.length - 1] += pending;
    else chunks.push(pending);
  }
  return chunks;
}

/**
 * The word-split retry for a query the phrase search found nothing for, or
 * null when splitting would change nothing. A term of 2 runes or fewer stays
 * out: the trigram index cannot use it, and {@link likeClause} handles it.
 */
function cjkRelaxedTerms(terms: string[]): string[] | null {
  if (!terms.some((term) => hasCjk(term) && runeLength(term) > 3)) return null;
  const relaxed = terms.flatMap(cjkChunks);
  // A 4-rune word like 登录不上 keeps one chunk that equals itself: retrying
  // would re-run the same query.
  if (relaxed.length === terms.length && relaxed.every((term, i) => term === terms[i])) {
    return null;
  }
  return relaxed.some((term) => runeLength(term) >= 3) ? relaxed : null;
}

function likePattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

interface Clause {
  sql: string;
  params: (string | number)[];
}

/**
 * The per-session filters (hidden / starred / agent / project), shared by the
 * turn executors and the title pass so the rule cannot drift between them.
 */
function sessionScopeClauses(params: SearchParams): Clause {
  // Hidden sessions are user data that stays indexed but never surfaces in a
  // default result; every executor (qa/process, fts/like/recent) shares this
  // clause, so the rule cannot drift between modes. `hiddenOnly` is the rail's
  // hidden view: the API/CLI/MCP layers reject it combined with the other two
  // flags, and here it wins by construction.
  const clauses = [
    params.hiddenOnly
      ? "s.hidden = 1"
      : params.includeHidden
        ? "1 = 1"
        : "s.hidden = 0",
  ];
  const values: (string | number)[] = [];
  if (params.starred && !params.hiddenOnly) {
    clauses.push("s.starred = 1");
  }
  if (params.agents.length > 0) {
    clauses.push(`s.agent IN (${params.agents.map(() => "?").join(", ")})`);
    values.push(...params.agents);
  }
  if (params.project) {
    clauses.push("s.project_path = ?");
    values.push(params.project);
  }
  return { sql: clauses.join(" AND "), params: values };
}

function baseClause(params: SearchParams): Clause {
  const scope = sessionScopeClauses(params);
  const clauses = [scope.sql];
  const values = [...scope.params];
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
  const fields =
    role === "user"
      ? ["t.user_text"]
      : role === "assistant"
        ? ["t.assistant_text"]
        : ["t.user_text", "t.assistant_text"];
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const field of fields) {
    clauses.push(`${field} LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  // A wrapped transcript stores 「使用不 同的模型协同」 with a space inside the
  // phrase. Compare whitespace-free columns against the compacted query so the
  // correct spelling finds it without weakening English word boundaries.
  const compact = compactCjkWhitespace(term);
  if (hasCjk(compact)) {
    const compactPattern = likePattern(compact);
    for (const field of fields) {
      clauses.push(`${strippedColumn(field)} LIKE ? ESCAPE '\\'`);
      params.push(compactPattern);
    }
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/** `field` with every whitespace character removed, for {@link likeClause}. */
function strippedColumn(field: string): string {
  return [" ", "\t", "\n", "\r", "\u3000"].reduce(
    (sql, ch) => `replace(${sql}, char(${ch.codePointAt(0)}), '')`,
    field,
  );
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
                 s.starred, s.hidden,
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
        starred: row.starred === 1,
        hidden: row.hidden === 1,
        hits: [],
        hitCount: row.session_hits,
        processHits: [],
        processHitCount: 0,
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
  // Placeholder order must follow `clauses`: filters, then MATCH, then short terms.
  const bound: (string | number)[] = [...base.params, match];
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
       ORDER BY s.updated_at DESC,
                COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC,
                rank ASC
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
       ORDER BY s.updated_at DESC,
                COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC
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
       ORDER BY s.updated_at DESC,
                COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC
       LIMIT ?`,
    )
    .all(...values, limit) as TurnRow[];
  fillSessionCounts(db, null, rows, where, values);
  return { rows, totalTurns: count.turns, totalSessions: count.sessions };
}

/**
 * A session matched by its title only (no turn matched). Carries the latest
 * turn so the result can render one hit row and a deep link, like any other.
 */
interface TitleSession {
  session_id: string;
  agent: AgentId;
  title: string;
  project_path: string;
  updated_at: number;
  starred: number;
  hidden: number;
  idx: number;
  ts: number;
  user_text: string;
}

/**
 * Title matches as a first-class result pass (QA scope only).
 *
 * A LIKE-based pass over `session.title` — deliberately not FTS: the title
 * column is not in the FTS tables, and a LIKE pass needs no schema version bump
 * and no re-index. Every query term must appear in the title (the same AND
 * semantics as the content passes), so a short or CJK term works exactly
 * like it does through the LIKE fallback. Filters are the shared session scope
 * (hidden / starred / agent / project) plus the same time window, expressed
 * over the session's turns. `role` is intentionally ignored: a title is
 * session-level metadata, not turn text, and narrowing it by role would make
 * title search useless under either role filter.
 *
 * Sessions are ordered by `updated_at` and capped at `limit`, so the caller
 * can merge them after the content rows and respect the pagination budget.
 */
function executeTitlePass(
  db: Database,
  params: SearchParams,
  terms: string[],
  limit: number,
): TitleSession[] {
  const scope = sessionScopeClauses(params);
  const clauses = [scope.sql];
  const values = [...scope.params];
  for (const term of terms) {
    clauses.push("s.title LIKE ? ESCAPE '\\'");
    values.push(likePattern(term));
  }
  if (params.from !== null) {
    clauses.push(
      "EXISTS (SELECT 1 FROM turn tt WHERE tt.session_id = s.id AND COALESCE(NULLIF(tt.ts, 0), s.updated_at) >= ?)",
    );
    values.push(params.from);
  }
  if (params.to !== null) {
    clauses.push(
      "EXISTS (SELECT 1 FROM turn tt WHERE tt.session_id = s.id AND COALESCE(NULLIF(tt.ts, 0), s.updated_at) <= ?)",
    );
    values.push(params.to);
  }
  const where = clauses.join(" AND ");
  // The latest turn per session comes from a window function instead of
  // scalar subqueries: SQLite does not resolve the outer row's columns inside
  // a correlated subquery's ORDER BY, and JOINs resolve them cleanly.
  const titleRows = db
    .query(
      `SELECT s.id AS session_id, s.agent, s.title, s.project_path,
              s.updated_at, s.starred, s.hidden
       FROM session s
       WHERE ${where}
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(...values, limit) as {
      session_id: string;
      agent: AgentId;
      title: string;
      project_path: string;
      updated_at: number;
      starred: number;
      hidden: number;
    }[];
  const ids = titleRows.map((row) => row.session_id);
  const placeholders = ids.map(() => "?").join(", ");
  const latest = new Map<string, { idx: number; ts: number; user_text: string }>();
  if (placeholders) {
    const rows = db
      .query(
        `WITH ranked AS (
           SELECT tt.session_id AS session_id, tt.idx AS idx, tt.ts AS ts,
                  tt.user_text AS user_text,
                  ROW_NUMBER() OVER (
                    PARTITION BY tt.session_id
                    ORDER BY COALESCE(NULLIF(tt.ts, 0), ss.updated_at) DESC, tt.idx DESC
                  ) AS n
           FROM turn tt
           JOIN session ss ON ss.id = tt.session_id
           WHERE tt.session_id IN (${placeholders})
         )
         SELECT session_id, idx, ts, user_text FROM ranked WHERE n = 1`,
      )
      .all(...ids) as { session_id: string; idx: number; ts: number; user_text: string }[];
    for (const row of rows) latest.set(row.session_id, row);
  }
  return titleRows.map((row) => {
    const turn = latest.get(row.session_id);
    return {
      ...row,
      idx: turn?.idx ?? 0,
      ts: turn?.ts ?? row.updated_at,
      user_text: turn?.user_text ?? "",
    };
  });
}

/** The hit row for a title match: snippet is the title itself. */
function pickTitleHit(session: TitleSession): SearchHit {
  return {
    turnId: -1,
    idx: session.idx,
    ts: session.ts,
    matchField: "title",
    snippet: clipTitle(session.title),
    userText: session.user_text.slice(0, 800),
    assistantSnippet: "",
  };
}

function clipTitle(title: string): string {
  const chars = [...title.replace(/\s+/g, " ").trim()];
  if (chars.length <= 240) return chars.join("");
  return `${chars.slice(0, 240).join("").trimEnd()}…`;
}

/** One SearchSession per title-matched row, one title hit each. */
function groupTitlePass(rows: TitleSession[]): SearchSession[] {
  return rows.map((row) => ({
    id: row.session_id,
    agent: row.agent,
    title: row.title,
    projectPath: row.project_path,
    updatedAt: row.updated_at,
    starred: row.starred === 1,
    hidden: row.hidden === 1,
    hits: [pickTitleHit(row)],
    hitCount: 1,
    processHits: [],
    processHitCount: 0,
  }));
}

interface ProcessRow {
  session_id: string;
  turn_idx: number;
  seq: number;
  name: string;
  input: string;
  error_text: string;
  status: string;
  agent: AgentId;
  title: string;
  project_path: string;
  updated_at: number;
  starred: number;
  hidden: number;
  ts: number;
  rank: number;
  session_hits: number;
}

function processSource(ftsTable: string | null): string {
  return ftsTable
    ? `${ftsTable} JOIN event_search es ON es.id = ${ftsTable}.rowid`
    : "event_search es";
}

function processRowQuery(ftsTable: string | null): string {
  const rank = ftsTable ? `bm25(${ftsTable}) AS rank` : "0 AS rank";
  return `SELECT es.session_id, es.turn_idx, es.seq, es.name, es.input,
                 es.error_text, es.status, s.agent, s.title, s.project_path,
                 s.updated_at, s.starred, s.hidden,
                 COALESCE(NULLIF(t.ts, 0), s.updated_at) AS ts, ${rank},
                 0 AS session_hits
          FROM ${processSource(ftsTable)}
          JOIN session s ON s.id = es.session_id
          LEFT JOIN turn t ON t.session_id = es.session_id AND t.idx = es.turn_idx`;
}

function processCountQuery(ftsTable: string | null, where: string): string {
  return `SELECT count(*) AS hits, count(DISTINCT es.session_id) AS sessions
          FROM ${processSource(ftsTable)}
          JOIN session s ON s.id = es.session_id
          LEFT JOIN turn t ON t.session_id = es.session_id AND t.idx = es.turn_idx
          WHERE ${where}`;
}

function processLikeClause(term: string): Clause {
  const pattern = likePattern(term);
  return {
    sql: "(es.name LIKE ? ESCAPE '\\' OR es.input LIKE ? ESCAPE '\\' OR es.error_text LIKE ? ESCAPE '\\')",
    params: [pattern, pattern, pattern],
  };
}

function processMatch(terms: string[]): string {
  return terms.length === 1
    ? ftsTerm(terms[0])
    : `(${terms.map(ftsTerm).join(" AND ")})`;
}

function fillProcessCounts(
  db: Database,
  ftsTable: string | null,
  rows: ProcessRow[],
  where: string,
  bound: (string | number)[],
): void {
  if (rows.length === 0) return;
  const ids = [...new Set(rows.map((row) => row.session_id))];
  const placeholders = ids.map(() => "?").join(", ");
  const counts = db
    .query(
      `SELECT es.session_id AS id, count(*) AS n
       FROM ${processSource(ftsTable)}
       JOIN session s ON s.id = es.session_id
       LEFT JOIN turn t ON t.session_id = es.session_id AND t.idx = es.turn_idx
       WHERE ${where} AND es.session_id IN (${placeholders})
       GROUP BY es.session_id`,
    )
    .all(...bound, ...ids) as { id: string; n: number }[];
  const byId = new Map(counts.map((row) => [row.id, row.n]));
  for (const row of rows) row.session_hits = byId.get(row.session_id) ?? 0;
}

function pickProcessHit(row: ProcessRow, terms: string[]): ProcessHit {
  const candidates: { field: ProcessHit["matchField"]; text: string }[] = [
    { field: "error", text: row.error_text },
    { field: "input", text: row.input },
    { field: "tool", text: row.name },
  ];
  for (const term of terms) {
    const needle = term.toLowerCase();
    for (const candidate of candidates) {
      if (candidate.text.toLowerCase().includes(needle)) {
        return {
          turnIdx: row.turn_idx,
          seq: row.seq,
          ts: row.ts,
          tool: row.name || "tool",
          status: row.status,
          matchField: candidate.field,
          snippet: windowSnippet(candidate.text, term),
        };
      }
    }
  }
  const fallback = candidates.find((candidate) => candidate.text) ?? candidates[2];
  return {
    turnIdx: row.turn_idx,
    seq: row.seq,
    ts: row.ts,
    tool: row.name || "tool",
    status: row.status,
    matchField: fallback.field,
    snippet: terms.length > 0
      ? windowSnippet(fallback.text, terms[0])
      : fallback.text.replace(/\s+/g, " ").slice(0, 240),
  };
}

function groupProcessRows(
  rows: ProcessRow[],
  terms: string[],
): SearchSession[] {
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
        starred: row.starred === 1,
        hidden: row.hidden === 1,
        hits: [],
        hitCount: 0,
        processHits: [],
        processHitCount: row.session_hits,
      };
      byId.set(row.session_id, session);
      sessions.push(session);
    }
    if (session.processHits.length < 3) {
      session.processHits.push(pickProcessHit(row, terms));
    }
  }
  return sessions;
}

function executeProcessRecent(
  db: Database,
  params: SearchParams,
  limit: number,
): { rows: ProcessRow[]; totalHits: number; totalSessions: number } {
  const base = baseClause(params);
  const where = base.sql;
  const count = db.query(processCountQuery(null, where)).get(...base.params) as {
    hits: number;
    sessions: number;
  };
  const rows = db
    .query(
      `${processRowQuery(null)}
       WHERE ${where}
       ORDER BY s.updated_at DESC,
                COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC,
                es.seq DESC
       LIMIT ?`,
    )
    .all(...base.params, limit) as ProcessRow[];
  fillProcessCounts(db, null, rows, where, base.params);
  return { rows, totalHits: count.hits, totalSessions: count.sessions };
}

function executeProcessLike(
  db: Database,
  params: SearchParams,
  terms: string[],
  limit: number,
): { rows: ProcessRow[]; totalHits: number; totalSessions: number } {
  const base = baseClause(params);
  const clauses = [base.sql];
  const values: (string | number)[] = [...base.params];
  for (const term of terms) {
    const clause = processLikeClause(term);
    clauses.push(clause.sql);
    values.push(...clause.params);
  }
  const where = clauses.join(" AND ");
  const count = db.query(processCountQuery(null, where)).get(...values) as {
    hits: number;
    sessions: number;
  };
  const rows = db
    .query(
      `${processRowQuery(null)}
       WHERE ${where}
       ORDER BY s.updated_at DESC,
                COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC,
                es.seq DESC
       LIMIT ?`,
    )
    .all(...values, limit) as ProcessRow[];
  fillProcessCounts(db, null, rows, where, values);
  return { rows, totalHits: count.hits, totalSessions: count.sessions };
}

function executeProcessFts(
  db: Database,
  params: SearchParams,
  terms: string[],
  table: "event_fts" | "event_fts_en",
  shortTerms: string[],
  limit: number,
): { rows: ProcessRow[]; totalHits: number; totalSessions: number } {
  const base = baseClause(params);
  const clauses = [base.sql, `${table} MATCH ?`];
  // Placeholder order must follow `clauses`: filters, then MATCH, then short terms.
  const values: (string | number)[] = [...base.params, processMatch(terms)];
  for (const term of shortTerms) {
    const clause = processLikeClause(term);
    clauses.push(clause.sql);
    values.push(...clause.params);
  }
  const where = clauses.join(" AND ");
  const count = db.query(processCountQuery(table, where)).get(...values) as {
    hits: number;
    sessions: number;
  };
  const rows = db
    .query(
      `${processRowQuery(table)}
       WHERE ${where}
       ORDER BY s.updated_at DESC,
                COALESCE(NULLIF(t.ts, 0), s.updated_at) DESC,
                es.seq DESC,
                rank ASC
       LIMIT ?`,
    )
    .all(...values, limit) as ProcessRow[];
  fillProcessCounts(db, table, rows, where, values);
  return { rows, totalHits: count.hits, totalSessions: count.sessions };
}

function searchProcess(
  db: Database,
  params: SearchParams,
  terms: string[],
  limit: number,
  offset: number,
): SearchResult {
  const startedAt = performance.now();
  let mode: "fts" | "like" | "recent" | "process" = "recent";
  let searchTerms = terms;
  let outcome: {
    rows: ProcessRow[];
    totalHits: number;
    totalSessions: number;
  };

  if (terms.length === 0) {
    mode = "recent";
    outcome = executeProcessRecent(db, params, limit + offset);
  } else {
    const longTerms = terms.filter((term) => runeLength(term) >= 3);
    const shortTerms = terms.filter((term) => runeLength(term) < 3);
    const asciiOnly = terms.every((term) => !hasCjk(term));
    if (longTerms.length > 0) {
      mode = "fts";
      outcome = executeProcessFts(
        db,
        params,
        longTerms,
        "event_fts",
        shortTerms,
        limit + offset,
      );
      if (outcome.rows.length === 0 && asciiOnly) {
        outcome = executeProcessFts(
          db,
          params,
          longTerms,
          "event_fts_en",
          shortTerms,
          limit + offset,
        );
      }
    } else {
      mode = "like";
      outcome = executeProcessLike(db, params, terms, limit + offset);
    }
    if (outcome.rows.length === 0 && mode !== "like") {
      const relaxed = cjkRelaxedTerms(terms);
      if (relaxed) {
        const retry = executeProcessFts(
          db,
          params,
          relaxed.filter((term) => runeLength(term) >= 3),
          "event_fts",
          relaxed.filter((term) => runeLength(term) < 3),
          limit + offset,
        );
        if (retry.rows.length > 0) {
          outcome = retry;
          searchTerms = relaxed;
        }
      }
    }

    if (outcome.rows.length === 0 && mode !== "like") {
      mode = "like";
      outcome = executeProcessLike(db, params, terms, limit + offset);
    }
  }

  const sliced =
    offset > 0
      ? outcome.rows.slice(offset, offset + limit)
      : outcome.rows.slice(0, limit);
  const sessions = groupProcessRows(
    sliced,
    searchTerms,
  ).slice(0, limit);

  return {
    q: params.q,
    terms,
    scope: "process",
    mode: mode === "process" ? "process" : mode,
    tookMs: Math.round((performance.now() - startedAt) * 10) / 10,
    totalTurns: outcome.totalHits,
    totalSessions: outcome.totalSessions,
    processTotal: outcome.totalHits,
    sessions,
  };
}

export function searchTurns(db: Database, params: SearchParams): SearchResult {
  const startedAt = performance.now();
  const terms = parseTerms(params.q);
  const requestedLimit = Number.isFinite(params.limit) ? params.limit : 120;
  const requestedOffset = Number.isFinite(params.offset) ? params.offset : 0;
  const limit = Math.max(1, Math.min(5000, requestedLimit));
  const offset = Math.max(0, requestedOffset);

  if (params.scope === "process") {
    return searchProcess(db, params, terms, limit, offset);
  }

  let mode: "fts" | "like" | "recent" = "recent";
  // The terms the matches actually came from: the word-split retry below
  // searches different strings than the user typed, and the snippet should
  // centre on what matched.
  let searchTerms = terms;
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
      const relaxed = cjkRelaxedTerms(terms);
      if (relaxed) {
        const retry = executeFts(
          db,
          params,
          relaxed.filter((term) => runeLength(term) >= 3),
          "turn_fts",
          relaxed.filter((term) => runeLength(term) < 3),
          limit + offset,
        );
        if (retry.rows.length > 0) {
          outcome = retry;
          searchTerms = relaxed;
        }
      }
    }

    if (outcome.rows.length === 0 && mode !== "like") {
      mode = "like";
      outcome = executeLike(db, params, terms, limit + offset);
    }
  }

  const sliced =
    offset > 0 ? outcome.rows.slice(offset, offset + limit) : outcome.rows.slice(0, limit);
  const sessions = groupRows(sliced, searchTerms, params).slice(0, limit);

  // Title pass (QA scope, non-empty query): sessions whose title matches
  // every term appear even when no turn matched. Turn-matched sessions stay
  // first; title-only sessions are appended, deduped against the content
  // result and bounded by the pagination budget.
  let resultSessions = sessions;
  let titleMatches = 0;
  if (terms.length > 0) {
    const contentIds = new Set(sliced.map((row) => row.session_id));
    const extra = executeTitlePass(db, params, terms, limit + offset)
      .filter((row) => !contentIds.has(row.session_id));
    const byId = new Map(resultSessions.map((session) => [session.id, session]));
    for (const titleSession of groupTitlePass(extra)) {
      if (byId.has(titleSession.id)) continue;
      byId.set(titleSession.id, titleSession);
      resultSessions = [...resultSessions, titleSession];
      titleMatches += 1;
    }
    resultSessions = resultSessions.slice(0, limit);
  }

  return {
    q: params.q,
    terms,
    scope: "qa",
    mode,
    tookMs: Math.round((performance.now() - startedAt) * 10) / 10,
    totalTurns: outcome.totalTurns,
    totalSessions: outcome.totalSessions,
    processTotal: 0,
    // Sessions found by title count toward the session total so the status
    // line matches what the list actually holds. Content turns stay as the
    // turn count: a title match has no turn content behind it.
    totalTurns: outcome.totalTurns,
    totalSessions: outcome.totalSessions + titleMatches,
    sessions: resultSessions,
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
  /** Whole-index totals, hidden sessions included. */
  total: { sessions: number; turns: number; chars: number };
  /** Sessions the starred filter returns by default (starred and not hidden). */
  starredCount: number;
  /** Sessions hidden from search; left out of `agents`, `projects` and `starredCount`. */
  hiddenCount: number;
  lastScanMs: number;
  lastScanTookMs: number;
  errors: { source: string; message: string; at: number }[];
}

export function facets(db: Database): FacetResult {
  // These feed the filter panel, so they count what a default search returns:
  // hidden sessions are left out, and `hiddenCount` says how many there are.
  const agents = db
    .query(
      `SELECT agent AS id, count(*) AS sessions FROM session
       WHERE hidden = 0 GROUP BY agent ORDER BY sessions DESC`,
    )
    .all() as { id: AgentId; sessions: number }[];
  const projects = db
    .query(
      `SELECT project_path AS path, count(*) AS sessions
       FROM session WHERE hidden = 0 AND project_path <> ''
       GROUP BY project_path ORDER BY sessions DESC, path ASC LIMIT 300`,
    )
    .all() as { path: string; sessions: number }[];
  const errors = db
    .query("SELECT source, message, at FROM scan_error ORDER BY at DESC LIMIT 20")
    .all() as { source: string; message: string; at: number }[];
  const flags = db
    .query(
      `SELECT
         (SELECT count(*) FROM session WHERE starred = 1 AND hidden = 0) AS starredCount,
         (SELECT count(*) FROM session WHERE hidden = 1) AS hiddenCount`,
    )
    .get() as { starredCount: number; hiddenCount: number };
  return {
    agents,
    projects,
    total: indexStats(db),
    starredCount: flags.starredCount,
    hiddenCount: flags.hiddenCount,
    lastScanMs: Number(getMeta(db, "last_scan_ms") ?? 0),
    lastScanTookMs: Number(getMeta(db, "last_scan_took_ms") ?? 0),
    errors,
  };
}
