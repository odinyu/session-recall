import { join } from "node:path";
import { CINDY_DIR, CODEX_DIR } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import { walkFiles } from "../util/fs.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
  readArray,
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
 * Codex CLI writes one rollout per session under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Each line is
 * `{timestamp, type, payload}`:
 *
 * - `session_meta`  starting cwd and session id
 * - `turn_context`  cwd/model for the next turn
 * - `response_item` the canonical transcript: `message` (role `user` /
 *                   `assistant` with `input_text` / `output_text` blocks),
 *                   `function_call` + `function_call_output`, `reasoning`
 * - `event_msg`     UI-level `user_message` / `agent_message` echoes and token
 *                   counts
 *
 * The adapter reads `response_item` and falls back to `event_msg` messages only
 * when a rollout has no `response_item` messages at all (older or partial
 * files). Reading both would duplicate every prompt.
 *
 * NOTE: no Codex sessions existed on the development machine, so this parser is
 * written against the documented rollout format and is not covered by a
 * real-file fixture.
 */

const SESSIONS_DIR = join(CODEX_DIR, "sessions");
const ROLLOUT = /^rollout-.*\.jsonl$/;

/**
 * Cindy runs Codex with its own home, and moves finished rollouts into
 * `archived_sessions`. Both live outside `~/.codex`, so a default install of
 * the desktop app would otherwise index no Codex session at all.
 */
function defaultSessionRoots(): string[] {
  const cindyHome = join(CINDY_DIR, "codex-home");
  return [
    SESSIONS_DIR,
    join(cindyHome, "sessions"),
    join(cindyHome, "archived_sessions"),
  ];
}

function contentText(content: unknown): string {
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

function reasoningText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    for (const part of readArray(payload, key)) {
      const block = objectValue(part);
      if (!block) continue;
      const text = readString(block, "text");
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

interface PendingTurn extends ParsedTurn {
  idx: number;
}

interface FallbackMessage {
  ts: number;
  role: "user" | "assistant";
  text: string;
}

export function codexAdapter(
  sessionRoots: string | string[] = defaultSessionRoots(),
): Adapter {
  const roots = Array.isArray(sessionRoots) ? sessionRoots : [sessionRoots];
  return {
    id: "codex",
    label: "Codex",
    version: 3,

    async list(): Promise<SessionRef[]> {
      const refs: SessionRef[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        for (const file of walkFiles(root, (name) => ROLLOUT.test(name))) {
          const externalId = file.path.split("/").pop()!.replace(/\.jsonl$/, "");
          if (seen.has(externalId)) continue;
          seen.add(externalId);
          refs.push({
            agent: "codex",
            externalId,
            fingerprint: `${file.size}:${file.mtimeMs}`,
            sourcePath: file.path,
          });
        }
      }
      return refs;
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const text = await Bun.file(ref.sourcePath).text();
      let projectPath = "";
      let model = "";
      let startedAt = 0;
      let updatedAt = 0;
      const turns: PendingTurn[] = [];
      const events: ParsedEvent[] = [];
      const calls = new Map<string, ParsedEvent>();
      const fallback: FallbackMessage[] = [];
      let eventSeq = 0;
      let current: PendingTurn | null = null;

      for (const line of text.split("\n")) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = objectValue(parsed);
        if (!entry) continue;
        const payload = objectValue(entry.payload);
        if (!payload) continue;

        const ts = Date.parse(readString(entry, "timestamp")) || 0;
        if (ts > 0) {
          if (!startedAt || ts < startedAt) startedAt = ts;
          if (ts > updatedAt) updatedAt = ts;
        }

        const type = readString(entry, "type");
        if (type === "session_meta") {
          const cwd = readString(payload, "cwd");
          if (cwd) projectPath = cwd;
          continue;
        }
        if (type === "turn_context") {
          const cwd = readString(payload, "cwd");
          if (cwd && !projectPath) projectPath = cwd;
          const next = readString(payload, "model");
          if (next) model = next;
          continue;
        }
        if (type === "event_msg") {
          const kind = readString(payload, "type");
          const message = readString(payload, "message");
          if (!message.trim()) continue;
          if (kind === "user_message") {
            fallback.push({ ts, role: "user", text: message });
          } else if (kind === "agent_message") {
            fallback.push({ ts, role: "assistant", text: message });
          }
          continue;
        }
        if (type !== "response_item") continue;

        const kind = readString(payload, "type");

        if (kind === "message") {
          const role = readString(payload, "role");
          const body = contentText(payload.content);
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
          if (role === "assistant") {
            if (!current || !body.trim()) continue;
            current.assistantText += current.assistantText
              ? `\n\n${body}`
              : body;
          }
          continue;
        }

        if (!current) continue;

        if (kind === "reasoning") {
          const reasoning = reasoningText(payload);
          if (!reasoning.trim()) continue;
          const capped = capEventText(reasoning, EVENT_CAPS.reasoning);
          events.push({
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "reasoning",
            output: capped.text,
            truncated: capped.truncated,
          });
          continue;
        }

        if (kind === "function_call" || kind.endsWith("_call")) {
          const callId = readString(payload, "call_id") || readString(payload, "id");
          const name = readString(payload, "name") || kind.replace(/_call$/, "");
          const input = payload.arguments ?? payload.action ?? payload.input ?? "";
          const capped = capEventText(jsonText(input), EVENT_CAPS.input);
          const event: ParsedEvent = {
            turnIdx: current.idx,
            seq: eventSeq++,
            kind: "tool",
            name: name || "tool",
            input: capped.text,
            output: "",
            meta: callId,
            truncated: capped.truncated,
          };
          events.push(event);
          if (callId) calls.set(callId, event);
          continue;
        }

        if (kind.endsWith("_output")) {
          const callId = readString(payload, "call_id") || readString(payload, "id");
          const output = jsonText(payload.output ?? payload.content ?? "");
          const target = callId ? calls.get(callId) : undefined;
          const capped = capEventText(output, EVENT_CAPS.output);
          if (target) {
            target.output = capped.text;
            target.truncated = target.truncated || capped.truncated;
            target.meta = `${callId}|ok`;
          } else if (output.trim()) {
            events.push({
              turnIdx: current.idx,
              seq: eventSeq++,
              kind: "tool",
              name: readString(payload, "name") || "tool",
              input: "",
              output: capped.text,
              meta: "ok",
              truncated: capped.truncated,
            });
          }
        }
      }

      // Older / partial rollouts may only carry the UI event stream.
      if (turns.length === 0) {
        for (const message of fallback) {
          if (message.role === "user") {
            current = {
              idx: turns.length,
              ts: message.ts,
              userText: message.text,
              assistantText: "",
              model: model || undefined,
            };
            turns.push(current);
          } else if (current) {
            current.assistantText += current.assistantText
              ? `\n\n${message.text}`
              : message.text;
          }
        }
      }

      if (turns.length === 0) return null;

      const fallbackTime = Bun.file(ref.sourcePath).lastModified || Date.now();
      const started = startedAt || turns[0]?.ts || fallbackTime;
      const updated = updatedAt || started;

      const capped = turns.map((turn, index) => {
        const user = capText(turn.userText);
        const assistant = capText(turn.assistantText);
        return {
          idx: index,
          ts: turn.ts || started,
          userText: user.text,
          assistantText: assistant.text,
          model: turn.model,
          truncated: user.truncated || assistant.truncated,
        };
      });

      return {
        agent: "codex",
        externalId: ref.externalId,
        projectPath,
        title: cleanTitle("", firstLine(titlePrompt(capped))),
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
