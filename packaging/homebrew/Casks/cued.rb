cask "cued" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/theotarr/cued/releases/download/v#{version}/CuedDaemon.dmg"
  name "Cued"
  desc "Local-only relationship and message sync daemon for macOS"
  homepage "https://github.com/theotarr/cued"

  app "CuedDaemon.app"
  binary "#{appdir}/CuedDaemon.app/Contents/Resources/cued-cli", target: "cued"

  zap trash: [
    "~/.cued",
    "~/Library/LaunchAgents/dev.cued.daemon.plist",
  ]
end
