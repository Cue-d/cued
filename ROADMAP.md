# Roadmap

This file describes direction, not a guarantee of delivery dates.

## Current Distribution

GitHub Releases are the supported install path today.

Release artifacts:

- `Cued.dmg`
- `cued-macos-arm64.tar.gz`
- release metadata and checksums

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
