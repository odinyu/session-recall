import { DB_PATH } from "./config.ts";
import {
  briefFilesMentioning,
  generateBrief,
  generateWeekReport,
  isoWeekKey,
  parseBriefDate,
  parseBriefWeek,
} from "./brief.ts";
import type { BriefFormat } from "./brief.ts";
import { runSearchCli } from "./cli-search.ts";
import { forgetSession, openDb, splitSessionId, unforgetSession } from "./db.ts";
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
} else if (command === "forget" || command === "unforget") {
  const target = (process.argv[3] ?? "").trim();
  const parsed = splitSessionId(target);
  if (!parsed) {
    console.error(`invalid session id "${target}": expected <agent>:<external-id>`);
    console.error("example: bun run src/cli.ts forget omp:2026-11-10T01-13-16-427Z_01a1c304");
    process.exit(2);
  }
  try {
    // The app and the MCP server scan on their own timers; hold the lock a scan
    // takes so neither can re-index the session while it is being removed.
    const lock = await acquireScanLock(scanLockPath(DB_PATH), { timeoutMs: 60_000 });
    if (!lock) throw new Error("another scan is running; try again when it finishes");
    const db = openDb(DB_PATH);
    try {
      if (command === "forget") {
        const outcome = forgetSession(db, parsed.agent, parsed.externalId);
        // Forgetting is index-only: say so, or the message reads like the agent's
        // own transcript was deleted.
        console.log(
          outcome.removed
            ? `已忘记会话 ${outcome.id}：已从本机索引移除，后续扫描不会再索引它；agent 自己存储中的原始会话文件不会被删除。`
            : `已忘记会话 ${outcome.id}：本机索引中没有它的记录，后续扫描会继续跳过它；agent 自己存储中的原始会话文件不会被删除。`,
        );
        // Briefs are plain Markdown copies; forgetting cannot rewrite them, so
        // report the files that still quote the session instead.
        const stale = briefFilesMentioning(outcome.id);
        if (stale.length > 0) {
          console.log("注意：以下已生成的简报文件仍引用该会话，需要时请重新生成或删除：");
          for (const path of stale) console.log(`  ${path}`);
        }
      } else {
        const wasForgotten = unforgetSession(db, parsed.agent, parsed.externalId);
        console.log(
          wasForgotten
            ? `已取消忘记 ${parsed.agent}:${parsed.externalId}：下次扫描会重新索引它。`
            : `${parsed.agent}:${parsed.externalId} 不在忘记名单中，无需取消。`,
        );
      }
    } finally {
      db.close();
      lock.release();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  console.error(
    "usage: bun run src/cli.ts [scan|serve|brief|search|mcp|forget <agent>:<id>|unforget <agent>:<id>]",
  );
  process.exit(1);
}
