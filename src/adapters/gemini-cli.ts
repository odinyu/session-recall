import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOME } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import { walkFiles } from "../util/fs.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
  parseJson,
  readArray,
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
 * Gemini CLI records one chat file per session under a per-project temporary
 * directory: `<root>/<project>/chats/session-<timestamp>-<shortId>.jsonl`, where
 * root defaults to `~/.gemini/tmp` (override with `GEMINI_DATA_DIR`). Older
 * versions wrote the same conversation as a single `.json` document, so both
 * extensions are read.
 *
 * File shapes:
 * - `.json`   one document `{sessionId, projectHash, startTime, lastUpdated,
 *             messages: MessageRecord[]}`.
 * - `.jsonl`  append-only records: one metadata line carrying
 *             `sessionId`/`projectHash`/`startTime`/`lastUpdated`, then one
 *             `MessageRecord` per message (`{id, timestamp, type, content}`),
 *             plus edit records (`$patch`, `$set`, `$rewindTo`).
 *
 * A `MessageRecord` is `{id, timestamp, type, content}` where `content` is a
 * string or a list of Gemini parts. Types this adapter keeps:
 * - `user`         the prompt that starts a turn
 * - `gemini`       the answer; also carries `model`, `tokens`, `thoughts[]` and
 *                  `toolCalls[]` (`{id, name, args, result, status}`)
 *
 * Deliberately ignored:
 * - `info` / `error` / `warning` records — interactive notices, not dialogue.
 * - `$patch` / `$set` / `$rewindTo` records — they edit earlier content or
 *   rewrite metadata; the appended message stream already carries the prompt
 *   and answer text a turn needs.
 * - `summary` — the context-compaction summary, not a session title.
 * - Non-text parts (`inlineData`, `fileData`) — attachments, already absent
 *   from the searchable text of every other adapter.
 * - Subagent transcripts (`chats/<parentSessionId>/*.jsonl`) — a second
 *   conversation nested under the same project.
 *
 * Both shapes are indexed with `sourceKind: "jsonl"`, the only file-backed kind
 * the index defines; the extension is still visible in `sourcePath`.
 *
 * projectPath comes from the `.project_root` marker Gemini CLI writes next to
 * the `chats` directory (the registry `~/.gemini/projects.json` is the fallback
 * when the marker is missing); when neither exists the project directory name
 * is used as-is. There is no recorded session title, so the first prompt names
 * the session.
 */

const DEFAULT_ROOT = process.env.GEMINI_DATA_DIR?.trim() || join(HOME, ".gemini", "tmp");
const PROJECT_ROOT_MARKER = ".project_root";

function isChatFile(path: string): boolean {
  // Main chats live directly in a `chats` directory; the `chats/<parent>/`
  // nesting is reserved for subagent transcripts.
  return (
    (path.endsWith(".json") || path.endsWith(".jsonl")) &&
    basename(dirname(path)) === "chats"
  );
}

/** Concatenate the text parts of a Gemini `PartListUnion` (string or parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of Array.isArray(content) ? content : []) {
    const block = objectValue(part);
    if (!block) continue;
    const text = readString(block, "text");
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/** The absolute project root recorded for a `chats` directory. */
function projectPathOf(file: string, root: string): string {
  const projectDir = dirname(dirname(file));
  try {
    const marker = readFileSync(join(projectDir, PROJECT_ROOT_MARKER), "utf8").trim();
    if (marker) return marker;
  } catch {
    // No marker: fall through to the registry and then to the directory name.
  }
  // Newer releases store a short slug per project in `~/.gemini/projects.json`
  // (`{"projects": {"/abs/path": "slug"}}`); the chats directory is the slug.
  try {
    const registry = objectValue(
      parseJson(readFileSync(join(root, "..", "projects.json"), "utf8")),
    );
    const projects = objectValue(registry?.projects);
    const slug = basename(projectDir);
    for (const [path, value] of Object.entries(projects ?? {})) {
      if (value === slug) return path;
    }
  } catch {
    // No registry file: the path segment is the best answer available.
  }
  return basename(projectDir);
}

/** Collect `MessageRecord` objects from either file shape, in file order. */
function readMessages(text: string, jsonl: boolean): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (!jsonl) {
    const document = objectValue(parseJson(text));
    for (const entry of readArray(document ?? {}, "messages")) {
      const message = objectValue(entry);
      if (message) messages.push(message);
    }
    return messages;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = objectValue(parseJson(line));
    if (!record) continue;
    // `$patch` / `$set` / `$rewindTo` records have no `type` field.
    for (const entry of readArray(record, "messages")) {
      const message = objectValue(entry);
      if (message) messages.push(message);
    }
    if (readString(record, "type")) messages.push(record);
  }
  return messages;
}

