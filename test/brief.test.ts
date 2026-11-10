import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBrief, parseBriefDate } from "../src/brief.ts";
import { openDb, writeSession } from "../src/db.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-brief-"));
const db = openDb(join(dir, "index.db"));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(
  externalId: string,
  projectPath: string,
  turns: ParsedSession["turns"],
  updatedAt: number,
): ParsedSession {
  return {
    agent: "omp",
    externalId,
    projectPath,
    title: `Session ${externalId}`,
    startedAt: turns[0]?.ts || updatedAt,
    updatedAt,
    sourceKind: "jsonl",
    sourcePath: `/tmp/${externalId}.jsonl`,
    fingerprint: "1",
    turns,
  };
}

const day = (hour: number) => new Date(2026, 10, 10, hour, 0, 0, 0).getTime();
const previous = new Date(2026, 10, 9, 11, 0, 0, 0).getTime();

writeSession(
  db,
  {
    ...session(
      "2026-11-10T09-00-00Z_01a1c36e-f580-7210-bab7-e3f4f99b1031",
      "/Users/odin/projects/fangtai",
      [
        {
          idx: 0,
          ts: day(9),
          userText: "修复批量附件删除逻辑",
          assistantText: "已修复旧附件删除逻辑，并补充了回归测试。",
        },
        {
          idx: 1,
          ts: day(10),
          userText: "再检查一下接口兼容性",
          assistantText: "接口保持不变，测试通过。",
        },
      ],
      day(10),
    ),
    title: "批量附件删除",
    events: [
      {
        turnIdx: 0,
        seq: 0,
        kind: "tool",
        name: "bash",
        input: '{"command":"bun test"}',
        output: "13 pass",
      },
    ],
  },
);

writeSession(
  db,
  {
    ...session(
      "ses_test123",
      "/Users/odin/projects/ibot12",
      [
        {
          idx: 0,
          ts: day(11),
          userText: "合并机器人场景代码",
          assistantText: "已完成合并，保留原有接口。",
        },
      ],
      day(11),
    ),
    agent: "opencode",
    title: "合并机器人代码",
  },
);

writeSession(
  db,
  {
    ...session(
      "old-session",
      "/Users/odin/projects/fangtai",
      [
        {
          idx: 0,
          ts: previous,
          userText: "旧的提问",
          assistantText: "旧回答",
        },
      ],
      previous,
    ),
    title: "昨天的会话",
  },
);

writeSession(
  db,
  {
    ...session(
      "cursor-session",
      "/Users/odin/projects/cursor-ppt",
      [
        {
          idx: 0,
          ts: 0,
          userText: "调整 PPT 布局",
          assistantText: "已调整标题与正文间距。",
        },
      ],
      day(15),
    ),
    agent: "cursor",
    sourceKind: "jsonl",
    title: "PPT 布局",
  },
);

test("parses local dates and rejects impossible dates", () => {
  expect(parseBriefDate("2026-11-10")?.key).toBe("2026-11-10");
  expect(parseBriefDate("2026-11-31")).toBeNull();
  expect(parseBriefDate("nope")).toBeNull();
});

test("generates a daily brief grouped by project", () => {
  const outDir = join(dir, "brief");
  const result = generateBrief(db, "2026-11-10", outDir);
  expect(result.sessions).toBe(3);
  expect(result.turns).toBe(4);
  expect(result.path).toBe(join(outDir, "2026-11-10.md"));
  expect(existsSync(result.path)).toBe(true);

  const markdown = readFileSync(result.path, "utf8");
  expect(markdown).toContain("# 工作简报 · 2026年11月10日");
  expect(markdown).toContain("## fangtai");
  expect(markdown).toContain("## ibot12");
  expect(markdown).toContain("## cursor-ppt");
  expect(markdown).toContain("修复批量附件删除逻辑");
  expect(markdown).toContain("omp --resume 01a1c36e-f580-7210-bab7-e3f4f99b1031");
  expect(markdown).toContain("opencode --session ses_test123");
  expect(markdown).toContain("工具 1");
  expect(markdown).toContain("最近 1 轮");
  expect(markdown).not.toContain("结果摘录");
  expect(markdown).not.toContain("昨天的会话");
});

test("keeps prior-day sessions out of the overview", () => {
  const result = generateBrief(db, "2026-11-09", join(dir, "brief-prev"));
  expect(result.sessions).toBe(1);
  expect(result.markdown).toContain("昨天的会话");
  expect(result.markdown).not.toContain("修复批量附件删除逻辑");
});
