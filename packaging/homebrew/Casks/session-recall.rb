# Homebrew cask for Session Recall.
#
# Lives in the tap at github.com/odinyu/homebrew-tap (Casks/session-recall.rb);
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
cask "session-recall" do
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
  # The bundle ships the CLI next to the shell binary. Linking it puts
  # `session-recall` on PATH, which is what makes `session-recall setup` and
  # `session-recall doctor` usable without typing a bundle path.
  binary "#{appdir}/Session Recall.app/Contents/MacOS/session-recall"

  zap trash: [
    "~/Library/Application Support/session-recall",
    "~/Library/Caches/com.odin.session-recall",
    "~/Library/WebKit/com.odin.session-recall",
  ]
end
