# The CLI/TUI/MCP binary, distributed as a formula.
#
# Why a formula and not a cask: Homebrew quarantines cask downloads
# (Library/Homebrew/cask/download.rb calls quarantine() explicitly) and never
# touches formula downloads. A quarantined ad-hoc-signed binary is the reason
# the cask needs that `xattr -dr com.apple.quarantine` line — a formula needs
# nothing: no notarization, no xattr, no Gatekeeper prompt.
#
# This is the source of truth; copy it into odinyu/homebrew-tap on release.
#
# No `depends_on "bun"`: bun ships 60 MB installed, our self-contained binary is
# 27 MB, and letting Homebrew upgrade bun independently would break the tool
# silently the day an API moves.
class SessionRecall < Formula
  desc "Local, read-only full-text recall across coding-agent sessions"
  homepage "https://github.com/odinyu/session-recall"
  version :latest
  sha256 :no_check
  license "MIT"

  # The asset names are stable across releases (`releases/latest/download/…`),
  # so `brew upgrade` picks up a new version without touching this file.
  on_macos do
    on_arm do
      url "https://github.com/odinyu/session-recall/releases/latest/download/session-recall_darwin-arm64.tar.gz"
    end
    on_intel do
      url "https://github.com/odinyu/session-recall/releases/latest/download/session-recall_darwin-x64.tar.gz"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/odinyu/session-recall/releases/latest/download/session-recall_linux-arm64.tar.gz"
    end
    on_intel do
      url "https://github.com/odinyu/session-recall/releases/latest/download/session-recall_linux-x64.tar.gz"
    end
  end

  def install
    bin.install "session-recall"
  end

  def caveats
    <<~EOS
      The index lives in the app data directory and fills on first run:
        session-recall scan

      Then, from a terminal:
        session-recall tui                 # the terminal UI
        session-recall search "keyword"    # one query, text or --json

      To let your coding agents search it too:
        session-recall setup
    EOS
  end

  test do
    # `--help` prints the command list and exits 1. Do NOT invoke the bare
    # binary here: with no subcommand it starts `serve` and blocks until killed.
    assert_match "usage", shell_output("#{bin}/session-recall --help 2>&1", 1)
  end
end
