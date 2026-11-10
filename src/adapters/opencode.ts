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
  readArray,
  readNumber,
  readString,
} from "../util/values.ts";
import type {
  Adapter,
  ParsedEvent,
  ParsedSession,
  ParsedTurn,
  SessionRef,
} from "./types.ts";

const DB_PATH = join(HOME, ".local", "share", "opencode", "opencode.db");

interface SessionRow {
  id: string;
  directory: string;
  title: string | null;
  time_created: number;
  time_updated: number;
  parent_id: string | null;
}

function toolOutput(state: Record<string, unknown> | null): string {
  if (!state) return "";
  const output = readString(state, "output");
  if (output) return output;
  const content = readArray(state, "content");
  const parts: string[] = [];
  for (const part of content) {
    const block = objectValue(part);
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function pushToolEvent(
  events: ParsedEvent[],
  turnIdx: number,
  seq: number,
  part: Record<string, unknown>,
): boolean {
  const state = objectValue(part.state);
  const name = readString(part, "name") || readString(part, "tool") || "tool";
  const cappedInput = capEventText(jsonText(state?.input), EVENT_CAPS.input);
  const cappedOutput = capEventText(toolOutput(state), EVENT_CAPS.output);
  if (!cappedInput.text && !cappedOutput.text) return false;
  const status = state ? readString(state, "status") : "";
  events.push({
    turnIdx,
    seq,
    kind: "tool",
    name,
    input: cappedInput.text,
    output: cappedOutput.text,
    meta: status,
    truncated: cappedInput.truncated || cappedOutput.truncated,
  });
  return true;
}

function buildTurns(
  messages: { role: string; text: string; ts: number; model?: string }[],
): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = {
        idx: turns.length,
        ts: message.ts,
        userText: message.text,
        assistantText: "",
      };
      turns.push(current);
    } else if (message.role === "assistant" && current) {
      current.assistantText += current.assistantText
        ? `\n\n${message.text}`
        : message.text;
      if (message.model && !current.model) current.model = message.model;
    }
  }
  return turns.filter((turn) => turn.userText.trim() || turn.assistantText.trim());
}

