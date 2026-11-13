import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { AGENT_IDS, AGENT_LABELS } from "./adapters/types.ts";
import type { AgentId } from "./adapters/types.ts";
import { BRIEF_DIR, PROJECT_ROOT } from "./config.ts";
import { BRIEF_LABELS, isBriefLang } from "./brief-lang.ts";
import type { BriefLabels, BriefLang } from "./brief-lang.ts";
import { resumeCommand, sessionDeepLink } from "./util/resume.ts";

/** The template language; session content is never translated. */
export type { BriefLang } from "./brief-lang.ts";

const MAX_PROMPT_CHARS = 220;
const MAX_TITLE_CHARS = 80;
const FALLBACK_TURNS = 12;

export interface BriefDate {
  key: string;
  start: number;
  end: number;
  label: string;
}

export type BriefFormat = "standup" | "archive" | "week";

export interface BriefDay {
  key: string;
  start: number;
  end: number;
}

export interface BriefWeek {
  key: string;
  year: number;
  week: number;
  start: number;
  end: number;
  range: string;
  label: string;
  days: BriefDay[];
}

export interface BriefOptions {
  format?: BriefFormat;
  outDir?: string;
  /** Template language; omitted means `zh`, the original output. */
  lang?: BriefLang;
}

/** Resolve the template language, rejecting anything outside the two tables. */
function resolveBriefLang(value: BriefLang | undefined): BriefLang {
  if (value === undefined) return "zh";
  if (!isBriefLang(value)) throw new Error(`invalid language: ${String(value)}`);
  return value;
}

export interface BriefResult {
  format: BriefFormat;
  /** Daily key for standup/archive, ISO week key for the weekly view. */
  date: string;
  week: string | null;
  range: string | null;
  path: string;
  relativePath: string;
  markdown: string;
  sessions: number;
  turns: number;
  projects: number;
  agents: AgentId[];
  activeDays: number | null;
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

/** Local calendar parts of a timestamp; the report title's date label. */
function dateParts(ms: number): { year: number; monthIndex: number; day: number } {
  const date = new Date(ms);
  return {
    year: date.getFullYear(),
    monthIndex: date.getMonth(),
    day: date.getDate(),
  };
}

function dateText(labels: BriefLabels, ms: number): string {
  const { year, monthIndex, day } = dateParts(ms);
  return labels.date(year, monthIndex, day);
}

/** The ISO week key plus its Monday..Sunday range, in the template language. */
function weekText(labels: BriefLabels, week: BriefWeek): string {
  const first = week.days[0];
  const last = week.days[6];
  return labels.weekLabel(
    week.key,
    first ? monthDay(first.key) : "",
    last ? monthDay(last.key) : "",
  );
}

/** ISO-8601 week key (`YYYY-Www`) for a local timestamp. */
export function isoWeekKey(ms: number): string {
  const date = new Date(ms);
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (thursday.getDay() + 6) % 7;
  thursday.setDate(thursday.getDate() - mondayOffset + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const jan4Offset = (jan4.getDay() + 6) % 7;
  const week1Thursday = new Date(year, 0, 4 - jan4Offset + 3);
  const week =
    Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * 86_400_000)) + 1;
  return `${year}-W${pad(week)}`;
}

function weekStart(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4);
  const jan4Offset = (jan4.getDay() + 6) % 7;
  return new Date(year, 0, 4 - jan4Offset + (week - 1) * 7);
}

function monthDay(key: string): string {
  return key.slice(5);
}

/**
 * `2026-W46` -> Monday..Sunday of that ISO week. Omitting the input means the
 * current week. Week 53 in a 52-week year is rejected instead of rolling into
 * next year.
 */
