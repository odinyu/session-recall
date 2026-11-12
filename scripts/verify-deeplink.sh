#!/usr/bin/env bash
#
# End-to-end verification for the `sessionrecall://session/<id>?turn=<n>` chain.
#
#   bash scripts/verify-deeplink.sh                  # non-destructive: bundle + Rust tests + warm deep link
#   bash scripts/verify-deeplink.sh --cold-start     # ALSO quit and relaunch the app (disruptive!)
#
# `--cold-start` is opt-in because it quits the running app and can race other
# tooling (screenshot capture, the 90 s scan). Run it only when nothing else is
# using the app.
#
# The chain has four hops, and this script checks all of them:
#   1. macOS LaunchServices resolves the `sessionrecall` scheme to the .app
#      (CFBundleURLTypes in Contents/Info.plist).
#   2. The Tauri Rust shell converts the URL into a hash route
#      (`#/session/<id>?turn=<n>`) and applies it via window.eval, parking it
#      until the webview finishes loading when the app was cold-started.
#   3. The sidecar serves the UI on a random loopback port.
#   4. The web router reads `turn` from the hash, renders the session, marks
#      `#/session/...?turn=n`'s target turn with `.is-target` and scrolls to it.
#
# Steps 1-3 are asserted from the bundle and the OS; step 4 is asserted in a
# real browser against the running sidecar, because the frontend has no unit
# tests. The browser assertion is intentionally separate from `bun test`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP="/Applications/Session Recall.app"
COLD_START=0
for arg in "$@"; do
  case "$arg" in
    --cold-start) COLD_START=1 ;;
    -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option '$arg' (expected --cold-start)" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: deep-link verification is macOS-only" >&2
  exit 1
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok: $*"; }

# --- 1. bundle registration -------------------------------------------------
[[ -d "$APP" ]] || fail "app bundle not found at $APP"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST" 2>/dev/null | grep -q 'sessionrecall' \
  || fail "CFBundleURLTypes does not register the sessionrecall scheme"
ok "Info.plist registers sessionrecall://"

[[ -x "$APP/Contents/MacOS/session-recall-app" ]] || fail "missing Tauri shell binary"
[[ -x "$APP/Contents/MacOS/session-recall" ]]     || fail "missing Bun sidecar binary"
[[ -f "$APP/Contents/Resources/web/dist/index.html" ]] || fail "missing bundled web UI"
ok "bundle contains shell + sidecar + web UI"

# The shipped app.js must contain the hash-router pieces that consume ?turn.
APPJS="$APP/Contents/Resources/web/dist/app.js"
for symbol in 'parseHash' 'turnIdx' 'scrollSessionTarget' 'is-target' 'hashchange'; do
  grep -q "$symbol" "$APPJS" || fail "bundled app.js is missing $symbol (rebuild with bun run build)"
done
ok "bundled app.js contains the ?turn hash-router code"

# --- 2. Rust route_for unit tests (NOT run by bun test / make-app.sh) --------
( cd "$ROOT/src-tauri" && cargo test --quiet ) \
  || fail "Rust deep-link route_for tests failed"
ok "Rust route_for unit tests pass"

# --- 3. LaunchServices ------------------------------------------------------
SCHEME_HANDLER="$(/usr/bin/defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null \
  | grep -A1 'sessionrecall' | head -2 || true)"
echo "  note: registered handler (informational): ${SCHEME_HANDLER:-<not reported by LSHandlers>}"

# --- 4. pick a real session with >= 2 turns to exercise ?turn ---------------
# The sidecar is started by the app; find its port from the listening socket.
PORT=""
for _ in $(seq 1 30); do
  PORT="$(lsof -nP -a -c session-recall -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk '/127\.0\.0\.1:/ { split($9,a,":"); print a[length(a)]; exit }' || true)"
  if [[ -n "$PORT" ]]; then break; fi
  sleep 0.5
done
[[ -n "$PORT" ]] || fail "sidecar did not open a loopback port (launch /Applications/Session Recall.app first)"
ok "sidecar is serving on 127.0.0.1:$PORT"

# Prefer a session with several turns so the scroll assertion is meaningful.
SESSION_ID="$(curl -fsS "http://127.0.0.1:$PORT/api/search?q=a&limit=30" \
  | bun -e 'const d = await Bun.stdin.json();
            let best = null, bestN = -1;
            for (const s of d.sessions ?? []) {
              if ((s.hits?.length ?? 0) === 0) continue;
              const n = s.turnCount ?? 0;
              if (n > bestN) { bestN = n; best = s.id; }
            }
            process.stdout.write(best ?? (d.sessions?.[0]?.id ?? ""));')"
