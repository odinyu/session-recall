import { basename, dirname, join, relative, sep } from "node:path";
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
 * Qwen Code is a Gemini CLI fork, so it records chats in the same append-only
 * JSONL family but under its own tree:
 * `<root>/projects/<project>/chats/<sessionId>.jsonl`, with `root` defaulting
 * to `~/.qwen` (override with `QWEN_DATA_DIR`).
 *
 * Each line is one `ChatRecord`:
 * - `user`        `{uuid, parentUuid, sessionId, timestamp, cwd, type, message,
 *                   provenance?, subtype?}` with `message.parts[]` holding the
 *                   prompt text.
 * - `assistant`   `message.parts[]` with `{text}` answer chunks, `{text,
 *                   thought: true}` reasoning chunks, `{functionCall: {id,
 *                   name, args}}` tool calls, plus `model` and `usageMetadata`.
 * - `tool_result` `message.parts[].functionResponse` (`{id, response}`) paired
 *   with the call that asked for it; `toolCallResult.status` says whether it
 *   failed.
 * - `system`      bookkeeping; only `subtype: "custom_title"` is read, because
 *                   it carries the session title the CLI shows.
 *
 * `cwd` is recorded on every record, so `projectPath` is the real work
 * directory; the `projects/<project>` directory name (a sanitized cwd) is only
 * a fallback for records that omit it.
 *
 * Deliberately ignored:
 * - Records whose `provenance` is `system` or `external_agent`, and synthetic
 *   user records (`subtype` starting with `agent_`): agent bootstrap/launch
 *   text, not something the person typed.
 * - The `parentUuid` chain. Qwen Code can branch (rewind/fork); flattening in
 *   timestamp order matches what the other adapters do, and a rewind leaves the
 *   abandoned branch in the file, which is the same trade-off Alma documents.
 * - Token counts, `toolCallResult.resultDisplay` (UI-only rendering hints) and
 *   `functionResponse` payload details beyond their text.
 */

const DEFAULT_ROOT = process.env.QWEN_DATA_DIR?.trim() || join(HOME, ".qwen");

/** `projects/<project>/chats/<session>.jsonl`, exactly three segments deep. */
function isChatFile(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep);
  return (
    parts.length === 4 &&
    parts[0] === "projects" &&
    Boolean(parts[1]) &&
    parts[2] === "chats" &&
    (parts[3] ?? "").endsWith(".jsonl")
  );
}

/** Concatenate the text parts of a Gemini-style `PartListUnion`. */
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

/** The text parts of `message.parts`, split into answer text and reasoning. */
function partsOf(record: Record<string, unknown>): {
  body: string;
  thoughts: string[];
  calls: { id: string; name: string; input: string }[];
} {
  const body: string[] = [];
  const thoughts: string[] = [];
  const calls: { id: string; name: string; input: string }[] = [];
  for (const entry of readArray(objectValue(record.message) ?? {}, "parts")) {
    const part = objectValue(entry);
    if (!part) continue;
    const text = readString(part, "text");
    if (text) {
      if (part.thought === true) thoughts.push(text);
      else body.push(text);
      continue;
    }
    const call = objectValue(part.functionCall);
    if (call) {
      calls.push({
        id: readString(call, "id"),
        name: readString(call, "name") || "tool",
        input: jsonText(call.args),
      });
    }
  }
  // Records hold a whole message, so separate text parts are separate
  // paragraphs, not stream fragments.
  return { body: body.join("\n"), thoughts, calls };
}

/** The output text of a `functionResponse`, which wraps arbitrary JSON. */
function responseText(part: Record<string, unknown>): string {
  const response = objectValue(part.functionResponse)?.response;
  const text = textOf(response);
  return text || jsonText(response);
}

