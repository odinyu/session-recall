import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR, PORT } from "./config.ts";

/**
 * User preferences, keyed to the installation rather than to the page origin.
 *
 * The packaged app reserves a fresh ephemeral port on every launch, so its
 * origin — and with it `localStorage` — is thrown away each time. Preferences
 * therefore live in a small JSON file under `APP_DIR`, which the sidecar owns
 * and serves over HTTP, so both the `.app` and `bun run start` share them.
 */

export type ThemeMode = "auto" | "light" | "dark";

/**
 * Interface language. `auto` follows the browser (see `web/i18n.ts`, which is
 * the only place the resolution rule lives); `zh`/`en` pin it.
 */
export type LanguagePref = "auto" | "zh" | "en";

export const THEME_MODES: readonly ThemeMode[] = ["auto", "light", "dark"];

export const LANGUAGE_PREFS: readonly LanguagePref[] = ["auto", "zh", "en"];

/**
 * A global shortcut in the `Modifier+Modifier+Key` form the shell can register,
 * e.g. `"Option+Command+R"`; `null` means "do not register one".
 */
export type Hotkey = string | null;

/** Shape of the file; unknown keys are kept so an older build cannot eat them. */
export interface Prefs {
  theme: ThemeMode;
  language: LanguagePref;
  /** Absent means "the default shortcut"; see {@link effectiveHotkey}. */
  hotkey?: Hotkey;
  /** Absent means `true`; only an explicit `false` turns the check off. */
  checkUpdates?: boolean;
  [key: string]: unknown;
}

export const DEFAULT_PREFS: Prefs = { theme: "auto", language: "auto" };

/** Raised for a patch we refuse to store; the API turns it into a 400. */
export class InvalidPrefsError extends Error {}

/**
 * The shortcut 1.6.0 ships with, in `global-hotkey`'s syntax. `Option+Space` is
 * deliberately avoided: Raycast and Spotlight claim it on most Macs.
 */
export const DEFAULT_HOTKEY = "Option+Command+R";

/**
 * Environment override for the shortcut, read by both the shell and this
 * module. Tests use it to run a launch without touching `prefs.json`.
 */
const HOTKEY_ENV = "SESSION_RECALL_HOTKEY";

/** Values that mean "no shortcut" rather than a key combination. */
const DISABLED_HOTKEY_VALUES: readonly string[] = ["", "off", "none", "false"];

/**
 * Modifier names a hotkey may use, normalised to the four real modifiers.
 * `Option`/`Alt` and `Ctrl`/`Control` are the same key spelled two ways.
 */
const HOTKEY_MODIFIERS: Record<string, string> = {
  option: "alt",
  alt: "alt",
  command: "command",
  cmd: "command",
  ctrl: "control",
  control: "control",
  shift: "shift",
};

/** The file the shell writes after registering the shortcut (see main.rs). */
const HOTKEY_STATE_FILE = "hotkey-state.json";

export function prefsPath(dir = APP_DIR): string {
  return join(dir, "prefs.json");
}

/**
 * Whether `value` is a hotkey this build can register, or `null` for "none".
 *
 * Exactly the strings `parse_hotkey_spec` in `src-tauri/src/main.rs` accepts, so
 * a preference the UI stores is never silently rejected by the shell: at least
 * one modifier from {@link HOTKEY_MODIFIERS}, no modifier twice, then a single
 * key — `A`–`Z`, `0`–`9` or `F1`–`F12`. Case does not matter; a modifier may
 * not follow the key.
 */
export function isHotkey(value: unknown): value is Hotkey {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const tokens = value.split("+");
  if (tokens.length < 2) return false;
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") return false;
    const modifier = HOTKEY_MODIFIERS[token.toLowerCase()];
    if (modifier !== undefined) {
      // Modifiers come first, and each one at most once: `Option+Alt` is the
      // Alt key twice, not a shorthand for two different modifiers.
      if (key !== null || modifiers.has(modifier)) return false;
      modifiers.add(modifier);
      continue;
    }
    if (key !== null) return false;
    if (!isHotkeyKey(token.toUpperCase())) return false;
    key = token;
  }
  return modifiers.size > 0 && key !== null;
}

function isHotkeyKey(token: string): boolean {
  if (token.length === 1) return /^[A-Z0-9]$/.test(token);
  const match = /^F([1-9]|1[0-2])$/.exec(token);
  return match !== null;
}

/**
 * Whether `value` is a usable `checkUpdates` preference. Only a real boolean
 * counts; `null`, `"true"` and `0` are all refused rather than coerced, so a
 * typo in a hand-edited file can never silently change the behaviour.
 */
export function isCheckUpdates(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return (
    typeof value === "string" && (THEME_MODES as readonly string[]).includes(value)
  );
}