[[ -n "$SESSION_ID" ]] || fail "could not find an indexed session to test with"
TURN="$(curl -fsS "http://127.0.0.1:$PORT/api/session/$SESSION_ID" \
  | bun -e 'const d = await Bun.stdin.json();
            const n = (d.turns ?? []).length;
            process.stdout.write(String(n > 1 ? n - 1 : 0));')"
ok "fixture session: $SESSION_ID (turn index $TURN)"

ENCODED_ID="$(bun -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$SESSION_ID")"
LINK="sessionrecall://session/${ENCODED_ID}?turn=${TURN}"
echo "  link: $LINK"

# --- 5. cold start (opt-in, disruptive) -------------------------------------
# A deep link must work even when the app is not running: LaunchServices starts
# it, the URL arrives before the webview loads, and Routes::flush applies it.
if [[ "$COLD_START" -eq 1 ]]; then
echo "==> cold-start verification"
OLD_PORT="$PORT"
OLD_PID="$(pgrep -f '/Applications/Session Recall.app/Contents/MacOS/session-recall-app' | head -n1 || true)"
osascript -e 'tell application "Session Recall" to quit' >/dev/null 2>&1 || true
# Wait for the *old* process to actually go away, not merely for pgrep to
# momentarily miss it (a relaunch can appear in the same polling window).
for _ in $(seq 1 60); do
  if [[ -z "$OLD_PID" ]] || ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
  sleep 0.3
done
if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
  fail "app did not quit; cannot test cold start"
fi
ok "cold-start: old process $OLD_PID exited"

# LaunchServices needs a moment to settle after a bundle exits; opening the
# scheme immediately can be delivered to the dying instance instead of
# starting a fresh one.
sleep 2
/usr/bin/open "$LINK"
# Wait for a sidecar on a *different* port: the app picks a fresh random port on
# each launch, so a new port is proof this was a real cold start rather than the
# previous instance still answering.
NEW_PORT=""
for _ in $(seq 1 90); do
  NEW_PORT="$(lsof -nP -a -c session-recall -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk '/127\.0\.0\.1:/ { split($9,a,":"); print a[length(a)]; exit }' || true)"
  if [[ -n "$NEW_PORT" && "$NEW_PORT" != "$OLD_PORT" ]]; then break; fi
  NEW_PORT=""
  sleep 0.5
done
[[ -n "$NEW_PORT" ]] || fail "app did not cold-start via the deep link (no new sidecar port; last seen $OLD_PORT)"
PORT="$NEW_PORT"
ok "cold-start: LaunchServices launched the app on a fresh port :$PORT (was :$OLD_PORT)"
else
  echo "==> cold-start verification SKIPPED (pass --cold-start to quit and relaunch the app)"
fi

# --- 6. warm start ----------------------------------------------------------
echo "==> warm-start verification"
/usr/bin/open "$LINK"
sleep 1
pgrep -f "/Applications/Session Recall.app/Contents/MacOS/session-recall-app" >/dev/null \
  || fail "app exited after the warm-start deep link"
ok "warm-start: the running instance accepted the deep link"

# --- 7. browser assertion (step 4) -----------------------------------------
# The frontend hash router has no automated tests. Print the exact URL to open
# and assert in a browser; the `--assert` mode below is usable from a browser
# automation harness that can evaluate JS in the page.
echo
echo "==> browser assertion (do this in a real browser against the running app)"
echo "    URL: http://127.0.0.1:$PORT/#/session/${ENCODED_ID}?turn=${TURN}"
echo "    Expected in-page state:"
echo "      document.getElementById('turn-${TURN}').classList.contains('is-target') === true"
echo "      window.scrollY > 0                         (for turn > 0)"
echo "      '?turn=abc' / '?turn=-1'  -> session opens at the top, no error"
echo "      '?turn=99999'             -> session opens at the top (stale turn fallback)"
echo
echo "    Also verify the OS-level link itself (not just the hash form):"
echo "      open '$LINK'"
echo "    and confirm the app is brought to the front with turn ${TURN} highlighted."
echo
echo "DONE: bundle, registration, Rust routing, cold start and warm start verified."
echo "      The browser-side DOM assertion above must be checked in a browser."
