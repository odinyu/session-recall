
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comparePeriods,
  computePeriodStats,
  generateMonthReport,
  generateWeekReport,
  isoWeekKey,
  parseBriefMonth,
  previousMonthKey,
  previousWeekKey,
  renderRankings,
} from "../src/brief.ts";
import { BRIEF_LABELS, REPORT_LABELS } from "../src/brief-lang.ts";
import { openDb, writeSession } from "../src/db.ts";
import { writeScheduledBrief } from "../src/server.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

/**
 * The 1.8.0 report additions: the monthly format, the period comparisons, the
 * rankings and the once-per-period scheduled write. Everything here is computed
 * from the local index — no network, no LLM.
 */

const dir = mkdtempSync(join(tmpdir(), "session-recall-brief-month-"));
const db = openDb(join(dir, "index.db"));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HAN = /[\u3400-\u9fff\uf900-\ufaff\uff00-\uff60]/;
const ts = (day: number, hour = 9) => new Date(2026, 9, day, hour, 0, 0, 0).getTime();

function session(id: string, project: string, day: number, turns: number, agent: "omp" | "codex" = "omp"): ParsedSession {
  const list = Array.from({ length: turns }, (_, i) => ({
    idx: i,
    ts: ts(day, 9 + (i % 8)),
    userText: "turn " + (i + 1),
    assistantText: "done.",
    model: "test-model",
    truncated: false,
  }));
  return {
    agent,
    externalId: id,
    projectPath: project,
    title: "work on " + project,
    startedAt: list[0]!.ts,
    updatedAt: list[list.length - 1]!.ts,
    sourceKind: "jsonl",
    sourcePath: "/tmp/" + id + ".jsonl",
    fingerprint: "1",
    turns: list,
  };
}

// October 2026: two projects; September: one smaller project.
writeSession(db, session("oct-a", "/tmp/alpha", 6, 4));
writeSession(db, session("oct-b", "/tmp/beta", 7, 2, "codex"));
writeSession(db, session("sep-a", "/tmp/alpha", 15, 1));

test("parseBriefMonth accepts YYYY-MM and rejects impossible months", () => {
  const october = parseBriefMonth("2026-10");
  expect(october?.key).toBe("2026-10");
  expect(october?.range).toBe("2026-10-01..2026-10-31");
  expect(parseBriefMonth("2026-13")).toBeNull();
  expect(parseBriefMonth("2026-00")).toBeNull();
  expect(parseBriefMonth("october")).toBeNull();
});

test("previousMonthKey and previousWeekKey cross the year boundary", () => {
  expect(previousMonthKey("2026-10")).toBe("2026-09");
  expect(previousMonthKey("2026-01")).toBe("2025-12");
  expect(previousWeekKey("2026-W46")).toBe("2026-W45");
});

test("the monthly report carries the month sections and no Han characters in English", () => {
  const result = generateMonthReport(db, "2026-10", { outDir: join(dir, "monthly-en"), lang: "en" });
  const markdown = result.markdown;
  expect(result.format).toBe("month");
  expect(markdown).toContain("# Monthly · 2026-10");
  expect(markdown).toContain("## Overview");
  expect(markdown).toContain("### Compared with last month (2026-09)");
  expect(HAN.test(markdown)).toBe(false);
  expect(existsSync(join(dir, "monthly-en", "monthly", "2026-10.md"))).toBe(true);
});

test("comparisons report real deltas and never invent them without a previous period", () => {
  const labels = BRIEF_LABELS.en;
  const sessions = [session("x", "/tmp/alpha", 6, 3)];
  const withPrevious = comparePeriods(sessions, [session("y", "/tmp/alpha", 15, 1)], labels);
  const rows = withPrevious.rows.filter((row) => row.metric === "sessions" || row.metric === "turns");
  expect(rows.every((row) => row.delta === row.current - row.previous)).toBe(true);

  const withoutPrevious = comparePeriods(sessions, [], labels);
  expect(REPORT_LABELS.en.noPreviousData).toBeTruthy();
  expect(withoutPrevious.rows.every((row) => row.previous === 0 && row.delta === row.current)).toBe(true);
});

test("rankings order projects by turns and agents by sessions", () => {
  const sessions = [
    session("r1", "/tmp/alpha", 6, 5),
    session("r2", "/tmp/beta", 6, 2, "codex"),
  ];
  const stats = computePeriodStats(sessions, BRIEF_LABELS.en);
  const ranked = Object.entries(stats.projectTurns).sort((a, b) => b[1] - a[1]);
  expect(ranked[0]?.[0]).toBe("alpha");
  expect(ranked[0]?.[1]).toBe(5);
  expect(stats.agents["Codex"]).toBe(1);
  expect(stats.agents["omp"]).toBe(1);

  const section = renderRankings(sessions, BRIEF_LABELS.en, REPORT_LABELS.en);
  expect(section).toContain("## Rankings");
  expect(section).toContain("alpha: 5 turns");
  expect(HAN.test(section)).toBe(false);
});

test("the scheduled write runs once per period per day", () => {
  const out = join(dir, "scheduled");
  const oct8 = new Date(2026, 9, 8, 12, 0, 0, 0);
  const first = writeScheduledBrief(db, "daily", oct8, null, out);
  expect(first.wrote).toBe(true);
  const again = writeScheduledBrief(db, "daily", oct8, first.marker, out);
  expect(again.wrote).toBe(false);
  const nextDay = writeScheduledBrief(db, "daily", new Date(2026, 9, 9, 12), first.marker, out);
  expect(nextDay.wrote).toBe(true);
  // The daily digest is the archive format, which keeps the legacy root path.
  expect(existsSync(join(out, "2026-10-09.md"))).toBe(true);
  const weekly = writeScheduledBrief(db, "weekly", oct8, nextDay.marker, out);
  expect(weekly.wrote).toBe(true);
  const weekKey = isoWeekKey(new Date(2026, 9, 8, 12).getTime());
  expect(existsSync(join(out, "weekly", weekKey + ".md"))).toBe(true);
  expect(readFileSync(join(out, "2026-10-08.md"), "utf8").length).toBeGreaterThan(0);
});
