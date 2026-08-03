# Integration Policy

Cued integrations handle private communications. New integrations should be boring, explicit, local-first, and easy to disable.

## Required Properties

Every integration must define:

- supported host operating systems
- auth method
- where credentials are stored
- what data is synced
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

## X

X reuses [Birdclaw](https://github.com/steipete/birdclaw) as the collector. Birdclaw imports an X archive and can refresh supported data through `xurl`; Cued's bundled Go helper reads `~/.birdclaw/birdclaw.sqlite` without owning X credentials or a second X API client.

Run `birdclaw import archive ~/Downloads/twitter-archive.zip --json` first. Cued then imports DM contacts, conversations, messages, profiles, and current follower/following edges into `~/.cued/local.db`; mutual status and profile metrics live in `contact_sources.metadata_json`. Set `CUED_BIRDCLAW_DB_PATH` only when Birdclaw uses a non-default data directory. X sync remains manual by default because Birdclaw's live transports can use metered provider APIs; run `cued sync run x` explicitly.

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
