import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Wire the MCP server into the MCP config of the agents installed here.
 *
 * Every agent keeps its MCP server list in its own file, in its own shape, and
 * hand-writing those is the single biggest reason people never get as far as
 * using this project MCP server. This module owns that wiring, under three
 * rules that matter more than the convenience:
 *
 *   1. Config files only. Agent transcripts are never touched - that is the
 *      core promise and it does not bend for setup.
 *   2. Only write a client whose config path AND entry shape were verified.
 *      Anything else is reported as "manual" with a snippet to paste. A wrong
 *      guess here silently corrupts someone tooling.
 *   3. Every write is backed up, atomic and reversible (--remove), and a file
 *      we cannot parse is reported, never rewritten.
 */

/** The key we own inside every client server map. */
export const SERVER_KEY = "session-recall";

export type ClientFormat = "mcpServers" | "opencode";

export interface ClientSpec {
  id: string;
  label: string;
  format: ClientFormat;
  /** Config file, resolved against the home we were pointed at. */
  configPath: (home: string) => string;
  /**
   * Does this client actually exist here? A config file directly under the home
   * (Claude Code) cannot answer that by checking its parent directory - the home
   * always exists - so each client names its own probe path instead.
   */
  installed: (home: string) => boolean;
  /** Some clients want an explicit transport on each entry. */
  entryType?: string;
  /** false => print a snippet, never write the file. */
  autoWrite: boolean;
  /** Where the entry shape was confirmed. */
  source: string;
}

/**
 * Verified shapes, in the order the plan prints them.
 *
 * mcpServers: a top-level object whose values are { command, args }. Cursor
 * additionally stamps type: "stdio", Alma does not. Confirmed against live
 * config files on macOS.
 *
 * opencode: mcp.servers.<name> = { type: "local", command: [exe, ...args] },
 * confirmed against https://opencode.ai/config.json (Mcp.LocalConfigEncoded;
 * the older flat mcp.<name> form is marked deprecated in that schema).
 *
 * Codex is deliberately not written: its config is TOML and we have no live
 * file here to confirm the exact table against.
 */
export const CLIENTS: ClientSpec[] = [
  {
    id: "cursor", label: "Cursor", format: "mcpServers",
    configPath: (home) => join(home, ".cursor", "mcp.json"),
    installed: (home) => existsSync(join(home, ".cursor")),
    entryType: "stdio", autoWrite: true, source: "live ~/.cursor/mcp.json",
  },
  {
    id: "alma", label: "Alma", format: "mcpServers",
    configPath: (home) => join(home, ".config", "alma", "mcp.json"),
    installed: (home) => existsSync(join(home, ".config", "alma")),
    autoWrite: true, source: "live ~/.config/alma/mcp.json",
  },
  {
    id: "claude-code", label: "Claude Code", format: "mcpServers",
    configPath: (home) => join(home, ".claude.json"),
    installed: (home) => existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json")),
    autoWrite: true, source: "user-scope mcpServers block",
  },
  {
    id: "gemini-cli", label: "Gemini CLI", format: "mcpServers",
    configPath: (home) => join(home, ".gemini", "settings.json"),
    installed: (home) => existsSync(join(home, ".gemini")),
    autoWrite: true, source: "same mcpServers shape as Claude Code",
  },
  {
    id: "qwen-code", label: "Qwen Code", format: "mcpServers",
    configPath: (home) => join(home, ".qwen", "settings.json"),
    installed: (home) => existsSync(join(home, ".qwen")),
    autoWrite: true, source: "same mcpServers shape as Claude Code",
  },
  {
    id: "opencode", label: "OpenCode", format: "opencode",
    configPath: (home) => join(home, ".config", "opencode", "opencode.json"),
    installed: (home) => existsSync(join(home, ".config", "opencode")),
    autoWrite: true, source: "opencode.ai/config.json schema",
  },
  {
    id: "codex", label: "Codex CLI", format: "mcpServers",
    configPath: (home) => join(home, ".codex", "config.toml"),
    installed: (home) => existsSync(join(home, ".codex")),
    autoWrite: false, source: "TOML; no live file to confirm against",
  },
];

