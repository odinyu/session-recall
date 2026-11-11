import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setMeta } from "../src/db.ts";
import { indexAgeMs, scanIfStale } from "../src/freshness.ts";
import { scanLockPath, tryAcquireScanLock } from "../src/scan-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-fresh-"));
const dbPath = join(dir, "index.db");
const lockPath = scanLockPath(dbPath);
const db = openDb(dbPath);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("indexAgeMs is null before the first scan", () => {
  expect(indexAgeMs(db)).toBeNull();
});

test("indexAgeMs measures from last_scan_ms", () => {
  setMeta(db, "last_scan_ms", "1000");
  expect(indexAgeMs(db, 1_500)).toBe(500);
  expect(indexAgeMs(db, 500)).toBe(0);
});

test("scanIfStale scans a never-scanned index under the lock", async () => {
  db.run("DELETE FROM meta WHERE key = 'last_scan_ms'");
  const result = await scanIfStale(db, lockPath, { adapters: [] });
  expect(result.scanned).toBe(true);
  expect(result.skipped).toBeNull();
  expect(result.report).not.toBeNull();
  expect(result.ageMs).not.toBeNull();
  expect(result.ageMs as number).toBeLessThan(5_000);
});

test("scanIfStale skips a fresh index", async () => {
  setMeta(db, "last_scan_ms", String(Date.now()));
  const result = await scanIfStale(db, lockPath, { adapters: [] });
  expect(result.scanned).toBe(false);
  expect(result.skipped).toBe("fresh");
});

test("force scans even when fresh", async () => {
  setMeta(db, "last_scan_ms", String(Date.now()));
  const result = await scanIfStale(db, lockPath, { adapters: [], force: true });
  expect(result.scanned).toBe(true);
});

test("scanIfStale leaves the index alone when another owner holds the lock", async () => {
  const old = Date.now() - 60 * 60 * 1000;
  setMeta(db, "last_scan_ms", String(old));
  const held = tryAcquireScanLock(lockPath);
  expect(held).not.toBeNull();
  try {
    const result = await scanIfStale(db, lockPath, { adapters: [], timeoutMs: 0 });
    expect(result.scanned).toBe(false);
    expect(result.skipped).toBe("locked");
    expect(result.ageMs as number).toBeGreaterThan(60_000);
  } finally {
    held?.release();
  }
});
