import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { APP_DIR, HOME } from "../config.ts";
import { capText } from "../db.ts";
import { walkFiles } from "../util/fs.ts";
import { cleanTitle, firstLine, objectValue, parseJson, readString } from "../util/values.ts";
import { AGENT_IDS } from "./types.ts";
import type { Adapter, ParsedSession, ParsedTurn, SessionRef } from "./types.ts";

/**
 * Agents described by a configuration file instead of by code.
 *
 * The built-in adapters exist because those agents are common enough to deserve
 * a hand-written parser. Everything else gets a declaration, and the declaration
 * is meant to be two lines:
 *
 *     { "id": "mytool", "root": "~/.mytool/sessions" }
 *
 * That is enough because every other field has an ordered fallback: the file
 * format comes from the extension, the role and text keys are tried against the
 * names agents actually use, and the message array defaults to "messages". The
 * explicit overrides exist for stores that do none of the above, and are
 * optional - the common case never has to name them.
 *
 * It is deliberately not a general plugin system. SQLite sources are not
 * expressible here; inventing a query language for them is where a declarative
 * format stops paying for itself and code is the honest answer.
 */

export const SOURCES_FILENAME = "sources.json";

/** Where the declarations live. The env override lets tests use a scratch file. */
export function sourcesPath(): string {
  return process.env.SESSION_RECALL_SOURCES ?? join(APP_DIR, SOURCES_FILENAME);
}

export interface CustomSource {
  /** Slug used in the UI, in --agent and in the index. */
  id: string;
  /** Shown in the UI; defaults to the id. */
  label?: string;
  /** Directory to scan; a leading ~/ is expanded. */
  root: string;
  /** Optional override; otherwise the file extension decides. */
  format?: "json" | "jsonl";
  /** json only: dot path to the message array (default "messages"). */
  messages?: string;
  /** Dot paths read from the first record that carries them. */
  title?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  /** Dot paths read from every record. */
  role?: string;
  text?: string;
  time?: string;
  /** Roles that open a turn, and roles that add to the current one. */
  userRoles?: string[];
  assistantRoles?: string[];
}

const USER_ROLES = ["user", "human", "prompt"];
const ASSISTANT_ROLES = ["assistant", "agent", "ai", "model", "bot"];

/**
 * Keys tried in order when the declaration does not name one. These are the
 * names the agent CLIs on this machine actually use; a store that matches none
 * of them names its own fields.
 */
const ROLE_KEYS = ["role", "sender", "who", "author", "type", "from"];
const TEXT_KEYS = ["content", "text", "message", "body", "parts", "payload"];
const TIME_KEYS = ["timestamp", "time", "created_at", "createdAt", "ts", "sentAt", "date"];
const TITLE_KEYS = ["title", "name", "summary"];
const CWD_KEYS = ["cwd", "working_dir", "workingDir", "project", "projectPath", "meta.cwd"];

function expandHome(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  return path;
}

function at(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    const holder = objectValue(current);
    if (!holder) return undefined;
    current = holder[part];
  }
  return current;
}

