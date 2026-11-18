# The macOS app, as a cask. The command line lives in the formula next door
# (Formula/session-recall.rb) — one token each, so the two never fight over
# /opt/homebrew/bin/session-recall.
#
# Lives in the tap at github.com/odinyu/homebrew-tap (Casks/session-recall-app.rb);
# this copy is the source of truth and is kept under version control with the
# app. After editing it here, copy it into the tap repo and push.
#
# Why a tap and not homebrew/cask: that repository requires the app to pass
# Homebrew's Gatekeeper checks without disabling or bypassing Gatekeeper. This
# build is ad-hoc signed and not notarized, so it is not eligible until there is
# a Developer ID certificate and a notarized release.
#
# version :latest + sha256 :no_check is deliberate. The release workflow
# publishes both zips under stable, version-less names, so this cask keeps
# working across releases and never needs a bump commit.
cask "session-recall-app" do
  version :latest
  sha256 :no_check

  on_arm do
    url "https://github.com/odinyu/session-recall/releases/latest/download/Session-Recall_macos-arm64.zip"
  end
  on_intel do
    url "https://github.com/odinyu/session-recall/releases/latest/download/Session-Recall_macos-intel.zip"
  end

  name "Session Recall"
  desc "Local, read-only search across AI coding-agent sessions"
  homepage "https://github.com/odinyu/session-recall"

  depends_on :macos

  app "Session Recall.app"

  zap trash: [
    "~/Library/Application Support/session-recall",
    "~/Library/Caches/com.odin.session-recall",
    "~/Library/WebKit/com.odin.session-recall",
  ]

  caveats <<~EOS
    This build is ad-hoc signed, so macOS quarantines it. The app opens anyway,
    but anything run out of the bundle will hang rather than fail until the
    attribute is cleared once:

      xattr -dr com.apple.quarantine "#{appdir}/Session Recall.app"

    For the command line and the terminal UI, install the formula instead — it
    is not quarantined and needs no such step:

      brew install odinyu/tap/session-recall
      session-recall tui
  EOS
end
