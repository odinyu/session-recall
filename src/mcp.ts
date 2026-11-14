import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Database } from "bun:sqlite";
import { AGENT_IDS, isAgentId } from "./adapters/types.ts";
import type { Adapter, AgentId } from "./adapters/types.ts";
import { localDateKey } from "./brief.ts";
import { DB_PATH } from "./config.ts";
import { openDb } from "./db.ts";
import {
  DEFAULT_MAX_AGE_MS,
  indexAgeMs,
  refreshInBackground,
  scanIfStale,
} from "./freshness.ts";
import type { RefreshState } from "./freshness.ts";
import { generateHandoff } from "./handoff.ts";
import { openIndexReadOnly } from "./index-read.ts";
import { DEFAULT_STALE_MS, scanLockPath } from "./scan-lock.ts";
import { facets, getSessionDetail, searchTurns } from "./search.ts";
import type { SearchParams, SearchScope } from "./search.ts";
import { clipText } from "./util/values.ts";

/**
 * Minimal stdio MCP server (JSON-RPC 2.0, one object per line) over the same
 * local index the app writes. Read tools open the index read-only; the only
 * write path is `recall_scan` / the stale refresh, and both hold the shared
 * scan lock before touching it.
 *
 * Compact by design: agents pay for context, so search returns one clipped hit
 * per session plus a deep link, and session reads are capped.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

const SERVER_VERSION = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0";
  } catch {
    return "0";
  }
})();

const MAX_SESSION_TURNS = 20;
const QUESTION_CHARS = 200;
const ANSWER_CHARS = 320;
const SNIPPET_CHARS = 240;

export interface McpContext {
  dbPath: string;
  /** Refresh when the last scan is older than this. */
  maxAgeMs?: number;
  /** Lock mtime/pid threshold for abandoned scans. */
  staleLockMs?: number;
  /** How long `recall_scan` waits for a running scan. */
  scanLockTimeoutMs?: number;
  /** Injected in tests so a tool call never reads the host's agent stores. */
  adapters?: Adapter[];
  onProgress?: (message: string) => void;
}

export function defaultContext(): McpContext {
  return {
    dbPath: DB_PATH,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    staleLockMs: DEFAULT_STALE_MS,
    scanLockTimeoutMs: 5_000,
    onProgress: (message) => console.error(message),
  };
}

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

class ToolArgsError extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok(payload: unknown): ToolCallResult {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
    ],
  };
}

function toolError(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function withIndex(
  ctx: McpContext,
  run: (db: Database) => ToolCallResult,
): ToolCallResult {
  let db: Database;
  try {
    db = openIndexReadOnly(ctx.dbPath);
  } catch (error) {
    return toolError(messageOf(error));
  }
  try {
    return run(db);
  } catch (error) {
    return toolError(messageOf(error));
  } finally {
    db.close();
  }
}

/** Age plus the decision about refreshing; shared by every read tool. */
function freshness(
  db: Database,
  ctx: McpContext,
): { indexAgeMs: number | null; refresh: RefreshState } {
  const age = indexAgeMs(db);
  const refresh = refreshInBackground(ctx.dbPath, {
    ageMs: age,
    maxAgeMs: ctx.maxAgeMs,
    staleMs: ctx.staleLockMs,
    adapters: ctx.adapters,
    onProgress: ctx.onProgress,
    onError: (error) => console.error("session-recall: background scan failed", messageOf(error)),
  });
  return { indexAgeMs: age, refresh };
}

function argsRecord(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolArgsError("arguments must be an object");
  }
  return raw as Record<string, unknown>;
}

function timeArg(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ToolArgsError(`${name} must be epoch milliseconds or an ISO date`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new ToolArgsError(`${name} must be epoch milliseconds or an ISO date`);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolArgsError(`invalid ${name} "${value}": expected epoch milliseconds or an ISO date`);
  }
  return parsed;
}

interface SearchArgs {
  query: string;
  agent: AgentId | null;
  scope: SearchScope;
  project: string;
  from: number | null;
  to: number | null;
  limit: number;
  starred: boolean;
  includeHidden: boolean;
}

function booleanArg(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new ToolArgsError(`${name} must be a boolean`);
  }
  return value;
}

