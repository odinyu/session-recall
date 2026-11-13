import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { HOME } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS } from "../util/events.ts";
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
 * Kimi Code CLI keeps one wire log per session at
 * `<root>/sessions/<workdir-digest>/<sessionId>/wire.jsonl`, where `root`
 * defaults to `~/.kimi` (the older `~/.kimi-code` root is read too, and
 * `KIMI_DATA_DIR` overrides both).
 *
 * Each line is either the protocol header `{type: "metadata",
 * protocol_version}` or a `{timestamp, message: {type, payload}}` envelope.
 * `timestamp` is epoch seconds. The envelopes this adapter reads:
 * - `TurnBegin`   `payload.user_input` (string or content parts) starts a turn
 * - `SteerInput`  text the user appended while the turn was running
 * - `ContentPart` `payload.type: "text"` answer chunks, `"think"` reasoning
 * - `ToolCall`    `payload.function: {name, arguments}` (arguments is a JSON
 *                 string)
 * - `ToolResult`  `payload.tool_call_id` + `payload.return_value`
 *                 (`{is_error, output, message}`)
 *
 * Deliberately ignored:
 * - `ToolCallPart` — streamed argument fragments duplicating `ToolCall`.
 * - Run control and UI events (`StepBegin`, `TurnEnd`, `StatusUpdate`,
 *   `Notification`, `Compaction*`, `Hook*`, `Approval*`, `Question*`,
 *   `PlanDisplay`, `SubagentEvent`, `MCP*`): no prompt or answer text.
 * - `BtwBegin` / `BtwEnd` — Kimi's side question thread; it is not part of the
 *   turn it interrupts.
 * - Subagent transcripts (`sessions/<digest>/<session>/agents/<agent>/wire.jsonl`):
 *   a nested conversation owned by an agent the session spawned.
 *
 * The project path is not stored in the wire file: it is looked up by hashing
 * each `work_dirs[].path` in `<root>/kimi.json` (md5, the directory digest) and
 * matching the digest segment. When that lookup fails the digest is reported as
 * the project. Title comes from `custom_title` in the session's `state.json`,
 * otherwise from the first prompt.
 */

const DEFAULT_ROOTS = [
  join(HOME, ".kimi"),
  join(HOME, ".kimi-code"),
];

function rootsFor(dir?: string): string[] {
  if (dir) return [dir];
  const fromEnv = process.env.KIMI_DATA_DIR?.trim();
  if (fromEnv) return [fromEnv];
  return [...new Set(DEFAULT_ROOTS)];
}

/**
 * `sessions/<digest>/<sessionId>/wire.jsonl`. Deeper files under `agents/` are
 * subagent logs and are skipped.
 */
function sessionParts(root: string, path: string): string[] | null {
  const parts = relative(root, path).split(sep);
  if (parts.length !== 4) return null;
  if (parts[0] !== "sessions" || !parts[1] || !parts[2]) return null;
  if (parts[3] !== "wire.jsonl") return null;
  return parts;
}

