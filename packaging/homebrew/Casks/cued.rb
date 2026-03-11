cask "cued" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/Cue-d/cued/releases/download/v#{version}/Cued.dmg"
  name "Cued"
  desc "Local-only relationship and message sync daemon for macOS"
  homepage "https://github.com/Cue-d/cued"

  app "Cued.app"
  binary "#{appdir}/Cued.app/Contents/Resources/cued-cli", target: "cued"

  zap trash: [
    "~/.cued",
    "~/Library/LaunchAgents/dev.cued.daemon.plist",
  ]
end