function searchArgs(raw: unknown): SearchArgs {
  const args = argsRecord(raw);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new ToolArgsError("query is required");

  let agent: AgentId | null = null;
  if (args.agent !== undefined && args.agent !== null) {
    if (!isAgentId(args.agent)) {
      throw new ToolArgsError(`unknown agent "${String(args.agent)}"`);
    }
    agent = args.agent;
  }

  const scope = args.scope ?? "qa";
  if (scope !== "qa" && scope !== "process") {
    throw new ToolArgsError(`invalid scope "${String(scope)}": expected qa or process`);
  }

  const rawLimit = args.limit ?? 5;
  const limit = typeof rawLimit === "string" ? Number(rawLimit) : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ToolArgsError("limit must be an integer from 1 to 50");
  }

  return {
    query,
    agent,
    scope,
    project: typeof args.project === "string" ? args.project : "",
    from: timeArg(args.from, "from"),
    to: timeArg(args.to, "to"),
    limit,
    starred: booleanArg(args.starred, "starred"),
    includeHidden: booleanArg(args.includeHidden, "includeHidden"),
  };
}

function deepLink(sessionId: string, turn?: number): string {
  const base = `sessionrecall://session/${encodeURIComponent(sessionId)}`;
  return turn === undefined ? base : `${base}?turn=${turn}`;
}

function day(ms: number): string {
  return ms > 0 ? localDateKey(new Date(ms)) : "";
}

interface CompactHit {
  sessionId: string;
  agent: AgentId;
  project: string;
  date: string;
  title: string;
  turn: number;
  deepLink: string;
  /** Present only when the user starred the session. */
  starred?: true;
  question?: string;
  answer?: string;
  tool?: string;
  status?: string;
  snippet?: string;
}

export function recallSearch(ctx: McpContext, rawArgs: unknown): ToolCallResult {
  let args: SearchArgs;
  try {
    args = searchArgs(rawArgs);
  } catch (error) {
    return toolError(messageOf(error));
  }

  return withIndex(ctx, (db) => {
    const { indexAgeMs: age, refresh } = freshness(db, ctx);
    const params: SearchParams = {
      q: args.query,
      agents: args.agent ? [args.agent] : [],
      project: args.project,
      from: args.from,
      to: args.to,
      role: "all",
      scope: args.scope,
      // searchTurns limits matching turns, at most 3 per session; ask for
      // enough rows to fill `limit` sessions, then slice.
      limit: Math.min(5000, args.limit * 3),
      offset: 0,
      starred: args.starred,
      includeHidden: args.includeHidden,
    };
    const result = searchTurns(db, params);

    const results: CompactHit[] = [];
    for (const session of result.sessions.slice(0, args.limit)) {
      const turn = args.scope === "qa" ? session.hits[0] : session.processHits[0];
      if (!turn) continue;
      const base = {
        sessionId: session.id,
        agent: session.agent,
        project: session.projectPath,
        date: day(session.updatedAt),
        title: clipText(session.title, 120),
        turn: "idx" in turn ? turn.idx : turn.turnIdx,
        deepLink: deepLink(session.id, "idx" in turn ? turn.idx : turn.turnIdx),
        // Kept out of the payload unless set: an agent pays for every token.
        ...(session.starred ? { starred: true as const } : {}),
      };
      if ("idx" in turn) {
        results.push({
          ...base,
          question: clipText(
            turn.matchField === "user" ? turn.snippet : turn.userText,
            QUESTION_CHARS,
          ),
          answer: clipText(
            turn.matchField === "user" ? turn.assistantSnippet : turn.snippet,
            ANSWER_CHARS,
          ),
        });
      } else {
        results.push({
          ...base,
          tool: turn.tool,
          status: turn.status,
          snippet: clipText(turn.snippet, SNIPPET_CHARS),
        });
      }
    }

    return ok({
      query: result.q,
      scope: result.scope,
      indexAgeMs: age,
      refresh,
      totalSessions: result.totalSessions,
      totalTurns: result.totalTurns,
      returned: results.length,
      results,
    });
  });
}

interface RawTurn {
  idx: number;
  ts: number;
  user_text: string;
  assistant_text: string;
  truncated: number;
}

