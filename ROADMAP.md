# Roadmap

This file describes direction, not a guarantee of delivery dates.

## Current Distribution

GitHub Releases are the supported install path today.

Release artifacts:

- `Cued.dmg`
- `cued-macos-arm64.tar.gz`
- release metadata and checksums

## Planned Distribution

Homebrew is the preferred next install channel for macOS CLI/app installs. Before adding it, releases need stable tarball naming, checksums, and a formula that installs the app bundle and CLI symlink predictably.

npm may make sense later as a CLI installer wrapper or developer package. Cued should stay `private` in `package.json` until the package contents and install behavior are intentionally designed for npm.

## Integration Status

Ready for normal public use:

- Contacts
- Discord
- iMessage
- LinkedIn
- Signal
- Slack
- WhatsApp

Waiting on external approval:

- Gmail official-build OAuth flow

Source builds can still use local Gmail OAuth credentials while official-build approval is pending.

Deferred:

- Telegram

Telegram should return as a managed integration with release-injected app credentials, source-build credential overrides, and a clean local smoke test.