export function qwenCodeAdapter(dir: string = DEFAULT_ROOT): Adapter {
  return {
    id: "qwen-code",
    label: "Qwen Code",
    version: 1,

    async list(): Promise<SessionRef[]> {
      return walkFiles(dir, (name) => name.endsWith(".jsonl"))
        .filter((file) => isChatFile(dir, file.path))
        .map((file) => ({
          agent: "qwen-code",
          // Qwen Code names the file after the session id.
          externalId: basename(file.path).replace(/\.jsonl$/, ""),
          fingerprint: `${file.size}:${file.mtimeMs}`,
          sourcePath: file.path,
        }));
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const text = await Bun.file(ref.sourcePath).text();
      const turns: ParsedTurn[] = [];
      const events: ParsedEvent[] = [];
      const calls = new Map<string, ParsedEvent>();
      let current: ParsedTurn | null = null;
      let eventSeq = 0;
      let startedAt = 0;
      let updatedAt = 0;
      let title = "";
      let projectPath = "";

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const record = objectValue(parseJson(line));
        if (!record) continue;

        const ts = Date.parse(readString(record, "timestamp")) || 0;
        if (ts > 0) {
          if (!startedAt || ts < startedAt) startedAt = ts;
          if (ts > updatedAt) updatedAt = ts;
        }
        const cwd = readString(record, "cwd");
        if (cwd) projectPath = cwd;

        const type = readString(record, "type");
        const subtype = readString(record, "subtype");
        if (type === "system") {
          if (subtype === "custom_title") {
            const payload = objectValue(record.systemPayload);
            const next = readString(payload ?? {}, "customTitle");
            if (next) title = next;
          }
          continue;
        }

        if (type === "user") {
          const provenance = readString(record, "provenance");
          if (provenance === "system" || provenance === "external_agent") continue;
          if (subtype.startsWith("agent_")) continue;
          const prompt = partsOf(record).body;
          if (!prompt.trim()) continue;
          current = { idx: turns.length, ts, userText: prompt, assistantText: "" };
          turns.push(current);
          calls.clear();
          eventSeq = 0;
          continue;
        }

        if (type === "tool_result") {
          // `functionResponse.id` names the call this result belongs to; the
          // result is attached to that call's event instead of becoming a turn.
          const status = readString(objectValue(record.toolCallResult) ?? {}, "status");
          for (const entry of readArray(objectValue(record.message) ?? {}, "parts")) {
            const block = objectValue(entry);
            if (!block) continue;
            const response = objectValue(block.functionResponse);
            if (!response) continue;
            const id = readString(response, "id");
            const target = id ? calls.get(id) : undefined;
            if (!target) continue;
            const capped = capEventText(responseText(block), EVENT_CAPS.output);
            target.output = capped.text;
            target.truncated = target.truncated || capped.truncated;
            target.meta = `${id}|${status || "done"}`;
          }
          continue;
        }

        if (type !== "assistant" || !current) continue;

        const model = readString(record, "model");
        if (model && !current.model) current.model = model;

        const parsed = partsOf(record);
        if (parsed.body.trim()) {
          current.assistantText += current.assistantText
            ? `\n\n${parsed.body}`
            : parsed.body;
        }
        for (const thought of parsed.thoughts) {
          if (!thought.trim()) continue;
          const capped = capEventText(thought, EVENT_CAPS.reasoning);
          events.push({
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
        }
        for (const call of parsed.calls) {
          const input = capEventText(call.input, EVENT_CAPS.input);
          const event: ParsedEvent = {
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "tool",
            name: call.name,
            input: input.text,
            output: "",
            meta: call.id,
            truncated: input.truncated,
          };
          events.push(event);
          if (call.id) calls.set(call.id, event);
        }
      }

      if (turns.length === 0) return null;

      if (!projectPath) {
        // `projects/<project>/chats/<file>`: the project segment is a sanitized
        // cwd, used only when no record carried `cwd`.
        projectPath = basename(dirname(dirname(ref.sourcePath)));
      }

      const fileTime = Bun.file(ref.sourcePath).lastModified || Date.now();
      const started = startedAt || turns[0]?.ts || fileTime;
      const updated = updatedAt || started;
      for (const turn of turns) {
        if (!turn.ts) turn.ts = started;
      }
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
        agent: "qwen-code",
        externalId: ref.externalId,
        projectPath,
        title: cleanTitle(title, firstLine(capped[0]?.userText ?? "")),
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
