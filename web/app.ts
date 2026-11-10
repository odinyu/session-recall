import { renderMarkdown } from "./markdown.ts";

type AgentId = "omp" | "opencode" | "cursor";
type Role = "all" | "user" | "assistant";
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

interface ResultSession {
  id: string;
  agent: AgentId;
  title: string;
  projectPath: string;
  updatedAt: number;
  hits: Hit[];
  hitCount: number;
}

interface SearchResult {
  q: string;
  terms: string[];
  mode: "fts" | "like" | "recent";
  tookMs: number;
  totalTurns: number;
  totalSessions: number;
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

interface UiState {
  view: "search" | "session";
  sessionId: string;
  turnIdx: number | null;
  q: string;
  agents: AgentId[];
  project: string;
  role: Role;
  range: Range;
}

const AGENT_LABEL: Record<AgentId, string> = {
  omp: "omp",
  opencode: "OpenCode",
  cursor: "Cursor",
};

const AGENTS: AgentId[] = ["cursor", "opencode", "omp"];
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
const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];
const THEME_KEY = "session-recall-theme";

let state: UiState = defaultState();
let facetsData: Facets | null = null;
let currentResults: SearchResult | null = null;
let lastTerms: string[] = [];
let searchAbort: AbortController | null = null;
let searchTimer: number | undefined;
let pollTimer: number | undefined;
let lastSearchHash = "#/search";
let themeMode: ThemeMode = "auto";

function defaultState(): UiState {
  return {
    view: "search",
    sessionId: "",
    turnIdx: null,
    q: "",
    agents: [],
    project: "",
    role: "all",
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
  if (raw.startsWith("/session/")) {
    const [path, query] = raw.split("?");
    const id = decodeURIComponent(path.slice("/session/".length));
    const turn = Number(new URLSearchParams(query ?? "").get("turn"));
    return {
      ...defaultState(),
      view: "session",
      sessionId: id,
      turnIdx: Number.isFinite(turn) && turn >= 0 ? turn : null,
    };
  }
  const queryIndex = raw.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? raw.slice(queryIndex + 1) : "");
  const agents = (params.get("agents") ?? "")
    .split(",")
    .filter((agent): agent is AgentId => AGENTS.includes(agent as AgentId));
  const role = params.get("role");
  const range = params.get("range");
  return {
    view: "search",
    sessionId: "",
    q: params.get("q") ?? "",
    agents,
    project: params.get("project") ?? "",
    role: role === "user" || role === "assistant" || role === "all" ? role : "all",
    range: range === "7d" || range === "30d" || range === "90d" ? range : "all",
  };
}

function syncHash(): void {
  if (state.view === "session") {
    history.replaceState(null, "", `#/session/${encodeURIComponent(state.sessionId)}${state.turnIdx !== null ? `?turn=${state.turnIdx}` : ""}`);
    return;
  }
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.agents.length > 0) params.set("agents", state.agents.join(","));
  if (state.project) params.set("project", state.project);
  if (state.role !== "all") params.set("role", state.role);
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
  state.turnIdx = null;
  syncHash();
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

function savedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resumeCommand(session: SessionDetail["session"]): string {
  const externalId = session.id.slice(session.agent.length + 1);
  const cwd = session.projectPath
    ? `cd ${shellQuote(session.projectPath)} && `
    : "";
  if (session.agent === "omp") {
    const resumeId = externalId.slice(externalId.lastIndexOf("_") + 1);
    return `${cwd}omp --resume ${resumeId}`;
  }
  if (session.agent === "opencode") {
    return `${cwd}opencode --session ${externalId}`;
  }
  return "";
}

