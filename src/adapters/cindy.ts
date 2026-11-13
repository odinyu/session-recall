import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { cindyDbPath } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
  parseJson,
  readString,
  titlePrompt,
} from "../util/values.ts";
import type {
  Adapter,
  ParsedEvent,
  ParsedSession,
  ParsedTurn,
  SessionRef,
} from "./types.ts";

/**
 * Cindy is a desktop host, not a CLI agent: it keeps every session in one
 * SQLite file (`sessions` + `messages`) under `CindyGlobal`, which the running
 * app holds open in WAL mode. Open it `readonly` with a busy timeout, like the
 * Alma and OpenCode adapters do for their live stores.
 *
 * `messages.content` is role-dependent:
 *   user       JSON `{text, images, files, slashCommandRanges}` (plain text on
 *              older rows)
 *   assistant  plain markdown text
 *   thinking   JSON `{kind, text, ...}`
 *   tool_use   JSON `{toolUseId, toolName, input}`
 *   tool_result plain tool output, paired with the oldest unanswered tool_use
 *   ask_user   JSON `{requestId, questions, status, answers}`
 *
 * `rewind_at` marks messages hidden by an edit/rewind; `sessions.cleared_at`
 * hides everything older than it. Both filters mirror what the Cindy UI shows.
 */

interface SessionRow {
  id: string;
  title: string;
  working_dir: string | null;
  model: string;
  created_at: number;
  updated_at: number;
  cleared_at: number | null;
  parent_session_id: string | null;
}

