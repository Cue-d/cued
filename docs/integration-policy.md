# Integration Policy

Cued integrations handle private communications. New integrations should be boring, explicit, local-first, and easy to disable.

## Required Properties

Every integration must define:

- supported host operating systems
- auth method
- where credentials are stored
- what data is synced
- whether send is supported
- whether realtime ingest is supported
- historical sync completeness limits
- auth invalidation behavior
- local smoke-test steps

The source of truth for platform capabilities is `src/platforms/core/types.ts`.

## Data and Credentials

- Keep message and contact data local to `~/.cued/local.db`.
- Store tokens, cookies, OAuth refresh tokens, and session credentials in Keychain or equivalent platform secret storage.
- Do not commit app credentials, OAuth client secrets, tokens, cookies, browser profiles, test accounts, or local databases.
- Redact credentials and message content from logs.
- Prefer least-privilege scopes when the platform supports them.

## Auth Models

OAuth is preferred when the provider supports the required local desktop flow and scopes.

Browser/session capture is allowed only when it is explicitly documented, stored locally, and has clear invalidation handling.

QR or device-linking flows are acceptable when they are the platform's normal local-device model.

Shared or managed app credentials must be injected at release time or supplied through local environment/config overrides for source builds. They must not be committed.

## Telegram

Telegram is deferred for the public OSS launch.

The future acceptable shape is:

- Cued-owned Telegram app credentials injected into official release builds
- source-build overrides for user-provided `api_id` and `api_hash`
- QR or phone login after app credentials are available
- Keychain/local storage for sessions
- documented rate-limit and auth-invalidation behavior
- clean `CUED_HOME` smoke coverage before public enablement

Do not expose Telegram in onboarding, README, or the public capability matrix until that path works.
