import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { DB_PATH, PORT, WEB_DIST } from "./config.ts";
import {
  briefFilesMentioning,
  generateBrief,
  generateWeekReport,
  isoWeekKey,
  parseBriefDate,
  readBrief,
} from "./brief.ts";
import type { BriefFormat, BriefResult } from "./brief.ts";
import {
  eventCountsFor,
  eventsForTurn,
  forgetSession,
  openDb,
  splitSessionId,
  unforgetSession,
} from "./db.ts";
import type { IndexedDatabase } from "./db.ts";
import { generateHandoff } from "./handoff.ts";
import { InvalidPrefsError, readPrefs, updatePrefs } from "./prefs.ts";
import { facets, getSessionDetail, searchTurns } from "./search.ts";
import type { SearchParams, SearchRole, SearchScope } from "./search.ts";
import { scan } from "./scan.ts";
import type { ScanReport } from "./scan.ts";
import { acquireScanLock, scanLockPath, tryAcquireScanLock } from "./scan-lock.ts";
import { AGENT_IDS, AGENT_LABELS, isAgentId } from "./adapters/types.ts";
import type { AgentId } from "./adapters/types.ts";
import { continuationFor } from "./util/resume.ts";

const ROLES: SearchRole[] = ["all", "user", "assistant"];
const SCOPES: SearchScope[] = ["qa", "process"];
const BRIEF_FORMATS: BriefFormat[] = ["standup", "archive", "week"];

function parseBriefFormat(value: string | null): BriefFormat | null {
  if (value === null) return "standup";
  return BRIEF_FORMATS.includes(value as BriefFormat) ? (value as BriefFormat) : null;
}

let db: IndexedDatabase | null = null;
let scanning = false;
let lastReport: ScanReport | null = null;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function parseAgentList(value: string | null): AgentId[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is AgentId => AGENT_IDS.includes(part as AgentId));
}

function parseRole(value: string | null): SearchRole {
  return ROLES.includes(value as SearchRole) ? (value as SearchRole) : "all";
}