export function geminiCliAdapter(dir: string = DEFAULT_ROOT): Adapter {
  return {
    id: "gemini-cli",
    label: "Gemini CLI",
    version: 1,

    async list(): Promise<SessionRef[]> {
      const files = walkFiles(dir, (name) => name.endsWith(".json") || name.endsWith(".jsonl"));
      return files.filter((file) => isChatFile(file.path)).map((file) => ({
        agent: "gemini-cli",
        // The filename stem is stable and unique per chats directory; the
        // recorded `sessionId` (Gemini's prompt id) is not part of the path.
        externalId: basename(file.path).replace(/\.jsonl?$/, ""),
        fingerprint: `${file.size}:${file.mtimeMs}`,
        sourcePath: file.path,
      }));
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const text = await Bun.file(ref.sourcePath).text();
      const jsonl = ref.sourcePath.endsWith(".jsonl");
      let fallbackTime = 0;
      if (!jsonl) {
        const document = objectValue(parseJson(text));
        if (document) {
          fallbackTime =
            Date.parse(readString(document, "startTime")) ||
            Date.parse(readString(document, "lastUpdated")) ||
            0;
        }
      }

      const turns: ParsedTurn[] = [];
      const events: ParsedEvent[] = [];
      let current: ParsedTurn | null = null;
      let eventSeq = 0;
      let startedAt = 0;
      let updatedAt = 0;

      for (const message of readMessages(text, jsonl)) {
        const ts = Date.parse(readString(message, "timestamp")) || 0;
        if (ts > 0) {
          if (!startedAt || ts < startedAt) startedAt = ts;
          if (ts > updatedAt) updatedAt = ts;
        }

        const type = readString(message, "type");
        if (type === "user") {
          const prompt = textOf(message.content);
          if (!prompt.trim()) continue;
          current = { idx: turns.length, ts, userText: prompt, assistantText: "" };
          turns.push(current);
          eventSeq = 0;
          continue;
        }
        if (type !== "gemini" || !current) continue;

        const model = readString(message, "model");
        if (model && !current.model) current.model = model;

        const body = textOf(message.content);
        if (body.trim()) {
          current.assistantText += current.assistantText ? `\n\n${body}` : body;
        }

        for (const entry of readArray(message, "thoughts")) {
          const thought = objectValue(entry);
          if (!thought) continue;
          const summary = [readString(thought, "subject"), readString(thought, "description")]
            .filter((part) => part.trim())
            .join("\n");
          if (!summary.trim()) continue;
          const capped = capEventText(summary, EVENT_CAPS.reasoning);
          events.push({
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
        }

        for (const entry of readArray(message, "toolCalls")) {
          const call = objectValue(entry);
          if (!call) continue;
          const input = capEventText(jsonText(call.args), EVENT_CAPS.input);
          const rawResult = call.result;
          const output = capEventText(
            typeof rawResult === "string" ? rawResult : textOf(rawResult) || jsonText(rawResult),
            EVENT_CAPS.output,
          );
          events.push({
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "tool",
            name: readString(call, "name") || "tool",
            input: input.text,
            output: output.text,
            meta: `${readString(call, "id")}|${readString(call, "status") || "done"}`,
            truncated: input.truncated || output.truncated,
          });
        }
      }

      if (turns.length === 0) return null;

      const fileTime = Bun.file(ref.sourcePath).lastModified || Date.now();
      const started = startedAt || fallbackTime || turns[0]?.ts || fileTime;
      const updated = updatedAt || fallbackTime || started;

      for (const turn of turns) {
        if (!turn.ts) turn.ts = started;
      }
      // Timestamps are already in file order in both shapes; this makes the
      // contract explicit and keeps equal timestamps in file order.
      const ordered = turns
        .map((turn, order) => ({ turn, order }))
        .sort((a, b) => a.turn.ts - b.turn.ts || a.order - b.order)
        .map(({ turn }) => turn);

      const capped = ordered.map((turn, index) => {
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
        agent: "gemini-cli",
        externalId: ref.externalId,
        projectPath: projectPathOf(ref.sourcePath, dir),
        title: cleanTitle("", firstLine(capped[0]?.userText ?? "")),
        startedAt: started,
        updatedAt: updated,
        sourceKind: "jsonl",
        sourcePath: ref.sourcePath,
        fingerprint: ref.fingerprint,
        turns: capped,
        events,
      };
    },
  };
}
