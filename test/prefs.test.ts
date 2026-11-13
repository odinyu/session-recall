import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFS,
  InvalidPrefsError,
  isLanguagePref,
  isThemeMode,
  prefsPath,
  readPrefs,
  updatePrefs,
} from "../src/prefs.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-prefs-"));
let caseId = 0;

/** A fresh directory per case, so one test can never see another's file. */
function freshDir(): string {
  const dir = join(root, `case-${caseId++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("defaults to auto when the file is missing", () => {
  const dir = freshDir();
  expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);
  expect(readPrefs(dir).theme).toBe("auto");
  expect(readPrefs(dir).language).toBe("auto");
});

test("round-trips a theme through the file", () => {
  const dir = freshDir();
  expect(updatePrefs({ theme: "dark" }, dir)).toEqual({
    theme: "dark",
    language: "auto",
  });
  expect(readPrefs(dir).theme).toBe("dark");

  const onDisk = JSON.parse(readFileSync(prefsPath(dir), "utf8")) as {
    theme: string;
  };
  expect(onDisk.theme).toBe("dark");

  expect(updatePrefs({ theme: "light" }, dir).theme).toBe("light");
  expect(readPrefs(dir).theme).toBe("light");
  // The temp file used for the atomic rename is gone again.
  expect(readdirSync(dir)).toEqual(["prefs.json"]);
});

test("merges a patch instead of replacing the whole file", () => {
  const dir = freshDir();
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "light", futureKey: { kept: true } }),
    "utf8",
  );
  const merged = updatePrefs({ theme: "dark" }, dir);
  expect(merged.theme).toBe("dark");
  expect(merged.futureKey).toEqual({ kept: true });

  const onDisk = JSON.parse(readFileSync(prefsPath(dir), "utf8")) as Record<
    string,
    unknown
  >;
  expect(onDisk.futureKey).toEqual({ kept: true });
  expect(onDisk.theme).toBe("dark");

  // A patch without a theme keeps the stored one.
  expect(updatePrefs({}, dir).theme).toBe("dark");
});

test("falls back to defaults for a corrupt file instead of throwing", () => {
  const dir = freshDir();
  for (const junk of ['{"theme": "dark"', "", "not json at all", "[]", "null"]) {
    writeFileSync(prefsPath(dir), junk, "utf8");
    expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);
  }
});

test("keeps unknown keys but repairs an unusable theme", () => {
  const dir = freshDir();
  writeFileSync(prefsPath(dir), JSON.stringify({ theme: 7, extra: "x" }), "utf8");
  expect(readPrefs(dir)).toEqual({ theme: "auto", language: "auto", extra: "x" });
});

test("rejects an invalid theme rather than storing garbage", () => {
  const dir = freshDir();
  updatePrefs({ theme: "dark" }, dir);
  for (const invalid of ["Dark", "blue", "", 1, null, true, {}]) {
    expect(() => updatePrefs({ theme: invalid }, dir)).toThrow(InvalidPrefsError);
  }
  // The stored value survived every rejected write.
  expect(readPrefs(dir).theme).toBe("dark");
  expect(isThemeMode("auto")).toBe(true);
  expect(isThemeMode(undefined)).toBe(false);
});

test("round-trips a language through the file", () => {
  const dir = freshDir();
  expect(updatePrefs({ language: "en" }, dir).language).toBe("en");
  expect(readPrefs(dir).language).toBe("en");
  // Language and theme are independent: patching one leaves the other alone.
  expect(readPrefs(dir).theme).toBe("auto");

  updatePrefs({ theme: "dark" }, dir);
  expect(readPrefs(dir)).toMatchObject({ theme: "dark", language: "en" });

  expect(updatePrefs({ language: "zh" }, dir).language).toBe("zh");
  expect(updatePrefs({ language: "auto" }, dir).language).toBe("auto");
  const onDisk = JSON.parse(readFileSync(prefsPath(dir), "utf8")) as {
    language: string;
  };
  expect(onDisk.language).toBe("auto");
});

test("treats a prefs file written before `language` existed as auto", () => {
  const dir = freshDir();
  // The v1.2.2 shape: theme only, plus a key this build does not know.
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "dark", futureKey: true }),
    "utf8",
  );
  const prefs = readPrefs(dir);
  expect(prefs.language).toBe("auto");
  expect(prefs.theme).toBe("dark");
  expect(prefs.futureKey).toBe(true);
});

test("repairs an unusable language but keeps unknown keys", () => {
  const dir = freshDir();
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ language: 7, theme: "light", extra: "x" }),
    "utf8",
  );
  expect(readPrefs(dir)).toEqual({ language: "auto", theme: "light", extra: "x" });
});

test("rejects an invalid language rather than storing garbage", () => {
  const dir = freshDir();
  updatePrefs({ language: "zh" }, dir);
  for (const invalid of [
    "ZH",
    "cn",
    "english",
    "",
    1,
    null,
    true,
    {},
    ["en"],
  ]) {
    expect(() => updatePrefs({ language: invalid }, dir)).toThrow(
      InvalidPrefsError,
    );
  }
  // The stored value survived every rejected write.
  expect(readPrefs(dir).language).toBe("zh");
  expect(isLanguagePref("auto")).toBe(true);
  expect(isLanguagePref("en")).toBe(true);
  expect(isLanguagePref(undefined)).toBe(false);

  // A rejected language patch must not persist the theme it travelled with
  // either: updatePrefs validates before it reads or writes anything.
  expect(() =>
    updatePrefs({ theme: "dark", language: "nope" }, dir),
  ).toThrow(InvalidPrefsError);
  expect(readPrefs(dir)).toMatchObject({ theme: "auto", language: "zh" });
});
