/**
 * Structural copy for generated reports.
 *
 * A report is a template plus verbatim session content: titles, prompts and
 * answers stay in whatever language they were written in, while every heading,
 * label and counter comes from one of these tables. `zh` is the original
 * template, so omitting a language keeps the output byte-for-byte as before;
 * `en` is a full translation with ASCII punctuation and fixed month/weekday
 * names (no `Intl`, so output cannot vary between machines).
 *
 * Keep the two tables in step: `BriefLabels` makes a missing entry a type error
 * once the file is type-checked, and `test/brief-lang.test.ts` renders both
 * languages so a stray Chinese structural string shows up as Han characters in
 * the English report.
 */

export type BriefLang = "zh" | "en";

export function isBriefLang(value: unknown): value is BriefLang {
  return value === "zh" || value === "en";
}

/** Fixed names: `Intl` month/weekday names vary by runtime and locale data. */
const ZH_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Every structural string a build function can emit. Functions rather than raw
 * strings where a phrase carries a count, a name or another fragment: each
 * language needs its own word order and punctuation, not a translated slot.
 */
export interface BriefLabels {
  readonly lang: BriefLang;
  /* Document titles (the builders append the heading marker). */
  readonly dailyTitle: (date: string, weekday: string) => string;
  readonly weeklyTitle: (week: string) => string;
  readonly archiveTitle: (date: string) => string;
  /* Summary lines. */
  readonly oneLine: (summary: string) => string;
  readonly weekLine: (summary: string) => string;
  readonly summary: (projects: number, sessions: number, turns: number) => string;
  readonly summaryFocus: (name: string, turns: number) => string;
  readonly weekSummary: (
    projects: number,
    sessions: number,
    turns: number,
    activeDays: number,
  ) => string;
  readonly sentenceEnd: string;
  /* Section headings, without the `## ` marker. */
  readonly sections: {
    readonly comparison: string;
    readonly rankings: string;
    readonly progress: string;
    readonly decisions: string;
    readonly pending: string;
    readonly firstTask: string;
    readonly overview: string;
    readonly archiveOverview: string;
    readonly monthOverview: string;
    readonly highlights: string;
    readonly byProject: string;
    readonly themes: string;
    readonly metrics: string;
    readonly risks: string;
    readonly nextWeek: string;
  };
  /* Empty and placeholder copy. */
  readonly none: string;
  readonly noSessionsToday: string;
  readonly noSessionsWeek: string;
  readonly untitled: string;
  readonly unknownProject: string;
  readonly noDecision: string;
  readonly noWeekDecision: string;
  readonly noPending: string;
  readonly noRisk: string;
  readonly metricsEmpty: string;
  readonly unknownTime: string;
  readonly continueProject: (name: string) => string;
  /* Standup and weekly lines. */
  readonly sessionBullet: (title: string, turns: number) => string;
  readonly highlightLine: (
    name: string,
    sessions: number,
    turns: number,
    latest: string,
  ) => string;
  readonly highlightLatest: (when: string, title: string) => string;
  readonly doneLine: (titles: string[]) => string;
  readonly ongoingLine: (titles: string[]) => string;
  readonly nextLine: (items: string[]) => string;
  /* Archive view. */
  readonly archiveMeta: (
    key: string,
    projects: number,
    sessions: number,
    turns: number,
    time: string,
  ) => string;
  readonly promptsHeading: string;
  readonly resumeLine: (code: string) => string;
  readonly openLink: (link: string) => string;
  readonly turnsShort: (turns: number) => string;
  readonly recentTurns: (turns: number) => string;
  readonly toolsCount: (tools: number) => string;
  readonly reasoningCount: (items: number) => string;
  readonly updatedAt: (time: string) => string;
  /* Tables. */
  readonly projectTableHeader: string;
  readonly weekTableHeader: string;
  /* Dates. `monthIndex` is 0-based, `dayIndex` is `Date#getDay()`. */
  readonly date: (year: number, monthIndex: number, day: number) => string;
  readonly weekday: (dayIndex: number) => string;
  readonly weekLabel: (key: string, start: string, end: string) => string;
  /* Counters, also used by the summary builders. */
  readonly projectsCount: (projects: number) => string;
  readonly sessionsCount: (sessions: number) => string;
  readonly turnsCount: (turns: number) => string;
  readonly activeDaysCount: (days: number) => string;
  /* Separators for verbatim lists. */
  readonly joinList: string;
  readonly joinClause: string;
}

