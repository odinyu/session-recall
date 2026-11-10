import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../config.ts";
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
import type { Adapter, ParsedEvent, ParsedSession, ParsedTurn, SessionRef } from "./types.ts";

const OMP_AGENT = join(HOME, ".omp", "agent");

function sessionRoots(): string[] {
  const roots = [join(OMP_AGENT, "sessions")];
  const profiles = join(HOME, ".omp", "profiles");
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      const root = join(profiles, name, "agent", "sessions");
      if (existsSync(root)) roots.push(root);
    }
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) roots.push(join(xdg, "omp", "sessions"));
  return roots;
}

function textOfContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const part of content) {
    const block = objectValue(part);
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export function ompAdapter(): Adapter {
  return {
    id: "omp",
    label: "omp",
    version: 3,

    async list(): Promise<SessionRef[]> {
      const refs: SessionRef[] = [];
      const seen = new Set<string>();
      for (const root of sessionRoots()) {
        for (const file of filesInChildDirs(root)) {
          const externalId = file.path.split("/").pop()!.replace(/\.jsonl$/, "");
          if (seen.has(externalId)) continue;
          seen.add(externalId);
          refs.push({
            agent: "omp",
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
      const lines = text.split("\n");

      let projectPath = "";
      let headerTime = 0;
      let title = "";
      let updatedAt = 0;
      const turns: ParsedTurn[] = [];
      const events: ParsedEvent[] = [];
      const calls = new Map<string, ParsedEvent>();
      let eventSeq = 0;
      let current: ParsedTurn | null = null;

      for (const line of lines) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = objectValue(parsed);
        if (!entry) continue;
        const type = readString(entry, "type");

        if (type === "session") {
          projectPath = readString(entry, "cwd");
          headerTime = Date.parse(readString(entry, "timestamp")) || 0;
          continue;
        }
        if (type === "title" || type === "title_change") {
          const next = readString(entry, "title");
          if (next) title = next;
          continue;
        }
        if (type !== "message") continue;

        const message = objectValue(entry.message);
        if (!message) continue;
        const role = readString(message, "role");
        const ts = Date.parse(readString(entry, "timestamp")) || 0;
        if (ts > updatedAt) updatedAt = ts;

        if (role === "user") {
          const body = textOfContent(readArray(message, "content"));
          if (!body.trim()) continue;
          current = {
            idx: turns.length,
            ts,
            userText: body,
            assistantText: "",
          };
          turns.push(current);
          calls.clear();
          eventSeq = 0;
          continue;
        }

        if (!current) continue;

        if (role === "assistant") {
          const body: string[] = [];
          for (const part of readArray(message, "content")) {
            const block = objectValue(part);
            if (!block) continue;
            const kind = readString(block, "type");
            if (kind === "text") {
              const text = readString(block, "text");
              if (text) body.push(text);
              continue;
            }
            if (kind === "thinking") {
              const raw =
                readString(block, "thinking") || readString(block, "text");
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
            if (kind === "toolCall") {
              const name = readString(block, "name") || "tool";
              const callId = readString(block, "id");
              const capped = capEventText(jsonText(block.arguments), EVENT_CAPS.input);
              const event: ParsedEvent = {
                turnIdx: current.idx,
                seq: eventSeq++,
                kind: "tool",
                name,
                input: capped.text,
                output: "",
                meta: callId,
                truncated: capped.truncated,
              };
              events.push(event);
              if (callId) calls.set(callId, event);
            }
          }
          const text = body.join("\n");
          if (text.trim()) {
            current.assistantText += current.assistantText
              ? `\n\n${text}`
              : text;
          }
          continue;
        }

        if (role === "toolResult") {
          const callId = readString(message, "toolCallId");
          const output = textOfContent(readArray(message, "content"));
          const isError = message.isError === true;
          const target = callId ? calls.get(callId) : undefined;
          if (target) {
            const capped = capEventText(output, EVENT_CAPS.output);
            target.output = capped.text;
            target.truncated = target.truncated || capped.truncated;
            target.meta = `${callId}|${isError ? "error" : "ok"}`;
          } else if (output.trim()) {
            const capped = capEventText(output, EVENT_CAPS.output);
            events.push({
              turnIdx: current.idx,
              seq: eventSeq++,
              kind: "tool",
              name: readString(message, "toolName") || "tool",
              input: "",
              output: capped.text,
              meta: isError ? "error" : "ok",
              truncated: capped.truncated,
            });
          }
        }
      }

      if (turns.length === 0) return null;

      const fallbackTime = statSync(ref.sourcePath).mtimeMs;
      const startedAt = headerTime || turns[0].ts || fallbackTime;
      if (!updatedAt) updatedAt = fallbackTime;

      const capped = turns.map((turn, index) => {
        const user = capText(turn.userText);
        const assistant = capText(turn.assistantText);
        return {
          idx: index,
          ts: turn.ts,
          userText: user.text,
          assistantText: assistant.text,
          truncated: user.truncated || assistant.truncated,
        };
      });

      return {
        agent: "omp",
        externalId: ref.externalId,
        projectPath,
        title: cleanTitle(title, firstLine(capped[0].userText)),
        startedAt,
        updatedAt,
        sourceKind: "jsonl",
        sourcePath: ref.sourcePath,
        fingerprint: ref.fingerprint,
        turns: capped,
        events,
      };
    },
  };
}
