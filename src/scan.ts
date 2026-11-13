import type { Database } from "bun:sqlite";
import { ompAdapter, piAdapter } from "./adapters/omp.ts";
import { openCodeAdapter } from "./adapters/opencode.ts";
import { cursorAdapter } from "./adapters/cursor.ts";
import { almaAdapter } from "./adapters/alma.ts";
import { cindyAdapter } from "./adapters/cindy.ts";
import { claudeCodeAdapter } from "./adapters/claude-code.ts";
import { codexAdapter } from "./adapters/codex.ts";
import type { Adapter, SessionRef } from "./adapters/types.ts";
import {
  clearScanError,
  deleteSession,
  existingIds,
  fingerprintsFor,
  forgottenIds,
  indexStats,
  purgeDeletedBytes,
  REDACTION_VERSION,
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
    piAdapter(),
    openCodeAdapter(),
    cursorAdapter(),
    almaAdapter(),
    cindyAdapter(),
    claudeCodeAdapter(),
    codexAdapter(),
  ],
  options: ScanOptions = {},
): Promise<ScanReport> {
  const startedAt = Date.now();
  const agents: Record<string, AgentScan> = {};
  const errors: { source: string; message: string }[] = [];
  const log = options.onProgress ?? (() => {});
  // Read once, before any adapter lists: a session the user forgot must not be
  // loaded (and rewritten) by a scan that started before the forget landed.
  const forgotten = forgottenIds(db);
  let purgedForgottenRows = false;

  for (const adapter of adapters) {
    const stat: AgentScan = { refs: 0, updated: 0, removed: 0, errors: 0 };
    agents[adapter.id] = stat;

    let listed: SessionRef[];
    try {
      listed = uniqueRefs(await adapter.list());
    } catch (error) {
      const message = messageOf(error);
      recordScanError(db, adapter.id, message);
      errors.push({ source: adapter.id, message });
      stat.errors++;
      log(`${adapter.label}: list failed — ${message}`);
      adapter.close?.();
      continue;
    }

    // Dropped here, before `load`, so no adapter can put a forgotten session
    // back; the deletion pass below still clears rows a forget left behind.
    const refs = listed.filter((ref) => !forgotten.has(`${ref.agent}:${ref.externalId}`));

    stat.refs = refs.length;
    clearScanError(db, adapter.id);
    const known = fingerprintsFor(db, adapter.id);
    const keep = new Set<string>();

    for (const [index, ref] of refs.entries()) {
      const id = `${ref.agent}:${ref.externalId}`;
      // The redaction revision rides along, so an index written before the
      // current redactor existed is re-read and rewritten once.
      const fingerprint = `${ref.fingerprint}:v${adapter.version ?? 1}:r${REDACTION_VERSION}`;
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
    const stale = [...existing].filter((id) => !keep.has(id));
    const forgottenRows = stale.filter((id) => forgotten.has(id));
    if (listed.length === 0 && existing.size > 0) {
      // Nothing listed at all is read as a source outage (an unmounted store),
      // so the existing index is kept — except for forgotten sessions, whose
      // rows must never outlive a scan.
      if (forgottenRows.length === 0) {
        log(`${adapter.label}: no sessions listed; keeping the existing index`);
      } else {
        log(
          `${adapter.label}: no sessions listed; dropped ${forgottenRows.length} forgotten session(s)`,
        );
      }
      for (const id of forgottenRows) {
        deleteSession(db, adapter.id, id.slice(adapter.id.length + 1));
        stat.removed++;
      }
    } else {
      for (const id of stale) {
        deleteSession(db, adapter.id, id.slice(adapter.id.length + 1));
        stat.removed++;
      }
    }
    if (forgottenRows.length > 0) purgedForgottenRows = true;

    adapter.close?.();
    log(
      `${adapter.label}: ${stat.refs} sessions, ${stat.updated} updated, ${stat.removed} removed, ${stat.errors} errors`,
    );
  }

  // Only reachable when this scan had to finish a forget (the row was still
  // indexed); rebuild the FTS indexes and drop the WAL so the removed text
  // leaves no searchable residue behind.
  if (purgedForgottenRows) purgeDeletedBytes(db);

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
