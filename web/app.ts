import { inAppRoute } from "./links.ts";
import { renderMarkdown } from "./markdown.ts";

type AgentId =
  | "omp"
  | "opencode"
  | "cursor"
  | "alma"
  | "cindy"
  | "claude-code"
  | "codex";
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
}

const AGENT_LABEL: Record<AgentId, string> = {
  omp: "omp",
  opencode: "OpenCode",
  cursor: "Cursor",
  alma: "Alma",
  cindy: "Cindy",
  "claude-code": "Claude Code",
  codex: "Codex",
};

const AGENTS: AgentId[] = [
  "cursor",
  "opencode",
  "omp",
  "claude-code",
  "codex",
  "alma",
  "cindy",
];
const RANGES: { id: Range; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "90d", label: "90 天" },
];
const ROLES: { id: Role; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "user", label: "提问" },
  { id: "assistant", label: "回答" },
];
const SCOPES: { id: Scope; label: string }[] = [
  { id: "qa", label: "问答" },
  { id: "process", label: "过程" },
];
const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];
/**
 * Same-launch cache for the first paint only (see `applyTheme`): the packaged
 * app's origin carries a fresh random port on every launch, so this value only
 * survives a reload. The server's `prefs.json` is the authority.
 */
const THEME_KEY = "session-recall-theme";
/** Scroll distance after which the floating "回到顶部" control appears. */
const TO_TOP_THRESHOLD = 400;

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
let themeMode: ThemeMode = cachedTheme();
let briefDate = localDateKey();

