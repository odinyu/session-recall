import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import { walkFiles } from "../util/fs.ts";
import type { WalkedFile } from "../util/fs.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
  parseJson,
  readArray,
  readNumber,
  readString,
} from "../util/values.ts";
import type { Adapter, ParsedEvent, ParsedSession, ParsedTurn, SessionRef } from "./types.ts";

const CURSOR_DIR = process.env.CURSOR_CONFIG_DIR ?? join(HOME, ".cursor");
const PROJECTS_DIR = join(CURSOR_DIR, "projects");
const STATE_DB = join(
  HOME,
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);

interface CursorMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  projectPath: string;
  headers: string[];
  parentId?: string;
}

interface Bubble {
  type: number;
  text: string;
  createdAt: string;
}

function blobText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function nestedUriPath(data: Record<string, unknown>): string {
  const workspace = objectValue(data.workspaceIdentifier);
  if (!workspace) return "";
  const uri = objectValue(workspace.uri);
  return uri ? readString(uri, "fsPath") : "";
}

function encodeProjectDir(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, "-");
}

function separatorVariants(segment: string): string[] {
  const parts = segment.split("-");
  if (parts.length <= 1) return [segment];
  const out = new Set<string>();
  const combinations = 1 << (parts.length - 1);
  for (let mask = 0; mask < combinations; mask++) {
    let name = parts[0];
    for (let index = 1; index < parts.length; index++) {
      name += `${(mask >> (index - 1)) & 1 ? "_" : "-"}${parts[index]}`;
    }
    out.add(name);
  }
  return [...out];
}

/**
 * Cursor stores a project as its absolute path with "/" (and often "_")
 * replaced by "-", which is ambiguous for names containing hyphens. Resolve
 * greedily against the filesystem, longest segment first; unknown paths stay
 * unresolved.
 */
function resolveEncodedProject(encoded: string): string {
  const prefix = "Users-odin-";
  if (!encoded.startsWith(prefix)) return "";
  const segments = encoded.slice(prefix.length).split("-").filter(Boolean);
  let current = join(HOME);
  let index = 0;
  while (index < segments.length) {
    let matched = false;
    for (let end = segments.length; end > index; end--) {
      const joined = segments.slice(index, end).join("-");
      for (const variant of separatorVariants(joined)) {
        const candidate = join(current, variant);
        if (existsSync(candidate)) {
          current = candidate;
          index = end;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) return "";
  }
  return current;
}

function extractUserText(text: string): string {
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  if (query) return query[1].trim();
  return text
    .replace(/<image_files>[\s\S]*?<\/image_files>/g, "")
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, "")
    .replace(/<rules>[\s\S]*?<\/rules>/g, "")
    .trim();
}

function textOfContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const part of content) {
    const block = objectValue(part);
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function buildTurns(
  messages: { role: string; text: string; ts: number }[],
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
    }
  }
  return turns.filter((turn) => turn.userText.trim() || turn.assistantText.trim());
}

/** Fill redacted transcript text with the composer's clean bubble text. */
function mergeCursorTurns(base: ParsedTurn[], supplement: ParsedTurn[]): void {
  for (let index = 0; index < Math.min(base.length, supplement.length); index++) {
    const turn = base[index];
    const extra = supplement[index];
    if (!turn || !extra) continue;
    if ((!turn.userText.trim() || turn.userText.includes("[REDACTED]")) && extra.userText.trim()) {
      turn.userText = extra.userText;
    }
    const assistant = extra.assistantText.trim();
    if (!assistant) continue;
    const redactions = turn.assistantText.match(/\[REDACTED\]/g)?.length ?? 0;
    if (!turn.assistantText.trim()) {
      turn.assistantText = extra.assistantText;
    } else if (redactions >= 3 && assistant.length >= 400) {
      // The transcript lost whole blocks to redaction; the composer text is
      // the coherent answer that remains.
      turn.assistantText = extra.assistantText;
    } else if (redactions > 0) {
      const fingerprint = assistant.slice(0, 80);
      if (!turn.assistantText.includes(fingerprint)) {
        turn.assistantText = `${turn.assistantText}\n\n${extra.assistantText}`;
      }
    }
  }
}

