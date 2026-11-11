import type { Database } from "bun:sqlite";
import type { Adapter } from "./adapters/types.ts";
import { getMeta, openDb } from "./db.ts";
import { scan } from "./scan.ts";
import type { ScanReport } from "./scan.ts";
import {
  acquireScanLock,
  scanLockPath,
  tryAcquireScanLock,
} from "./scan-lock.ts";

/** How old a scan may be before a reader bothers to refresh it. */
export const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export interface ScanIfStaleOptions {
  maxAgeMs?: number;
  /** Scan even when the index is fresh (an explicit user request). */
  force?: boolean;
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  adapters?: Adapter[];
  onProgress?: (message: string) => void;
}

export interface StaleScanResult {
  scanned: boolean;
  skipped: "fresh" | "locked" | null;
  /** Age before the scan decided; null when the index has never been scanned. */
  ageMs: number | null;
  report: ScanReport | null;
}

/** now − last successful scan, or null when this index has never been scanned. */
export function indexAgeMs(db: Database, now = Date.now()): number | null {
  const last = Number(getMeta(db, "last_scan_ms") ?? 0);
  return Number.isFinite(last) && last > 0 ? Math.max(0, now - last) : null;
}

/**
 * Scans only when the index is older than `maxAgeMs` or forced, and only while
 * holding the cross-process scan lock. When another process is scanning the
 * caller keeps the existing index and sees `skipped: "locked"`.
 */
export async function scanIfStale(
  db: Database,
  lockPath: string,
  options: ScanIfStaleOptions = {},
): Promise<StaleScanResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const before = indexAgeMs(db);
  if (!options.force && before !== null && before <= maxAgeMs) {
    return { scanned: false, skipped: "fresh", ageMs: before, report: null };
  }

  const lock = await acquireScanLock(lockPath, {
    staleMs: options.staleMs,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
  });
  if (!lock) return { scanned: false, skipped: "locked", ageMs: before, report: null };

  try {
    // Someone may have refreshed it while we waited for the lock.
    const current = indexAgeMs(db);
    if (!options.force && current !== null && current <= maxAgeMs) {
      return { scanned: false, skipped: "fresh", ageMs: current, report: null };
    }
    const report = await scan(db, options.adapters, { onProgress: options.onProgress });
    return { scanned: true, skipped: null, ageMs: indexAgeMs(db), report };
  } finally {
    lock.release();
  }
}

export type RefreshState = "fresh" | "started" | "locked";

export interface RefreshOptions {
  /** Age the caller already read; avoids a second read-only open. */
  ageMs: number | null;
  maxAgeMs?: number;
  staleMs?: number;
  adapters?: Adapter[];
  onProgress?: (message: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * Fire-and-forget refresh for latency-sensitive readers. Starts at most one
 * scan per process attempt: the file lock decides, so a second caller — in this
 * process or another — reports `locked` and reads the current index instead.
 */
export function refreshInBackground(dbPath: string, options: RefreshOptions): RefreshState {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (options.ageMs !== null && options.ageMs <= maxAgeMs) return "fresh";

  const lock = tryAcquireScanLock(scanLockPath(dbPath), { staleMs: options.staleMs });
  if (!lock) return "locked";

  void (async () => {
    try {
      const db = openDb(dbPath);
      try {
        await scan(db, options.adapters, { onProgress: options.onProgress });
      } finally {
        db.close();
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      lock.release();
    }
  })();

  return "started";
}