export function openCodeAdapter(): Adapter {
  let db: Database | null = null;
  let mode: "v2" | "v1" = "v2";

  function open(): Database | null {
    if (db) return db;
    if (!existsSync(DB_PATH)) return null;
    db = new Database(DB_PATH, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const v2 = db
      .query("SELECT count(*) AS n FROM session_v2")
      .get() as { n: number } | null;
    mode = v2 && v2.n > 0 ? "v2" : "v1";
    return db;
  }

  function sessionRow(id: string): SessionRow | null {
    if (!db) return null;
    const table = mode === "v2" ? "session_v2" : "session";
    return (
      (db
        .query(
          `SELECT id, directory, title, time_created, time_updated, parent_id
           FROM ${table} WHERE id = ?`,
        )
        .get(id) as SessionRow | null) ?? null
    );
  }

  function v2Parse(id: string): { turns: ParsedTurn[]; events: ParsedEvent[] } {
    if (!db) return { turns: [], events: [] };
    const rows = db
      .query(
        `SELECT type, seq, time_created, data FROM session_message
         WHERE session_id = ? ORDER BY seq`,
      )
      .all(id) as { type: string; seq: number; time_created: number; data: string }[];

    const messages: { role: string; text: string; ts: number; model?: string }[] = [];
    const events: ParsedEvent[] = [];
    let turnIdx = -1;
    let eventSeq = 0;

    for (const row of rows) {
      const data = objectValue(parseJson(row.data));
      if (!data) continue;
      const time = objectValue(data.time);
      const ts = (time ? readNumber(time, "created") : 0) || row.time_created;
      if (row.type === "user") {
        const text = readString(data, "text");
        if (!text.trim()) continue;
        turnIdx++;
        eventSeq = 0;
        messages.push({ role: "user", text, ts });
        continue;
      }
      if (row.type !== "assistant") continue;

      const textParts: string[] = [];
      for (const part of readArray(data, "content")) {
        const block = objectValue(part);
        if (!block) continue;
        const kind = readString(block, "type");
        if (kind === "text") {
          const text = readString(block, "text");
          if (text) textParts.push(text);
          continue;
        }
        if (turnIdx < 0) continue;
        if (kind === "reasoning") {
          const raw = readString(block, "text");
          if (!raw.trim()) continue;
          const capped = capEventText(raw, EVENT_CAPS.reasoning);
          events.push({
            turnIdx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
        } else if (kind === "tool") {
          if (pushToolEvent(events, turnIdx, eventSeq, block)) eventSeq++;
        }
      }

      const text = textParts.join("\n\n");
      if (!text.trim() || turnIdx < 0) continue;
      const model = objectValue(data.model);
      messages.push({
        role: "assistant",
        text,
        ts,
        model: model ? readString(model, "id") : undefined,
      });
    }
    return { turns: buildTurns(messages), events };
  }

  function v1Parse(id: string): { turns: ParsedTurn[]; events: ParsedEvent[] } {
    if (!db) return { turns: [], events: [] };
    const rows = db
      .query(
        `SELECT m.id AS mid, m.time_created AS mtime,
                json_extract(m.data, '$.role') AS role,
                json_extract(m.data, '$.modelID') AS model,
                p.data AS part
         FROM message m
         LEFT JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?
         ORDER BY m.time_created, m.id, p.time_created, p.id`,
      )
      .all(id) as {
      mid: string;
      mtime: number;
      role: string;
      model: string | null;
      part: string | null;
    }[];

    const byMessage = new Map<
      string,
      {
        role: string;
        ts: number;
        model?: string;
        parts: Record<string, unknown>[];
      }
    >();
    for (const row of rows) {
      let entry = byMessage.get(row.mid);
      if (!entry) {
        entry = {
          role: row.role,
          ts: row.mtime,
          model: row.model ?? undefined,
          parts: [],
        };
        byMessage.set(row.mid, entry);
      }
      if (!row.part) continue;
      const part = objectValue(parseJson(row.part));
      if (part) entry.parts.push(part);
    }

    const messages: { role: string; text: string; ts: number; model?: string }[] = [];
    const events: ParsedEvent[] = [];
    let turnIdx = -1;
    let eventSeq = 0;

    for (const entry of byMessage.values()) {
      if (entry.role === "user") {
        const text = entry.parts
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n\n");
        if (!text.trim()) continue;
        turnIdx++;
        eventSeq = 0;
        messages.push({ role: "user", text, ts: entry.ts });
        continue;
      }
      if (entry.role !== "assistant" || turnIdx < 0) continue;

      const textParts: string[] = [];
      for (const part of entry.parts) {
        const kind = readString(part, "type");
        if (kind === "text") {
          const text = readString(part, "text");
          if (text) textParts.push(text);
        } else if (kind === "reasoning") {
          const raw = readString(part, "text");
          if (!raw.trim()) continue;
          const capped = capEventText(raw, EVENT_CAPS.reasoning);
          events.push({
            turnIdx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
        } else if (kind === "tool") {
          if (pushToolEvent(events, turnIdx, eventSeq, part)) eventSeq++;
        }
      }
      const text = textParts.join("\n\n");
      if (text.trim()) {
        messages.push({
          role: "assistant",
          text,
          ts: entry.ts,
          model: entry.model,
        });
      }
    }
    return { turns: buildTurns(messages), events };
  }

  return {
    id: "opencode",
    label: "OpenCode",
    version: 2,

    async list(): Promise<SessionRef[]> {
      const opened = open();
      if (!opened) return [];
      const table = mode === "v2" ? "session_v2" : "session";
      const rows = opened
        .query(`SELECT id, time_updated FROM ${table}`)
        .all() as { id: string; time_updated: number }[];
      return rows.map((row) => ({
        agent: "opencode",
        externalId: row.id,
        fingerprint: `${mode}:${row.time_updated}`,
        sourcePath: DB_PATH,
      }));
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const opened = open();
      if (!opened) return null;
      const session = sessionRow(ref.externalId);
      if (!session) return null;
      const parsed =
        mode === "v2"
          ? v2Parse(ref.externalId)
          : v1Parse(ref.externalId);
      const turns = parsed.turns;
      if (turns.length === 0) return null;

      const capped = turns.map((turn, index) => {
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

      return {
        agent: "opencode",
        externalId: ref.externalId,
        parentId: session.parent_id ?? undefined,
        projectPath: session.directory,
        title: cleanTitle(session.title ?? "", firstLine(capped[0].userText)),
        startedAt: session.time_created,
        updatedAt: session.time_updated,
        sourceKind: "sqlite",
        sourcePath: DB_PATH,
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
