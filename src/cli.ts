import { DB_PATH } from "./config.ts";
import { generateBrief, parseBriefDate } from "./brief.ts";
import { runSearchCli } from "./cli-search.ts";
import { openDb } from "./db.ts";
import { runMcpServer } from "./mcp.ts";
import { scan } from "./scan.ts";
import type { ScanReport } from "./scan.ts";
import { acquireScanLock, scanLockPath } from "./scan-lock.ts";
import { serve } from "./server.ts";

/** Scans under the shared lock; the app or MCP may be scanning right now. */
async function scanLocked(): Promise<ScanReport> {
  const lock = await acquireScanLock(scanLockPath(DB_PATH), { timeoutMs: 60_000 });
  if (!lock) throw new Error("another scan is running; try again when it finishes");
  const db = openDb(DB_PATH);
  try {
    return await scan(db, undefined, {
      onProgress: (message) => console.error(message),
    });
  } finally {
    db.close();
    lock.release();
  }
}

const command = process.argv[2] ?? "serve";

if (command === "scan") {
  try {
    console.log(JSON.stringify(await scanLocked(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (command === "brief") {
  const input = process.argv[3];
  const date = parseBriefDate(input);
  if (!date) {
    console.error("usage: bun run src/cli.ts brief [YYYY-MM-DD]");
    process.exit(1);
  }
  try {
    await scanLocked();
  } catch (error) {
    console.error(
      "scan failed; using existing index",
      error instanceof Error ? error.message : String(error),
    );
  }
  const db = openDb(DB_PATH);
  const result = generateBrief(db, date.key);
  console.log(`brief → ${result.path}`);
  db.close();
} else if (command === "serve") {
  serve();
} else if (command === "search") {
  process.exitCode = runSearchCli(process.argv.slice(3));
} else if (command === "mcp") {
  await runMcpServer();
} else {
  console.error("usage: bun run src/cli.ts [scan|serve|brief|search|mcp]");
  process.exit(1);
}