function parseScope(value: string | null): SearchScope {
  return SCOPES.includes(value as SearchScope) ? (value as SearchScope) : "qa";
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function searchParams(url: URL): SearchParams {
  return {
    q: (url.searchParams.get("q") ?? "").trim(),
    agents: parseAgentList(url.searchParams.get("agents")),
    project: url.searchParams.get("project") ?? "",
    from: parseTime(url.searchParams.get("from")),
    to: parseTime(url.searchParams.get("to")),
    role: parseRole(url.searchParams.get("role")),
    scope: parseScope(url.searchParams.get("scope")),
    limit: Number(url.searchParams.get("limit") ?? 30),
    offset: Number(url.searchParams.get("offset") ?? 0),
  };
}

async function runScan(): Promise<ScanReport | null> {
  if (!db || scanning) return lastReport;
  // Another process (CLI, MCP) may be scanning; skip this cycle and keep serving.
  const lock = tryAcquireScanLock(scanLockPath(DB_PATH));
  if (!lock) return lastReport;
  scanning = true;
  try {
    lastReport = await scan(db, undefined, {
      onProgress: (message) => console.log(message),
    });
    return lastReport;
  } catch (error) {
    console.error("scan failed", error);
    return lastReport;
  } finally {
    scanning = false;
    lock.release();
  }
}

function sessionDetail(id: string): Response {
  if (!db) return json({ error: "index not open" }, 500);
  const raw = getSessionDetail(db, id) as {
    session: {
      id: string;
      agent: AgentId;
      external_id: string;
      title: string;
      project_path: string;
      started_at: number;
      updated_at: number;
      turn_count: number;
      source_kind: string;
      source_path: string;
    };
    turns: {
      idx: number;
      ts: number;
      user_text: string;
      assistant_text: string;
      model: string | null;
      truncated: number;
    }[];
  } | null;
  if (!raw) return json({ error: "session not found" }, 404);
  const counts = eventCountsFor(db, raw.session.id);
  return json({
    session: {
      id: raw.session.id,
      agent: raw.session.agent,
      title: raw.session.title,
      projectPath: raw.session.project_path,
      startedAt: raw.session.started_at,
      updatedAt: raw.session.updated_at,
      turnCount: raw.session.turn_count,
      sourceKind: raw.session.source_kind,
      continuations: AGENT_IDS.map((agent) => ({
        targetAgent: agent,
        label: AGENT_LABELS[agent],
        ...continuationFor(agent, {
          agent: raw.session.agent,
          externalId: raw.session.external_id,
          projectPath: raw.session.project_path,
        }),
      })),
    },
    turns: raw.turns.map((turn) => ({
      idx: turn.idx,
      ts: turn.ts,
      userText: turn.user_text,
      assistantText: turn.assistant_text,
      model: turn.model,
      truncated: turn.truncated === 1,
      eventCount: counts.get(turn.idx) ?? 0,
    })),
  });
}

async function api(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/search") {
    if (!db) return json({ error: "index not open" }, 500);
    return json(searchTurns(db, searchParams(url)));
  }
  if (
    request.method === "POST" &&
    url.pathname.startsWith("/api/session/") &&
    (url.pathname.endsWith("/forget") || url.pathname.endsWith("/unforget"))
  ) {
    if (!db) return json({ error: "index not open" }, 500);
    const forget = url.pathname.endsWith("/forget");
    const suffix = forget ? "/forget" : "/unforget";
    const rawId = decodeURIComponent(url.pathname.slice("/api/session/".length, -suffix.length));
    const target = splitSessionId(rawId);
    if (!target) return json({ error: `invalid session id "${rawId}"` }, 400);
    // Removing a session races the 90s background scan, which rewrites sessions
    // in bulk; both paths take the same cross-process lock. Refusing is better
    // than waiting: the forget itself rebuilds the FTS indexes and checkpoints
    // the WAL, so a long wait would push the request past the idle timeout.
    if (scanning) return json({ error: "正在重新索引，请稍后重试" }, 409);
    const lock = await acquireScanLock(scanLockPath(DB_PATH), { timeoutMs: 5_000 });
    if (!lock) return json({ error: "正在重新索引，请稍后重试" }, 409);
    try {
      if (!forget) {
        const wasForgotten = unforgetSession(db, target.agent, target.externalId);
        return json({ id: rawId, forgotten: false, wasForgotten, removed: false, briefs: [] });
      }
      const outcome = forgetSession(db, target.agent, target.externalId);
      return json({
        id: outcome.id,
        forgotten: true,
        removed: outcome.removed,
        wasForgotten: outcome.already,
        // Briefs are Markdown copies; the UI tells the user they can be stale.
        briefs: briefFilesMentioning(outcome.id),
      });
    } finally {
      lock.release();
    }
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/session/")) {
    const rest = url.pathname.slice("/api/session/".length);
    if (rest.endsWith("/handoff")) {
      if (!db) return json({ error: "index not open" }, 500);
      const id = decodeURIComponent(rest.slice(0, -"/handoff".length));
      const targetParam = url.searchParams.get("targetAgent");
      if (targetParam !== null && !isAgentId(targetParam)) {
        return json({ error: `unknown targetAgent "${targetParam}"` }, 400);
      }
      const handoff = generateHandoff(
        db,
        id,
        targetParam ? { targetAgent: targetParam } : {},
      );
      if (handoff === null) return json({ error: "session not found" }, 404);
      return new Response(handoff, {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/markdown; charset=utf-8",
        },
      });
    }
    if (rest.endsWith("/events")) {
      if (!db) return json({ error: "index not open" }, 500);
      const id = decodeURIComponent(rest.slice(0, -"/events".length));
      const turn = Number(url.searchParams.get("turn") ?? "-1");
      if (!Number.isInteger(turn) || turn < 0) {
        return json({ error: "invalid turn" }, 400);
      }
      return json({ turn, events: eventsForTurn(db, id, turn) });
    }
    const id = decodeURIComponent(rest);
    return sessionDetail(id);
  }
  if (request.method === "GET" && url.pathname === "/api/facets") {
    if (!db) return json({ error: "index not open" }, 500);
    return json(facets(db));
  }
  if (request.method === "POST" && url.pathname === "/api/brief") {
    if (!db) return json({ error: "index not open" }, 500);
    const format = parseBriefFormat(url.searchParams.get("format"));
    if (!format) {
      return json({ error: `invalid format: ${url.searchParams.get("format") ?? ""}` }, 400);
    }
    const date = parseBriefDate(url.searchParams.get("date"));
    let result: BriefResult;
    if (format === "week") {
      const week =
        url.searchParams.get("week") ??
        isoWeekKey(date?.start ?? Date.now());
      try {
        result = generateWeekReport(db, week);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    } else {
      if (!date) return json({ error: "invalid date" }, 400);
      result = generateBrief(db, date.key, { format });
    }
    const download = new URLSearchParams({ format });
    if (result.week) download.set("week", result.week);
    else download.set("date", result.date);
    return json({
      format: result.format,
      date: result.date,
      week: result.week,
      range: result.range,
      activeDays: result.activeDays,
      agents: result.agents,
      path: result.path,
      relativePath: result.relativePath,
      sessions: result.sessions,
      turns: result.turns,
      projects: result.projects,
      markdown: result.markdown,
      download: `/api/brief/file?${download.toString()}`,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/brief/file") {
    // Old links carried no format and meant the archive file; keep that.
    const rawFormat = url.searchParams.get("format");
    const format = rawFormat === null ? "archive" : parseBriefFormat(rawFormat);
    if (!format) {
      return json({ error: `invalid format: ${rawFormat ?? ""}` }, 400);
    }
    const week = url.searchParams.get("week") ?? undefined;
    const date = url.searchParams.get("date") ?? undefined;
    const content = readBrief({ format, week, date });
    if (content === null) return json({ error: "brief not found" }, 404);
    const filename = (format === "week" ? week : date) ?? "brief";
    return new Response(content, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.md"`,
        "cache-control": "no-store",
      },
    });
  }
  if (url.pathname === "/api/prefs") {
    if (request.method === "GET") return json(readPrefs());
    if (request.method === "PATCH") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json({ error: "expected a JSON object" }, 400);
      }
      try {
        return json(updatePrefs(body as Record<string, unknown>));
      } catch (error) {
        if (error instanceof InvalidPrefsError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }
    return json({ error: "method not allowed" }, 405);
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    return json({
      scanning,
      lastReport,
      port: PORT,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/scan") {
    if (scanning) return json({ scanning: true }, 202);
    void runScan();
    return json({ scanning: true }, 202);
  }
  return json({ error: "not found" }, 404);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function staticResponse(pathname: string): Response {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(WEB_DIST, `.${normalize(requested)}`);
  if (!filePath.startsWith(resolve(WEB_DIST))) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(filePath)) {
    if (requested === "/index.html") {
      return new Response("Run `bun run build` to build the web UI.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  }
  return new Response(readFileSync(filePath), {
    headers: {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    },
  });
}

export function serve(): void {
  db = openDb(DB_PATH);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    // A forget rebuilds the FTS indexes and vacuums the index, which can take
    // seconds on a large index; the default 10s idle timeout would abort the
    // request while the delete was already committed.
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        try {
          return await api(request, url);
        } catch (error) {
          console.error(error);
          return json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      return staticResponse(url.pathname);
    },
  });

  console.log(`session-recall  http://127.0.0.1:${server.port}`);
  void runScan();
  setInterval(() => {
    void runScan();
  }, 90_000);

  process.on("SIGINT", () => {
    server.stop();
    db?.close();
    process.exit(0);
  });
}