/** Concatenate the text of a Kimi `user_input` / `output` field. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const entry of Array.isArray(content) ? content : []) {
    const part = objectValue(entry);
    if (!part) continue;
    const text = readString(part, "text") || readString(part, "think");
    if (text) parts.push(text);
  }
  return parts.join("");
}

/** Wire timestamps are epoch seconds; tolerate millisecond values too. */
function timestampOf(record: Record<string, unknown>): number {
  const value = record.timestamp;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

function digestOf(path: string): string {
  return createHash("md5").update(path, "utf8").digest("hex");
}

export function kimiCodeAdapter(dir?: string): Adapter {
  const roots = rootsFor(dir);
  // digest -> work directory, filled lazily from `<root>/kimi.json`.
  const projects = new Map<string, Map<string, string>>();

  function projectPathOf(root: string, digest: string): string {
    let byDigest = projects.get(root);
    if (!byDigest) {
      byDigest = new Map();
      try {
        const metadata = objectValue(parseJson(readFileSync(join(root, "kimi.json"), "utf8")));
        for (const entry of readArray(metadata ?? {}, "work_dirs")) {
          const path = readString(objectValue(entry) ?? {}, "path");
          if (path) byDigest.set(digestOf(path), path);
        }
      } catch {
        // No metadata file: the digest is the only project identifier left.
      }
      projects.set(root, byDigest);
    }
    return byDigest.get(digest) || digest;
  }

  return {
    id: "kimi-code",
    label: "Kimi Code",
    version: 1,

    async list(): Promise<SessionRef[]> {
      const refs: SessionRef[] = [];
      for (const root of roots) {
        for (const file of walkFiles(join(root, "sessions"), (name) => name === "wire.jsonl")) {
          const parts = sessionParts(root, file.path);
          if (!parts) continue;
          refs.push({
            agent: "kimi-code",
            externalId: parts[2] as string,
            fingerprint: `${file.size}:${file.mtimeMs}`,
            sourcePath: file.path,
          });
        }
      }
      return refs;
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
      // A step boundary means the next text chunk starts a new paragraph;
      // chunks inside one step are contiguous stream fragments.
      let atBoundary = false;

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const record = objectValue(parseJson(line));
        if (!record) continue;
        const envelope = objectValue(record.message);
        if (!envelope) continue; // metadata header
        const ts = timestampOf(record);
        if (ts > 0) {
          if (!startedAt || ts < startedAt) startedAt = ts;
          if (ts > updatedAt) updatedAt = ts;
        }
        const kind = readString(envelope, "type");
        const payload = objectValue(envelope.payload) ?? {};

        if (kind === "StepBegin") {
          atBoundary = true;
          continue;
        }
        if (kind === "TurnBegin") {
          const prompt = textOf(payload.user_input);
          if (!prompt.trim()) continue;
          current = { idx: turns.length, ts, userText: prompt, assistantText: "" };
          turns.push(current);
          calls.clear();
          eventSeq = 0;
          atBoundary = false;
          continue;
        }
        if (kind === "SteerInput") {
          const steering = textOf(payload.user_input);
          if (!steering.trim()) continue;
          if (current) {
            current.userText += `\n\n${steering}`;
          } else {
            current = { idx: turns.length, ts, userText: steering, assistantText: "" };
            turns.push(current);
            calls.clear();
            eventSeq = 0;
          }
          continue;
        }
        if (!current) continue;

        if (kind === "ContentPart" || kind === "TextPart" || kind === "ThinkPart") {
          const partType = kind === "ContentPart" ? readString(payload, "type") : kind;
          if (partType === "text" || kind === "TextPart") {
            const chunk = readString(payload, "text");
            if (!chunk) continue;
            current.assistantText +=
              current.assistantText && atBoundary ? `\n\n${chunk}` : chunk;
            atBoundary = false;
            continue;
          }
          if (partType === "think" || kind === "ThinkPart") {
            const thought = readString(payload, "think") || readString(payload, "text");
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
          continue;
        }

        if (kind === "ToolCall") {
          const fn = objectValue(payload.function) ?? {};
          const input = capEventText(readString(fn, "arguments"), EVENT_CAPS.input);
          const callId = readString(payload, "id");
          const event: ParsedEvent = {
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "tool",
            name: readString(fn, "name") || "tool",
            input: input.text,
            output: "",
            meta: callId,
            truncated: input.truncated,
          };
          events.push(event);
          if (callId) calls.set(callId, event);
          // Text after a tool round is a new assistant message, not the
          // continuation of the chunk that requested the call.
          atBoundary = true;
          continue;
        }

        if (kind === "ToolResult") {
          atBoundary = true;
          const callId = readString(payload, "tool_call_id");
          const target = callId ? calls.get(callId) : undefined;
          if (!target) continue;
          const value = objectValue(payload.return_value) ?? {};
          const raw = value.output;
          const outputText =
            typeof raw === "string" ? raw : textOf(raw) || readString(value, "message");
          const capped = capEventText(outputText, EVENT_CAPS.output);
          target.output = capped.text;
          target.truncated = target.truncated || capped.truncated;
          target.meta = `${callId}|${value.is_error === true ? "error" : "ok"}`;
        }
      }

      if (turns.length === 0) return null;

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

      // `state.json` sits in the session directory that owns the wire file.
      const root = dirname(dirname(dirname(dirname(ref.sourcePath))));
      const sessionDir = dirname(ref.sourcePath);
      let title = "";
      try {
        const state = objectValue(
          parseJson(readFileSync(join(sessionDir, "state.json"), "utf8")),
        );
        title = readString(state ?? {}, "custom_title");
      } catch {
        // No state file, or it was written by an older release.
      }
      const parts = relative(root, ref.sourcePath).split(sep);
      const digest = parts[1] ?? basename(dirname(dirname(ref.sourcePath)));

      return {
        agent: "kimi-code",
        externalId: ref.externalId,
        projectPath: projectPathOf(root, digest),
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
