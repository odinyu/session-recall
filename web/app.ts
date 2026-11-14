import {
  HANDOFF_WAIT_MS,
  handoffKey,
  rememberHandoff,
  waitForHandoff,
  type HandoffWait,
} from "./handoff.ts";
import {
  DATE_LOCALE,
  DOC_LANG,
  LANG_LABELS,
  MESSAGES,
  WEEKDAY_SHORT,
  format,
  isLangPref,
  resolveLang,
  type Lang,
  type LangPref,
  type Messages,
} from "./i18n.ts";
import { inAppRoute } from "./links.ts";
import { renderMarkdown } from "./markdown.ts";

type AgentId =
  | "omp"
  | "pi"
  | "opencode"
  | "cursor"
  | "alma"
  | "cindy"
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "qwen-code"
  | "kimi-code"
  | "copilot-cli"
  | "goose";
type Role = "all" | "user" | "assistant";
type Scope = "qa" | "process";
type Range = "all" | "7d" | "30d" | "90d";
type ThemeMode = "auto" | "light" | "dark";

interface Hit {
  turnId: number;
  idx: number;
  ts: number;
  matchField: "user" | "assistant";
  snippet: string;
  userText: string;
  assistantSnippet: string;
}

interface ProcessHit {
  turnIdx: number;
  seq: number;
  ts: number;
  tool: string;
  status: string;
  matchField: "tool" | "input" | "error";
  snippet: string;
}

interface ResultSession {
  id: string;
  agent: AgentId;
  title: string;
  projectPath: string;
  updatedAt: number;
  starred: boolean;
  hidden: boolean;
  hits: Hit[];
  hitCount: number;
  processHits: ProcessHit[];
  processHitCount: number;
}

interface SearchResult {
  q: string;
  terms: string[];
  scope: Scope;
  mode: "fts" | "like" | "recent" | "process";
  tookMs: number;
  totalTurns: number;
  totalSessions: number;
  processTotal: number;
  sessions: ResultSession[];
}

interface Facets {
  agents: { id: AgentId; sessions: number }[];
  projects: { path: string; sessions: number }[];
  total: { sessions: number; turns: number; chars: number };
  starredCount: number;
  hiddenCount: number;
  lastScanMs: number;
  lastScanTookMs: number;
  errors: { source: string; message: string; at: number }[];
}

interface SessionEvent {
  seq: number;
  kind: "reasoning" | "tool" | string;
  name: string | null;
  input: string;
  output: string;
  meta: string | null;
  truncated: number;
}

interface Continuation {
  targetAgent: AgentId;
  label: string;
  kind: "resume" | "deep-link" | "launch" | "manual";
  command: string;
  note: string;
}

interface SessionDetail {
  session: {
    id: string;
    agent: AgentId;
    title: string;
    projectPath: string;
    startedAt: number;
    updatedAt: number;
    turnCount: number;
    sourceKind: string;
    starred: boolean;
    hidden: boolean;
    continuations: Continuation[];
  };
  turns: {
    idx: number;
    ts: number;
    userText: string;
    assistantText: string;
    model: string | null;
    truncated: boolean;
    eventCount: number;
  }[];
}

interface BriefPayload {
  date: string;
  week?: string | null;
  range?: string | null;
  path: string;
  relativePath: string;
  sessions: number;
  turns: number;
  projects: number;
  markdown: string;
  download: string;
}

interface UiState {
  view: "search" | "session" | "brief";
  sessionId: string;
  briefDate: string;
  briefFormat: "day" | "week";
  turnIdx: number | null;
  focus: "user" | "assistant" | null;
  processOpen: boolean;
  processSeq: number | null;
  q: string;
  agents: AgentId[];
  project: string;
  role: Role;
  scope: Scope;
  range: Range;
  /** Rail view switch: default, starred only, or the hidden shelf. */
  sessionView: SessionView;
}

const SESSION_VIEWS: SessionView[] = ["all", "starred", "hidden"];
type SessionView = (typeof SESSION_VIEWS)[number];

const AGENT_LABEL: Record<AgentId, string> = {
  omp: "omp",
  pi: "pi",
  opencode: "OpenCode",
  cursor: "Cursor",
  alma: "Alma",
  cindy: "Cindy",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "qwen-code": "Qwen Code",
  "kimi-code": "Kimi Code",
  "copilot-cli": "Copilot CLI",
  goose: "Goose",
};

const AGENTS: AgentId[] = [
  "cursor",
  "opencode",
  "omp",
  "pi",
  "claude-code",
  "codex",
  "alma",
  "cindy",
  "gemini-cli",
  "qwen-code",
  "kimi-code",
  "copilot-cli",
  "goose",
];
/** Filter ids; their labels come from the dictionary at render time. */
const RANGES: Range[] = ["all", "7d", "30d", "90d"];
const ROLES: Role[] = ["all", "user", "assistant"];
const SCOPES: Scope[] = ["qa", "process"];
const THEMES: ThemeMode[] = ["auto", "light", "dark"];

function rangeLabel(id: Range): string {
  return id === "all"
    ? t.rangeAll
    : id === "7d"
      ? t.range7d
      : id === "30d"
        ? t.range30d
        : t.range90d;
}

function roleLabel(id: Role): string {
  return id === "user" ? t.roleUser : id === "assistant" ? t.roleAssistant : t.roleAll;
}

function scopeLabel(id: Scope): string {
  return id === "process" ? t.scopeProcess : t.scopeQa;
}

function themeLabel(id: ThemeMode): string {
  return id === "light" ? t.themeLight : id === "dark" ? t.themeDark : t.themeAuto;
}
/**
 * Same-launch cache for the first paint only (see `applyTheme`): the packaged
 * app's origin carries a fresh random port on every launch, so this value only
 * survives a reload. The server's `prefs.json` is the authority.
 */
const THEME_KEY = "session-recall-theme";
/** Scroll distance after which the floating "back to top" control appears. */
const TO_TOP_THRESHOLD = 400;
/** Deep-linked search terms are capped before they reach the DOM. */
const MAX_HASH_Q = 300;

let state: UiState = defaultState();
let facetsData: Facets | null = null;
let currentResults: SearchResult | null = null;
let lastTerms: string[] = [];
let searchAbort: AbortController | null = null;
let searchTimer: number | undefined;
let pollTimer: number | undefined;
let lastSearchHash = "#/search";
const INITIAL_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 5000;
let resultLimit = INITIAL_RESULT_LIMIT;
// Identifies the current query/filters. "Show more" grows resultLimit for the
// same criteria; a new query or filter must start from the initial limit again,
// otherwise every later search keeps fetching hundreds of rows.
let lastSearchKey = "";
let themeMode: ThemeMode = cachedTheme();
// Interface language: `langPref` is what the server stores ("auto" follows the
// browser), `lang` is what that resolves to, and `t` is the dictionary every
// renderer paints from.
let langPref: LangPref = "auto";
let lang: Lang = "zh";
let t: Messages = MESSAGES.zh;
let briefDate = localDateKey();
// Which report the footer generates: a single day, or the ISO week that the
// chosen day falls in.
let briefMode: "day" | "week" = "day";

function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` as a local date; malformed keys fall back to today. */
function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year || 1970, (month || 1) - 1, day || 1);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** Monday..Sunday of the ISO week that contains `key`. */
function weekRange(key: string): { start: string; end: string } {
  const date = parseDateKey(key);
  const mondayOffset = (date.getDay() + 6) % 7;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: localDateKey(monday), end: localDateKey(sunday) };
}

/** Compact label under the date button: `2026/11/12` or the week `11/16–11/22`. */
function briefDateLabel(): string {
  if (briefMode === "week") {
    const { start, end } = weekRange(briefDate);
    return `${start.slice(5).replace("-", "/")}–${end.slice(5).replace("-", "/")}`;
  }
  return briefDate.replace(/-/g, "/");
}

function briefDateLabelHtml(): string {
  return `<span class="brief-date-label">${escapeHtml(briefDateLabel())}</span>
    <svg class="brief-date-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 6.5h11M5.5 2.2v3M10.5 2.2v3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
}

/* -------------------------------------------------------------------------
 * Date picker
 *
 * A `<input type="date">` hands its popup to the OS or browser, which cannot be
 * themed; this is a small calendar drawn with the app's own tokens instead. It
 * keeps the native behaviours that matter: Monday-first ISO weeks (the weekly
 * report groups by ISO week), arrow/Page/Home/End navigation, Enter to pick,
 * Escape to close, and a focus ring.
 * ---------------------------------------------------------------------- */

interface DatePicker {
  el: HTMLDivElement;
  trigger: HTMLElement;
  view: Date; // first day of the visible month
  focus: Date; // the day that owns keyboard focus
  onOutside: (event: MouseEvent) => void;
}
let datePicker: DatePicker | null = null;

/** Month heading and the aria-label of a day, in the current language. */
function monthLabel(date: Date): string {
  return date.toLocaleDateString(DATE_LOCALE[lang], {
    year: "numeric",
    month: "long",
  });
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString(DATE_LOCALE[lang], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function openDatePicker(trigger: HTMLElement): void {
  closeDatePicker(false);
  const selected = parseDateKey(briefDate);
  const el = document.createElement("div");
  el.className = "date-picker";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "false");
  el.setAttribute("aria-label", t.pickDate);
  document.body.appendChild(el);
  const picker: DatePicker = {
    el,
    trigger,
    view: new Date(selected.getFullYear(), selected.getMonth(), 1),
    focus: selected,
    onOutside: () => {},
  };
  datePicker = picker;
  el.addEventListener("click", onDatePickerClick);
  el.addEventListener("keydown", onDatePickerKey);
  renderDatePicker();
  positionDatePicker();
  trigger.setAttribute("aria-expanded", "true");
  picker.onOutside = (event) => {
    const target = event.target as Node | null;
    if (!target) return;
    if (el.contains(target) || trigger.contains(target)) return;
    closeDatePicker();
  };
  // Defer, or the click that opened the picker also counts as "outside".
  window.setTimeout(() => {
    if (datePicker === picker) document.addEventListener("mousedown", picker.onOutside, true);
  }, 0);
  focusDateCell();
}

function closeDatePicker(restoreFocus = true): void {
  if (!datePicker) return;
  const { el, trigger, onOutside } = datePicker;
  document.removeEventListener("mousedown", onOutside, true);
  trigger.setAttribute("aria-expanded", "false");
  el.remove();
  datePicker = null;
  if (restoreFocus) trigger.focus();
}

/** Keep the open picker attached to the current footer button after a rerender. */
function anchorDatePicker(): void {
  if (!datePicker) return;
  const trigger = byId<HTMLElement>("brief-date");
  if (!trigger) {
    closeDatePicker(false);
    return;
  }
  datePicker.trigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  positionDatePicker();
}

function renderDatePicker(): void {
  if (!datePicker) return;
  const { view, focus } = datePicker;
  const year = view.getFullYear();
  const month = view.getMonth();
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const start = new Date(year, month, 1 - lead);
  const todayKey = localDateKey();
  const focusKey = localDateKey(focus);
  const rows: string[] = [];
  for (let row = 0; row < 6; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < 7; col += 1) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + row * 7 + col);
      const key = localDateKey(day);
      const classes = ["date-cell"];
      if (day.getMonth() !== month) classes.push("is-outside");
      if (key === todayKey) classes.push("is-today");
      if (key === briefDate) classes.push("is-selected");
      if (key === focusKey) classes.push("is-focus");
      cells.push(
        `<button type="button" class="${classes.join(" ")}" data-date="${key}" role="gridcell" aria-selected="${key === briefDate}" aria-label="${escapeAttr(dayLabel(day))}" tabindex="${key === focusKey ? 0 : -1}">${day.getDate()}</button>`,
      );
    }
    rows.push(`<div class="date-row" role="row">${cells.join("")}</div>`);
  }
  const heading = escapeHtml(monthLabel(new Date(year, month, 1)));
  datePicker.el.innerHTML = `
    <div class="date-head">
      <button type="button" class="date-nav" data-date-nav="-1" aria-label="${escapeAttr(t.monthPrev)}">‹</button>
      <span class="date-title" aria-live="polite">${heading}</span>
      <button type="button" class="date-nav" data-date-nav="1" aria-label="${escapeAttr(t.monthNext)}">›</button>
    </div>
    <div class="date-grid" role="grid" aria-label="${heading}">
      <div class="date-week" role="row">${WEEKDAY_SHORT[lang].map((label) => `<span role="columnheader">${label}</span>`).join("")}</div>
      ${rows.join("")}
    </div>`;
}

function focusDateCell(): void {
  if (!datePicker) return;
  const key = localDateKey(datePicker.focus);
  datePicker.el.querySelector<HTMLButtonElement>(`[data-date="${key}"]`)?.focus();
}

function shiftPickerMonth(delta: number): void {
  if (!datePicker) return;
  const { view, focus } = datePicker;
  const nextView = new Date(view.getFullYear(), view.getMonth() + delta, 1);
  const lastDay = new Date(nextView.getFullYear(), nextView.getMonth() + 1, 0).getDate();
  datePicker.view = nextView;
  datePicker.focus = new Date(nextView.getFullYear(), nextView.getMonth(), Math.min(focus.getDate(), lastDay));
  renderDatePicker();
  focusDateCell();
}

function shiftPickerDays(delta: number): void {
  if (!datePicker) return;
  const focus = datePicker.focus;
  const next = new Date(focus.getFullYear(), focus.getMonth(), focus.getDate() + delta);
  datePicker.focus = next;
  if (next.getFullYear() !== datePicker.view.getFullYear() || next.getMonth() !== datePicker.view.getMonth()) {
    datePicker.view = new Date(next.getFullYear(), next.getMonth(), 1);
  }
  renderDatePicker();
  focusDateCell();
}

function pickDate(key: string): void {
  briefDate = key;
  closeDatePicker();
  // Update the label in place rather than rerendering the whole footer.
  const label = document.querySelector<HTMLElement>("#brief-date .brief-date-label");
  if (label) label.textContent = briefDateLabel();
}

function onDatePickerClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const nav = target.closest<HTMLButtonElement>("[data-date-nav]");
  if (nav) {
    shiftPickerMonth(Number(nav.dataset.dateNav));
    return;
  }
  const cell = target.closest<HTMLButtonElement>("[data-date]");
  if (cell?.dataset.date) pickDate(cell.dataset.date);
}

function onDatePickerKey(event: KeyboardEvent): void {
  if (!datePicker) return;
  const dow = (datePicker.focus.getDay() + 6) % 7;
  switch (event.key) {
    case "Escape":
      event.preventDefault();
      closeDatePicker();
      return;
    case "ArrowLeft":
      event.preventDefault();
      shiftPickerDays(-1);
      return;
    case "ArrowRight":
      event.preventDefault();
      shiftPickerDays(1);
      return;
    case "ArrowUp":
      event.preventDefault();
      shiftPickerDays(-7);
      return;
    case "ArrowDown":
      event.preventDefault();
      shiftPickerDays(7);
      return;
    case "PageUp":
      event.preventDefault();
      shiftPickerMonth(-1);
      return;
    case "PageDown":
      event.preventDefault();
      shiftPickerMonth(1);
      return;
    case "Home":
      event.preventDefault();
      shiftPickerDays(-dow);
      return;
    case "End":
      event.preventDefault();
      shiftPickerDays(6 - dow);
      return;
    case "Enter":
    case " ": {
      const key = (document.activeElement as HTMLElement | null)?.getAttribute("data-date");
      if (key) {
        event.preventDefault();
        pickDate(key);
      }
      return;
    }
  }
}

function positionDatePicker(): void {
  if (!datePicker) return;
  const { el, trigger } = datePicker;
  const rect = trigger.getBoundingClientRect();
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
  // The trigger sits in the rail footer, so open upwards unless there is no room.
  let top = rect.top - height - 8;
  if (top < 8) top = rect.bottom + 8;
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.visibility = "";
}

function defaultState(): UiState {
  return {
    view: "search",
    sessionId: "",
    briefDate: "",
    briefFormat: "day",
    turnIdx: null,
    focus: null,
    processOpen: false,
    processSeq: null,
    q: "",
    agents: [],
    project: "",
    role: "all",
    scope: "qa",
    range: "all",
    sessionView: "all",
  };
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap query terms in `<mark>` without corrupting HTML entities. The match runs
 * over the raw text and each slice is escaped afterwards, so a term like "amp"
 * can never match inside `&amp;`. Matching after escaping (the old approach)
 * injected `<mark>` into entities and rendered garbage.
 */
function highlight(text: string, terms: string[]): string {
  if (terms.length === 0) return escapeHtml(text);
  const parts = terms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (parts.length === 0) return escapeHtml(text);
  const matcher = new RegExp(`(${parts.map(escapeRegExp).join("|")})`, "gi");
  let out = "";
  let last = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    out += escapeHtml(text.slice(last, index));
    out += `<mark>${escapeHtml(match[0])}</mark>`;
    last = index + match[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/**
 * Mark terms inside already-rendered Markdown.
 *
 * Answer bodies go through `renderMarkdown()`, so they cannot use the string
 * highlighter; walk their text nodes and wrap matches in `<mark>` instead. This
 * is what makes a deep-linked hit visible when the match sits in the answer
 * rather than in the prompt. Labels and existing marks are left alone.
 */
function markRenderedTerms(root: ParentNode, terms: string[]): void {
  const parts = terms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (parts.length === 0) return;
  const matcher = new RegExp(`(${parts.map(escapeRegExp).join("|")})`, "gi");
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data.trim()) continue;
    if (node.parentElement?.closest("mark, .msg-label")) continue;
    texts.push(node);
  }
  for (const node of texts) {
    matcher.lastIndex = 0;
    if (!matcher.test(node.data)) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of node.data.matchAll(matcher)) {
      const index = match.index ?? 0;
      if (index > last) fragment.append(node.data.slice(last, index));
      const mark = document.createElement("mark");
      mark.textContent = match[0];
      fragment.append(mark);
      last = index + match[0].length;
    }
    if (last < node.data.length) fragment.append(node.data.slice(last));
    node.replaceWith(fragment);
  }
}

