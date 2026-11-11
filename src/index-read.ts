import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "./db.ts";

/**
 * Opens the index without write access. Readers (MCP, and anything else that
 * must not mutate the index) use this instead of `openDb`, which migrates the
 * schema and would fight the app for the write lock.
 *
 * A schema newer than this build fails loudly rather than running queries
 * against columns it does not understand. An older one is rejected too: the
 * read-only connection cannot migrate it, and running `scan` with this build
 * upgrades it in place.
 */
export function openIndexReadOnly(path: string): Database {
  if (!existsSync(path)) {
    throw new Error(`index not found: ${path}; run \`bun run scan\` first`);
  }
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
    const version = typeof row?.user_version === "number" ? row.user_version : 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `index schema ${version} is newer than this build (${SCHEMA_VERSION}); update session-recall`,
      );
    }
    if (version < SCHEMA_VERSION) {
      throw new Error(
        `index schema ${version} is older than this build (${SCHEMA_VERSION}); run \`bun run scan\` to upgrade it`,
      );
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