export interface McpCommand { command: string; args: string[] }

const APP_SIDECAR = "/Applications/Session Recall.app/Contents/MacOS/session-recall";

/**
 * Pick the binary a client should spawn. An override wins, then the installed
 * app, then the running compiled CLI, and only then give up - writing a path
 * that does not exist is worse than printing instructions.
 */
export function resolveMcpCommand(
  env: Record<string, string | undefined> = process.env,
): McpCommand | null {
  const explicit = env.SESSION_RECALL_SIDECAR;
  if (explicit && existsSync(explicit)) return { command: explicit, args: ["mcp"] };
  if (existsSync(APP_SIDECAR)) return { command: APP_SIDECAR, args: ["mcp"] };
  const execName = basename(process.execPath);
  if (execName === "session-recall" && existsSync(process.execPath)) {
    return { command: process.execPath, args: ["mcp"] };
  }
  const sibling = join(dirname(process.execPath), "session-recall");
  if (execName !== "bun" && existsSync(sibling)) return { command: sibling, args: ["mcp"] };
  return null;
}

export type PlanAction = "add" | "update" | "already" | "skip" | "manual";

export interface ClientPlan {
  id: string;
  label: string;
  action: PlanAction;
  configPath: string;
  detail: string;
  source: string;
  entry: unknown;
}

export interface SetupOptions {
  home: string;
  dryRun: boolean;
  yes: boolean;
  remove: boolean;
  only?: string;
  json: boolean;
  command: McpCommand | null;
}