const zh: BriefLabels = {
  lang: "zh",
  dailyTitle: (date, weekday) => `# 日报 · ${date} ${weekday}`,
  weeklyTitle: (week) => `# 周报 · ${week}`,
  archiveTitle: (date) => `# 工作简报 · ${date}`,
  oneLine: (summary) => `**一句话**：${summary}`,
  weekLine: (summary) => `**本周一句话**：${summary}`,
  summary: (projects, sessions, turns) =>
    `${projects} 个项目、${sessions} 个会话、${turns} 轮问答`,
  summaryFocus: (name, turns) => `，主要集中在 ${name}（${turns} 轮）`,
  weekSummary: (projects, sessions, turns, activeDays) =>
    `${projects} 个项目、${sessions} 个会话、${turns} 轮问答，跨 ${activeDays} 个活跃日`,
  sentenceEnd: "。",
  sections: {
    comparison: "与上期对比",
    rankings: "排行",
    progress: "进展",
    decisions: "决策",
    pending: "待续",
    firstTask: "明天第一件事",
    overview: "概览",
    archiveOverview: "今日概览",
    monthOverview: "本月概览",
    highlights: "亮点",
    byProject: "按项目",
    themes: "主题与决策",
    metrics: "指标",
    risks: "风险 / 阻塞",
    nextWeek: "下周计划",
  },
  none: "（无）",
  noSessionsToday: "当日没有记录到会话。",
  noSessionsWeek: "本周没有记录到会话。",
  untitled: "未命名会话",
  unknownProject: "未识别项目",
  noDecision: "（没有显式 decision 标记）",
  noWeekDecision: "（本周没有显式 decision 标记）",
  noPending: "（没有从最后一条回答里提取到待办）",
  noRisk: "（未从最后一条回答中提取到风险）",
  metricsEmpty: "（本周没有记录到会话）",
  unknownTime: "时间未知",
  continueProject: (name) => `继续推进 **${name}**`,
  sessionBullet: (title, turns) => `- **${title}**（${turns} 轮）`,
  highlightLine: (name, sessions, turns, latest) =>
    `- **${name}**：${sessions} 个会话 / ${turns} 轮${latest}`,
  highlightLatest: (when, title) => `；最近 ${when} ${title}`,
  doneLine: (titles) => `- 完成：${titles.join("、")}`,
  ongoingLine: (titles) => `- 进行中：${titles.join("、")}`,
  nextLine: (items) => `- 下周：${items.join("；")}`,
  archiveMeta: (key, projects, sessions, turns, time) =>
    `> ${key} · ${projects} 个项目 · ${sessions} 个会话 · ${turns} 轮问答 · 生成于 ${time}`,
  promptsHeading: "**提问**",
  resumeLine: (code) => `**继续**：${code}`,
  openLink: (link) => `[在 session-recall 打开](${link})`,
  turnsShort: (turns) => `${turns} 轮`,
  recentTurns: (turns) => `最近 ${turns} 轮`,
  toolsCount: (tools) => `工具 ${tools}`,
  reasoningCount: (items) => `思考 ${items}`,
  updatedAt: (time) => `更新于 ${time}`,
  projectTableHeader: "| 项目 | 会话 | 问答 | Agent |",
  weekTableHeader: "| 日期 | 会话 | 问答 | 活跃项目 |",
  date: (year, monthIndex, day) => `${year}年${monthIndex + 1}月${day}日`,
  weekday: (dayIndex) => ZH_WEEKDAYS[dayIndex] ?? "",
  weekLabel: (key, start, end) => `${key}（${start} ~ ${end}）`,
  projectsCount: (projects) => `${projects} 个项目`,
  sessionsCount: (sessions) => `${sessions} 个会话`,
  turnsCount: (turns) => `${turns} 轮问答`,
  activeDaysCount: (days) => `${days} 个活跃日`,
  joinList: "、",
  joinClause: "；",
};