function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultState(): UiState {
  return {
    view: "search",
    sessionId: "",
    briefDate: "",
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

function highlight(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);
  if (terms.length === 0) return escaped;
  const parts = terms
    .map((term) => escapeHtml(term))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (parts.length === 0) return escaped;
  const matcher = new RegExp(`(${parts.map(escapeRegExp).join("|")})`, "gi");
  return escaped.replace(matcher, "<mark>$1</mark>");
}

function parseTerms(value: string): string[] {
  return value
    .split(/\s+/)
    .map((term) => term.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function parseHash(): UiState {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("/brief/")) {
    const [path] = raw.split("?");
    return {
      ...defaultState(),
      view: "brief",
      briefDate: decodeURIComponent(path.slice("/brief/".length)),
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
    return {
      ...defaultState(),
      view: "session",
      sessionId: id,
      turnIdx: Number.isFinite(turn) && turn >= 0 ? turn : null,
      focus: hit === "user" || hit === "assistant" ? hit : null,
      processOpen: params.get("process") === "1",
      processSeq: Number.isFinite(seq) && seq >= 0 ? seq : null,
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
  return {
    view: "search",
    sessionId: "",
    q: params.get("q") ?? "",
    agents,
    project: params.get("project") ?? "",
    role: role === "user" || role === "assistant" || role === "all" ? role : "all",
    scope: scope === "process" || scope === "qa" ? scope : "qa",
    range: range === "7d" || range === "30d" || range === "90d" ? range : "all",
  };
}

function syncHash(): void {
  if (state.view === "brief") {
    history.replaceState(
      null,
      "",
      `#/brief/${encodeURIComponent(state.briefDate)}`,
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
    history.replaceState(
      null,
      "",
      `#/session/${encodeURIComponent(state.sessionId)}${query ? `?${query}` : ""}`,
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
  return value.toLocaleString("zh-CN");
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

/**
 * The server owns the theme: it is served by the sidecar out of
 * `<app dir>/prefs.json`, so it outlives the port (and the origin) the packaged
 * app picks on every launch. Run before the first paint, so nothing renders in
 * the wrong theme.
 */
async function loadPrefs(): Promise<void> {
  try {
    const prefs = await api<{ theme?: unknown }>("/api/prefs");
    applyTheme(isThemeMode(prefs.theme) ? prefs.theme : "auto");
  } catch {
    // No server to ask: the cache is the best available guess.
    applyTheme(cachedTheme(), false);
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
    <span class="foot-muted">主题</span>
    <div class="segmented theme-switch" id="theme-switch" role="group" aria-label="明暗主题">
      ${THEMES.map(
        (theme) =>
          `<button class="seg${themeMode === theme.id ? " is-active" : ""}" data-theme-mode="${theme.id}" aria-pressed="${themeMode === theme.id}">${theme.label}</button>`,
      ).join("")}
    </div>
  </div>`;
}

function formatDate(ms: number): string {
  if (!ms) return "时间未知";
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return "昨天";
  if (now.getTime() - ms < 7 * 864e5) return `${Math.floor((now.getTime() - ms) / 864e5)} 天前`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
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
  if (!path) return "未识别项目";
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function agentBadge(agent: AgentId): string {
  return `<span class="agent agent-${agent}"><span class="agent-dot"></span>${AGENT_LABEL[agent]}</span>`;
}

/** The command/link/note strip for the currently selected target agent. */
function continuationDetail(continuation: Continuation): string {
  if (continuation.kind === "deep-link") {
    return `<a class="resume-link" href="${escapeAttr(continuation.command)}" title="${escapeAttr(continuation.note)}">
      <code class="resume-code">${escapeHtml(continuation.command)}</code>
    </a>
    <button class="copy-command" type="button" data-command="${escapeAttr(continuation.command)}">复制链接</button>`;
  }
  if (continuation.command) {
    return `<code class="resume-code">${escapeHtml(continuation.command)}</code>
    <button class="copy-command" type="button" data-command="${escapeAttr(continuation.command)}">复制</button>`;
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
    <span class="resume-label">继续到</span>
    <select class="resume-target" aria-label="在哪个 agent 中继续">${options}</select>
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
  const copied = await copyText(command);
  button.textContent = copied ? "已复制" : "复制失败";
  button.classList.toggle("is-copied", copied);
  window.setTimeout(() => {
    button.textContent = "复制";
    button.classList.remove("is-copied");
  }, 1400);
}

async function copyHandoff(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.handoff;
  if (!id) return;
  const target =
    button
      .closest(".session-actionbar")
      ?.querySelector<HTMLSelectElement>(".resume-target")?.value ?? null;
  button.disabled = true;
  button.textContent = "准备中…";
  try {
    const handoff = await loadHandoff(id, target);
    const copied = await copyText(handoff);
    button.textContent = copied ? "已复制" : "复制失败";
    button.classList.toggle("is-copied", copied);
  } catch {
    button.textContent = "交接不可用";
    button.title = "生成交接卡失败";
  } finally {
    window.setTimeout(() => {
      button.textContent = "复制交接";
      button.disabled = false;
      button.classList.remove("is-copied");
    }, 1600);
  }
}

const handoffCache = new Map<string, string>();

async function loadHandoff(id: string, targetAgent: string | null): Promise<string> {
  const key = `${id}|${targetAgent ?? ""}`;
  const cached = handoffCache.get(key);
  if (cached !== undefined) return cached;
  const query = targetAgent ? `?targetAgent=${encodeURIComponent(targetAgent)}` : "";
  const response = await fetch(
    `/api/session/${encodeURIComponent(id)}/handoff${query}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  const handoff = await response.text();
  handoffCache.set(key, handoff);
  return handoff;
}

/**
 * Forgetting is destructive and permanent: the rows leave the index and a marker
 * keeps every later scan from re-reading the session. The confirm step is the
 * only guard, so it spells out both halves; a successful forget also drops the
 * cached handoff cards and returns to the results.
 */
async function forgetSessionFromUi(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.forget ?? "";
  if (!id) return;
  const title = button.closest(".session-page-head")?.querySelector("h1")?.textContent ?? id;
  const confirmed = window.confirm(
    `忘记此会话？\n\n${title}\n\n它会被永久移出本机索引，之后的扫描也不会再索引它。`,
  );
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = "正在忘记…";
  try {
    const result = await api<{ briefs?: string[] }>(
      `/api/session/${encodeURIComponent(id)}/forget`,
      { method: "POST" },
    );
    // The cached handoff card is a full copy of the session.
    for (const key of [...handoffCache.keys()]) {
      if (key.startsWith(`${id}|`)) handoffCache.delete(key);
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
        stale > 0
          ? `已忘记该会话；${stale} 个已生成的简报仍引用它，可重新生成或删除`
          : "已忘记该会话，后续扫描不会再索引它";
      // Forgetting is permanent by design, but a misclick should still be
      // recoverable without dropping to a terminal. The undo calls the same
      // /unforget endpoint as the CLI, then re-scans so the session returns.
      status.textContent = "";
      const text = document.createElement("span");
      text.textContent = `${note} · `;
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "status-undo";
      undo.textContent = "撤销";
      undo.title = "恢复该会话，之后的扫描会重新索引它";
      undo.addEventListener("click", () => void unforgetFromUi(undo, id));
      status.append(text, undo);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = "忘记失败";
    button.title = error instanceof Error ? error.message : String(error);
    window.setTimeout(() => {
      button.textContent = "忘记此会话";
      button.title = "从本机索引中永久移除该会话，之后扫描不会再索引它";
    }, 2400);
  }
}

/** Undo a forget from the status line; the next scan re-indexes the session. */
async function unforgetFromUi(button: HTMLButtonElement, id: string): Promise<void> {
  button.disabled = true;
  button.textContent = "正在恢复…";
  try {
    await api(`/api/session/${encodeURIComponent(id)}/unforget`, { method: "POST" });
    const status = byId<HTMLDivElement>("search-status");
    if (status) status.textContent = "已恢复该会话，正在重新索引…";
    // The marker is gone; a scan is what actually puts the rows back.
    await fetch("/api/scan", { method: "POST" }).catch(() => null);
    await loadFacets();
    await runSearch();
    if (status) status.textContent = "已恢复该会话";
  } catch (error) {
    button.disabled = false;
    button.textContent = "撤销";
    button.title = error instanceof Error ? error.message : String(error);
    const status = byId<HTMLDivElement>("search-status");
    if (status) {
      status.textContent = `恢复失败：${button.title}。可在终端运行 bun run src/cli.ts unforget ${id}`;
    }
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${response.status})`);
  }
  return (await response.json()) as T;
}

function renderShell(): void {
  const root = byId<HTMLDivElement>("app");
  if (!root) return;
  root.innerHTML = `
    <a class="skip" href="#content">跳到结果</a>
    <div class="shell">
      <aside class="rail" id="rail" aria-label="筛选">
        <div class="brand-row">
          <a class="brand" href="#/search">session<span>recall</span></a>
          <button class="icon-btn rail-close" id="rail-close" aria-label="关闭筛选">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <p class="rail-sub">本机 agent 会话 · 只读索引</p>
        <div class="rail-scroll">
          <section class="filter-block">
            <h2>Agent <span class="filter-hint">未选 = 全部</span></h2>
            <div class="agent-filters" id="agent-filters"></div>
          </section>
          <section class="filter-block">
            <h2>项目</h2>
            <div class="project-combobox" id="project-combobox">
              <button class="project-trigger" id="project-select" type="button"
                role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="project-listbox" aria-label="按项目筛选">
                <span class="project-value" id="project-value">全部项目</span>
                <svg class="project-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="project-popup" id="project-listbox" role="listbox" aria-label="项目" hidden></div>
            </div>
          </section>
          <section class="filter-block">
            <h2>时间</h2>
            <div class="segmented range-filters" id="range-filters"></div>
          </section>
          <button class="text-btn" id="clear-filters" hidden>清除筛选</button>
        </div>
        <footer class="rail-foot" id="rail-foot"></footer>
      </aside>
      <main class="main">
        <div class="main-inner">
          <header class="topbar">
            <button class="icon-btn filters-toggle" id="filters-toggle" aria-label="打开筛选">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h8M8 15h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
            <div class="search-field">
              <svg class="search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13.4 13.4 3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              <input id="search" type="search" autocomplete="off" spellcheck="false"
                aria-label="搜索提问和回答" placeholder="搜索提问和回答…">
              <kbd>⌘K</kbd>
            </div>
            <div class="toolbar">
              <div class="toolbar-filters">
                <div class="segmented" id="scope-filters" role="group" aria-label="搜索范围类型"></div>
                <div class="segmented" id="role-filters" role="group" aria-label="问答范围"></div>
              </div>
              <div class="status-line" id="search-status" aria-live="polite"></div>
            </div>
          </header>
          <div id="content" tabindex="-1"></div>
        </div>
      </main>
    </div>
    <button class="to-top" id="to-top" type="button" title="回到顶部" aria-label="回到顶部" hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 12.5 10 7l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="scrim" id="scrim" hidden></div>
  `;
  bindShell();
}

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
    document.body.classList.toggle("filters-open");
    const scrim = byId<HTMLDivElement>("scrim");
    if (scrim) scrim.hidden = !document.body.classList.contains("filters-open");
  });
  byId<HTMLButtonElement>("rail-close")?.addEventListener("click", closeFilters);
  byId<HTMLDivElement>("scrim")?.addEventListener("click", closeFilters);

  bindProjectCombobox();
  bindToTop();

  byId<HTMLDivElement>("agent-filters")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-agent]");
    if (!button) return;
    ensureSearchView();
    const agent = button.dataset.agent as AgentId;
    state.agents = state.agents.includes(agent)
      ? state.agents.filter((value) => value !== agent)
      : [...state.agents, agent];
    syncHash();
    renderControls();
    void runSearch();
  });

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

  byId<HTMLDivElement>("scope-filters")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-scope]");
    if (!button) return;
    ensureSearchView();
    state.scope = button.dataset.scope as Scope;
    syncHash();
    renderControls();
    void runSearch();
  });

  byId<HTMLDivElement>("role-filters")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-role]");
    if (!button) return;
    ensureSearchView();
    state.role = button.dataset.role as Role;
    syncHash();
    renderControls();
    void runSearch();
  });

  byId<HTMLButtonElement>("clear-filters")?.addEventListener("click", () => {
    ensureSearchView();
    state.agents = [];
    state.project = "";
    state.range = "all";
    syncHash();
    renderControls();
    void runSearch();
  });

  byId<HTMLDivElement>("rail-foot")?.addEventListener("click", (event) => {
    const themeButton = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button[data-theme-mode]",
    );
    if (themeButton) {
      const mode = themeButton.dataset.themeMode;
      if (isThemeMode(mode)) {
        applyTheme(mode);
        renderFoot();
        void saveTheme(mode);
      }
      return;
    }
    if ((event.target as HTMLElement).closest("[data-brief]")) {
      void generateBriefFile();
      return;
    }
    if ((event.target as HTMLElement).closest("[data-refresh]")) void refreshIndex();
  });

  byId<HTMLDivElement>("rail-foot")?.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "brief-date") {
      briefDate = target.value || localDateKey();
    }
  });

  byId<HTMLDivElement>("content")?.addEventListener("click", onContentClick);

  document.addEventListener("keydown", (event) => {
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
}

function closeFilters(): void {
  document.body.classList.remove("filters-open");
  const scrim = byId<HTMLDivElement>("scrim");
  if (scrim) scrim.hidden = true;
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
  window.addEventListener("scroll", updateToTop, { passive: true });
  updateToTop();
}

function updateToTop(): void {
  const button = byId<HTMLButtonElement>("to-top");
  if (button) button.hidden = window.scrollY <= TO_TOP_THRESHOLD;
}

/* ---------- project combobox ---------- */

interface ProjectOption {
  value: string;
  label: string;
}

let projectOpen = false;
let activeProjectIndex = 0;

function projectOptions(): ProjectOption[] {
  const options: ProjectOption[] = [{ value: "", label: "全部项目" }];
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

  // Closing on pointer and focus movement (rather than on `blur` alone) also
  // covers clicks on non-focusable chrome, and leaving option mousedown alone
  // keeps the popup's own scrollbar draggable.
  document.addEventListener("mousedown", (event) => {
    if (!projectOpen) return;
    const target = event.target;
    if (target instanceof Node && combo.contains(target)) return;
    closeProjectPopup();
  });
  combo.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (next instanceof Node && combo.contains(next)) return;
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
      if (target instanceof Node && popup.contains(target)) return;
      closeProjectPopup();
    },
    { passive: true, capture: true },
  );
}

function renderControls(): void {
  const search = byId<HTMLInputElement>("search");
  if (search) {
    search.placeholder =
      state.scope === "process"
        ? "搜索文件、命令或错误…"
        : "搜索提问和回答…";
  }

  const agentFilters = byId<HTMLDivElement>("agent-filters");
  if (agentFilters) {
    const counts = new Map(facetsData?.agents.map((entry) => [entry.id, entry.sessions]) ?? []);
    agentFilters.innerHTML = AGENTS.map((agent) => {
      const active = state.agents.includes(agent);
      const count = counts.get(agent) ?? 0;
      return `<button class="agent-row${active ? " is-active" : ""}" data-agent="${agent}" aria-pressed="${active}">
        <span class="agent-dot agent-${agent}"></span>
        <span class="agent-name">${AGENT_LABEL[agent]}</span>
        <span class="agent-count">${formatCount(count)}</span>
      </button>`;
    }).join("");
  }

  renderProjectControl();

  const rangeFilters = byId<HTMLDivElement>("range-filters");
  if (rangeFilters) {
    rangeFilters.innerHTML = RANGES.map(
      (range) =>
        `<button class="seg${state.range === range.id ? " is-active" : ""}" data-range="${range.id}" aria-pressed="${state.range === range.id}">${range.label}</button>`,
    ).join("");
  }

  const scopeFilters = byId<HTMLDivElement>("scope-filters");
  if (scopeFilters) {
    scopeFilters.innerHTML = SCOPES.map(
      (scope) =>
        `<button class="seg${state.scope === scope.id ? " is-active" : ""}" data-scope="${scope.id}" aria-pressed="${state.scope === scope.id}">${scope.label}</button>`,
    ).join("");
  }

  const roleFilters = byId<HTMLDivElement>("role-filters");
  if (roleFilters) {
    roleFilters.hidden = state.scope === "process";
    roleFilters.innerHTML = ROLES.map(
      (role) =>
        `<button class="seg${state.role === role.id ? " is-active" : ""}" data-role="${role.id}" aria-pressed="${state.role === role.id}">${role.label}</button>`,
    ).join("");
  }

  const clear = byId<HTMLButtonElement>("clear-filters");
  if (clear) clear.hidden = state.agents.length === 0 && !state.project && state.range === "all";

  renderFoot();
}

function renderFoot(): void {
  const foot = byId<HTMLElement>("rail-foot");
  if (!foot) return;
  if (!facetsData) {
    foot.innerHTML = `${themeSwitchHtml()}<span class="foot-muted">正在读取索引…</span>`;
    return;
  }
  const { sessions, turns } = facetsData.total;
  const scanned = facetsData.lastScanMs
    ? `索引于 ${new Date(facetsData.lastScanMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : "尚未索引";
  foot.innerHTML = `
    ${themeSwitchHtml()}
    <div class="brief-row">
      <input id="brief-date" class="brief-date" type="date" value="${escapeAttr(briefDate)}" aria-label="简报日期">
      <button class="brief-button" type="button" data-brief>生成简报</button>
    </div>
    <div class="brief-status" id="brief-status" aria-live="polite"></div>
    <div class="foot-stats"><strong>${formatCount(sessions)}</strong> 会话 · <strong>${formatCount(turns)}</strong> 问答</div>
    <div class="foot-row">
      <span class="foot-muted">${scanned}</span>
      <button class="icon-btn" data-refresh aria-label="重新索引" title="重新索引">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 8A5.8 5.8 0 1 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M15.8 4.8v3.4h-3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`;
}

function route(): void {
  const input = byId<HTMLInputElement>("search");
  if (input && input.value !== state.q) input.value = state.q;
  renderControls();
  if (state.view === "brief") {
    void renderBrief(state.briefDate);
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
    const foot = byId<HTMLElement>("rail-foot");
    if (foot) foot.innerHTML = `<span class="foot-muted">索引读取失败</span>`;
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
  if (state.range !== "all") {
    const days = state.range === "7d" ? 7 : state.range === "30d" ? 30 : 90;
    params.set("from", String(Date.now() - days * 864e5));
  }
  return params.toString();
}

async function runSearch(): Promise<void> {
  if (state.view !== "search") return;
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  const status = byId<HTMLDivElement>("search-status");
  if (status) status.textContent = "搜索中…";
  try {
    const result = await api<SearchResult>(`/api/search?${paramsForSearch()}`, {
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    currentResults = result;
    lastTerms = result.terms;
    renderResults();
    if (status) {
      status.textContent =
        state.scope === "process"
          ? `${formatCount(result.totalSessions)} 个会话 · ${formatCount(result.processTotal)} 条过程 · ${result.tookMs.toFixed(1)} ms`
          : `${formatCount(result.totalSessions)} 个会话 · ${formatCount(result.totalTurns)} 条问答 · ${result.tookMs.toFixed(1)} ms`;
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (status) status.textContent = "";
    renderError(error);
  }
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
      ? "过程搜索"
      : "搜索结果"
    : state.scope === "process"
      ? "最近过程"
      : state.role === "assistant"
        ? "最近回答"
        : "最近提问";
  const description = state.q
    ? state.scope === "process"
      ? `包含 “${escapeHtml(state.q)}” 的工具、命令或错误 · 按最近活动`
      : `包含 “${escapeHtml(state.q)}” 的提问与回答 · 按最近活动`
    : state.scope === "process"
      ? "按最近工具活动排序"
      : "按最近活动排序";
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
        ? `<p class="list-foot">显示前 ${formatCount(result.sessions.length)} 个会话，共 ${formatCount(result.totalSessions)} 个。<button type="button" class="load-more" data-more>显示更多</button></p>`
        : `<p class="list-foot">显示前 ${formatCount(result.sessions.length)} 个会话，共 ${formatCount(result.totalSessions)} 个；已达到单次显示上限。</p>`
      : "");
}

function emptyState(): string {
  if (state.scope === "process") {
    return `<div class="empty">
      <h2>没有找到匹配的过程</h2>
      <p>过程搜索覆盖工具名、参数里的文件和命令，以及错误输出。试试更短的文件名或命令片段。</p>
    </div>`;
  }
  if (state.q) {
    return `<div class="empty">
      <h2>没有找到匹配的问答</h2>
      <p>试试更短的关键词，或把搜索范围切到「全部」，也可以清除 Agent / 项目筛选。</p>
    </div>`;
  }
  if (facetsData && facetsData.total.sessions === 0) {
    return `<div class="empty">
      <h2>索引还是空的</h2>
      <p>先在终端运行 <code>bun run scan</code>，然后刷新这个页面。</p>
    </div>`;
  }
  return `<div class="empty"><h2>还没有可显示的提问</h2><p>换一个关键词，或把范围切到「全部」。</p></div>`;
}

function sessionBlock(session: ResultSession, terms: string[]): string {
  const project = projectLabel(session.projectPath);
  const showProject = project.toLowerCase() !== AGENT_LABEL[session.agent].toLowerCase();
  const processMode = state.scope === "process";
  const count = processMode ? session.processHitCount : session.hitCount;
  const shown = processMode ? session.processHits.length : session.hits.length;
  const more = count > shown
    ? `<span class="hit-count">${formatCount(count)} 处命中</span>`
    : "";
  const body = processMode
    ? session.processHits.map((hit) => processHitBlock(hit, session.id, terms)).join("")
    : (state.q ? session.hits : session.hits.slice(0, 2))
        .map((hit) => hitBlock(hit, session, terms))
        .join("");
  return `<article class="session-block">
    <a class="session-head" href="#/session/${encodeURIComponent(session.id)}">
      <h2 class="session-title">${escapeHtml(session.title || "未命名会话")}</h2>
      <div class="session-meta">
        ${agentBadge(session.agent)}
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
      ? "错误输出"
      : hit.matchField === "input"
        ? "参数"
        : "工具";
  const meta = [label, hit.tool, status].filter(Boolean).join(" · ");
  return `<a class="hit process-hit" href="${href}">
    <span class="hit-label">${escapeHtml(meta)}</span>
    <p class="hit-primary">${highlight(hit.snippet || "（无内容）", terms)}</p>
  </a>`;
}

function hitBlock(hit: Hit, session: ResultSession, terms: string[]): string {
  const href = `#/session/${encodeURIComponent(session.id)}?turn=${hit.idx}&hit=${hit.matchField}`;
  const prompt = hit.matchField === "user" ? hit.snippet : hit.userText;
  const answer = hit.matchField === "user" ? hit.assistantSnippet : hit.snippet;
  const answerText = plainPreview(answer);
  return `<a class="hit" href="${href}">
    <span class="hit-label">提问</span>
    <p class="hit-primary">${highlight(prompt || "（无提问记录）", terms)}</p>
    ${answerText ? `<p class="hit-secondary"><span class="hit-answer-label">回答</span>${highlight(answerText, terms)}</p>` : ""}
  </a>`;
}

/** YAML front-matter is for tools; the page starts at the first heading. */
function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

async function renderBrief(date: string): Promise<void> {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  const status = byId<HTMLDivElement>("search-status");
  if (status) status.textContent = "";
  content.innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
  try {
    const response = await fetch(
      `/api/brief?date=${encodeURIComponent(date)}`,
      { method: "POST" },
    );
    const data = (await response.json().catch(() => null)) as
      | (BriefPayload & { error?: string })
      | null;
    if (!response.ok || !data?.markdown) {
      throw new Error(data?.error ?? `请求失败 (${response.status})`);
    }
    content.innerHTML = `
      <a class="back" href="${lastSearchHash}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        返回搜索
      </a>
      <div class="brief-toolbar">
        <span class="foot-muted">${escapeHtml(data.date)} · ${formatCount(data.projects)} 个项目 · ${formatCount(data.sessions)} 个会话 · ${formatCount(data.turns)} 轮问答</span>
        <a class="brief-download" href="${escapeAttr(data.download)}" download>下载 .md</a>
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
    const session = detail.session;
    const terms = lastTerms;
    const project = projectLabel(session.projectPath);
    const showProject = project.toLowerCase() !== AGENT_LABEL[session.agent].toLowerCase();
    content.innerHTML = `
      <a class="back" href="${lastSearchHash}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        返回搜索
      </a>
      <header class="session-page-head">
        <h1>${escapeHtml(session.title || "未命名会话")}</h1>
        <div class="session-meta">
          ${agentBadge(session.agent)}
          ${showProject ? `<span class="project" title="${escapeAttr(session.projectPath)}">${escapeHtml(project)}</span><span class="dot-sep">·</span>` : ""}
          <time>${formatDate(session.updatedAt)}</time>
          <span class="dot-sep">·</span>
          <span>${formatCount(detail.turns.length)} 轮问答</span>
        </div>
      </header>
      <div class="session-actionbar">
        ${resumeBlock(session)}
        <button class="handoff-button" type="button" data-handoff="${escapeAttr(session.id)}" title="复制包含问题、文件、命令和 Git 状态的交接卡">复制交接</button>
        <button class="forget-button" type="button" data-forget="${escapeAttr(session.id)}" title="从本机索引中永久移除该会话，之后扫描不会再索引它">忘记此会话</button>
      </div>
      <div class="turns">
        ${detail.turns.map((turn) => turnBlock(turn, session.agent, terms, turnIdx, focus)).join("")}
      </div>
    `;
    window.scrollTo({ top: 0, behavior: "auto" });
    syncTopbarHeight();
    const resumeSelect = content.querySelector<HTMLSelectElement>(".resume-target");
    resumeSelect?.addEventListener("change", () => {
      const continuation = session.continuations?.find(
        (row) => row.targetAgent === resumeSelect.value,
      );
      const detail = content.querySelector<HTMLElement>("[data-resume-detail]");
      if (continuation && detail) detail.innerHTML = continuationDetail(continuation);
    });
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
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const actionbar = document.querySelector<HTMLElement>(".session-actionbar");
  const offset =
    (topbar?.getBoundingClientRect().height ?? 0) +
    (actionbar?.getBoundingClientRect().height ?? 0) +
    16;
  const rect = target.getBoundingClientRect();
  // Do not scroll a target that is already comfortably visible. This keeps the
  // session header (resume / handoff) on screen when the first turn is opened.
  if (rect.top >= offset && rect.top <= window.innerHeight * 0.7) return;
  window.scrollTo({
    top: Math.max(0, window.scrollY + rect.top - offset),
    behavior: "auto",
  });
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
        <div class="msg-label">提问</div>
        <div class="msg-body">${highlight(turn.userText, terms)}</div>
      </section>`
    : "";
  const assistant = turn.assistantText.trim()
    ? `<section class="msg msg-assistant${target && focus === "assistant" ? " is-hit" : ""}" id="turn-${turn.idx}-assistant">
        <div class="msg-label">回答 <span class="msg-agent">${AGENT_LABEL[agent]}</span>${modelBadge}</div>
        <div class="markdown">${renderMarkdown(turn.assistantText)}</div>
        ${turn.truncated ? `<p class="truncated">内容较长，已截断索引。</p>` : ""}
      </section>`
    : `<section class="msg msg-assistant" id="turn-${turn.idx}-assistant"><div class="msg-label">回答${modelBadge}</div><p class="muted">（没有记录到回答）</p></section>`;
  return `<article class="turn${target ? " is-target" : ""}" id="turn-${turn.idx}">
    <div class="turn-rail" aria-hidden="true">${number}</div>
    <div class="turn-main">${user}${assistant}${processBlock(turn)}</div>
  </article>`;
}

function processBlock(turn: SessionDetail["turns"][number]): string {
  if (turn.eventCount <= 0) return "";
  return `<details class="process" data-turn="${turn.idx}">
    <summary>过程 <span class="process-count">${formatCount(turn.eventCount)} 项</span></summary>
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
    ? `<p class="truncated">内容较长，已截断。</p>`
    : "";
  if (event.kind === "reasoning") {
    return `<details class="process-event process-reasoning" data-seq="${event.seq}" id="event-${turn}-${event.seq}">
      <summary>思考过程</summary>
      <pre class="process-pre">${escapeHtml(event.output)}</pre>
      ${truncated}
    </details>`;
  }
  const status = processStatus(event.meta);
  const input = event.input.trim()
    ? `<div class="process-section">
        <span class="process-label">参数</span>
        <pre class="process-pre">${escapeHtml(prettyEventText(event.input))}</pre>
      </div>`
    : "";
  const output = event.output.trim()
    ? `<div class="process-section">
        <span class="process-label">结果</span>
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
  panel.innerHTML = `<p class="muted process-loading">正在读取过程…</p>`;
  try {
    const data = await api<{ turn: number; events: SessionEvent[] }>(
      `/api/session/${encodeURIComponent(state.sessionId)}/events?turn=${turn}`,
    );
    panel.innerHTML = data.events.length
      ? data.events.map((event) => processEventBlock(event, turn)).join("")
      : `<p class="muted">没有记录到过程。</p>`;
  } catch (error) {
    panel.dataset.loaded = "0";
    const message = error instanceof Error ? error.message : String(error);
    panel.innerHTML = `<p class="muted">读取失败：${escapeHtml(message)}</p>`;
  }
}

function renderError(error: unknown): void {
  const content = byId<HTMLDivElement>("content");
  if (!content) return;
  const message = error instanceof Error ? error.message : String(error);
  content.innerHTML = `<div class="empty">
    <h2>读取失败</h2>
    <p>${escapeHtml(message)}</p>
    <button class="text-btn" id="retry">重试</button>
  </div>`;
  byId<HTMLButtonElement>("retry")?.addEventListener("click", () => {
    if (state.view === "session") void renderSession(state.sessionId);
    else if (state.view === "brief") void renderBrief(state.briefDate);
    else void runSearch();
  });
}

async function generateBriefFile(): Promise<void> {
  const status = byId<HTMLDivElement>("brief-status");
  const input = byId<HTMLInputElement>("brief-date");
  const date = input?.value || briefDate || localDateKey();
  briefDate = date;
  if (status) status.innerHTML = `<span class="foot-muted">正在生成…</span>`;
  try {
    const response = await fetch(
      `/api/brief?date=${encodeURIComponent(date)}`,
      { method: "POST" },
    );
    const body = (await response.json().catch(() => null)) as
      | {
          error?: string;
          path?: string;
          relativePath?: string;
          download?: string;
        }
      | null;
    if (!response.ok || !body?.download) {
      throw new Error(body?.error ?? `请求失败 (${response.status})`);
    }
    if (status) {
      status.innerHTML = `已生成 <a href="#/brief/${encodeURIComponent(date)}" title="${escapeAttr(body.path ?? "")}">在线查看</a> · <a href="${escapeAttr(body.download)}" download>下载 .md</a>`;
    }
  } catch (error) {
    if (status) {
      const message = error instanceof Error ? error.message : String(error);
      status.innerHTML = `<span class="foot-muted">生成失败：${escapeHtml(message)}</span>`;
    }
  }
}

async function refreshIndex(): Promise<void> {
  const foot = byId<HTMLElement>("rail-foot");
  if (foot) foot.innerHTML = `<span class="foot-muted">正在索引…</span>`;
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
      if (themeMode === "auto") applyTheme("auto", false);
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
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(".copy-command");
    if (button) void copyCommand(button);
    const handoff = target.closest<HTMLButtonElement>(".handoff-button");
    if (handoff) void copyHandoff(handoff);
    const forget = target.closest<HTMLButtonElement>(".forget-button");
    if (forget) void forgetSessionFromUi(forget);
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
