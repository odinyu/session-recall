import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSession,
  eventCountsFor,
  eventsForTurn,
  openDb,
  writeSession,
} from "../src/db.ts";
import type { ParsedEvent, ParsedSession } from "../src/adapters/types.ts";
import {
  capEventText,
  limitEvents,
  MAX_EVENTS_PER_SESSION,
  MAX_EVENTS_PER_TURN,
} from "../src/util/events.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-events-"));
const db = openDb(join(dir, "index.db"));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  agent: "omp" as const,
  projectPath: "/tmp/project",
  title: "events",
  startedAt: Date.UTC(2026, 9, 1),
  updatedAt: Date.UTC(2026, 9, 2),
  sourceKind: "jsonl" as const,
  sourcePath: "/tmp/events.jsonl",
  fingerprint: "1",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 9, 1),
      userText: "question",
      assistantText: "answer",
    },
  ],
};

test("capEventText bounds a value and keeps both ends", () => {
  const capped = capEventText(`${"a".repeat(80)}z`, 20);
  expect(capped.truncated).toBe(true);
  expect(capped.text.length).toBeLessThanOrEqual(20);
  expect(capped.text.startsWith("a")).toBe(true);
  expect(capped.text.endsWith("z")).toBe(true);
  expect(capped.text).not.toContain("\u0000");
});

test("capEventText removes NUL and skips base64 payloads", () => {
  expect(capEventText("a\u0000b", 10).text).toBe("ab");
  const binary = capEventText(
    `data:image/png;base64,${"A".repeat(100)}`,
    1_000,
  );
  expect(binary.truncated).toBe(true);
  expect(binary.text).toContain("二进制内容已省略");
});

test("limitEvents enforces per-turn and per-session caps", () => {
  const events: ParsedEvent[] = Array.from(
    { length: MAX_EVENTS_PER_TURN + 5 },
    (_, seq) => ({
      turnIdx: 0,
      seq,
      kind: "tool",
      name: "bash",
      input: "{}",
      output: "",
    }),
  );
  expect(limitEvents(events)).toHaveLength(MAX_EVENTS_PER_TURN);

  const large: ParsedEvent[] = Array.from(
    { length: MAX_EVENTS_PER_SESSION + 5 },
    (_, seq) => ({
      turnIdx: Math.floor(seq / MAX_EVENTS_PER_TURN) + 1,
      seq,
      kind: "tool",
      name: "bash",
      input: "{}",
      output: "",
    }),
  );
  expect(limitEvents(large)).toHaveLength(MAX_EVENTS_PER_SESSION);
});

test("process events are stored per turn and removed with the session", () => {
  const session: ParsedSession = {
    ...base,
    externalId: "event-session",
    events: [
      {
        turnIdx: 0,
        seq: 0,
        kind: "reasoning",
        output: "thinking",
      },
      {
        turnIdx: 0,
        seq: 1,
        kind: "tool",
        name: "read",
        input: '{"path":"a.ts"}',
        output: "contents",
        meta: "ok",
        truncated: true,
      },
    ],
  };
  writeSession(db, session);

  expect(eventCountsFor(db, "omp:event-session").get(0)).toBe(2);
  const stored = eventsForTurn(db, "omp:event-session", 0);
  expect(stored.map((event) => event.kind)).toEqual(["reasoning", "tool"]);
  expect(stored[1]?.output).toBe("contents");
  expect(stored[1]?.truncated).toBe(1);

  deleteSession(db, "omp", "event-session");
  expect(eventCountsFor(db, "omp:event-session").size).toBe(0);
});
