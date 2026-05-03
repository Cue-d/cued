# Security Policy

Cued stores private communications and integration credentials locally, so please report security issues privately.

## Reporting a Vulnerability

Email security reports to `theo@cued.so`.

Please include:

- the affected version or commit
- the affected platform or integration
- reproduction steps or a proof of concept
- whether user message content, local databases, Keychain items, tokens, or attachments may be exposed

Do not open public GitHub issues for vulnerabilities. Do not include real `~/.cued/local.db` files, message exports, Keychain payloads, browser profiles, OAuth credentials, Slack cookies, Discord tokens, LinkedIn cookies, or Gmail tokens in public issues or pull requests.

## Supported Versions

Security fixes target the latest released Cued version and `main`. Older prerelease builds may not receive patches.

## Scope

In scope:

- local database confidentiality and integrity
- daemon and CLI access controls
- Keychain credential handling
- integration auth capture and refresh flows
- local attachment storage
- update, packaging, and signing behavior

Out of scope:

- attacks requiring an already compromised macOS account with unrestricted local access
- vulnerabilities in upstream messaging services outside Cued's control
- spam or abuse reports for third-party services

## Public Issue Hygiene

When filing normal bugs, redact logs before sharing them. Logs and screenshots can contain names, message snippets, workspace names, account IDs, or local filesystem paths.
