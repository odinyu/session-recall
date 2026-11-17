# Homebrew tap for Session Recall

```bash
brew tap odinyu/tap
brew trust odinyu/tap          # one-time: Homebrew 7 asks before loading a tap
brew install --cask session-recall
xattr -dr com.apple.quarantine "/Applications/Session Recall.app"
```

That last line is not optional. Homebrew quarantines what it downloads, and this
build is ad-hoc signed rather than notarized, so a quarantined copy cannot run
its command line: `session-recall` hangs instead of printing an error. Clearing
the attribute once is enough.

Then connect the agents on this Mac:

```bash
session-recall setup     # writes the MCP entry and the agent skill
session-recall doctor    # verifies, including a real MCP handshake
```

## What the cask gives you

- The app in `/Applications`, so **File → Check for Updates…** works.
- `session-recall` linked onto your PATH via `binary`, which is what makes
  `setup` and `doctor` usable without typing a bundle path.
- `brew upgrade` as the update path.

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
