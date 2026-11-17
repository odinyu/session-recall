import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  customAdapter,
  customAdapters,
  InvalidSourcesError,
  loadCustomSources,
} from "../src/adapters/custom.ts";
import type { CustomSource } from "../src/adapters/custom.ts";
import { openDb } from "../src/db.ts";
import { scan } from "../src/scan.ts";
import { searchTurns } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-custom-"));
let caseId = 0;

function freshDir(): string {
  const dir = join(root, "case-" + caseId++);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(dir: string, name: string, records: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

function spec(overrides: Partial<CustomSource> = {}): CustomSource {
  return { id: "mytool", format: "jsonl", root: root, ...overrides };
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("pairs user and assistant records into turns", async () => {
  const dir = freshDir();
  writeJsonl(dir, "s1.jsonl", [
    { role: "user", content: "how do we fix the reconnect backoff" },
    { role: "assistant", content: "we cap the delay at 30s" },
    { role: "user", content: "and the jitter?" },
    { role: "assistant", content: "full jitter, decorrelated" },
  ]);

  const adapter = customAdapter(spec({ root: dir }));
  const refs = await adapter.list();
  expect(refs.length).toBe(1);
  expect(refs[0].agent).toBe("mytool");
  expect(refs[0].externalId).toBe("s1");

  const session = await adapter.load(refs[0]);
  expect(session?.turns.length).toBe(2);
  expect(session?.turns[0].userText).toContain("reconnect backoff");
  expect(session?.turns[0].assistantText).toContain("30s");
  expect(session?.turns[1].userText).toContain("jitter");
  expect(session?.title).toContain("reconnect backoff");
});

test("reads dot paths, custom roles and block-shaped content", async () => {
  const dir = freshDir();
  writeJsonl(dir, "session-a.jsonl", [
    { meta: { title: "A stored title", cwd: "/tmp/proj" }, who: "human", body: [{ text: "first ask" }] },
    { who: "ai", body: [{ type: "text", text: "first answer" }] },
  ]);

  const adapter = customAdapter(spec({
    root: dir,
    title: "meta.title",
    cwd: "meta.cwd",
    role: "who",
    text: "body",
  }));
  const [ref] = await adapter.list();
  const session = await adapter.load(ref);
  expect(session?.title).toBe("A stored title");
  expect(session?.projectPath).toBe("/tmp/proj");
  expect(session?.turns[0].userText).toBe("first ask");
  expect(session?.turns[0].assistantText).toBe("first answer");
});

test("json format reads the array at messages", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "one.json"), JSON.stringify({
    messages: [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi" },
    ],
  }));

  const adapter = customAdapter(spec({ root: dir, format: "json" }));
  const refs = await adapter.list();
  expect(refs.length).toBe(1);
  const session = await adapter.load(refs[0]);
  expect(session?.turns.length).toBe(1);
  expect(session?.turns[0].assistantText).toBe("hi");
});

test("a record with no text is skipped rather than counted as a turn", async () => {
  const dir = freshDir();
  writeJsonl(dir, "s.jsonl", [
    { role: "user", content: "real question" },
    { role: "assistant", content: "" },
    { role: "system", content: "injected context" },
    { role: "assistant", content: "real answer" },
  ]);
  const adapter = customAdapter(spec({ root: dir }));
  const [ref] = await adapter.list();
  const session = await adapter.load(ref);
  expect(session?.turns.length).toBe(1);
  expect(session?.turns[0].assistantText).toBe("real answer");
});

test("a source with no readable sessions yields an empty list", async () => {
  const adapter = customAdapter(spec({ root: join(root, "does-not-exist") }));
  expect(await adapter.list()).toEqual([]);
});

test("the config is validated with a reason, not silently ignored", () => {
  const dir = freshDir();
  const bad = join(dir, "sources.json");

  writeFileSync(bad, "{ not json");
  expect(() => loadCustomSources(bad)).toThrow(InvalidSourcesError);

  writeFileSync(bad, JSON.stringify({ sources: [{ format: "jsonl", root: "/tmp" }] }));
  expect(() => loadCustomSources(bad)).toThrow(/missing "id"/);

  writeFileSync(bad, JSON.stringify({ sources: [{ id: "cursor", root: "/tmp" }] }));
  expect(() => loadCustomSources(bad)).toThrow(/already a built-in agent/);

  writeFileSync(bad, JSON.stringify({ sources: [{ id: "Bad Id", root: "/tmp" }] }));
  expect(() => loadCustomSources(bad)).toThrow(/lowercase/);

  writeFileSync(bad, JSON.stringify({ sources: [{ id: "x", format: "sqlite", root: "/tmp" }] }));
  expect(() => loadCustomSources(bad)).toThrow(/format must be/);
});

test("a broken config surfaces as a failing adapter, not as silence", async () => {
  const dir = freshDir();
  const bad = join(dir, "sources.json");
  writeFileSync(bad, "{ not json");
  const adapters = customAdapters(bad);
  expect(adapters.length).toBe(1);
  await expect(adapters[0].list()).rejects.toThrow(/not valid JSON/);
});

test("no config file means no extra adapters", () => {
  expect(customAdapters(join(root, "absent.json"))).toEqual([]);
});

test("a configured source is indexed and searchable end to end", async () => {
  const dir = freshDir();
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeJsonl(sessions, "live.jsonl", [
    { role: "user", content: "why does the parser eat semicolons" },
    { role: "assistant", content: "because the comment closed early" },
  ]);

  const config = join(dir, "sources.json");
  writeFileSync(config, JSON.stringify({
    sources: [{ id: "mytool", label: "My Tool", format: "jsonl", root: sessions }],
  }));

  const db = openDb(join(dir, "index.db"));
  try {
    const report = await scan(db, customAdapters(config));
    expect(report.errors).toEqual([]);
    expect(report.sessions).toBe(1);

    const found = searchTurns(db, {
      q: "semicolons",
      agents: [],
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: "qa",
      limit: 20,
      offset: 0,
    });
    expect(found.sessions.length).toBe(1);
    expect(found.sessions[0].agent).toBe("mytool");
  } finally {
    db.close();
  }
});
