import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the browser entrypoint against the bug that shipped in 1.3.0: a
 * `renderBrief(ref, format)` parameter shadowed the `format()` helper imported
 * from `i18n.ts`. The parameter is a string, so the brief view threw
 * "format2 is not a function" — the bundler renamed the import to `format2`,
 * and every `format(t.key, ...)` call inside renderBrief resolved to the
 * parameter instead. A type-check would have caught it, but `bun run build`
 * strips types without checking them.
 */

const webDir = join(import.meta.dir, "..", "web");
const appPath = join(webDir, "app.ts");
const appSource = readFileSync(appPath, "utf8");

/** The names `app.ts` imports; a parameter with one of these shadows it. */
function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"[^"]+";/gm)) {
    for (const part of (match[1] ?? "").split(",")) {
      const withoutType = part.trim().replace(/^type\s+/, "");
      const name = withoutType.split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Every `function` parameter list, so a shadowing parameter cannot hide. */
function functionParameters(source: string): { fn: string; params: string[] }[] {
  const found: { fn: string; params: string[] }[] = [];
  for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    const params = (match[2] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^\.\.\./, "").match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? "")
      .filter(Boolean);
    found.push({ fn: match[1] ?? "(anonymous)", params });
  }
  return found;
}

test("no function parameter shadows an imported helper", () => {
  const imported = importedNames(appSource);
  expect(imported.has("format")).toBe(true);
  const collisions = functionParameters(appSource).flatMap(({ fn, params }) =>
    params.filter((param) => imported.has(param)).map((param) => `${fn}(${param})`),
  );
  expect(collisions).toEqual([]);
});

test("renderBrief takes a kind, not the format helper's name", () => {
  const signature = appSource.match(/async function renderBrief\s*\(([^)]*)\)/);
  expect(signature).not.toBeNull();
  expect(signature?.[1]).toContain("kind");
  expect(signature?.[1]).not.toMatch(/\bformat\b/);
});

test("the built bundle keeps the format helper and has no format2 collision", async () => {
  const result = await Bun.build({
    entrypoints: [appPath],
    target: "browser",
    minify: false,
  });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  // `format2` is what the bundler names the import once a local binding has
  // taken `format`; its presence means the shadowing is back.
  expect(code).not.toMatch(/\bformat2\b/);
  const signature = code.match(/async function renderBrief\s*\(([^)]*)\)/);
  expect(signature).not.toBeNull();
  expect(signature?.[1]).not.toMatch(/\bformat\b/);
});
