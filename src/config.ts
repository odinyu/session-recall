import { readdirSync, statSync } from "node:fs";
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

export function cindyDbPath(): string {
  const explicit = process.env.SESSION_RECALL_CINDY_DB;
  if (explicit) return explicit;
  try {
    const candidates = readdirSync(CINDY_DIR)
      .filter((name) => /^cindy-.+\.db$/.test(name))
      .map((name) => join(CINDY_DIR, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length > 0) return candidates[0];
  } catch {
    // Missing or unreadable profile: the adapter reports no sessions.
  }
  return join(CINDY_DIR, "cindy.db");
}

export const PORT = Number(process.env.SESSION_RECALL_PORT ?? 4319);

export const PROJECT_ROOT = join(import.meta.dir, "..");

export const BRIEF_DIR =
  process.env.SESSION_RECALL_BRIEF_DIR ?? join(APP_DIR, "brief");

export const WEB_DIST =
  process.env.SESSION_RECALL_WEB_DIST ?? join(PROJECT_ROOT, "web", "dist");