export function parseBriefWeek(
  input: string | null | undefined,
  now = new Date(),
): BriefWeek | null {
  const raw = input?.trim();
  let year: number;
  let week: number;
  if (raw) {
    const match = /^(\d{4})-W(\d{1,2})$/.exec(raw);
    if (!match) return null;
    year = Number(match[1]);
    week = Number(match[2]);
  } else {
    const key = isoWeekKey(now.getTime());
    year = Number(key.slice(0, 4));
    week = Number(key.slice(6));
  }
  if (week < 1 || week > 53) return null;
  const monday = weekStart(year, week);
  const key = `${year}-W${pad(week)}`;
  if (isoWeekKey(monday.getTime()) !== key) return null;

  const days: BriefDay[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const start = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + offset,
    );
    const end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 1,
    );
    days.push({ key: localDateKey(start), start: start.getTime(), end: end.getTime() });
  }
  const first = days[0] as BriefDay;
  const last = days[6] as BriefDay;
  return {
    key,
    year,
    week,
    start: first.start,
    end: last.end,
    range: `${first.key}..${last.key}`,
    label: `${key}（${monthDay(first.key)} ~ ${monthDay(last.key)}）`,
    days,
  };
}

function oneLine(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  const chars = [...oneLine(value)];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

function projectName(path: string, labels: BriefLabels): string {
  if (!path) return labels.unknownProject;
  return basename(path) || path;
}

function codeSpan(value: string): string {
  const clean = oneLine(value);
  const ticks = clean.includes("`") ? "``" : "`";
  return `${ticks}${clean}${ticks}`;
}

function eventCounts(
  db: Database,
  sessionId: string,
  hasDayTurn: boolean,
  range: BriefDate | BriefWeek,
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
        .all(sessionId, range.start, range.end) as { kind: string; n: number }[])
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

/** Sessions with any turn inside `range`; no-ts sessions by their update time. */
function loadSessions(db: Database, range: BriefDate | BriefWeek): BriefSession[] {
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
      range.start,
      range.end,
      range.start,
      range.end,
      range.start,
      range.end,
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
          .all(row.id, range.start, range.end) as TurnRow[])
      : (db
          .query(
            `SELECT idx, ts, user_text, assistant_text FROM turn
             WHERE session_id = ? ORDER BY idx DESC LIMIT ?`,
          )
          .all(row.id, FALLBACK_TURNS) as TurnRow[]).reverse();

    if (turnRows.length === 0) continue;
    const counts = eventCounts(db, row.id, hasDayTurn, range);
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

function timeLabel(session: BriefSession, labels: BriefLabels): string {
  const times = session.turns.map((turn) => turn.ts).filter((ts) => ts > 0);
  if (times.length > 0) {
    const first = Math.min(...times);
    const last = Math.max(...times);
    return first === last ? clock(first) : `${clock(first)}–${clock(last)}`;
  }
  return session.updatedAt
    ? labels.updatedAt(clock(session.updatedAt))
    : labels.unknownTime;
}

function sessionTitle(session: BriefSession, labels: BriefLabels): string {
  const title = oneLine(session.title);
  if (title) return clip(title, MAX_TITLE_CHARS);
  const firstPrompt = session.turns.find((turn) => oneLine(turn.user_text));
  return firstPrompt
    ? clip(firstPrompt.user_text, MAX_TITLE_CHARS)
    : labels.untitled;
}

function sessionBlock(session: BriefSession, labels: BriefLabels): string {
  const lines: string[] = [`### ${sessionTitle(session, labels)}`, ""];
  const meta = [
    AGENT_LABELS[session.agent],
    timeLabel(session, labels),
    session.hasDayTurn
      ? labels.turnsShort(session.turns.length)
      : labels.recentTurns(session.turns.length),
  ];
  if (session.toolCount || session.reasoningCount) {
    const process: string[] = [];
    if (session.toolCount) process.push(labels.toolsCount(session.toolCount));
    if (session.reasoningCount) {
      process.push(labels.reasoningCount(session.reasoningCount));
    }
    meta.push(process.join(" / "));
  }
  lines.push(meta.join(" · "), "");

  const prompts = session.turns
    .map((turn) => oneLine(turn.user_text))
    .filter(Boolean);
  if (prompts.length > 0) {
    lines.push(labels.promptsHeading, "");
    for (const prompt of prompts) {
      lines.push(`- ${clip(prompt, MAX_PROMPT_CHARS)}`);
    }
    lines.push("");
  }

  const resume = resumeCommand(
    session.agent,
    session.externalId,
    session.projectPath,
  );
  if (resume) {
    lines.push(labels.resumeLine(codeSpan(resume)), "");
  }

  // A stable address for the app itself: `http://127.0.0.1:<port>` would be the
  // port of whichever launch generated the brief, and would die on the next one
  // (and land in a browser when clicked from outside the app).
  const link = sessionDeepLink(session.id);
  lines.push(labels.openLink(link), "");
  return lines.join("\n");
}

function projectBlock(project: BriefProject, labels: BriefLabels): string {
  const lines = [`## ${oneLine(project.name)}`, ""];
  if (project.path) lines.push(codeSpan(project.path), "");
  for (const session of project.sessions) {
    lines.push(sessionBlock(session, labels));
  }
  return lines.join("\n");
}

function overviewTable(projects: BriefProject[], labels: BriefLabels): string {
  const rows = projects.map((project) => {
    const agents = [
      ...new Set(project.sessions.map((session) => AGENT_LABELS[session.agent])),
    ].join(labels.joinList);
    return `| ${oneLine(project.name).replace(/\|/g, "\\|")} | ${project.sessions.length} | ${project.turns} | ${agents} |`;
  });
  return [
    labels.projectTableHeader,
    "| --- | ---: | ---: | --- |",
    ...rows,
  ].join("\n");
}

/** Sessions grouped by project, newest activity first. Shared by all views. */
function groupProjects(sessions: BriefSession[], labels: BriefLabels): BriefProject[] {
  const grouped = new Map<string, BriefProject>();
  for (const session of sessions) {
    const key = session.projectPath || "";
    let project = grouped.get(key);
    if (!project) {
      project = {
        path: session.projectPath,
        name: projectName(session.projectPath, labels),
        sessions: [],
        turns: 0,
      };
      grouped.set(key, project);
    }
    project.sessions.push(session);
    project.turns += session.turns.length;
  }
  return [...grouped.values()].sort((a, b) => {
    const latest = (value: BriefProject) =>
      Math.max(...value.sessions.map((session) => session.updatedAt));
    return latest(b) - latest(a);
  });
}

function buildMarkdown(
  date: BriefDate,
  sessions: BriefSession[],
  labels: BriefLabels,
): string {
  const sessionsCount = sessions.length;
  const turnsCount = sessions.reduce((sum, session) => sum + session.turns.length, 0);
  const projects = groupProjects(sessions, labels);

  const lines = [
    labels.archiveTitle(dateText(labels, date.start)),
    "",
    labels.archiveMeta(
      date.key,
      projects.length,
      sessionsCount,
      turnsCount,
      clock(Date.now()),
    ),
    "",
  ];
  if (sessionsCount === 0) {
    lines.push(labels.noSessionsToday, "");
    return lines.join("\n");
  }
  lines.push(`## ${labels.sections.archiveOverview}`, "", overviewTable(projects, labels), "");
  for (const project of projects) {
    lines.push(projectBlock(project, labels));
  }
  return lines.join("\n").trimEnd() + "\n";
}

const COMPLETION =
  /(^|[^未])完成|已(修复|提交|推送|合入|上线|通过)|测试通过|fixed|done|shipped|completed|merged/i;
// Markers are language-independent: both template languages extract the same
// items from the same sessions. `next step` is the English counterpart of 下一步.
const PENDING_MARK = /待办|下一步|next step|TODO/i;
const RISK_MARK = /风险|阻塞|blocked|blocker|risk|未解决/i;
const UNCHECKED = /^\s*[-*]\s*\[\s*\]\s+(.+?)\s*$/;
const DECISION_MARK = /<!--\s*decision\s*:\s*([\s\S]*?)-->/gi;

function lastAssistantText(turns: TurnRow[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = turns[index]?.assistant_text ?? "";
    if (text.trim()) return text;
  }
  return "";
}

function agentsFor(sessions: BriefSession[]): AgentId[] {
  const present = new Set(sessions.map((session) => session.agent));
  return AGENT_IDS.filter((agent) => present.has(agent));
}

function agentsYaml(agents: AgentId[]): string {
  return `[${agents.join(", ")}]`;
}

function frontMatter(fields: [string, string][]): string {
  return ["---", ...fields.map(([key, value]) => `${key}: ${value}`), "---", ""].join(
    "\n",
  );
}

function generatedAt(now = new Date()): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return `${localDateKey(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
    now.getSeconds(),
  )}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function cleanBullet(line: string): string {
  return oneLine(line)
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^#+\s+/, "");
}

/** Explicit `<!-- decision: ... -->` markers in assistant answers only. */
function decisionsIn(turns: TurnRow[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (!turn.assistant_text) continue;
    DECISION_MARK.lastIndex = 0;
    for (;;) {
      const match = DECISION_MARK.exec(turn.assistant_text);
      if (!match) break;
      const item = oneLine(match[1] ?? "");
      if (item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

/**
 * Reject extraction noise: schema snippets, code, tables and long paragraphs
 * can all contain "待办/下一步" or "风险" without being a real item.
 */
function isCleanItem(item: string): boolean {
  if (!item) return false;
  if (item.length > 120) return false;
  if (/description\s*:/i.test(item)) return false;
  if (/[{}|]/.test(item)) return false;
  if (/[`]/.test(item)) return false;
  return true;
}

