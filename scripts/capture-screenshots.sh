#!/usr/bin/env bash
#
# Regenerate the README screenshots in docs/screenshots/.
#
# Every shot is taken from a throwaway index built out of synthetic sessions
# (test/fixtures/screenshot-data.ts). The real index — a large private history
# under ~/Library/Application Support/session-recall/index.db — is never opened:
# HOME, every SESSION_RECALL_* path and every adapter root point into a
# temporary directory, so even the scan the server runs on boot can only find
# nothing. The script verifies that before and after it takes the shots.
#
# Every set holds the same three views, taken from one language-specific index
# so the English shots show English chrome *and* English session bodies. A run
# writes into a directory of its own, so the light originals are never touched
# by a dark run:
#
#   light (default)  docs/screenshots/<lang>/{search-results,session-detail,process-search}.png
#   dark             docs/screenshots/<lang>-dark/{search-results,session-detail,process-search}.png
#
# The theme is a server-side preference, so each theme gets its own server,
# started after `prefs.json` has been written into the temp app dir: the first
# paint of every shot is already in the theme being captured. A light run keeps
# the sequence it has always had — only the search results are light, the
# session and process shots are dark, so the existing light assets are not
# silently re-rendered. A dark run is dark throughout.
#
# Usage:
#   bash scripts/capture-screenshots.sh [--lang en|zh|all] [--theme light|dark|all]
#
#   --lang   default all
#   --theme  default light (today's behaviour); `all` takes both sets
#
# Env overrides:
#   SR_CHROME    path to a Chrome/Chromium binary (auto-detected by default)
#   SR_PORT      first port to try for the UI (default 4399)
#   SR_WIDTH     viewport width, default 1440
#   SR_HEIGHT    viewport height, default 900
#   SR_THEME     same as --theme (light, dark or all); default light
#   SR_KEEP_TMP  1 keeps the temp dir (fixture index, server log) for inspection
#
# Requires macOS, Bun 1.3+ and a Chrome/Chromium build. Re-runnable: each
# language seeds a fresh index in the same temp dir, gets its own server process
# and its own port, and every process it started is stopped before it exits.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN:-bun}"
WIDTH="${SR_WIDTH:-1440}"
HEIGHT="${SR_HEIGHT:-900}"
OUT="$ROOT/docs/screenshots"
FIXTURE="$ROOT/test/fixtures/screenshot-data.ts"

LANG_ARG="all"
THEME_ARG="${SR_THEME:-light}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)
      if [[ $# -lt 2 ]]; then
        echo "--lang needs a value (en, zh or all)" >&2
        exit 2
      fi
      LANG_ARG="$2"
      shift 2
      ;;
    --lang=*)
      LANG_ARG="${1#--lang=}"
      shift
      ;;
    --theme)
      if [[ $# -lt 2 ]]; then
        echo "--theme needs a value (light, dark or all)" >&2
        exit 2
      fi
      THEME_ARG="$2"
      shift 2
      ;;
    --theme=*)
      THEME_ARG="${1#--theme=}"
      shift
      ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $1 (expected --lang en|zh|all, --theme light|dark|all)" >&2
      exit 2
      ;;
  esac
done

case "$LANG_ARG" in
  all) LANGS=(en zh) ;;
  en|zh) LANGS=("$LANG_ARG") ;;
  *)
    echo "invalid --lang value: $LANG_ARG (expected en, zh or all)" >&2
    exit 2
    ;;
esac

case "$THEME_ARG" in
  all) THEMES=(light dark) ;;
  light|dark) THEMES=("$THEME_ARG") ;;
  *)
    echo "invalid --theme value: $THEME_ARG (expected light, dark or all)" >&2
    exit 2
    ;;
esac

echo "本脚本使用合成数据，不会读取真实 index.db"
echo "capture-screenshots: synthetic sessions only; the real index.db is never opened"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}
need "$BUN"
need curl
need lsof
need mktemp

find_chrome() {
  if [[ -n "${SR_CHROME:-}" ]]; then printf "%s\n" "$SR_CHROME"; return; fi
  local candidate
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    if [[ -x "$candidate" ]]; then printf "%s\n" "$candidate"; return; fi
  done
  command -v google-chrome || command -v chromium || true
}
CHROME="$(find_chrome)"
if [[ -z "$CHROME" || ! -x "$CHROME" ]]; then
  echo "no Chrome/Chromium found; set SR_CHROME=/path/to/binary" >&2
  exit 1
