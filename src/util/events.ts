import type { ParsedEvent } from "../adapters/types.ts";

export const EVENT_CAPS = {
  reasoning: 2_000,
  input: 1_000,
  output: 2_000,
} as const;

export const MAX_EVENTS_PER_TURN = 30;
export const MAX_EVENTS_PER_SESSION = 1_200;

const BINARY_MARKERS = /data:[a-z]+\/[a-z0-9.+-]+;base64,/i;

export interface CappedText {
  text: string;
  truncated: boolean;
}

/** Keep a head and a tail so both the start and the outcome stay readable. */
export function capEventText(value: string, limit: number): CappedText {
  const clean = value.replace(/\u0000/g, "");
  if (!clean) return { text: "", truncated: false };
  if (BINARY_MARKERS.test(clean.slice(0, 2_000))) {
    return { text: "（二进制内容已省略）", truncated: true };
  }
  if (clean.length <= limit) return { text: clean, truncated: false };
  const marker = "\n…\n";
  const usable = limit - marker.length;
  const head = Math.ceil(usable / 2);
  const tail = Math.max(0, usable - head);
  return {
    text: `${clean.slice(0, head)}${marker}${tail > 0 ? clean.slice(-tail) : ""}`,
    truncated: true,
  };
}

export function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Bound one session's event list without losing its turn order. */
export function limitEvents(events: ParsedEvent[]): ParsedEvent[] {
  const perTurn = new Map<number, number>();
  const out: ParsedEvent[] = [];
  for (const event of events) {
    if (out.length >= MAX_EVENTS_PER_SESSION) break;
    const count = perTurn.get(event.turnIdx) ?? 0;
    if (count >= MAX_EVENTS_PER_TURN) continue;
    perTurn.set(event.turnIdx, count + 1);
    out.push(event);
  }
  return out;
}
