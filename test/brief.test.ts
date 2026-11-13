import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateBrief,
  generateWeekReport,
  isoWeekKey,
  parseBriefDate,
  parseBriefWeek,
  readBrief,
} from "../src/brief.ts";
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
const earlier = (minute: number) => new Date(2026, 10, 8, 9, minute, 0, 0).getTime();

const MANY_PROMPTS = [
  "第一轮提问：先看看索引结构",
  "第二轮提问：再确认一下 FTS 的配置",
  "第三轮提问：把项目筛选接上",
  "第四轮提问：补一个空状态",
  "第五轮提问：最后跑一遍测试",
];

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

writeSession(
  db,
  {
    ...session(
      "many-prompts",
      "/Users/odin/projects/many-prompts",
      MANY_PROMPTS.map((prompt, index) => ({
        idx: index,
        ts: earlier(index),
        userText: prompt,
        assistantText: `回答 ${index + 1}`,
      })),
      earlier(MANY_PROMPTS.length),
    ),
    title: "多轮提问",
  },
);

test("generates a daily brief grouped by project", () => {
  const outDir = join(dir, "brief");
  const result = generateBrief(db, "2026-11-10", { format: "archive", outDir });
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

test("links sessions through the app's own scheme, never a port-bound url", () => {
  const markdown = generateBrief(db, "2026-11-10", { format: "archive", outDir: join(dir, "brief-links") }).markdown;
  expect(markdown).toContain(
    "[在 session-recall 打开](sessionrecall://session/omp%3A2026-11-10T09-00-00Z_01a1c36e-f580-7210-bab7-e3f4f99b1031)",
  );
  expect(markdown).toContain(
    "[在 session-recall 打开](sessionrecall://session/opencode%3Ases_test123)",
  );
  expect(markdown).toContain(
    "[在 session-recall 打开](sessionrecall://session/cursor%3Acursor-session)",
  );
  // The old absolute link died on the next launch, so nothing emits one now.
  expect(markdown).not.toContain("http://127.0.0.1");
  expect(markdown).not.toContain("/#/session/");
});

test("lists every prompt of a session with more than three", () => {
  const result = generateBrief(db, "2026-11-08", { format: "archive", outDir: join(dir, "brief-many-prompts") });
  expect(result.sessions).toBe(1);
  expect(result.turns).toBe(MANY_PROMPTS.length);

  const markdown = result.markdown;
  expect(markdown).toContain("### 多轮提问");
  for (const prompt of MANY_PROMPTS) {
    expect(markdown).toContain(`- ${prompt}`);
  }
  // No cap and no fallback line: one bullet per prompt, nothing else.
  expect(markdown.split("\n").filter((line) => line.startsWith("- ")).length).toBe(
    MANY_PROMPTS.length,
  );
  expect(markdown).not.toContain("未列出");
});

test("keeps prior-day sessions out of the overview", () => {
  const result = generateBrief(db, "2026-11-09", { format: "archive", outDir: join(dir, "brief-prev") });
  expect(result.sessions).toBe(1);
  expect(result.markdown).toContain("昨天的会话");
  expect(result.markdown).not.toContain("修复批量附件删除逻辑");
});

// ---- report views (standup / weekly) ----

const day11 = (hour: number) =>
  new Date(2026, 10, 11, hour, 0, 0, 0).getTime();
const day12 = (hour: number) =>
  new Date(2026, 10, 12, hour, 0, 0, 0).getTime();

writeSession(db, {
  ...session(
    "cross-day",
    "/Users/odin/projects/session-recall",
    [
      {
        idx: 0,
        ts: day11(10),
        userText: "开始重构报告层",
        assistantText: "已完成第一版。",
      },
      {
        idx: 1,
        ts: day12(9),
        userText: "继续收尾",
        assistantText:
          "已完成收尾。\n- [ ] 补深链 turn 定位\n下一步：跑完整测试\n风险：Codex 无本机数据\n<!-- decision: 周报从 DB 聚合 -->",
      },
    ],
    day12(9),
  ),
  agent: "claude-code",
  title: "跨天报告会话",
});

test("standup carries YAML front-matter and the four movable sections", () => {
  const result = generateBrief(db, "2026-11-10", {
    format: "standup",
    outDir: join(dir, "standup"),
  });
  expect(result.format).toBe("standup");
  expect(result.path).toBe(join(dir, "standup", "daily", "2026-11-10.md"));
  expect(result.sessions).toBe(3);
  expect(result.turns).toBe(4);

  const markdown = result.markdown;
  expect(markdown.startsWith("---\nkind: daily\nlang: zh\ndate: 2026-11-10\n")).toBe(true);
  expect(markdown).toContain("projects: 3");
  expect(markdown).toContain("sessions: 3");
  expect(markdown).toContain("turns: 4");
  expect(markdown).toContain("agents: [omp, opencode, cursor]");
  expect(markdown).toMatch(/generated_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  expect(markdown).toContain("# 日报 · 2026年11月10日 周二");
  expect(markdown).toContain("**一句话**：3 个项目、3 个会话、4 轮问答");
  for (const heading of ["## 进展", "## 决策", "## 待续", "## 明天第一件事", "## 概览"]) {
    expect(markdown).toContain(heading);
  }
  // Standup distills answers; raw prompt lists stay in archive.
  expect(markdown).not.toContain("**提问**");
  expect(markdown).not.toContain("- 修复批量附件删除逻辑");
  expect(markdown).toContain("## 概览");
  expect(markdown).toContain("| fangtai |");
});

test("standup derives pending, decisions and tomorrow's first task", () => {
  const result = generateBrief(db, "2026-11-12", {
    format: "standup",
    outDir: join(dir, "standup-pending"),
  });
  expect(result.markdown).toContain("- [ ] 补深链 turn 定位");
  expect(result.markdown).toContain("- 周报从 DB 聚合");
  expect(result.markdown).toContain("补深链 turn 定位");
  expect(result.markdown).not.toContain("- （没有显式 decision 标记）");
});

test("standup handles a day with no sessions", () => {
  const result = generateBrief(db, "2026-11-07", {
    format: "standup",
    outDir: join(dir, "standup-empty"),
  });
  expect(result.sessions).toBe(0);
  expect(result.markdown).toContain("date: 2026-11-07");
  expect(result.markdown).toContain("sessions: 0");
  expect(result.markdown).toContain("**一句话**：当日没有记录到会话。");
  for (const heading of ["## 进展", "## 决策", "## 待续", "## 明天第一件事", "## 概览"]) {
    expect(result.markdown).toContain(heading);
  }
});

test("archive keeps the legacy path and dump shape", () => {
  const outDir = join(dir, "archive-consistency");
  const result = generateBrief(db, "2026-11-10", { format: "archive", outDir });
  expect(result.format).toBe("archive");
  expect(result.path).toBe(join(outDir, "2026-11-10.md"));
  expect(existsSync(result.path)).toBe(true);
  expect(result.markdown.startsWith("# 工作简报 · 2026年11月10日")).toBe(true);
  expect(result.markdown).not.toContain("kind: daily");
  expect(result.markdown).toContain("## 今日概览");
  expect(result.markdown).toContain("**提问**");
  expect(readBrief({ format: "archive", date: "2026-11-10", outDir })).toBe(
    result.markdown,
  );
});

test("weekly aggregates from the DB by range and attributes a session once", () => {
  expect(isoWeekKey(new Date(2026, 10, 9).getTime())).toBe("2026-W46");
  const week = parseBriefWeek("2026-W46");
  expect(week?.range).toBe("2026-11-09..2026-11-15");

  const result = generateWeekReport(db, "2026-W46", {
    outDir: join(dir, "weekly"),
  });
  expect(result.format).toBe("week");
  expect(result.week).toBe("2026-W46");
  expect(result.range).toBe("2026-11-09..2026-11-15");
  expect(result.sessions).toBe(5);
  expect(result.turns).toBe(7);
  expect(result.projects).toBe(4);
  expect(result.activeDays).toBe(3);
  expect(result.path).toBe(join(dir, "weekly", "weekly", "2026-W46.md"));

  const markdown = result.markdown;
  expect(markdown.startsWith("---\nkind: weekly\nlang: zh\nweek: 2026-W46\n")).toBe(true);
  expect(markdown).toContain("range: 2026-11-09..2026-11-15");
  expect(markdown).toContain("active_days: 3");
  for (const heading of ["## 亮点", "## 按项目", "## 主题与决策", "## 指标", "## 风险 / 阻塞", "## 下周计划"]) {
    expect(markdown).toContain(heading);
  }
  // The cross-day session lands on its last active day exactly once.
  expect(markdown).toContain("| 11-12 | 1 | 2 | 1 |");
  expect(markdown).not.toContain("| 11-11 |");
  expect(markdown).toContain("周报从 DB 聚合");
  expect(markdown).toContain("补深链 turn 定位");
  expect(markdown).toContain("风险：Codex 无本机数据");
});

test("weekly rejects impossible week keys", () => {
  expect(parseBriefWeek("2026-W54")).toBeNull();
  expect(parseBriefWeek("2025-W53")).toBeNull();
  expect(parseBriefWeek("not-a-week")).toBeNull();
  expect(parseBriefWeek("2026-W46")?.key).toBe("2026-W46");
});

test("writes an index of recent daily and weekly reports", () => {
  const outDir = join(dir, "indexed");
  generateBrief(db, "2026-11-10", { format: "standup", outDir });
  generateWeekReport(db, "2026-W46", { outDir });
  const index = readFileSync(join(outDir, "index.md"), "utf8");
  expect(index).toContain("# Briefs");
  expect(index).toContain("[2026-11-10](daily/2026-11-10.md)");
  expect(index).toContain("[2026-W46](weekly/2026-W46.md)");
});

const day16 = (hour: number) => new Date(2026, 10, 16, hour, 0, 0, 0).getTime();

writeSession(db, {
  ...session(
    "noise-01",
    "/Users/odin/projects/noise",
    [
      {
        idx: 0,
        ts: day16(10),
        userText: "收尾",
        assistantText: [
          "我先把无争议的部分删掉（风险项留到最后问你）。",
          "description: 每轮结束输出 3 行摘要（做了什么/改了哪些文件/下一步）",
          "这段里顺带提到下一步，但不是任务。",
          "- [ ] 真正的待办：补一个测试",
          "风险：这是真风险",
        ].join("\n"),
      },
    ],
    day16(10),
  ),
  title: "噪声会话",
});

test("standup ignores mid-sentence and schema noise, keeps real todos", () => {
  const result = generateBrief(db, "2026-11-16", {
    format: "standup",
    outDir: join(dir, "standup-noise"),
  });
  const markdown = result.markdown;
  expect(markdown).toContain("- [ ] 真正的待办：补一个测试");
  expect(markdown).not.toContain("description:");
  expect(markdown).not.toContain("我先把无争议");
  expect(markdown).not.toContain("顺带提到下一步");
});

test("weekly risk extraction ignores passing mentions", () => {
  const result = generateWeekReport(db, "2026-W47", {
    outDir: join(dir, "weekly-noise"),
  });
  const markdown = result.markdown;
  expect(markdown).toContain("风险：这是真风险");
  expect(markdown).not.toContain("我先把无争议");
});
