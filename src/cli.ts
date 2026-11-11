import { DB_PATH } from "./config.ts";
import {
  generateBrief,
  generateWeekReport,
  isoWeekKey,
  parseBriefDate,
  parseBriefWeek,
} from "./brief.ts";
import type { BriefFormat } from "./brief.ts";
import { runSearchCli } from "./cli-search.ts";
import { openDb } from "./db.ts";
import { runMcpServer } from "./mcp.ts";
import { scan } from "./scan.ts";
import type { ScanReport } from "./scan.ts";
import { acquireScanLock, scanLockPath } from "./scan-lock.ts";
import { serve } from "./server.ts";


type BriefCli =
  | { kind: "run"; format: BriefFormat; date: string | null; week: string | null }
  | { kind: "help" }
  | { kind: "error"; message: string };

function parseBriefArgs(argv: string[]): BriefCli {
  let format: BriefFormat = "standup";
  let formatGiven = false;
  let date: string | null = null;
  let week: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--format" || arg.startsWith("--format=")) {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
      const value = inline ?? argv[index + 1];
      if (inline === null) index += 1;
      if (value !== "standup" && value !== "archive" && value !== "week") {
        return {
          kind: "error",
          message: `invalid --format "${value ?? ""}": expected standup, archive or week`,
        };
      }
      format = value;
      formatGiven = true;
      continue;
    }
    if (arg === "--week" || arg.startsWith("--week=")) {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
      const value = inline ?? argv[index + 1];
      if (inline === null) index += 1;
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "--week requires a value, e.g. --week 2026-W46" };
      }
      week = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown option "${arg}"` };
    }
    if (date !== null) {
      return { kind: "error", message: `unexpected argument "${arg}"` };
    }
    date = arg;
  }

  if (week !== null && formatGiven && format !== "week") {
    return { kind: "error", message: "--week requires --format week" };
  }
  if (week !== null) format = "week";

  if (format === "week") {
    if (week === null) {
      const parsed = parseBriefDate(date);
      if (date !== null && !parsed) {
        return { kind: "error", message: `invalid date "${date}"` };
      }
      week = isoWeekKey(parsed?.start ?? Date.now());
    }
    if (!parseBriefWeek(week)) {
      return { kind: "error", message: `invalid week "${week}": expected YYYY-Www` };
    }
  } else if (date !== null && !parseBriefDate(date)) {
    return { kind: "error", message: `invalid date "${date}"` };
  }

  return { kind: "run", format, date, week };
}

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
  const parsed = parseBriefArgs(process.argv.slice(3));
  if (parsed.kind === "help") {
    console.log(
      "usage: bun run src/cli.ts brief [YYYY-MM-DD] [--format standup|archive|week] [--week YYYY-Www]",
    );
  } else if (parsed.kind === "error") {
    console.error(parsed.message);
    console.error("run with --help for usage.");
    process.exit(2);
  } else {
    try {
      await scanLocked();
    } catch (error) {
      console.error(
        "scan failed; using existing index",
        error instanceof Error ? error.message : String(error),
      );
    }
    const db = openDb(DB_PATH);
    try {
      const result =
        parsed.format === "week"
          ? generateWeekReport(db, parsed.week ?? undefined)
          : generateBrief(db, parsed.date ?? undefined, { format: parsed.format });
      console.log(`brief → ${result.path}`);
    } finally {
      db.close();
    }
  }
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
