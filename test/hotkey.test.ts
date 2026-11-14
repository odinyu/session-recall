import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOTKEY,
  DEFAULT_PREFS,
  InvalidPrefsError,
  hotkeyStatus,
  isHotkey,
  prefsPath,
  readPrefs,
  updatePrefs,
  effectiveHotkey,
} from "../src/prefs.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-hotkey-"));
let caseId = 0;

/** A fresh directory per case, so one test can never see another's file. */
function freshDir(): string {
  const dir = join(root, `case-${caseId++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PORT = 4319;

/** Stand-in for the shell's record; its shape is `record_hotkey_state`'s. */
function writeState(
  dir: string,
  state: { hotkey: string | null; registered: boolean; error?: string },
  port = PORT,
): void {
  writeFileSync(
    join(dir, "hotkey-state.json"),
    JSON.stringify({ ...state, error: state.error ?? null, port }),
    "utf8",
  );
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("accepts the shortcut spellings the shell can register", () => {
  for (const valid of [
    "Option+Command+R",
    "option+command+r",
    "Command+Option+R",
    "Alt+Cmd+R",
    "Option+Shift+F12",
    "Ctrl+Alt+1",
    "Control+A",
    "  Option + Command + R  ",
  ]) {
    expect(isHotkey(valid)).toBe(true);
  }
  // With no preference stored, the default is what gets registered.
  expect(isHotkey(DEFAULT_HOTKEY)).toBe(true);
});

test("treats null (and only null) as a deliberate opt-out", () => {
  expect(isHotkey(null)).toBe(true);
  expect(isHotkey(undefined)).toBe(false);
  expect(isHotkey(false)).toBe(false);
});

test("rejects shortcuts the shell would refuse", () => {
  for (const invalid of [
    "",
    "R",
    "Option",
    "Option+",
    "Option++R",
    "Option+R+Shift",
    "Option+Alt+R",
    "Super+R",
    "Option+Meta+R",
    "Option+Command+Rr",
    "Option+Command+F13",
    "Option+Command+F0",
    "Option+Command+Return",
    7,
    {},
    ["Option+Command+R"],
  ]) {
    expect(isHotkey(invalid)).toBe(false);
  }
});

test("stores a hotkey, a null and keeps unknown keys", () => {
  const dir = freshDir();
  expect(updatePrefs({ hotkey: "Option+Command+K" }, dir).hotkey).toBe(
    "Option+Command+K",
  );
  expect(readPrefs(dir).hotkey).toBe("Option+Command+K");

  // The rest of the file is untouched by a hotkey patch.
  expect(readPrefs(dir)).toMatchObject({ theme: "auto", language: "auto" });

  writeFileSync(prefsPath(dir), JSON.stringify({ futureKey: 1 }), "utf8");
  updatePrefs({ hotkey: null }, dir);
  expect(readPrefs(dir)).toEqual({
    futureKey: 1,
    theme: "auto",
    language: "auto",
    hotkey: null,
  });
});

test("rejects an unusable hotkey instead of storing it", () => {
  const dir = freshDir();
  updatePrefs({ hotkey: "Option+Command+R" }, dir);
  for (const invalid of ["R", "Option+Command+F13", "Super+R", 7, true, {}]) {
    expect(() => updatePrefs({ hotkey: invalid }, dir)).toThrow(InvalidPrefsError);
  }
  // A rejected patch must not persist the theme it travelled with either.
  expect(() => updatePrefs({ theme: "dark", hotkey: "nope" }, dir)).toThrow(
    InvalidPrefsError,
  );
  expect(readPrefs(dir)).toMatchObject({
    theme: "auto",
    hotkey: "Option+Command+R",
  });
});

test("keeps a persisted null but drops an unusable persisted hotkey", () => {
  const dir = freshDir();
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "dark", hotkey: null }),
    "utf8",
  );
  expect(readPrefs(dir)).toMatchObject({ theme: "dark", hotkey: null });

  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "dark", hotkey: "Hyper+Q", extra: "x" }),
    "utf8",
  );
  // Dropped, not repaired: absent is exactly what "use the default" means.
  expect(readPrefs(dir)).toEqual({ theme: "dark", language: "auto", extra: "x" });
});

test("resolves the effective hotkey from env, then the file, then the default", () => {
  const dir = freshDir();
  const noEnv: Record<string, string | undefined> = {};

  expect(effectiveHotkey(dir, noEnv)).toBe(DEFAULT_HOTKEY);
  expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);

  updatePrefs({ hotkey: "Option+Command+K" }, dir);
  expect(effectiveHotkey(dir, noEnv)).toBe("Option+Command+K");

  updatePrefs({ hotkey: null }, dir);
  expect(effectiveHotkey(dir, noEnv)).toBeNull();

  // The environment wins over the file, for one launch at a time.
  expect(effectiveHotkey(dir, { SESSION_RECALL_HOTKEY: "Ctrl+Shift+F5" })).toBe(
    "Ctrl+Shift+F5",
  );
  for (const off of ["", "off", "none", "FALSE", " off "]) {
    expect(
      effectiveHotkey(dir, { SESSION_RECALL_HOTKEY: off }),
    ).toBeNull();
  }
  // An unusable override is ignored, not fatal.
  expect(effectiveHotkey(dir, { SESSION_RECALL_HOTKEY: "Hyper+Q" })).toBeNull();
});

test("trims the stored hotkey, as the shell does before registering", () => {
  const dir = freshDir();
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "auto", language: "auto", hotkey: "  Option+Command+R  " }),
    "utf8",
  );
  expect(effectiveHotkey(dir, {})).toBe("Option+Command+R");
  // A shell record of the trimmed form therefore reads as registered.
  writeState(dir, { hotkey: "Option+Command+R", registered: true });
  expect(hotkeyStatus(dir, PORT, {})).toEqual({
    hotkey: "Option+Command+R",
    registered: true,
  });
});

test("falls back to the default for an unusable stored hotkey", () => {
  const dir = freshDir();
  writeFileSync(
    prefsPath(dir),
    JSON.stringify({ theme: "auto", language: "auto", hotkey: "Hyper+Q" }),
    "utf8",
  );
  // `readPrefs` already dropped it; the resolver must not invent anything.
  expect(effectiveHotkey(dir, {})).toBe(DEFAULT_HOTKEY);
});

test("reports the shell's registration success", () => {
  const dir = freshDir();
  writeState(dir, { hotkey: DEFAULT_HOTKEY, registered: true });
  expect(hotkeyStatus(dir, PORT, {})).toEqual({
    hotkey: DEFAULT_HOTKEY,
    registered: true,
  });
});

test("surfaces a registration failure with the shell's hint", () => {
  const dir = freshDir();
  const error = `could not register ${DEFAULT_HOTKEY}: already in use. Allow Session Recall under System Settings`;
  writeState(dir, { hotkey: DEFAULT_HOTKEY, registered: false, error });
  expect(hotkeyStatus(dir, PORT, {})).toEqual({
    hotkey: DEFAULT_HOTKEY,
    registered: false,
    error,
  });
});

test("reports nothing registered without a shell state file", () => {
  const dir = freshDir();
  const status = hotkeyStatus(dir, PORT, {});
  expect(status).toMatchObject({ hotkey: DEFAULT_HOTKEY, registered: false });
  expect(status.error).toContain("desktop app is not running");
});

test("ignores a state file written by another launch", () => {
  const dir = freshDir();
  writeState(dir, { hotkey: DEFAULT_HOTKEY, registered: true }, PORT + 1);
  expect(hotkeyStatus(dir, PORT, {})).toMatchObject({ registered: false });
});

test("reports a shortcut changed after launch as pending a restart", () => {
  const dir = freshDir();
  writeState(dir, { hotkey: "Option+Command+K", registered: true });
  const status = hotkeyStatus(dir, PORT, {});
  expect(status.registered).toBe(false);
  expect(status.active).toBe("Option+Command+K");
  expect(status.error).toContain("restart");
});

test("reports a disabled shortcut without inventing an error", () => {
  const dir = freshDir();
  expect(hotkeyStatus(dir, PORT, { SESSION_RECALL_HOTKEY: "off" })).toEqual({
    hotkey: null,
    registered: false,
  });
});

test("survives a corrupt state file", () => {
  const dir = freshDir();
  for (const junk of ["", "not json", "[]", "null", '{"port":']) {
    writeFileSync(join(dir, "hotkey-state.json"), junk, "utf8");
    expect(hotkeyStatus(dir, PORT, {}).registered).toBe(false);
  }
});

test("serialises to the endpoint's documented shape", () => {
  const dir = freshDir();
  writeState(dir, { hotkey: DEFAULT_HOTKEY, registered: false, error: "denied" });
  const text = JSON.stringify(hotkeyStatus(dir, PORT, {}));
  expect(JSON.parse(text)).toEqual({
    hotkey: DEFAULT_HOTKEY,
    registered: false,
    error: "denied",
  });
  // Reading the status writes nothing, so `prefs.json` stays absent.
  expect(() => readFileSync(prefsPath(dir), "utf8")).toThrow();
});
