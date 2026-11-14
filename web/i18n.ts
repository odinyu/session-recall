/**
 * Interface copy for the two UI languages.
 *
 * Only *chrome* lives here: filters, buttons, headings, empty and error states,
 * titles and aria-labels. Session bodies, session titles, project paths,
 * commands and generated briefs are data — they are shown exactly as the index
 * holds them and are never translated.
 *
 * `zh` is the single source of truth for the shape: `Messages` is derived from
 * it, so a key added on one side and forgotten on the other is a type error.
 * Types alone would not gate it — `bun run build` strips types without checking
 * them — so `test/i18n.test.ts` also pins key parity, placeholder parity and
 * the absence of Chinese text in the English dictionary. Without those tests a
 * forgotten key would render as `undefined` instead of failing a gate.
 * Values are plain strings; `{name}` placeholders are filled by `format()`.
 */

export type Lang = "zh" | "en";
export type LangPref = "auto" | Lang;

export const LANG_PREFS: readonly LangPref[] = ["auto", "zh", "en"];

export function isLangPref(value: unknown): value is LangPref {
  return (
    typeof value === "string" && (LANG_PREFS as readonly string[]).includes(value)
  );
}

/**
 * `auto` follows the browser: a primary language that starts with `zh` means
 * Chinese, anything else (including an empty list) means English.
 */
export function resolveLang(pref: LangPref, languages: readonly string[]): Lang {
  if (pref === "zh" || pref === "en") return pref;
  const primary = (languages[0] ?? "").trim().toLowerCase();
  return primary.startsWith("zh") ? "zh" : "en";
}

/** What `<html lang>` gets; `en` is deliberately bare, `zh` carries its region. */
export const DOC_LANG: Record<Lang, string> = { zh: "zh-CN", en: "en" };

/** Locale for `Intl`/`toLocaleString` formatting of counts, times and dates. */
export const DATE_LOCALE: Record<Lang, string> = { zh: "zh-CN", en: "en-US" };

/** The switch names each option in its own language, so it never has to move. */
export const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "EN" };

/** Date-picker column headers, Monday first. */
export const WEEKDAY_SHORT: Record<Lang, string[]> = {
  zh: ["一", "二", "三", "四", "五", "六", "日"],
  en: ["M", "T", "W", "T", "F", "S", "S"],
};

