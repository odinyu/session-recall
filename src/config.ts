import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

export const APP_DIR =
  process.env.SESSION_RECALL_HOME ??
  join(HOME, "Library", "Application Support", "session-recall");

export const DB_PATH = process.env.SESSION_RECALL_DB ?? join(APP_DIR, "index.db");

export const PORT = Number(process.env.SESSION_RECALL_PORT ?? 4319);

export const WEB_DIST = join(import.meta.dir, "..", "web", "dist");
