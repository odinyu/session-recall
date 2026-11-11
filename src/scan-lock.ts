import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Cross-process scan lock, so the app sidecar, the CLI and the MCP server
 * never write the same index at once. SQLite allows many readers, but a scan
 * rewrites sessions in bulk; two scans interleaving would duplicate work and
 * could delete each other's rows.
 *
 * The lock is a file next to the index created with `O_EXCL` (`"wx"`), which
 * is atomic on every local filesystem. A lock whose mtime is older than
 * `staleMs` — or whose owner pid is gone — is treated as a crash leftover and
 * taken over by renaming it away, so two stealers cannot both win.
 */

export const DEFAULT_STALE_MS = 10 * 60 * 1000;
export const LOCK_SUFFIX = ".scan.lock";

export interface ScanLockHandle {
  path: string;
  token: string;
  /** Idempotent; removes the file only while this handle still owns it. */
  release(): void;
}

/** Minimal errno shape; avoids depending on @types/node. */
interface ErrnoLike {
  code?: string;
}

export interface ScanLockInfo {
  pid: number;
  token: string;
  acquiredAt: number;
}

export interface TryAcquireOptions {
  /** Age after which a lock is considered abandoned. */
  staleMs?: number;
}

export interface AcquireOptions extends TryAcquireOptions {
  /** 0 (default) tries once, without waiting. */
  timeoutMs?: number;
  pollMs?: number;
}

/** `index.db` -> `index.db.scan.lock`. */
export function scanLockPath(dbPath: string): string {
  return `${dbPath}${LOCK_SUFFIX}`;
}

export function readScanLock(path: string): ScanLockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    typeof record.token !== "string" ||
    typeof record.acquiredAt !== "number"
  ) {
    return null;
  }
  return { pid: record.pid, token: record.token, acquiredAt: record.acquiredAt };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as ErrnoLike).code === "EPERM";
  }
}

function lockIsStale(path: string, staleMs: number, now: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (now - mtimeMs > staleMs) return true;
  const info = readScanLock(path);
  return info !== null && !pidAlive(info.pid);
}

/** Rename-away the stale lock; at most one process can win that rename. */
function clearStale(path: string, staleMs: number): boolean {
  if (!lockIsStale(path, staleMs, Date.now())) return false;
  const grave = `${path}.${process.pid}.${Date.now().toString(36)}.stale`;
  try {
    renameSync(path, grave);
  } catch (error) {
    return (error as ErrnoLike).code === "ENOENT";
  }
  try {
    unlinkSync(grave);
  } catch {
    // A leftover grave file is harmless; it never names the live lock.
  }
  return true;
}

function releaseLock(path: string, token: string): void {
  const current = readScanLock(path);
  if (!current || current.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or taken over after the read above; either way not ours.
  }
}

function createLock(path: string): ScanLockHandle | null {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as ErrnoLike).code === "EEXIST") return null;
    throw error;
  }
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }));
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // closing a just-opened fd cannot fail in a recoverable way
    }
    try {
      unlinkSync(path);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
  closeSync(fd);
  return { path, token, release: () => releaseLock(path, token) };
}

/** One attempt, including a stale takeover; null when another owner holds it. */
export function tryAcquireScanLock(
  lockPath: string,
  options: TryAcquireOptions = {},
): ScanLockHandle | null {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = createLock(lockPath);
    if (lock) return lock;
    if (attempt === 0 && clearStale(lockPath, staleMs)) continue;
    return null;
  }
  return null;
}

/** Polls until the lock is free or `timeoutMs` elapses; null on timeout. */
export async function acquireScanLock(
  lockPath: string,
  options: AcquireOptions = {},
): Promise<ScanLockHandle | null> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const pollMs = Math.max(1, options.pollMs ?? 100);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = tryAcquireScanLock(lockPath, options);
    if (lock) return lock;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(pollMs, remaining));
  }
}
