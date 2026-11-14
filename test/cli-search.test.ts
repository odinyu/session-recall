import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDateKey } from "../src/brief.ts";
import { openDb, setSessionFlag, writeSession } from "../src/db.ts";
import { USAGE } from "../src/cli-search.ts";
import type { ParsedSession } from "../src/adapters/types.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-cli-"));
const dbPath = join(dir, "index.db");
const root = join(import.meta.dir, "..");

const db = openDb(dbPath);

const older: ParsedSession = {
  agent: "omp",
  externalId: "tvbox-one",
  projectPath: "/Users/test/tvbox",
  title: "tvbox 安装",
  startedAt: Date.UTC(2026, 10, 10, 4),
  updatedAt: Date.UTC(2026, 10, 10, 5),
  sourceKind: "jsonl",
  sourcePath: "/tmp/tvbox-one.jsonl",
  fingerprint: "1",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 10, 10, 4),
      userText: "tvbox 安装失败怎么排查",
      assistantText: "先看 brew 日志，再重装 com.apple.tvbox",
    },
  ],
};

const newer: ParsedSession = {
  ...older,
  agent: "opencode",
  externalId: "tvbox-two",
  projectPath: "/Users/test/player",
  title: "tvbox websocket",
  startedAt: Date.UTC(2026, 10, 11, 4),
  updatedAt: Date.UTC(2026, 10, 11, 5),
  sourcePath: "/tmp/tvbox-two.jsonl",
  turns: [
    {
      idx: 0,
      ts: Date.UTC(2026, 10, 11, 4),
      userText: "tvbox 的 websocket 又断了",
      assistantText: "加 exponential backoff 重连",
    },
  ],
};

writeSession(db, older);
writeSession(db, newer);
// Starred only; nothing is hidden, so the unflagged assertions above still hold.
setSessionFlag(db, "omp", "tvbox-one", "starred", true);
db.close();

/**
 * A separate index for the hidden/starred flags: hiding a session changes what
 * the shared fixture above returns, so this lives in its own database.
 */