function entryFor(spec: ClientSpec, command: McpCommand): unknown {
  if (spec.format === "opencode") {
    return { type: "local", command: [command.command].concat(command.args) };
  }
  const entry: Record<string, unknown> = { command: command.command, args: command.args.slice() };
  if (spec.entryType) entry.type = spec.entryType;
  return entry;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The container our key lives in, created on demand when writing. */
function containerFor(
  doc: Record<string, unknown>, spec: ClientSpec, create: boolean,
): Record<string, unknown> | null {
  if (spec.format === "opencode") {
    let mcp = asRecord(doc.mcp);
    if (!mcp) { if (!create) return null; mcp = {}; doc.mcp = mcp; }
    let servers = asRecord(mcp.servers);
    if (!servers) { if (!create) return null; servers = {}; mcp.servers = servers; }
    return servers;
  }
  let servers = asRecord(doc.mcpServers);
  if (!servers) { if (!create) return null; servers = {}; doc.mcpServers = servers; }
  return servers;
}

export function readEntry(doc: Record<string, unknown>, spec: ClientSpec): unknown {
  const servers = containerFor(doc, spec, false);
  return servers ? servers[SERVER_KEY] : undefined;
}

export function writeEntry(doc: Record<string, unknown>, spec: ClientSpec, entry: unknown): void {
  const servers = containerFor(doc, spec, true);
  if (servers) servers[SERVER_KEY] = entry;
}

/** Remove only our entry, and leave no empty scaffolding behind. */
export function deleteEntry(doc: Record<string, unknown>, spec: ClientSpec): boolean {
  const servers = containerFor(doc, spec, false);
  if (!servers || !(SERVER_KEY in servers)) return false;
  delete servers[SERVER_KEY];
  if (Object.keys(servers).length === 0) {
    if (spec.format === "opencode") {
      const mcp = asRecord(doc.mcp);
      if (mcp) {
        delete mcp.servers;
        if (Object.keys(mcp).length === 0) delete doc.mcp;
      }
    } else {
      delete doc.mcpServers;
    }
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const ra = asRecord(a);
  const rb = asRecord(b);
  if (ra && rb) {
    const ka = Object.keys(ra).sort();
    const kb = Object.keys(rb).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(ra[k], rb[k]));
  }
  return false;
}

interface LoadedConfig { exists: boolean; doc: Record<string, unknown> }

/** Parse a config file. Throws (with the path) rather than guessing. */
export function loadConfig(path: string): LoadedConfig {
  if (!existsSync(path)) return { exists: false, doc: {} };
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return { exists: true, doc: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(path + " is not valid JSON (" + reason + "); left untouched");
  }
  const doc = asRecord(parsed);
  if (!doc) throw new Error(path + " is not a JSON object; left untouched");
  return { exists: true, doc };
}

export function planClients(options: SetupOptions): ClientPlan[] {
  const plans: ClientPlan[] = [];
  for (const spec of CLIENTS) {
    if (options.only && spec.id !== options.only) continue;
    const configPath = spec.configPath(options.home);
    const installed = spec.installed(options.home) || existsSync(configPath);

    if (!installed) {
      plans.push({ id: spec.id, label: spec.label, action: "skip", configPath,
        detail: "not installed", source: spec.source, entry: null });
      continue;
    }

    if (!spec.autoWrite || !options.command) {
      plans.push({ id: spec.id, label: spec.label, action: "manual", configPath,
        detail: !spec.autoWrite
          ? "entry shape not verified; paste the snippet by hand"
          : "no runnable session-recall binary found; paste the snippet by hand",
        source: spec.source,
        entry: options.command ? entryFor(spec, options.command) : null });
      continue;
    }

    const entry = entryFor(spec, options.command);
    let loaded: LoadedConfig;
    try {
      loaded = loadConfig(configPath);
    } catch (error) {
      plans.push({ id: spec.id, label: spec.label, action: "manual", configPath,
        detail: error instanceof Error ? error.message : String(error),
        source: spec.source, entry });
      continue;
    }

    if (options.remove) {
      const present = readEntry(loaded.doc, spec) !== undefined;
      plans.push({ id: spec.id, label: spec.label, action: present ? "update" : "already",
        configPath, detail: present ? "remove our entry" : "no entry to remove",
        source: spec.source, entry: null });
      continue;
    }

    const current = readEntry(loaded.doc, spec);
    if (current === undefined) {
      plans.push({ id: spec.id, label: spec.label, action: "add", configPath,
        detail: loaded.exists ? "append our entry" : "create config",
        source: spec.source, entry });
    } else if (deepEqual(current, entry)) {
      plans.push({ id: spec.id, label: spec.label, action: "already", configPath,
        detail: "already configured", source: spec.source, entry });
    } else {
      plans.push({ id: spec.id, label: spec.label, action: "update", configPath,
        detail: "replace our entry (other entries untouched)",
        source: spec.source, entry });
    }
  }
  return plans;
}

export interface ApplyResult { id: string; ok: boolean; detail: string; backup?: string }

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

/** Copy the file aside before we touch it, so a bad write is always undoable. */
function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const target = path + ".session-recall.bak-" + timestamp();
  copyFileSync(path, target);
  return target;
}