function scrubRedactions(text: string): string {
  return text
    .replace(/\[REDACTED\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cursorAdapter(): Adapter {
  let db: Database | null = null;
  const metas = new Map<string, CursorMeta>();
  const transcripts = new Map<string, WalkedFile>();
  const transcriptOwners = new Map<string, string>();
  const resolvedProjects = new Map<string, string>();

  function open(): Database | null {
    if (db) return db;
    if (!existsSync(STATE_DB)) return null;
    db = new Database(STATE_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 4000");
    return db;
  }

  function readMetas(): void {
    const opened = open();
    metas.clear();
    if (!opened) return;
    const rows = opened
      .query(
        "SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'",
      )
      .all() as { key: string; value: unknown }[];

    for (const row of rows) {
      const data = objectValue(parseJson(blobText(row.value)));
      if (!data) continue;
      const id = readString(data, "composerId") || row.key.slice("composerData:".length);
      const headers: string[] = [];
      for (const header of readArray(data, "fullConversationHeadersOnly")) {
        const record = objectValue(header);
        const bubbleId = record ? readString(record, "bubbleId") : "";
        if (bubbleId) headers.push(bubbleId);
      }
      if (headers.length === 0) continue;
      const subagent = objectValue(data.subagentInfo);
      metas.set(id, {
        id,
        name: readString(data, "name"),
        createdAt: readNumber(data, "createdAt"),
        updatedAt: readNumber(data, "lastUpdatedAt"),
        projectPath: nestedUriPath(data),
        headers,
        parentId: subagent ? readString(subagent, "parentAgentId") || undefined : undefined,
      });
    }
  }

  function readTranscripts(): void {
    transcripts.clear();
    transcriptOwners.clear();
    const files = walkFiles(PROJECTS_DIR, (name) => name.endsWith(".jsonl"));
    for (const file of files) {
      if (!file.path.includes("/agent-transcripts/")) continue;
      const id = basename(file.path).replace(/\.jsonl$/, "");
      if (!id) continue;
      transcripts.set(id, file);
      const afterProjects = file.path.split("/projects/")[1] ?? "";
      transcriptOwners.set(id, afterProjects.split("/")[0] ?? "");
    }
  }

  function projectForTranscript(id: string): string {
    const owner = transcriptOwners.get(id) ?? "";
    if (!owner) return "";
    for (const meta of metas.values()) {
      if (meta.projectPath && encodeProjectDir(meta.projectPath) === owner) {
        return meta.projectPath;
      }
    }
    const cached = resolvedProjects.get(owner);
    if (cached !== undefined) return cached;
    const resolved = resolveEncodedProject(owner);
    resolvedProjects.set(owner, resolved);
    return resolved;
  }

  function readTranscript(
    file: WalkedFile,
    meta: CursorMeta | undefined,
    ref: SessionRef,
  ): ParsedSession | null {
    const text = readFileText(file.path);
    if (text === null) return null;
    const messages: { role: string; text: string; ts: number }[] = [];
    const events: ParsedEvent[] = [];
    let turnIdx = -1;
    let eventSeq = 0;
    let title = "";
    for (const line of text.split("\n")) {
      if (!line) continue;
      const entry = objectValue(parseJson(line));
      if (!entry) continue;
      const role = readString(entry, "role");
      if (role !== "user" && role !== "assistant") continue;
      const message = objectValue(entry.message);
      if (!message) continue;
      const content = readArray(message, "content");
      const raw = textOfContent(content);
      if (role === "user") {
        if (!raw.trim()) continue;
        const typed = extractUserText(raw);
        if (!typed) continue;
        if (!title) title = firstLine(typed);
        turnIdx++;
        eventSeq = 0;
        messages.push({ role, text: typed, ts: 0 });
        continue;
      }

      if (turnIdx >= 0) {
        for (const part of content) {
          const block = objectValue(part);
          if (!block || block.type !== "tool_use") continue;
          const capped = capEventText(jsonText(block.input), EVENT_CAPS.input);
          events.push({
            turnIdx,
            seq: eventSeq++,
            kind: "tool",
            name: readString(block, "name") || "tool",
            input: capped.text,
            output: "",
            meta: readString(block, "id"),
            truncated: capped.truncated,
          });
        }
      }
      if (raw.trim()) messages.push({ role, text: raw, ts: 0 });
    }
    const turns = buildTurns(messages);
    if (turns.length === 0) return null;
    if (
      meta &&
      turns.some(
        (turn) =>
          turn.assistantText.includes("[REDACTED]") ||
          turn.userText.includes("[REDACTED]"),
      )
    ) {
      const supplement = kvTurns(meta);
      if (supplement.length === turns.length) mergeCursorTurns(turns, supplement);
    }
    return finish(
      ref,
      meta,
      turns,
      {
        projectPath: meta?.projectPath ?? projectForTranscript(ref.externalId),
        fallbackTime: file.mtimeMs,
        titleFrom: title,
      },
      events,
    );
  }

  function kvTurns(meta: CursorMeta): ParsedTurn[] {
    const opened = open();
    if (!opened) return [];
    const bubbles = new Map<string, Bubble>();
    const rows = opened
      .query("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?")
      .all(`bubbleId:${meta.id}:`, `bubbleId:${meta.id};`) as {
      key: string;
      value: unknown;
    }[];
    for (const row of rows) {
      const data = objectValue(parseJson(blobText(row.value)));
      if (!data) continue;
      const bubbleId = row.key.slice(`bubbleId:${meta.id}:`.length);
      bubbles.set(bubbleId, {
        type: readNumber(data, "type"),
        text: readString(data, "text"),
        createdAt: readString(data, "createdAt"),
      });
    }

    const messages: { role: string; text: string; ts: number }[] = [];
    for (const header of meta.headers) {
      const bubble = bubbles.get(header);
      if (!bubble || !bubble.text.trim()) continue;
      const role = bubble.type === 1 ? "user" : bubble.type === 2 ? "assistant" : "";
      if (!role) continue;
      messages.push({
        role,
        text: role === "user" ? extractUserText(bubble.text) : bubble.text,
        ts: Date.parse(bubble.createdAt) || 0,
      });
    }
    const turns = buildTurns(messages);
    if (turns.length === 0) return [];
    return turns;
  }

  function readKv(meta: CursorMeta, ref: SessionRef): ParsedSession | null {
    const turns = kvTurns(meta);
    if (turns.length === 0) return null;
    return finish(ref, meta, turns, {
      projectPath: meta.projectPath,
      fallbackTime: meta.updatedAt || Date.now(),
      titleFrom: "",
    });
  }

  function finish(
    ref: SessionRef,
    meta: CursorMeta | undefined,
    turns: ParsedTurn[],
    options: { projectPath: string; fallbackTime: number; titleFrom: string },
    events: ParsedEvent[] = [],
  ): ParsedSession {
    const capped = turns.map((turn, index) => {
      const user = capText(turn.userText);
      const assistant = capText(turn.assistantText);
      return {
        idx: index,
        ts: turn.ts,
        userText: scrubRedactions(user.text),
        assistantText: scrubRedactions(assistant.text),
        truncated: user.truncated || assistant.truncated,
      };
    });
    const firstTurnTs = capped.find((turn) => turn.ts > 0)?.ts ?? 0;
    return {
      agent: "cursor",
      externalId: ref.externalId,
      parentId: meta?.parentId,
      projectPath: options.projectPath,
      title: cleanTitle(
        meta?.name ?? "",
        options.titleFrom || firstLine(capped[0]?.userText ?? ""),
      ),
      startedAt: meta?.createdAt || firstTurnTs || options.fallbackTime,
      updatedAt: meta?.updatedAt || firstTurnTs || options.fallbackTime,
      sourceKind: transcripts.has(ref.externalId) ? "jsonl" : "cursor-kv",
      sourcePath: ref.sourcePath,
      fingerprint: ref.fingerprint,
      turns: capped,
      events,
    };
  }

  return {
    id: "cursor",
    label: "Cursor",
    version: 4,

    async list(): Promise<SessionRef[]> {
      readMetas();
      readTranscripts();
      const refs: SessionRef[] = [];
      const seen = new Set<string>();

      for (const [id, file] of transcripts) {
        const meta = metas.get(id);
        refs.push({
          agent: "cursor",
          externalId: id,
          fingerprint: `t:${file.size}:${file.mtimeMs}:${meta?.updatedAt ?? 0}`,
          sourcePath: file.path,
        });
        seen.add(id);
      }

      for (const meta of metas.values()) {
        if (seen.has(meta.id)) continue;
        refs.push({
          agent: "cursor",
          externalId: meta.id,
          fingerprint: `k:${meta.updatedAt}:${meta.headers.length}`,
          sourcePath: `${STATE_DB}#${meta.id}`,
        });
        seen.add(meta.id);
      }
      return refs;
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const meta = metas.get(ref.externalId);
      const transcript = transcripts.get(ref.externalId);
      if (transcript) return readTranscript(transcript, meta, ref);
      if (meta) return readKv(meta, ref);
      return null;
    },

    close(): void {
      db?.close();
      db = null;
    },
  };
}

function readFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
