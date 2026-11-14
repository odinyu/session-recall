import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestChangelogOpen } from "../src/prefs.ts";

/**
 * The changelog request file is the sanctioned path from the web drawer to
 * the system browser: the shell polls for `<APP_DIR>/open-changelog-request.json`,
 * deletes it, and opens the URL it has compiled in — nothing caller-supplied.
 */

test("requestChangelogOpen writes {} atomically into the given dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-recall-changelog-"));
  try {
    expect(requestChangelogOpen(dir)).toBe("requested");
    expect(readFileSync(join(dir, "open-changelog-request.json"), "utf8")).toBe("{}\n");
    // No temp file left behind by the atomic write.
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestChangelogOpen creates the dir when missing and reports failure on an unwritable path", () => {
  const root = mkdtempSync(join(tmpdir(), "session-recall-changelog-"));
  try {
    const dir = join(root, "app");
    expect(requestChangelogOpen(dir)).toBe("requested");
    expect(readFileSync(join(dir, "open-changelog-request.json"), "utf8")).toBe("{}\n");
    // A read-only directory makes the write fail, readably.
    const blocked = join(root, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o500);
    expect(requestChangelogOpen(blocked)).toBe("failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/open-changelog returns 202 and writes into the temp home", async () => {
  // The route re-reads SESSION_RECALL_HOME per request (same env + fallback as
  // config.ts's APP_DIR), so a temp home works even though other test files
  // imported the server module first.
  const home = mkdtempSync(join(tmpdir(), "session-recall-changelog-home-"));
  process.env.SESSION_RECALL_HOME = home;
  try {
    const { api } = await import("../src/server.ts");
    const url = new URL("http://127.0.0.1/api/open-changelog");
    const response = await api(new Request(url, { method: "POST" }), url);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(readFileSync(join(home, "open-changelog-request.json"), "utf8")).toBe("{}\n");
  } finally {
    delete process.env.SESSION_RECALL_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