const flagsPath = join(dir, "flags.db");
const flagsDb = openDb(flagsPath);
function flagSession(externalId: string, userText: string): ParsedSession {
  return {
    ...older,
    externalId,
    title: externalId,
    sourcePath: `/tmp/${externalId}.jsonl`,
    turns: [{ idx: 0, ts: older.startedAt, userText, assistantText: "ok" }],
  };
}
writeSession(flagsDb, flagSession("visible-flag", "hiddenmarker visible"));
writeSession(flagsDb, flagSession("hidden-flag", "hiddenmarker shielded"));
setSessionFlag(flagsDb, "omp", "hidden-flag", "hidden", true);
setSessionFlag(flagsDb, "omp", "hidden-flag", "starred", true);
flagsDb.close();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", "search", ...args],
    cwd: root,
    env: { ...process.env, SESSION_RECALL_DB: dbPath, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("prints question/answer pairs with session metadata", () => {
  const out = run(["tvbox"]);
  expect(out.code).toBe(0);
  expect(out.stdout).toContain("opencode:tvbox-two");
  expect(out.stdout).toContain("[opencode]");
  expect(out.stdout).toContain("/Users/test/player");
  expect(out.stdout).toContain(localDateKey(new Date(newer.updatedAt)));
  expect(out.stdout).toContain("websocket");
  expect(out.stdout).toContain("exponential backoff");
});

test("--json emits stable structured results", () => {
  const out = run(["tvbox", "--json"]);
  expect(out.code).toBe(0);
  const data = JSON.parse(out.stdout);
  expect(data.query).toBe("tvbox");
  expect(data.scope).toBe("qa");
  expect(data.agents).toEqual([]);
  expect(data.returned).toBe(2);
  expect(data.totalSessions).toBe(2);
  expect(data.results.map((row: { sessionId: string }) => row.sessionId)).toEqual([
    "opencode:tvbox-two",
    "omp:tvbox-one",
  ]);
  const hit = data.results[0].hits[0];
  expect(hit.matchField === "user" || hit.matchField === "assistant").toBe(true);
  expect(typeof hit.question).toBe("string");
  expect(typeof hit.answer).toBe("string");
  expect(hit.answer).toContain("exponential backoff");
});

test("--limit caps returned sessions", () => {
  const out = run(["tvbox", "--limit", "1", "--json"]);
  expect(out.code).toBe(0);
  const data = JSON.parse(out.stdout);
  expect(data.limit).toBe(1);
  expect(data.returned).toBe(1);
  expect(data.results).toHaveLength(1);
  expect(data.totalSessions).toBe(2);
});

test("--agent filters by agent", () => {
  const out = run(["tvbox", "--agent", "omp", "--json"]);
  expect(out.code).toBe(0);
  const data = JSON.parse(out.stdout);
  expect(data.agents).toEqual(["omp"]);
  expect(data.returned).toBe(1);
  expect(data.results[0].sessionId).toBe("omp:tvbox-one");
});

test("empty results exit 0 with a friendly message", () => {
  const text = run(["no-such-token-xyz"]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("No matches");

  const json = JSON.parse(run(["no-such-token-xyz", "--json"]).stdout);
  expect(json.returned).toBe(0);
  expect(json.totalSessions).toBe(0);
  expect(json.results).toEqual([]);
});

test("rejects invalid arguments with exit code 2", () => {
  const scope = run(["tvbox", "--scope", "wat"]);
  expect(scope.code).toBe(2);
  expect(scope.stderr).toContain('invalid --scope "wat"');

  const limit = run(["tvbox", "--limit", "0"]);
  expect(limit.code).toBe(2);
  expect(limit.stderr).toContain("invalid --limit");

  const agent = run(["tvbox", "--agent", "nope"]);
  expect(agent.code).toBe(2);
  expect(agent.stderr).toContain('unknown agent "nope"');

  const missing = run([]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("missing query");
});

test("--starred narrows the result set to starred sessions", () => {
  const data = JSON.parse(run(["tvbox", "--starred", "--json"]).stdout);
  expect(data.starred).toBe(true);
  expect(data.results.map((row: { sessionId: string }) => row.sessionId)).toEqual([
    "omp:tvbox-one",
  ]);
  // The flag pair is reported either way, so a script can tell them apart.
  expect(data.includeHidden).toBe(false);
});

test("--include-hidden brings hidden sessions back, and composes with --starred", () => {
  interface Row {
    sessionId: string;
    starred: boolean;
    hidden: boolean;
  }
  const rows = (...args: string[]) =>
    JSON.parse(
      run(["hiddenmarker", "--json", ...args], { SESSION_RECALL_DB: flagsPath }).stdout,
    ).results as Row[];
  const ids = (...args: string[]) => rows(...args).map((row) => row.sessionId).sort();

  expect(ids()).toEqual(["omp:visible-flag"]);
  expect(ids("--include-hidden")).toEqual(["omp:hidden-flag", "omp:visible-flag"]);
  expect(ids("--include-hidden", "--starred")).toEqual(["omp:hidden-flag"]);

  // A mixed result must say which row is which.
  const mixed = rows("--include-hidden");
  expect(mixed.find((row) => row.sessionId === "omp:hidden-flag")).toMatchObject({
    starred: true,
    hidden: true,
  });
  expect(mixed.find((row) => row.sessionId === "omp:visible-flag")).toMatchObject({
    starred: false,
    hidden: false,
  });
});

test("help documents the organization flags", () => {
  expect(USAGE).toContain("--starred");
  expect(USAGE).toContain("--include-hidden");
  expect(run(["--help"]).stdout).toContain("--include-hidden");
});

test("missing index gives a clear message instead of throwing", () => {
  const missingPath = join(dir, "absent", "index.db");
  const out = run(["tvbox"], { SESSION_RECALL_DB: missingPath });
  expect(out.code).toBe(1);
  expect(out.stderr).toContain("index not found");
  expect(out.stderr).toContain("bun run scan");
  expect(out.stdout).toBe("");
  expect(existsSync(missingPath)).toBe(false);
});