export function isLanguagePref(value: unknown): value is LanguagePref {
  return (
    typeof value === "string" &&
    (LANGUAGE_PREFS as readonly string[]).includes(value)
  );
}

/**
 * Coerce anything read from disk into usable prefs: a non-object (or an
 * unusable `theme`/`language`) falls back to the defaults, and every other key
 * survives. An older `prefs.json` without `language` therefore reads as `auto`.
 */
function normalize(value: unknown): Prefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_PREFS };
  }
  const raw = value as Record<string, unknown>;
  const normalized: Prefs = {
    ...raw,
    theme: isThemeMode(raw.theme) ? raw.theme : DEFAULT_PREFS.theme,
    language: isLanguagePref(raw.language)
      ? raw.language
      : DEFAULT_PREFS.language,
  };
  // An unusable hotkey is dropped rather than repaired: absent already means
  // "the default shortcut", which is what the shell falls back to as well.
  if ("hotkey" in normalized && !isHotkey(normalized.hotkey)) {
    delete normalized.hotkey;
  }
  // Same for the update toggle: absent means enabled, so an unusable value is
  // dropped rather than guessed into either direction.
  if ("checkUpdates" in normalized && !isCheckUpdates(normalized.checkUpdates)) {
    delete normalized.checkUpdates;
  }
  return normalized;
}

/**
 * Current preferences. A missing, unreadable, truncated or unparseable file all
 * mean "defaults" — booting must never depend on this file being intact.
 */
