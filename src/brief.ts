import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentId } from "./adapters/types.ts";
import { BRIEF_DIR, PROJECT_ROOT } from "./config.ts";

const AGENT_LABELS: Record<AgentId, string> = {
  omp: "omp",
  opencode: "OpenCode",
  cursor: "Cursor",
  alma: "Alma",
};

const MAX_PROMPT_CHARS = 220;
const MAX_TITLE_CHARS = 80;
const FALLBACK_TURNS = 12;
/** Mirrors `plugins.deep-link.desktop.schemes` in src-tauri/tauri.conf.json. */
const DEEP_LINK_SCHEME = "sessionrecall";

export interface BriefDate {
  key: string;
  start: number;
  end: number;
  label: string;
}

export interface BriefResult {
  date: string;
  path: string;
  relativePath: string;
  markdown: string;
  sessions: number;
  turns: number;
  projects: number;
}

interface SessionRow {
  id: string;
  agent: AgentId;
  external_id: string;
  title: string;
  project_path: string;
  updated_at: number;
  has_day_turn: number;
}

interface TurnRow {
  idx: number;
  ts: number;
  user_text: string;
  assistant_text: string;
}

interface BriefSession {
  id: string;
  agent: AgentId;
  externalId: string;
  title: string;
  projectPath: string;
  updatedAt: number;
  hasDayTurn: boolean;
  turns: TurnRow[];
  toolCount: number;
  reasoningCount: number;
}

interface BriefProject {
  path: string;
  name: string;
  sessions: BriefSession[];
  turns: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseBriefDate(
  input: string | null | undefined,
  now = new Date(),
): BriefDate | null {
  const key = input?.trim() || localDateKey(now);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const start = new Date(year, month, day, 0, 0, 0, 0);
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month ||
    start.getDate() !== day
  ) {
    return null;
  }
  const end = new Date(year, month, day + 1, 0, 0, 0, 0);
  return {
    key,
    start: start.getTime(),
    end: end.getTime(),
    label: `${year}年${month + 1}月${day}日`,
  };
}