function resumeBlock(session: SessionDetail["session"]): string {
  const command = resumeCommand(session);
  if (!command) return "";
  return `<div class="resume">
    <span class="resume-label">继续会话</span>
    <code class="resume-code">${escapeHtml(command)}</code>
    <button class="copy-command" type="button" data-command="${escapeAttr(command)}">复制</button>
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

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
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
            <select id="project-select" class="project-select" aria-label="按项目筛选">
              <option value="">全部项目</option>
            </select>
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
              <div class="segmented" id="role-filters" role="group" aria-label="搜索范围"></div>
              <div class="status-line" id="search-status" aria-live="polite"></div>
            </div>
          </header>
          <div id="content" tabindex="-1"></div>
        </div>
      </main>
    </div>
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

  byId<HTMLSelectElement>("project-select")?.addEventListener("change", (event) => {
    ensureSearchView();
    state.project = (event.target as HTMLSelectElement).value;
    syncHash();
    renderControls();
    closeFilters();
    void runSearch();
  });

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
    const themeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-mode]");
    if (themeButton) {
      applyTheme(themeButton.dataset.themeMode as ThemeMode);
      renderFoot();
      return;
    }
    if ((event.target as HTMLElement).closest("[data-refresh]")) void refreshIndex();
  });

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

  window.addEventListener("hashchange", () => {
    const next = parseHash();
    if (
      next.view === "session" &&
      next.sessionId === state.sessionId &&
      next.turnIdx === state.turnIdx
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

function renderControls(): void {
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

  const projectSelect = byId<HTMLSelectElement>("project-select");
  if (projectSelect && facetsData) {
    const options = facetsData.projects
      .map((project) => {
        const label = projectLabel(project.path);
        return `<option value="${escapeAttr(project.path)}"${state.project === project.path ? " selected" : ""}>${escapeHtml(label)} · ${formatCount(project.sessions)}</option>`;
      })
      .join("");
    projectSelect.innerHTML = `<option value="">全部项目</option>${options}`;
    if (state.project) projectSelect.value = state.project;
  }

  const rangeFilters = byId<HTMLDivElement>("range-filters");
  if (rangeFilters) {
    rangeFilters.innerHTML = RANGES.map(
      (range) =>
        `<button class="seg${state.range === range.id ? " is-active" : ""}" data-range="${range.id}" aria-pressed="${state.range === range.id}">${range.label}</button>`,
    ).join("");
  }

  const roleFilters = byId<HTMLDivElement>("role-filters");
  if (roleFilters) {
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
  if (state.view === "session") {
    void renderSession(state.sessionId, state.turnIdx);
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
  params.set("limit", "40");
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
    const result = await api<SearchResult>(`/api/search?${paramsForSearch()}`, controller.signal);
    if (controller.signal.aborted) return;
    currentResults = result;
    lastTerms = result.terms;
    renderResults();
    if (status) {
      status.textContent = `${formatCount(result.totalSessions)} 个会话 · ${formatCount(result.totalTurns)} 条问答 · ${result.tookMs.toFixed(1)} ms`;
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
    ? "搜索结果"
    : state.role === "assistant"
      ? "最近回答"
      : "最近提问";
  const head = `<div class="result-head">
    <h1>${heading}</h1>
    <p>${state.q ? `包含 “${escapeHtml(state.q)}” 的提问与回答` : "按最近活动排序"}</p>
  </div>`;

  if (result.sessions.length === 0) {
    content.innerHTML = head + emptyState();
    return;
  }

  content.innerHTML =
    head +
    `<div class="results">${result.sessions.map((session) => sessionBlock(session, result.terms)).join("")}</div>` +
    (result.sessions.length < result.totalSessions
      ? `<p class="list-foot">显示前 ${formatCount(result.sessions.length)} 个会话，共 ${formatCount(result.totalSessions)} 个；缩小筛选范围可看到更多。</p>`
      : "");
}

function emptyState(): string {
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
  const more = session.hitCount > session.hits.length
    ? `<span class="hit-count">${formatCount(session.hitCount)} 处命中</span>`
    : "";
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
    <div class="hits">${(state.q ? session.hits : session.hits.slice(0, 2)).map((hit) => hitBlock(hit, session, terms)).join("")}</div>
  </article>`;
}

function hitBlock(hit: Hit, session: ResultSession, terms: string[]): string {
  const href = `#/session/${encodeURIComponent(session.id)}?turn=${hit.idx}`;
  const prompt = hit.matchField === "user" ? hit.snippet : hit.userText;
  const answer = hit.matchField === "user" ? hit.assistantSnippet : hit.snippet;
  const answerText = plainPreview(answer);
  return `<a class="hit" href="${href}">
    <span class="hit-label">提问</span>
    <p class="hit-primary">${highlight(prompt || "（无提问记录）", terms)}</p>
    ${answerText ? `<p class="hit-secondary"><span class="hit-answer-label">回答</span>${highlight(answerText, terms)}</p>` : ""}
  </a>`;
}

async function renderSession(id: string, turnIdx: number | null = null): Promise<void> {
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
        ${resumeBlock(session)}
      </header>
      <div class="turns">
        ${detail.turns.map((turn) => turnBlock(turn, session.agent, terms, turnIdx)).join("")}
      </div>
    `;
    window.scrollTo({ top: 0, behavior: "auto" });
    if (turnIdx !== null) {
      requestAnimationFrame(() => {
        document.getElementById(`turn-${turnIdx}`)?.scrollIntoView({ block: "start" });
      });
    }
  } catch (error) {
    renderError(error);
  }
}

function turnBlock(
  turn: SessionDetail["turns"][number],
  agent: AgentId,
  terms: string[],
  targetIdx: number | null,
): string {
  const number = String(turn.idx + 1).padStart(2, "0");
  const user = turn.userText.trim()
    ? `<section class="msg msg-user">
        <div class="msg-label">提问</div>
        <div class="msg-body">${highlight(turn.userText, terms)}</div>
      </section>`
    : "";
  const assistant = turn.assistantText.trim()
    ? `<section class="msg msg-assistant">
        <div class="msg-label">回答 <span class="msg-agent">${AGENT_LABEL[agent]}</span></div>
        <div class="markdown">${renderMarkdown(turn.assistantText)}</div>
        ${turn.truncated ? `<p class="truncated">内容较长，已截断索引。</p>` : ""}
      </section>`
    : `<section class="msg msg-assistant"><div class="msg-label">回答</div><p class="muted">（没有记录到回答）</p></section>`;
  return `<article class="turn${targetIdx === turn.idx ? " is-target" : ""}" id="turn-${turn.idx}">
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

function processEventBlock(event: SessionEvent): string {
  const truncated = event.truncated
    ? `<p class="truncated">内容较长，已截断。</p>`
    : "";
  if (event.kind === "reasoning") {
    return `<details class="process-event process-reasoning">
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
  return `<details class="process-event process-tool">
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
      ? data.events.map(processEventBlock).join("")
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
    else void runSearch();
  });
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
  themeMode = savedTheme();
  applyTheme(themeMode, false);
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
  });
  state = parseHash();
  renderControls();
  await loadFacets();
  route();
}

void boot();
