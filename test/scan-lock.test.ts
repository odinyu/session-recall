import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireScanLock,
  readScanLock,
  scanLockPath,
  tryAcquireScanLock,
} from "../src/scan-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "session-recall-lock-"));
const lockPath = scanLockPath(join(dir, "index.db"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLock(pid: number, token: string, mtime?: Date): void {
  writeFileSync(lockPath, JSON.stringify({ pid, token, acquiredAt: Date.now() }));
  if (mtime) utimesSync(lockPath, mtime, mtime);
}

test("only one owner at a time; release frees it", async () => {
  const first = tryAcquireScanLock(lockPath);
  expect(first).not.toBeNull();
  expect(tryAcquireScanLock(lockPath)).toBeNull();

  const waited = await acquireScanLock(lockPath, { timeoutMs: 30, pollMs: 5 });
  expect(waited).toBeNull();

  first?.release();
  expect(readScanLock(lockPath)).toBeNull();

  const second = tryAcquireScanLock(lockPath);
  expect(second).not.toBeNull();
  second?.release();
  expect(readScanLock(lockPath)).toBeNull();
});

test("waits for a live owner to release", async () => {
  const first = tryAcquireScanLock(lockPath);
  expect(first).not.toBeNull();

  // Released while the waiter is already polling, so ordering is deterministic.
  const pending = acquireScanLock(lockPath, { timeoutMs: 1_000, pollMs: 5 });
  first?.release();
  const second = await pending;
  expect(second).not.toBeNull();
  expect(readScanLock(lockPath)?.token).toBe(second?.token);
  second?.release();
});

test("takes over a lock whose mtime is past the stale threshold", () => {
  const old = new Date(Date.now() - 15 * 60 * 1000);
  writeLock(process.pid, "old-owner", old);

  const lock = tryAcquireScanLock(lockPath, { staleMs: 60_000 });
  expect(lock).not.toBeNull();
  expect(readScanLock(lockPath)?.token).toBe(lock?.token);
  lock?.release();
});

test("keeps a fresh lock held by another live pid", () => {
  writeLock(process.pid, "live-owner");

  expect(tryAcquireScanLock(lockPath, { staleMs: 60_000 })).toBeNull();
  expect(readScanLock(lockPath)?.token).toBe("live-owner");
});

test("takes over a fresh lock whose owner pid is gone", () => {
  writeLock(999_999, "dead-owner");

  const lock = tryAcquireScanLock(lockPath, { staleMs: 60 * 60 * 1000 });
  expect(lock).not.toBeNull();
  expect(readScanLock(lockPath)?.token).toBe(lock?.token);
  lock?.release();
});

test("release never removes a lock that was taken over", () => {
  const lock = tryAcquireScanLock(lockPath);
  expect(lock).not.toBeNull();

  // Simulate another process taking the lock away.
  writeLock(process.pid, "intruder");
  lock?.release();

  expect(readScanLock(lockPath)?.token).toBe("intruder");
});