interface RawSession {
  id: string;
  agent: AgentId;
  title: string;
  project_path: string;
  updated_at: number;
  turn_count: number;
}

export function recallSession(ctx: McpContext, rawArgs: unknown): ToolCallResult {
  let sessionId: string;
  let turn: number | null = null;
  try {
    const args = argsRecord(rawArgs);
    sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) throw new ToolArgsError("sessionId is required");
    if (args.turn !== undefined && args.turn !== null) {
      if (
        typeof args.turn !== "number" ||
        !Number.isInteger(args.turn) ||
        args.turn < 0
      ) {
        throw new ToolArgsError("turn must be a non-negative integer");
      }
      turn = args.turn;
    }
  } catch (error) {
    return toolError(messageOf(error));
  }

  return withIndex(ctx, (db) => {
    const { indexAgeMs: age, refresh } = freshness(db, ctx);
    const detail = getSessionDetail(db, sessionId) as {
      session: RawSession;
      turns: RawTurn[];
    } | null;
    if (!detail) return toolError(`session not found: ${sessionId}`);

    const all = detail.turns;
    let kept = all;
    if (turn !== null) {
      kept = all.filter((row) => row.idx === turn);
      if (kept.length === 0) return toolError(`session ${sessionId} has no turn ${turn}`);
    } else if (all.length > MAX_SESSION_TURNS) {
      kept = all.slice(-MAX_SESSION_TURNS);
    }

    return ok({
      indexAgeMs: age,
      refresh,
      session: {
        sessionId: detail.session.id,
        agent: detail.session.agent,
        project: detail.session.project_path,
        title: detail.session.title,
        date: day(detail.session.updated_at),
        updatedAt: detail.session.updated_at,
        turnCount: detail.session.turn_count,
        deepLink: deepLink(
          detail.session.id,
          turn === null ? undefined : turn,
        ),
      },
      totalTurns: all.length,
      returnedTurns: kept.length,
      truncated: kept.length < all.length,
      turns: kept.map((row) => ({
        idx: row.idx,
        date: day(row.ts),
        user: clipText(row.user_text, 800),
        assistant: clipText(row.assistant_text, 1200),
        sourceTruncated: row.truncated === 1,
      })),
    });
  });
}

export function recallFacets(ctx: McpContext, rawArgs: unknown): ToolCallResult {
  return withIndex(ctx, (db) => {
    const { indexAgeMs: age, refresh } = freshness(db, ctx);
    const result = facets(db);
    return ok({
      indexAgeMs: age,
      refresh,
      total: result.total,
      starredCount: result.starredCount,
      hiddenCount: result.hiddenCount,
      lastScanMs: result.lastScanMs,
      agents: result.agents,
      projectCount: result.projects.length,
      projects: result.projects.slice(0, 30),
    });
  });
}

export function recallHandoff(ctx: McpContext, rawArgs: unknown): ToolCallResult {
  let sessionId: string;
  let targetAgent: AgentId | undefined;
  try {
    const args = argsRecord(rawArgs);
    sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) throw new ToolArgsError("sessionId is required");
    if (args.targetAgent !== undefined && args.targetAgent !== null) {
      if (!isAgentId(args.targetAgent)) {
        throw new ToolArgsError(`unknown targetAgent "${String(args.targetAgent)}"`);
      }
      targetAgent = args.targetAgent;
    }
  } catch (error) {
    return toolError(messageOf(error));
  }

  return withIndex(ctx, (db) => {
    const card = generateHandoff(db, sessionId, targetAgent ? { targetAgent } : {});
    if (!card) return toolError(`session not found: ${sessionId}`);
    return ok(card);
  });
}

export async function recallScan(ctx: McpContext): Promise<ToolCallResult> {
  let db: Database;
  try {
    db = openDb(ctx.dbPath);
  } catch (error) {
    return toolError(messageOf(error));
  }
  try {
    const result = await scanIfStale(db, scanLockPath(ctx.dbPath), {
      force: true,
      timeoutMs: ctx.scanLockTimeoutMs,
      staleMs: ctx.staleLockMs,
      adapters: ctx.adapters,
      onProgress: ctx.onProgress,
    });
    const report = result.report;
    return ok({
      scanned: result.scanned,
      skipped: result.skipped,
      indexAgeMs: result.ageMs,
      tookMs: report?.tookMs ?? 0,
      sessions: report?.sessions ?? null,
      turns: report?.turns ?? null,
      errors: report ? report.errors.length : null,
    });
  } catch (error) {
    return toolError(`scan failed: ${messageOf(error)}`);
  } finally {
    db.close();
  }
}

