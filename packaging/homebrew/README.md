# Homebrew tap for Session Recall

```bash
brew install --cask odinyu/tap/session-recall
```

That is the whole install. It also links the `session-recall` CLI onto your
PATH, so the next step is:

```bash
session-recall setup     # connect the agents installed on this Mac
session-recall doctor    # verify, including a real MCP handshake
```

## Why install from a tap instead of downloading the zip

The GitHub release zip arrives quarantined and the build is ad-hoc signed, not
notarized, so opening it requires either right-click → Open or a terminal
command:

```bash
xattr -dr com.apple.quarantine "/Applications/Session Recall.app"
```

Homebrew downloads with curl, which sets no quarantine attribute, so the cask
path skips that step entirely.

## About this cask

- `version :latest` / `sha256 :no_check`: the releases use stable version-less
  asset names, so the cask never needs a bump. The trade-off is no checksum
  verification of the download.
- The cask is maintained by hand in the main repository at
  `packaging/homebrew/Casks/session-recall.rb` and copied here.
- Not in `homebrew/cask`: that repository requires the app to pass Gatekeeper's
  checks without bypassing Gatekeeper. A notarized build would qualify.
