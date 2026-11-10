import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Files directly inside subdirectories of root; hidden entries skipped. */
export function filesInChildDirs(root: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  let children: string[];
  try {
    children = readdirSync(root);
  } catch {
    return out;
  }
  for (const child of children) {
    if (child.startsWith(".")) continue;
    const dir = join(root, child);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || !entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const stat = statSync(path);
        if (stat.isFile()) out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A file removed between readdir and stat is simply not listed.
      }
    }
  }
  return out;
}

/** Recursive file walk with a name filter. */
export function walkFiles(root: string, matches: (name: string) => boolean): WalkedFile[] {
  const out: WalkedFile[] = [];
  const visit = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && matches(entry.name)) {
        try {
          const stat = statSync(path);
          out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // ignore files that vanish mid-walk
        }
      }
    }
  };
  visit(root);
  return out;
}
