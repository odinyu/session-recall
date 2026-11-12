#!/usr/bin/env bash
#
# Package Session Recall as a double-clickable macOS .app.
#
#   bash scripts/make-app.sh                 # host architecture only (fast)
#   bash scripts/make-app.sh --native        # the same thing, spelled out
#   bash scripts/make-app.sh --universal     # arm64 + x86_64 in one bundle
#   bash scripts/make-app.sh --arch <triple> # one specific slice:
#                                            #   aarch64-apple-darwin (Apple silicon)
#                                            #   x86_64-apple-darwin  (Intel)
#   bash scripts/make-app.sh --no-install    # build only, leave /Applications alone
#
# Steps: build the web UI, compile the Bun CLI into a self-contained sidecar
# binary — one per architecture for --universal/--arch, lipo'd into a single
# file for --universal — then let Tauri bundle it together with the UI, and
# install the result into /Applications so it is double-clickable from Finder
# and Spotlight.
#
# Build output: src-tauri/target/release/bundle/macos/Session Recall.app
#               src-tauri/target/<triple>/release/bundle/macos/Session Recall.app
#               src-tauri/target/universal-apple-darwin/release/bundle/macos/Session Recall.app
# Install path: /Applications/Session Recall.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="native"
ARCH=""
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --native)     MODE="native"; shift ;;
    --universal)  MODE="universal"; shift ;;
    --arch)       MODE="arch"; [[ $# -ge 2 ]] || { echo "error: --arch needs a triple" >&2; exit 1; }; ARCH="$2"; shift 2 ;;
    --arch=*)     MODE="arch"; ARCH="${1#*=}"; shift ;;
    --install)    INSTALL=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown option '$1' (expected --native, --universal, --arch <triple>, --no-install)" >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  arch)
    [[ "$ARCH" == "aarch64-apple-darwin" || "$ARCH" == "x86_64-apple-darwin" ]] || {
      echo "error: --arch expects aarch64-apple-darwin or x86_64-apple-darwin (got '$ARCH')" >&2
      exit 1
    }
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: make-app.sh only builds macOS bundles (found $(uname -s))" >&2
  exit 1
fi

# --- host triple ------------------------------------------------------------
TRIPLE="$(rustc -vV | awk '/^host: /{ print $2 }')"
if [[ -z "$TRIPLE" ]]; then
  echo "error: could not determine the host target triple from 'rustc -vV'" >&2
  exit 1
fi

# Tauri names external binaries "<name>-<target-triple>"; the Bun compiler wants
# its own platform label. Keep the two in sync.
bun_target_for() {
  case "$1" in
    aarch64-apple-darwin) echo "bun-darwin-arm64" ;;
    x86_64-apple-darwin)  echo "bun-darwin-x64" ;;
    *) return 1 ;;
  esac
}

# `lipo -create` needs both slices, so fail early with the fix instead of
# halfway through a multi-minute build.
require_rust_target() {
  command -v rustup >/dev/null 2>&1 || return 0
  if ! rustup target list --installed 2>/dev/null | grep -qx "$1"; then
    echo "error: rust target '$1' is not installed (run: rustup target add $1)" >&2
    exit 1
  fi
}