const zh = {
  /* --- document --- */
  appTitle: "session recall · 本机 agent 会话检索",
  appDescription: "本机 AI agent 会话的只读检索库：搜索过去的提问与回答。",

  /* --- shell --- */
  skipToResults: "跳到结果",
  railAria: "筛选",
  closeFilters: "关闭筛选",
  railSub: "本机 agent 会话 · 只读索引",
  agentHeading: "Agent",
  agentHint: "未选 = 全部",
  allAgents: "全部 Agent",
  agentsSelected: "{n} 个 Agent",
  agentSelected: "{n} 个 Agent",
  filterByAgent: "按 Agent 筛选",
  agentsAria: "Agent",
  agentSearchPlaceholder: "筛选 Agent…",
  agentSearchAria: "按名称筛选 Agent",
  noAgentsMatch: "没有匹配的 Agent",
  sessionViewHeading: "会话视图",
  viewAll: "全部",
  viewStarred: "收藏",
  viewHidden: "隐藏",
  projectsHeading: "项目",
  filterByProject: "按项目筛选",
  allProjects: "全部项目",
  projectsAria: "项目",
  timeHeading: "时间",
  clearFilters: "清除筛选",
  openFilters: "打开筛选",
  searchAria: "搜索任何内容",
  searchPlaceholder: "搜索任何内容…",
  searchProcessPlaceholder: "搜索文件、命令或错误…",
  scopeAria: "搜索范围类型",
  roleAria: "问答范围",
  roleChipClear: "移除「{role}」筛选",
  backToTop: "回到顶部",

  /* --- theme and language --- */
  themeLabel: "主题",
  themeAria: "明暗主题",
  themeAuto: "自动",
  themeLight: "浅色",
  themeDark: "深色",
  langLabel: "语言",
  langAria: "界面语言",

  /* --- filter values --- */
  rangeAll: "全部",
  range7d: "7 天",
  range30d: "30 天",
  range90d: "90 天",
  roleAll: "全部",
  roleUser: "提问",
  roleAssistant: "回答",
  scopeQa: "问答",
  scopeProcess: "过程",

  /* --- rail footer --- */
  readingIndex: "正在读取索引…",
  indexedAt: "索引于 {time}",
  notIndexed: "尚未索引",
  briefAria: "简报类型",
  briefDay: "日报",
  briefWeek: "周报",
  pickDate: "选择日期",
  briefGenerate: "生成",
  sessionsUnit: "会话",
  turnsUnit: "问答",
  footStatsOne: "<b>{s}</b> 会话 · <b>{t}</b> 轮问答",
  footStatsMany: "<b>{s}</b> 会话 · <b>{t}</b> 轮问答",
  reindex: "重新索引",
  indexReadFailed: "索引读取失败",
  monthPrev: "上个月",
  monthNext: "下个月",

  /* --- date formatting --- */
  unknownTime: "时间未知",
  todayAt: "今天 {time}",
  yesterday: "昨天",
  daysAgo: "{n} 天前",

  /* --- results --- */
  searching: "搜索中…",
  requestFailed: "请求失败 ({status})",
  statusProcess: "{sessions} 个会话 · {rows} 条过程 · {ms} ms",
  statusQa: "{sessions} 个会话 · {turns} 条问答 · {ms} ms",
  searchFailed: "搜索失败：{message}",
  retry: "重试",
  headingProcessSearch: "过程搜索",
  headingSearch: "搜索结果",
  headingRecentProcess: "最近过程",
  headingRecentAnswers: "最近回答",
  headingRecentQuestions: "最近提问",
  descProcessQuery: "包含 “{q}” 的工具、命令或错误 · 按最近活动",
  descQaQuery: "包含 “{q}” 的提问与回答 · 按最近活动",
  descRecentProcess: "按最近工具活动排序",
  descRecent: "按最近活动排序",
  listFootMore: "显示前 {shown} 个会话，共 {total} 个。",
  listFootCapped: "显示前 {shown} 个会话，共 {total} 个；已达到单次显示上限。",
  showMore: "显示更多",
  hitsCount: "{n} 处命中",
  untitledSession: "未命名会话",
  unknownProject: "未识别项目",
  noContent: "（无内容）",
  noPrompt: "（无提问记录）",
  questionLabel: "提问",
  answerLabel: "回答",
  toolLabel: "工具",
  inputLabel: "参数",
  outputLabel: "结果",
  errorOutputLabel: "错误输出",

  /* --- empty and error states --- */
  emptyProcessTitle: "没有找到匹配的过程",
  emptyProcessBody:
    "过程搜索覆盖工具名、参数里的文件和命令，以及错误输出。试试更短的文件名或命令片段。",
  emptyQaTitle: "没有找到匹配的问答",
  emptyQaBody:
    "试试更短的关键词，或把问答范围切到「全部」，也可以清除 Agent / 项目筛选。",
  emptyIndexTitle: "索引还是空的",
  emptyIndexBody: "先在终端运行 {cmd}，然后刷新这个页面。",
  emptyRecentTitle: "还没有可显示的提问",
  emptyRecentBody: "换一个关键词，或把范围切到「全部」。",
  readFailed: "读取失败",

  /* --- session page --- */
  backToSearch: "返回搜索",
  fromSearch: "来自搜索 “{q}” · ",
  viewSearchResults: "查看搜索结果",
  turnCount: "{n} 轮问答",
  truncatedTurn: "内容较长，已截断索引。",
  truncatedEvent: "内容较长，已截断。",
  resumeLabel: "继续到",
  resumeTargetAria: "在哪个 agent 中继续",
  copy: "复制",
  copyLink: "复制链接",
  copied: "已复制",
  copyFailed: "复制失败",
  handoffCopy: "复制交接",
  handoffPreparing: "准备中…",
  handoffUnavailable: "交接不可用",
  handoffBuildFailed: "生成交接卡失败",
  handoffReadyAgain: "交接卡已就绪，请再点一次",
  handoffButtonTitle: "复制包含问题、文件、命令和 Git 状态的交接卡",
  copyConversation: "复制对话",
  copyConversationTitle:
    "按顺序复制全部问答，轮次之间用分隔线隔开；超长内容会在结尾注明截断",
  copyQa: "复制问答",
  copyQaTitle: "复制这一轮的提问与回答（Markdown）",
  copyQ: "复制提问",
  copyQTitle: "只复制这一轮的提问原文",
  copyA: "复制回答",
  copyATitle: "只复制这一轮的回答原文（Markdown）",
  copyTruncatedNote: "（内容超过 {limit}，已截断）",
  forgetButton: "忘记",
  forgetButtonTitle:
    "从本机索引中移除该会话，之后扫描不会再索引它；不会删除 agent 自己存储中的原始会话文件",
  forgetConfirm:
    "忘记此会话？\n\n{title}\n\n它会被移出本机索引，之后的扫描也不会再索引它。\n\nagent 自己存储中的原始会话文件不会被删除，只是这里不再检索它。",
  forgetting: "正在忘记…",
  forgetFailed: "忘记失败",
  forgotWithBriefs:
    "已忘记该会话：已从本机索引移除，后续扫描不会再索引它（agent 存储中的原始会话文件未删除）；{n} 个已生成的简报仍引用它，可重新生成或删除",
  forgot:
    "已忘记该会话：已从本机索引移除，后续扫描不会再索引它；agent 自己存储中的原始会话文件仍然保留",
  undo: "撤销",
  undoTitle: "恢复该会话，之后的扫描会重新索引它",
  undoing: "正在恢复…",
  undoneIndexing: "已恢复该会话，正在重新索引…",
  undone: "已恢复该会话",
  undoFailed: "恢复失败：{message}。可在终端运行 bun run src/cli.ts unforget {id}",
  hiddenBadge: "隐藏",
  starButton: "收藏",
  starButtonTitle: "收藏此会话，可在侧栏「收藏」中快速找到",
  starButtonTitleActive: "取消收藏",
  hideButton: "隐藏",
  hideButtonTitle:
    "从默认视图移出该会话；可在侧栏「隐藏」中找回，agent 自己存储中的原始会话文件不受影响",
  hideConfirm: "隐藏此会话？\n\n{title}\n\n它会从默认视图移出，可在侧栏「隐藏」中找回。",
  hiddenNotice: "已隐藏该会话；在侧栏「隐藏」中可找回",
  hiddenSessionNote: "该会话已隐藏",
  unhideButton: "取消隐藏",
  starFailed: "收藏失败",
  hideFailed: "隐藏失败",
  unhideFailed: "取消隐藏失败",

  /* --- process panel --- */
  processLabel: "过程",
  processCountUnit: "项",
  reasoningLabel: "思考过程",
  processLoading: "正在读取过程…",
  processEmpty: "没有记录到过程。",
  processReadFailed: "读取失败：{message}",
  noAnswerRecorded: "（没有记录到回答）",

  /* --- brief --- */
  briefMeta: "{subtitle} · {projects} 个项目 · {sessions} 个会话 · {turns} 轮问答",
  downloadMd: "下载 .md",
  generating: "正在生成…",
  generated: "已生成 ",
  viewOnline: "在线查看",
  generateFailed: "生成失败：{message}",
  indexing: "正在索引…",

  /* --- settings drawer --- */
  settingsTitle: "设置",
  settingsOpen: "打开设置",
  settingsClose: "关闭设置",
  settingsAppearance: "外观",
  settingsIndex: "索引",
  settingsLastScan: "最近扫描",
  settingsShortcuts: "快捷键",
  shortcutGlobalWake: "全局唤起",
  hotkeyLoading: "读取快捷键状态…",
  hotkeyCurrent: "当前",
  hotkeyNone: "未设置",
  hotkeyRegistered: "已注册",
  hotkeyNotRegistered: "未注册",
  hotkeyPendingRestart: "重启应用后生效",
  hotkeyNotRunning: "桌面应用未运行，只有它能注册全局快捷键",
  hotkeyRegisterError: "注册失败",
  hotkeyPlaceholder: "如 Option+Command+R",
  hotkeyInvalid: "格式：修饰键 + 单个键（A–Z、0–9、F1–F12）",
  hotkeyInputAria: "设置全局唤起快捷键",
  hotkeySave: "保存",
  hotkeyDisable: "禁用",
  hotkeyReset: "恢复默认",
  hotkeySaved: "已保存",
  hotkeySaveFailed: "保存失败",
  shortcutInApp: "应用内快捷键",
  shortcutFocusSearch: "⌘K 或 / 聚焦搜索框",
  settingsUpdates: "更新",
  updateCurrent: "当前版本",
  updateNotChecked: "尚未检查更新",
  updateLatest: "已是最新",
  updateAvailable: "有新版本",
  updateNow: "立即更新",
  updateInstalling: "正在安装更新…",
  updateInstallRequested: "已开始下载，安装后应用会自动重启",
  updateLastChecked: "上次检查 {time}",
  updateCheckFailed: "更新检查失败",
  checkUpdatesLabel: "自动检查更新",
  settingsSaved: "保存的搜索",
  savedEmpty: "还没有保存的搜索",
  savedOpen: "打开此搜索",
  savedRename: "重命名",
  savedDelete: "删除",
  savedDeleteConfirm: "删除保存的搜索「{name}」？这只删除这个入口，不影响任何会话。",
  savedNameAria: "搜索名称",
  savedNamePlaceholder: "名称，如「WebSocket 重连」",
  saveThisSearch: "保存此搜索",
  saveSearchSave: "保存",
  saveSearchSaved: "已保存，可在设置里找到",
  saveSearchFailed: "保存失败",
  saveSearchNameRequired: "先给这个搜索起个名字",
  savedRenameFailed: "重命名失败",
  savedDeleteFailed: "删除失败",
};