function parseTerms(value: string): string[] {
  return value
    .split(/\s+/)
    .map((term) => term.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Percent-decode a raw `k=v` value, tolerating malformed escapes. */
function decodeHashValue(raw: string | null): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The raw (still-encoded) value for `name` in a `k=v&k=v` query string. */
function rawHashParam(query: string, name: string): string | null {
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function parseHash(): UiState {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("/brief/")) {
    const [path, query] = raw.split("?");
    const params = new URLSearchParams(query ?? "");
    return {
      ...defaultState(),
      view: "brief",
      briefDate: decodeURIComponent(path.slice("/brief/".length)),
      briefFormat: params.get("format") === "week" ? "week" : "day",
    };
  }
  if (raw.startsWith("/session/")) {
    const [path, query] = raw.split("?");
    const id = decodeURIComponent(path.slice("/session/".length));
    const params = new URLSearchParams(query ?? "");
    const turnParam = params.get("turn");
    const turn = turnParam === null ? Number.NaN : Number(turnParam);
    const hit = params.get("hit");
    const seqParam = params.get("event");
    const seq = seqParam === null ? Number.NaN : Number(seqParam);
    // The search that produced the link travels in `q`; read it from the raw
    // query so it decodes exactly once, and cap it before it reaches the DOM.
    const q = decodeHashValue(rawHashParam(query ?? "", "q")).slice(0, MAX_HASH_Q);
    return {
      ...defaultState(),
      view: "session",
      sessionId: id,
      turnIdx: Number.isFinite(turn) && turn >= 0 ? turn : null,
      focus: hit === "user" || hit === "assistant" ? hit : null,
      processOpen: params.get("process") === "1",
      processSeq: Number.isFinite(seq) && seq >= 0 ? seq : null,
      q,
    };
  }
  const queryIndex = raw.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? raw.slice(queryIndex + 1) : "");
  const agents = (params.get("agents") ?? "")
    .split(",")
    .filter((agent): agent is AgentId => AGENTS.includes(agent as AgentId));
  const role = params.get("role");
  const scope = params.get("scope");
  const range = params.get("range");
  const view = params.get("view");
  return {
    view: "search",
    sessionId: "",
    q: params.get("q") ?? "",
    agents,
    project: params.get("project") ?? "",
    role: role === "user" || role === "assistant" || role === "all" ? role : "all",
    scope: scope === "process" || scope === "qa" ? scope : "qa",
    range: range === "7d" || range === "30d" || range === "90d" ? range : "all",
    sessionView: view === "starred" || view === "hidden" ? view : "all",
  };
}

function syncHash(): void {
  if (state.view === "brief") {
    const suffix = state.briefFormat === "week" ? "?format=week" : "";
    history.replaceState(
      null,
      "",
      `#/brief/${encodeURIComponent(state.briefDate)}${suffix}`,
    );
    return;
  }
  if (state.view === "session") {
    const params = new URLSearchParams();
    if (state.turnIdx !== null) params.set("turn", String(state.turnIdx));
    if (state.focus) params.set("hit", state.focus);
    if (state.processOpen) params.set("process", "1");
    if (state.processSeq !== null) params.set("event", String(state.processSeq));
    const query = params.toString();
    // Keep the originating search on the URL so back/forward does not lose it.
    // `q` is encoded the way the deep-link shell encodes it, so `parseHash`
    // decodes it with `decodeURIComponent` (URLSearchParams would use `+`).
    const q = state.q ? `q=${encodeURIComponent(state.q)}` : "";
    const joined = [query, q].filter(Boolean).join("&");
    history.replaceState(
      null,
      "",
      `#/session/${encodeURIComponent(state.sessionId)}${joined ? `?${joined}` : ""}`,
    );
    return;
  }
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.agents.length > 0) params.set("agents", state.agents.join(","));
  if (state.project) params.set("project", state.project);
  if (state.role !== "all") params.set("role", state.role);
  if (state.scope !== "qa") params.set("scope", state.scope);
  if (state.range !== "all") params.set("range", state.range);
  if (state.sessionView !== "all") params.set("view", state.sessionView);
  const query = params.toString();
  const hash = `#/search${query ? `?${query}` : ""}`;
  lastSearchHash = hash;
  history.replaceState(null, "", hash);
}

function ensureSearchView(): void {
  if (state.view === "search") return;
  state.view = "search";
  state.sessionId = "";
  state.briefDate = "";
  state.turnIdx = null;
  state.focus = null;
  state.processOpen = false;
  state.processSeq = null;
  syncHash();
}

function formatCount(value: number): string {
  return value.toLocaleString(DATE_LOCALE[lang]);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

/** The last value this origin painted with; empty or stale on a fresh launch. */
function cachedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isThemeMode(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

/**
 * Paint a theme and, unless told otherwise, refresh the same-launch cache.
 *
 * `auto` keeps following the system through `matchMedia`, here and in the
 * `prefers-color-scheme` listener registered in `boot`.
 */
function applyTheme(mode: ThemeMode, persist = true): void {
  themeMode = mode;
  const dark =
    mode === "dark" ||
    (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeMode = mode;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // private browsing may refuse persistence; the session choice still applies
  }
}

/** The browser's language list, with the single-language fallback. */
function browserLanguages(): string[] {
  const list = navigator.languages;
  return list && list.length > 0 ? [...list] : [navigator.language];
}

/**
 * Paint a language choice: `<html lang>` and the title, plus the dictionary and
 * locale every later render reads. Callers re-render whatever is on screen;
 * nothing here touches the DOM the renderers own.
 */
function applyLanguage(pref: LangPref): void {
  langPref = pref;
  lang = resolveLang(pref, browserLanguages());
  t = MESSAGES[lang];
  document.documentElement.lang = DOC_LANG[lang];
  document.title = t.appTitle;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", t.appDescription);
  if (datePicker) renderDatePicker();
}

/** Persist a language choice; the local switch already applied, so failures only log. */
async function saveLanguage(pref: LangPref): Promise<void> {
  try {
    const prefs = await api<{ language?: unknown }>("/api/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: pref }),
    });
    // A rejected or rewritten value wins — but only while it still describes
    // what is on screen: a second click can land before this reply arrives, and
    // that older answer must not pull the UI back to the language it named.
    if (
      isLangPref(prefs.language) &&
      prefs.language !== pref &&
      pref === langPref
    ) {
      applyLanguage(prefs.language);
      renderControls();
      renderSettings();
      route();
    }
  } catch (error) {
    console.error("language preference not saved", error);
  }
}

/**
 * The server owns the theme and the language: they are served by the sidecar out
 * of `<app dir>/prefs.json`, so they outlive the port (and the origin) the
 * packaged app picks on every launch. Run before the first paint, so nothing
 * renders in the wrong theme or the wrong language.
 */
async function loadPrefs(): Promise<void> {
  try {
    const prefs = await api<{ theme?: unknown; language?: unknown }>("/api/prefs");
    applyTheme(isThemeMode(prefs.theme) ? prefs.theme : "auto");
    applyLanguage(isLangPref(prefs.language) ? prefs.language : "auto");
  } catch {
    // No server to ask: the cache is the best available guess for the theme,
    // and `auto` (the browser) for the language.
    applyTheme(cachedTheme(), false);
    applyLanguage("auto");
  }
}

/** Persist a theme choice; the local cache already switched, so failures are logged only. */
async function saveTheme(mode: ThemeMode): Promise<void> {
  try {
    const prefs = await api<{ theme?: unknown }>("/api/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: mode }),
    });
    if (isThemeMode(prefs.theme) && prefs.theme !== themeMode) {
      // The server rejected or rewrote the value; its answer wins.
      applyTheme(prefs.theme);
    }
  } catch (error) {
    console.error("theme preference not saved", error);
  }
}

function themeSwitchHtml(): string {
  return `<div class="theme-row">
    <span class="foot-muted">${t.themeLabel}</span>
    <div class="segmented theme-switch" id="theme-switch" role="group" aria-label="${escapeAttr(t.themeAria)}">
      ${THEMES.map(
        (theme) =>
          `<button class="seg${themeMode === theme ? " is-active" : ""}" type="button" data-theme-mode="${theme}" aria-pressed="${themeMode === theme}">${themeLabel(theme)}</button>`,
      ).join("")}
    </div>
  </div>`;
}

/**
 * The language switch, next to the theme switch. Each option is written in its
 * own language and stays put; only the row label follows the UI.
 */
function langSwitchHtml(): string {
  const options: Lang[] = ["zh", "en"];
  return `<div class="lang-row">
    <span class="foot-muted">${t.langLabel}</span>
    <div class="segmented lang-switch" id="lang-switch" role="group" aria-label="${escapeAttr(t.langAria)}">
      ${options
        .map(
          (code) =>
            `<button class="seg${lang === code ? " is-active" : ""}" type="button" data-lang="${code}" aria-pressed="${lang === code}">${LANG_LABELS[code]}</button>`,
        )
        .join("")}
    </div>
  </div>`;
}

