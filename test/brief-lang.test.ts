import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBrief, generateWeekReport } from "../src/brief.ts";
import type { BriefLang } from "../src/brief.ts";
import { openDb, writeSession } from "../src/db.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

/**
 * One report template per interface language. Session content stays verbatim,
 * so an English report over English sessions must contain no Han characters at
 * all; the Chinese default must keep producing the original wording.
 */

const dir = mkdtempSync(join(tmpdir(), "session-recall-brief-lang-"));
const db = openDb(join(dir, "index.db"));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HAN = /[㐀-鿿豈-﫿＀-｠]/;
const ZH_PUNCT = /[：、（）「」]/;

const ts = (hour: number) => new Date(2026, 10, 10, hour, 0, 0, 0).getTime();

function session(
  externalId: string,
  projectPath: string,
  turns: ParsedSession["turns"],
): ParsedSession {
  return {
    agent: "omp",
    externalId,
    projectPath,
    title: "add offline cache",
    startedAt: turns[0]?.ts ?? ts(9),
    updatedAt: turns[turns.length - 1]?.ts ?? ts(10),
    sourceKind: "jsonl",
    sourcePath: `/tmp/${externalId}.jsonl`,
    fingerprint: "1",
    turns,
  };
}

writeSession(
  db,
  session("lang-fixture-1", "/tmp/demo-app", [
    {
      idx: 0,
      ts: ts(9),
      userText: "add offline cache to the demo app",
      assistantText: "Done.",
      model: "test-model",
      truncated: false,
    },
    {
      // Derivation reads each session's *last* assistant message, so the
      // markers live here.
      idx: 1,
      ts: ts(10),
      userText: "check the paging boundary",
      assistantText: [
        "Fixed the page=0 boundary.",
        "blocked: sync conflict policy is undecided",
        "- [ ] write docs",
        "Next step: run the replay test",
        "<!-- decision: keep only seven days of cache -->",
      ].join("\n"),
      model: "test-model",
      truncated: false,
    },
  ]),
);

const standup = (lang?: BriefLang, out = join(dir, `standup-${lang ?? "default"}`)) =>
  generateBrief(db, "2026-11-10", { format: "standup", outDir: out, lang });

const weekly = (lang?: BriefLang, out = join(dir, `weekly-${lang ?? "default"}`)) =>
  generateWeekReport(db, "2026-W46", { outDir: out, lang });

test("the English standup uses English structure and no Han characters", () => {
  const markdown = standup("en").markdown;
  expect(markdown.startsWith("---\nkind: daily\nlang: en\ndate: 2026-11-10\n")).toBe(true);
  expect(markdown).toContain("# Daily · Tue, Nov 10, 2026");
  expect(markdown).toContain("**One line**: 1 project, 1 session, 2 turns");
  for (const heading of [
    "## Progress",
    "## Decisions",
    "## Open threads",
    "## First task tomorrow",
    "## Overview",
  ]) {
    expect(markdown).toContain(heading);
  }
  expect(markdown).toContain("| Project | Sessions | Turns | Agent |");
  expect(markdown).toContain("- **add offline cache** (2 turns)");
  expect(HAN.test(markdown)).toBe(false);
  expect(ZH_PUNCT.test(markdown)).toBe(false);
});

test("the English weekly uses English structure and no Han characters", () => {
  const markdown = weekly("en").markdown;
  expect(markdown.startsWith("---\nkind: weekly\nlang: en\nweek: 2026-W46\n")).toBe(true);
  expect(markdown).toContain("# Weekly · 2026-W46 · 11/09–11/15");
  expect(markdown).toContain("**This week in one line**:");
  for (const heading of [
    "## Highlights",
    "## By project",
    "## Themes and decisions",
    "## Metrics",
    "## Risks",
    "## Next week",
  ]) {
    expect(markdown).toContain(heading);
  }
  expect(markdown).toContain("| Date | Sessions | Turns | Active projects |");
  expect(markdown).toContain("- Done:");
  expect(HAN.test(markdown)).toBe(false);
  expect(ZH_PUNCT.test(markdown)).toBe(false);
});

test("the default template is still the original Chinese one", () => {
  const omitted = standup().markdown;
  const explicit = standup("zh").markdown;
  expect(explicit.startsWith("---\nkind: daily\nlang: zh\ndate: 2026-11-10\n")).toBe(true);
  expect(explicit).toContain("# 日报 · 2026年11月10日 周二");
  expect(explicit).toContain("**一句话**：1 个项目、1 个会话、2 轮问答");
  for (const heading of ["## 进展", "## 决策", "## 待续", "## 明天第一件事", "## 概览"]) {
    expect(explicit).toContain(heading);
  }
  expect(explicit).toContain("| 项目 | 会话 | 问答 | Agent |");
  // Omitting `lang` keeps the Chinese template, the pre-existing behaviour.
  expect(omitted.replace(/generated_at: .*/, "")).toBe(
    explicit.replace(/generated_at: .*/, ""),
  );
  expect(weekly().markdown).toContain("# 周报 · 2026-W46（11-09 ~ 11-15）");
  expect(weekly().markdown).toContain("## 风险 / 阻塞");
});

test("both templates extract the same pending items and risks", () => {
  const zh = standup("zh").markdown;
  const en = standup("en").markdown;
  for (const markdown of [zh, en]) {
    expect(markdown).toContain("- [ ] write docs");
    expect(markdown).toContain("- [ ] Next step: run the replay test");
  }
  const zhWeek = weekly("zh").markdown;
  const enWeek = weekly("en").markdown;
  for (const markdown of [zhWeek, enWeek]) {
    expect(markdown).toContain("blocked: sync conflict policy is undecided");
  }
});

test("a language outside zh/en is rejected", () => {
  expect(() => standup("fr" as BriefLang)).toThrow("invalid language: fr");
  expect(() => weekly("fr" as BriefLang)).toThrow("invalid language: fr");
});

test("the shared brief index uses language-neutral group headings", () => {
  standup("zh", join(dir, "indexed"));
  weekly("en", join(dir, "indexed"));
  const index = readFileSync(join(dir, "indexed", "index.md"), "utf8");
  expect(index).toContain("## Daily");
  expect(index).toContain("## Weekly");
  expect(HAN.test(index)).toBe(false);
});

function runBriefCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "brief", ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    code: proc.exitCode ?? -1,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

test("CLI parsing accepts --lang en", () => {
  // `--help` stops before scanning or writing anything, but only after the
  // language option has been accepted.
  for (const args of [["--lang", "en", "--help"], ["--lang=en", "--help"]]) {
    const result = runBriefCli(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[--lang zh|en]");
  }
});

test("CLI parsing rejects an unknown language", () => {
  const result = runBriefCli(["--lang", "fr"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('invalid --lang "fr": expected zh or en');
  expect(result.stderr).toContain("run with --help for usage.");
});