// No \b after CJK: Chinese characters and ASCII punctuation are both non-word
// characters in JS, so a word boundary never appears between them.
const STARTS_MARK = /^\s*(?:待办|下一步|next step)/i;
const STARTS_TODO = /^\s*TODO\b/i;

/** Unchecked boxes and 待办/下一步/TODO list items from one assistant message. */
function pendingFromAnswer(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const unchecked = UNCHECKED.exec(line);
    if (unchecked) {
      const item = oneLine(unchecked[1] ?? "");
      if (isCleanItem(item)) out.push(item);
      continue;
    }
    if (!PENDING_MARK.test(line)) continue;
    // The cleaned item must *start* with the marker; a passing mention mid
    // sentence (or inside a schema fragment) is not a task.
    const item = cleanBullet(line).replace(/^[*_\s]+/, "");
    if (!STARTS_MARK.test(item) && !STARTS_TODO.test(item)) continue;
    if (isCleanItem(item)) out.push(item);
  }
  return out;
}

function collectPending(
  sessions: BriefSession[],
  totalCap = 10,
  perSessionCap = 3,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const session of sessions) {
    for (const item of pendingFromAnswer(lastAssistantText(session.turns)).slice(
      0,
      perSessionCap,
    )) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length >= totalCap) return out;
    }
  }
  return out;
}