function formatDate(ms: number): string {
  if (!ms) return t.unknownTime;
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return format(t.todayAt, {
      time: date.toLocaleTimeString(DATE_LOCALE[lang], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return t.yesterday;
  // Only 2..6 days reach this branch: same-day and yesterday were handled above.
  if (now.getTime() - ms < 7 * 864e5) {
    return format(t.daysAgo, { n: Math.floor((now.getTime() - ms) / 864e5) });
  }
  return date.toLocaleDateString(DATE_LOCALE[lang], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function plainPreview(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\s[-*]\s+/g, " ")
    .replace(/(?:\s*:\s*){3,}/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function projectLabel(path: string): string {
  if (!path) return t.unknownProject;
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function agentBadge(agent: AgentId): string {
  return `<span class="agent agent-${agent}"><span class="agent-dot agent-${agent}"></span>${AGENT_LABEL[agent]}</span>`;
}

/** The command/link/note strip for the currently selected target agent. */
function continuationDetail(continuation: Continuation): string {
  if (continuation.kind === "deep-link") {
    return `<a class="resume-link" href="${escapeAttr(continuation.command)}" title="${escapeAttr(continuation.note)}">
      <code class="resume-code">${escapeHtml(continuation.command)}</code>
    </a>
    <button class="copy-command" type="button" data-command="${escapeAttr(continuation.command)}" data-copy-label="link">${t.copyLink}</button>`;
  }
  if (continuation.command) {
    return `<code class="resume-code">${escapeHtml(continuation.command)}</code>
    <button class="copy-command" type="button" data-command="${escapeAttr(continuation.command)}">${t.copy}</button>`;
  }
  return `<span class="resume-note">${escapeHtml(continuation.note)}</span>`;
}

/**
 * "Continue in <agent>": the server sends a continuation per target agent, so
 * the page never guesses another agent's CLI. Picking a target swaps the
 * command; same-agent picks the exact resume, cross-agent picks a new session in
 * that agent with the handoff card as context.
 */
function resumeBlock(session: SessionDetail["session"]): string {
  const continuations = session.continuations ?? [];
  const selected =
    continuations.find((row) => row.targetAgent === session.agent) ??
    continuations[0];
  const options = continuations
    .map(
      (row) =>
        `<option value="${row.targetAgent}"${row === selected ? " selected" : ""}>${escapeHtml(row.label)}</option>`,
    )
    .join("");
  return `<div class="resume" data-resume>
    <span class="resume-label">${t.resumeLabel}</span>
    <select class="resume-target" aria-label="${escapeAttr(t.resumeTargetAria)}">${options}</select>
    <span class="resume-detail" data-resume-detail>${selected ? continuationDetail(selected) : ""}</span>
  </div>`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission can be unavailable; fall through to selection copy.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

async function copyCommand(button: HTMLButtonElement): Promise<void> {
  const command = button.dataset.command ?? "";
  // A deep link's button says "Copy link"; a command's says "Copy". Read the
  // label from the dictionary again on the way back, so a language switch during
  // the confirmation does not restore a stale word.
  const idleLabel = (): string =>
    button.dataset.copyLabel === "link" ? t.copyLink : t.copy;
  const copied = await copyText(command);
  button.textContent = copied ? t.copied : t.copyFailed;
  button.classList.toggle("is-copied", copied);
  window.setTimeout(() => {
    button.textContent = idleLabel();
    button.classList.remove("is-copied");
  }, 1400);
}

/** The resume target the action bar currently shows; `null` when it has none. */
function handoffTargetFor(scope: Element | null): string | null {
  return scope?.querySelector<HTMLSelectElement>(".resume-target")?.value ?? null;
}

/**
 * Show the outcome on the button, then restore its idle label. The restore is
 * token-guarded: a page or target change during the 1.6s confirmation owns the
 * button by then and must not be overwritten.
 */
function paintHandoffResult(button: HTMLButtonElement, copied: boolean, token: number): void {
  if (token !== handoffWarmToken) return;
  button.textContent = copied ? t.copied : t.copyFailed;
  button.classList.toggle("is-copied", copied);
  window.setTimeout(() => {
    if (token !== handoffWarmToken) return;
    button.textContent = t.handoffCopy;
    button.disabled = false;
    button.classList.remove("is-copied");
    button.title = t.handoffButtonTitle;
  }, 1600);
}

/* ---------- Q&A copy (per turn and whole conversation) ---------- */

/**
 * The turns of the session page currently on screen, in order. Copy reads the
 * raw `userText`/`assistantText` from here rather than from the DOM: the DOM
 * holds rendered Markdown, and the copy must carry the answer's code fences
 * verbatim. Cleared whenever another view is rendered.
 */
let sessionTurns: SessionDetail["turns"] = [];

/**
 * The Markdown shape of a copied turn — a stable contract shared by the
 * per-turn button and the whole-conversation copy:
 *
 *   > the user's prompt, verbatim, as a blockquote
 *   (blank line)
 *   the assistant's answer, verbatim Markdown
 *
 * An empty half is left out (some turns record no answer). The whole
 * conversation is every turn in order, separated by a `---` divider with blank
 * lines around it. A `---` inside an answer's fenced code block is data the
 * fence keeps intact, so the divider stays unambiguous to a Markdown reader.
 */
function turnMarkdown(turn: SessionDetail["turns"][number]): string {
  const parts: string[] = [];
  const user = turn.userText.trim();
  if (user) parts.push(`> ${user.replace(/\n/g, "\n> ")}`);
  const answer = turn.assistantText.trim();
  if (answer) parts.push(answer);
  return parts.join("\n\n");
}

/** Text above this size is cut and the copy says so at the tail. */
const COPY_TEXT_LIMIT = 200 * 1024;
const COPY_TEXT_LIMIT_LABEL = "200 KB";

function copyPayload(markdown: string): string {
  if (markdown.length <= COPY_TEXT_LIMIT) return markdown;
  return (
    markdown.slice(0, COPY_TEXT_LIMIT) +
    "\n\n" +
    format(t.copyTruncatedNote, { limit: COPY_TEXT_LIMIT_LABEL })
  );
}

/**
 * Copy one slice of a turn. `data-turn-copy` is the combined Q&A Markdown
 * (see `turnMarkdown`); `data-turn-copy-q`/`data-turn-copy-a` copy the raw
 * `userText`/`assistantText` verbatim — no blockquote, no decoration.
 */
async function copyTurnFromUi(button: HTMLButtonElement): Promise<void> {
  const idx = Number(button.dataset.turnCopy ?? button.dataset.turnCopyQ ?? button.dataset.turnCopyA);
  const turn = sessionTurns.find((row) => row.idx === idx);
  if (!turn) return;
  const text = button.dataset.turnCopyQ !== undefined
    ? turn.userText
    : button.dataset.turnCopyA !== undefined
      ? turn.assistantText
      : copyPayload(turnMarkdown(turn));
  const copied = await copyText(text);
  // Icon-only button: colour is the feedback, the title spells it out.
  button.classList.toggle("is-copied", copied);
  button.title = copied ? t.copied : t.copyFailed;
  window.setTimeout(() => {
    button.classList.remove("is-copied");
    button.title =
      button.dataset.turnCopyQ !== undefined
        ? t.copyQTitle
        : button.dataset.turnCopyA !== undefined
          ? t.copyATitle
          : t.copyQaTitle;
  }, 1400);
}

async function copyConversationFromUi(button: HTMLButtonElement): Promise<void> {
  if (!sessionTurns.length) return;
  const markdown = sessionTurns
    .map((turn) => turnMarkdown(turn))
    .join("\n\n---\n\n");
  const copied = await copyText(copyPayload(markdown));
  // Same feedback pattern as the handoff button it sits beside.
  button.textContent = copied ? t.copied : t.copyFailed;
  button.classList.toggle("is-copied", copied);
  window.setTimeout(() => {
    button.textContent = t.copyConversation;
    button.classList.remove("is-copied");
    button.title = t.copyConversationTitle;
  }, 1400);
}

/** Show a short notice (e.g. "ready — click again"), then restore the idle label. */
function paintHandoffNotice(button: HTMLButtonElement, message: string, token: number): void {  if (token !== handoffWarmToken) return;
  // The notice asks for another click; do not leave the button inert for 1.6s.
  button.disabled = false;
  button.textContent = message;
  button.classList.remove("is-copied");
  window.setTimeout(() => {
    if (token !== handoffWarmToken) return;
    button.textContent = t.handoffCopy;
    button.disabled = false;
    button.classList.remove("is-copied");
    button.title = t.handoffButtonTitle;
  }, 1600);
}

async function copyHandoff(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.handoff;
  if (!id) return;
  const target = handoffTargetFor(button.closest(".session-actionbar"));
  const key = handoffKey(id, target);
  // A prefetch that settles from here on describes an older page state; it must
  // not repaint the button under this click (or a later target switch).
  const token = ++handoffWarmToken;
  const cached = handoffCache.get(key);
  if (cached !== undefined) {
    // The card was prefetched with the session, so the clipboard write can start
    // inside the click handler itself. Awaiting a fetch first would lose the
    // browser's user activation and the first click would always fail.
    paintHandoffResult(button, await copyText(cached), token);
    return;
  }
  // No card in hand: a copy after an await cannot keep user activation, so wait
  // (bounded) for the card and ask for one more click on the now-warm cache.
  button.disabled = true;
  button.textContent = t.handoffPreparing;
  const pending = handoffPending.get(key);
  let outcome: HandoffWait;
  if (pending) {
    outcome = await waitForHandoff(pending.promise, HANDOFF_WAIT_MS);
  } else {
    try {
      await loadHandoff(id, target);
      outcome = "ready";
    } catch {
      outcome = "failed";
    }
  }
  // A target switch or a fresh render during the wait owns the button now.
  if (token !== handoffWarmToken) return;
  if (outcome === "timeout") {
    // Nothing conclusive happened; hand the button back rather than guess.
    button.disabled = false;
    button.textContent = t.handoffCopy;
    button.classList.remove("is-copied");
    return;
  }
  // `ready` only helps if the card actually landed: an aborted request (forget,
  // target switch) can resolve without filling the cache.
  const warm = outcome === "ready" && handoffCache.has(key);
  paintHandoffNotice(button, warm ? t.handoffReadyAgain : t.handoffUnavailable, token);
  if (!warm) button.title = t.handoffBuildFailed;
}

const handoffCache = new Map<string, string>();

interface PendingHandoff {
  promise: Promise<string>;
  abort: AbortController;
}

/** One in-flight request per (session, target), so prefetch and click share it. */
const handoffPending = new Map<string, PendingHandoff>();

/** Token of the newest prefetch; older completions must not repaint the button. */
let handoffWarmToken = 0;

async function loadHandoff(id: string, targetAgent: string | null): Promise<string> {
  const key = handoffKey(id, targetAgent);
  const cached = handoffCache.get(key);
  if (cached !== undefined) return cached;
  const inflight = handoffPending.get(key);
  if (inflight) return inflight.promise;
  const abort = new AbortController();
  const promise = (async () => {
    const query = targetAgent ? `?targetAgent=${encodeURIComponent(targetAgent)}` : "";
    const response = await fetch(
      `/api/session/${encodeURIComponent(id)}/handoff${query}`,
      { cache: "no-store", signal: abort.signal },
    );
    if (!response.ok) throw new Error(format(t.requestFailed, { status: response.status }));
    const handoff = await response.text();
    // Forget and target switches abort in-flight requests; a card that finished
    // just before the abort must not slip back into the cache.
    if (!abort.signal.aborted) rememberHandoff(handoffCache, key, handoff);
    return handoff;
  })();
  const entry: PendingHandoff = { promise, abort };
  handoffPending.set(key, entry);
  // Clear the slot once settled (a failure must be retryable), but only if this
  // request still owns it: a forget may have dropped it and a new one taken over.
  void promise
    .catch(() => {})
    .finally(() => {
      if (handoffPending.get(key) === entry) handoffPending.delete(key);
    });
  return promise;
}

/**
 * Warm the card as the session page renders and keep the button disabled until
 * it is cached (or the wait expires). This is what removes the first-click race:
 * a click can only happen once `copyText` can start inside the handler.
 *
 * A hit restores the button immediately; resolve, reject and the timeout all
 * hand it back too, so a failure falls through to the slow path instead of
 * leaving the button stuck. The token makes a stale request (an earlier target,
 * a page that has since rerendered) unable to touch the current button.
 */
function prepareHandoff(id: string, targetAgent: string | null): void {
  if (!id) return;
  const token = ++handoffWarmToken;
  const key = handoffKey(id, targetAgent);
  const button =
    byId<HTMLDivElement>("content")?.querySelector<HTMLButtonElement>(".handoff-button") ??
    null;
  const idle = (): void => {
    if (!button || token !== handoffWarmToken) return;
    button.disabled = false;
    button.textContent = t.handoffCopy;
    button.classList.remove("is-copied");
    button.title = t.handoffButtonTitle;
  };
  if (handoffCache.has(key)) {
    idle();
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = t.handoffPreparing;
  }
  const timer = window.setTimeout(idle, HANDOFF_WAIT_MS);
  loadHandoff(id, targetAgent).then(
    () => {
      window.clearTimeout(timer);
      idle();
    },
    () => {
      window.clearTimeout(timer);
      idle();
    },
  );
}

/**
 * Warm-up for a pointerdown/focus that lands before the page's own prefetch
 * settles (or after its timeout). Best effort: a failure stays silent.
 */
function prefetchHandoff(id: string, targetAgent: string | null): void {
  if (!id) return;
  const key = handoffKey(id, targetAgent);
  if (handoffCache.has(key) || handoffPending.has(key)) return;
  void loadHandoff(id, targetAgent).catch(() => {});
}

/**
 * Forgetting is destructive and permanent for this index: the rows leave it and
 * a marker keeps every later scan from re-reading the session. The agent's own
 * transcript is never touched — only the copy here. The confirm step is the only
 * guard, so it spells out both halves; a successful forget also drops the cached
 * handoff cards and returns to the results.
 */
async function forgetSessionFromUi(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.forget ?? "";
  if (!id) return;
  const title = button.closest(".session-page-head")?.querySelector("h1")?.textContent ?? id;
  const confirmed = window.confirm(format(t.forgetConfirm, { title }));
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = t.forgetting;
  try {
    const result = await api<{ briefs?: string[] }>(
      `/api/session/${encodeURIComponent(id)}/forget`,
      { method: "POST" },
    );
    // The cached handoff card is a full copy of the session.
    for (const key of [...handoffCache.keys()]) {
      if (key.startsWith(`${id}|`)) handoffCache.delete(key);
    }
    // A prefetch still in flight would put one back; cancel it instead.
    for (const [key, entry] of [...handoffPending]) {
      if (!key.startsWith(`${id}|`)) continue;
      entry.abort.abort();
      if (handoffPending.get(key) === entry) handoffPending.delete(key);
    }
    ensureSearchView();
    // The page still renders the forgotten turns until the results come back;
    // clear it now so the text does not linger on screen.
    const content = byId<HTMLDivElement>("content");
    if (content) {
      content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
    }
    window.scrollTo({ top: 0, behavior: "auto" });
    await loadFacets();
    await runSearch();
    const status = byId<HTMLDivElement>("search-status");
    if (status) {
      const stale = result.briefs?.length ?? 0;
      const note =
        stale > 0 ? format(t.forgotWithBriefs, { n: stale }) : t.forgot;
      // Forgetting is permanent by design, but a misclick should still be
      // recoverable without dropping to a terminal. The undo calls the same
      // /unforget endpoint as the CLI, then re-scans so the session returns.
      status.textContent = "";
      const text = document.createElement("span");
      text.textContent = `${note} · `;
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "status-undo";
      undo.textContent = t.undo;
      undo.title = t.undoTitle;
      undo.addEventListener("click", () => void unforgetFromUi(undo, id));
      status.append(text, undo);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = t.forgetFailed;
    button.title = error instanceof Error ? error.message : String(error);
    window.setTimeout(() => {
      button.textContent = t.forgetButton;
      button.title = t.forgetButtonTitle;
    }, 2400);
  }
}

/** Undo a forget from the status line; the next scan re-indexes the session. */
async function unforgetFromUi(button: HTMLButtonElement, id: string): Promise<void> {
  button.disabled = true;
  button.textContent = t.undoing;
  try {
    await api(`/api/session/${encodeURIComponent(id)}/unforget`, { method: "POST" });
    const status = byId<HTMLDivElement>("search-status");
    if (status) status.textContent = t.undoneIndexing;
    // The marker is gone; a scan is what actually puts the rows back.
    await fetch("/api/scan", { method: "POST" }).catch(() => null);
    await loadFacets();
    await runSearch();
    if (status) status.textContent = t.undone;
  } catch (error) {
    button.disabled = false;
    button.textContent = t.undo;
    button.title = error instanceof Error ? error.message : String(error);
    const status = byId<HTMLDivElement>("search-status");
    if (status) {
      status.textContent = format(t.undoFailed, { message: button.title, id });
    }
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? format(t.requestFailed, { status: response.status }));
  }
  return (await response.json()) as T;
}

/** Post one session flag; the route is `/star` or `/hide`, the body keyed by the flag. */
async function postSessionFlag(
  id: string,
  flag: "starred" | "hidden",
  value: boolean,
): Promise<void> {
  const suffix = flag === "starred" ? "star" : "hide";
  await api(`/api/session/${encodeURIComponent(id)}/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [flag]: value }),
  });
}

/**
 * Toggle the star in place: the button repaints itself and the facets refresh,
 * so the rail's badge follows without leaving the page.
 */
async function toggleStarFromUi(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.star ?? "";
  if (!id || button.disabled) return;
  button.disabled = true;
  try {
    const starred = !button.classList.contains("is-active");
    await postSessionFlag(id, "starred", starred);
    button.classList.toggle("is-active", starred);
    button.setAttribute("aria-pressed", String(starred));
    button.title = starred ? t.starButtonTitleActive : t.starButtonTitle;
    const icon = button.querySelector<SVGPathElement>(".star-icon path");
    if (icon) icon.setAttribute("fill", starred ? "currentColor" : "none");
    // The header's meta marker flips too, so the page stays consistent without
    // a full re-render.
    const meta = document.querySelector(".session-page-head .session-meta");
    if (meta) {
      let mark = meta.querySelector<HTMLElement>(".star-mark");
      if (starred && !mark) {
        mark = document.createElement("span");
        mark.className = "star-mark";
        mark.title = t.starButton;
        mark.setAttribute("aria-label", t.starButton);
        mark.textContent = "★";
        meta.prepend(mark);
      } else if (!starred && mark) {
        mark.remove();
      }
    }
    // The rail badge lives elsewhere.
    await loadFacets();
  } catch (error) {
    button.title = error instanceof Error ? error.message : String(error);
    window.setTimeout(() => {
      const starred = button.classList.contains("is-active");
      button.title = starred ? t.starButtonTitleActive : t.starButtonTitle;
    }, 2400);
  } finally {
    button.disabled = false;
  }
}

/**
 * Hide from the session page: back to the search view the user came from, with
 * an undo in the status line — the same shape as the forget/undo flow, but the
 * undo only flips the flag back, no scan needed.
 */
async function hideSessionFromUi(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.hide ?? "";
  if (!id || button.disabled) return;
  const title = button.closest(".session-page-head")?.querySelector("h1")?.textContent ?? id;
  if (!window.confirm(format(t.hideConfirm, { title }))) return;
  button.disabled = true;
  button.textContent = t.hideButton;
  try {
    await postSessionFlag(id, "hidden", true);
    ensureSearchView();
    const content = byId<HTMLDivElement>("content");
    if (content) {
      content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
    }
    window.scrollTo({ top: 0, behavior: "auto" });
    await loadFacets();
    await runSearch();
    const status = byId<HTMLDivElement>("search-status");
    if (status) {
      status.textContent = "";
      const text = document.createElement("span");
      text.textContent = `${t.hiddenNotice} · `;
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "status-undo";
      undo.textContent = t.undo;
      undo.title = t.undoTitle;
      undo.addEventListener("click", () => void unhideFromUi(undo, id));
      status.append(text, undo);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = t.hideFailed;
    button.title = error instanceof Error ? error.message : String(error);
    window.setTimeout(() => {
      button.textContent = t.hideButton;
      button.title = t.hideButtonTitle;
    }, 2400);
  }
}

/** Flip the hidden flag back and refresh what the current view shows. */
async function unhideFromUi(button: HTMLButtonElement, id: string): Promise<void> {
  button.disabled = true;
  try {
    await postSessionFlag(id, "hidden", false);
    button.textContent = t.undone;
    await loadFacets();
    await runSearch();
    const note = byId<HTMLElement>("session-hidden-note");
    if (note) note.remove();
  } catch (error) {
    button.disabled = false;
    button.textContent = t.unhideFailed;
    button.title = error instanceof Error ? error.message : String(error);
    const status = byId<HTMLDivElement>("search-status");
    if (status) status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderShell(): void {
  const root = byId<HTMLDivElement>("app");
  if (!root) return;
  root.innerHTML = `
    <a class="skip" href="#content">${t.skipToResults}</a>
    <div class="shell">
      <aside class="rail" id="rail" aria-label="${escapeAttr(t.railAria)}">
        <div class="brand-row">
          <a class="brand" href="#/search">session<span>recall</span></a>
          <button class="icon-btn settings-btn" id="settings-open" type="button"
            aria-haspopup="dialog" aria-controls="settings" aria-expanded="false"
            aria-label="${escapeAttr(t.settingsOpen)}" title="${escapeAttr(t.settingsOpen)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M18.9 14.6a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4.1 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.6-1H2.1a2 2 0 1 1 0-4.1h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.6V2.1a2 2 0 1 1 4.1 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4.1h-.1a1.7 1.7 0 0 0-1.6 1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn rail-close" id="rail-close" aria-label="${escapeAttr(t.closeFilters)}">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <p class="rail-sub">${t.railSub}</p>
        <div class="rail-scroll">
          <section class="filter-block">
            <h2>${t.scopeAria}</h2>
            <div class="segmented" id="scope-filters" role="group" aria-label="${escapeAttr(t.scopeAria)}"></div>
          </section>
          <section class="filter-block">
            <h2>${t.agentHeading} <span class="filter-hint">${t.agentHint}</span></h2>
            <div class="agent-combobox" id="agent-combobox">
              <button class="agent-trigger" id="agent-select" type="button"
                role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="agent-listbox" aria-label="${escapeAttr(t.filterByAgent)}">
                <span class="agent-value" id="agent-value">${t.allAgents}</span>
                <svg class="agent-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="agent-popup" id="agent-listbox" role="listbox" aria-multiselectable="true" aria-label="${escapeAttr(t.agentsAria)}" hidden>
                <div class="agent-search">
                  <input class="agent-search-input" id="agent-search" type="text"
                    placeholder="${escapeAttr(t.agentSearchPlaceholder)}"
                    aria-label="${escapeAttr(t.agentSearchAria)}" autocomplete="off" spellcheck="false">
                </div>
                <div class="agent-options" id="agent-options" role="presentation"></div>
              </div>
            </div>
            <div class="agent-chips" id="agent-chips"></div>
          </section>
          <section class="filter-block">
            <h2>${t.sessionViewHeading}</h2>
            <div class="segmented session-views" id="session-views" role="group" aria-label="${escapeAttr(t.sessionViewHeading)}"></div>
          </section>
          <section class="filter-block">
            <h2>${t.projectsHeading}</h2>
            <div class="project-combobox" id="project-combobox">
              <button class="project-trigger" id="project-select" type="button"
                role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="project-listbox" aria-label="${escapeAttr(t.filterByProject)}">
                <span class="project-value" id="project-value">${t.allProjects}</span>
                <svg class="project-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="project-popup" id="project-listbox" role="listbox" aria-label="${escapeAttr(t.projectsAria)}" hidden></div>
            </div>
          </section>
          <section class="filter-block">
            <h2>${t.timeHeading}</h2>
            <div class="segmented range-filters" id="range-filters"></div>
          </section>
          <section class="filter-block" id="save-search-block" hidden>
            <h2>${t.saveThisSearch}</h2>
            <div class="save-search-row">
              <input class="save-search-input" id="save-search-name" type="text" autocomplete="off"
                placeholder="${escapeAttr(t.savedNamePlaceholder)}" aria-label="${escapeAttr(t.savedNameAria)}" maxlength="200">
              <button class="save-search-btn" id="save-search-btn" type="button">${t.saveSearchSave}</button>
            </div>
            <p class="save-search-note" id="save-search-note" aria-live="polite"></p>
          </section>
        </div>
        <div class="rail-filter-actions" id="rail-filter-actions" hidden>
          <button class="clear-filters" id="clear-filters" type="button">
            <svg class="clear-filters-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            <span>${t.clearFilters}</span>
            <span class="clear-filters-count" id="clear-filters-count"></span>
          </button>
        </div>
        <footer class="rail-foot" id="rail-foot"></footer>
      </aside>
      <main class="main">
        <div class="main-inner">
          <header class="topbar">
            <button class="icon-btn filters-toggle" id="filters-toggle" aria-label="${escapeAttr(t.openFilters)}" aria-controls="rail" aria-expanded="false">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h8M8 15h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
            <div class="search-field">
              <svg class="search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13.4 13.4 3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              <input id="search" type="search" autocomplete="off" spellcheck="false"
                aria-label="${escapeAttr(t.searchAria)}" placeholder="${escapeAttr(t.searchPlaceholder)}">
              <kbd>⌘K</kbd>
            </div>
            <div class="toolbar">
              <div class="toolbar-filters">
                <button class="role-chip" id="role-chip" type="button" hidden></button>
              </div>
              <div class="status-line" id="search-status" aria-live="polite"></div>
            </div>
          </header>
          <div id="content" tabindex="-1"></div>
        </div>
      </main>
    </div>
    <button class="to-top" id="to-top" type="button" title="${escapeAttr(t.backToTop)}" aria-label="${escapeAttr(t.backToTop)}" hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 12.5 10 7l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="scrim" id="scrim" hidden aria-hidden="true"></div>
    <div class="settings" id="settings" hidden>
      <div class="settings-panel" id="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header class="settings-head">
          <h2 class="settings-title" id="settings-title">${t.settingsTitle}</h2>
          <button class="icon-btn settings-close" id="settings-close" type="button" aria-label="${escapeAttr(t.settingsClose)}">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </header>
        <div class="settings-body" id="settings-body"></div>
      </div>
    </div>
  `;
  bindShell();
  // A language switch rebuilds the whole shell; the drawer is chrome too, so it
  // comes back open rather than vanishing under the pointer.
  if (settingsOpen) openSettings(false);
}

/**
 * `document`/`window` handlers outlive the elements `renderShell` rebuilds, so
 * they are registered once per page. The language switch re-renders the shell
 * (its copy is chrome too), and without this guard every switch would stack
 * another copy of the keyboard, resize, scroll and hashchange handlers.
 */
let globalHandlersBound = false;

function bindShell(): void {
  byId<HTMLInputElement>("search")?.addEventListener("input", (event) => {
    state.q = (event.target as HTMLInputElement).value;
    ensureSearchView();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      syncHash();
      void runSearch();
    }, 180);
  });

  byId<HTMLButtonElement>("filters-toggle")?.addEventListener("click", () => {
    const open = !document.body.classList.contains("filters-open");
    setFiltersOpen(open);
    // Move focus into the drawer when it opens, and back to the toggle when it
    // closes, so keyboard users are never stranded on the page behind it.
    if (open) byId<HTMLButtonElement>("rail-close")?.focus();
    else byId<HTMLButtonElement>("filters-toggle")?.focus();
  });
  byId<HTMLButtonElement>("rail-close")?.addEventListener("click", closeFilters);
  byId<HTMLDivElement>("scrim")?.addEventListener("click", closeFilters);

  bindAgentCombobox();
  bindProjectCombobox();
  bindToTop();

  byId<HTMLDivElement>("range-filters")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-range]");
    if (!button) return;
    ensureSearchView();
    state.range = button.dataset.range as Range;
    syncHash();
    renderControls();
    closeFilters();
    void runSearch();
  });

  byId<HTMLDivElement>("session-views")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-view]");
    if (!button) return;
    ensureSearchView();
    state.sessionView = button.dataset.sessionView as SessionView;
    syncHash();
    renderControls();
    closeFilters();
    void runSearch();
  });

  byId<HTMLElement>("brief-block")?.addEventListener("click", (event) => {
    const modeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-brief-mode]");
    if (modeButton) {
      const mode = modeButton.dataset.briefMode === "week" ? "week" : "day";
      if (mode !== briefMode) {
        briefMode = mode;
        renderBriefBlock();
      }
      return;
    }
    const dateTrigger = (event.target as HTMLElement).closest<HTMLElement>("#brief-date");
    if (dateTrigger) {
      if (datePicker) closeDatePicker();
      else openDatePicker(dateTrigger);
      return;
    }
    if ((event.target as HTMLElement).closest("[data-brief]")) {
      void generateBriefFile();
    }
  });

  // The gear is static per shell render; the modal is opened from the rail.
  byId<HTMLButtonElement>("settings-open")?.addEventListener("click", () => {
    openSettings();
  });

  byId<HTMLDivElement>("scope-filters")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-scope]");
    if (!button) return;
    ensureSearchView();
    state.scope = button.dataset.scope as Scope;
    syncHash();
    renderControls();
    void runSearch();
  });

  byId<HTMLButtonElement>("role-chip")?.addEventListener("click", () => {
    // The rail no longer exposes a role control; the chip is the only way back
    // to all-roles when a saved search or deep link narrows it.
    ensureSearchView();
    state.role = "all";
    syncHash();
    renderControls();
    void runSearch();
  });

  byId<HTMLButtonElement>("clear-filters")?.addEventListener("click", () => {
    ensureSearchView();
    state.agents = [];
    state.project = "";
    state.range = "all";
    state.sessionView = "all";
    syncHash();
    renderControls();
    void runSearch();
  });

  byId<HTMLButtonElement>("save-search-btn")?.addEventListener("click", () => {
    void saveCurrentSearch();
  });
  byId<HTMLInputElement>("save-search-name")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveCurrentSearch();
    }
  });



  byId<HTMLDivElement>("settings")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    // The panel is the only child; a click landing on the backdrop closes.
    if (target.closest("#settings-close") || target.id === "settings") {
      closeSettings();
      return;
    }
    const themeButton = target.closest<HTMLButtonElement>("button[data-theme-mode]");
    if (themeButton) {
      const mode = themeButton.dataset.themeMode;
      if (isThemeMode(mode)) {
        applyTheme(mode);
        renderSettings();
        void saveTheme(mode);
      }
      return;
    }
    const langButton = target.closest<HTMLButtonElement>("button[data-lang]");
    if (langButton) {
      const pref = langButton.dataset.lang;
      if (isLangPref(pref) && pref !== langPref) {
        applyLanguage(pref);
        // The rail, the search box and the drawer are all chrome, so repaint
        // them in place rather than reloading the page. Rebuilding the shell is
        // why its global handlers are bound only once.
        closeProjectPopup();
        closeAgentPopup();
        renderShell();
        // The rebuilt shell has a fresh scrim; leave the filter drawer closed
        // rather than open over a page that no longer matches its state.
        setFiltersOpen(false);
        route();
        // The rebuilt shell dropped focus to <body>; put it back on the switch.
        byId<HTMLDivElement>("lang-switch")
          ?.querySelector<HTMLButtonElement>(`[data-lang="${lang}"]`)
          ?.focus();
        void saveLanguage(pref);
      }
      return;
    }
    if (target.closest("[data-refresh]")) void refreshIndex();
  });

  byId<HTMLDivElement>("content")?.addEventListener("click", onContentClick);

  if (globalHandlersBound) return;

  document.addEventListener("keydown", (event) => {
    // The settings drawer is modal: it owns Escape and Tab, and no other view
    // may take focus behind it while it is open.
    if (settingsOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      } else if (event.key === "Tab") {
        trapSettingsFocus(event);
      }
      return;
    }
    trapFiltersFocus(event);
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      byId<HTMLInputElement>("search")?.focus();
      return;
    }
    if (event.key === "/" && !typing) {
      event.preventDefault();
      byId<HTMLInputElement>("search")?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (datePicker) {
        closeDatePicker();
        return;
      }
      closeFilters();
      if (target === byId<HTMLInputElement>("search")) {
        if (state.q) {
          state.q = "";
          const input = byId<HTMLInputElement>("search");
          if (input) input.value = "";
          syncHash();
          void runSearch();
        } else {
          target.blur();
        }
      }
    }
  });

  window.addEventListener("resize", syncTopbarHeight);

  window.addEventListener("hashchange", () => {
    const next = parseHash();
    if (
      next.view === "session" &&
      next.sessionId === state.sessionId &&
      next.turnIdx === state.turnIdx &&
      next.focus === state.focus &&
      next.processSeq === state.processSeq &&
      next.processOpen === state.processOpen
    ) {
      return;
    }
    state = next;
    route();
  });

  globalHandlersBound = true;
}

/**
 * Show/hide the off-canvas filter drawer and keep the toggle's state in sync.
 * `aria-expanded` is what tells assistive tech the rail is showing.
 */
function setFiltersOpen(open: boolean): void {
  document.body.classList.toggle("filters-open", open);
  const scrim = byId<HTMLDivElement>("scrim");
  if (scrim) scrim.hidden = !open;
  byId<HTMLButtonElement>("filters-toggle")?.setAttribute("aria-expanded", String(open));
}

function closeFilters(): void {
  const wasOpen = document.body.classList.contains("filters-open");
  setFiltersOpen(false);
  // Only restore focus when this actually closed the drawer; closeFilters also
  // runs on Escape and on views that never opened it.
  if (wasOpen) byId<HTMLButtonElement>("filters-toggle")?.focus();
}

/**
 * While the drawer is open it covers the page, so Tab must cycle inside it
 * rather than walking the hidden content behind the scrim.
 */
function trapFiltersFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !document.body.classList.contains("filters-open")) return;
  const rail = byId<HTMLElement>("rail");
  if (!rail) return;
  const focusable = Array.from(
    rail.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && rail.contains(active);
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Markdown from a brief can carry in-app links: the `sessionrecall://session/<id>`
 * deep link the brief is generated with, and older absolute loopback links
 * (`http://127.0.0.1:<port>/#/session/<id>`). Clicking either should stay inside
 * the app — `links.ts` maps them to a hash route — rather than going out to the
 * system browser or bouncing off the OS URL handler. External links, `download`
 * anchors and unrelated schemes keep their default behaviour.
 */
function onContentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (!anchor || anchor.hasAttribute("download")) return;
  const route = inAppRoute(anchor.getAttribute("href") ?? "");
  if (!route) return;
  event.preventDefault();
  location.hash = route;
}

function bindToTop(): void {
  byId<HTMLButtonElement>("to-top")?.addEventListener("click", () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
  if (!globalHandlersBound) {
    window.addEventListener("scroll", updateToTop, { passive: true });
  }
  updateToTop();
}

function updateToTop(): void {
  const button = byId<HTMLButtonElement>("to-top");
  if (button) button.hidden = window.scrollY <= TO_TOP_THRESHOLD;
}

/* ---------- agent combobox ---------- */

/**
 * The agent filter is a multi-select combobox rather than a stack of one row
 * per agent: with thirteen sources and more coming, a list of buttons in the
 * rail is the wrong shape. The trigger shows the count, the popup lists the
 * agents with their session counts, and the active ones also appear as
 * removable chips under the trigger. The filter semantics are unchanged —
 * `state.agents` is still a multi-select set.
 */
let agentOpen = false;
let activeAgentIndex = 0;
let agentQuery = "";
/** Set while a Tab is being trapped inside the popup, so the focusout that
    follows it does not close the popup before the trap takes effect. */
let agentTrapFocus = false;

function agentCounts(): Map<AgentId, number> {
  return new Map(facetsData?.agents.map((entry) => [entry.id, entry.sessions]) ?? []);
}

/** The agents offered by the popup, narrowed by the popup's search box. */
function agentOptions(): AgentId[] {
  const query = agentQuery.trim().toLowerCase();
  if (!query) return AGENTS;
  return AGENTS.filter((agent) =>
    AGENT_LABEL[agent].toLowerCase().includes(query),
  );
}

function renderAgentControl(): void {
  const value = byId<HTMLSpanElement>("agent-value");
  const chips = byId<HTMLDivElement>("agent-chips");
  const popup = byId<HTMLDivElement>("agent-listbox");
  const options = byId<HTMLDivElement>("agent-options");
  const counts = agentCounts();

  if (value) {
    const count = state.agents.length;
    value.textContent =
      count === 0
        ? t.allAgents
        : format(count === 1 ? t.agentSelected : t.agentsSelected, { n: count });
  }

  // The chips mirror the trigger: a removable chip per active agent.
  if (chips) {
    chips.innerHTML = state.agents
      .map(
        (agent) =>
          `<span class="agent-chip"><span class="agent-dot agent-${agent}"></span>${escapeHtml(AGENT_LABEL[agent])}<button class="agent-chip-remove" type="button" data-agent-remove="${agent}" aria-label="${escapeAttr(AGENT_LABEL[agent])}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></span>`,
      )
      .join("");
  }

  if (!popup || !options) return;
  const shown = agentOptions();
  if (shown.length === 0) {
    options.innerHTML = `<p class="agent-empty">${escapeHtml(t.noAgentsMatch)}</p>`;
    return;
  }
  // A narrowed filter list can leave the index past its end.
  activeAgentIndex = Math.min(activeAgentIndex, shown.length - 1);
  options.innerHTML = shown
    .map((agent, index) => {
      const active = state.agents.includes(agent);
      const count = counts.get(agent) ?? 0;
      return `<div class="agent-option${active ? " is-selected" : ""}" role="option" aria-selected="${active}" tabindex="-1" id="agent-option-${index}" data-index="${index}" data-agent-option="${agent}">
        <span class="agent-check" aria-hidden="true">${active ? "✓" : ""}</span>
        <span class="agent-dot agent-${agent}"></span>
        <span class="agent-name">${escapeHtml(AGENT_LABEL[agent])}</span>
        <span class="agent-count">${formatCount(count)}</span>
      </div>`;
    })
    .join("");
  paintActiveAgent();
}

/** Marks the keyboard-active row, distinct from the selected ones. */
function paintActiveAgent(scrollIntoView = false): void {
  const trigger = byId<HTMLButtonElement>("agent-select");
  const popup = byId<HTMLDivElement>("agent-listbox");
  if (!trigger || !popup) return;
  const options = [...popup.querySelectorAll<HTMLElement>('[role="option"]')];
  const active = options[activeAgentIndex];
  options.forEach((option) => option.classList.toggle("is-active", option === active));
  // `aria-activedescendant` only means something while the popup is open.
  if (!active || popup.hidden) {
    trigger.removeAttribute("aria-activedescendant");
    return;
  }
  trigger.setAttribute("aria-activedescendant", active.id);
  if (scrollIntoView) active.scrollIntoView({ block: "nearest" });
}

/**
 * The popup escapes the rail's scroll clipping (and its stacking context) by
 * positioning itself against the viewport, clamped to the space around the
 * trigger — the same trick the project popup uses.
 */
function positionAgentPopup(): void {
  const trigger = byId<HTMLButtonElement>("agent-select");
  const popup = byId<HTMLDivElement>("agent-listbox");
  if (!trigger || !popup || popup.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  const margin = 16;
  const limit = 340;
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  popup.style.left = `${Math.round(rect.left)}px`;
  popup.style.width = `${Math.round(rect.width)}px`;
  if (below >= Math.min(limit, 200) || below >= above) {
    popup.style.top = `${Math.round(rect.bottom + gap)}px`;
    popup.style.bottom = "auto";
    popup.style.maxHeight = `${Math.round(Math.max(120, Math.min(limit, below)))}px`;
  } else {
    popup.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
    popup.style.top = "auto";
    popup.style.maxHeight = `${Math.round(Math.max(120, Math.min(limit, above)))}px`;
  }
}

function openAgentPopup(): void {
  const trigger = byId<HTMLButtonElement>("agent-select");
  const popup = byId<HTMLDivElement>("agent-listbox");
  if (!trigger || !popup || agentOpen) return;
  agentOpen = true;
  agentQuery = "";
  const search = byId<HTMLInputElement>("agent-search");
  if (search) search.value = "";
  renderAgentControl();
  const first = agentOptions().findIndex((agent) => state.agents.includes(agent));
  activeAgentIndex = first >= 0 ? first : 0;
  popup.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  positionAgentPopup();
  paintActiveAgent(true);
  search?.focus();
}

function closeAgentPopup(focusTrigger = false): void {
  if (!agentOpen) return;
  agentOpen = false;
  const trigger = byId<HTMLButtonElement>("agent-select");
  const popup = byId<HTMLDivElement>("agent-listbox");
  if (popup) popup.hidden = true;
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (focusTrigger) trigger.focus();
  }
}

function moveActiveAgent(delta: number): void {
  const count = agentOptions().length;
  if (count === 0) return;
  activeAgentIndex = Math.min(count - 1, Math.max(0, activeAgentIndex + delta));
  paintActiveAgent(true);
}

/** Adds or removes one agent from the filter set; the popup stays open. */
function toggleAgent(agent: AgentId): void {
  ensureSearchView();
  state.agents = state.agents.includes(agent)
    ? state.agents.filter((value) => value !== agent)
    : [...state.agents, agent];
  // The keyboard-active row follows the row the user acted on; leaving it
  // stale was the combobox-highlight bug: the ✓ moved to the clicked agent
  // while the highlight stayed wherever the popup was opened.
  const index = agentOptions().indexOf(agent);
  if (index >= 0) activeAgentIndex = index;
  syncHash();
  renderControls();
  void runSearch();
}

function onAgentKeydown(event: KeyboardEvent): void {
  const open = agentOpen;
  const popup = byId<HTMLDivElement>("agent-listbox");
  if (!popup) return;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      event.preventDefault();
      if (!open) {
        openAgentPopup();
        if (event.key === "ArrowUp") {
          activeAgentIndex = Math.max(0, agentOptions().length - 1);
          paintActiveAgent(true);
        }
        return;
      }
      moveActiveAgent(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    case "Home":
    case "End": {
      if (!open) return;
      event.preventDefault();
      activeAgentIndex =
        event.key === "Home" ? 0 : Math.max(0, agentOptions().length - 1);
      paintActiveAgent(true);
      return;
    }
    case "Enter":
    case " ": {
      // Handling both keys here (and cancelling the native activation) keeps a
      // single code path: the browser would otherwise also fire `click`.
      event.preventDefault();
      if (!open) {
        openAgentPopup();
        return;
      }
      const agent = agentOptions()[activeAgentIndex];
      if (agent) toggleAgent(agent);
      return;
    }
    case "Escape": {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      closeAgentPopup(true);
      return;
    }
    case "Tab": {
      // A focus trap: Tab cycles inside the popup instead of walking into the
      // rail behind it, so the keyboard user cannot end up somewhere with the
      // listbox still open.
      if (!open) return;
      event.preventDefault();
      const focusables = [
        ...popup.querySelectorAll<HTMLElement>(
          'input, button, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.getClientRects().length > 0);
      if (focusables.length === 0) return;
      const index = focusables.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusables.length - 1 : index - 1)
        : (index < 0 || index === focusables.length - 1 ? 0 : index + 1);
      // The browser still moves focus after this handler returns, so mark the
      // trap: the focusout it causes must not close the popup.
      agentTrapFocus = true;
      focusables[next].focus();
      window.setTimeout(() => {
        agentTrapFocus = false;
      }, 0);
      return;
    }
    default:
  }
}

function bindAgentCombobox(): void {
  const trigger = byId<HTMLButtonElement>("agent-select");
  const popup = byId<HTMLDivElement>("agent-listbox");
  const combo = byId<HTMLDivElement>("agent-combobox");
  const search = byId<HTMLInputElement>("agent-search");
  const options = byId<HTMLDivElement>("agent-options");
  const chips = byId<HTMLDivElement>("agent-chips");
  if (!trigger || !popup || !combo) return;

  trigger.addEventListener("click", () => {
    if (agentOpen) closeAgentPopup();
    else openAgentPopup();
  });
  trigger.addEventListener("keydown", onAgentKeydown);

  // Type-to-filter. The query narrows the list but never changes the filter
  // itself; the selection lives in `state.agents`.
  search?.addEventListener("input", () => {
    agentQuery = search.value;
    activeAgentIndex = 0;
    const list = byId<HTMLDivElement>("agent-options");
    if (!list) return;
    const shown = agentOptions();
    if (shown.length === 0) {
      list.innerHTML = `<p class="agent-empty">${escapeHtml(t.noAgentsMatch)}</p>`;
    } else {
      const counts = agentCounts();
      list.innerHTML = shown
        .map((agent, index) => {
          const active = state.agents.includes(agent);
          const count = counts.get(agent) ?? 0;
          return `<div class="agent-option${active ? " is-selected" : ""}" role="option" aria-selected="${active}" tabindex="-1" id="agent-option-${index}" data-index="${index}" data-agent-option="${agent}">
            <span class="agent-check" aria-hidden="true">${active ? "✓" : ""}</span>
            <span class="agent-dot agent-${agent}"></span>
            <span class="agent-name">${escapeHtml(AGENT_LABEL[agent])}</span>
            <span class="agent-count">${formatCount(count)}</span>
          </div>`;
        })
        .join("");
    }
    paintActiveAgent();
  });

  options?.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-agent-option]",
    );
    if (!row) return;
    toggleAgent(row.dataset.agentOption as AgentId);
  });

  // The keyboard lives on the popup, not on each row: one handler covers both
  // the trigger and the rows inside it. The capture phase makes sure a Tab is
  // trapped before the browser moves focus anywhere.
  popup.addEventListener("keydown", onAgentKeydown, true);

  // A removable chip clears one agent without opening the popup.
  chips?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-agent-remove]",
    );
    if (!button) return;
    toggleAgent(button.dataset.agentRemove as AgentId);
  });

  // Focus leaving the combobox closes the popup — but not when Tab is cycling
  // inside it, which the keydown handler traps. The trap is armed for the
  // duration of the key event, because the browser moves focus after the
  // handler returns.
  combo.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (next instanceof Node && combo.contains(next)) return;
    if (agentOpen && agentTrapFocus) return;
    closeAgentPopup();
  });

  if (globalHandlersBound) return;

  // Closing on pointer and focus movement (rather than on `blur` alone) also
  // covers clicks on non-focusable chrome, and leaving option mousedown alone
  // keeps the popup's own scrollbar draggable. These live on `document`/`window`
  // and so look the rail up by id each time: a language switch replaces it.
  document.addEventListener("mousedown", (event) => {
    if (!agentOpen) return;
    const target = event.target;
    const current = byId<HTMLDivElement>("agent-combobox");
    if (target instanceof Node && current?.contains(target)) return;
    closeAgentPopup();
  });
  window.addEventListener("resize", () => {
    if (agentOpen) positionAgentPopup();
  });
  // A fixed-position panel cannot follow its trigger: close it when anything
  // outside the popup scrolls, including the rail.
  window.addEventListener(
    "scroll",
    (event) => {
      if (!agentOpen) return;
      const target = event.target;
      const current = byId<HTMLDivElement>("agent-listbox");
      if (target instanceof Node && current?.contains(target)) return;
      closeAgentPopup();
    },
    { passive: true, capture: true },
  );
}

/* ---------- project combobox ---------- */

interface ProjectOption {
  value: string;
  label: string;
}

let projectOpen = false;
let activeProjectIndex = 0;

function projectOptions(): ProjectOption[] {
  const options: ProjectOption[] = [{ value: "", label: t.allProjects }];
  for (const project of facetsData?.projects ?? []) {
    options.push({
      value: project.path,
      label: `${projectLabel(project.path)} · ${formatCount(project.sessions)}`,
    });
  }
  return options;
}

function renderProjectControl(): void {
  const value = byId<HTMLSpanElement>("project-value");
  const popup = byId<HTMLDivElement>("project-listbox");
  const options = projectOptions();
  const current = options.find((option) => option.value === state.project) ?? options[0];
  if (value && current) value.textContent = current.label;
  if (!popup) return;
  popup.innerHTML = options
    .map(
      (option, index) =>
        `<button class="project-option${option.value === state.project ? " is-selected" : ""}" type="button" role="option" tabindex="-1" id="project-option-${index}" data-index="${index}" data-value="${escapeAttr(option.value)}" aria-selected="${option.value === state.project}">${escapeHtml(option.label)}</button>`,
    )
    .join("");
  if (projectOpen) paintActiveProject();
}

/** Marks the keyboard-active row, distinct from the selected one. */
function paintActiveProject(scrollIntoView = false): void {
  const trigger = byId<HTMLButtonElement>("project-select");
  const popup = byId<HTMLDivElement>("project-listbox");
  if (!trigger || !popup) return;
  const options = [...popup.querySelectorAll<HTMLElement>('[role="option"]')];
  const active = options[activeProjectIndex];
  options.forEach((option) => option.classList.toggle("is-active", option === active));
  if (!active) return;
  trigger.setAttribute("aria-activedescendant", active.id);
  if (scrollIntoView) active.scrollIntoView({ block: "nearest" });
}

/**
 * The popup escapes the rail's scroll clipping (and its stacking context) by
 * positioning itself against the viewport, clamped to the space around the
 * trigger.
 */
function positionProjectPopup(): void {
  const trigger = byId<HTMLButtonElement>("project-select");
  const popup = byId<HTMLDivElement>("project-listbox");
  if (!trigger || !popup || popup.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  const margin = 16;
  const limit = 300;
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  popup.style.left = `${Math.round(rect.left)}px`;
  popup.style.width = `${Math.round(rect.width)}px`;
  if (below >= Math.min(limit, 160) || below >= above) {
    popup.style.top = `${Math.round(rect.bottom + gap)}px`;
    popup.style.bottom = "auto";
    popup.style.maxHeight = `${Math.round(Math.max(90, Math.min(limit, below)))}px`;
  } else {
    popup.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
    popup.style.top = "auto";
    popup.style.maxHeight = `${Math.round(Math.max(90, Math.min(limit, above)))}px`;
  }
}

function openProjectPopup(): void {
  const trigger = byId<HTMLButtonElement>("project-select");
  const popup = byId<HTMLDivElement>("project-listbox");
  if (!trigger || !popup || projectOpen) return;
  projectOpen = true;
  const selected = projectOptions().findIndex((option) => option.value === state.project);
  activeProjectIndex = selected >= 0 ? selected : 0;
  popup.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  positionProjectPopup();
  paintActiveProject(true);
}

function closeProjectPopup(focusTrigger = false): void {
  if (!projectOpen) return;
  projectOpen = false;
  const trigger = byId<HTMLButtonElement>("project-select");
  const popup = byId<HTMLDivElement>("project-listbox");
  if (popup) popup.hidden = true;
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (focusTrigger) trigger.focus();
  }
}

function moveActiveProject(delta: number): void {
  const count = projectOptions().length;
  activeProjectIndex = Math.min(count - 1, Math.max(0, activeProjectIndex + delta));
  paintActiveProject(true);
}

function selectProject(value: string): void {
  ensureSearchView();
  state.project = value;
  syncHash();
  closeProjectPopup();
  renderControls();
  closeFilters();
  void runSearch();
}

function onProjectKeydown(event: KeyboardEvent): void {
  const open = projectOpen;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      event.preventDefault();
      if (open) {
        moveActiveProject(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      openProjectPopup();
      if (event.key === "ArrowUp") {
        activeProjectIndex = Math.max(0, projectOptions().length - 1);
        paintActiveProject(true);
      }
      return;
    }
    case "Home":
    case "End": {
      if (!open) return;
      event.preventDefault();
      activeProjectIndex =
        event.key === "Home" ? 0 : Math.max(0, projectOptions().length - 1);
      paintActiveProject(true);
      return;
    }
    case "Enter":
    case " ": {
      // Handling both keys here (and cancelling the native activation) keeps a
      // single code path: the browser would otherwise also fire `click`.
      event.preventDefault();
      if (!open) {
        openProjectPopup();
        return;
      }
      const option = projectOptions()[activeProjectIndex];
      if (option) selectProject(option.value);
      return;
    }
    case "Escape": {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      closeProjectPopup(true);
      return;
    }
    case "Tab": {
      if (open) closeProjectPopup();
      return;
    }
    default:
  }
}

function bindProjectCombobox(): void {
  const trigger = byId<HTMLButtonElement>("project-select");
  const popup = byId<HTMLDivElement>("project-listbox");
  const combo = byId<HTMLDivElement>("project-combobox");
  if (!trigger || !popup || !combo) return;

  trigger.addEventListener("click", () => {
    if (projectOpen) closeProjectPopup();
    else openProjectPopup();
  });
  trigger.addEventListener("keydown", onProjectKeydown);

  popup.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option) return;
    const value = option.dataset.value;
    if (value !== undefined) selectProject(value);
  });

  combo.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (next instanceof Node && combo.contains(next)) return;
    closeProjectPopup();
  });

  if (globalHandlersBound) return;

  // Closing on pointer and focus movement (rather than on `blur` alone) also
  // covers clicks on non-focusable chrome, and leaving option mousedown alone
  // keeps the popup's own scrollbar draggable. These live on `document`/`window`
  // and so look the rail up by id each time: a language switch replaces it.
  document.addEventListener("mousedown", (event) => {
    if (!projectOpen) return;
    const target = event.target;
    const current = byId<HTMLDivElement>("project-combobox");
    if (target instanceof Node && current?.contains(target)) return;
    closeProjectPopup();
  });
  window.addEventListener("resize", () => {
    if (projectOpen) positionProjectPopup();
  });
  // A fixed-position panel cannot follow its trigger: close it when anything
  // outside the popup scrolls, including the rail.
  window.addEventListener(
    "scroll",
    (event) => {
      if (!projectOpen) return;
      const target = event.target;
      const current = byId<HTMLDivElement>("project-listbox");
      if (target instanceof Node && current?.contains(target)) return;
      closeProjectPopup();
    },
    { passive: true, capture: true },
  );
}

