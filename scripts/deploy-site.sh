#!/usr/bin/env bash
#
# deploy-site.sh — bump the asset cache version, check, and deploy the landing page.
#
# Usage:
#   bash scripts/deploy-site.sh              # bump ?v=, run checks, wrangler deploy
#   bash scripts/deploy-site.sh --dry-run    # validate only; no files changed, no deploy
#   bash scripts/deploy-site.sh --no-bump    # check and deploy without touching ?v=
#
# First-time setup: npx wrangler login
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
BUMP=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1; BUMP=0 ;;
    --no-bump) BUMP=0 ;;
    -h|--help)
      echo "Usage: bash scripts/deploy-site.sh [--dry-run] [--no-bump]"
      echo "  --dry-run  check and run wrangler deploy --dry-run; no files changed"
      echo "  --no-bump  deploy without changing the ?v= asset version"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

command -v npx >/dev/null 2>&1 || { echo "FAIL: npx not found on PATH" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 not found on PATH" >&2; exit 1; }
[ -f wrangler.jsonc ] || { echo "FAIL: wrangler.jsonc not found" >&2; exit 1; }
[ -f site/index.html ] && [ -f site/zh/index.html ] || {
  echo "FAIL: site/index.html or site/zh/index.html not found" >&2
  exit 1
}

if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  echo "Note: working tree has uncommitted changes; deploying the current files."
fi

BACKUP=""
restore() {
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
    cp "$BACKUP/index.html" site/index.html
    cp "$BACKUP/zh-index.html" site/zh/index.html
    echo "Restored site HTML after a failed run."
  fi
}
trap restore EXIT

if [ "$BUMP" -eq 1 ]; then
  BACKUP="$(mktemp -d)"
  cp site/index.html "$BACKUP/index.html"
  cp site/zh/index.html "$BACKUP/zh-index.html"

  BUMP_OUTPUT="$(python3 - <<'PY'
from pathlib import Path
import re

files = [Path("site/index.html"), Path("site/zh/index.html")]
texts = [path.read_text(encoding="utf-8") for path in files]
current = max(
    (int(match) for text in texts for match in re.findall(r"\?v=(\d+)", text)),
    default=0,
)
next_version = current + 1
for path, text in zip(files, texts):
    path.write_text(
        re.sub(
            r"(/assets/(?:site\.(?:css|js)|theme-init\.js))\?v=\d+",
            rf"\1?v={next_version}",
            text,
        ),
        encoding="utf-8",
    )
    # The screenshots are served with a long cache lifetime, so their URLs
    # carry the same version. Without this they would keep pointing at the
    # bytes cached before the last re-encode.
    path.write_text(
        re.sub(
            r"(/assets/screenshots/[^\"'\s]+?\.webp)(\?v=\d+)?",
            rf"\1?v={next_version}",
            path.read_text(encoding="utf-8"),
        ),
        encoding="utf-8",
    )
print(current, next_version)
PY
)"
  [ -n "$BUMP_OUTPUT" ] || { echo "FAIL: could not bump asset version" >&2; exit 1; }
  CURRENT="${BUMP_OUTPUT%% *}"
  NEXT="${BUMP_OUTPUT##* }"
  echo "Asset version: v$CURRENT -> v$NEXT"

  for page in site/index.html site/zh/index.html; do
    grep -q "site.css?v=$NEXT" "$page" || { echo "FAIL: version bump missing in $page" >&2; exit 1; }
    grep -q "site.js?v=$NEXT" "$page" || { echo "FAIL: version bump missing in $page" >&2; exit 1; }
    grep -q "theme-init.js?v=$NEXT" "$page" || { echo "FAIL: version bump missing in $page" >&2; exit 1; }
    grep -q "screenshots/en/search-results-1440.webp?v=$NEXT" "$page" || { echo "FAIL: screenshot version bump missing in $page" >&2; exit 1; }
    grep -q "screenshots/zh/session-detail-dark-720.webp?v=$NEXT" "$page" || { echo "FAIL: screenshot version bump missing in $page" >&2; exit 1; }
  done
fi

bash scripts/check-site.sh

if [ "$DRY_RUN" -eq 1 ]; then
  npx --yes wrangler@4 deploy --dry-run
  BACKUP=""
  echo "Dry run passed. No deploy was performed."
  exit 0
fi

npx --yes wrangler@4 deploy

BACKUP=""
echo "Deployed to Cloudflare Workers."
if [ "$BUMP" -eq 1 ]; then
  echo "Now commit and push the bumped site files so GitHub builds keep the same version:"
  echo "  git add site/"
  echo "  git commit -m \"更新落地页资源版本\" && git push origin main"
fi

