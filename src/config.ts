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

export const PORT = Number(process.env.SESSION_RECALL_PORT ?? 4319);

export const PROJECT_ROOT = join(import.meta.dir, "..");

export const BRIEF_DIR =
  process.env.SESSION_RECALL_BRIEF_DIR ?? join(APP_DIR, "brief");

export const WEB_DIST =
  process.env.SESSION_RECALL_WEB_DIST ?? join(PROJECT_ROOT, "web", "dist");
