import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { APP_DIR, DB_PATH } from "./config.ts";
import { getMeta, indexStats, SCHEMA_VERSION } from "./db.ts";
import { openIndexReadOnly } from "./index-read.ts";
import { scanLockPath } from "./scan-lock.ts";
import {
  CLIENTS, loadConfig, readEntry, resolveMcpCommand,
} from "./setup.ts";
import type { McpCommand } from "./setup.ts";

/**
 * Self-check the whole install and print a fix for anything that is off.
 *
 * The point of this command is to answer the question users actually have
 * after installing - is it working, and if not, which piece is wrong - without
 * making them read the source. Every non-ok line carries a command they can
 * paste. The MCP check does a real initialize + tools/list handshake rather
 * than inspecting files, because a config that merely looks right is the
 * failure mode worth catching.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

const APP_BUNDLE = "/Applications/Session Recall.app";
const STALE_LOCK_MS = 10 * 60 * 1000;

function shortSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (bytes >= 1024 * 1024) return Math.round(bytes / 1024 / 1024) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " h ago";
  return Math.floor(hours / 24) + " d ago";
}

function plistValue(plistPath: string, key: string): string | null {
  const result = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", "Print :" + key, plistPath]);
  if (result.exitCode !== 0) return null;
  const text = new TextDecoder().decode(result.stdout).trim();
  return text === "" ? null : text;
}

function checkIndex(): Check[] {
  const checks: Check[] = [];
  if (!existsSync(DB_PATH)) {
    checks.push({ id: "index", label: "index", status: "fail",
      detail: "no index at " + DB_PATH, fix: "session-recall scan" });
    return checks;
  }

  let db: Database;
  try {
    db = openIndexReadOnly(DB_PATH);
  } catch (error) {
    checks.push({ id: "index", label: "index", status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "session-recall scan" });
    return checks;
  }

  try {
    const stats = indexStats(db as never);
    const lastScan = Number(getMeta(db as never, "last_scan_ms") ?? 0);
    const age = lastScan > 0 ? Date.now() - lastScan : Number.POSITIVE_INFINITY;
    const bytes = statSync(DB_PATH).size;
    checks.push({
      id: "index", label: "index",
      status: stats.sessions > 0 ? "ok" : "warn",
      detail: stats.sessions + " sessions, " + stats.turns + " turns, " + shortSize(bytes)
        + ", scanned " + humanAge(age),
      fix: stats.sessions > 0 ? undefined : "session-recall scan",
    });

    const version = (db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0;
    checks.push({
      id: "schema", label: "schema",
      status: version === SCHEMA_VERSION ? "ok" : "fail",
      detail: "v" + version + (version === SCHEMA_VERSION ? "" : " (expected v" + SCHEMA_VERSION + ")"),
      fix: version === SCHEMA_VERSION ? undefined : "session-recall scan",
    });

    let integrity = "ok";
    try {
      const rows = db.query("PRAGMA integrity_check").all() as { integrity_check?: string }[];
      const first = rows[0]?.integrity_check ?? "ok";
      if (first !== "ok") integrity = first;
    } catch (error) {
      integrity = error instanceof Error ? error.message : String(error);
    }
    checks.push({
      id: "integrity", label: "integrity",
      status: integrity === "ok" ? "ok" : "fail",
      detail: integrity === "ok" ? "ok" : integrity,
      fix: integrity === "ok" ? undefined : "rm " + DB_PATH + " && session-recall scan",
    });

    const perAgent = db.query(
      "SELECT agent AS id, count(*) AS sessions FROM session GROUP BY agent ORDER BY sessions DESC",
    ).all() as { id: string; sessions: number }[];
    const errors = db.query("SELECT source, message FROM scan_error").all() as {
      source: string; message: string;
    }[];
    const errorBySource = new Map(errors.map((row) => [row.source, row.message]));
    const total = perAgent.reduce((sum, row) => sum + row.sessions, 0);
    checks.push({
      id: "adapters", label: "adapters",
      status: errors.length > 0 ? "warn" : "ok",
      detail: perAgent.length + " agents indexed (" + total + " sessions); "
        + perAgent.map((row) => row.id + " " + row.sessions).join(", "),
      fix: errors.length > 0 ? "session-recall scan  # see the failing sources below" : undefined,
    });
    for (const row of errors) {
      checks.push({
        id: "adapter:" + row.source, label: "  " + row.source, status: "warn",
        detail: row.message,
        fix: undefined,
      });
    }
    void errorBySource;
  } finally {
    db.close();
  }
  return checks;
}

function checkPrefs(): Check {
  const path = join(APP_DIR, "prefs.json");
  if (!existsSync(path)) {
    return { id: "prefs", label: "prefs", status: "ok", detail: "absent (defaults in use)" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return { id: "prefs", label: "prefs", status: "ok", detail: path };
  } catch (error) {
    return {
      id: "prefs", label: "prefs", status: "warn",
      detail: (error instanceof Error ? error.message : String(error)) + " (" + path + ")",
      fix: "rm " + path + "  # falls back to defaults",
    };
  }
}

function checkLock(): Check {
  const path = scanLockPath(DB_PATH);
  if (!existsSync(path)) {
    return { id: "lock", label: "scan lock", status: "ok", detail: "no lock held" };
  }
  let age = 0;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return { id: "lock", label: "scan lock", status: "ok", detail: "no lock held" };
  }
  if (age > STALE_LOCK_MS) {
    return {
      id: "lock", label: "scan lock", status: "warn",
      detail: "left behind " + humanAge(age) + " (a scan probably crashed)",
      fix: "rm " + path,
    };
  }
  return { id: "lock", label: "scan lock", status: "ok", detail: "held by a running scan" };
}

function checkApp(): Check[] {
  if (!existsSync(APP_BUNDLE)) {
    return [{
      id: "app", label: "app", status: "warn",
      detail: "not installed at " + APP_BUNDLE,
      fix: "bash scripts/make-app.sh  # or download the release",
    }];
  }
  const plist = join(APP_BUNDLE, "Contents", "Info.plist");
  const version = plistValue(plist, "CFBundleShortVersionString") ?? "unknown";
  const arch = (() => {
    const result = Bun.spawnSync(["/usr/bin/lipo", "-archs", join(APP_BUNDLE, "Contents", "MacOS", "session-recall-app")]);
    if (result.exitCode !== 0) return "unknown";
    return new TextDecoder().decode(result.stdout).trim();
  })();
  return [{ id: "app", label: "app", status: "ok", detail: "v" + version + " (" + arch + ")" }];
}

function checkDeepLink(): Check {
  const plist = join(APP_BUNDLE, "Contents", "Info.plist");
  if (!existsSync(plist)) {
    return { id: "deep-link", label: "deep link", status: "skip", detail: "app not installed" };
  }
  const types = plistValue(plist, "CFBundleURLTypes") ?? "";
  const registered = types.indexOf("sessionrecall") >= 0;
  return {
    id: "deep-link", label: "deep link", status: registered ? "ok" : "warn",
    detail: registered ? "sessionrecall:// registered" : "sessionrecall:// not registered",
    fix: registered ? undefined : "reinstall the app bundle",
  };
}

function checkMcpWiring(home: string): Check[] {
  const checks: Check[] = [];
  for (const spec of CLIENTS) {
    const path = spec.configPath(home);
    if (!spec.installed(home) && !existsSync(path)) {
      checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "skip", detail: "not installed" });
      continue;
    }
    let doc: Record<string, unknown>;
    try {
      doc = loadConfig(path).doc;
    } catch (error) {
      checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "fix the JSON in " + path + " then: session-recall setup --agent " + spec.id });
      continue;
    }
    const entry = readEntry(doc, spec) as { command?: string } | undefined;
    if (!entry && !spec.autoWrite) {
      checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "warn",
        detail: "not auto-configured (" + spec.source + ")",
        fix: "paste the snippet from doc/MCP.md" });
      continue;
    }
    if (!entry) {
      checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "warn",
        detail: "no session-recall entry in " + path,
        fix: "session-recall setup --agent " + spec.id });
      continue;
    }
    const command = typeof entry.command === "string" ? entry.command : null;
    if (!command) {
      checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "fail",
        detail: "entry has no command: " + path,
        fix: "session-recall setup --agent " + spec.id });
      continue;
    }
    if (!existsSync(command)) {
      checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "fail",
        detail: "points at a missing file: " + command,
        fix: "session-recall setup --agent " + spec.id });
      continue;
    }
    checks.push({ id: "mcp:" + spec.id, label: "mcp " + spec.id, status: "ok", detail: command });
  }
  return checks;
}

async function handshake(command: McpCommand, timeoutMs = 10000): Promise<Check> {
  if (!existsSync(command.command)) {
    return { id: "handshake", label: "handshake", status: "fail",
      detail: "command not found: " + command.command, fix: "session-recall setup" };
  }
  const started = Date.now();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const timer = setTimeout(() => { try { proc?.kill(); } catch { /* already gone */ } }, timeoutMs);
  try {
    proc = Bun.spawn([command.command].concat(command.args), {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const encoder = new TextEncoder();
    const send = (payload: unknown) => {
      proc!.stdin.write(encoder.encode(JSON.stringify(payload) + "\n"));
      proc!.stdin.flush();
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "session-recall-doctor", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tools: { name?: string }[] | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: { tools?: { name?: string }[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && message.result && Array.isArray(message.result.tools)) {
          tools = message.result.tools;
        }
      }
      if (tools) break;
    }
    const elapsed = Date.now() - started;
    if (!tools) {
      return { id: "handshake", label: "handshake", status: "fail",
        detail: "no tools/list reply within " + Math.round(elapsed) + " ms",
        fix: "run it by hand: " + [command.command].concat(command.args).join(" ") };
    }
    const names = tools.map((tool) => tool.name ?? "");
    const hasCore = names.indexOf("recall_search") >= 0;
    return {
      id: "handshake", label: "handshake",
      status: hasCore && names.length > 0 ? "ok" : "fail",
      detail: names.length + " tools in " + elapsed + " ms"
        + (hasCore ? "" : " (recall_search missing)"),
      fix: hasCore ? undefined : "the MCP server started but exposes no recall_search tool",
    };
  } catch (error) {
    return { id: "handshake", label: "handshake", status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "session-recall mcp  # run it by hand to see the error" };
  } finally {
    clearTimeout(timer);
    try { proc?.kill(); } catch { /* already exited */ }
  }
}

const LABEL_WIDTH = 16;

function print(checks: Check[]): void {
  console.log("session-recall doctor");
  console.log("");
  for (const check of checks) {
    const status = check.status === "skip" ? "-   " : check.status;
    console.log("  " + status.padEnd(6) + check.label.padEnd(LABEL_WIDTH) + " " + check.detail);
    if (check.fix) console.log("        " + " ".repeat(LABEL_WIDTH + 1) + "fix: " + check.fix);
  }
  const ok = checks.filter((check) => check.status === "ok").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  console.log("");
  console.log("  " + ok + " ok, " + warn + " warn, " + fail + " fail");
}

export interface DoctorOptions {
  home: string;
  json: boolean;
  handshake: boolean;
}

function parseArgs(argv: string[]): DoctorOptions | { error: string } {
  const options: DoctorOptions = {
    home: process.env.SESSION_RECALL_SETUP_HOME ?? homedir(),
    json: false, handshake: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--no-handshake") { options.handshake = false; continue; }
    if (arg === "-h" || arg === "--help") return { error: "__help__" };
    if (arg === "--home") {
      const value = argv[++i];
      if (!value) return { error: "--home needs a directory" };
      options.home = value;
      continue;
    }
    if (arg.startsWith("--home=")) { options.home = arg.slice(7); continue; }
    return { error: "unknown option \"" + arg + "\"" };
  }
  return options;
}

const USAGE = [
  "usage: session-recall doctor [--json] [--no-handshake] [--home <dir>]",
  "",
  "  Check the install and print a fix for anything that is off.",
  "  Exit code is 0 unless something actually failed.",
  "  --no-handshake  skip spawning the MCP server to verify it answers",
].join("\n");

export async function runDoctorCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "__help__") { console.log(USAGE); return 0; }
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  const options = parsed;

  const checks: Check[] = [];
  // Tracing exists because a check that hangs produces no output until the end,
  // which makes a stuck run indistinguishable from a slow one.
  const trace = process.env.SESSION_RECALL_DOCTOR_TRACE === "1";
  const step = (label: string): void => {
    if (trace) console.error("[doctor] " + label);
  };

  step("index");
  checks.push(...checkIndex());
  step("prefs");
  checks.push(checkPrefs());
  step("lock");
  checks.push(checkLock());
  step("app");
  checks.push(...checkApp());
  step("deep-link");
  checks.push(checkDeepLink());
  step("mcp wiring");
  checks.push(...checkMcpWiring(options.home));

  if (options.handshake) {
    step("handshake");
    const command = resolveMcpCommand();
    if (command) checks.push(await handshake(command));
    else checks.push({ id: "handshake", label: "handshake", status: "skip",
      detail: "no runnable session-recall binary found" });
  }

  if (options.json) {
    console.log(JSON.stringify({ home: options.home, checks }, null, 2));
  } else {
    print(checks);
  }
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}