function clock(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function oneLine(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  const chars = [...oneLine(value)];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

function projectName(path: string): string {
  if (!path) return "未识别项目";
  return basename(path) || path;
}

function codeSpan(value: string): string {
  const clean = oneLine(value);
  const ticks = clean.includes("`") ? "``" : "`";
  return `${ticks}${clean}${ticks}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resumeCommand(session: BriefSession): string {
  const cwd = session.projectPath
    ? `cd ${shellQuote(session.projectPath)} && `
    : "";
  if (session.agent === "omp") {
    const resumeId = session.externalId.slice(
      session.externalId.lastIndexOf("_") + 1,
    );
    return `${cwd}omp --resume ${resumeId}`;
  }
  if (session.agent === "opencode") {
    return `${cwd}opencode --session ${session.externalId}`;
  }
  return "";
}

function eventCounts(
  db: Database,
  sessionId: string,
  hasDayTurn: boolean,
  date: BriefDate,
): { tool: number; reasoning: number } {
  const rows = hasDayTurn
    ? (db
        .query(
          `SELECT e.kind AS kind, count(*) AS n
           FROM event e
           JOIN turn t ON t.session_id = e.session_id AND t.idx = e.turn_idx
           WHERE e.session_id = ? AND t.ts >= ? AND t.ts < ?
           GROUP BY e.kind`,
        )
        .all(sessionId, date.start, date.end) as { kind: string; n: number }[])
    : (db
        .query(
          `SELECT kind, count(*) AS n FROM event
           WHERE session_id = ? GROUP BY kind`,
        )
        .all(sessionId) as { kind: string; n: number }[]);
  let tool = 0;
  let reasoning = 0;
  for (const row of rows) {
    if (row.kind === "tool") tool = row.n;
    else if (row.kind === "reasoning") reasoning = row.n;
  }
  return { tool, reasoning };
}

function loadSessions(db: Database, date: BriefDate): BriefSession[] {
  const rows = db
    .query(
      `SELECT s.id, s.agent, s.external_id, s.title, s.project_path,
              s.updated_at,
              EXISTS (
                SELECT 1 FROM turn t
                WHERE t.session_id = s.id AND t.ts >= ? AND t.ts < ?
              ) AS has_day_turn
       FROM session s
       WHERE EXISTS (
               SELECT 1 FROM turn t
               WHERE t.session_id = s.id AND t.ts >= ? AND t.ts < ?
             )
          OR (
               s.updated_at >= ? AND s.updated_at < ?
               AND NOT EXISTS (
                 SELECT 1 FROM turn t
                 WHERE t.session_id = s.id AND t.ts > 0
               )
             )
       ORDER BY s.updated_at DESC`,
    )
    .all(
      date.start,
      date.end,
      date.start,
      date.end,
      date.start,
      date.end,
    ) as SessionRow[];

  const sessions: BriefSession[] = [];
  for (const row of rows) {
    const hasDayTurn = row.has_day_turn === 1;
    const turnRows = hasDayTurn
      ? (db
          .query(
            `SELECT idx, ts, user_text, assistant_text FROM turn
             WHERE session_id = ? AND ts >= ? AND ts < ?
             ORDER BY idx`,
          )
          .all(row.id, date.start, date.end) as TurnRow[])
      : (db
          .query(
            `SELECT idx, ts, user_text, assistant_text FROM turn
             WHERE session_id = ? ORDER BY idx DESC LIMIT ?`,
          )
          .all(row.id, FALLBACK_TURNS) as TurnRow[]).reverse();

    if (turnRows.length === 0) continue;
    const counts = eventCounts(db, row.id, hasDayTurn, date);
    sessions.push({
      id: row.id,
      agent: row.agent,
      externalId: row.external_id,
      title: row.title,
      projectPath: row.project_path,
      updatedAt: row.updated_at,
      hasDayTurn,
      turns: turnRows,
      toolCount: counts.tool,
      reasoningCount: counts.reasoning,
    });
  }
  return sessions;
}

function timeLabel(session: BriefSession): string {
  const times = session.turns.map((turn) => turn.ts).filter((ts) => ts > 0);
  if (times.length > 0) {
    const first = Math.min(...times);
    const last = Math.max(...times);
    return first === last ? clock(first) : `${clock(first)}–${clock(last)}`;
  }
  return session.updatedAt ? `更新于 ${clock(session.updatedAt)}` : "时间未知";
}

function sessionTitle(session: BriefSession): string {
  const title = oneLine(session.title);
  if (title) return clip(title, MAX_TITLE_CHARS);
  const firstPrompt = session.turns.find((turn) => oneLine(turn.user_text));
  return firstPrompt
    ? clip(firstPrompt.user_text, MAX_TITLE_CHARS)
    : "未命名会话";
}

function sessionBlock(session: BriefSession): string {
  const lines: string[] = [`### ${sessionTitle(session)}`, ""];
  const meta = [
    AGENT_LABELS[session.agent],
    timeLabel(session),
    session.hasDayTurn
      ? `${session.turns.length} 轮`
      : `最近 ${session.turns.length} 轮`,
  ];
  if (session.toolCount || session.reasoningCount) {
    const process: string[] = [];
    if (session.toolCount) process.push(`工具 ${session.toolCount}`);
    if (session.reasoningCount) process.push(`思考 ${session.reasoningCount}`);
    meta.push(process.join(" / "));
  }
  lines.push(meta.join(" · "), "");

  const prompts = session.turns
    .map((turn) => oneLine(turn.user_text))
    .filter(Boolean);
  if (prompts.length > 0) {
    lines.push("**提问**", "");
    for (const prompt of prompts) {
      lines.push(`- ${clip(prompt, MAX_PROMPT_CHARS)}`);
    }
    lines.push("");
  }

  const resume = resumeCommand(session);
  if (resume) {
    lines.push(`**继续**：${codeSpan(resume)}`, "");
  }

  // A stable address for the app itself: `http://127.0.0.1:<port>` would be the
  // port of whichever launch generated the brief, and would die on the next one
  // (and land in a browser when clicked from outside the app).
  const link = `${DEEP_LINK_SCHEME}://session/${encodeURIComponent(session.id)}`;
  lines.push(`[在 session-recall 打开](${link})`, "");
  return lines.join("\n");
}

function projectBlock(project: BriefProject): string {
  const lines = [`## ${oneLine(project.name)}`, ""];
  if (project.path) lines.push(codeSpan(project.path), "");
  for (const session of project.sessions) {
    lines.push(sessionBlock(session));
  }
  return lines.join("\n");
}

function overviewTable(projects: BriefProject[]): string {
  const rows = projects.map((project) => {
    const agents = [...new Set(project.sessions.map((session) => AGENT_LABELS[session.agent]))]
      .join("、");
    return `| ${oneLine(project.name).replace(/\|/g, "\\|")} | ${project.sessions.length} | ${project.turns} | ${agents} |`;
  });
  return [
    "| 项目 | 会话 | 问答 | Agent |",
    "| --- | ---: | ---: | --- |",
    ...rows,
  ].join("\n");
}

function buildMarkdown(date: BriefDate, sessions: BriefSession[]): string {
  const sessionsCount = sessions.length;
  const turnsCount = sessions.reduce((sum, session) => sum + session.turns.length, 0);
  const grouped = new Map<string, BriefProject>();
  for (const session of sessions) {
    const key = session.projectPath || "";
    let project = grouped.get(key);
    if (!project) {
      project = {
        path: session.projectPath,
        name: projectName(session.projectPath),
        sessions: [],
        turns: 0,
      };
      grouped.set(key, project);
    }
    project.sessions.push(session);
    project.turns += session.turns.length;
  }
  const projects = [...grouped.values()].sort((a, b) => {
    const latest = (value: BriefProject) =>
      Math.max(...value.sessions.map((session) => session.updatedAt));
    return latest(b) - latest(a);
  });

  const lines = [
    `# 工作简报 · ${date.label}`,
    "",
    `> ${date.key} · ${projects.length} 个项目 · ${sessionsCount} 个会话 · ${turnsCount} 轮问答 · 生成于 ${clock(Date.now())}`,
    "",
  ];
  if (sessionsCount === 0) {
    lines.push("当日没有记录到会话。", "");
    return lines.join("\n");
  }
  lines.push("## 今日概览", "", overviewTable(projects), "");
  for (const project of projects) {
    lines.push(projectBlock(project));
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function generateBrief(
  db: Database,
  dateInput?: string,
  outDir = BRIEF_DIR,
): BriefResult {
  const date = parseBriefDate(dateInput);
  if (!date) throw new Error(`invalid date: ${dateInput ?? ""}`);
  const sessions = loadSessions(db, date);
  const markdown = buildMarkdown(date, sessions);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${date.key}.md`);
  writeFileSync(path, markdown, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore filesystems without POSIX modes
  }
  return {
    date: date.key,
    path,
    relativePath: relative(PROJECT_ROOT, path),
    markdown,
    sessions: sessions.length,
    turns: sessions.reduce((sum, session) => sum + session.turns.length, 0),
    projects: new Set(sessions.map((session) => session.projectPath)).size,
  };
}

export function readBrief(dateInput: string, outDir = BRIEF_DIR): string | null {
  const date = parseBriefDate(dateInput);
  if (!date) return null;
  try {
    return readFileSync(join(outDir, `${date.key}.md`), "utf8");
  } catch {
    return null;
  }
}