fi

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}
first_free_port() { # first_free_port <start>
  local port="$1"
  for _ in $(seq 1 30); do
    if ! port_in_use "$port"; then printf "%s\n" "$port"; return 0; fi
    port=$((port + 1))
  done
  return 1
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/session-recall-screenshots.XXXXXX")"
SERVER_PID=""
CHROME_PID=""

cleanup() {
  if [[ -n "$CHROME_PID" ]] && kill -0 "$CHROME_PID" 2>/dev/null; then
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "${SR_KEEP_TMP:-0}" == "1" ]]; then
    echo "kept temp dir: $TMP"
  else
    case "$TMP" in */session-recall-screenshots.*) rm -rf -- "$TMP" ;; esac
  fi
}
trap cleanup EXIT INT TERM

# --- isolation: nothing below can reach the real index or a real agent dir ---
export HOME="$TMP/home"
mkdir -p "$HOME"
export SESSION_RECALL_HOME="$TMP/app"
export SESSION_RECALL_DB="$TMP/app/index.db"
export SESSION_RECALL_BRIEF_DIR="$TMP/app/brief"
export SESSION_RECALL_WEB_DIST="$ROOT/web/dist"
# Every adapter root explicitly redirected, on top of the empty HOME:
export SESSION_RECALL_ALMA_DB="$HOME/Library/Application Support/alma/chat_threads.db"
export SESSION_RECALL_CINDY_DIR="$HOME/Library/Application Support/CindyGlobal"
export SESSION_RECALL_CLAUDE_DIR="$HOME/.claude"
export SESSION_RECALL_CODEX_DIR="$HOME/.codex"
export CURSOR_CONFIG_DIR="$HOME/.cursor"
export XDG_DATA_HOME="$HOME/.local/share"

echo "temp dir:      $TMP"
echo "fixture index: $SESSION_RECALL_DB"
echo "chrome:        $CHROME"
echo "languages:     ${LANGS[*]}"
echo "themes:        ${THEMES[*]}"

if [[ ! -f "$SESSION_RECALL_WEB_DIST/index.html" ]]; then
  echo "web/dist is missing; building the UI"
  ( cd "$ROOT" && "$BUN" run scripts/build.ts )
fi

verify_fixture() { # verify_fixture <label>
  "$BUN" run "$FIXTURE" --verify "$SESSION_RECALL_DB" >/dev/null
  echo "  verified ($1): only synthetic sessions in the index"
}

# Shots are taken over the DevTools protocol from a helper written to the temp
# dir. Chrome's own --screenshot flag cannot be used for the session view: when
# a ?turn= deep link points below the fold the page scrolls itself, and the flag
# writes an empty frame instead of the scrolled content. A live tab also lets
# each shot wait for the view it expects (results rendered, turn highlighted)
# and pins the viewport to an exact size.
cat > "$TMP/screenshot.ts" <<'SCREENSHOT_TS_EOF'
/**
 * Screenshot helper for scripts/capture-screenshots.sh, written into the temp
 * dir at run time and run with Bun.
 *
 * usage: bun run screenshot.ts <cdp-port> <url> <out.png> [width] [height] [ready-js]
 *
 * It opens a blank tab, waits for the load event, for the readiness expression
 * and for one animation frame, then captures the viewport.
 */
const [portArg, url, outFile, widthArg, heightArg, readyArg] = process.argv.slice(2);
if (!portArg || !url || !outFile) {
  console.error("usage: screenshot.ts <cdp-port> <url> <out.png> [width] [height] [ready-js]");
  process.exit(2);
}
const port = Number(portArg);
const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const ready = readyArg || "document.getElementById('content') !== null";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => {
  console.error("screenshot helper timed out: " + url);
  process.exit(3);
}, 20_000);

// A blank tab first: a tab Chrome already started loading can leave
// Page.navigate without a reply.
const opened = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" });
if (!opened.ok) {
  console.error("could not open a tab: HTTP " + opened.status);
  process.exit(1);
}
const target = (await opened.json()) as { id: string; webSocketDebuggerUrl: string };

const socket = new WebSocket(target.webSocketDebuggerUrl);
const waiting = new Map<number, (message: any) => void>();
let nextId = 1;
let loaded = false;