const en: BriefLabels = {
  lang: "en",
  dailyTitle: (date, weekday) => `# Daily · ${weekday}, ${date}`,
  weeklyTitle: (week) => `# Weekly · ${week}`,
  archiveTitle: (date) => `# Work brief · ${date}`,
  oneLine: (summary) => `**One line**: ${summary}`,
  weekLine: (summary) => `**This week in one line**: ${summary}`,
  summary: (projects, sessions, turns) =>
    `${plural(projects, "project", "projects")}, ${plural(sessions, "session", "sessions")}, ${plural(turns, "turn", "turns")}`,
  summaryFocus: (name, turns) => `, mainly in ${name} (${plural(turns, "turn", "turns")})`,
  weekSummary: (projects, sessions, turns, activeDays) =>
    `${plural(projects, "project", "projects")}, ${plural(sessions, "session", "sessions")}, ${plural(turns, "turn", "turns")}, across ${plural(activeDays, "active day", "active days")}`,
  sentenceEnd: ".",
  sections: {
    comparison: "Compared with the previous period",
    rankings: "Rankings",
    progress: "Progress",
    decisions: "Decisions",
    pending: "Open threads",
    firstTask: "First task tomorrow",
    overview: "Overview",
    archiveOverview: "Overview",
    monthOverview: "Overview",
    highlights: "Highlights",
    byProject: "By project",
    themes: "Themes and decisions",
    metrics: "Metrics",
    risks: "Risks",
    nextWeek: "Next week",
  },
  none: "(none)",
  noSessionsToday: "No sessions recorded on this day.",
  noSessionsWeek: "No sessions recorded this week.",
  untitled: "Untitled session",
  unknownProject: "Unrecognized project",
  noDecision: "(no explicit decision markers)",
  noWeekDecision: "(no explicit decision markers this week)",
  noPending: "(no to-dos extracted from the last answer)",
  noRisk: "(no risks extracted from the last answer)",
  metricsEmpty: "(no sessions recorded this week)",
  unknownTime: "time unknown",
  continueProject: (name) => `Continue working on **${name}**`,
  sessionBullet: (title, turns) => `- **${title}** (${plural(turns, "turn", "turns")})`,
  highlightLine: (name, sessions, turns, latest) =>
    `- **${name}**: ${plural(sessions, "session", "sessions")} / ${plural(turns, "turn", "turns")}${latest}`,
  highlightLatest: (when, title) => `; latest ${when} ${title}`,
  doneLine: (titles) => `- Done: ${titles.join(", ")}`,
  ongoingLine: (titles) => `- In progress: ${titles.join(", ")}`,
  nextLine: (items) => `- Next week: ${items.join("; ")}`,
  archiveMeta: (key, projects, sessions, turns, time) =>
    `> ${key} · ${plural(projects, "project", "projects")} · ${plural(sessions, "session", "sessions")} · ${plural(turns, "turn", "turns")} · generated at ${time}`,
  promptsHeading: "**Questions**",
  resumeLine: (code) => `**Resume**: ${code}`,
  openLink: (link) => `[Open in session-recall](${link})`,
  turnsShort: (turns) => plural(turns, "turn", "turns"),
  recentTurns: (turns) => `latest ${plural(turns, "turn", "turns")}`,
  toolsCount: (tools) => `tools ${tools}`,
  reasoningCount: (items) => `reasoning ${items}`,
  updatedAt: (time) => `updated at ${time}`,
  projectTableHeader: "| Project | Sessions | Turns | Agent |",
  weekTableHeader: "| Date | Sessions | Turns | Active projects |",
  date: (year, monthIndex, day) =>
    `${EN_MONTHS[monthIndex] ?? ""} ${day}, ${year}`,
  weekday: (dayIndex) => EN_WEEKDAYS[dayIndex] ?? "",
  // The range arrives as the ISO `MM-DD` keys; English reports use slashes.
  weekLabel: (key, start, end) =>
    `${key} · ${start.replace("-", "/")}–${end.replace("-", "/")}`,
  projectsCount: (projects) => plural(projects, "project", "projects"),
  sessionsCount: (sessions) => plural(sessions, "session", "sessions"),
  turnsCount: (turns) => plural(turns, "turn", "turns"),
  activeDaysCount: (days) => plural(days, "active day", "active days"),
  joinList: ", ",
  joinClause: "; ",
};

export const BRIEF_LABELS: Record<BriefLang, BriefLabels> = { zh, en };

/**
 * Labels for the 1.8.0 usage-report additions (monthly framing, period
 * comparisons and rankings). Kept in a separate table so the original
 * `BriefLabels` contract for daily/standup/weekly output stays untouched.
 */
