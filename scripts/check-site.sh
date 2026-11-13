#!/usr/bin/env bash
#
# check-site.sh — self-check for the Session Recall landing page.
#
# Serves site/ from a local HTTP server and verifies:
#   1. every required route returns 200
#   2. every local href/src/srcset referenced by the pages resolves with 200
#   3. no external subresources (fonts, images, scripts, stylesheets) are referenced
#   4. in-page anchors point at ids that exist
#   5. the only "TODO" markers left are the documented ones (the placeholder
#      domain, and a version number where one still has to be typed by hand)
#
# Usage:  bash scripts/check-site.sh
# Exit code 0 = pass, non-zero = fail.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="$ROOT/site"
HOST="127.0.0.1"

if [ ! -d "$SITE" ]; then
  echo "FAIL: site directory not found at $SITE"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 not found on PATH"
  exit 1
fi

PORT="$(python3 -I -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

python3 -I -m http.server "$PORT" --bind "$HOST" --directory "$SITE" >/dev/null 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://$HOST:$PORT/" 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FAIL: local server exited before it served anything"
    exit 1
  fi
  sleep 0.1
done

if [ "$READY" -ne 1 ]; then
  echo "FAIL: local server did not become ready on port $PORT"
  exit 1
fi

echo "Serving $SITE at http://$HOST:$PORT"

python3 -I - "$SITE" "http://$HOST:$PORT" <<'PY'
import os
import re
import sys
import urllib.error
import urllib.request

site, base = sys.argv[1], sys.argv[2]
fails = []

REQUIRED = [
    "/",
    "/zh/",
    "/robots.txt",
    "/sitemap.xml",
    "/_headers",
    "/_redirects",
    "/assets/site.css",
    "/assets/site.js",
    "/assets/favicon.svg",
    "/assets/apple-touch-icon.png",
    "/assets/og.png",
]

HTML_FILES = ["index.html", "zh/index.html"]

SUB_TAG = re.compile(
    r"<(?:img|script|source|iframe|audio|video|embed|track|link)\b[^>]*>", re.I
)
ANCHOR_TAG = re.compile(r"<a\b[^>]*>", re.I)
ATTR = re.compile(r'(src|href)\s*=\s*"([^"]*)"', re.I)
SRCSET = re.compile(r'srcset\s*=\s*"([^"]*)"', re.I)
ID = re.compile(r'\bid\s*=\s*"([^"]+)"')
HASH_HREF = re.compile(r'href\s*=\s*"#([^"]+)"', re.I)
EXTERNAL = ("http://", "https://", "//")
LINK_SUBRESOURCE_REL = (
    "stylesheet",
    "icon",
    "preload",
    "manifest",
    "apple-touch-icon",
    "mask-icon",
)


def fetch(path):
    try:
        with urllib.request.urlopen(base + path, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception as exc:  # noqa: BLE001
        return "ERR(%s)" % exc


# --- 1. required routes -----------------------------------------------------

for path in REQUIRED:
    status = fetch(path)
    if status != 200:
        fails.append("%s -> %s" % (path, status))

# --- 2 & 3. scrape the pages ------------------------------------------------

local_refs = set()
for name in HTML_FILES:
    full = os.path.join(site, name)
    if not os.path.isfile(full):
        fails.append("missing page: %s" % name)
        continue
    src = open(full, encoding="utf-8").read()

    # navigation links: external is fine, local must resolve, anchors must exist
    ids = set(ID.findall(src))
    for match in HASH_HREF.finditer(src):
        if match.group(1) not in ids:
            fails.append('%s: anchor #%s has no target' % (name, match.group(1)))

    for match in ANCHOR_TAG.finditer(src):
        for attr in ATTR.finditer(match.group(0)):
            value = attr.group(2)
            if not value or value.startswith("#"):
                continue
            if value.startswith(EXTERNAL):
                continue
            if value.startswith("/"):
                local_refs.add(value)
            else:
                fails.append("%s: link is not root-absolute: %s" % (name, value))

    # subresources: must be local
    for match in SUB_TAG.finditer(src):
        tag = match.group(0)
        if tag.lower().startswith("<link"):
            rel_match = re.search(r'rel\s*=\s*"([^"]*)"', tag, re.I)
            rel = rel_match.group(1).lower() if rel_match else ""
            if not any(key in rel for key in LINK_SUBRESOURCE_REL):
                continue  # canonical / hreflang alternates are page links, not files

        for attr in ATTR.finditer(tag):
            kind, value = attr.group(1), attr.group(2)
            if not value:
                continue
            if value.startswith(EXTERNAL):
                fails.append('%s: external subresource %s="%s"' % (name, kind, value))
            elif value.startswith("/"):
                local_refs.add(value)
            elif value.startswith("data:"):
                fails.append("%s: inline data: subresource (%s)" % (name, kind))
            else:
                fails.append("%s: subresource is not root-absolute: %s" % (name, value))

        for set_match in SRCSET.finditer(tag):
            for part in set_match.group(1).split(","):
                part = part.strip()
                if not part:
                    continue
                value = part.split()[0]
                if value.startswith(EXTERNAL):
                    fails.append("%s: external subresource in srcset: %s" % (name, value))
                elif value.startswith("/"):
                    local_refs.add(value)
                else:
                    fails.append("%s: srcset entry is not root-absolute: %s" % (name, value))

# --- 2b. every local reference resolves -------------------------------------

for ref in sorted(local_refs):
    path = ref.split("#")[0].split("?")[0]
    if not path:
        continue
    status = fetch(path)
    if status != 200:
        fails.append("%s -> %s" % (path, status))

# --- 3b. the stylesheet must not reach out either ---------------------------

css_path = os.path.join(site, "assets", "site.css")
if os.path.isfile(css_path):
    css = open(css_path, encoding="utf-8").read()
    for match in re.finditer(r"url\(\s*['\"]?([^'\")\s]+)", css, re.I):
        value = match.group(1)
        if value.startswith(EXTERNAL):
            fails.append("assets/site.css: external url() -> %s" % value)
    if re.search(r"@import", css, re.I):
        fails.append("assets/site.css: @import is not allowed (external CSS)")

# --- 5. remaining TODO markers ----------------------------------------------

ALLOWED_TODO = re.compile(r"session-recall\.pages\.dev|\d+\.\d+\.\d+")
# Shipped pages and assets only. README.md is a maintainer doc and refers to the
# TODO convention in prose, so it is deliberately not scanned.
SCAN_EXT = (".html", ".css", ".js", ".txt", ".xml")

for dirpath, _dirnames, filenames in os.walk(site):
    for filename in filenames:
        if not filename.endswith(SCAN_EXT):
            continue
        full = os.path.join(dirpath, filename)
        rel = os.path.relpath(full, site)
        try:
            text = open(full, encoding="utf-8").read()
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if "TODO" in line and not ALLOWED_TODO.search(line):
                fails.append(
                    "%s:%d: undocumented TODO -> %s" % (rel, lineno, line.strip()[:110])
                )

# --- report -----------------------------------------------------------------

print("checked %d local references" % len(local_refs))
if fails:
    print("")
    for item in fails:
        print("  FAIL  %s" % item)
    print("")
    print("%d problem(s)" % len(fails))
    sys.exit(1)

print("all references resolve, no external subresources, no stray TODO markers")
sys.exit(0)
PY

STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "PASS: site checks passed"
else
  echo "FAIL: site checks failed"
fi

exit "$STATUS"
