import type { Database } from "bun:sqlite";
import { ompAdapter } from "./adapters/omp.ts";
import { openCodeAdapter } from "./adapters/opencode.ts";
import { cursorAdapter } from "./adapters/cursor.ts";
import { almaAdapter } from "./adapters/alma.ts";
import type { Adapter, SessionRef } from "./adapters/types.ts";
import {
  clearScanError,
  deleteSession,
  existingIds,
  fingerprintsFor,
  indexStats,
  recordScanError,
  setMeta,
  writeSession,
} from "./db.ts";

export interface AgentScan {
  refs: number;
  updated: number;
  removed: number;
  errors: number;
}

export interface ScanReport {
  tookMs: number;
  agents: Record<string, AgentScan>;
  sessions: number;
  turns: number;
  chars: number;
  errors: { source: string; message: string }[];
}

export interface ScanOptions {
  onProgress?: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueRefs(refs: SessionRef[]): SessionRef[] {
  const seen = new Map<string, SessionRef>();
  for (const ref of refs) seen.set(`${ref.agent}:${ref.externalId}`, ref);
  return [...seen.values()];
}

export async function scan(
  db: Database,
  adapters: Adapter[] = [
    ompAdapter(),
    openCodeAdapter(),
    cursorAdapter(),
    almaAdapter(),
  ],
  options: ScanOptions = {},
): Promise<ScanReport> {
  const startedAt = Date.now();
  const agents: Record<string, AgentScan> = {};
  const errors: { source: string; message: string }[] = [];
  const log = options.onProgress ?? (() => {});

  for (const adapter of adapters) {
    const stat: AgentScan = { refs: 0, updated: 0, removed: 0, errors: 0 };
    agents[adapter.id] = stat;

    let refs: SessionRef[];
    try {
      refs = uniqueRefs(await adapter.list());
    } catch (error) {
      const message = messageOf(error);
      recordScanError(db, adapter.id, message);
      errors.push({ source: adapter.id, message });
      stat.errors++;
      log(`${adapter.label}: list failed — ${message}`);
      adapter.close?.();
      continue;
    }

    stat.refs = refs.length;
    clearScanError(db, adapter.id);
    const known = fingerprintsFor(db, adapter.id);
    const keep = new Set<string>();

    for (const [index, ref] of refs.entries()) {
      const id = `${ref.agent}:${ref.externalId}`;
      const fingerprint = `${ref.fingerprint}:v${adapter.version ?? 1}`;
      keep.add(id);
      if (known.get(id) === fingerprint) continue;
      try {
        const session = await adapter.load(ref);
        if (!session) {
          deleteSession(db, ref.agent, ref.externalId);
          stat.removed++;
          continue;
        }
        session.fingerprint = fingerprint;
        writeSession(db, session);
        clearScanError(db, ref.sourcePath);
        stat.updated++;
      } catch (error) {
        const message = messageOf(error);
        recordScanError(db, ref.sourcePath, message);
        errors.push({ source: ref.sourcePath, message });
        stat.errors++;
      }
      if ((index + 1) % 50 === 0) {
        log(`${adapter.label}: ${index + 1}/${refs.length} checked`);
      }
    }

    const existing = existingIds(db, adapter.id);
    if (refs.length === 0 && existing.size > 0) {
      log(`${adapter.label}: no sessions listed; keeping the existing index`);
    } else {
      for (const id of existing) {
        if (keep.has(id)) continue;
        deleteSession(db, adapter.id, id.slice(adapter.id.length + 1));
        stat.removed++;
      }
    }

    adapter.close?.();
    log(
      `${adapter.label}: ${stat.refs} sessions, ${stat.updated} updated, ${stat.removed} removed, ${stat.errors} errors`,
    );
  }

  const stats = indexStats(db);
  const finishedAt = Date.now();
  setMeta(db, "last_scan_ms", String(finishedAt));
  setMeta(db, "last_scan_took_ms", String(finishedAt - startedAt));

  return {
    tookMs: finishedAt - startedAt,
    agents,
    sessions: stats.sessions,
    turns: stats.turns,
    chars: stats.chars,
    errors,
  };
}
