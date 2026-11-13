import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOME } from "../config.ts";
import { capText } from "../db.ts";
import { capEventText, EVENT_CAPS, jsonText } from "../util/events.ts";
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
 * GitHub Copilot CLI writes one append-only JSONL log per session under
 * `$COPILOT_HOME/session-state/<session-id>/events.jsonl` (default
 * `~/.copilot`). Builds before 1.0.11 wrote the same file flat, as
 * `session-state/<session-id>.jsonl`; both layouts are read. `history-session-state`
 * is scanned with the same rules because older installs kept their sessions
 * there.
 *
 * Every line is one event: `{type, data, id?, parentId?, timestamp}`. Only the
 * conversation and tool records are used:
 * - `user.message` -> `data.content` is a plain string and starts a turn.
 *   `data.attachments` (file paths) is not matched to the prompt, so it is
 *   ignored.
 * - `assistant.message` -> `data.content` is the visible answer, `data.model`
 *   names the model. `data.toolRequests[]` carries `toolCallId`, `name` and
 *   `arguments`; each becomes a tool event. The encrypted payload
 *   (`encryptedContent`, `reasoningOpaque`) is provider data and is never read.
 * - `tool.execution_complete` -> `data.result.content` (a plain string in every
 *   store seen so far) fills the output of the event with the same
 *   `data.toolCallId`; `data.success === false` marks it as an error. A
 *   `tool.execution_start` only contributes `data.arguments` when the assistant
 *   record carried none.
 *
 * Deliberately ignored: `session.start` / `session.shutdown` /
 * `session.usage_checkpoint` / `session.model_change` carry usage and
 * bookkeeping (only the cwd, start time and model fallback are read);
 * `assistant.turn_start` / `turn_end`, `assistant.reasoning` (plaintext may be
 * absent), `system.message` / `system.notification`, `hook.*`,
 * `subagent.started` / `subagent.completed` and `session.truncation` are not
 * conversation. Records written by a sub-agent share the parent's file; the
 * format is documented to stamp them with `agentId`, but that has not been
 * verified against a real store, so no attempt is made to split them into a
 * second session.
 *
 * Project path: `session.start` -> `data.context.cwd`, else the `cwd:` scalar of
 * the sibling `workspace.yaml`, else "" (the file path carries no project
 * segment). Title: the `name:` scalar of `workspace.yaml` when present, else the
 * first prompt.
 */

const MAX_LINE_BYTES = 8 * 1024 * 1024;

interface WorkspaceInfo {
  name: string;
  cwd: string;
}

/** The session state directories, current layout first. */
function stateDirs(root: string): string[] {
  return [join(root, "session-state"), join(root, "history-session-state")];
}

/** `$COPILOT_HOME` when set and non-empty, else `~/.copilot`. */
function copilotHome(dir?: string): string {
  if (dir) return dir;
  const fromEnv = process.env.COPILOT_HOME?.trim();
  return fromEnv ? fromEnv : join(HOME, ".copilot");
}

/**
 * `workspace.yaml` is flat scalars (`cwd:`, `name:`, `git_root:`, `branch:`…).
 * Only the two keys used here are read; nested YAML and quoting are tolerated by
 * stripping a matching pair of single or double quotes.
 */
function readWorkspace(path: string): WorkspaceInfo {
  const info: WorkspaceInfo = { name: "", cwd: "" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return info;
  }
  for (const line of text.split("\n")) {
    const match = /^(name|cwd):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (match[1] === "name") info.name = value;
    else info.cwd = value;
  }
  return info;
}

/** Tool output is a string in practice; flatten arrays/objects defensively. */
function toolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => toolOutput(item))
      .filter((part) => part.trim())
      .join("\n");
  }
  const record = objectValue(value);
  if (record) {
    const text = readString(record, "text");
    if (text) return text;
    return jsonText(value);
  }
  return value === null || value === undefined ? "" : String(value);
}