function collectRisks(sessions: BriefSession[], cap = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const session of sessions) {
    let inFence = false;
    for (const line of lastAssistantText(session.turns).split(/\r?\n/)) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (!RISK_MARK.test(line)) continue;
      // Same guard as tasks: the cleaned item must start with the marker, so a
      // passing mention ("…风险项留到最后…") is not counted as a blocker.
      const item = clip(cleanBullet(line).replace(/^[*_\s]+/, ""), 120);
      if (
        !/^(?:风险|阻塞|未解决)/i.test(item) &&
        !/^(?:blocked|blocker|risk)\b/i.test(item)
      ) {
        continue;
      }
      if (!isCleanItem(item) || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Standup keeps raw prompts out, including the title fallback archive uses. */
function reportTitle(session: BriefSession, labels: BriefLabels): string {
  const title = oneLine(session.title);
  return title ? clip(title, MAX_TITLE_CHARS) : labels.untitled;
}

function isCompleted(session: BriefSession): boolean {
  const last = lastAssistantText(session.turns);
  return last ? COMPLETION.test(last) : false;
}

function buildStandup(
  date: BriefDate,
  sessions: BriefSession[],
  labels: BriefLabels,
): string {
  const projects = groupProjects(sessions, labels);
  const turns = sessions.reduce((sum, session) => sum + session.turns.length, 0);
  const agents = agentsFor(sessions);
  const top = projects.reduce<BriefProject | null>(
    (best, project) => (best === null || project.turns > best.turns ? project : best),
    null,
  );
  const decisions = decisionsIn(sessions.flatMap((session) => session.turns));
  const pending = collectPending(sessions);

  const lines: string[] = [
    frontMatter([
      ["kind", "daily"],
      ["lang", labels.lang],
      ["date", date.key],
      ["projects", String(projects.length)],
      ["sessions", String(sessions.length)],
      ["turns", String(turns)],
      ["agents", agentsYaml(agents)],
      ["generated_at", generatedAt()],
    ]),
    labels.dailyTitle(
      dateText(labels, date.start),
      labels.weekday(new Date(date.start).getDay()),
    ),
    "",
  ];

  if (sessions.length === 0) {
    lines.push(labels.oneLine(labels.noSessionsToday), "");
    lines.push(`## ${labels.sections.progress}`, "", `- ${labels.none}`, "");
  } else {
    const focus = top ? labels.summaryFocus(oneLine(top.name), top.turns) : "";
    lines.push(
      labels.oneLine(
        `${labels.summary(projects.length, sessions.length, turns)}${focus}${labels.sentenceEnd}`,
      ),
      "",
      `## ${labels.sections.progress}`,
      "",
    );
    for (const project of projects) {
      lines.push(`**${oneLine(project.name)}**`, "");
      for (const session of project.sessions) {
        // A conclusion, not a dump: the session title and its size. Raw answer
        // text stays out of the standup; open the link for detail.
        lines.push(
          labels.sessionBullet(
            reportTitle(session, labels),
            session.turns.length,
          ),
        );
      }
      lines.push("");
    }
  }

  lines.push(`## ${labels.sections.decisions}`, "");
  if (decisions.length > 0) {
    for (const decision of decisions) lines.push(`- ${decision}`);
  } else {
    lines.push(`- ${labels.noDecision}`);
  }
  lines.push("", `## ${labels.sections.pending}`, "");
  if (pending.length > 0) {
    for (const item of pending) lines.push(`- [ ] ${item}`);
  } else {
    lines.push(`- ${labels.noPending}`);
  }
  lines.push("", `## ${labels.sections.firstTask}`, "");
  lines.push(
    pending[0] ?? (top ? labels.continueProject(oneLine(top.name)) : "—"),
  );
  lines.push("", `## ${labels.sections.overview}`, "");
  lines.push(
    projects.length > 0 ? overviewTable(projects, labels) : labels.none,
  );
  return lines.join("\n").trimEnd() + "\n";
}

interface WeekDayStat {
  day: BriefDay;
  sessions: number;
  turns: number;
  projects: number;
}

function buildWeek(
  week: BriefWeek,
  sessions: BriefSession[],
  projects: BriefProject[],
  stats: WeekDayStat[],
  labels: BriefLabels,
): string {
  const turns = sessions.reduce((sum, session) => sum + session.turns.length, 0);
  const agents = agentsFor(sessions);
  const activeDays = stats.filter((stat) => stat.sessions > 0).length;
  const decisions = decisionsIn(sessions.flatMap((session) => session.turns));
  const pending = collectPending(sessions);
  const risks = collectRisks(sessions);
  const top = [...projects].sort((a, b) => b.turns - a.turns);

  const lines: string[] = [
    frontMatter([
      ["kind", "weekly"],
      ["lang", labels.lang],
      ["week", week.key],
      ["range", week.range],
      ["active_days", String(activeDays)],
      ["projects", String(projects.length)],
      ["sessions", String(sessions.length)],
      ["turns", String(turns)],
      ["agents", agentsYaml(agents)],
      ["generated_at", generatedAt()],
    ]),
    labels.weeklyTitle(weekText(labels, week)),
    "",
  ];

  if (sessions.length === 0) {
    lines.push(labels.weekLine(labels.noSessionsWeek), "");
  } else {
    lines.push(
      labels.weekLine(
        `${labels.weekSummary(projects.length, sessions.length, turns, activeDays)}${labels.sentenceEnd}`,
      ),
      "",
    );
  }

  lines.push(`## ${labels.sections.highlights}`, "");
  if (top.length === 0) {
    lines.push(`- ${labels.none}`);
  } else {
    for (const project of top.slice(0, 3)) {
      const latest = project.sessions[0];
      const when = latest ? monthDay(localDateKey(new Date(latest.updatedAt))) : "";
      const latestText = latest
        ? labels.highlightLatest(when, sessionTitle(latest, labels))
        : "";
      lines.push(
        labels.highlightLine(
          oneLine(project.name),
          project.sessions.length,
          project.turns,
          latestText,
        ),
      );
    }
  }

  lines.push("", `## ${labels.sections.byProject}`, "");
  if (projects.length === 0) {
    lines.push(`- ${labels.none}`);
  } else {
    for (const project of projects) {
      lines.push(`**${oneLine(project.name)}**`, "");
      const completed = project.sessions.filter(isCompleted);
      const ongoing = project.sessions.filter((session) => !isCompleted(session));
      if (completed.length > 0) {
        lines.push(
          labels.doneLine(
            completed.map((session) => sessionTitle(session, labels)),
          ),
        );
      }
      if (ongoing.length > 0) {
        lines.push(
          labels.ongoingLine(
            ongoing.map((session) => sessionTitle(session, labels)),
          ),
        );
      }
      const next = collectPending(project.sessions, 3, 2);
      if (next.length > 0) {
        lines.push(labels.nextLine(next));
      }
      lines.push("");
    }
  }

  lines.push(`## ${labels.sections.themes}`, "");
  if (decisions.length > 0) {
    for (const decision of decisions) lines.push(`- ${decision}`);
  } else {
    lines.push(`- ${labels.noWeekDecision}`);
  }

  lines.push("", `## ${labels.sections.metrics}`, "");
  const active = stats.filter((stat) => stat.sessions > 0);
  if (active.length === 0) {
    lines.push(labels.metricsEmpty);
  } else {
    lines.push(labels.weekTableHeader, "| --- | ---: | ---: | ---: |");
    for (const stat of active) {
      lines.push(
        `| ${monthDay(stat.day.key)} | ${stat.sessions} | ${stat.turns} | ${stat.projects} |`,
      );
    }
  }

  lines.push("", `## ${labels.sections.risks}`, "");
  if (risks.length > 0) {
    for (const risk of risks) lines.push(`- ${risk}`);
  } else {
    lines.push(`- ${labels.noRisk}`);
  }

  lines.push("", `## ${labels.sections.nextWeek}`, "");
  if (pending.length > 0) {
    for (const item of pending) lines.push(`- [ ] ${item}`);
  } else {
    lines.push(`- ${labels.noPending}`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

function writeText(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore filesystems without POSIX modes
  }
}

/** Keep `brief/index.md` as a short, newest-first entry list. */
function updateBriefIndex(outDir: string): void {
  const sections: string[] = [];
  // Language-neutral: one cumulative list may mix reports from both templates.
  const groups = [
    ["daily", "Daily", 14],
    ["weekly", "Weekly", 8],
  ] as const;
  for (const [dir, title, limit] of groups) {
    let names: string[];
    try {
      names = readdirSync(join(outDir, dir)).filter((name) => name.endsWith(".md"));
    } catch {
      continue;
    }
    const rows = names
      .sort()
      .reverse()
      .slice(0, limit)
      .map((name) => `- [${name.replace(/\.md$/, "")}](${dir}/${name})`);
    if (rows.length > 0) sections.push(`## ${title}`, "", ...rows, "");
  }
  if (sections.length === 0) return;
  writeText(join(outDir, "index.md"), ["# Briefs", "", ...sections].join("\n").trimEnd() + "\n");
}

function dailyTotals(
  sessions: BriefSession[],
  labels: BriefLabels,
): { turns: number; projects: number } {
  return {
    turns: sessions.reduce((sum, session) => sum + session.turns.length, 0),
    projects: groupProjects(sessions, labels).length,
  };
}

export function generateBrief(
  db: Database,
  dateInput?: string,
  options: BriefOptions = {},
): BriefResult {
  const lang = resolveBriefLang(options.lang);
  const labels = BRIEF_LABELS[lang];
  const format = options.format ?? "standup";
  if (format === "week") {
    throw new Error("weekly reports are generated with generateWeekReport");
  }
  const outDir = options.outDir ?? BRIEF_DIR;
  const date = parseBriefDate(dateInput);
  if (!date) throw new Error(`invalid date: ${dateInput ?? ""}`);
  const sessions = loadSessions(db, date);
  const totals = dailyTotals(sessions, labels);
  const markdown =
    format === "archive"
      ? buildMarkdown(date, sessions, labels)
      : buildStandup(date, sessions, labels);
  // Archive keeps the legacy `<date>.md` path; standup gets its own daily tree.
  const path =
    format === "archive"
      ? join(outDir, `${date.key}.md`)
      : join(outDir, "daily", `${date.key}.md`);
  writeText(path, markdown);
  updateBriefIndex(outDir);
  return {
    format,
    date: date.key,
    week: null,
    range: null,
    path,
    relativePath: relative(PROJECT_ROOT, path),
    markdown,
    sessions: sessions.length,
    turns: totals.turns,
    projects: totals.projects,
    agents: agentsFor(sessions),
    activeDays: null,
  };
}

export interface WeekReportOptions {
  outDir?: string;
  /** Template language; omitted means `zh`, the original output. */
  lang?: BriefLang;
}

export function generateWeekReport(
  db: Database,
  weekInput?: string,
  options: WeekReportOptions = {},
): BriefResult {
  const lang = resolveBriefLang(options.lang);
  const labels = BRIEF_LABELS[lang];
  const outDir = options.outDir ?? BRIEF_DIR;
  const week = parseBriefWeek(weekInput);
  if (!week) throw new Error(`invalid week: ${weekInput ?? ""}`);
  const sessions = loadSessions(db, week);
  const projects = groupProjects(sessions, labels);
  const stats: WeekDayStat[] = week.days.map((day) => ({
    day,
    sessions: 0,
    turns: 0,
    projects: 0,
  }));
  const perDayProjects = new Map<string, Set<string>>();
  for (const session of sessions) {
    const times = session.turns.map((turn) => turn.ts).filter((ts) => ts > 0);
    const lastTs = times.length > 0 ? Math.max(...times) : session.updatedAt;
    const clamped = Math.min(Math.max(lastTs, week.start), week.end - 1);
    const key = localDateKey(new Date(clamped));
    const stat = stats.find((row) => row.day.key === key) ?? stats[stats.length - 1];
    if (!stat) continue;
    stat.sessions += 1;
    stat.turns += session.turns.length;
    const paths = perDayProjects.get(stat.day.key) ?? new Set<string>();
    paths.add(session.projectPath || "");
    perDayProjects.set(stat.day.key, paths);
  }
  for (const stat of stats) {
    stat.projects = perDayProjects.get(stat.day.key)?.size ?? 0;
  }
  const markdown = buildWeek(week, sessions, projects, stats, labels);
  const path = join(outDir, "weekly", `${week.key}.md`);
  writeText(path, markdown);
  updateBriefIndex(outDir);
  return {
    format: "week",
    date: week.key,
    week: week.key,
    range: week.range,
    path,
    relativePath: relative(PROJECT_ROOT, path),
    markdown,
    sessions: sessions.length,
    turns: sessions.reduce((sum, session) => sum + session.turns.length, 0),
    projects: projects.length,
    agents: agentsFor(sessions),
    activeDays: stats.filter((stat) => stat.sessions > 0).length,
  };
}

export interface ReadBriefOptions {
  format?: BriefFormat;
  date?: string;
  week?: string;
  outDir?: string;
}

export function readBrief(options: ReadBriefOptions): string | null {
  const outDir = options.outDir ?? BRIEF_DIR;
  const format = options.format ?? "standup";
  if (format === "week") {
    const week = parseBriefWeek(options.week);
    if (!week) return null;
    try {
      return readFileSync(join(outDir, "weekly", `${week.key}.md`), "utf8");
    } catch {
      return null;
    }
  }
  const date = parseBriefDate(options.date);
  if (!date) return null;
  const path =
    format === "archive"
      ? join(outDir, `${date.key}.md`)
      : join(outDir, "daily", `${date.key}.md`);
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `readdirSync` with directories included, and a missing dir as nothing. */
function briefDirEntries(dir: string): { name: string; isDirectory(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Generated brief files that still quote a session. A brief is a plain Markdown
 * snapshot, so forgetting the session cannot rewrite it: the caller reports the
 * files that have to be regenerated or deleted by hand. Every brief links to the
 * session it came from, and the deep link carries the encoded session id.
 */
export function briefFilesMentioning(sessionId: string, outDir: string = BRIEF_DIR): string[] {
  const needle = encodeURIComponent(sessionId);
  const found: string[] = [];
  const scanDir = (dir: string): void => {
    for (const entry of briefDirEntries(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(path);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      try {
        if (readFileSync(path, "utf8").includes(needle)) {
          found.push(relative(PROJECT_ROOT, path));
        }
      } catch {
        // An unreadable brief cannot be reported, and must not fail the forget.
      }
    }
  };
  scanDir(outDir);
  return found;
}
