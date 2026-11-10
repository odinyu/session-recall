import { DB_PATH } from "./config.ts";
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
} else if (command === "serve") {
  serve();
} else {
  console.error("usage: bun run src/cli.ts [scan|serve]");
  process.exit(1);
}