/** Sort turns by time, keeping file order for equal timestamps, then remap events. */
function orderConversation(
  turns: ParsedTurn[],
  events: ParsedEvent[],
): { turns: ParsedTurn[]; events: ParsedEvent[] } {
  const order = turns
    .map((turn, position) => ({ turn, position }))
    .sort((left, right) => left.turn.ts - right.turn.ts || left.position - right.position);
  const remap = new Map<number, number>();
  const sorted = order.map((entry, next) => {
    remap.set(entry.turn.idx, next);
    return { ...entry.turn, idx: next };
  });
  const remapped = events
    .filter((event) => remap.has(event.turnIdx))
    .map((event) => ({ ...event, turnIdx: remap.get(event.turnIdx) as number }))
    .sort((left, right) => left.turnIdx - right.turnIdx || left.seq - right.seq);
  return { turns: sorted, events: remapped };
}

export function copilotCliAdapter(copilotDir?: string): Adapter {
  const root = copilotHome(copilotDir);

  async function list(): Promise<SessionRef[]> {
    const bySession = new Map<string, SessionRef>();
    for (const dir of stateDirs(root)) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        // Current layout: a session directory whose transcript is events.jsonl.
        // A directory without it has nothing to read and is not listed.
        const sourcePath = entry.isDirectory()
          ? join(path, "events.jsonl")
          : entry.isFile() && entry.name.endsWith(".jsonl")
            ? path
            : "";
        if (!sourcePath) continue;
        let stat: Stats;
        try {
          stat = statSync(sourcePath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const externalId = entry.isDirectory()
          ? entry.name
          : basename(entry.name).replace(/\.jsonl$/, "");
        if (!externalId) continue;
        // A store migrated from the flat layout can hold both shapes for one
        // session; the per-session directory is the current one, so it wins.
        const previous = bySession.get(externalId);
        if (previous && !entry.isDirectory()) continue;
        bySession.set(externalId, {
          agent: "copilot-cli",
          externalId,
          fingerprint: `${stat.size}:${stat.mtimeMs}`,
          sourcePath,
        });
      }
    }
    return [...bySession.values()].sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    );
  }

  async function load(ref: SessionRef): Promise<ParsedSession | null> {
    let text: string;
    try {
      text = await Bun.file(ref.sourcePath).text();
    } catch {
      return null;
    }
    const workspace = readWorkspace(join(dirname(ref.sourcePath), "workspace.yaml"));

    let projectPath = "";
    let startedAt = 0;
    let updatedAt = 0;
    let fallbackModel = "";
    const turns: ParsedTurn[] = [];
    const events: ParsedEvent[] = [];
    const calls = new Map<string, ParsedEvent>();
    let current: ParsedTurn | null = null;
    let eventSeq = 0;

    const pushEvent = (event: Omit<ParsedEvent, "seq">, callId?: string): ParsedEvent => {
      const created: ParsedEvent = { ...event, seq: eventSeq++ };
      events.push(created);
      if (callId) calls.set(callId, created);
      return created;
    };

    for (const raw of text.split("\n")) {
      if (!raw || raw.length > MAX_LINE_BYTES) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const line = objectValue(parsed);
      if (!line) continue;
      const type = readString(line, "type");
      const data = objectValue(line.data) ?? {};
      const ts = Date.parse(readString(line, "timestamp")) || 0;
      if (ts > 0) {
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (ts > updatedAt) updatedAt = ts;
      }

      if (type === "session.start") {
        const context = objectValue(data.context);
        const cwd = context ? readString(context, "cwd") : "";
        if (cwd && !projectPath) projectPath = cwd;
        const startTime = Date.parse(readString(data, "startTime")) || 0;
        if (startTime > 0 && (!startedAt || startTime < startedAt)) startedAt = startTime;
        continue;
      }
      if (type === "session.model_change") {
        const model = readString(data, "newModel");
        if (model) fallbackModel = model;
        continue;
      }

      if (type === "user.message") {
        const prompt = readString(data, "content");
        if (!prompt.trim()) continue;
        current = {
          idx: turns.length,
          ts,
          userText: prompt,
          assistantText: "",
          model: fallbackModel || undefined,
        };
        turns.push(current);
        calls.clear();
        eventSeq = 0;
        continue;
      }

      if (type === "assistant.message") {
        if (!current) continue;
        const model = readString(data, "model");
        if (model) {
          fallbackModel = model;
          if (!current.model) current.model = model;
        }
        const body = readString(data, "content");
        if (body.trim()) {
          current.assistantText += current.assistantText ? `\n\n${body}` : body;
        }
        for (const rawRequest of readArray(data, "toolRequests")) {
          const request = objectValue(rawRequest);
          if (!request) continue;
          const callId = readString(request, "toolCallId");
          const name = readString(request, "name") || "tool";
          const input = capEventText(jsonText(request.arguments), EVENT_CAPS.input);
          pushEvent(
            {
              turnIdx: current.idx,
              kind: "tool",
              name,
              input: input.text,
              output: "",
              truncated: input.truncated,
            },
            callId || undefined,
          );
        }
        continue;
      }

      if (type === "tool.execution_start") {
        if (!current) continue;
        const callId = readString(data, "toolCallId");
        const name = readString(data, "toolName") || readString(data, "name") || "tool";
        const argumentsValue = data.arguments;
        const existing = callId ? calls.get(callId) : undefined;
        if (existing) {
          if (!existing.input && argumentsValue !== undefined && argumentsValue !== null) {
            const input = capEventText(jsonText(argumentsValue), EVENT_CAPS.input);
            existing.input = input.text;
            existing.truncated = existing.truncated || input.truncated;
          }
          continue;
        }
        const input = capEventText(jsonText(argumentsValue), EVENT_CAPS.input);
        pushEvent(
          {
            turnIdx: current.idx,
            kind: "tool",
            name,
            input: input.text,
            output: "",
            truncated: input.truncated,
          },
          callId || undefined,
        );
        continue;
      }

      if (type === "tool.execution_complete") {
        if (!current) continue;
        const callId = readString(data, "toolCallId");
        const result = objectValue(data.result);
        const output = capEventText(
          result ? toolOutput(result.content) : "",
          EVENT_CAPS.output,
        );
        const status = data.success === false ? "error" : "ok";
        const existing = callId ? calls.get(callId) : undefined;
        if (existing) {
          existing.output = output.text;
          existing.meta = status;
          existing.truncated = existing.truncated || output.truncated;
          continue;
        }
        pushEvent(
          {
            turnIdx: current.idx,
            kind: "tool",
            name: readString(data, "toolName") || "tool",
            input: "",
            output: output.text,
            meta: status,
            truncated: output.truncated,
          },
          callId || undefined,
        );
      }
    }

    if (turns.length === 0) return null;

    const ordered = orderConversation(turns, events);
    const capped = ordered.turns.map((turn) => {
      const user = capText(turn.userText);
      const assistant = capText(turn.assistantText);
      return {
        idx: turn.idx,
        ts: turn.ts || startedAt || updatedAt,
        userText: user.text,
        assistantText: assistant.text,
        model: turn.model,
        truncated: user.truncated || assistant.truncated,
      };
    });

    const fallbackTime = Bun.file(ref.sourcePath).lastModified || Date.now();
    const started = startedAt || capped[0]?.ts || fallbackTime;
    const updated = updatedAt || started;

    return {
      agent: "copilot-cli",
      externalId: ref.externalId,
      projectPath: projectPath || workspace.cwd,
      title: cleanTitle(workspace.name, firstLine(capped[0]?.userText ?? "")),
      startedAt: started,
      updatedAt: updated,
      sourceKind: "jsonl",
      sourcePath: ref.sourcePath,
      fingerprint: ref.fingerprint,
      turns: capped,
      events: ordered.events,
    };
  }

  return {
    id: "copilot-cli",
    label: "Copilot CLI",
    version: 1,
    list,
    load,
  };
}
