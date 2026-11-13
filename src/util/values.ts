export type JsonObject = Record<string, unknown>;

/** JSON.parse output narrowed at the boundary; every field is checked on read. */
export function objectValue(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function cleanTitle(value: string, fallback: string): string {
  const cleaned = value
    .replace(/\p{Co}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) return cleaned.slice(0, 200);
  return fallback;
}

export function firstLine(text: string, max = 120): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (line ?? "").slice(0, max);
}

/**
 * Cindy and Orca prepend instructions before the user's actual prompt. They are
 * still transcript turns, but a title built from them is useless.
 */
const INJECTED_PROMPT =
  /^(?:<environment_context>|<cindy-extra-writable-directories>|\[UI language\]|\[系统\]\s*Orca Worker)/i;

/** The first prompt worth showing as a title, or the first one if none is. */
export function titlePrompt(turns: { userText: string }[]): string {
  const real = turns.find((turn) => !INJECTED_PROMPT.test(turn.userText.trimStart()));
  const text = real?.userText ?? turns[0]?.userText ?? "";
  return text.replace(/^\[From Orca Lead\]\s*/i, "");
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Flatten whitespace and cut to `max` runes, marking the cut with an ellipsis. */
export function clipText(value: string, max: number): string {
  const flat = collapse(value);
  const runes = [...flat];
  return runes.length <= max ? flat : `${runes.slice(0, max - 1).join("")}…`;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