# `bun build --compile` assembles the executable through a ~63 MB scratch file
# named ".<hex>-00000000.bun-build" in the working directory and never removes
# it. Sweep it up after every compile; the pattern is bun-private, so nothing
# else can match.
sweep_bun_build() {
  rm -f "$ROOT"/*.bun-build "$ROOT"/.*.bun-build 2>/dev/null || true
}

compile_sidecar() {
  local triple="$1" bun_target out
  if ! bun_target="$(bun_target_for "$triple")"; then
    echo "error: no bun target for triple '$triple'" >&2
    exit 1
  fi
  out="src-tauri/binaries/session-recall-${triple}"
  echo "==> compiling sidecar for $triple (bun target: $bun_target)"
  # Cross-compiling fetches that architecture's Bun runtime on first use and
  # caches it under ~/.bun/install/cache, so --universal needs network once.
  bun build --compile --target="$bun_target" src/cli.ts --outfile "$out"
  chmod +x "$out"
  echo "    $(du -h "$out" | cut -f1)  $out"
  sweep_bun_build
}

run_tauri_build() {
  # The Tauri CLI binds the CI env var to its boolean `--ci` flag, so a value like
  # CI=1 (common in CI and agent shells) aborts the build with
  # "invalid value '1' for '--ci'", and an empty CI fails with
  # "a value is required for '--ci'". Only a real boolean is meaningful to it.
  if [[ -n "${CI+x}" && "$CI" != "true" && "$CI" != "false" ]]; then
    echo "note: ignoring non-boolean CI='$CI' for the Tauri CLI"
    unset CI
  fi
  local -a args=(--bundles app)
  if [[ -n "${1:-}" ]]; then
    args=(--target "$1" "${args[@]}")
  fi
  echo "==> bundling .app${1:+ for $1}"
  (cd src-tauri && cargo tauri build "${args[@]}")
}

# --- 1. web UI --------------------------------------------------------------
echo "==> mode: $MODE  (host: $TRIPLE)"
echo "==> building web UI"
bun run build

# --- 2/3. sidecar(s) + bundle ----------------------------------------------
mkdir -p src-tauri/binaries
APP=""

if [[ "$MODE" == "universal" ]]; then
  require_rust_target aarch64-apple-darwin
  require_rust_target x86_64-apple-darwin

  compile_sidecar aarch64-apple-darwin
  compile_sidecar x86_64-apple-darwin

  SIDECAR="src-tauri/binaries/session-recall-universal-apple-darwin"
  echo "==> lipo -create → $SIDECAR"
  lipo -create -output "$SIDECAR" \
    "src-tauri/binaries/session-recall-aarch64-apple-darwin" \
    "src-tauri/binaries/session-recall-x86_64-apple-darwin"
  chmod +x "$SIDECAR"
  echo "    $(du -h "$SIDECAR" | cut -f1)  $SIDECAR  [$(lipo -archs "$SIDECAR")]"

  run_tauri_build universal-apple-darwin
  APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Session Recall.app"
elif [[ "$MODE" == "arch" ]]; then
  # One slice only: Tauri names the external binary "<name>-<triple>", so a
  # per-arch sidecar is all it takes — no lipo.
  require_rust_target "$ARCH"
  compile_sidecar "$ARCH"
  run_tauri_build "$ARCH"
  APP="src-tauri/target/$ARCH/release/bundle/macos/Session Recall.app"
else
  compile_sidecar "$TRIPLE"
  run_tauri_build
  APP="src-tauri/target/release/bundle/macos/Session Recall.app"
fi

if [[ ! -d "$APP" ]]; then
  echo "error: expected bundle not found at $APP" >&2
  exit 1
fi

echo
echo "==> $APP"
echo "    size: $(du -sh "$APP" | cut -f1)"
for binary in "Contents/MacOS/session-recall-app" "Contents/MacOS/session-recall"; do
  if [[ -f "$APP/$binary" ]]; then
    echo "    $(lipo -archs "$APP/$binary")  $binary"
  fi
done

# --- install into /Applications ---------------------------------------------
if [[ "$INSTALL" -eq 1 ]]; then
  DEST="/Applications/Session Recall.app"
  echo
  echo "==> installing to $DEST"

  # Never delete through a symlink.
  if [[ -L "$DEST" ]]; then
    echo "error: $DEST is a symlink; refusing to replace it" >&2
    exit 1
  fi

  if [[ -e "$DEST" ]] && ! rm -rf "$DEST"; then
    echo "error: could not remove the existing $DEST" >&2
    echo "hint: quit the app first, or check its ownership" >&2
    exit 1
  fi

  # ditto, not cp: it preserves resource forks, ACLs and the ad-hoc signature
  # Tauri just applied to the bundle.
  ditto "$APP" "$DEST"

  if [[ ! -x "$DEST/Contents/MacOS/session-recall-app" ]]; then
    echo "error: $DEST does not look like a usable bundle after install" >&2
    exit 1
  fi

  if xattr -p com.apple.quarantine "$DEST" >/dev/null 2>&1; then
    echo "    note: cleared a quarantine flag introduced by this copy"
    xattr -dr com.apple.quarantine "$DEST"
  fi

  echo "    $DEST"
  echo "    size: $(du -sh "$DEST" | cut -f1)"
  for binary in "Contents/MacOS/session-recall-app" "Contents/MacOS/session-recall"; do
    if [[ -f "$DEST/$binary" ]]; then
      echo "    $(lipo -archs "$DEST/$binary")  $binary"
    fi
  done
  echo
  echo "    open \"$DEST\"   # or double-click it in Finder / Spotlight"
else
  echo
  echo "==> --no-install: built at $APP but not installed"
fi