/** The first candidate path that yields a value, so defaults need no config. */
function pick(record: Record<string, unknown>, explicit: string | undefined, candidates: string[]): unknown {
  if (explicit) return at(record, explicit);
  for (const path of candidates) {
    const value = at(record, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Message text in the shapes agents actually write. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") { parts.push(item); continue; }
    const block = objectValue(item);
    if (!block) continue;
    const text = readString(block, "text");
    if (text) { parts.push(text); continue; }
    const content = readString(block, "content");
    if (content) parts.push(content);
  }
  return parts.join("\n");
}

/** Epoch seconds, epoch milliseconds or an ISO string, all to milliseconds. */
function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return toMillis(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export class InvalidSourcesError extends Error {}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Read and validate the declarations. Throws InvalidSourcesError with a reason. */
export function loadCustomSources(path: string = sourcesPath()): CustomSource[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InvalidSourcesError(
      path + " is not valid JSON: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  const doc = objectValue(parsed);
  const list = doc?.sources;
  if (!doc || !Array.isArray(list)) {
    throw new InvalidSourcesError(path + ' needs a "sources" array');
  }
  const seen = new Set<string>();
  const out: CustomSource[] = [];
  list.forEach((raw, index) => {
    const entry = objectValue(raw);
    const where = path + " sources[" + index + "]";
    if (!entry) throw new InvalidSourcesError(where + ": not an object");
    const id = readString(entry, "id");
    if (!id) throw new InvalidSourcesError(where + ': missing "id"');
    if (!SOURCE_ID.test(id)) {
      throw new InvalidSourcesError(where + ': id "' + id + '" must be lowercase letters, digits and dashes');
    }
    if ((AGENT_IDS as readonly string[]).includes(id)) {
      throw new InvalidSourcesError(where + ': id "' + id + '" is already a built-in agent; pick another');
    }
    if (seen.has(id)) throw new InvalidSourcesError(where + ': duplicate id "' + id + '"');
    seen.add(id);
    const format = readString(entry, "format");
    if (format && format !== "json" && format !== "jsonl") {
      throw new InvalidSourcesError(where + ': format must be "json" or "jsonl"');
    }
    const root = readString(entry, "root");
    if (!root) throw new InvalidSourcesError(where + ': missing "root"');
    out.push({
      id,
      label: readString(entry, "label") || id,
      root: expandHome(root),
      format: (format as "json" | "jsonl" | undefined) || undefined,
      messages: readString(entry, "messages") || undefined,
      title: readString(entry, "title") || undefined,
      cwd: readString(entry, "cwd") || undefined,
      startedAt: readString(entry, "startedAt") || undefined,
      updatedAt: readString(entry, "updatedAt") || undefined,
      role: readString(entry, "role") || undefined,
      text: readString(entry, "text") || undefined,
      time: readString(entry, "time") || undefined,
      userRoles: stringArray(entry, "userRoles") ?? USER_ROLES,
      assistantRoles: stringArray(entry, "assistantRoles") ?? ASSISTANT_ROLES,
    });
  });
  return out;
}

function stringArray(record: Record<string, unknown>, key: string): string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) return null;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : null;
}

export function customAdapter(spec: CustomSource): Adapter {
  /** Both message-file shapes are collected; the extension decides how to read. */
  const matches = (name: string): boolean => name.endsWith(".jsonl") || name.endsWith(".json");

  async function list(): Promise<SessionRef[]> {
    return walkFiles(spec.root, matches).map((file) => {
      const name = basename(file.path);
      const dot = name.lastIndexOf(".");
      const externalId = dot > 0 ? name.slice(0, dot) : name;
      let stamp = 0;
      try {
        stamp = statSync(file.path).mtimeMs;
      } catch {
        // A file that vanished mid-walk still gets a ref; load will skip it.
      }
      return { agent: spec.id, externalId, fingerprint: String(stamp), sourcePath: file.path };
    });
  }

  async function load(ref: SessionRef): Promise<ParsedSession | null> {
    if (!existsSync(ref.sourcePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(ref.sourcePath, "utf8");
    } catch {
      return null;
    }

    const format = spec.format ?? (ref.sourcePath.endsWith(".jsonl") ? "jsonl" : "json");
    let records: unknown[];
    if (format === "jsonl") {
      records = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const parsed = parseJson(line);
        if (parsed !== undefined && parsed !== null) records.push(parsed);
      }
    } else {
      const doc = objectValue(parseJson(raw));
      if (!doc) return null;
      const value = at(doc, spec.messages ?? "messages");
      records = Array.isArray(value) ? value : [];
    }
    if (records.length === 0) return null;

    const userRoles = new Set(spec.userRoles ?? USER_ROLES);
    const assistantRoles = new Set(spec.assistantRoles ?? ASSISTANT_ROLES);
    const turns: ParsedTurn[] = [];
    let current: ParsedTurn | null = null;
    let projectPath = "";
    let title = "";
    let startedAt = 0;
    let updatedAt = 0;

    for (const rawRecord of records) {
      const record = objectValue(rawRecord);
      if (!record) continue;

      if (!projectPath) {
        const value = pick(record, spec.cwd, CWD_KEYS);
        if (typeof value === "string") projectPath = value;
      }
      if (!title) {
        const value = pick(record, spec.title, TITLE_KEYS);
        if (typeof value === "string") title = value;
      }
      if (!startedAt && spec.startedAt) startedAt = toMillis(at(record, spec.startedAt));
      if (spec.updatedAt) {
        const stamp = toMillis(at(record, spec.updatedAt));
        if (stamp > updatedAt) updatedAt = stamp;
      }

      const roleValue = pick(record, spec.role, ROLE_KEYS);
      const role = (typeof roleValue === "string" ? roleValue : "").toLowerCase();
      const body = textOf(pick(record, spec.text, TEXT_KEYS)).trim();
      if (!body) continue;
      const ts = toMillis(pick(record, spec.time, TIME_KEYS));

      if (userRoles.has(role)) {
        const capped = capText(body);
        current = {
          idx: turns.length,
          ts,
          userText: capped.text,
          assistantText: "",
          truncated: capped.truncated || undefined,
        };
        turns.push(current);
        if (!startedAt && ts) startedAt = ts;
        continue;
      }
      if (assistantRoles.has(role) && current) {
        const capped = capText(body);
        current.assistantText = current.assistantText
          ? current.assistantText + "\n\n" + capped.text
          : capped.text;
        if (capped.truncated) current.truncated = true;
        if (ts > updatedAt) updatedAt = ts;
      }
    }

    if (turns.length === 0) return null;

    let stamp = 0;
    try {
      stamp = statSync(ref.sourcePath).mtimeMs;
    } catch {
      stamp = 0;
    }
    const first = turns[0];
    const last = turns[turns.length - 1];
    const began = startedAt || first.ts || stamp;
    const ended = updatedAt || last.ts || stamp || began;

    return {
      agent: spec.id,
      externalId: ref.externalId,
      projectPath,
      title: cleanTitle(title, firstLine(first.userText)),
      startedAt: began,
      updatedAt: ended,
      sourceKind: "jsonl",
      sourcePath: ref.sourcePath,
      fingerprint: ref.fingerprint,
      turns,
    };
  }

  return { id: spec.id, label: spec.label || spec.id, version: 2, list, load };
}

/** Ids declared in sources.json, or [] when there is no readable config. */
export function customAgentIds(path: string = sourcesPath()): string[] {
  try {
    return loadCustomSources(path).map((spec) => spec.id);
  } catch {
    return [];
  }
}

/**
 * Adapters for the configured sources. A broken config yields one adapter whose
 * list() rejects, so the failure shows up in scan output and in doctor instead
 * of silently indexing nothing.
 */
export function customAdapters(path: string = sourcesPath()): Adapter[] {
  let sources: CustomSource[];
  try {
    sources = loadCustomSources(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [{
      id: "custom-config",
      label: "sources.json",
      list(): Promise<SessionRef[]> {
        return Promise.reject(new Error(reason));
      },
      load(): Promise<ParsedSession | null> {
        return Promise.resolve(null);
      },
    }];
  }
  return sources.map((spec) => customAdapter(spec));
}
