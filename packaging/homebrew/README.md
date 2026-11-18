# Homebrew tap for Session Recall

Two packages, because the two builds have genuinely different constraints.

## The terminal build is a formula — nothing to clear

```bash
brew tap odinyu/tap
brew trust odinyu/tap          # one-time: Homebrew 7 asks before loading a tap
brew install session-recall
session-recall scan            # build the index
session-recall tui             # or: session-recall setup, to wire up your agents
```

One self-contained binary with the CLI, the terminal UI and the MCP server. A
formula download is **not** quarantined (only `cask/download.rb` calls
`quarantine()`), so this path needs no notarization, no `xattr`, and no
`Gatekeeper` prompt. It also builds for Linux from the same source.

## The macOS app is a cask

```bash
brew install --cask session-recall-app
xattr -dr com.apple.quarantine "/Applications/Session Recall.app"
```

That last line is not optional. Homebrew quarantines what it downloads, and this
build is ad-hoc signed rather than notarized, so a quarantined copy cannot run
anything out of the bundle: a command run from it hangs instead of printing an
error. Clearing the attribute once is enough.

The cask ships the app only. The `session-recall` command comes from the formula
above — two packages sharing one binary name would fight over
`/opt/homebrew/bin/session-recall`.

## What each gives you

- **formula**: `session-recall` on your PATH (CLI, `tui`, `setup`, `doctor`,
  `mcp`), `brew upgrade` as the update path.
- **cask**: the app in `/Applications`, so **File → Check for Updates…** works.

## Regenerating the formula

A formula cannot use `sha256 :no_check` (cask-only), so the version and the four
per-architecture checksums are written out. After a release:

```bash
python3 scripts/bump_formula.py vX.Y.Z --tap
```

## About this cask

- `version :latest` / `sha256 :no_check`: the releases publish both zips under
  stable, version-less names, so the cask never needs a bump. The trade-off is
  no checksum verification of the download.
- Maintained by hand in the main repository at
  `packaging/homebrew/Casks/session-recall.rb` and copied here.
- Not in `homebrew/cask`: that repository requires the app to pass Gatekeeper's
  checks without bypassing Gatekeeper, and `--no-quarantine` no longer exists in
  Homebrew 7. A notarized build would qualify; until then a tap is the honest
  home for it.