/** Attributes that identify a filter/theme control across an innerHTML rerender. */
const FOCUS_ATTRS = [
  "data-agent-option",
  "data-agent-remove",
  "data-range",
  "data-scope",
  "data-role",
  "data-session-view",
  "data-theme-mode",
  "data-lang",
];

/**
 * Remember which control has focus so a rerender can restore it. Rewriting a
 * group's innerHTML destroys the focused button and drops focus to <body>, which
 * makes the filters unusable from the keyboard.
 */
function focusedControlSelector(): string | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  for (const attr of FOCUS_ATTRS) {
    const value = el.getAttribute(attr);
    if (value !== null) return `[${attr}="${CSS.escape(value)}"]`;
  }
  return null;
}

function restoreControlFocus(selector: string | null): void {
  if (!selector) return;
  document.querySelector<HTMLElement>(selector)?.focus();
}

function renderControls(): void {
  const focus = focusedControlSelector();
  const search = byId<HTMLInputElement>("search");
  if (search) {
    search.placeholder =
      state.scope === "process"
        ? t.searchProcessPlaceholder
        : t.searchPlaceholder;
  }

  renderAgentControl();

  const sessionViews = byId<HTMLDivElement>("session-views");
  if (sessionViews) {
    // The badge counts what each view returns: the starred shelf counts sessions
    // the starred filter shows (starred, not hidden), the hidden shelf the
    // hidden ones — both straight from the facets endpoint.
    const counts: Record<SessionView, string> = {
      all: "",
      starred:
        facetsData && facetsData.starredCount > 0
          ? String(facetsData.starredCount)
          : "",
      hidden:
        facetsData && facetsData.hiddenCount > 0
          ? String(facetsData.hiddenCount)
          : "",
    };
    const labels: Record<SessionView, string> = {
      all: t.viewAll,
      starred: t.viewStarred,
      hidden: t.viewHidden,
    };
    sessionViews.innerHTML = SESSION_VIEWS.map(
      (view) =>
        `<button class="seg${state.sessionView === view ? " is-active" : ""}" data-session-view="${view}" aria-pressed="${state.sessionView === view}">${labels[view]}${
          counts[view] ? `<span class="seg-count">${counts[view]}</span>` : ""
        }</button>`,
    ).join("");
  }

  renderProjectControl();

  const rangeFilters = byId<HTMLDivElement>("range-filters");
  if (rangeFilters) {
    rangeFilters.innerHTML = RANGES.map(
      (range) =>
        `<button class="seg${state.range === range ? " is-active" : ""}" data-range="${range}" aria-pressed="${state.range === range}">${rangeLabel(range)}</button>`,
    ).join("");
  }


  const scopeFilters = byId<HTMLDivElement>("scope-filters");
  if (scopeFilters) {
    scopeFilters.innerHTML = SCOPES.map(
      (scope) =>
        `<button class="seg${state.scope === scope ? " is-active" : ""}" data-scope="${scope}" aria-pressed="${state.scope === scope}">${scopeLabel(scope)}</button>`,
    ).join("");
  }

  const roleChip = byId<HTMLButtonElement>("role-chip");
  if (roleChip) {
    // The rail has no role control any more; a saved search or deep link can
    // still carry one, and silence would hide a filter that narrows results.
    const nonDefault = state.role !== "all";
    roleChip.hidden = !nonDefault;
    if (nonDefault) {
      roleChip.textContent = `${roleLabel(state.role)} ✕`;
      roleChip.title = format(t.roleChipClear, { role: roleLabel(state.role) });
    }
  }

  renderBriefBlock();
  const activeFilters =
    state.agents.length + (state.project ? 1 : 0) + (state.range === "all" ? 0 : 1);
  const filterActions = byId<HTMLDivElement>("rail-filter-actions");
  if (filterActions) filterActions.hidden = activeFilters === 0;
  const filterCount = byId<HTMLSpanElement>("clear-filters-count");
  if (filterCount) filterCount.textContent = activeFilters > 0 ? String(activeFilters) : "";

  // The save-search affordance only exists while there is something to save;
  // it hides itself (and its stale note) on the default view.
  const saveBlock = byId<HTMLElement>("save-search-block");
  if (saveBlock) {
    const savable = state.view === "search" && hasNonDefaultFilters();
    saveBlock.hidden = !savable;
    if (!savable) {
      const note = byId<HTMLElement>("save-search-note");
      if (note) note.textContent = "";
    }
  }

  renderFoot();
  restoreControlFocus(focus);
}

