# Privacy

Cued is a local-only message and contact datastore for agents. It does not run a Cued-hosted cloud sync service for your data.

## Where Data Lives

Cued stores runtime state under `~/.cued/` on your Mac.

Important paths:

- `~/.cued/local.db`: canonical local SQLite database for synced events and projected state
- `~/.cued/logs/`: local daemon logs
- `~/.cued/attachments/`: local attachment cache when attachments are synced
- `~/.cued/browser/`: local browser/auth session state used by some integrations

Integration credentials are stored in the macOS Keychain when possible. This includes OAuth tokens, local session cookies, and captured account tokens used by integrations.

## What Cued Syncs

Cued syncs only the data needed for the integrations you connect. Depending on the platform, that can include contacts, conversations, messages, timestamps, participants, attachments, reactions, read-state metadata, and provider-specific IDs.

The current platform capability matrix is documented in the README and can be inspected locally:

```bash
cued integrations capabilities
```

## Gmail Status

Gmail support uses the read-only Gmail scope:

```text
https://www.googleapis.com/auth/gmail.readonly
```

Source builds can use a local Google OAuth desktop client JSON. Official Cued builds are waiting on Google OAuth approval before Gmail is presented as a normal no-credential user flow.

## Deleting Local Data

To remove Cued data from a machine:

1. Quit Cued.
2. Remove `~/.cued/`.
3. Remove Cued-related Keychain items if you connected integrations.
4. Remove `/Applications/Cued.app` or `~/Applications/Cued.app`.

Cued cannot delete copies that already exist in third-party messaging services.

## Reporting Privacy or Security Issues

Email `theo@cued.so`. Do not attach real local databases, raw message exports, tokens, cookies, or Keychain payloads to public GitHub issues.
