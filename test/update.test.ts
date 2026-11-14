import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFS,
  InvalidPrefsError,
  effectiveCheckUpdates,
  isCheckUpdates,
  prefsPath,
  readPrefs,
  requestUpdateInstall,
  updatePrefs,
  updateStatus,
} from "../src/prefs.ts";
import { buildLatestJson } from "../scripts/gen-latest-json.mjs";

const root = mkdtempSync(join(tmpdir(), "session-recall-update-"));
let caseId = 0;

function freshDir(): string {
  const dir = join(root, `case-${caseId++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpkZWZhdWx0IHRydXN0bGV2ZWw6IGdsb2JhbA==";

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("checkUpdates is only ever a real boolean", () => {
  expect(isCheckUpdates(true)).toBe(true);
  expect(isCheckUpdates(false)).toBe(true);
  for (const invalid of [null, undefined, "true", "false", 1, 0, {}]) {
    expect(isCheckUpdates(invalid)).toBe(false);
  }
});

test("stores a checkUpdates toggle and keeps unknown keys", () => {
  const dir = freshDir();
  expect(updatePrefs({ checkUpdates: false }, dir).checkUpdates).toBe(false);
  expect(readPrefs(dir).checkUpdates).toBe(false);
  expect(readPrefs(dir)).toMatchObject({ theme: "auto", language: "auto" });

  // Turning it back on round-trips through the file.
  expect(updatePrefs({ checkUpdates: true }, dir).checkUpdates).toBe(true);
  expect(readPrefs(dir).checkUpdates).toBe(true);
});

test("rejects an unusable checkUpdates instead of storing it", () => {
  const dir = freshDir();
  updatePrefs({ checkUpdates: true }, dir);
  for (const invalid of [null, "false", 1, 0, {}]) {
    expect(() => updatePrefs({ checkUpdates: invalid }, dir)).toThrow(
      InvalidPrefsError,
    );
  }
  // A rejected patch must not persist what it travelled with either.
  expect(() =>
    updatePrefs({ theme: "dark", checkUpdates: "no" }, dir),
  ).toThrow(InvalidPrefsError);
  expect(readPrefs(dir)).toMatchObject({ theme: "auto", checkUpdates: true });
});

test("keeps a persisted toggle but drops an unusable persisted value", () => {
  const dir = freshDir();
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "dark", checkUpdates: false, extra: "x" }),
    "utf8",
  );
  expect(readPrefs(dir)).toEqual({
    theme: "dark",
    language: "auto",
    checkUpdates: false,
    extra: "x",
  });

  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "dark", checkUpdates: "false" }),
    "utf8",
  );
  // Dropped, not repaired: absent already means enabled.
  expect(readPrefs(dir)).toEqual({ theme: "dark", language: "auto" });
});

test("only an explicit false disables the update check", () => {
  const dir = freshDir();
  expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);
  expect(effectiveCheckUpdates(dir)).toBe(true);

  updatePrefs({ checkUpdates: true }, dir);
  expect(effectiveCheckUpdates(dir)).toBe(true);

  updatePrefs({ checkUpdates: false }, dir);
  expect(effectiveCheckUpdates(dir)).toBe(false);
});

test("reports the shell's successful update check", () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, "update-state.json"),
    JSON.stringify({
      available: true,
      version: "1.7.0",
      notes: "auto-update support",
      error: null,
      checkedAt: 1731550000000,
      installing: false,
    }),
    "utf8",
  );
  expect(updateStatus(dir)).toEqual({
    available: true,
    version: "1.7.0",
    notes: "auto-update support",
    checkedAt: 1731550000000,
  });
});

test("reports a failed check with the shell's error", () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, "update-state.json"),
    JSON.stringify({
      available: false,
      version: null,
      notes: null,
      error: "update check failed: network unreachable",
      checkedAt: 1731550000000,
      installing: false,
    }),
    "utf8",
  );
  expect(updateStatus(dir)).toEqual({
    available: false,
    error: "update check failed: network unreachable",
    checkedAt: 1731550000000,
  });
});

test("a missing or shapeless state file reads as not-checked-yet", () => {
  const dir = freshDir();
  expect(updateStatus(dir)).toEqual({ available: false });

  writeFileSync(join(dir, "update-state.json"), "not json at all", "utf8");
  expect(updateStatus(dir)).toEqual({
    available: false,
    error: "the update state file is corrupt",
  });

  writeFileSync(join(dir, "update-state.json"), "[]", "utf8");
  expect(updateStatus(dir)).toEqual({ available: false });
});

test("install requests are gated on an announced update", () => {
  const dir = freshDir();
  // Nothing announced: no request file may appear, the shell would poll for it.
  expect(requestUpdateInstall(dir)).toBe("no-update-available");
  expect(() => readFileSync(join(dir, "update-install-request.json"))).toThrow();

  writeFileSync(
    join(dir, "update-state.json"),
    JSON.stringify({ available: true, version: "1.7.0" }),
    "utf8",
  );
  expect(requestUpdateInstall(dir)).toBe("requested");
  expect(readFileSync(join(dir, "update-install-request.json"), "utf8")).toBe("{}\n");
});

test("buildLatestJson emits the exact schema the updater plugin parses", () => {
  const latest = buildLatestJson({
    version: "1.7.0",
    notes: "auto-update support",
    pubDate: "2026-11-14T10:00:00Z",
    darwinAarch64: { signature: SIG, url: "https://example.com/arm.app.tar.gz" },
    darwinX86_64: { signature: `  ${SIG}  `, url: "https://example.com/intel.app.tar.gz" },
  });
  expect(latest).toEqual({
    version: "1.7.0",
    notes: "auto-update support",
    pub_date: "2026-11-14T10:00:00Z",
    platforms: {
      "darwin-aarch64": { signature: SIG, url: "https://example.com/arm.app.tar.gz" },
      "darwin-x86_64": { signature: SIG, url: "https://example.com/intel.app.tar.gz" },
    },
  });
  // The plugin reads the serialized form; nothing may be lost in transit.
  expect(JSON.parse(JSON.stringify(latest))).toEqual(latest);
});

test("buildLatestJson refuses malformed inputs", () => {
  const good = {
    version: "1.7.0",
    notes: "",
    pubDate: "2026-11-14T10:00:00Z",
    darwinAarch64: { signature: SIG, url: "https://example.com/arm.app.tar.gz" },
    darwinX86_64: { signature: SIG, url: "https://example.com/intel.app.tar.gz" },
  };
  expect(() =>
    buildLatestJson({ ...good, version: "v1.7.0-not-semver" }),
  ).toThrow("semver");
  expect(() => buildLatestJson({ ...good, pubDate: "today" })).toThrow("RFC 3339");
  expect(() =>
    buildLatestJson({
      ...good,
      darwinAarch64: { signature: SIG, url: "http://example.com/arm.app.tar.gz" },
    }),
  ).toThrow("https");
  expect(() =>
    buildLatestJson({
      ...good,
      darwinX86_64: { signature: "  ", url: "https://example.com/intel.app.tar.gz" },
    }),
  ).toThrow("signature is empty");
});
