import { execFileSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { AGENT_LABELS } from "./adapters/types.ts";
import type { AgentId } from "./adapters/types.ts";
import {
  almaDeepLink,
  continuationFor,
  resumeCommand,
  sessionDeepLink,
} from "./util/resume.ts";

const MAX_TURNS = 6;
const MAX_PROMPT_CHARS = 320;
const MAX_ANSWER_CHARS = 900;
const MAX_FILES = 20;
const MAX_COMMANDS = 10;
const MAX_ERRORS = 5;
const ERROR_TEXT = /error|exception|failed|fatal|denied|rejected|失败|错误|异常|拒绝/i;
const FILE_KEY =
  /(?:^|_)(?:path|file|filename|filepath|target|notebook|glob|directory|dir)(?:$|_)/i;

interface SessionRow {
  id: string;
  agent: AgentId;
  external_id: string;
  title: string;
  project_path: string;
  started_at: number;
  updated_at: number;
}

interface TurnRow {
  idx: number;
  ts: number;
  user_text: string;
  assistant_text: string;
}

interface EventRow {
  turn_idx: number;
  seq: number;
  name: string | null;
  input: string;
  output: string;
  meta: string | null;
}

function oneLine(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  const chars = [...oneLine(value)];
  return chars.length <= max
    ? chars.join("")
    : `${chars.slice(0, max).join("").trimEnd()}…`;
}

function codeSpan(value: string): string {
  const clean = oneLine(value);
  const ticks = clean.includes("`") ? "``" : "`";
  return `${ticks}${clean}${ticks}`;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStatus(meta: string | null): string {
  if (!meta) return "";
  const parts = meta.split("|");
  return parts[parts.length - 1] ?? "";
}

function isError(status: string): boolean {
  return /error|denied|fail|reject/i.test(status);
}

function timeLabel(session: SessionRow): string {
  const start = session.started_at;
  const end = session.updated_at;
  const format = (value: number) => {
    if (!value) return "";
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const from = format(start);
  const to = format(end);
  if (!from) return to || "时间未知";
  if (!to || from === to) return from;
  return `${from} → ${to}`;
}

function collectPathValues(
  value: unknown,
  key: string,
  output: string[],
): void {
  if (typeof value === "string") {
    if (looksLikeFile(value, key)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, key, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [childKey, child] of Object.entries(value)) {
    collectPathValues(child, childKey, output);
  }
}

function looksLikeFile(value: string, key: string): boolean {
  if (!value || value.length > 400 || value.includes("\n")) return false;
  if (/^(?:https?|mailto|skill|[a-z][a-z0-9+.-]*):\/\//i.test(value)) {
    return false;
  }
  if (FILE_KEY.test(key)) return true;
  return (
    (value.startsWith("/") || value.startsWith("~/")) &&
    !/^\/api\//.test(value)
  );
}

function extractFiles(events: EventRow[]): string[] {
  const files: string[] = [];
  for (const event of events) {
    const input = parseJsonObject(event.input);
    const values: string[] = [];
    collectPathValues(input, "", values);
    for (const value of values) {
      if (!files.includes(value)) files.push(value);
      if (files.length >= MAX_FILES) return files;
    }
  }
  return files;
}

function extractCommands(events: EventRow[]): string[] {
  const commands: string[] = [];
  for (const event of events) {
    const input = parseJsonObject(event.input);
    if (typeof input === "string") {
      if (/bash|shell|command|exec|terminal/i.test(event.name ?? "")) {
        commands.push(input);
      }
    } else if (typeof input === "object" && input !== null) {
      const record = input as Record<string, unknown>;
      for (const key of ["command", "cmd", "script"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
          commands.push(value);
        }
      }
    }
  }
  const unique: string[] = [];
  for (const command of commands) {
    const clean = oneLine(command);
    if (clean && !unique.includes(clean)) unique.push(clean);
    if (unique.length >= MAX_COMMANDS) break;
  }
  return unique;
}

function extractErrors(events: EventRow[]): string[] {
  const errors: string[] = [];
  for (const event of events) {
    const status = normalizeStatus(event.meta);
    const lines = event.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const flagged = lines.find((line) => ERROR_TEXT.test(line));
    if (!isError(status) && !flagged) continue;
    const detail = flagged ?? lines[0] ?? "";
    const label = event.name || "tool";
    errors.push(`${label}${status ? ` [${status}]` : ""}: ${clip(detail || "（无输出）", 240)}`);
    if (errors.length >= MAX_ERRORS) break;
  }
  return errors;
}

function gitState(projectPath: string): string[] {
  if (!projectPath) return [];
  try {
    const output = execFileSync(
      "git",
      ["-C", projectPath, "status", "--short", "--branch"],
      {
        encoding: "utf8",
        timeout: 1_500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!output) return [];
    const lines = output.split(/\r?\n/);
    const branchLine = lines.shift() ?? "";
    const branch = branchLine.replace(/^##\s*/, "").split("...")[0]?.trim();
    const result: string[] = [];
    if (branch) result.push(`分支：${codeSpan(branch)}`);
    if (lines.length > 0) {
      result.push("未提交改动：", ...lines.slice(0, 20).map((line) => codeSpan(line)));
    }
    return result;
  } catch {
    return [];
  }
}

function continuationLines(
  session: SessionRow,
  targetAgent: AgentId | undefined,
): string[] {
  if (targetAgent) {
    const continuation = continuationFor(targetAgent, {
      agent: session.agent,
      externalId: session.external_id,
      projectPath: session.project_path,
    });
    const lines = ["", `## 在 ${AGENT_LABELS[targetAgent]} 中继续`, ""];
    if (continuation.kind === "deep-link") {
      lines.push(`- ${continuation.note}：${codeSpan(continuation.command)}`);
    } else if (continuation.command) {
      lines.push("```bash", continuation.command, "```", "", `> ${continuation.note}`);
    } else {
      lines.push(`> ${continuation.note}`);
    }
    return lines;
  }

  const resume = resumeCommand(session.agent, session.external_id, session.project_path);
  if (resume) return ["", "## 继续", "", "```bash", resume, "```"];
  if (session.agent === "alma") {
    return ["", "## 继续", "", `- 在 Alma 中打开：${codeSpan(almaDeepLink(session.external_id))}`];
  }
  return [];
}

function markdown(
  session: SessionRow,
  turns: TurnRow[],
  events: EventRow[],
  targetAgent?: AgentId,
): string {
  const title = oneLine(session.title) || oneLine(turns[0]?.user_text ?? "") || "未命名会话";
  const lines: string[] = [`# 交接：${clip(title, 100)}`, ""];
  if (session.project_path) lines.push(`- 项目：${codeSpan(session.project_path)}`);
  lines.push(`- Agent：${AGENT_LABELS[session.agent]}`);
  lines.push(`- 时间：${timeLabel(session)}`);
  lines.push(`- 会话：${sessionDeepLink(session.id)}`);
  lines.push(...continuationLines(session, targetAgent));

  const prompts = turns
    .map((turn) => oneLine(turn.user_text))
    .filter(Boolean)
    .slice(-MAX_TURNS);
  if (prompts.length > 0) {
    lines.push("", "## 最近提问", "");
    for (const prompt of prompts) lines.push(`- ${clip(prompt, MAX_PROMPT_CHARS)}`);
  }

  const answer = [...turns]
    .reverse()
    .map((turn) => turn.assistant_text)
    .find((value) => oneLine(value));
  if (answer) {
    lines.push("", "## 最后回答（原文截断）", "", `> ${clip(answer, MAX_ANSWER_CHARS)}`);
  }

  const files = extractFiles(events);
  if (files.length > 0) {
    lines.push("", "## 涉及文件", "");
    for (const file of files) lines.push(`- ${codeSpan(file)}`);
  }

  const commands = extractCommands(events);
  if (commands.length > 0) {
    lines.push("", "## 执行命令", "");
    for (const command of commands) lines.push(`- ${codeSpan(command)}`);
  }

  const errors = extractErrors(events);
  if (errors.length > 0) {
    lines.push("", "## 问题 / 未完成", "");
    for (const error of errors) lines.push(`- ${error}`);
  }

  const git = gitState(session.project_path);
  if (git.length > 0) {
    lines.push("", "## Git 状态", "", ...git);
  }

  lines.push("");
  return lines.join("\n");
}

export interface HandoffOptions {
  /** Continue in this agent instead of the session's own agent. */
  targetAgent?: AgentId;
}

export function generateHandoff(
  db: Database,
  id: string,
  options: HandoffOptions = {},
): string | null {
  const session = db
    .query(
      `SELECT id, agent, external_id, title, project_path, started_at, updated_at
       FROM session WHERE id = ?`,
    )
    .get(id) as SessionRow | null;
  if (!session) return null;
  const turns = db
    .query(
      `SELECT idx, ts, user_text, assistant_text FROM turn
       WHERE session_id = ? ORDER BY idx`,
    )
    .all(id) as TurnRow[];
  const events = db
    .query(
      `SELECT turn_idx, seq, name, input, output, meta FROM event
       WHERE session_id = ? AND kind = 'tool' ORDER BY turn_idx, seq`,
    )
    .all(id) as EventRow[];
  return markdown(session, turns, events, options.targetAgent);
}