export const TOOLS = [
  {
    name: "recall_search",
    description:
      "Search past coding-agent sessions (omp, OpenCode, Cursor, Alma, Cindy) on this machine. " +
      "Returns one compact question/answer pair per session with a deep link. " +
      "Scope qa searches prompts and answers; scope process searches tool calls and errors. " +
      "Sessions the user hid are skipped unless includeHidden is true; starred: true " +
      "restricts the search to the user's starred sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Bare terms or a quoted phrase; multi-term is ANDed." },
        agent: { type: "string", enum: [...AGENT_IDS] },
        scope: { type: "string", enum: ["qa", "process"], default: "qa" },
        project: { type: "string", description: "Exact project path to filter on." },
        from: { type: "string", description: "ISO date or epoch milliseconds, inclusive." },
        to: { type: "string", description: "ISO date or epoch milliseconds, inclusive." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 5 },
        starred: {
          type: "boolean",
          default: false,
          description: "Only sessions the user starred.",
        },
        includeHidden: {
          type: "boolean",
          default: false,
          description: "Also search sessions the user hid; hidden ones are skipped by default.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "recall_session",
    description:
      "Read a session's turns, or one turn when `turn` is given. Capped to the most recent 20 turns.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The id returned by recall_search." },
        turn: { type: "integer", minimum: 0, description: "Turn index; omit for the whole session." },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "recall_facets",
    description:
      "List indexed agents and projects with session counts (hidden sessions excluded), " +
      "plus starred/hidden counts and index freshness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "recall_handoff",
    description:
      "Render the Markdown handoff card for a session, ready to paste into a new agent. " +
      "Pass targetAgent to get that agent's resume command or new-session command in the card.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The id returned by recall_search." },
        targetAgent: {
          type: "string",
          enum: [...AGENT_IDS],
          description: "Continue in this agent; omit to keep the source agent's own resume section.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "recall_scan",
    description: "Rescan the local agent stores now and return index statistics.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const HANDLERS: Record<
  string,
  (ctx: McpContext, args: unknown) => ToolCallResult | Promise<ToolCallResult>
> = {
  recall_search: recallSearch,
  recall_session: recallSession,
  recall_facets: recallFacets,
  recall_handoff: recallHandoff,
  recall_scan: recallScan,
};

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Handles one decoded JSON-RPC message; null when no response is due. */
export async function handleRpcMessage(
  ctx: McpContext,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  const record = message as Record<string, unknown>;
  const method = record.method;
  if (typeof method !== "string") return rpcError(null, -32600, "Invalid Request");

  const rawId = record.id;
  const hasId = rawId !== undefined && rawId !== null;
  // Notifications get no response, by spec; only the initialized notice matters.
  if (!hasId) return null;
  if (typeof rawId !== "number" && typeof rawId !== "string") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const id = rawId;
  const params = record.params;

  if (method === "initialize") {
    const requested =
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>).protocolVersion
        : undefined;
    return rpcResult(id, {
      protocolVersion:
        typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)
          ? requested
          : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "session-recall", version: SERVER_VERSION },
      instructions:
        "Local, read-only recall over coding-agent sessions. Search is compact; " +
        "open a deepLink (sessionrecall://session/<id>) to inspect it in the app.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const call = typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};
    const name = typeof call.name === "string" ? call.name : "";
    const handler = HANDLERS[name];
    if (!handler) return rpcError(id, -32602, `unknown tool: ${name || "(missing name)"}`);
    const result = await handler(ctx, call.arguments);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

/** Reads newline-delimited JSON-RPC from stdin until EOF, writing replies to stdout. */
export async function runMcpServer(ctx: McpContext = defaultContext()): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await handleRpcMessage(ctx, message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