export type Messages = typeof zh;

const en: Messages = {
  /* --- document --- */
  appTitle: "session recall · local agent session search",
  appDescription: "A local, read-only index over AI agent sessions on this Mac.",

  /* --- shell --- */
  skipToResults: "Skip to results",
  railAria: "Filters",
  closeFilters: "Close filters",
  railSub: "Local agent sessions · read-only index",
  agentHeading: "Agent",
  agentHint: "none selected = all",
  allAgents: "All agents",
  agentsSelected: "{n} agents",
  agentSelected: "{n} agent",
  filterByAgent: "Filter by agent",
  agentsAria: "Agents",
  agentSearchPlaceholder: "Filter agents…",
  agentSearchAria: "Filter agents by name",
  noAgentsMatch: "No matching agent",
  sessionViewHeading: "Session view",
  viewAll: "All",
  viewStarred: "Starred",
  viewHidden: "Hidden",
  projectsHeading: "Projects",
  filterByProject: "Filter by project",
  allProjects: "All projects",
  projectsAria: "Projects",
  timeHeading: "Time",
  clearFilters: "Clear filters",
  openFilters: "Open filters",
  searchAria: "Search anything",
  searchPlaceholder: "Search anything…",
  searchProcessPlaceholder: "Search files, commands or errors…",
  scopeAria: "Search scope",
  roleAria: "Question and answer range",
  roleChipClear: "Remove the {role} filter",
  backToTop: "Back to top",

  /* --- theme and language --- */
  themeLabel: "Theme",
  themeAria: "Colour theme",
  themeAuto: "Auto",
  themeLight: "Light",
  themeDark: "Dark",
  langLabel: "Language",
  langAria: "Interface language",

  /* --- filter values --- */
  rangeAll: "All",
  range7d: "7 days",
  range30d: "30 days",
  range90d: "90 days",
  roleAll: "All",
  roleUser: "Questions",
  roleAssistant: "Answers",
  scopeQa: "Q&A",
  scopeProcess: "Process",

  /* --- rail footer --- */
  readingIndex: "Reading the index…",
  indexedAt: "Indexed at {time}",
  notIndexed: "Not indexed yet",
  briefAria: "Report type",
  briefDay: "Daily",
  briefWeek: "Weekly",
  pickDate: "Pick a date",
  briefGenerate: "Generate",
  sessionsUnit: "sessions",
  turnsUnit: "turns",
  footStatsOne: "<b>{s}</b> session · <b>{t}</b> turn",
  footStatsMany: "<b>{s}</b> sessions · <b>{t}</b> turns",
  reindex: "Re-index",
  indexReadFailed: "Could not read the index",
  monthPrev: "Previous month",
  monthNext: "Next month",

  /* --- date formatting --- */
  unknownTime: "Time unknown",
  todayAt: "Today {time}",
  yesterday: "Yesterday",
  daysAgo: "{n} days ago",

  /* --- results --- */
  searching: "Searching…",
  requestFailed: "Request failed ({status})",
  statusProcess: "{sessions} sessions · {rows} process rows · {ms} ms",
  statusQa: "{sessions} sessions · {turns} turns · {ms} ms",
  searchFailed: "Search failed: {message}",
  retry: "Retry",
  headingProcessSearch: "Process search",
  headingSearch: "Search results",
  headingRecentProcess: "Recent process",
  headingRecentAnswers: "Recent answers",
  headingRecentQuestions: "Recent questions",
  descProcessQuery: "Tool calls, commands and errors containing “{q}” · by recent activity",
  descQaQuery: "Questions and answers containing “{q}” · by recent activity",
  descRecentProcess: "Sorted by recent tool activity",
  descRecent: "Sorted by recent activity",
  listFootMore: "Showing the first {shown} of {total} sessions.",
  listFootCapped:
    "Showing the first {shown} of {total} sessions; the per-view limit is reached.",
  showMore: "Show more",
  hitsCount: "{n} hits",
  untitledSession: "Untitled session",
  unknownProject: "Unrecognised project",
  noContent: "(no content)",
  noPrompt: "(no question recorded)",
  questionLabel: "Question",
  answerLabel: "Answer",
  toolLabel: "Tool",
  inputLabel: "Input",
  outputLabel: "Output",
  errorOutputLabel: "Error output",

  /* --- empty and error states --- */
  emptyProcessTitle: "No matching process rows",
  emptyProcessBody:
    "Process search covers tool names, the files and commands in their arguments, and error output. Try a shorter file name or command fragment.",
  emptyQaTitle: "No matching questions or answers",
  emptyQaBody:
    "Try a shorter keyword, switch the role filter to “All”, or clear the agent / project filters.",
  emptyIndexTitle: "The index is still empty",
  emptyIndexBody: "Run {cmd} in a terminal, then reload this page.",
  emptyRecentTitle: "No questions to show yet",
  emptyRecentBody: "Try another keyword, or switch the range to “All”.",
  readFailed: "Could not read",

  /* --- session page --- */
  backToSearch: "Back to search",
  fromSearch: "From the search “{q}” · ",
  viewSearchResults: "View search results",
  turnCount: "{n} turns",
  truncatedTurn: "Long content; the index keeps an excerpt.",
  truncatedEvent: "Long content; truncated.",
  resumeLabel: "Continue in",
  resumeTargetAria: "Which agent to continue in",
  copy: "Copy",
  copyLink: "Copy link",
  copied: "Copied",
  copyFailed: "Copy failed",
  handoffCopy: "Copy handoff",
  handoffPreparing: "Preparing…",
  handoffUnavailable: "Handoff unavailable",
  handoffBuildFailed: "Could not build the handoff card",
  handoffReadyAgain: "Handoff card ready — click again",
  handoffButtonTitle:
    "Copy a handoff card with the question, files, commands and Git state",
  copyConversation: "Copy conversation",
  copyConversationTitle:
    "Copy every turn in order, separated by divider lines; the tail notes a truncation",
  copyQa: "Copy Q&A",
  copyQaTitle: "Copy this turn's question and answer (Markdown)",
  copyQ: "Copy question",
  copyQTitle: "Copy only this turn's question, verbatim",
  copyA: "Copy answer",
  copyATitle: "Copy only this turn's answer, verbatim (Markdown)",
  copyTruncatedNote: "(content exceeded {limit}; truncated)",
  forgetButton: "Forget",
  forgetButtonTitle:
    "Remove this session from the local index; later scans will not index it again. The original session in the agent's own storage is not deleted.",
  forgetConfirm:
    "Forget this session?\n\n{title}\n\nIt is removed from the local index, and later scans will not index it again.\n\nThe original session in the agent's own storage is not deleted — it is only no longer searchable here.",
  forgetting: "Forgetting…",
  forgetFailed: "Forget failed",
  forgotWithBriefs:
    "Session forgotten: removed from the local index, and later scans will not index it again (the original session in the agent's own storage is kept). {n} generated briefs still reference it — regenerate or delete them",
  forgot:
    "Session forgotten: removed from the local index, and later scans will not index it again. The original session in the agent's own storage is kept.",
  undo: "Undo",
  undoTitle: "Restore this session; the next scan will index it again",
  undoing: "Restoring…",
  undoneIndexing: "Session restored; re-indexing…",
  undone: "Session restored",
  undoFailed:
    "Restore failed: {message}. You can run bun run src/cli.ts unforget {id} in a terminal",
  hiddenBadge: "Hidden",
  starButton: "Starred",
  starButtonTitle: "Star this session to find it quickly under Starred in the sidebar",
  starButtonTitleActive: "Unstar",
  hideButton: "Hide",
  hideButtonTitle:
    "Move this session out of the default view; find it under Hidden in the sidebar. The original session in the agent's own storage is not affected.",
  hideConfirm:
    "Hide this session?\n\n{title}\n\nIt leaves the default view; you can find it again under Hidden in the sidebar.",
  hiddenNotice: "Session hidden. Find it under Hidden in the sidebar.",
  hiddenSessionNote: "This session is hidden",
  unhideButton: "Unhide",
  starFailed: "Star failed",
  hideFailed: "Hide failed",
  unhideFailed: "Unhide failed",

  /* --- process panel --- */
  processLabel: "Process",
  processCountUnit: "items",
  reasoningLabel: "Reasoning",
  processLoading: "Loading the process…",
  processEmpty: "No process recorded.",
  processReadFailed: "Could not load: {message}",
  noAnswerRecorded: "(no answer recorded)",

  /* --- brief --- */
  briefMeta: "{subtitle} · {projects} projects · {sessions} sessions · {turns} turns",
  downloadMd: "Download .md",
  generating: "Generating…",
  generated: "Generated ",
  viewOnline: "View online",
  generateFailed: "Generate failed: {message}",
  indexing: "Indexing…",

  /* --- settings drawer --- */
  settingsTitle: "Settings",
  settingsOpen: "Open settings",
  settingsClose: "Close settings",
  settingsAppearance: "Appearance",
  settingsIndex: "Index",
  settingsLastScan: "Last scan",
  settingsShortcuts: "Shortcuts",
  shortcutGlobalWake: "Global hotkey",
  hotkeyLoading: "Loading the hotkey state…",
  hotkeyCurrent: "Current",
  hotkeyNone: "Not set",
  hotkeyRegistered: "Registered",
  hotkeyNotRegistered: "Not registered",
  hotkeyPendingRestart: "Restart the app to apply",
  hotkeyNotRunning: "The desktop app is not running; only it can register a global hotkey",
  hotkeyRegisterError: "Registration failed",
  hotkeyPlaceholder: "e.g. Option+Command+R",
  hotkeyInvalid: "Modifiers plus one key (A–Z, 0–9, F1–F12)",
  hotkeyInputAria: "Set the global wake hotkey",
  hotkeySave: "Save",
  hotkeyDisable: "Disable",
  hotkeyReset: "Reset to default",
  hotkeySaved: "Saved",
  hotkeySaveFailed: "Save failed",
  shortcutInApp: "In-app shortcuts",
  shortcutFocusSearch: "⌘K or / to focus search",
  settingsUpdates: "Updates",
  updateCurrent: "Current version",
  updateNotChecked: "Not checked yet",
  updateLatest: "Up to date",
  updateAvailable: "New version available",
  updateNow: "Update now",
  updateInstalling: "Installing update…",
  updateInstallRequested: "Download started; the app restarts when it is installed",
  updateLastChecked: "Last checked {time}",
  updateCheckFailed: "Update check failed",
  checkUpdatesLabel: "Check for updates automatically",
  settingsSaved: "Saved searches",
  savedEmpty: "No saved searches yet",
  savedOpen: "Open this search",
  savedRename: "Rename",
  savedDelete: "Delete",
  savedDeleteConfirm:
    "Delete the saved search “{name}”? Only this entry is removed; no sessions are affected.",
  savedNameAria: "Search name",
  savedNamePlaceholder: "Name, e.g. “WebSocket backoff”",
  saveThisSearch: "Save this search",
  saveSearchSave: "Save",
  saveSearchSaved: "Saved — find it in Settings",
  saveSearchFailed: "Save failed",
  saveSearchNameRequired: "Give this search a name first",
  savedRenameFailed: "Rename failed",
  savedDeleteFailed: "Delete failed",
};

export const MESSAGES: Record<Lang, Messages> = { zh, en };

/** Replace `{name}` placeholders; a name with no value is left as written. */
export function format(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : whole,
  );
}
