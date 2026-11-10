import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "web", "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "web", "app.ts")],
  outdir: dist,
  target: "browser",
  minify: false,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const file of ["index.html", "styles.css", "favicon.svg"]) {
  copyFileSync(join(root, "web", file), join(dist, file));
}

console.log(`web built → ${dist}`);
