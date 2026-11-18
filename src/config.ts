import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

export const APP_DIR =
  process.env.SESSION_RECALL_HOME ??
  join(HOME, "Library", "Application Support", "session-recall");

export const DB_PATH = process.env.SESSION_RECALL_DB ?? join(APP_DIR, "index.db");

/** Alma's live chat store; the running app holds it open in WAL mode. */
export const ALMA_DB =
  process.env.SESSION_RECALL_ALMA_DB ??
  join(HOME, "Library", "Application Support", "alma", "chat_threads.db");

/**
 * Cindy (the desktop host) stores every session in one SQLite file under its
 * global profile directory. The filename carries a per-install id, so resolve
 * the newest `cindy-*.db` rather than hard-coding it; the live app holds the
 * file open in WAL mode, hence the read-only contract in the adapter.
 */
export const CINDY_DIR =
  process.env.SESSION_RECALL_CINDY_DIR ??
  join(HOME, "Library", "Application Support", "CindyGlobal");

/**
 * Cindy leaves stubs and partial migration artefacts next to the live store, so
 * newest-by-mtime alone can pick a 4 KB file that opens but fails on the first
 * statement ("unable to open database file"). Prefer files that actually start
 * with the SQLite header; fall back to mtime order when none do, which keeps the
 * old behaviour for a profile we cannot read.
 */
function looksLikeSqlite(path: string): boolean {
  try {
    if (statSync(path).size < 512) return false;
    const fd = openSync(path, "r");
    try {
      const header = Buffer.alloc(16);
      const read = readSync(fd, header, 0, 16, 0);
      return read === 16 && header.toString("utf8", 0, 15) === "SQLite format 3";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function cindyDbPath(dir: string = CINDY_DIR): string {
  const explicit = process.env.SESSION_RECALL_CINDY_DB;
  if (explicit) return explicit;
  try {
    const files = readdirSync(dir)
      .filter((name) => /^cindy-.+\.db$/.test(name))
      .map((name) => join(dir, name));
    const valid = files.filter(looksLikeSqlite);
    const pool = valid.length > 0 ? valid : files;
    pool.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (pool.length > 0) return pool[0];
  } catch {
    // Missing or unreadable profile: the adapter reports no sessions.
  }
  return join(dir, "cindy.db");
}

/** Claude Code: one JSONL per session under `projects/<slug>/`. */
export const CLAUDE_DIR =
  process.env.SESSION_RECALL_CLAUDE_DIR ?? join(HOME, ".claude");

/** Codex CLI: rollout JSONL files under `sessions/YYYY/MM/DD/`. */
export const CODEX_DIR =
  process.env.SESSION_RECALL_CODEX_DIR ?? join(HOME, ".codex");

export const PORT = Number(process.env.SESSION_RECALL_PORT ?? 4319);

export const PROJECT_ROOT = join(import.meta.dir, "..");

export const BRIEF_DIR =
  process.env.SESSION_RECALL_BRIEF_DIR ?? join(APP_DIR, "brief");

export const WEB_DIST =
  process.env.SESSION_RECALL_WEB_DIST ?? join(PROJECT_ROOT, "web", "dist");