interface ListRow {
  id: string;
  updated_at: number;
  cleared_at: number | null;
  message_count: number;
  message_created: number;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

/** Cindy's placeholder title for an untouched session. */
const DEFAULT_TITLE = "New CCS";

function isPlaceholderTitle(title: string): boolean {
  return !title.trim() || title.trim() === DEFAULT_TITLE;
}

function timeOf(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** User and reasoning rows wrap their text in JSON; older rows are raw. */
function jsonTextOf(content: string, key: string): string {
  const parsed = objectValue(parseJson(content));
  if (!parsed) return content;
  return readString(parsed, key) || readString(parsed, "text");
}

/**
 * Normal user rows carry `text`. Orca worker rows carry the lead's task as
 * `{"orcaSource":"lead","content":"..."}`, so read that as the prompt too;
 * otherwise a worker whose only prompts came from Orca parses to zero turns
 * and is dropped from the index.
 */
function userText(content: string): string {
  const parsed = objectValue(parseJson(content));
  if (!parsed) return content;
  return readString(parsed, "text") || readString(parsed, "content");
}

function toolEvent(
  content: string,
  turnIdx: number,
  seq: number,
): ParsedEvent | null {
  const parsed = objectValue(parseJson(content));
  if (!parsed) return null;
  const input = parsed.input ?? parsed.arguments ?? "";
  const capped = capEventText(jsonText(input), EVENT_CAPS.input);
  return {
    turnIdx,
    seq,
    kind: "tool",
    name: readString(parsed, "toolName") || "tool",
    input: capped.text,
    output: "",
    meta: readString(parsed, "toolUseId"),
    truncated: capped.truncated,
  };
}

function askUserEvent(
  content: string,
  turnIdx: number,
  seq: number,
): ParsedEvent | null {
  const parsed = objectValue(parseJson(content));
  if (!parsed) return null;
  const questions = parsed.questions ?? parsed;
  const capped = capEventText(jsonText(questions), EVENT_CAPS.input);
  return {
    turnIdx,
    seq,
    kind: "tool",
    name: "ask_user",
    input: capped.text,
    output: "",
    meta: readString(parsed, "status"),
    truncated: capped.truncated,
  };
}

export function cindyAdapter(dbPath: string = cindyDbPath()): Adapter {
  let db: Database | null = null;

  function open(): Database | null {
    if (db) return db;
    if (!existsSync(dbPath)) return null;
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

  function sessionRow(id: string): SessionRow | null {
    if (!db) return null;
    return (
      (db
        .query(
          `SELECT id, title, working_dir, model, created_at, updated_at,
                  cleared_at, parent_session_id
           FROM sessions WHERE id = ?`,
        )
        .get(id) as SessionRow | null) ?? null
    );
  }

  function parse(
    session: SessionRow,
  ): { turns: ParsedTurn[]; events: ParsedEvent[]; lastMessageTs: number } {
    if (!db) return { turns: [], events: [], lastMessageTs: 0 };
    const rows = db
      .query(
        `SELECT id, role, content, created_at FROM messages
         WHERE session_id = ? AND rewind_at IS NULL
           AND (? IS NULL OR created_at > ?)
         ORDER BY created_at, id`,
      )
      .all(session.id, session.cleared_at, session.cleared_at) as MessageRow[];

    const turns: ParsedTurn[] = [];
    const events: ParsedEvent[] = [];
    /** Unanswered tool_use events; tool_result rows arrive in call order. */
    const pending: ParsedEvent[] = [];
    let current: ParsedTurn | null = null;
    let eventSeq = 0;
    let lastMessageTs = 0;

    for (const row of rows) {
      const ts = timeOf(row.created_at);
      if (ts > lastMessageTs) lastMessageTs = ts;

      if (row.role === "user") {
        const body = userText(row.content);
        if (!body.trim()) continue;
        current = {
          idx: turns.length,
          ts,
          userText: body,
          assistantText: "",
          model: session.model || undefined,
        };
        turns.push(current);
        eventSeq = 0;
        continue;
      }
      if (!current) continue;

      switch (row.role) {
        case "assistant": {
          if (row.content.trim()) {
            current.assistantText += current.assistantText
              ? `\n\n${row.content}`
              : row.content;
          }
          break;
        }
        case "thinking": {
          const raw = jsonTextOf(row.content, "text");
          if (!raw.trim()) break;
          const capped = capEventText(raw, EVENT_CAPS.reasoning);
          events.push({
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
          break;
        }
        case "tool_use": {
          const event = toolEvent(row.content, current.idx, eventSeq++);
          if (!event) break;
          events.push(event);
          pending.push(event);
          break;
        }
        case "tool_result": {
          const target = pending.shift();
          if (target) {
            const capped = capEventText(row.content, EVENT_CAPS.output);
            target.output = capped.text;
            target.truncated = target.truncated || capped.truncated;
          } else if (row.content.trim()) {
            const capped = capEventText(row.content, EVENT_CAPS.output);
            events.push({
              turnIdx: current.idx,
              seq: eventSeq++,
              kind: "tool",
              name: "tool_result",
              input: "",
              output: capped.text,
              truncated: capped.truncated,
            });
          }
          break;
        }
        case "ask_user": {
          const event = askUserEvent(row.content, current.idx, eventSeq++);
          if (event) events.push(event);
          break;
        }
        default:
          // `error` rows are UI banners; nothing to index.
          break;
      }
    }

    return { turns, events, lastMessageTs };
  }

  return {
    id: "cindy",
    label: "Cindy",
    version: 3,

    async list(): Promise<SessionRef[]> {
      const opened = open();
      if (!opened) return [];
      const rows = opened
        .query(
          `SELECT s.id, s.updated_at, s.cleared_at,
                  count(m.id) AS message_count,
                  COALESCE(max(m.created_at), 0) AS message_created
           FROM sessions s
           LEFT JOIN messages m ON m.session_id = s.id
             AND m.rewind_at IS NULL
             AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
           GROUP BY s.id
           HAVING count(m.id) > 0`,
        )
        .all() as ListRow[];
      return rows.map((row) => ({
        agent: "cindy",
        externalId: row.id,
        fingerprint: `${row.updated_at}:${row.message_count}:${row.message_created}:${row.cleared_at ?? 0}`,
        sourcePath: dbPath,
      }));
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const opened = open();
      if (!opened) return null;
      const session = sessionRow(ref.externalId);
      if (!session) return null;

      const parsed = parse(session);
      if (parsed.turns.length === 0) return null;

      const capped = parsed.turns.map((turn, index) => {
        const user = capText(turn.userText);
        const assistant = capText(turn.assistantText);
        return {
          idx: index,
          ts: turn.ts,
          userText: user.text,
          assistantText: assistant.text,
          model: turn.model,
          truncated: user.truncated || assistant.truncated,
        };
      });

      const createdAt = timeOf(session.created_at);
      const updatedAt = timeOf(session.updated_at);
      const startedAt = createdAt || capped[0]?.ts || parsed.lastMessageTs;

      return {
        agent: "cindy",
        externalId: ref.externalId,
        parentId: session.parent_session_id ?? undefined,
        projectPath: session.working_dir ?? "",
        title: cleanTitle(
          isPlaceholderTitle(session.title) ? "" : session.title,
          firstLine(titlePrompt(capped)),
        ),
        startedAt,
        updatedAt: updatedAt || parsed.lastMessageTs || startedAt,
        sourceKind: "sqlite",
        sourcePath: dbPath,
        fingerprint: ref.fingerprint,
        turns: capped,
        events: parsed.events,
      };
    },

    close(): void {
      db?.close();
      db = null;
    },
  };
}