export function readPrefs(dir = APP_DIR): Prefs {
  let text: string;
  try {
    text = readFileSync(prefsPath(dir), "utf8");
  } catch {
    return { ...DEFAULT_PREFS };
  }
  try {
    return normalize(JSON.parse(text));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * Merge `patch` over the stored preferences, persist the result and return it.
 *
 * Merging (rather than replacing) keeps keys this build does not know about.
 * Writes go to a sibling temp file that is renamed over the target, so an
 * interrupted write can only ever leave the previous file in place.
 */
export function updatePrefs(
  patch: Record<string, unknown>,
  dir = APP_DIR,
): Prefs {
  if ("theme" in patch && !isThemeMode(patch.theme)) {
    throw new InvalidPrefsError(
      `invalid theme: ${JSON.stringify(patch.theme)} (expected auto, light or dark)`,
    );
  }
  if ("language" in patch && !isLanguagePref(patch.language)) {
    throw new InvalidPrefsError(
      `invalid language: ${JSON.stringify(patch.language)} (expected auto, zh or en)`,
    );
  }
  if ("hotkey" in patch && !isHotkey(patch.hotkey)) {
    throw new InvalidPrefsError(
      `invalid hotkey: ${JSON.stringify(patch.hotkey)} (expected null, or a shortcut such as ${JSON.stringify(DEFAULT_HOTKEY)})`,
    );
  }
  if ("checkUpdates" in patch && !isCheckUpdates(patch.checkUpdates)) {
    throw new InvalidPrefsError(
      `invalid checkUpdates: ${JSON.stringify(patch.checkUpdates)} (expected true or false)`,
    );
  }
  const merged: Prefs = { ...readPrefs(dir), ...patch } as Prefs;
  persist(merged, dir);
  return merged;
}

/**
 * Whether the shell should look for updates on launch. Only an explicit
 * `false` disables it; absent, `true` and every unusable value mean enabled —
 * mirroring `prefs_check_updates` in `src-tauri/src/main.rs`, so the drawer's
 * toggle can never disagree with what the shell actually does.
 */
export function effectiveCheckUpdates(dir = APP_DIR): boolean {
  return readPrefs(dir).checkUpdates !== false;
}

/**
 * The global shortcut in force for a launch: `SESSION_RECALL_HOTKEY` first, then
 * the stored preference, then {@link DEFAULT_HOTKEY}. `null` means the user
 * turned it off.
 *
 * An unusable override or stored value is ignored rather than fatal — booting
 * must not depend on a hand-edited file — so both sides of the app fall back to
 * the default. Mirrors `effective_hotkey` in `src-tauri/src/main.rs`; the shell
 * registers this value and the sidecar reports it, so the rules must agree.
 */
export function effectiveHotkey(
  dir = APP_DIR,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const override = env[HOTKEY_ENV]?.trim();
  if (override !== undefined) {
    if (DISABLED_HOTKEY_VALUES.includes(override.toLowerCase())) return null;
    if (isHotkey(override)) return override;
  }
  const stored = readPrefs(dir).hotkey;
  if (stored === null) return null;
  // Trimmed, because the shell trims before it registers: the two have to agree
  // on the string, or a padded pref would look like a change after launch.
  return isHotkey(stored) ? stored.trim() : DEFAULT_HOTKEY;
}

/** What the shell recorded after trying to register the shortcut. */
interface HotkeyState {
  hotkey: string | null;
  registered: boolean;
  error: string | null;
  port: number;
}

/**
 * The shell's record, but only when it belongs to the process serving `port`.
 *
 * The file is written fresh by every launch (the packaged app reserves a new
 * port each time), so a port mismatch means the file describes some other run.
 */
function readHotkeyState(dir: string, port: number): HotkeyState | null {
  let text: string;
  try {
    text = readFileSync(join(dir, HOTKEY_STATE_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as Partial<HotkeyState>;
    if (raw.port !== port || typeof raw.registered !== "boolean") return null;
    if (raw.hotkey !== null && typeof raw.hotkey !== "string") return null;
    return {
      hotkey: raw.hotkey,
      registered: raw.registered,
      error: typeof raw.error === "string" ? raw.error : null,
      port,
    };
  } catch {
    return null;
  }
}

/** What `GET /api/hotkey` reports; the settings drawer renders it. */
export interface HotkeyStatus {
  /** The shortcut the preferences ask for now, or `null` when disabled. */
  hotkey: string | null;
  /** True only when the running shell owns that shortcut right now. */
  registered: boolean;
  /** Why it is not active, in the shell's words (it carries the macOS hint). */
  error?: string;
  /** The shortcut still in force, when prefs changed after launch. */
  active?: string | null;
}

/**
 * Registration is a launch-time step, so a preference written while the app
 * runs reports as not registered *with* the shortcut it will get after a
 * restart — that keeps "restart to apply" distinct from "someone else owns it".
 */
export function hotkeyStatus(
  dir = APP_DIR,
  port = PORT,
  env: Record<string, string | undefined> = process.env,
): HotkeyStatus {
  const hotkey = effectiveHotkey(dir, env);
  if (hotkey === null) return { hotkey: null, registered: false };
  const state = readHotkeyState(dir, port);
  if (state === null) {
    return {
      hotkey,
      registered: false,
      error: "the desktop app is not running, and only it can register a global shortcut",
    };
  }
  if (state.hotkey !== hotkey) {
    return {
      hotkey,
      registered: false,
      active: state.hotkey,
      error: `the shortcut changed to ${hotkey}; restart the app to apply it`,
    };
  }
  return state.error === null
    ? { hotkey, registered: state.registered }
    : { hotkey, registered: state.registered, error: state.error };
}

/** The file the shell writes after every update check (see main.rs). */
const UPDATE_STATE_FILE = "update-state.json";

/** The file this sidecar writes to ask the shell to install an update. */
const UPDATE_REQUEST_FILE = "update-install-request.json";

/** What the shell recorded after an update check or an install attempt. */
export interface UpdateStatus {
  /** True when the shell saw a newer release on its last check. */
  available: boolean;
  /** The version the shell would install, when one was seen. */
  version?: string;
  /** The release notes the shell saw, when one was seen. */
  notes?: string;
  /** Why the last check or install failed, in the shell's words. */
  error?: string;
  /** When the last check ran, as epoch milliseconds (the shell's clock). */
  checkedAt?: number;
  /** True while the shell is downloading and installing an update. */
  installing?: boolean;
}

/**
 * The shell's update record, for `GET /api/update`.
 *
 * A missing file means the shell has not checked yet (it waits ten seconds
 * after the window opens), so the status is `{ available: false }` with no
 * timestamp rather than an error — nothing has failed.
 */
export function updateStatus(dir = APP_DIR): UpdateStatus {
  let text: string;
  try {
    text = readFileSync(join(dir, UPDATE_STATE_FILE), "utf8");
  } catch {
    return { available: false };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.available !== "boolean") return { available: false };
    const status: UpdateStatus = { available: raw.available };
    if (typeof raw.version === "string") status.version = raw.version;
    if (typeof raw.notes === "string") status.notes = raw.notes;
    if (typeof raw.error === "string") status.error = raw.error;
    if (typeof raw.checkedAt === "number") status.checkedAt = raw.checkedAt;
    if (raw.installing === true) status.installing = true;
    return status;
  } catch {
    // A corrupt file must not read as a failure of the update system itself.
    return { available: false, error: "the update state file is corrupt" };
  }
}

/**
 * Ask the shell to download and install the announced update.
 *
 * The shell has no IPC channel to the sidecar, so the request travels as a
 * file it polls (every couple of seconds, see main.rs). Writing it is gated on
 * an update actually being announced; the shell still re-checks before it
 * downloads, so a stale announcement cannot install the wrong package.
 */
export function requestUpdateInstall(
  dir = APP_DIR,
): "requested" | "no-update-available" {
  if (!updateStatus(dir).available) return "no-update-available";
  writeFileSync(join(dir, UPDATE_REQUEST_FILE), "{}\n", "utf8");
  return "requested";
}

function persist(prefs: Prefs, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const target = prefsPath(dir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
