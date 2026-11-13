import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
  parseJson,
  readString,
} from "../util/values.ts";
import type {
  Adapter,
  ParsedEvent,
  ParsedSession,
  ParsedTurn,
  SessionRef,
} from "./types.ts";

/**
 * Goose keeps every session in one SQLite file, `sessions.db`. The location is
 * `$GOOSE_PATH_ROOT/data/sessions/sessions.db` when that variable is set,
 * otherwise the platform store — `~/Library/Application Support/goose/sessions/`
 * on macOS, `~/.local/share/goose/sessions/` on Linux, plus the
 * `~/.local/share/Block/goose/sessions/` variant older installs used. The
 * database is opened `readonly` with a busy timeout because the running Goose
 * app holds it in WAL mode, the same contract the Alma and OpenCode adapters
 * use.
 *
 * Columns read (verified against Goose's own schema):
 * - `sessions`: `id`, `name`, `description`, `working_dir`, `created_at`,
 *   `updated_at`, `model_config_json` (JSON holding `model_name`),
 *   `parent_session_id`.
 * - `messages`: `id` (row order tie-break), `session_id`, `role`,
 *   `content_json`, `created_timestamp` (Unix seconds), `metadata_json`.
 *
 * `content_json` decodes to an array of blocks tagged `type`:
 * `text` (`.text`), `toolRequest` (`.id`, `.toolCall.value.name` /
 * `.toolCall.value.arguments`), `toolResponse` (`.id`, `.toolResult.status` and
 * either `.toolResult.value` — an MCP result with `content[]` — or
 * `.toolResult.error`), and `thinking` (`.thinking`). `image`, `document`,
 * `redactedThinking`, `systemNotification`, `error`, `toolConfirmationRequest`
 * and `actionRequired` are not conversation text and are skipped.
 *
 * `metadata_json.userVisible === false` marks agent-only messages (injected
 * context, compaction summaries); they are skipped so a search cannot surface
 * text the user never saw. Older rows have no metadata and stay visible.
 *
 * Schema drift: the columns above moved between Goose releases (`name`,
 * `metadata_json`, `model_config_json` and `parent_session_id` are all
 * migrations). Every column is probed with `PRAGMA table_info` and the query is
 * built from what exists; `created_timestamp` falls back to `timestamp`. When
 * `sessions` or the required `messages` columns are missing, the adapter reports
 * no sessions instead of throwing.
 *
 * Project path comes from `sessions.working_dir`; Goose does not record the
 * project anywhere else, so it is empty when that column is absent. Title is
 * `sessions.name`, then `sessions.description`, then the first prompt.
 */

const DB_NAME = "sessions.db";
/** Safety cap so a damaged or runaway store cannot stall a scan. */
const MAX_ROWS = 200_000;

/** `~` is expanded because GOOSE_PATH_ROOT is often written by hand. */
function expandHome(value: string): string {
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return join(HOME, value.slice(2));
  return value;
}

/** The candidate databases, platform default first. */
function defaultCandidates(): string[] {
  const local = join(HOME, ".local", "share", "goose", "sessions", DB_NAME);
  const mac = join(HOME, "Library", "Application Support", "goose", "sessions", DB_NAME);
  const block = join(HOME, ".local", "share", "Block", "goose", "sessions", DB_NAME);
  return process.platform === "darwin" ? [mac, local, block] : [local, block, mac];
}

function resolveDbPath(explicit?: string): string | null {
  if (explicit) return explicit;
  const root = process.env.GOOSE_PATH_ROOT?.trim();
  if (root) return join(expandHome(root), "data", "sessions", DB_NAME);
  return defaultCandidates().find((path) => existsSync(path)) ?? null;
}

/** Columns of a table; an empty set when the table does not exist. */
function tableColumns(db: Database, table: string): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/** Goose stores Unix seconds, but millisecond rows appear in some versions. */
function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return 0;
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return toMillis(Number(text));
  // SQLite CURRENT_TIMESTAMP is UTC without a zone marker; Date.parse would
  // otherwise read it in local time.
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  return Date.parse(normalized) || 0;
}

