import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ALMA_DB } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
  parseJson,
  readArray,
  readString,
} from "../util/values.ts";
import type { JsonObject } from "../util/values.ts";
import type {
  Adapter,
  ParsedEvent,
  ParsedSession,
  ParsedTurn,
  SessionRef,
} from "./types.ts";

/**
 * Alma keeps its threads in a single WAL database that the running app writes
 * to, so this adapter opens it `readonly` with a busy timeout — the same
 * contract the OpenCode adapter uses for its live store.
 *
 * Ordering note: Alma supports editing and regenerating messages, which leaves
 * several siblings per slot in `chat_messages` (`parent_id`/`slot_id`/`depth`).
 * We deliberately do not resolve the active branch; every message is flattened
 * into linear `(timestamp, id)` order. See README "Known limits".
 */

interface ThreadRow {
  id: string;
  title: string | null;
  model: string | null;
  created_at: string | null;
  updated_at: string | null;
  parent_thread_id: string | null;
  project_path: string | null;
}

interface ListRow {
  id: string;
  updated_at: string | null;
  message_count: number;
  message_updated: string | null;
}

interface MessageRow {
  id: string;
  message: string;
  timestamp: string | null;
}

/** Alma stores `providerId:modelId`; the other adapters index the model id. */
function modelId(value: string): string {
  const separator = value.indexOf(":");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function timeOf(value: string | null): number {
  return Date.parse(value ?? "") || 0;
}

/** `output` is an object ({stdout, stderr, exitCode…}), never a string. */
function outputText(part: JsonObject): string {
  const output = part.output;
  if (output === undefined || output === null) return "";
  return jsonText(output);
}

/** `input` is absent on a part that errored before it ran; `rawInput` survives. */
function inputText(part: JsonObject): string {
  const input = part.input ?? part.rawInput;
  if (input === undefined || input === null) return "";
  return jsonText(input);
}

/** `approvalDecision` is usually `{action, decidedAt}`, but tolerate a bare string. */
function approvalAction(part: JsonObject): string {
  const decision = part.approvalDecision;
  if (typeof decision === "string") return decision;
  const record = objectValue(decision);
  return record ? readString(record, "action") : "";
}

function isDenied(action: string): boolean {
  return /deny|denied|reject/i.test(action);
}

/**
 * Short status shown next to a tool row. A denied call reports `denied`
 * regardless of how far the part got; an unfinished part keeps its raw state
 * (`input-available`, `input-streaming`) rather than pretending it produced
 * output.
 */
function toolStatus(part: JsonObject): string {
  if (isDenied(approvalAction(part))) return "denied";
  const state = readString(part, "state");
  if (state === "output-available") return "ok";
  if (state === "output-error") return "error";
  return state;
}

function toolEvent(part: JsonObject, turnIdx: number, seq: number): ParsedEvent {
  const type = readString(part, "type");
  const name = type.slice("tool-".length) || "tool";
  const cappedInput = capEventText(inputText(part), EVENT_CAPS.input);
  const cappedOutput = capEventText(outputText(part), EVENT_CAPS.output);
  return {
    turnIdx,
    seq,
    kind: "tool",
    name,
    input: cappedInput.text,
    output: cappedOutput.text,
    meta: toolStatus(part),
    truncated: cappedInput.truncated || cappedOutput.truncated,
  };
}

function textParts(parts: unknown[]): string {
  const out: string[] = [];
  for (const raw of parts) {
    const part = objectValue(raw);
    if (part && part.type === "text") {
      const text = readString(part, "text");
      if (text) out.push(text);
    }
  }
  return out.join("\n\n");
}

export function almaAdapter(dbPath: string = ALMA_DB): Adapter {
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

  function threadRow(id: string): ThreadRow | null {
    if (!db) return null;
    return (
      (db
        .query(
          `SELECT t.id, t.title, t.model, t.created_at, t.updated_at,
                  t.parent_thread_id, w.path AS project_path
           FROM chat_threads t
           LEFT JOIN workspaces w ON w.id = t.workspace_id
           WHERE t.id = ? AND t.is_incognito = 0`,
        )
        .get(id) as ThreadRow | null) ?? null
    );
  }

  function parse(id: string, model: string): {
    turns: ParsedTurn[];
    events: ParsedEvent[];
    lastMessageTs: number;
  } {
    if (!db) return { turns: [], events: [], lastMessageTs: 0 };
    const rows = db
      .query(
        `SELECT id, message, timestamp FROM chat_messages
         WHERE thread_id = ? ORDER BY timestamp, id`,
      )
      .all(id) as MessageRow[];

    const turns: ParsedTurn[] = [];
    const events: ParsedEvent[] = [];
    let current: ParsedTurn | null = null;
    let eventSeq = 0;
    let lastMessageTs = 0;

    for (const row of rows) {
      const ts = timeOf(row.timestamp);
      if (ts > lastMessageTs) lastMessageTs = ts;
      const message = objectValue(parseJson(row.message));
      if (!message) continue;
      const role = readString(message, "role");
      const parts = readArray(message, "parts");

      if (role === "user") {
        const body = textParts(parts);
        if (!body.trim()) continue;
        current = {
          idx: turns.length,
          ts,
          userText: body,
          assistantText: "",
          model: model || undefined,
        };
        turns.push(current);
        eventSeq = 0;
        continue;
      }
      if (role !== "assistant" || !current) continue;

      const text: string[] = [];
      for (const raw of parts) {
        const part = objectValue(raw);
        if (!part) continue;
        const type = readString(part, "type");
        if (type === "text") {
          const value = readString(part, "text");
          if (value) text.push(value);
          continue;
        }
        if (type === "reasoning") {
          const value = readString(part, "text");
          if (!value.trim()) continue;
          const capped = capEventText(value, EVENT_CAPS.reasoning);
          events.push({
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
          continue;
        }
        if (type.startsWith("tool-")) {
          events.push(toolEvent(part, current.idx, eventSeq++));
        }
      }

      const body = text.join("\n\n");
      if (body.trim()) {
        current.assistantText += current.assistantText
          ? `\n\n${body}`
          : body;
      }
    }

    return { turns, events, lastMessageTs };
  }

  return {
    id: "alma",
    label: "Alma",
    version: 1,

    async list(): Promise<SessionRef[]> {
      const opened = open();
      if (!opened) return [];
      // `updated_at` alone misses an edit that rewrites a message in place, so
      // the fingerprint also carries the message count and newest message stamp.
      const rows = opened
        .query(
          `SELECT t.id, t.updated_at,
                  count(m.id) AS message_count,
                  COALESCE(max(m.updated_at), '') AS message_updated
           FROM chat_threads t
           LEFT JOIN chat_messages m ON m.thread_id = t.id
           WHERE t.is_incognito = 0
           GROUP BY t.id`,
        )
        .all() as ListRow[];
      return rows.map((row) => ({
        agent: "alma",
        externalId: row.id,
        fingerprint: `${row.updated_at ?? ""}:${row.message_count}:${row.message_updated ?? ""}`,
        sourcePath: dbPath,
      }));
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const opened = open();
      if (!opened) return null;
      const thread = threadRow(ref.externalId);
      if (!thread) return null;

      const model = thread.model ? modelId(thread.model) : "";
      const parsed = parse(ref.externalId, model);
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

      const createdAt = timeOf(thread.created_at);
      const updatedAt = timeOf(thread.updated_at);
      const startedAt = createdAt || capped[0]?.ts || parsed.lastMessageTs;

      return {
        agent: "alma",
        externalId: ref.externalId,
        parentId: thread.parent_thread_id ?? undefined,
        projectPath: thread.project_path ?? "",
        title: cleanTitle(thread.title ?? "", firstLine(capped[0]?.userText ?? "")),
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
