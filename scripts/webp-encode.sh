#!/usr/bin/env bash
#
# Encode the site's WebP screenshot derivatives from the PNG shots in
# docs/screenshots/, using the browser's own WebP encoder.
#
# `sips` cannot write WebP on macOS and the ffmpeg here has no libwebp, so
# headless Chrome does it: scripts/webp-encode.html draws each PNG onto a canvas
# at the target width and encodes with canvas.toDataURL("image/webp", quality).
# The job list travels in the page's URL fragment; scripts/webp-encode-cdp.ts
# reads the encoded bytes back over the DevTools protocol; this script writes
# them to disk.
#
# One PNG can feed several sizes; the output name is
# `<stem><suffix>-<width>.webp`, matching what site/index.html references:
#
#   docs/screenshots/en/search-results.png
#     -> site/assets/screenshots/en/search-results-1440.webp
#     -> site/assets/screenshots/en/search-results-720.webp
#   docs/screenshots/en-dark/search-results.png
#     -> site/assets/screenshots/en/search-results-dark-1440.webp
#     -> site/assets/screenshots/en/search-results-dark-720.webp
#
# A file over --max-bytes is re-encoded a little lower in quality until it fits
# (never below 0.60); every file's final quality is printed, and the run fails
# rather than shipping something oversized. Source PNGs are never modified.
#
# Usage:
#   bash scripts/webp-encode.sh --src <png-dir> --out <webp-dir> [options]
#
# Options:
#   --suffix <s>       inserted before the size, e.g. -dark   (default none)
#   --quality <q>      WebP quality, 0–1                     (default 0.84)
#   --sizes <a,b>      widths to write                       (default 1440,720)
#   --max-bytes <n>    per-file ceiling                      (default 122880 = 120 KiB)
#
# Env overrides:
#   SR_CHROME     path to a Chrome/Chromium binary (auto-detected by default)
#   SR_CDP_PORT   first DevTools port to try for headless Chrome (default 4500)
#   SR_KEEP_TMP   1 keeps the temp dir (page dumps, chrome log) for inspection
#
# Requires macOS, Bun 1.3+ and a Chrome/Chromium build. Re-runnable: each output
# is replaced only once its bytes have been produced in full.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN:-bun}"
ENCODER="$ROOT/scripts/webp-encode.html"
CDP_CLIENT="$ROOT/scripts/webp-encode-cdp.ts"
SRC=""
OUT=""
SUFFIX=""
QUALITY="0.84"
SIZES="1440,720"
MAX_BYTES="122880"
MIN_QUALITY="0.60"
STEP="0.04"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="${2:-}"; shift 2 ;;
    --src=*) SRC="${1#--src=}"; shift ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --out=*) OUT="${1#--out=}"; shift ;;
    --suffix) SUFFIX="${2:-}"; shift 2 ;;
    --suffix=*) SUFFIX="${1#--suffix=}"; shift ;;
    --quality) QUALITY="${2:-}"; shift 2 ;;
    --quality=*) QUALITY="${1#--quality=}"; shift ;;
    --sizes) SIZES="${2:-}"; shift 2 ;;
    --sizes=*) SIZES="${1#--sizes=}"; shift ;;
    --max-bytes) MAX_BYTES="${2:-}"; shift 2 ;;
    --max-bytes=*) MAX_BYTES="${1#--max-bytes=}"; shift ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $1 (try --help)" >&2
      exit 2
      ;;
  esac
done

[[ -n "$SRC" && -n "$OUT" ]] || { echo "--src and --out are required (try --help)" >&2; exit 2; }
[[ -d "$SRC" ]] || { echo "no such source directory: $SRC" >&2; exit 1; }
[[ -f "$ENCODER" ]] || { echo "missing encoder page: $ENCODER" >&2; exit 1; }
[[ -f "$CDP_CLIENT" ]] || { echo "missing DevTools client: $CDP_CLIENT" >&2; exit 1; }
mkdir -p "$OUT"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}
need "$BUN"
need curl
need lsof

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