/** `model_config_json.model_name`, tolerating a missing or malformed object. */
function modelName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const record = objectValue(parseJson(raw));
  if (!record) return "";
  return readString(record, "model_name") || readString(record, "model");
}

/** A message body is an array of blocks; a bare string is one text block. */
function blocksOf(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") return [{ type: "text", text: parsed }];
  const record = objectValue(parsed);
  return record ? [record] : [];
}

/** MCP tool results wrap readable text in `content[]`. */
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => contentText(item))
      .filter((part) => part.trim())
      .join("\n");
  }
  const record = objectValue(value);
  if (!record) return "";
  if (record.content !== undefined) return contentText(record.content);
  const text = readString(record, "text");
  if (text) return text;
  return jsonText(record);
}

interface ToolCall {
  name: string;
  input: string;
}

/** `toolRequest.toolCall` is `{status, value:{name, arguments}}`; tolerate flat. */
function toolCallOf(block: Record<string, unknown>): ToolCall {
  const call = objectValue(block.toolCall);
  if (!call) return { name: "tool", input: "" };
  const status = readString(call, "status");
  const value = objectValue(call.value);
  if (status === "success" && value) {
    return {
      name: readString(value, "name") || "tool",
      input: jsonText(value.arguments),
    };
  }
  // Older rows (or an errored call) keep the name at the top level.
  return {
    name: readString(call, "name") || "tool",
    input: jsonText(call.arguments),
  };
}

interface ToolResult {
  output: string;
  status: string;
}

/** `toolResponse.toolResult` is `{status:"success",value}` or `{status:"error",error}`. */
function toolResultOf(block: Record<string, unknown>): ToolResult {
  const result = objectValue(block.toolResult);
  if (!result) return { output: "", status: "" };
  if (readString(result, "status") === "error") {
    return { output: readString(result, "error"), status: "error" };
  }
  return { output: contentText(result.value), status: "ok" };
}

/** Sort turns by time, keeping query order for equal timestamps, then remap events. */
function orderConversation(
  turns: ParsedTurn[],
  events: ParsedEvent[],
): { turns: ParsedTurn[]; events: ParsedEvent[] } {
  const order = turns
    .map((turn, position) => ({ turn, position }))
    .sort((left, right) => left.turn.ts - right.turn.ts || left.position - right.position);
  const remap = new Map<number, number>();
  const sorted = order.map((entry, next) => {
    remap.set(entry.turn.idx, next);
    return { ...entry.turn, idx: next };
  });
  const remapped = events
    .filter((event) => remap.has(event.turnIdx))
    .map((event) => ({ ...event, turnIdx: remap.get(event.turnIdx) as number }))
    .sort((left, right) => left.turnIdx - right.turnIdx || left.seq - right.seq);
  return { turns: sorted, events: remapped };
}

interface Shape {
  sessionColumns: Set<string>;
  messageColumns: Set<string>;
  ready: boolean;
  timestampColumn: string;
  orderBy: string;
}

