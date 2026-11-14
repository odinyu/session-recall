import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "web", "dist");

// The drawer's update group shows the running version; the only source of
// truth is package.json, injected as a build-time constant.
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version?: string;
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "web", "app.ts")],
  outdir: dist,
  target: "browser",
  minify: false,
  sourcemap: "linked",
  define: { __APP_VERSION__: JSON.stringify(pkgVersion.version ?? "0.0.0") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const file of ["index.html", "styles.css", "favicon.svg"]) {
  copyFileSync(join(root, "web", file), join(dist, file));
}

console.log(`web built → ${dist}`);