# `base64 -d` is GNU, `base64 -D` is BSD/macOS; openssl is the portable last
# resort. Probe with a known string rather than trusting the exit status, which
# some builds return even when they reject the flag.
decode_b64() {
  if [[ "$(printf 'aGVsbG8=' | base64 -d 2>/dev/null)" == "hello" ]]; then base64 -d
  elif [[ "$(printf 'aGVsbG8=' | base64 -D 2>/dev/null)" == "hello" ]]; then base64 -D
  else openssl base64 -d -A
  fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/session-recall-webp.XXXXXX")"
CHROME_PID=""
cleanup() {
  if [[ -n "$CHROME_PID" ]] && kill -0 "$CHROME_PID" 2>/dev/null; then
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
  fi
  if [[ "${SR_KEEP_TMP:-0}" == "1" ]]; then
    echo "kept temp dir: $WORK"
  else
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT INT TERM

SHOTS=()
while IFS= read -r png; do SHOTS+=("$png"); done < <(find "$SRC" -maxdepth 1 -name '*.png' -type f | sort)
if [[ ${#SHOTS[@]} -eq 0 ]]; then
  echo "no PNGs in $SRC" >&2
  exit 1
fi

# --- the job list: one line per (png, width) --------------------------------
# Columns: output name, absolute PNG path, target width, quality.
JOBS="$WORK/jobs.tsv"
: > "$JOBS"
IFS=',' read -r -a WIDTH_LIST <<< "$SIZES"
for png in "${SHOTS[@]}"; do
  stem="$(basename "$png" .png)"
  absolute="$(cd "$(dirname "$png")" && pwd)/$(basename "$png")"
  for width in "${WIDTH_LIST[@]}"; do
    printf '%s\t%s\t%s\t%s\n' "${stem}${SUFFIX}-${width}" "$absolute" "$width" "$QUALITY" >> "$JOBS"
  done
done

start_chrome() { # start_chrome <cdp-port>
  echo "starting headless Chrome (DevTools on port $1)"
  # The mock keychain and the disabled updater keep a fresh profile from blocking
  # on macOS dialogs or background work before the page runs.
  "$CHROME" --headless=new --disable-gpu --allow-file-access-from-files \
    --no-first-run --no-default-browser-check --disable-extensions \
    --disable-component-update --disable-background-networking \
    --use-mock-keychain --password-store=basic --hide-scrollbars \
    --user-data-dir="$WORK/chrome" --remote-debugging-port="$1" \
    about:blank > "$WORK/chrome.log" 2>&1 &
  CHROME_PID=$!

  local ready=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$1/json/version" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$CHROME_PID" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if [[ "$ready" != "1" ]]; then
    echo "headless Chrome did not report a DevTools endpoint; log follows:" >&2
    cat "$WORK/chrome.log" >&2
    exit 1
  fi
}

encode_pass() { # encode_pass <jobs.tsv> <tag> ; writes $WORK/index-<tag>.tsv
  local jobs="$1" tag="$2" json hash raw i=0
  json="$(awk -F'\t' '
    BEGIN { printf "[" }
    {
      if (NR > 1) printf ","
      printf "{\"out\":\"%s\",\"src\":\"file://%s\",\"width\":%s,\"quality\":%s}", $1, $2, $3, $4
    }
    END { printf "]" }
  ' "$jobs")"
  hash="$(printf '%s' "$json" | base64 | tr -d '\n')"
  raw="$WORK/records-$tag.tsv"

  if ! "$BUN" run "$CDP_CLIENT" "$CDP_PORT" "file://$ENCODER#$hash" > "$raw"; then
    echo "the encoder page did not finish (see above)" >&2
    exit 1
  fi

  : > "$WORK/index-$tag.tsv"
  local out width height quality bytes b64
  while IFS=$'\t' read -r out width height quality bytes b64; do
    [[ -n "$out" ]] || continue
    i=$((i + 1))
    printf '%s' "$b64" > "$WORK/$tag-$i.b64"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$out" "$width" "$height" "$quality" "$bytes" "$WORK/$tag-$i.b64" >> "$WORK/index-$tag.tsv"
  done < "$raw"
}

enforce_size() { # enforce_size <jobs.tsv> <index.tsv>
  local jobs="$1" index="$2" out width height quality bytes b64 src next
  : > "$WORK/retry.tsv"
  while IFS=$'\t' read -r out width height quality bytes b64; do
    [[ -n "$out" ]] || continue
    if (( bytes > MAX_BYTES )); then
      if awk -v q="$quality" -v m="$MIN_QUALITY" 'BEGIN { exit !(q > m) }'; then
        next="$(awk -v q="$quality" -v s="$STEP" -v m="$MIN_QUALITY" \
          'BEGIN { q = q - s; if (q < m) q = m; printf "%.2f", q }')"
        src="$(awk -F'\t' -v n="$out" '$1 == n { print $2; exit }' "$jobs")"
        printf '%s\t%s\t%s\t%s\n' "$out" "$src" "$width" "$next" >> "$WORK/retry.tsv"
        echo "  $out is $bytes bytes; retrying at quality $next" >&2
      else
        echo "  $out is $bytes bytes, over the $MAX_BYTES ceiling even at quality $quality" >&2
        SIZE_FAILED=1
      fi
      continue
    fi
    decode_b64 < "$b64" > "$OUT/$out.webp"
    printf '  %-42s %5sx%-4s q=%s  %7s bytes\n' "$out.webp" "$width" "$height" "$quality" "$bytes"
  done < "$index"
}

CDP_PORT="$(first_free_port "${SR_CDP_PORT:-4500}")" || {
  echo "no free DevTools port near ${SR_CDP_PORT:-4500}; set SR_CDP_PORT" >&2
  exit 1
}

echo "source:  ${SRC#"$ROOT"/} (${#SHOTS[@]} PNG)"
echo "output:  ${OUT#"$ROOT"/}"
echo "sizes:   $SIZES · quality $QUALITY · ceiling $MAX_BYTES bytes"

start_chrome "$CDP_PORT"

SIZE_FAILED=0
PASS=1
cp "$JOBS" "$WORK/pass.tsv"
while :; do
  encode_pass "$WORK/pass.tsv" "p$PASS"
  enforce_size "$WORK/pass.tsv" "$WORK/index-p$PASS.tsv"
  if [[ ! -s "$WORK/retry.tsv" ]]; then break; fi
  if (( PASS >= 4 )); then
    echo "still over the ceiling after $PASS passes; lower --quality" >&2
    SIZE_FAILED=1
    break
  fi
  PASS=$((PASS + 1))
  cp "$WORK/retry.tsv" "$WORK/pass.tsv"
done

if (( SIZE_FAILED )); then
  echo "one or more files exceed $MAX_BYTES bytes" >&2
  exit 1
fi
echo "wrote ${#WIDTH_LIST[@]} sizes × ${#SHOTS[@]} PNG into ${OUT#"$ROOT"/}"
