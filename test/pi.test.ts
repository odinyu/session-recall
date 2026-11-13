import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piAdapter } from "../src/adapters/omp.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";
import { titlePrompt } from "../src/util/values.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-pi-"));
const sessions = join(root, "sessions");
mkdirSync(sessions, { recursive: true });

const id = "01a1ce53-fc62-7119-9617-c0e0001a45e6";
const file = join(sessions, `2026-11-12T05-56-13-027Z_${id}.jsonl`);

function line(value: unknown): string {
  return JSON.stringify(value);
}

writeFileSync(
  file,
  [
    line({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-11-12T05:56:13.027Z",
      cwd: "/Users/test/pi-worktree",
    }),
    line({
      type: "message",
      timestamp: "2026-11-12T05:56:14.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "修一下 pi 的深链" }],
      },
    }),
    line({
      type: "message",
      timestamp: "2026-11-12T05:56:15.000Z",
      message: {
        role: "assistant",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "先看路由" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rg pi" } },
          { type: "text", text: "改好了" },
        ],
      },
    }),
    line({
      type: "message",
      timestamp: "2026-11-12T05:56:16.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "web/app.ts" }],
        isError: false,
      },
    }),
  ].join("\n") + "\n",
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("lists flat pi session files", async () => {
  const refs = await piAdapter([sessions]).list();
  expect(refs).toHaveLength(1);
  expect(refs[0]!.agent).toBe("pi");
  expect(refs[0]!.externalId).toBe(`2026-11-12T05-56-13-027Z_${id}`);
});

test("parses pi turns and tool calls", async () => {
  const adapter = piAdapter([sessions]);
  const session = await adapter.load((await adapter.list())[0]!);

  expect(session).not.toBeNull();
  expect(session!.agent).toBe("pi");
  expect(session!.projectPath).toBe("/Users/test/pi-worktree");
  expect(session!.turns).toHaveLength(1);
  expect(session!.turns[0]!.userText).toBe("修一下 pi 的深链");
  expect(session!.turns[0]!.assistantText).toBe("改好了");
  expect(session!.turns[0]!.model).toBe("test-model");

  const events = session!.events ?? [];
  expect(events.map((event) => event.kind)).toEqual(["reasoning", "tool"]);
  expect(events[1]!.name).toBe("bash");
  expect(events[1]!.output).toBe("web/app.ts");
});

test("pi sessions reach the search index", async () => {
  const dir = mkdtempSync(join(root, "index-"));
  const db = openDb(join(dir, "index.db"));
  const report = await scan(db, [piAdapter([sessions])]);

  expect(report.agents.pi?.refs).toBe(1);
  expect(report.sessions).toBe(1);

  const found = searchTurns(db, {
    q: "深链",
    agents: [],
    project: "",
    from: null,
    to: null,
    role: "all",
    scope: "qa",
    limit: 20,
    offset: 0,
  });
  expect(found.sessions.map((session) => session.agent)).toEqual(["pi"]);
  db.close();
});

test("skips injected prompts and the Orca lead prefix in titles", () => {
  expect(
    titlePrompt([
      { userText: "[系统] Orca Worker 已就绪，当前没有待执行任务。" },
      { userText: "[From Orca Lead]\n任务：修深链上下文" },
    ]),
  ).toBe("任务：修深链上下文");
  expect(
    titlePrompt([
      { userText: "<environment_context>\n<cwd>/tmp</cwd>" },
      { userText: "[UI language] System note" },
      { userText: "真正的问题" },
    ]),
  ).toBe("真正的问题");
});