/**
 * The footer is a glance, not a settings panel: the brief controls, the index
 * counters and the way into the settings drawer. Theme, language, the scan time
 * and re-index moved into the drawer.
 */
/**
 * The brief controls live at the top of the rail in one compact row; the
 * footer keeps only the stats and the transient index note.
 */
function renderBriefBlock(): void {
  const focus = focusedControlSelector();
  const block = byId<HTMLElement>("brief-block");
  if (!block) return;
  block.innerHTML = `
    <div class="brief-line">
      <div class="segmented brief-mode" id="brief-mode" role="group" aria-label="${escapeAttr(t.briefAria)}">
        <button class="seg${briefMode === "day" ? " is-active" : ""}" type="button" data-brief-mode="day" aria-pressed="${briefMode === "day"}">${t.briefDay}</button>
        <button class="seg${briefMode === "week" ? " is-active" : ""}" type="button" data-brief-mode="week" aria-pressed="${briefMode === "week"}">${t.briefWeek}</button>
      </div>
      <button class="brief-date" id="brief-date" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="${escapeAttr(t.pickDate)}">${briefDateLabelHtml()}</button>
      <button class="brief-button" type="button" data-brief>${t.briefGenerate}</button>
    </div>
    <div class="brief-status" id="brief-status" aria-live="polite"></div>`;
  restoreControlFocus(focus);
  anchorDatePicker();
}


function renderFoot(): void {
  const focus = focusedControlSelector();
  const foot = byId<HTMLElement>("rail-foot");
  if (!foot) return;
  if (!facetsData) {
    foot.innerHTML = `<div class="foot-row">
      <span class="foot-note" id="foot-note">${t.readingIndex}</span>
    </div>`;
    restoreControlFocus(focus);
    return;
  }
  const { sessions, turns } = facetsData.total;
  foot.innerHTML = `
    <div class="foot-stats">${sessions === 1 && turns === 1 ? t.footStatsOne : format(t.footStatsMany, { s: sessions, t: turns })}</div>
    <div class="foot-row">
      <span class="foot-note" id="foot-note"></span>
    </div>`;
  restoreControlFocus(focus);
}

/**
 * Transient footer copy — reading, indexing, a failed index read. The footer
 * also holds the settings gear now, so this writes into the note slot instead
 * of replacing the footer wholesale and taking the gear with it.
 */
function setFootNote(text: string): void {
  const note = byId<HTMLElement>("foot-note");
  if (note) {
    note.textContent = text;
    return;
  }
  const foot = byId<HTMLElement>("rail-foot");
  if (foot) foot.innerHTML = `<span class="foot-muted">${escapeHtml(text)}</span>`;
}

