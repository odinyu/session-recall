import { join } from "node:path";
import { CLAUDE_DIR } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
import { filesInChildDirs } from "../util/fs.ts";
import {
  cleanTitle,
  firstLine,
  objectValue,
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
 * Claude Code stores one JSONL transcript per session at
 * `~/.claude/projects/<project-slug>/<sessionId>.jsonl`. Every record carries
 * `type`, `timestamp`, `sessionId` and usually `cwd`; the conversation is in
 * `user` / `assistant` records whose `message.content` is either a string or an
 * array of Anthropic content blocks.
 *
 * Things this adapter deliberately ignores:
 * - `isSidechain` records (subagent branches) — they would interleave a second
 *   conversation into the same turn list.
 * - `queue-operation`, `api-request`, `file-history-*`, `cost-state`, `mode`,
 *   `atis-latch`, `system`, `attachment` — bookkeeping, not conversation.
 * - `tool_result`-only user records — they answer a `tool_use`, not the user;
 *   they attach to the tool event instead.
 *
 * Title comes from the `ai-title` record; `last-prompt` is not used because it
 * is a clipped preview of an actual prompt already in the transcript.
 */

const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const INTERRUPT = /^\[Request interrupted by user(?: for tool use)?\]$/;

/** Concatenate text blocks; used for both prompts and tool results. */
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

function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => objectValue(part)?.type === "tool_result")
  );
}

/**
 * `projects/-Users-odin-projects` mirrors the cwd with `/` replaced by `-`.
 * Only a fallback: transcripts stamped with `cwd` always win, because a project
 * name that contains a dash would otherwise be split in the wrong place.
 */
function pathFromSlug(slug: string): string {
  return slug.startsWith("-") ? slug.replace(/-/g, "/") : "";
}

interface PendingTurn extends ParsedTurn {
  idx: number;
}

export function claudeCodeAdapter(projectsDir: string = PROJECTS_DIR): Adapter {
  return {
    id: "claude-code",
    label: "Claude Code",
    version: 1,

    async list(): Promise<SessionRef[]> {
      return filesInChildDirs(projectsDir).map((file) => ({
        agent: "claude-code",
        externalId: file.path.split("/").pop()!.replace(/\.jsonl$/, ""),
        fingerprint: `${file.size}:${file.mtimeMs}`,
        sourcePath: file.path,
      }));
    },

    async load(ref: SessionRef): Promise<ParsedSession | null> {
      const text = await Bun.file(ref.sourcePath).text();
      const slug = ref.sourcePath.split("/").at(-2) ?? "";
      let projectPath = pathFromSlug(slug);
      let title = "";
      let startedAt = 0;
      let updatedAt = 0;
      const turns: PendingTurn[] = [];
      const events: ParsedEvent[] = [];
      const calls = new Map<string, ParsedEvent>();
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
        if (entry.isSidechain === true) continue;

        const ts = Date.parse(readString(entry, "timestamp")) || 0;
        const cwd = readString(entry, "cwd");
        if (cwd) projectPath = cwd;
        if (ts > 0) {
          if (!startedAt || ts < startedAt) startedAt = ts;
          if (ts > updatedAt) updatedAt = ts;
        }

        const type = readString(entry, "type");
        if (type === "ai-title") {
          const next = readString(entry, "aiTitle");
          if (next) title = next;
          continue;
        }
        if (type !== "user" && type !== "assistant") continue;

        const message = objectValue(entry.message);
        if (!message) continue;

        if (type === "user") {
          const content = message.content;
          if (hasToolResult(content)) {
            for (const part of readArray(message, "content")) {
              const block = objectValue(part);
              if (!block || block.type !== "tool_result") continue;
              const callId = readString(block, "tool_use_id");
              const output = textOf(block.content);
              const status = block.is_error === true ? "error" : "ok";
              const target = callId ? calls.get(callId) : undefined;
              if (target) {
                const capped = capEventText(output, EVENT_CAPS.output);
                target.output = capped.text;
                target.truncated = target.truncated || capped.truncated;
                target.meta = `${callId}|${status}`;
              } else if (output.trim()) {
                const capped = capEventText(output, EVENT_CAPS.output);
                const turnIdx = current?.idx ?? Math.max(0, turns.length - 1);
                events.push({
                  turnIdx,
                  seq: eventSeq++,
                  kind: "tool",
                  name: "tool",
                  input: "",
                  output: capped.text,
                  meta: status,
                  truncated: capped.truncated,
                });
              }
            }
            continue;
          }

          const prompt = textOf(content);
          const trimmed = prompt.trim();
          if (!trimmed || INTERRUPT.test(trimmed)) continue;
          current = { idx: turns.length, ts, userText: prompt, assistantText: "" };
          turns.push(current);
          calls.clear();
          eventSeq = 0;
          continue;
        }

        if (!current) continue;
        const model = readString(message, "model");
        if (model && !current.model) current.model = model;

        const body: string[] = [];
        for (const part of readArray(message, "content")) {
          const block = objectValue(part);
          if (!block) continue;
          const kind = readString(block, "type");
          if (kind === "text") {
            const value = readString(block, "text");
            if (value) body.push(value);
            continue;
          }
          if (kind === "thinking") {
            const raw = readString(block, "thinking") || readString(block, "text");
            if (!raw.trim()) continue;
            const capped = capEventText(raw, EVENT_CAPS.reasoning);
            events.push({
              turnIdx: current.idx,
              seq: eventSeq++,
              kind: "reasoning",
              output: capped.text,
              truncated: capped.truncated,
            });
            continue;
          }
          if (kind === "tool_use") {
            const callId = readString(block, "id");
            const capped = capEventText(jsonText(block.input), EVENT_CAPS.input);
            const event: ParsedEvent = {
              turnIdx: current.idx,
              seq: eventSeq++,
              kind: "tool",
              name: readString(block, "name") || "tool",
              input: capped.text,
              output: "",
              meta: callId,
              truncated: capped.truncated,
            };
            events.push(event);
            if (callId) calls.set(callId, event);
          }
        }
        const value = body.join("\n");
        if (value.trim()) {
          current.assistantText += current.assistantText
            ? `\n\n${value}`
            : value;
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
        agent: "claude-code",
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
