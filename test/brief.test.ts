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

test("links sessions through the app's own scheme, never a port-bound url", () => {
  const markdown = generateBrief(db, "2026-11-10", join(dir, "brief-links")).markdown;
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
  const result = generateBrief(db, "2026-11-08", join(dir, "brief-many-prompts"));
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
  const result = generateBrief(db, "2026-11-09", join(dir, "brief-prev"));
  expect(result.sessions).toBe(1);
  expect(result.markdown).toContain("昨天的会话");
  expect(result.markdown).not.toContain("修复批量附件删除逻辑");
});