export interface ReportLabels {
  readonly monthlyTitle: (month: string) => string;
  readonly monthlyFraming: (activeProjects: number, totalProjects: number) => string;
  readonly comparisonHeading: (previous: string) => string;
  readonly noPreviousData: string;
  readonly comparisonTableHeader: string;
  readonly metricSessions: string;
  readonly metricTurns: string;
  readonly metricProjects: string;
  readonly movedUp: string;
  readonly movedDown: string;
  readonly agentShareChanged: (agent: string, current: number, previous: number) => string;
  readonly rankingsHeading: string;
  readonly topProjects: string;
  readonly topAgents: string;
  readonly busiestDays: string;
  readonly busiestHours: string;
  readonly none: string;
  readonly turnsUnit: string;
  readonly turnsUnitOne: string;
  readonly sessionsUnit: string;
  readonly sessionsUnitOne: string;
  readonly rankRow: (name: string, value: number, unitOne: string, unitMany: string) => string;
  readonly hourLabel: (hour: string) => string;
  readonly previousWeek: (key: string) => string;
  readonly previousMonth: (key: string) => string;
  readonly deltaUp: (n: number) => string;
  readonly deltaDown: (n: number) => string;
  readonly deltaSame: string;
  readonly moverLine: (name: string, value: number) => string;
}

const reportZh: ReportLabels = {
  monthlyTitle: (month) => `# 月报 · ${month}`,
  monthlyFraming: (active, total) =>
    `本月有 ${active} 个项目产生会话${total > active ? `，索引中共有 ${total} 个项目` : ""}。`,
  comparisonHeading: (previous) => `### 对比 ${previous}`,
  noPreviousData: "上一周期没有记录到会话，无法计算变化。",
  comparisonTableHeader: "| 指标 | 本期 | 上期 | 变化 |",
  metricSessions: "会话",
  metricTurns: "问答轮次",
  metricProjects: "活跃项目",
  movedUp: "增长最多",
  movedDown: "下降最多",
  agentShareChanged: (agent, current, previous) =>
    `${agent}：${previous}% → ${current}%`,
  rankingsHeading: "## 排行",
  topProjects: "按问答轮次排名的项目",
  topAgents: "按会话数排名的 Agent",
  busiestDays: "最活跃的日子",
  busiestHours: "最活跃的时段",
  none: "（无）",
  turnsUnit: "轮",
  turnsUnitOne: "轮",
  sessionsUnit: "个会话",
  sessionsUnitOne: "个会话",
  rankRow: (name, value, unitOne) => `${name}：${value} ${unitOne}`,
  hourLabel: (hour) => `${hour}:00–${hour}:59`,
  previousWeek: (key) => `上周（${key}）`,
  previousMonth: (key) => `上月（${key}）`,
  deltaUp: (n) => `+${n}`,
  deltaDown: (n) => `-${n}`,
  deltaSame: "持平",
  moverLine: (name, value) => `${name}（${value} 轮）`,
};

const reportEn: ReportLabels = {
  monthlyTitle: (month) => `# Monthly · ${month}`,
  monthlyFraming: (active, total) =>
    `${active} ${active === 1 ? "project was" : "projects were"} active this month${total > active ? `, out of ${total} in the index` : ""}.`,
  comparisonHeading: (previous) => `### Compared with ${previous}`,
  noPreviousData: "No sessions were recorded in the previous period, so no deltas can be computed.",
  comparisonTableHeader: "| Metric | This period | Previous | Change |",
  metricSessions: "Sessions",
  metricTurns: "Turns",
  metricProjects: "Active projects",
  movedUp: "Biggest gain",
  movedDown: "Biggest drop",
  agentShareChanged: (agent, current, previous) =>
    `${agent}: ${previous}% → ${current}%`,
  rankingsHeading: "## Rankings",
  topProjects: "Top projects by turns",
  topAgents: "Top agents by sessions",
  busiestDays: "Busiest days",
  busiestHours: "Busiest hours",
  none: "(none)",
  turnsUnit: "turns",
  turnsUnitOne: "turn",
  sessionsUnit: "sessions",
  sessionsUnitOne: "session",
  rankRow: (name, value, unitOne, unitMany) =>
    `${name}: ${value} ${value === 1 ? unitOne : unitMany}`,
  hourLabel: (hour) => `${hour}:00–${hour}:59`,
  previousWeek: (key) => `last week (${key})`,
  previousMonth: (key) => `last month (${key})`,
  deltaUp: (n) => `+${n}`,
  deltaDown: (n) => `-${n}`,
  deltaSame: "unchanged",
  moverLine: (name, value) => `${name} (${value} turns)`,
};

export const REPORT_LABELS: Record<BriefLang, ReportLabels> = {
  zh: reportZh,
  en: reportEn,
};
