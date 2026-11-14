import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setMeta, setSessionFlag, writeSession } from "../src/db.ts";
import {
  handleRpcMessage,
  recallFacets,
  recallHandoff,
  recallScan,
  recallSearch,
  recallSession,
  TOOLS,
} from "../src/mcp.ts";
import type { McpContext, ToolCallResult } from "../src/mcp.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-mcp-"));
const dbPath = join(dir, "index.db");
const db = openDb(dbPath);

const first: ParsedSession = {
  agent: "omp",
  externalId: "mcp-a",
  projectPath: "/Users/test/mcp-a",
  title: "MCP 检索 A",
  startedAt: Date.UTC(2026, 10, 11, 4),
  updatedAt: Date.UTC(2026, 10, 11, 5),
  sourceKind: "jsonl",
  sourcePath: "/tmp/mcp-a.jsonl",
  fingerprint: "1",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 10, 11, 4),
      userText: "mcp 会话里 tvbox 安装失败",
      assistantText: "先看 brew 日志，再重装",
    },
    {
      idx: 1,
      ts: Date.UTC(2026, 10, 11, 5),
      userText: "再试一次 mcp 检索",
      assistantText: "这次通过了，链接已生成",
    },
  ],
};

const second: ParsedSession = {
  agent: "opencode",
  externalId: "mcp-b",
  projectPath: "/Users/test/mcp-b",
  title: "MCP 检索 B",
  startedAt: Date.UTC(2026, 10, 10, 4),
  updatedAt: Date.UTC(2026, 10, 10, 5),
  sourceKind: "jsonl",
  sourcePath: "/tmp/mcp-b.jsonl",
  fingerprint: "1",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 10, 10, 4),
      userText: "mcp 结果里怎么带 deep link",
      assistantText: "用 sessionrecall 协议",
    },
  ],
};

writeSession(db, first);
writeSession(db, second);
// Nothing is hidden, so every existing expectation above still sees both.
setSessionFlag(db, "opencode", "mcp-b", "starred", true);
setMeta(db, "last_scan_ms", String(Date.now()));
db.close();

