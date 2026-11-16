/**
 * Project paths that are real working directories but not projects.
 *
 * Cindy runs its agents inside its own per-dialogue scratch directory
 * (`…/owners/<owner>/dialogues/<date>/<id>`, `…/owners/<owner>/learn/staging/<id>`).
 * Indexing those cwds verbatim filled the project filter with raw dialogue ids,
 * so every adapter's path passes through here and they index as "no project".
 */
export function normalizeProjectPath(raw: string): string {
  const path = raw.replace(/\/+$/, "");
  if (!path) return "";
  if (/\/owners\/[^/]+\/(?:dialogues|learn\/staging)\//.test(path)) return "";
  return path;
}
