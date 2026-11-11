import { DB_PATH } from "./config.ts";
import { generateBrief, parseBriefDate } from "./brief.ts";
import { runSearchCli } from "./cli-search.ts";
import { openDb } from "./db.ts";
import { scan } from "./scan.ts";
import { serve } from "./server.ts";

const command = process.argv[2] ?? "serve";

if (command === "scan") {
  const db = openDb(DB_PATH);
  const report = await scan(db, undefined, {
    onProgress: (message) => console.error(message),
  });
  console.log(JSON.stringify(report, null, 2));
  db.close();
} else if (command === "brief") {
  const input = process.argv[3];
  const date = parseBriefDate(input);
  if (!date) {
    console.error("usage: bun run src/cli.ts brief [YYYY-MM-DD]");
    process.exit(1);
  }
  const db = openDb(DB_PATH);
  try {
    await scan(db, undefined, {
      onProgress: (message) => console.error(message),
    });
  } catch (error) {
    console.error("scan failed; using existing index", error);
  }
  const result = generateBrief(db, date.key);
  console.log(`brief → ${result.path}`);
  db.close();
} else if (command === "serve") {
  serve();
} else if (command === "search") {
  process.exitCode = runSearchCli(process.argv.slice(3));
} else {
  console.error("usage: bun run src/cli.ts [scan|serve|brief|search]");
  process.exit(1);
}