/* ---------- settings drawer ---------- */

let settingsOpen = false;

/** The time of the last scan, as the drawer's index group spells it. */
function lastScanLabel(): string {
  if (!facetsData) return t.readingIndex;
  if (!facetsData.lastScanMs) return t.notIndexed;
  return format(t.indexedAt, {
    time: new Date(facetsData.lastScanMs).toLocaleTimeString(DATE_LOCALE[lang], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
}

function settingsHtml(): string {
  return `
    <section class="settings-group" aria-labelledby="settings-appearance">
      <h3 class="settings-group-title" id="settings-appearance">${t.settingsAppearance}</h3>
      ${themeSwitchHtml()}
      ${langSwitchHtml()}
    </section>
    <section class="settings-group" aria-labelledby="settings-index">
      <h3 class="settings-group-title" id="settings-index">${t.settingsIndex}</h3>
      <div class="settings-line">
        <span>${t.settingsLastScan}</span>
        <span class="settings-value">${lastScanLabel()}</span>
      </div>
      <button class="settings-action" type="button" data-refresh>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 8A5.8 5.8 0 1 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M15.8 4.8v3.4h-3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${t.reindex}</span>
      </button>
    </section>
    <section class="settings-group" aria-labelledby="settings-shortcuts">
      <h3 class="settings-group-title" id="settings-shortcuts">${t.settingsShortcuts}</h3>
      <div class="settings-line">
        <span>${t.shortcutGlobalWake}</span>
        <span class="settings-value" id="hotkey-current">${t.hotkeyLoading}</span>
      </div>
      <div class="settings-line" id="hotkey-state-line" hidden>
        <span>${t.hotkeyCurrent}</span>
        <span class="settings-value" id="hotkey-state"></span>
      </div>
      <p class="settings-help" id="hotkey-help" hidden></p>
      <div class="hotkey-row">
        <input class="hotkey-input" id="hotkey-input" type="text" autocomplete="off" spellcheck="false"
          placeholder="${escapeAttr(t.hotkeyPlaceholder)}" aria-label="${escapeAttr(t.hotkeyInputAria)}">
        <button class="settings-action hotkey-save" type="button" data-hotkey-save>${t.hotkeySave}</button>
      </div>
      <p class="settings-help" id="hotkey-note" aria-live="polite"></p>
      <div class="hotkey-quick">
        <button class="text-btn" type="button" data-hotkey-disable>${t.hotkeyDisable}</button>
        <button class="text-btn" type="button" data-hotkey-reset>${t.hotkeyReset}</button>
      </div>
      <div class="settings-line">
        <span>${t.shortcutInApp}</span>
        <span class="settings-value">${t.shortcutFocusSearch}</span>
      </div>
    </section>
    <section class="settings-group" aria-labelledby="settings-updates">
      <h3 class="settings-group-title" id="settings-updates">${t.settingsUpdates}</h3>
      <div class="settings-line">
        <span>${t.updateCurrent}</span>
        <span class="settings-value">v${__APP_VERSION__}</span>
      </div>
      <div class="settings-line">
        <span id="update-state-label">${t.updateNotChecked}</span>
        <span class="settings-value" id="update-state">${t.readingIndex}</span>
      </div>
      <p class="settings-help" id="update-notes" hidden></p>
      <button class="settings-action" type="button" id="update-install" hidden>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0 0 3.3-3.3M10 12 6.7 8.7M4 15.5h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${t.updateNow}</span>
      </button>
      <p class="settings-help" id="update-note" aria-live="polite"></p>
      <label class="settings-line settings-toggle">
        <span>${t.checkUpdatesLabel}</span>
        <input type="checkbox" id="check-updates">
      </label>
      <p class="settings-help">${t.hotkeyPendingRestart}</p>
    </section>
    <section class="settings-group" aria-labelledby="settings-saved">
      <h3 class="settings-group-title" id="settings-saved">${t.settingsSaved}</h3>
      <ul class="saved-list" id="saved-list"></ul>
      <p class="settings-help" id="saved-note" aria-live="polite"></p>
    </section>`;
}

/* ---------- hotkey settings ---------- */

/** Mirrors `GET /api/hotkey`; see `HotkeyStatus` in src/prefs.ts. */
interface HotkeyInfo {
  hotkey: string | null;
  registered: boolean;
  error?: string;
  active?: string | null;
}

let hotkeyInfo: HotkeyInfo | null = null;
/** What the user typed, kept across drawer repaints so a rerender keeps it. */
let hotkeyDraft = "";

/**
 * The default is `DEFAULT_HOTKEY` in src/prefs.ts. It is spelled out here
 * because the web bundle cannot import that module (it pulls in `node:fs`).
 */
const DEFAULT_HOTKEY = "Option+Command+R";

const HOTKEY_MODIFIER_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Option",
  option: "Option",
  shift: "Shift",
  cmd: "Command",
  command: "Command",
};
const HOTKEY_MODIFIER_ORDER = ["Ctrl", "Option", "Shift", "Command"];

/**
 * Client-side copy of the rules `isHotkey` enforces: at least one modifier, no
 * modifier twice, a modifier may not follow the key, then a single key —
 * `A`–`Z`, `0`–`9` or `F1`–`F12`. Returns the canonical spelling, or null when
 * the input cannot be registered.
 */
function canonicalHotkey(raw: string): string | null {
  const tokens = raw
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length < 2) return null;
  const modifiers: string[] = [];
  let key: string | null = null;
  for (const token of tokens) {
    const modifier = HOTKEY_MODIFIER_LABELS[token.toLowerCase()];
    if (modifier !== undefined) {
      if (key !== null || modifiers.includes(modifier)) return null;
      modifiers.push(modifier);
      continue;
    }
    if (key !== null) return null;
    const upper = token.toUpperCase();
    const isKey =
      upper.length === 1 ? /^[A-Z0-9]$/.test(upper) : /^F([1-9]|1[0-2])$/.test(upper);
    if (!isKey) return null;
    key = upper;
  }
  if (modifiers.length === 0 || key === null) return null;
  return [...HOTKEY_MODIFIER_ORDER.filter((m) => modifiers.includes(m)), key].join("+");
}

/** Paint the fetched registration state into the drawer's live nodes. */
function renderHotkeyStatus(): void {
  const current = byId<HTMLElement>("hotkey-current");
  const stateLine = byId<HTMLElement>("hotkey-state-line");
  const stateNode = byId<HTMLElement>("hotkey-state");
  const help = byId<HTMLElement>("hotkey-help");
  if (!current || !stateLine || !stateNode || !help) return;
  if (!hotkeyInfo) return;
  const pending = hotkeyInfo.active !== undefined && hotkeyInfo.active !== hotkeyInfo.hotkey;
  current.textContent = hotkeyInfo.hotkey ?? t.hotkeyNone;
  if (pending) {
    stateNode.textContent = t.hotkeyPendingRestart;
    stateLine.hidden = false;
    return;
  }
  if (hotkeyInfo.registered) {
    stateNode.textContent = t.hotkeyRegistered;
    stateLine.hidden = false;
    help.hidden = true;
    return;
  }
  stateNode.textContent = t.hotkeyNotRegistered;
  stateLine.hidden = false;
  const error = hotkeyInfo.error ?? "";
  help.textContent = error.includes("not running") ? t.hotkeyNotRunning : error;
  help.hidden = help.textContent === "";
}

async function loadHotkeyStatus(): Promise<void> {
  try {
    hotkeyInfo = await api<HotkeyInfo>("/api/hotkey");
    renderHotkeyStatus();
  } catch {
    hotkeyInfo = null;
  }
}

async function saveHotkey(value: string | null): Promise<void> {
  const note = byId<HTMLElement>("hotkey-note");
  const setNote = (text: string) => {
    if (note) note.textContent = text;
    window.setTimeout(() => {
      if (note && note.textContent === text) note.textContent = "";
    }, 2400);
  };
  try {
    await api("/api/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hotkey: value }),
    });
    setNote(t.hotkeySaved);
  } catch (error) {
    console.error("hotkey preference not saved", error);
    setNote(t.hotkeySaveFailed);
  }
  await loadHotkeyStatus();
}

/** Save what the input holds; the canonical form is what gets stored. */
async function saveHotkeyFromInput(): Promise<void> {
  const input = byId<HTMLInputElement>("hotkey-input");
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) {
    const note = byId<HTMLElement>("hotkey-note");
    if (note) {
      note.textContent = t.hotkeyInvalid;
      window.setTimeout(() => {
        if (note && note.textContent === t.hotkeyInvalid) note.textContent = "";
      }, 2400);
    }
    return;
  }
  const canonical = canonicalHotkey(raw);
  if (canonical === null) {
    const note = byId<HTMLElement>("hotkey-note");
    if (note) {
      note.textContent = t.hotkeyInvalid;
      window.setTimeout(() => {
        if (note && note.textContent === t.hotkeyInvalid) note.textContent = "";
      }, 2400);
    }
    input.focus();
    return;
  }
  hotkeyDraft = canonical;
  input.value = canonical;
  await saveHotkey(canonical);
}

/** Drawer-only listeners; the body is repainted by every renderSettings call. */
function bindSettingsBody(): void {
  const body = byId<HTMLDivElement>("settings-body");
  if (!body) return;
  const input = body.querySelector<HTMLInputElement>("#hotkey-input");
  if (input) {
    input.value = hotkeyDraft;
    input.addEventListener("input", () => {
      hotkeyDraft = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveHotkeyFromInput();
      }
    });
  }
  body.querySelector("[data-hotkey-save]")?.addEventListener("click", () => {
    void saveHotkeyFromInput();
  });
  body.querySelector("[data-hotkey-disable]")?.addEventListener("click", () => {
    hotkeyDraft = "";
    const input = body.querySelector<HTMLInputElement>("#hotkey-input");
    if (input) input.value = "";
    void saveHotkey(null);
  });
  body.querySelector("[data-hotkey-reset]")?.addEventListener("click", () => {
    hotkeyDraft = DEFAULT_HOTKEY;
    const input = body.querySelector<HTMLInputElement>("#hotkey-input");
    if (input) input.value = DEFAULT_HOTKEY;
    void saveHotkey(DEFAULT_HOTKEY);
  });
  bindUpdateGroup(body);
  bindSavedList(body);
}

/** Drawer-only listeners for the update group; fresh nodes on every repaint. */
function bindUpdateGroup(body: HTMLElement): void {
  body.querySelector("#update-install")?.addEventListener("click", () => {
    void installUpdate();
  });
  const box = body.querySelector<HTMLInputElement>("#check-updates");
  if (box) {
    box.checked = checkUpdatesValue;
    box.addEventListener("change", () => {
      checkUpdatesValue = box.checked;
      void api("/api/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkUpdates: box.checked }),
      }).catch((error) => {
        console.error("checkUpdates preference not saved", error);
      });
    });
  }
}

/* ---------- update settings ---------- */

/** Injected by scripts/build.ts from package.json's version field. */
declare const __APP_VERSION__: string;

/** Mirrors `GET /api/update`; see `UpdateStatus` in src/prefs.ts. */
interface UpdateInfo {
  available: boolean;
  version?: string;
  notes?: string;
  error?: string;
  checkedAt?: number;
  installing?: boolean;
}

let updateInfo: UpdateInfo | null = null;
let updatePollTimer = 0;

/** Saved searches from `GET /api/saved-searches`; null until the first load. */
interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: Record<string, string>;
  createdAt: number;
}

let savedSearches: SavedSearch[] | null = null;
/** The row currently being renamed; survives drawer repaints. */
let renamingSavedId = "";
/** `checkUpdates` is a per-shell pref; the checkbox mirrors the server's value. */
let checkUpdatesValue = true;

async function loadUpdateStatus(): Promise<void> {
  try {
    updateInfo = await api<UpdateInfo>("/api/update");
  } catch {
    updateInfo = null;
  }
  renderUpdateGroup();
}