export function gooseAdapter(databasePath?: string): Adapter {
  const dbPath = resolveDbPath(databasePath);
  let db: Database | null = null;
  let shape: Shape | null = null;

  function open(): Database | null {
    if (db) return db;
    if (!dbPath || !existsSync(dbPath)) return null;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      // A locked or half-written store is not fatal: report no sessions.
      db = null;
      return null;
    }
    db.run("PRAGMA busy_timeout = 5000");
    return db;
  }

  function schema(): Shape | null {
    if (shape) return shape;
    const opened = open();
    if (!opened) return null;
    const sessionColumns = tableColumns(opened, "sessions");
    const messageColumns = tableColumns(opened, "messages");
    const timestampColumn = messageColumns.has("created_timestamp")
      ? "created_timestamp"
      : messageColumns.has("timestamp")
        ? "timestamp"
        : "";
    shape = {
      sessionColumns,
      messageColumns,
      ready:
        sessionColumns.has("id") &&
        messageColumns.has("session_id") &&
        messageColumns.has("role") &&
        messageColumns.has("content_json"),
      timestampColumn,
      orderBy: timestampColumn
        ? `${timestampColumn}${messageColumns.has("id") ? ", id" : ""}`
        : messageColumns.has("id")
          ? "id"
          : "rowid",
    };
    return shape;
  }

  /** `columnName AS alias`, or `NULL AS alias` when the version lacks it. */
  function pick(columns: Set<string>, table: string, name: string, alias = name): string {
    return columns.has(name) ? `${table}.${name} AS ${alias}` : `NULL AS ${alias}`;
  }

  async function list(): Promise<SessionRef[]> {
    const opened = open();
    const layout = schema();
    if (!opened || !layout || !layout.ready) return [];
    const stamp = pick(layout.sessionColumns, "s", "updated_at", "updated_at");
    const count = layout.timestampColumn
      ? `COUNT(m.rowid) AS messages, COALESCE(MAX(m.${layout.timestampColumn}), 0) AS last_stamp`
      : "COUNT(m.rowid) AS messages, 0 AS last_stamp";
    try {
      const rows = opened
        .query(
          `SELECT s.id AS id, ${stamp}, ${count}
           FROM sessions s
           LEFT JOIN messages m ON m.session_id = s.id
           GROUP BY s.id
           LIMIT ${MAX_ROWS}`,
        )
        .all() as { id: string; updated_at: unknown; messages: number; last_stamp: number }[];
      return rows.map((row) => ({
        agent: "goose",
        externalId: row.id,
        // `updated_at` alone misses a message appended without touching the
        // session row, so the message count and newest stamp ride along.
        fingerprint: `${String(row.updated_at ?? "")}:${row.messages}:${row.last_stamp}`,
        sourcePath: dbPath as string,
      }));
    } catch {
      return [];
    }
  }

  async function load(ref: SessionRef): Promise<ParsedSession | null> {
    const opened = open();
    const layout = schema();
    if (!opened || !layout || !layout.ready) return null;

    let session: Record<string, unknown> | null;
    try {
      session = objectValue(
        opened
          .query(
            `SELECT ${pick(layout.sessionColumns, "s", "id")},
                    ${pick(layout.sessionColumns, "s", "name")},
                    ${pick(layout.sessionColumns, "s", "description")},
                    ${pick(layout.sessionColumns, "s", "working_dir")},
                    ${pick(layout.sessionColumns, "s", "created_at")},
                    ${pick(layout.sessionColumns, "s", "updated_at")},
                    ${pick(layout.sessionColumns, "s", "model_config_json")},
                    ${pick(layout.sessionColumns, "s", "parent_session_id")}
             FROM sessions s WHERE s.id = ?`,
          )
          .get(ref.externalId),
      );
    } catch {
      return null;
    }
    if (!session) return null;

    let rows: {
      role: string;
      content_json: unknown;
      ts: unknown;
      metadata_json: unknown;
    }[];
    try {
      rows = opened
        .query(
          `SELECT role, content_json,
                  ${layout.timestampColumn ? layout.timestampColumn : "NULL"} AS ts,
                  ${layout.messageColumns.has("metadata_json") ? "metadata_json" : "NULL"} AS metadata_json
           FROM messages WHERE session_id = ?
           ORDER BY ${layout.orderBy}
           LIMIT ${MAX_ROWS}`,
        )
        .all(ref.externalId) as {
        role: string;
        content_json: unknown;
        ts: unknown;
        metadata_json: unknown;
      }[];
    } catch {
      return null;
    }

    const model = modelName(session.model_config_json);
    const turns: ParsedTurn[] = [];
    const events: ParsedEvent[] = [];
    const calls = new Map<string, ParsedEvent>();
    let current: ParsedTurn | null = null;
    let eventSeq = 0;
    let lastMessageTs = 0;

    const pushEvent = (event: Omit<ParsedEvent, "seq">, callId: string): ParsedEvent => {
      const created: ParsedEvent = { ...event, seq: eventSeq++ };
      events.push(created);
      if (callId) calls.set(callId, created);
      return created;
    };

    for (const row of rows) {
      // Agent-only messages (injected context, compaction summaries) are not
      // conversation the user saw. Missing metadata means an older row.
      const metadata = objectValue(
        typeof row.metadata_json === "string" ? parseJson(row.metadata_json) : null,
      );
      if (metadata && metadata.userVisible === false) continue;

      const role = row.role;
      if (role !== "user" && role !== "assistant") continue;
      const ts = toMillis(row.ts);
      if (ts > lastMessageTs) lastMessageTs = ts;

      const text: string[] = [];
      for (const rawBlock of blocksOf(row.content_json)) {
        const block = objectValue(rawBlock);
        if (!block) continue;
        const kind = readString(block, "type");
        if (kind === "text") {
          const value = readString(block, "text");
          if (value) text.push(value);
          continue;
        }
        if (kind === "thinking") {
          if (!current) continue;
          const value = readString(block, "thinking");
          if (!value.trim()) continue;
          const capped = capEventText(value, EVENT_CAPS.reasoning);
          pushEvent(
            {
              turnIdx: current.idx,
              kind: "reasoning",
              output: capped.text,
              truncated: capped.truncated,
            },
            "",
          );
          continue;
        }
        if (kind === "toolRequest") {
          if (!current) continue;
          const callId = readString(block, "id");
          const call = toolCallOf(block);
          const capped = capEventText(call.input, EVENT_CAPS.input);
          pushEvent(
            {
              turnIdx: current.idx,
              kind: "tool",
              name: call.name,
              input: capped.text,
              output: "",
              truncated: capped.truncated,
            },
            callId,
          );
          continue;
        }
        if (kind === "toolResponse") {
          if (!current) continue;
          const callId = readString(block, "id");
          const result = toolResultOf(block);
          const capped = capEventText(result.output, EVENT_CAPS.output);
          const existing = callId ? calls.get(callId) : undefined;
          if (existing) {
            existing.output = capped.text;
            existing.meta = result.status;
            existing.truncated = existing.truncated || capped.truncated;
            continue;
          }
          pushEvent(
            {
              turnIdx: current.idx,
              kind: "tool",
              name: "tool",
              input: "",
              output: capped.text,
              meta: result.status,
              truncated: capped.truncated,
            },
            callId,
          );
        }
      }

      const body = text.join("\n");
      if (role === "user") {
        if (!body.trim()) continue;
        current = {
          idx: turns.length,
          ts,
          userText: body,
          assistantText: "",
          model: model || undefined,
        };
        turns.push(current);
        calls.clear();
        eventSeq = 0;
        continue;
      }
      if (!current || !body.trim()) continue;
      current.assistantText += current.assistantText ? `\n\n${body}` : body;
      if (model && !current.model) current.model = model;
    }

    if (turns.length === 0) return null;

    const ordered = orderConversation(turns, events);
    const createdAt = toMillis(session.created_at);
    const updatedAt = toMillis(session.updated_at);
    // A version without created_timestamp on messages falls back to the session
    // stamp so turns never land on 1970.
    const turnTime = (ts: number): number => ts || createdAt || lastMessageTs;
    const capped = ordered.turns.map((turn) => {
      const user = capText(turn.userText);
      const assistant = capText(turn.assistantText);
      return {
        idx: turn.idx,
        ts: turnTime(turn.ts),
        userText: user.text,
        assistantText: assistant.text,
        model: turn.model,
        truncated: user.truncated || assistant.truncated,
      };
    });

    const startedAt = createdAt || capped[0]?.ts || lastMessageTs;
    const workingDir = typeof session.working_dir === "string" ? session.working_dir : "";
    const parentId =
      typeof session.parent_session_id === "string" ? session.parent_session_id : "";

    return {
      agent: "goose",
      externalId: ref.externalId,
      parentId: parentId || undefined,
      projectPath: workingDir,
      title: cleanTitle(
        typeof session.name === "string" ? session.name : "",
        cleanTitle(
          typeof session.description === "string" ? session.description : "",
          firstLine(capped[0]?.userText ?? ""),
        ),
      ),
      startedAt,
      updatedAt: updatedAt || lastMessageTs || startedAt,
      sourceKind: "sqlite",
      sourcePath: ref.sourcePath,
      fingerprint: ref.fingerprint,
      turns: capped,
      events: ordered.events,
    };
  }

  return {
    id: "goose",
    label: "Goose",
    version: 1,
    list,
    load,
    close(): void {
      db?.close();
      db = null;
      shape = null;
    },
  };
}