socket.addEventListener("message", (event: MessageEvent) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Page.loadEventFired") loaded = true;
  const resolve = message.id ? waiting.get(message.id) : undefined;
  if (resolve) {
    waiting.delete(message.id);
    resolve(message);
  }
});
await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));

function call(method: string, params: Record<string, unknown> = {}) {
  const id = nextId++;
  return new Promise<any>((resolve) => {
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression: string) {
  const answer = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return answer.result?.result?.value;
}

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await call("Page.navigate", { url });

for (let i = 0; i < 200 && !loaded; i += 1) await sleep(50);

let matched = false;
for (let i = 0; i < 100; i += 1) {
  if ((await evaluate(ready)) === true) {
    matched = true;
    break;
  }
  await sleep(100);
}
if (!matched) {
  console.error("the view never matched: " + ready);
  process.exit(1);
}

// One animation frame, so the scroll a deep link performs has been painted;
// the sleep stands in if the frame callback never runs.
await Promise.race([
  evaluate("new Promise((resolve) => requestAnimationFrame(() => resolve(1)))"),
  sleep(1000),
]);
await sleep(200);

const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
const data = shot.result?.data as string | undefined;
if (!data) {
  console.error("captureScreenshot returned no data");
  process.exit(1);
}
await Bun.write(outFile, Buffer.from(data, "base64"));
await fetch("http://127.0.0.1:" + port + "/json/close/" + target.id).catch(() => {});
socket.close();
console.log("  captured " + outFile);
process.exit(0);
SCREENSHOT_TS_EOF

start_chrome() {
  local cdp_port="$1"
  echo "starting headless Chrome (DevTools on port $cdp_port)"
  # The mock keychain and the disabled updater keep a fresh profile from blocking
  # on macOS dialogs or background work before a shot is written.
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --disable-extensions --disable-component-update --disable-background-networking \
    --use-mock-keychain --password-store=basic --hide-scrollbars \
    --user-data-dir="$TMP/chrome" --window-size="$WIDTH,$HEIGHT" \
    --remote-debugging-port="$cdp_port" about:blank > "$TMP/chrome.log" 2>&1 &
  CHROME_PID=$!

  local cdp_ready=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$cdp_port/json/version" 2>/dev/null; then cdp_ready=1; break; fi
    if ! kill -0 "$CHROME_PID" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if [[ "$cdp_ready" != "1" ]]; then
    echo "headless Chrome did not report a DevTools endpoint; log follows:" >&2
    cat "$TMP/chrome.log" >&2
    exit 1
  fi
}

start_server() { # start_server <port> <log-name>
  echo "starting the UI on http://127.0.0.1:$1 with isolated adapters"
  ( cd "$ROOT" && exec "$BUN" run src/cli.ts serve ) > "$TMP/serve-$2.log" 2>&1 &
  SERVER_PID=$!
  local ready=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$1/api/status" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if [[ "$ready" != "1" ]]; then
    echo "the server did not come up; log follows:" >&2
    cat "$TMP/serve-$2.log" >&2
    exit 1
  fi
}

stop_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

# Theme and interface language are both server-side preferences, stored by the
# sidecar in `<app dir>/prefs.json` — inside the temp dir here, because
# SESSION_RECALL_HOME points there. Writing that file before the server starts
# is what makes the very first paint of a run the right theme; the PATCH below
# is only for changing it mid-run.
write_prefs() { # write_prefs <theme> <lang>
  mkdir -p "$SESSION_RECALL_HOME"
  printf '{\n  "theme": "%s",\n  "language": "%s"\n}\n' "$1" "$2" \
    > "$SESSION_RECALL_HOME/prefs.json"
  echo "prefs before boot: theme=$1 language=$2"
}

set_prefs() { # set_prefs <theme> <lang>
  curl -fsS -X PATCH -H "content-type: application/json" \
    -d "{\"theme\":\"$1\",\"language\":\"$2\"}" "http://127.0.0.1:$PORT/api/prefs" >/dev/null
}

# A set is captured in exactly one theme: `--theme light` makes every view
# light and `--theme dark` makes every view dark. The earlier script switched to
# dark partway through a light run, which left the shipped light set two-thirds
# dark — the mismatch the site had between its theme and its screenshots.
view_theme() { # view_theme <run-theme> <view>
  printf "%s\n" "$1"
}

shoot() { # shoot <file> <url> <ready-js>
  local file="$1" url="$2" ready="$3"
  local attempt bytes
  for attempt in 1 2 3; do
    rm -f -- "$file"
    if "$BUN" run "$TMP/screenshot.ts" "$CDP_PORT" "$url" "$file" "$WIDTH" "$HEIGHT" "$ready"; then
      bytes=0
      if [[ -f "$file" ]]; then bytes="$(wc -c < "$file")"; fi
      # A blank or browser-error page is a few kB; anything this small is a miss.
      if (( bytes >= 10000 )); then
        echo "  $(basename "$file") — $bytes bytes"
        return 0
      fi
    fi
    echo "  attempt $attempt failed; retrying $file" >&2
  done
  echo "screenshot failed: $file" >&2
  return 1
}

CAPTURED=()

for LANG in "${LANGS[@]}"; do
  echo
  echo "=== $LANG ==="
  case "$LANG" in
    zh) QUERY="%E9%87%8D%E8%BF%9E%20backoff" ;; # 重连 backoff
    en) QUERY="reconnect%20backoff" ;;
  esac

  echo "seeding synthetic sessions ($LANG)"
  "$BUN" run "$FIXTURE" --lang "$LANG" "$SESSION_RECALL_DB"
  # Before anything photographs this index, prove it holds fixtures only.
  verify_fixture "after seeding"

  for THEME in "${THEMES[@]}"; do
    # A dark run writes beside the light one, never over it.
    if [[ "$THEME" == "dark" ]]; then DEST="$OUT/$LANG-dark"; else DEST="$OUT/$LANG"; fi
    mkdir -p "$DEST"

    echo
    echo "--- $LANG / $THEME theme -> ${DEST#"$ROOT"/} ---"

    PORT="$(first_free_port "${SR_PORT:-4399}")" || { echo "no free port near ${SR_PORT:-4399}; set SR_PORT" >&2; exit 1; }
    # Per language and theme, so a second run cannot collide with the one just
    # stopped — and never the real app's port (4319 by default), which may well
    # be in use.
    export SESSION_RECALL_PORT="$PORT"

    # Before the server exists, so the first paint of every shot already has the
    # theme and language this run is about.
    write_prefs "$THEME" "$LANG"

    # One Chrome for the whole run, so its DevTools port is picked once and every
    # language and theme photographs through the same browser.
    if [[ -z "$CHROME_PID" ]]; then
      CDP_PORT="$(first_free_port "$((PORT + 1))")" || { echo "no free DevTools port near $((PORT + 1))" >&2; exit 1; }
      start_chrome "$CDP_PORT"
    fi
    start_server "$PORT" "$LANG-$THEME"

    # The server scans every agent root on boot. Let that settle, then prove it
    # found nothing: the index may only still hold the sessions this script seeded.
    sleep 1
    verify_fixture "after the boot scan ($THEME)"

    BASE="http://127.0.0.1:$PORT"
    # 1. Search results for the language's own mixed-language query.
    set_prefs "$(view_theme "$THEME" search-results)" "$LANG"
    shoot "$DEST/search-results.png" "$BASE/#/search?q=$QUERY" \
      'document.querySelectorAll(".session-block").length > 0'
    # 2. One session, deep-linked to a question that sits below the fold, so the shot
    #    shows the ?turn= jump itself with its question and answer side by side.
    set_prefs "$(view_theme "$THEME" session-detail)" "$LANG"
    shoot "$DEST/session-detail.png" "$BASE/#/session/claude-code%3Ademo-ws-reconnect?turn=1&hit=user" \
      'document.querySelectorAll(".turn.is-target .is-hit").length > 0'
    # 3. Process scope: the tool calls and the errors behind the answers.
    set_prefs "$(view_theme "$THEME" process-search)" "$LANG"
    shoot "$DEST/process-search.png" "$BASE/#/search?q=timeout&scope=process" \
      'document.querySelectorAll(".session-block").length > 0'

    # Nothing the server or the browser did may have added a non-fixture session.
    verify_fixture "after the shots ($THEME)"

    stop_server
    CAPTURED+=("$DEST"/*.png)
  done
done

echo
echo "done — screenshots written:"
printf '%s\n' "${CAPTURED[@]}"