export function applyPlan(plans: ClientPlan[], options: SetupOptions): ApplyResult[] {
  const results: ApplyResult[] = [];
  for (const plan of plans) {
    if (plan.action !== "add" && plan.action !== "update") continue;
    const spec = CLIENTS.find((client) => client.id === plan.id);
    if (!spec) continue;

    let loaded: LoadedConfig;
    try {
      loaded = loadConfig(plan.configPath);
    } catch (error) {
      results.push({ id: plan.id, ok: false,
        detail: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const doc = loaded.doc;
    if (options.remove) deleteEntry(doc, spec);
    else if (options.command) writeEntry(doc, spec, entryFor(spec, options.command));

    const saved = backup(plan.configPath);
    const temp = plan.configPath + ".tmp-" + process.pid;
    try {
      if (Object.keys(doc).length === 0) {
        // Nothing left to say: drop the file instead of leaving "{}" behind.
        if (existsSync(plan.configPath)) rmSync(plan.configPath);
      } else {
        mkdirSync(dirname(plan.configPath), { recursive: true });
        writeFileSync(temp, JSON.stringify(doc, null, 2) + "\n", "utf8");
        renameSync(temp, plan.configPath);
      }
      results.push({ id: plan.id, ok: true,
        detail: options.remove ? "entry removed" : "entry written",
        backup: saved ?? undefined });
    } catch (error) {
      if (existsSync(temp)) rmSync(temp);
      if (saved) { try { copyFileSync(saved, plan.configPath); } catch { /* best effort */ } }
      results.push({ id: plan.id, ok: false,
        detail: (error instanceof Error ? error.message : String(error)) + " (restored from backup)",
        backup: saved ?? undefined });
    }
  }
  return results;
}

function manualSnippet(spec: ClientSpec, command: McpCommand | null): string[] {
  const exe = command ? command.command : "/path/to/session-recall";
  if (spec.format === "opencode") {
    return [
      "{",
      "  \"mcp\": {",
      "    \"servers\": {",
      "      \"session-recall\": {",
      "        \"type\": \"local\",",
      "        \"command\": [\"" + exe + "\", \"mcp\"]",
      "      }",
      "    }",
      "  }",
      "}",
    ];
  }
  if (spec.id === "codex") {
    return [
      "[mcp_servers.session-recall]",
      "command = \"" + exe + "\"",
      "args = [\"mcp\"]",
    ];
  }
  return [
    "{",
    "  \"mcpServers\": {",
    "    \"session-recall\": {",
    "      \"command\": \"" + exe + "\",",
    "      \"args\": [\"mcp\"]",
    "    }",
    "  }",
    "}",
  ];
}

const ACTION_LABEL: Record<PlanAction, string> = {
  add: "add", update: "update", already: "already", skip: "skip", manual: "manual",
};

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * The agent skill: one Markdown file, written into every skill folder we find.
 *
 * This is the second integration channel, and the cheaper of the two. An MCP
 * entry has to be re-derived for every client format (JSON here, TOML there, a
 * nested key somewhere else) and its shape has to be verified client by client.
 * A skill does not: the same bytes land in N folders, and any agent with shell
 * access can follow it. It also reaches clients we cannot write an MCP entry for
 * at all.
 */
export interface SkillTarget {
  id: string;
  label: string;
  /** The skill folder itself, e.g. ~/.claude/skills/session-recall. */
  dir: (home: string) => string;
  /** Prove the client is installed before writing anything into it. */
  installed: (home: string) => boolean;
}

/** Marks a skill copy as ours, so a locally edited one is never clobbered. */
export const SKILL_MARKER = ".session-recall.json";

export const SKILL_TARGETS: SkillTarget[] = [
  {
    id: "agents", label: "universal (.agents)",
    dir: (home) => join(home, ".agents", "skills", "session-recall"),
    installed: (home) => existsSync(join(home, ".agents", "skills")),
  },
  {
    id: "alma", label: "Alma",
    dir: (home) => join(home, ".config", "alma", "skills", "session-recall"),
    installed: (home) => existsSync(join(home, ".config", "alma", "skills")),
  },
  {
    id: "claude-code", label: "Claude Code",
    dir: (home) => join(home, ".claude", "skills", "session-recall"),
    installed: (home) => existsSync(join(home, ".claude", "skills")),
  },
  {
    id: "codex", label: "Codex CLI",
    dir: (home) => join(home, ".codex", "skills", "session-recall"),
    installed: (home) => existsSync(join(home, ".codex", "skills")),
  },
  {
    id: "cursor", label: "Cursor",
    dir: (home) => join(home, ".cursor", "skills", "session-recall"),
    installed: (home) => existsSync(join(home, ".cursor", "skills")),
  },
  {
    id: "opencode", label: "OpenCode",
    dir: (home) => join(home, ".config", "opencode", "skills", "session-recall"),
    installed: (home) => existsSync(join(home, ".config", "opencode", "skills")),
  },
];

export function skillContent(command: McpCommand | null): string {
  const exe = command ? command.command : "session-recall";
  return [
    "---",
    "name: session-recall",
    "description: Search this machine's past coding-agent sessions (omp, OpenCode,",
    "  Cursor, Claude Code, Codex, Alma, Cindy, Pi, plus any source declared in",
    "  sources.json) when earlier decisions, failed attempts, commands or error",
    "  messages could matter. Use before re-solving a problem, when resuming",
    "  earlier work, when the user asks how something was fixed before, or when you",
    "  need a path, command or class name that was probably explored already.",
    "---",
    "",
    "# session-recall",
    "",
    "A local, read-only index of past agent sessions on this machine. The agent",
    "transcripts themselves are never modified: search reads an index that the",
    "desktop app keeps fresh.",
    "",
    "## When to use it",
    "",
    "- Before starting work in an unfamiliar area, or resuming something from days",
    "  ago: search for the decision, the constraint, or the failed attempt.",
    "- When the user says \"we did this before\" or asks why a choice was made.",
    "- When you are about to re-derive something expensive: a build command, a",
    "  flaky test, an API quirk, a file layout.",
    "- Do not use it as a general search engine, and do not paste whole sessions",
    "  into context - read the one turn you need.",
    "",
    "## Search",
    "",
    "    " + exe + " search \"<query>\" --limit 5",
    "    " + exe + " search \"<query>\" --agent omp,claude-code --json",
    "    " + exe + " search \"<query>\" --scope process",
    "",
    "--scope qa (default) searches prompts and answers. --scope process searches",
    "tool inputs, tool outputs and extracted error lines - use it when you are",
    "hunting a command or a stack trace rather than a conversation.",
    "",
    "## Read one session",
    "",
    "Each result carries a session id and a sessionrecall:// deep link. Opening the",
    "link jumps the desktop app to that turn. From an MCP client, use the tools",
    "below instead.",
    "",
    "## If MCP is wired up",
    "",
    "Tools: recall_search, recall_session, recall_facets, recall_handoff,",
    "recall_scan, recall_saved_searches, recall_brief. Prefer recall_search for",
    "compact results; recall_handoff builds a transfer card when work moves to",
    "another agent.",
    "",
    "## If the index is missing or stale",
    "",
    "    " + exe + " doctor",
    "    " + exe + " scan",
    "",
    "If the tool is unavailable, say so instead of inventing history.",
    "",
  ].join("\n");
}

export type SkillAction = "add" | "update" | "already" | "skip" | "manual";

export interface SkillPlan {
  id: string;
  label: string;
  action: SkillAction;
  skillDir: string;
  detail: string;
}

function readMarker(dir: string): Record<string, unknown> | null {
  const path = join(dir, SKILL_MARKER);
  if (!existsSync(path)) return null;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function planSkills(options: SetupOptions): SkillPlan[] {
  const plans: SkillPlan[] = [];
  const body = skillContent(options.command);
  for (const target of SKILL_TARGETS) {
    if (options.only && options.only !== target.id) continue;
    const dir = target.dir(options.home);
    const skillPath = join(dir, "SKILL.md");
    const id = "skill:" + target.id;
    const label = target.label + " skill";
    if (!target.installed(options.home) && !existsSync(skillPath)) {
      plans.push({ id, label, action: "skip", skillDir: dir, detail: "not installed" });
      continue;
    }
    const marker = readMarker(dir);
    const exists = existsSync(skillPath);
    if (options.remove) {
      plans.push({
        id, label, action: marker ? "update" : "already", skillDir: dir,
        detail: marker ? "remove the managed copy" : "no managed copy to remove",
      });
      continue;
    }
    if (exists && !marker) {
      plans.push({
        id, label, action: "manual", skillDir: dir,
        detail: "a SKILL.md without our marker is there; left alone",
      });
      continue;
    }
    if (!exists) {
      plans.push({ id, label, action: "add", skillDir: dir, detail: "install" });
      continue;
    }
    const current = readFileSync(skillPath, "utf8");
    plans.push({
      id, label, skillDir: dir,
      action: current === body ? "already" : "update",
      detail: current === body ? "already installed" : "update to this version",
    });
  }
  return plans;
}

export function applySkills(plans: SkillPlan[], options: SetupOptions): ApplyResult[] {
  const results: ApplyResult[] = [];
  const body = skillContent(options.command);
  for (const plan of plans) {
    if (plan.action !== "add" && plan.action !== "update") continue;
    const skillPath = join(plan.skillDir, "SKILL.md");
    const markerPath = join(plan.skillDir, SKILL_MARKER);
    try {
      if (options.remove) {
        if (existsSync(skillPath)) rmSync(skillPath);
        if (existsSync(markerPath)) rmSync(markerPath);
        // Only drop the folder if nothing else lives in it. rmdirSync is the
        // empty-only call, so a folder holding anything else survives untouched.
        try {
          rmdirSync(plan.skillDir);
        } catch {
          // Not empty: leave it.
        }
        results.push({ id: plan.id, ok: true, detail: "removed" });
        continue;
      }
      mkdirSync(plan.skillDir, { recursive: true });
      const temp = skillPath + ".tmp-" + process.pid;
      writeFileSync(temp, body, "utf8");
      renameSync(temp, skillPath);
      writeFileSync(markerPath, JSON.stringify({
        managed: true, version: 1, installedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      results.push({ id: plan.id, ok: true, detail: "installed" });
    } catch (error) {
      results.push({
        id: plan.id, ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function printSkills(plans: SkillPlan[]): void {
  if (plans.length === 0) return;
  console.log("");
  console.log("agent skill");
  for (const plan of plans) {
    console.log("  " + ACTION_LABEL[plan.action].padEnd(8) + plan.label.padEnd(26) + plan.detail);
    if (plan.action !== "skip") console.log("                        " + plan.skillDir);
  }
}

interface SetupRun extends SetupOptions {
  /** Install the agent skill as well as the MCP entry. */
  skill: boolean;
  /** Install MCP entries; --no-mcp turns this off. */
  mcp: boolean;
}

function parseArgs(argv: string[]): SetupRun | { error: string } {
  const options: SetupRun = {
    home: process.env.SESSION_RECALL_SETUP_HOME ?? homedir(),
    dryRun: false, yes: false, remove: false, json: false, command: null,
    skill: true, mcp: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--yes" || arg === "-y") { options.yes = true; continue; }
    if (arg === "--remove") { options.remove = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--no-skill") { options.skill = false; continue; }
    if (arg === "--no-mcp") { options.mcp = false; continue; }
    if (arg === "-h" || arg === "--help") return { error: "__help__" };
    if (arg === "--agent") {
      const value = argv[++i];
      if (!value) return { error: "--agent needs a client id" };
      options.only = value;
      continue;
    }
    if (arg.startsWith("--agent=")) { options.only = arg.slice(8); continue; }
    if (arg === "--home") {
      const value = argv[++i];
      if (!value) return { error: "--home needs a directory" };
      options.home = value;
      continue;
    }
    if (arg.startsWith("--home=")) { options.home = arg.slice(7); continue; }
    return { error: "unknown option \"" + arg + "\"" };
  }
  if (options.only) {
    const known = CLIENTS.some((client) => client.id === options.only)
      || SKILL_TARGETS.some((target) => target.id === options.only);
    if (!known) {
      const ids = CLIENTS.map((c) => c.id).concat(
        SKILL_TARGETS.map((t) => t.id).filter((id) => !CLIENTS.some((c) => c.id === id)),
      );
      return { error: "unknown client \"" + options.only + "\"; known: " + ids.join(", ") };
    }
  }
  return options;
}

const USAGE = [
  "usage: session-recall setup [--dry-run] [--yes] [--agent <id>] [--remove]",
  "                              [--no-skill] [--no-mcp] [--json] [--home <dir>]",
  "",
  "  Connect this machine's agents to session-recall, two ways:",
  "    mcp    write the session-recall entry into each client MCP config",
  "    skill  write one SKILL.md into each agent skill folder",
  "",
  "  Config files and skill folders only - agent transcripts are never touched.",
  "  --dry-run     print the plan, write nothing",
  "  --yes         skip the confirmation prompt",
  "  --agent <id>  only this client: " + CLIENTS.map((c) => c.id).join(", "),
  "  --remove      remove what we installed, leaving everything else intact",
  "  --no-skill    MCP entries only",
  "  --no-mcp      skill only",
  "  --json        machine-readable plan/result",
  "  --home <dir>  discover configs under this home instead of ~ (tests)",
].join("\n");

export async function runSetupCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "__help__") { console.log(USAGE); return 0; }
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  const options = parsed;
  options.command = resolveMcpCommand();

  let plans: ClientPlan[] = [];
  let skills: SkillPlan[] = [];
  try {
    if (options.mcp) plans = planClients(options);
    if (options.skill) skills = planSkills(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const actionable = plans.filter((plan) => plan.action === "add" || plan.action === "update");
  const skillActionable = skills.filter((plan) => plan.action === "add" || plan.action === "update");
  const total = actionable.length + skillActionable.length;

  if (options.json) {
    console.log(JSON.stringify({
      home: options.home, command: options.command, dryRun: options.dryRun,
      remove: options.remove, clients: plans, skills,
    }, null, 2));
    if (options.dryRun || total === 0) return 0;
  } else {
    const heading = options.remove ? "session-recall setup --remove" : "session-recall setup";
    console.log(heading + (options.dryRun ? "  (dry run - nothing written)" : ""));
    console.log("");
    for (const plan of plans) {
      console.log("  " + ACTION_LABEL[plan.action].padEnd(8) + plan.label.padEnd(16) + plan.configPath);
      if (plan.action !== "skip") console.log("                        " + plan.detail);
      if (plan.action === "manual") {
        const spec = CLIENTS.find((client) => client.id === plan.id);
        if (spec) {
          for (const line of manualSnippet(spec, options.command)) {
            console.log("                        " + line);
          }
        }
      }
    }
    printSkills(skills);
    if (options.command) {
      console.log("");
      console.log("command: " + [options.command.command].concat(options.command.args).join(" "));
    }
  }

  if (total === 0) {
    if (!options.json) console.log("\nnothing to do");
    return 0;
  }
  if (options.dryRun) {
    if (!options.json) console.log("\nrun again without --dry-run to apply");
    return 0;
  }

  if (!options.yes) {
    const proceed = await confirm("\n" + total
      + " item(s) will be written (config files are backed up first). Continue? [y/N] ");
    if (!proceed) {
      console.error("aborted; nothing written (pass --yes to skip this prompt)");
      return 1;
    }
  }

  const results = applyPlan(plans, options).concat(applySkills(skills, options));
  const failed = results.filter((result) => !result.ok);
  if (!options.json) {
    console.log("");
    for (const result of results) {
      const plan = plans.find((item) => item.id === result.id);
      const skill = skills.find((item) => item.id === result.id);
      const label = plan ? plan.label : skill ? skill.label + " skill" : result.id;
      console.log("  " + (result.ok ? "ok  " : "FAIL") + " " + label.padEnd(26) + result.detail);
      if (result.backup) console.log("                             backup: " + result.backup);
    }
    console.log("\n" + (results.length - failed.length) + " done, " + failed.length + " failed");
  }
  return failed.length === 0 ? 0 : 1;
}
