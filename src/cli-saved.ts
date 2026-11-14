import { localDateKey } from "./brief.ts";
import { DB_PATH } from "./config.ts";
import {
  createSavedSearch,
  deleteSavedSearch,
  InvalidSavedSearchError,
  listSavedSearches,
  openDb,
} from "./db.ts";
import type { IndexedDatabase } from "./db.ts";
import { clipText } from "./util/values.ts";

/**
 * Minimal `saved` subcommand: list, add, remove. The web UI is the primary
 * surface; this exists so scripts can bookmark a search without opening it.
 */

export const USAGE = `usage: bun run src/cli.ts saved <list|add|remove> [args]

Manage saved searches — named query + filter bookmarks the web UI expands.

commands:
  list
      print saved searches, newest first
  add <name> [query] [--filters '<json>']
      save a search and print its id; filters is a JSON object of the
      hash-router query params, booleans as "1"/"0", e.g.
      '{"agents":"omp","scope":"process","starred":"1"}'
  remove <id>
      delete one saved search

options:
  -h, --help       show this help

examples:
  bun run src/cli.ts saved list
  bun run src/cli.ts saved add "tvbox 调试" "tvbox" --filters '{"scope":"process"}'
  bun run src/cli.ts saved remove ss-1a2b3c4d`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): number {
  console.error(message);
  console.error("run with --help for usage.");
  return 2;
}

function printList(db: IndexedDatabase): number {
  const rows = listSavedSearches(db);
  if (rows.length === 0) {
    console.log("没有保存的搜索；用 `saved add` 添加。");
    return 0;
  }
  for (const search of rows) {
    console.log(
      `${search.id}  ${localDateKey(new Date(search.createdAt))}  ${clipText(search.name, 60)}`,
    );
    console.log(`    查询: ${search.query ? clipText(search.query, 120) : "（无）"}`);
    console.log(`    筛选: ${JSON.stringify(search.filters)}`);
  }
  return 0;
}

/** Runs the `saved` subcommand and returns the process exit code. */
export function runSavedCli(argv: string[], dbPath = DB_PATH): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (subcommand === "-h" || subcommand === "--help") {
    console.log(USAGE);
    return 0;
  }

  let db: IndexedDatabase;
  try {
    db = openDb(dbPath);
  } catch (error) {
    console.error(`cannot open index ${dbPath}: ${messageOf(error)}`);
    return 1;
  }

  try {
    if (subcommand === "list") {
      return printList(db);
    }
    if (subcommand === "add") {
      const positional: string[] = [];
      let filtersRaw: string | null = null;
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index] as string;
        if (arg === "--filters" || arg.startsWith("--filters=")) {
          const eq = arg.indexOf("=");
          if (eq >= 0) {
            filtersRaw = arg.slice(eq + 1);
          } else {
            const next = rest[index + 1];
            if (next === undefined || next.startsWith("-")) {
              return fail(
                '--filters requires a JSON object value, e.g. --filters \'{"scope":"process"}\'',
              );
            }
            filtersRaw = next;
            index += 1;
          }
          continue;
        }
        if (arg.startsWith("-")) return fail(`unknown option "${arg}"`);
        positional.push(arg);
      }
      const [name, query] = positional;
      if (!name) return fail("usage: saved add <name> [query] [--filters '<json>']");
      let filters: unknown = {};
      if (filtersRaw !== null) {
        try {
          filters = JSON.parse(filtersRaw);
        } catch (error) {
          return fail(`invalid --filters JSON: ${messageOf(error)}`);
        }
      }
      try {
        const search = createSavedSearch(db, {
          name,
          query: query ?? "",
          filters,
        });
        console.log(`已保存搜索 ${search.id}：${search.name}`);
        return 0;
      } catch (error) {
        if (error instanceof InvalidSavedSearchError) return fail(error.message);
        throw error;
      }
    }
    if (subcommand === "remove") {
      const id = rest[0];
      if (!id) return fail("usage: saved remove <id>");
      if (!deleteSavedSearch(db, id)) {
        console.error(`${id} 不存在，未删除。`);
        return 1;
      }
      console.log(`已删除保存的搜索 ${id}`);
      return 0;
    }
    return fail(`unknown subcommand "${subcommand}": expected list, add or remove`);
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  } finally {
    db.close();
  }
}
