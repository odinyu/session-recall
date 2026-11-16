import { expect, test } from "bun:test";
import { normalizeProjectPath } from "../src/util/projects.ts";

const OWNER = "/Users/odin/Library/Application Support/CindyGlobal/owners/f94fe314";

test("keeps real project paths, minus a trailing slash", () => {
  expect(normalizeProjectPath("/Users/odin/projects/app")).toBe("/Users/odin/projects/app");
  expect(normalizeProjectPath("/Users/odin/projects/app/")).toBe("/Users/odin/projects/app");
  expect(normalizeProjectPath("")).toBe("");
});

test("drops Cindy's per-dialogue and staging scratch directories", () => {
  expect(normalizeProjectPath(`${OWNER}/dialogues/2026-11-13/32a58be6-e579-4dec-95a4`)).toBe("");
  expect(normalizeProjectPath(`${OWNER}/dialogues/2026-11-12/abc/work`)).toBe("");
  expect(normalizeProjectPath(`${OWNER}/learn/staging/01612810-9dee-48e7`)).toBe("");
});

test("keeps the bot workspace, which is a real cwd the user may filter on", () => {
  const workspace = `${OWNER}/bots/cindy-default/workspace`;
  expect(normalizeProjectPath(workspace)).toBe(workspace);
});