const ctx: McpContext = {
  dbPath,
  maxAgeMs: 5 * 60 * 1000,
  staleLockMs: 10 * 60 * 1000,
  scanLockTimeoutMs: 1_000,
  // Never let a tool call touch the host's real agent stores.
  adapters: [],
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function payload(result: ToolCallResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("recall_search returns compact, linked results", () => {
  const data = payload(recallSearch(ctx, { query: "mcp", limit: 2 }));
  expect(data.scope).toBe("qa");
  expect(data.refresh).toBe("fresh");
  expect(typeof data.indexAgeMs).toBe("number");
  expect(data.totalSessions).toBe(2);
  expect(data.returned).toBe(2);

  const results = data.results as Record<string, unknown>[];
  expect(results[0]?.sessionId).toBe("omp:mcp-a");
  const hit = results[0] as Record<string, unknown>;
  expect(hit.agent).toBe("omp");
  expect(hit.project).toBe("/Users/test/mcp-a");
  expect(hit.title).toBe("MCP 检索 A");
  expect(String(hit.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof hit.turn).toBe("number");
  expect(String(hit.deepLink)).toMatch(/^sessionrecall:\/\/session\/.+[?]turn=\d+$/);
  expect(String(hit.question).length).toBeGreaterThan(0);
  expect(String(hit.answer).length).toBeGreaterThan(0);
});

test("recall_search validates arguments", () => {
  expect(recallSearch(ctx, {}).isError).toBe(true);
  expect(recallSearch(ctx, { query: "mcp", agent: "nope" }).isError).toBe(true);
  expect(recallSearch(ctx, { query: "mcp", scope: "wat" }).isError).toBe(true);
  expect(recallSearch(ctx, { query: "mcp", limit: 0 }).isError).toBe(true);
});

test("recall_search reports an empty result without erroring", () => {
  const data = payload(recallSearch(ctx, { query: "zz-not-indexed" }));
  expect(data.totalSessions).toBe(0);
  expect(data.returned).toBe(0);
  expect(data.results).toEqual([]);
});

test("recall_search filters by starred and only marks starred hits", () => {
  const starred = payload(recallSearch(ctx, { query: "mcp", starred: true }));
  expect(starred.totalSessions).toBe(1);
  const results = starred.results as Record<string, unknown>[];
  expect(results.map((row) => row.sessionId)).toEqual(["opencode:mcp-b"]);
  expect(results[0]?.starred).toBe(true);

  const plain = payload(recallSearch(ctx, { query: "mcp", limit: 2 }));
  const firstHit = (plain.results as Record<string, unknown>[])[0];
  // Unstarred hits stay compact: no `starred: false` in the payload.
  expect(firstHit).not.toHaveProperty("starred");
});

test("recall_search accepts includeHidden and rejects non-boolean flags", () => {
  const data = payload(recallSearch(ctx, { query: "mcp", includeHidden: true }));
  expect(data.returned).toBe(2);
  expect(recallSearch(ctx, { query: "mcp", starred: "yes" }).isError).toBe(true);
  expect(recallSearch(ctx, { query: "mcp", includeHidden: 1 }).isError).toBe(true);
});

test("recall_search advertises the organization filters in its schema", () => {
  const tool = TOOLS.find((entry) => entry.name === "recall_search");
  const properties = tool?.inputSchema.properties as Record<string, { type: string }>;
  expect(properties.starred?.type).toBe("boolean");
  expect(properties.includeHidden?.type).toBe("boolean");
});

test("recall_search hiddenOnly returns only hidden sessions and rejects conflicts", () => {
  const hiddenDir = mkdtempSync(join(tmpdir(), "session-recall-mcp-hidden-"));
  try {
    // A mixed index: one hidden session among three.
    const hiddenPath = join(hiddenDir, "index.db");
    const hiddenDb = openDb(hiddenPath);
    for (const externalId of ["hidden-a", "hidden-b", "hidden-c"]) {
      writeSession(hiddenDb, {
        ...first,
        agent: "omp",
        externalId,
        title: `MCP hidden ${externalId}`,
        sourcePath: `/tmp/${externalId}.jsonl`,
        turns: [
          {
            idx: 0,
            ts: first.startedAt,
            userText: `mcp hidden marker ${externalId}`,
            assistantText: "ok",
          },
        ],
      });
    }
    setSessionFlag(hiddenDb, "omp", "hidden-a", "hidden", true);
    setMeta(hiddenDb, "last_scan_ms", String(Date.now()));
    hiddenDb.close();

    const hiddenCtx: McpContext = {
      dbPath: hiddenPath,
      maxAgeMs: 5 * 60 * 1000,
      staleLockMs: 10 * 60 * 1000,
      scanLockTimeoutMs: 1_000,
      adapters: [],
    };
    const data = payload(recallSearch(hiddenCtx, { query: "mcp", hiddenOnly: true }));
    expect(data.totalSessions).toBe(1);
    expect(
      (data.results as { sessionId: string }[]).map((row) => row.sessionId),
    ).toEqual(["omp:hidden-a"]);

    // Conflicts are argument errors before any index is opened.
    const starred = recallSearch(ctx, { query: "mcp", hiddenOnly: true, starred: true });
    expect(starred.isError).toBe(true);
    expect(starred.content[0]?.text).toContain("hiddenOnly cannot be combined");
    expect(
      recallSearch(ctx, { query: "mcp", hiddenOnly: true, includeHidden: true }).isError,
    ).toBe(true);
  } finally {
    rmSync(hiddenDir, { recursive: true, force: true });
  }
});

test("recall_session returns the whole session or one turn", () => {
  const whole = payload(recallSession(ctx, { sessionId: "omp:mcp-a" }));
  const turns = whole.turns as Record<string, unknown>[];
  expect(turns).toHaveLength(2);
  expect(turns[0]?.idx).toBe(0);
  expect(whole.totalTurns).toBe(2);
  expect(whole.truncated).toBe(false);
  const session = whole.session as Record<string, unknown>;
  expect(session.sessionId).toBe("omp:mcp-a");
  expect(session.agent).toBe("omp");
  expect(String(session.deepLink)).toBe("sessionrecall://session/omp%3Amcp-a");

  const one = payload(recallSession(ctx, { sessionId: "omp:mcp-a", turn: 1 }));
  const only = one.turns as Record<string, unknown>[];
  const oneSession = one.session as Record<string, unknown>;
  expect(one.returnedTurns).toBe(1);
  expect(only[0]?.idx).toBe(1);
  expect(String(only[0]?.assistant)).toContain("这次通过了");
  expect(String(oneSession.deepLink)).toMatch(/[?]turn=1$/);
});

test("recall_session errors on an unknown session or turn", () => {
  expect(recallSession(ctx, { sessionId: "omp:nope" }).isError).toBe(true);
  const missingTurn = recallSession(ctx, { sessionId: "omp:mcp-a", turn: 9 });
  expect(missingTurn.isError).toBe(true);
  expect(missingTurn.content[0]?.text).toContain("no turn 9");
});

test("recall_facets lists agents and projects with counts", () => {
  const data = payload(recallFacets(ctx, {}));
  expect(typeof data.indexAgeMs).toBe("number");
  expect(data.projectCount).toBe(2);
  expect(data.starredCount).toBe(1);
  expect(data.hiddenCount).toBe(0);
  const agents = data.agents as { id: string; sessions: number }[];
  expect(agents.find((row) => row.id === "omp")?.sessions).toBe(1);
  expect(agents.find((row) => row.id === "opencode")?.sessions).toBe(1);
  const projects = data.projects as { path: string }[];
  expect(projects.map((row) => row.path).sort()).toEqual([
    "/Users/test/mcp-a",
    "/Users/test/mcp-b",
  ]);
});

test("recall_handoff renders a Markdown card", () => {
  const card = recallHandoff(ctx, { sessionId: "omp:mcp-a" });
  expect(card.isError).toBeFalsy();
  const text = card.content[0]?.text ?? "";
  expect(text.startsWith("# 交接：")).toBe(true);
  expect(text).toContain("/Users/test/mcp-a");
  expect(text).toContain("## 最近提问");

  expect(recallHandoff(ctx, { sessionId: "omp:nope" }).isError).toBe(true);
});

test("recall_handoff targets another agent when asked", () => {
  const card = recallHandoff(ctx, { sessionId: "omp:mcp-a", targetAgent: "claude-code" });
  expect(card.isError).toBeFalsy();
  const text = card.content[0]?.text ?? "";
  expect(text).toContain("## 在 Claude Code 中继续");
  expect(text).toContain("claude");
  expect(text).toContain("新开一个会话");

  const sameAgent = recallHandoff(ctx, { sessionId: "omp:mcp-a" });
  expect(sameAgent.content[0]?.text).toContain("omp --resume mcp-a");

  const invalid = recallHandoff(ctx, { sessionId: "omp:mcp-a", targetAgent: "nope" });
  expect(invalid.isError).toBe(true);
  expect(invalid.content[0]?.text).toContain("unknown targetAgent");
});

test("recall_scan refreshes and reports stats", async () => {
  const data = payload(await recallScan(ctx));
  expect(data.scanned).toBe(true);
  expect(data.skipped).toBeNull();
  expect(data.sessions).toBe(2);
  expect(data.turns).toBe(3);
  expect(data.errors).toBe(0);
  expect(Number(data.indexAgeMs)).toBeLessThan(5_000);
});

test("JSON-RPC: initialize, tools/list and tools/call", async () => {
  const init = await handleRpcMessage(ctx, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const initResult = init?.result as {
    protocolVersion: string;
    serverInfo: { name: string };
  };
  expect(initResult.protocolVersion).toBe("2025-06-18");
  expect(initResult.serverInfo.name).toBe("session-recall");

  const initialized = await handleRpcMessage(ctx, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  expect(initialized).toBeNull();

  const list = await handleRpcMessage(ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listResult = list?.result as { tools: { name: string }[] };
  const tools = listResult.tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "recall_search",
    "recall_session",
    "recall_facets",
    "recall_handoff",
    "recall_scan",
  ]);

  const call = await handleRpcMessage(ctx, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "recall_search", arguments: { query: "mcp", limit: 1 } },
  });
  const result = call?.result as { content: { text: string }[] };
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { returned: number };
  expect(parsed.returned).toBe(1);

  const unknown = await handleRpcMessage(ctx, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "nope" },
  });
  expect(unknown?.error?.code).toBe(-32602);
});
