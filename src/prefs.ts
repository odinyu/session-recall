import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config.ts";

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

/** Shape of the file; unknown keys are kept so an older build cannot eat them. */
export interface Prefs {
  theme: ThemeMode;
  language: LanguagePref;
  [key: string]: unknown;
}

export const DEFAULT_PREFS: Prefs = { theme: "auto", language: "auto" };

/** Raised for a patch we refuse to store; the API turns it into a 400. */
export class InvalidPrefsError extends Error {}

export function prefsPath(dir = APP_DIR): string {
  return join(dir, "prefs.json");
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
  return {
    ...raw,
    theme: isThemeMode(raw.theme) ? raw.theme : DEFAULT_PREFS.theme,
    language: isLanguagePref(raw.language)
      ? raw.language
      : DEFAULT_PREFS.language,
  };
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
  const merged: Prefs = { ...readPrefs(dir), ...patch } as Prefs;
  persist(merged, dir);
  return merged;
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