function renderUpdateGroup(): void {
  const stateLabel = byId<HTMLElement>("update-state-label");
  const state = byId<HTMLElement>("update-state");
  const notes = byId<HTMLElement>("update-notes");
  const install = byId<HTMLButtonElement>("update-install");
  if (!stateLabel || !state || !notes || !install) return;
  if (!updateInfo) {
    stateLabel.textContent = t.updateCheckFailed;
    state.textContent = "";
    notes.hidden = true;
    install.hidden = true;
    return;
  }
  if (updateInfo.installing) {
    stateLabel.textContent = t.updateInstalling;
    state.textContent = "";
    notes.hidden = true;
    install.hidden = true;
    return;
  }
  if (updateInfo.available) {
    stateLabel.textContent = t.updateAvailable;
    state.textContent = updateInfo.version ? `v${updateInfo.version}` : "";
    notes.textContent = updateInfo.notes ?? "";
    notes.hidden = notes.textContent === "";
    install.hidden = false;
    return;
  }
  install.hidden = true;
  if (updateInfo.checkedAt === undefined) {
    // No state file yet: the shell checks ten seconds after launch. Absence
    // is not a failure, so this renders as a state, not an error.
    stateLabel.textContent = t.updateNotChecked;
    state.textContent = "";
    notes.hidden = true;
    return;
  }
  stateLabel.textContent = t.updateLatest;
  state.textContent = "";
  notes.textContent = updateInfo.error
    ? updateInfo.error
    : format(t.updateLastChecked, {
        time: new Date(updateInfo.checkedAt).toLocaleTimeString(DATE_LOCALE[lang], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
  notes.hidden = notes.textContent === "";
}

async function installUpdate(): Promise<void> {
  const note = byId<HTMLElement>("update-note");
  try {
    await api("/api/update/install", { method: "POST" });
    if (note) note.textContent = t.updateInstallRequested;
    // The shell does the download itself; watch its state file flip to
    // `installing` (and then to a restart) rather than guessing.
    window.clearInterval(updatePollTimer);
    updatePollTimer = window.setInterval(() => void loadUpdateStatus(), 2000);
    window.setTimeout(() => window.clearInterval(updatePollTimer), 60_000);
  } catch (error) {
    if (note) {
      note.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

async function loadCheckUpdates(): Promise<void> {
  const box = byId<HTMLInputElement>("check-updates");
  if (!box) return;
  try {
    const prefs = await api<{ checkUpdates?: unknown }>("/api/prefs");
    checkUpdatesValue = prefs.checkUpdates !== false;
  } catch {
    checkUpdatesValue = true;
  }
  box.checked = checkUpdatesValue;
}

/* ---------- saved searches ---------- */

function savedSearchHash(search: SavedSearch): string {
  // The contract: filters values are the hash's own string values ("1"/"0"
  // for booleans), expanded verbatim; the query travels as `q`, encoded the
  // way `parseHash` decodes it (encodeURIComponent, not URLSearchParams).
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search.filters)) params.set(key, value);
  const query = search.query ? `q=${encodeURIComponent(search.query)}` : "";
  const rest = params.toString();
  const joined = [query, rest].filter(Boolean).join("&");
  return `#/search${joined ? `?${joined}` : ""}`;
}

async function loadSavedSearches(): Promise<void> {
  try {
    const body = await api<{ searches: SavedSearch[] }>("/api/saved-searches");
    savedSearches = body.searches;
  } catch {
    savedSearches = null;
  }
  renderSavedList();
}

function renderSavedList(): void {
  const list = byId<HTMLUListElement>("saved-list");
  if (!list) return;
  if (!savedSearches) {
    list.innerHTML = `<li class="saved-empty">${t.readingIndex}</li>`;
    return;
  }
  if (savedSearches.length === 0) {
    list.innerHTML = `<li class="saved-empty">${t.savedEmpty}</li>`;
    return;
  }
  list.innerHTML = savedSearches
    .map((search) =>
      search.id === renamingSavedId
        ? `<li class="saved-row is-renaming" data-saved-id="${escapeAttr(search.id)}">
            <input class="saved-rename-input" type="text" value="${escapeAttr(search.name)}"
              aria-label="${escapeAttr(t.savedNameAria)}" maxlength="200">
            <button class="text-btn" type="button" data-saved-rename-save>${t.hotkeySave}</button>
            <button class="text-btn" type="button" data-saved-rename-cancel>${t.undo}</button>
          </li>`
        : `<li class="saved-row" data-saved-id="${escapeAttr(search.id)}">
            <button class="saved-open" type="button" title="${escapeAttr(t.savedOpen)}"
              data-saved-open>${escapeHtml(search.name)}</button>
            <span class="saved-query">${escapeHtml(search.query || t.viewAll)}</span>
            <button class="text-btn" type="button" data-saved-rename title="${escapeAttr(t.savedRename)}">${t.savedRename}</button>
            <button class="text-btn" type="button" data-saved-delete title="${escapeAttr(t.savedDelete)}">${t.savedDelete}</button>
          </li>`,
    )
    .join("");
  const renaming = list.querySelector<HTMLInputElement>(".saved-rename-input");
  if (renaming) {
    renaming.focus();
    renaming.select();
  }
}

function bindSavedList(body: HTMLElement): void {
  const list = body.querySelector<HTMLUListElement>("#saved-list");
  if (!list) return;
  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-saved-id]");
    if (!row) return;
    const id = row.dataset.savedId ?? "";
    if (target.closest("[data-saved-open]")) {
      const search = savedSearches?.find((row2) => row2.id === id);
      if (search) {
        closeSettings();
        location.hash = savedSearchHash(search);
      }
      return;
    }
    if (target.closest("[data-saved-rename]")) {
      renamingSavedId = id;
      renderSavedList();
      return;
    }
    if (target.closest("[data-saved-rename-cancel]")) {
      renamingSavedId = "";
      renderSavedList();
      return;
    }
    if (target.closest("[data-saved-rename-save]")) {
      void renameSavedSearch(id, row);
      return;
    }
    const del = target.closest<HTMLButtonElement>("[data-saved-delete]");
    if (del) void deleteSavedSearchFromUi(del, id);
  });
  // Enter commits a rename, Escape cancels it.
  list.addEventListener("keydown", (event) => {
    const input = event.target as HTMLElement;
    if (!input.classList.contains("saved-rename-input")) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    const row = input.closest<HTMLElement>("[data-saved-id]");
    if (!row) return;
    const id = row.dataset.savedId ?? "";
    if (event.key === "Escape") {
      renamingSavedId = "";
      renderSavedList();
      return;
    }
    void renameSavedSearch(id, row);
  });
}

const savedNoteResetters = new Map<string, number>();
function setSavedNote(text: string): void {
  const note = byId<HTMLElement>("saved-note");
  if (!note) return;
  note.textContent = text;
  window.clearTimeout(savedNoteResetters.get(text));
  savedNoteResetters.set(
    text,
    window.setTimeout(() => {
      if (note.textContent === text) note.textContent = "";
    }, 2400),
  );
}

async function renameSavedSearch(id: string, row: HTMLElement): Promise<void> {
  const input = row.querySelector<HTMLInputElement>(".saved-rename-input");
  const name = input?.value.trim() ?? "";
  if (!name) return;
  try {
    await api(`/api/saved-searches/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    renamingSavedId = "";
    await loadSavedSearches();
  } catch (error) {
    setSavedNote(`${t.savedRenameFailed}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deleteSavedSearchFromUi(
  button: HTMLButtonElement,
  id: string,
): Promise<void> {
  const search = savedSearches?.find((row) => row.id === id);
  const name = search?.name ?? id;
  if (!window.confirm(format(t.savedDeleteConfirm, { name }))) return;
  try {
    await api(`/api/saved-searches/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadSavedSearches();
  } catch (error) {
    setSavedNote(`${t.savedDeleteFailed}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---------- save-search entry point (search view rail) ---------- */

/**
 * The current non-default filters, in the saved-search contract's shape:
 * string values only, so the hash expansion and the server's validation see
 * exactly one canonical form.
 */
function currentSearchFilters(): Record<string, string> {
  const filters: Record<string, string> = {};
  if (state.agents.length > 0) filters.agents = state.agents.join(",");
  if (state.project) filters.project = state.project;
  if (state.role !== "all") filters.role = state.role;
  if (state.scope !== "qa") filters.scope = state.scope;
  if (state.range !== "all") filters.range = state.range;
  if (state.sessionView !== "all") filters.view = state.sessionView;
  return filters;
}

/** True when anything is set that a saved search should remember. */
function hasNonDefaultFilters(): boolean {
  return (
    state.q.trim() !== "" || Object.keys(currentSearchFilters()).length > 0
  );
}

const saveSearchNoteResetter = { timer: 0 };
function setSaveSearchNote(text: string): void {
  const note = byId<HTMLElement>("save-search-note");
  if (!note) return;
  note.textContent = text;
  window.clearTimeout(saveSearchNoteResetter.timer);
  saveSearchNoteResetter.timer = window.setTimeout(() => {
    if (note.textContent === text) note.textContent = "";
  }, 2400);
}

async function saveCurrentSearch(): Promise<void> {
  const input = byId<HTMLInputElement>("save-search-name");
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    setSaveSearchNote(t.saveSearchNameRequired);
    input.focus();
    return;
  }
  try {
    await api("/api/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        query: state.q,
        filters: currentSearchFilters(),
      }),
    });
    input.value = "";
    setSaveSearchNote(t.saveSearchSaved);
    if (settingsOpen) await loadSavedSearches();
  } catch (error) {
    setSaveSearchNote(`${t.saveSearchFailed}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Repaints the drawer body; the open/closed state lives outside it. */
function renderSettings(): void {
  const body = byId<HTMLDivElement>("settings-body");
  if (!body) return;
  const focus = focusedControlSelector();
  body.innerHTML = settingsHtml();
  bindSettingsBody();
  void loadHotkeyStatus();
  void loadUpdateStatus();
  void loadCheckUpdates();
  renderSavedList();
  void loadSavedSearches();
  if (!focus) return;
  // Scoped to the drawer on purpose: `applyTheme` puts `data-theme-mode` on
  // <html> too, and a document-wide lookup would match that instead of the
  // button that was just pressed.
  body.querySelector<HTMLElement>(focus)?.focus();
}

function openSettings(focusFirst = true): void {
  const panel = byId<HTMLElement>("settings");
  if (!panel) return;
  settingsOpen = true;
  renderSettings();
  panel.hidden = false;
  document.body.classList.add("settings-open");
  byId<HTMLButtonElement>("settings-open")?.setAttribute("aria-expanded", "true");
  if (focusFirst) byId<HTMLButtonElement>("settings-close")?.focus();
}

function closeSettings(): void {
  if (!settingsOpen) return;
  settingsOpen = false;
  const panel = byId<HTMLElement>("settings");
  if (panel) panel.hidden = true;
  document.body.classList.remove("settings-open");
  const trigger = byId<HTMLButtonElement>("settings-open");
  if (!trigger) return;
  trigger.setAttribute("aria-expanded", "false");
  trigger.focus();
}

/**
 * The drawer covers the page, so Tab must cycle inside it rather than walking
 * the content behind the backdrop.
 */
function trapSettingsFocus(event: KeyboardEvent): void {
  const panel = byId<HTMLElement>("settings-panel");
  if (!panel) return;
  const focusable = Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && panel.contains(active);
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

function route(): void {
  // Keep the footer's daily/weekly switch in step with the report being viewed.
  if (state.view === "brief") briefMode = state.briefFormat;
  const input = byId<HTMLInputElement>("search");
  if (input && input.value !== state.q) input.value = state.q;
  renderControls();
  if (state.view === "brief") {
    void renderBrief(state.briefDate, state.briefFormat);
  } else if (state.view === "session") {
    void renderSession(
      state.sessionId,
      state.turnIdx,
      state.focus,
      state.processSeq,
    );
  } else {
    lastSearchHash = location.hash && location.hash.startsWith("#/search") ? location.hash : "#/search";
    void runSearch();
  }
}

async function loadFacets(): Promise<void> {
  try {
    facetsData = await api<Facets>("/api/facets");
    renderControls();
  } catch (error) {
    setFootNote(t.indexReadFailed);
    console.error(error);
  }
}

function paramsForSearch(): string {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.agents.length > 0) params.set("agents", state.agents.join(","));
  if (state.project) params.set("project", state.project);
  params.set("role", state.role);
  params.set("scope", state.scope);
  params.set("limit", String(resultLimit));
  // The hidden shelf is the server's `hiddenOnly`; the starred shelf reuses the
  // default search plus its `starred` flag. The API rejects `hiddenOnly`
  // combined with the other two flags, so neither is ever sent alongside it.
  if (state.sessionView === "hidden") params.set("hiddenOnly", "1");
  if (state.sessionView === "starred") params.set("starred", "1");
  if (state.range !== "all") {
    const days = state.range === "7d" ? 7 : state.range === "30d" ? 30 : 90;
    params.set("from", String(Date.now() - days * 864e5));
  }
  return params.toString();
}

/** The inputs that define a result set, ignoring the page size. */
function searchCriteriaKey(): string {
  return JSON.stringify({
    q: state.q,
    agents: state.agents,
    project: state.project,
    role: state.role,
    scope: state.scope,
    range: state.range,
    sessionView: state.sessionView,
  });
}

async function runSearch(): Promise<void> {
  if (state.view !== "search") return;
  const key = searchCriteriaKey();
  if (key !== lastSearchKey) {
    lastSearchKey = key;
    resultLimit = INITIAL_RESULT_LIMIT;
  }
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  const status = byId<HTMLDivElement>("search-status");
  if (status) status.textContent = t.searching;
  // Keep a rendered result set on screen through the request; anything else
  // (cold start, an empty result set, a session/brief page left behind by
  // navigation) gets a skeleton so the page never sits blank.
  const content = byId<HTMLDivElement>("content");
  const keepResults =
    !!content && hasSearchResults() && !!content.querySelector(".result-head");
  if (content && !keepResults) {
    content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
  }
  try {
    const result = await api<SearchResult>(`/api/search?${paramsForSearch()}`, {
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    currentResults = result;
    lastTerms = result.terms;
    renderResults();
    if (status) {
      const counts = {
        sessions: formatCount(result.totalSessions),
        ms: result.tookMs.toFixed(1),
      };
      status.textContent =
        state.scope === "process"
          ? format(t.statusProcess, { ...counts, rows: formatCount(result.processTotal) })
          : format(t.statusQa, { ...counts, turns: formatCount(result.totalTurns) });
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (status) status.textContent = "";
    // The results already on screen survive a failed request; only a search
    // with nothing to show falls back to the full-page error state.
    if (keepResults) renderSearchErrorBar(error);
    else renderError(error);
  }
}

/** True when the in-memory search result set holds at least one session. */
function hasSearchResults(): boolean {
  return !!currentResults && currentResults.sessions.length > 0;
}

/** Remove the transient error bar above the current results, if any. */
function clearSearchError(): void {
  byId<HTMLElement>("search-error")?.remove();
}

/**
 * Keep the results on screen and surface the failure above them. The bar is a
 * child of `#content`, so the next successful renderResults() replaces it away.
 */
function renderSearchErrorBar(error: unknown): void {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  clearSearchError();
  const message = error instanceof Error ? error.message : String(error);
  const bar = document.createElement("div");
  bar.className = "search-error";
  bar.id = "search-error";
  bar.setAttribute("role", "alert");
  const text = document.createElement("span");
  text.className = "search-error-text";
  text.textContent = format(t.searchFailed, { message });
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "text-btn";
  retry.textContent = t.retry;
  retry.addEventListener("click", () => {
    clearSearchError();
    void runSearch();
  });
  bar.append(text, retry);
  content.prepend(bar);
}

function renderResults(): void {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  const result = currentResults;
  if (!result) {
    content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
    return;
  }
  const heading = state.q
    ? state.scope === "process"
      ? t.headingProcessSearch
      : t.headingSearch
    : state.scope === "process"
      ? t.headingRecentProcess
      : state.role === "assistant"
        ? t.headingRecentAnswers
        : t.headingRecentQuestions;
  const description = state.q
    ? state.scope === "process"
      ? format(t.descProcessQuery, { q: escapeHtml(state.q) })
      : format(t.descQaQuery, { q: escapeHtml(state.q) })
    : state.scope === "process"
      ? t.descRecentProcess
      : t.descRecent;
  const head = `<div class="result-head">
    <h1>${heading}</h1>
    <p>${description}</p>
  </div>`;

  if (result.sessions.length === 0) {
    content.innerHTML = head + emptyState();
    return;
  }

  content.innerHTML =
    head +
    `<div class="results">${result.sessions.map((session) => sessionBlock(session, result.terms)).join("")}</div>` +
    (result.sessions.length < result.totalSessions
      ? resultLimit < MAX_RESULT_LIMIT
        ? `<p class="list-foot">${format(t.listFootMore, { shown: formatCount(result.sessions.length), total: formatCount(result.totalSessions) })}<button type="button" class="load-more" data-more>${t.showMore}</button></p>`
        : `<p class="list-foot">${format(t.listFootCapped, { shown: formatCount(result.sessions.length), total: formatCount(result.totalSessions) })}</p>`
      : "");
}

function emptyState(): string {
  if (state.scope === "process") {
    return `<div class="empty">
      <h2>${t.emptyProcessTitle}</h2>
      <p>${t.emptyProcessBody}</p>
    </div>`;
  }
  if (state.q) {
    return `<div class="empty">
      <h2>${t.emptyQaTitle}</h2>
      <p>${t.emptyQaBody}</p>
    </div>`;
  }
  if (facetsData && facetsData.total.sessions === 0) {
    return `<div class="empty">
      <h2>${t.emptyIndexTitle}</h2>
      <p>${format(t.emptyIndexBody, { cmd: "<code>bun run scan</code>" })}</p>
    </div>`;
  }
  return `<div class="empty"><h2>${t.emptyRecentTitle}</h2><p>${t.emptyRecentBody}</p></div>`;
}

function sessionBlock(session: ResultSession, terms: string[]): string {
  const project = projectLabel(session.projectPath);
  const showProject = project.toLowerCase() !== AGENT_LABEL[session.agent].toLowerCase();
  const processMode = state.scope === "process";
  const count = processMode ? session.processHitCount : session.hitCount;
  const shown = processMode ? session.processHits.length : session.hits.length;
  const more = count > shown
    ? `<span class="hit-count">${format(t.hitsCount, { n: formatCount(count) })}</span>`
    : "";
  const body = processMode
    ? session.processHits.map((hit) => processHitBlock(hit, session.id, terms)).join("")
    : (state.q ? session.hits : session.hits.slice(0, 2))
        .map((hit) => hitBlock(hit, session, terms))
        .join("");
  return `<article class="session-block">
    <a class="session-head" href="#/session/${encodeURIComponent(session.id)}">
      <h2 class="session-title">${escapeHtml(session.title || t.untitledSession)}</h2>
      <div class="session-meta">
        ${agentBadge(session.agent)}
        ${session.starred ? `<span class="star-mark" title="${escapeAttr(t.starButton)}" aria-label="${escapeAttr(t.starButton)}">★</span>` : ""}
        ${session.hidden ? `<span class="hidden-badge">${t.hiddenBadge}</span>` : ""}
        ${showProject ? `<span class="project" title="${escapeAttr(session.projectPath)}">${escapeHtml(project)}</span><span class="dot-sep">·</span>` : ""}
        <time>${formatDate(session.updatedAt)}</time>
        ${more}
      </div>
    </a>
    <div class="hits">${body}</div>
  </article>`;
}

function processHitBlock(
  hit: ProcessHit,
  sessionId: string,
  terms: string[],
): string {
  const href = `#/session/${encodeURIComponent(sessionId)}?turn=${hit.turnIdx}&process=1&event=${hit.seq}`;
  const status = processStatus(hit.status);
  const label =
    hit.matchField === "error"
      ? t.errorOutputLabel
      : hit.matchField === "input"
        ? t.inputLabel
        : t.toolLabel;
  const meta = [label, hit.tool, status].filter(Boolean).join(" · ");
  return `<a class="hit process-hit" href="${href}">
    <span class="hit-label">${escapeHtml(meta)}</span>
    <p class="hit-primary">${highlight(hit.snippet || t.noContent, terms)}</p>
  </a>`;
}

function hitBlock(hit: Hit, session: ResultSession, terms: string[]): string {
  const href = `#/session/${encodeURIComponent(session.id)}?turn=${hit.idx}&hit=${hit.matchField}`;
  const prompt = hit.matchField === "user" ? hit.snippet : hit.userText;
  const answer = hit.matchField === "user" ? hit.assistantSnippet : hit.snippet;
  const answerText = plainPreview(answer);
  return `<a class="hit" href="${href}">
    <span class="hit-label">${t.questionLabel}</span>
    <p class="hit-primary">${highlight(prompt || t.noPrompt, terms)}</p>
    ${answerText ? `<p class="hit-secondary"><span class="hit-answer-label">${t.answerLabel}</span>${highlight(answerText, terms)}</p>` : ""}
  </a>`;
}

/** YAML front-matter is for tools; the page starts at the first heading. */
function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** `2026-W46 · 11/09–11/15` — the ISO week plus the days it covers. */
function weekSubtitle(week: string, range: string | null | undefined): string {
  const [start, end] = (range ?? "").split("..");
  if (!start || !end) return week;
  const short = (key: string) => key.slice(5).replace("-", "/");
  return `${week} · ${short(start)}–${short(end)}`;
}

/**
 * The report POST target for both the preview and the "Generate" button.
 *
 * The page resolves `auto` itself (it follows this browser), so it sends the
 * language it is actually showing; the server would only see the stored
 * preference, which cannot describe `auto`.
 */
function briefEndpoint(params: Record<string, string>): string {
  return `/api/brief?${new URLSearchParams({ ...params, lang }).toString()}`;
}

/**
 * `kind` is deliberately not called `format`: that name belongs to the
 * dictionary helper imported from `i18n.ts`, and a parameter of the same name
 * shadows it inside this function (the bundler then renames the import, and the
 * shadowed calls break at runtime). `test/web-app.test.ts` guards the name.
 */
async function renderBrief(ref: string, kind: "day" | "week" = "day"): Promise<void> {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  const status = byId<HTMLDivElement>("search-status");
  if (status) status.textContent = "";
  content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
  const isWeek = kind === "week";
  const endpoint = isWeek
    ? briefEndpoint({ format: "week", week: ref })
    : briefEndpoint({ date: ref });
  try {
    const response = await fetch(endpoint, { method: "POST" });
    const data = (await response.json().catch(() => null)) as
      | (BriefPayload & { error?: string })
      | null;
    if (!response.ok || !data?.markdown) {
      throw new Error(data?.error ?? format(t.requestFailed, { status: response.status }));
    }
    const subtitle = isWeek ? weekSubtitle(data.week ?? ref, data.range) : data.date;
    content.innerHTML = `
      <a class="back" href="${lastSearchHash}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${t.backToSearch}
      </a>
      <div class="brief-toolbar">
        <span class="foot-muted">${format(t.briefMeta, {
          subtitle: escapeHtml(subtitle),
          projects: formatCount(data.projects),
          sessions: formatCount(data.sessions),
          turns: formatCount(data.turns),
        })}</span>
        <a class="brief-download" href="${escapeAttr(data.download)}" download>${t.downloadMd}</a>
      </div>
      <article class="markdown brief-view">${renderMarkdown(stripFrontMatter(data.markdown))}</article>
    `;
    window.scrollTo({ top: 0, behavior: "auto" });
  } catch (error) {
    renderError(error);
  }
}

async function renderSession(
  id: string,
  turnIdx: number | null = null,
  focus: "user" | "assistant" | null = null,
  processSeq: number | null = null,
): Promise<void> {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  const status = byId<HTMLDivElement>("search-status");
  if (status) status.textContent = "";
  content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
  try {
    const detail = await api<SessionDetail>(`/api/session/${encodeURIComponent(id)}`);
    sessionTurns = detail.turns;
    const session = detail.session;
    const query = state.q.trim();
    // A deep link carries the search that produced it: it wins over whatever
    // this launch searched before, so the highlights and the back link always
    // describe the link that was opened.
    const terms = query ? parseTerms(query) : lastTerms;
    const searchHash = `#/search?q=${encodeURIComponent(query)}`;
    const backHref = query ? searchHash : lastSearchHash;
    const project = projectLabel(session.projectPath);
    const showProject = project.toLowerCase() !== AGENT_LABEL[session.agent].toLowerCase();
    const fromSearch = query
      ? `<p class="session-from-search">${format(t.fromSearch, { q: escapeHtml(query) })}<a href="${searchHash}">${t.viewSearchResults}</a></p>`
      : "";
    // A hidden session stays reachable by deep link: hiding is a filter, not a
    // lock, so the page renders fully and offers the way back.
    const hiddenNote = session.hidden
      ? `<p class="session-hidden-note" id="session-hidden-note"><span>${t.hiddenSessionNote}</span><button class="status-undo" type="button" data-unhide="${escapeAttr(session.id)}">${t.unhideButton}</button></p>`
      : "";
    const starred = session.starred;
    content.innerHTML = `
      <a class="back" href="${backHref}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${t.backToSearch}
      </a>
      <header class="session-page-head">
        <h1>${escapeHtml(session.title || t.untitledSession)}</h1>
        <div class="session-meta">
          ${agentBadge(session.agent)}
          ${starred ? `<span class="star-mark" title="${escapeAttr(t.starButton)}" aria-label="${escapeAttr(t.starButton)}">★</span>` : ""}
          ${session.hidden ? `<span class="hidden-badge">${t.hiddenBadge}</span>` : ""}
          ${showProject ? `<span class="project" title="${escapeAttr(session.projectPath)}">${escapeHtml(project)}</span><span class="dot-sep">·</span>` : ""}
          <time>${formatDate(session.updatedAt)}</time>
          <span class="dot-sep">·</span>
          <span>${format(t.turnCount, { n: formatCount(detail.turns.length) })}</span>
        </div>
      </header>
      ${fromSearch}
      ${hiddenNote}
      <div class="session-actionbar">
        ${resumeBlock(session)}
        <button class="handoff-button" type="button" data-handoff="${escapeAttr(session.id)}" title="${escapeAttr(t.handoffButtonTitle)}">${t.handoffCopy}</button>
        <button class="handoff-button" type="button" data-copy-conversation title="${escapeAttr(t.copyConversationTitle)}">${t.copyConversation}</button>
        <button class="star-button${starred ? " is-active" : ""}" type="button" data-star="${escapeAttr(session.id)}"
          aria-pressed="${starred}" title="${escapeAttr(starred ? t.starButtonTitleActive : t.starButtonTitle)}">
          <svg viewBox="0 0 20 20" aria-hidden="true" class="star-icon"><path d="M10 2.6l2.24 4.8 5.26.63-3.9 3.6 1.03 5.2L10 14.2l-4.63 2.63 1.03-5.2-3.9-3.6 5.26-.63z" fill="${starred ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <span>${t.starButton}</span>
        </button>
        <button class="forget-button" type="button" data-forget="${escapeAttr(session.id)}" title="${escapeAttr(t.forgetButtonTitle)}">${t.forgetButton}</button>
        <button class="hide-button" type="button" data-hide="${escapeAttr(session.id)}" title="${escapeAttr(t.hideButtonTitle)}">${t.hideButton}</button>
      </div>
      <div class="turns">
        ${detail.turns.map((turn) => turnBlock(turn, session.agent, terms, turnIdx, focus)).join("")}
      </div>
    `;
    // Answers are Markdown, so their matches are marked after the fact.
    const turnsEl = content.querySelector<HTMLElement>(".turns");
    if (turnsEl) markRenderedTerms(turnsEl, terms);
    window.scrollTo({ top: 0, behavior: "auto" });
    syncTopbarHeight();
    const resumeSelect = content.querySelector<HTMLSelectElement>(".resume-target");
    resumeSelect?.addEventListener("change", () => {
      const continuation = session.continuations?.find(
        (row) => row.targetAgent === resumeSelect.value,
      );
      const detail = content.querySelector<HTMLElement>("[data-resume-detail]");
      if (continuation && detail) detail.innerHTML = continuationDetail(continuation);
      // Each target renders its own card; warm this one and keep the button
      // preparing until it is cached, so its first click copies.
      prepareHandoff(session.id, resumeSelect.value);
    });
    // The card is part of the page's data, not a click-time fetch: loading it now
    // is what lets `copyHandoff` write to the clipboard synchronously on click.
    prepareHandoff(session.id, resumeSelect?.value ?? null);
    if (turnIdx !== null) {
      requestAnimationFrame(() => {
        const target = document.getElementById(
          focus ? `turn-${turnIdx}-${focus}` : `turn-${turnIdx}`,
        );
        if (!target) return;
        if (state.processOpen) {
          const details = target.querySelector<HTMLDetailsElement>("details.process");
          if (details) {
            details.open = true;
            void loadProcess(details).then(() => {
              if (processSeq !== null) {
                const event = document.getElementById(
                  `event-${turnIdx}-${processSeq}`,
                );
                if (event instanceof HTMLElement) {
                  if (event instanceof HTMLDetailsElement) event.open = true;
                  event.classList.add("is-hit");
                  scrollSessionTarget(event);
                  return;
                }
              }
              scrollSessionTarget(target);
            });
            return;
          }
        }
        scrollSessionTarget(target);
      });
    }
  } catch (error) {
    sessionTurns = [];
    renderError(error);
  }
}

function syncTopbarHeight(): void {
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const height = topbar?.getBoundingClientRect().height;
  if (!height) return;
  document.documentElement.style.setProperty("--topbar-h", `${height}px`);
}

function scrollSessionTarget(target: HTMLElement): void {
  // Center the target instead of aligning it just below the sticky chrome: a
  // deep-linked hit often has the previous turn crowding it at the top, and
  // centering keeps the matched turn clear of both the topbar and the actionbar.
  target.scrollIntoView({ block: "center", behavior: "auto" });
}

function turnBlock(
  turn: SessionDetail["turns"][number],
  agent: AgentId,
  terms: string[],
  targetIdx: number | null,
  focus: "user" | "assistant" | null,
): string {
  const number = String(turn.idx + 1).padStart(2, "0");
  const target = targetIdx === turn.idx;
  const modelBadge = turn.model
    ? `<span class="msg-model">${escapeHtml(turn.model)}</span>`
    : "";
  const user = turn.userText.trim()
    ? `<section class="msg msg-user${target && focus === "user" ? " is-hit" : ""}" id="turn-${turn.idx}-user">
        <div class="msg-label">${t.questionLabel}</div>
        <div class="msg-body">${highlight(turn.userText, terms)}</div>
      </section>`
    : "";
  const assistant = turn.assistantText.trim()
    ? `<section class="msg msg-assistant${target && focus === "assistant" ? " is-hit" : ""}" id="turn-${turn.idx}-assistant">
        <div class="msg-label">${t.answerLabel} <span class="msg-agent">${AGENT_LABEL[agent]}</span>${modelBadge}</div>
        <div class="markdown">${renderMarkdown(turn.assistantText)}</div>
        ${turn.truncated ? `<p class="truncated">${t.truncatedTurn}</p>` : ""}
      </section>`
    : `<section class="msg msg-assistant" id="turn-${turn.idx}-assistant"><div class="msg-label">${t.answerLabel}${modelBadge}</div><p class="muted">${t.noAnswerRecorded}</p></section>`;
  return `<article class="turn${target ? " is-target" : ""}" id="turn-${turn.idx}">
    <div class="turn-rail">
      <span aria-hidden="true">${number}</span>
      <div class="turn-tools">
        <button class="turn-copy" type="button" data-turn-copy-q="${turn.idx}"
          aria-label="${escapeAttr(t.copyQ)}" title="${escapeAttr(t.copyQTitle)}">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.2 6.4c0-1.2 1-2.2 2.2-2.2h9.2c1.2 0 2.2 1 2.2 2.2v5c0 1.2-1 2.2-2.2 2.2H9.8l-4 3.2v-3.2h-.4c-1.2 0-2.2-1-2.2-2.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <svg class="turn-copy-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="turn-copy" type="button" data-turn-copy-a="${turn.idx}"
          aria-label="${escapeAttr(t.copyA)}" title="${escapeAttr(t.copyATitle)}">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.2h12M4 9.6h12M4 14h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <svg class="turn-copy-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="turn-copy" type="button" data-turn-copy="${turn.idx}"
          aria-label="${escapeAttr(t.copyQa)}" title="${escapeAttr(t.copyQaTitle)}">
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="11" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12.6 4.5H6a1.8 1.8 0 0 0-1.8 1.8v8.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <svg class="turn-copy-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="turn-main">${user}${assistant}${processBlock(turn)}</div>
  </article>`;
}

function processBlock(turn: SessionDetail["turns"][number]): string {
  if (turn.eventCount <= 0) return "";
  return `<details class="process" data-turn="${turn.idx}">
    <summary>${t.processLabel} <span class="process-count">${formatCount(turn.eventCount)} ${t.processCountUnit}</span></summary>
    <div class="process-panel" data-loaded="0"></div>
  </details>`;
}

function prettyEventText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function processStatus(meta: string | null): string {
  if (!meta) return "";
  const parts = meta.split("|");
  return parts.length > 1 ? parts[parts.length - 1] : meta;
}

function processEventBlock(event: SessionEvent, turn: number): string {
  const truncated = event.truncated
    ? `<p class="truncated">${t.truncatedEvent}</p>`
    : "";
  if (event.kind === "reasoning") {
    return `<details class="process-event process-reasoning" data-seq="${event.seq}" id="event-${turn}-${event.seq}">
      <summary>${t.reasoningLabel}</summary>
      <pre class="process-pre">${escapeHtml(event.output)}</pre>
      ${truncated}
    </details>`;
  }
  const status = processStatus(event.meta);
  const input = event.input.trim()
    ? `<div class="process-section">
        <span class="process-label">${t.inputLabel}</span>
        <pre class="process-pre">${escapeHtml(prettyEventText(event.input))}</pre>
      </div>`
    : "";
  const output = event.output.trim()
    ? `<div class="process-section">
        <span class="process-label">${t.outputLabel}</span>
        <pre class="process-pre">${escapeHtml(prettyEventText(event.output))}</pre>
      </div>`
    : "";
  return `<details class="process-event process-tool" data-seq="${event.seq}" id="event-${turn}-${event.seq}">
    <summary>
      <span class="process-tool-name">${escapeHtml(event.name || "tool")}</span>
      ${status ? `<span class="process-status">${escapeHtml(status)}</span>` : ""}
    </summary>
    <div class="process-tool-body">${input}${output}${truncated}</div>
  </details>`;
}

async function loadProcess(details: HTMLDetailsElement): Promise<void> {
  const panel = details.querySelector<HTMLDivElement>(".process-panel");
  const turn = Number(details.dataset.turn ?? "-1");
  if (!panel || panel.dataset.loaded === "1" || turn < 0) return;
  panel.dataset.loaded = "1";
  panel.innerHTML = `<p class="muted process-loading">${t.processLoading}</p>`;
  try {
    const data = await api<{ turn: number; events: SessionEvent[] }>(
      `/api/session/${encodeURIComponent(state.sessionId)}/events?turn=${turn}`,
    );
    panel.innerHTML = data.events.length
      ? data.events.map((event) => processEventBlock(event, turn)).join("")
      : `<p class="muted">${t.processEmpty}</p>`;
  } catch (error) {
    panel.dataset.loaded = "0";
    const message = error instanceof Error ? error.message : String(error);
    panel.innerHTML = `<p class="muted">${format(t.processReadFailed, { message: escapeHtml(message) })}</p>`;
  }
}

function renderError(error: unknown): void {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  const message = error instanceof Error ? error.message : String(error);
  content.innerHTML = `<div class="empty">
    <h2>${t.readFailed}</h2>
    <p>${escapeHtml(message)}</p>
    <button class="text-btn" id="retry">${t.retry}</button>
  </div>`;
  byId<HTMLButtonElement>("retry")?.addEventListener("click", () => {
    if (state.view === "session") void renderSession(state.sessionId);
    // Retry the report the page was showing: a weekly view must not fall back
    // to the daily endpoint of the same key.
    else if (state.view === "brief") void renderBrief(state.briefDate, state.briefFormat);
    else void runSearch();
  });
}

async function generateBriefFile(): Promise<void> {
  const status = byId<HTMLDivElement>("brief-status");
  const date = briefDate || localDateKey();
  briefDate = date;
  const isWeek = briefMode === "week";
  if (status) status.innerHTML = `<span class="foot-muted">${t.generating}</span>`;
  try {
    const endpoint = isWeek
      ? briefEndpoint({ format: "week", date })
      : briefEndpoint({ date });
    const response = await fetch(endpoint, { method: "POST" });
    const body = (await response.json().catch(() => null)) as
      | {
          error?: string;
          path?: string;
          relativePath?: string;
          download?: string;
          date?: string;
          week?: string | null;
        }
      | null;
    if (!response.ok || !body?.download) {
      throw new Error(body?.error ?? format(t.requestFailed, { status: response.status }));
    }
    // A weekly report is keyed by ISO week, so the in-app link carries both the
    // week and the format that tells the brief view how to load it.
    const ref = isWeek ? (body.week ?? date) : (body.date ?? date);
    const suffix = isWeek ? "?format=week" : "";
    const href = `#/brief/${encodeURIComponent(ref)}${suffix}`;
    if (status) {
      status.innerHTML = `${t.generated}<a href="${escapeAttr(href)}" title="${escapeAttr(body.path ?? "")}">${t.viewOnline}</a> · <a href="${escapeAttr(body.download)}" download>${t.downloadMd}</a>`;
    }
  } catch (error) {
    if (status) {
      const message = error instanceof Error ? error.message : String(error);
      status.innerHTML = `<span class="foot-muted">${format(t.generateFailed, { message: escapeHtml(message) })}</span>`;
    }
  }
}

async function refreshIndex(): Promise<void> {
  setFootNote(t.indexing);
  try {
    await fetch("/api/scan", { method: "POST" });
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(pollStatus, 700);
  } catch {
    await loadFacets();
  }
}

async function pollStatus(): Promise<void> {
  try {
    const status = await api<{ scanning: boolean }>("/api/status");
    if (status.scanning) {
      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(pollStatus, 900);
      return;
    }
    await loadFacets();
    void runSearch();
  } catch {
    await loadFacets();
  }
}

async function boot(): Promise<void> {
  // The stored theme comes first: nothing below should paint in the wrong one.
  await loadPrefs();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (themeMode !== "auto") return;
      applyTheme("auto", false);
      // The drawer's theme switch follows the OS while it is set to auto.
      if (settingsOpen) renderSettings();
    });
  renderShell();
  document.addEventListener(
    "toggle",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLDetailsElement &&
        target.classList.contains("process") &&
        target.open
      ) {
        void loadProcess(target);
      }
    },
    true,
  );
  // Fallback warm-up for the handoff card: the page prefetches when it renders,
  // but a pointerdown (or keyboard focus) that lands before that request settles
  // still buys a little extra time before the click reads the cache.
  const warmHandoff = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(".handoff-button");
    if (!button) return;
    prefetchHandoff(
      button.dataset.handoff ?? "",
      handoffTargetFor(button.closest(".session-actionbar")),
    );
  };
  document.addEventListener("pointerdown", warmHandoff, true);
  document.addEventListener("focusin", warmHandoff);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(".copy-command");
    if (button) void copyCommand(button);
    const handoff = target.closest<HTMLButtonElement>(".handoff-button");
    if (handoff) void copyHandoff(handoff);
    const conversation = target.closest<HTMLButtonElement>("[data-copy-conversation]");
    if (conversation) void copyConversationFromUi(conversation);
    const turnCopy = target.closest<HTMLButtonElement>(
      ".turn-copy[data-turn-copy], .turn-copy[data-turn-copy-q], .turn-copy[data-turn-copy-a]",
    );
    if (turnCopy) void copyTurnFromUi(turnCopy);
    const forget = target.closest<HTMLButtonElement>(".forget-button");
    if (forget) void forgetSessionFromUi(forget);
    const star = target.closest<HTMLButtonElement>(".star-button[data-star]");
    if (star) void toggleStarFromUi(star);
    const hide = target.closest<HTMLButtonElement>(".hide-button[data-hide]");
    if (hide) void hideSessionFromUi(hide);
    const unhide = target.closest<HTMLButtonElement>("[data-unhide]");
    if (unhide instanceof HTMLButtonElement) void unhideFromUi(unhide, unhide.dataset.unhide ?? "");
    if (target.closest("[data-more]")) {
      resultLimit = Math.min(MAX_RESULT_LIMIT, resultLimit * 2);
      void runSearch();
    }
  });
  state = parseHash();
  renderControls();
  syncTopbarHeight();
  await loadFacets();
  route();
}

void boot();
