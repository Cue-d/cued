# Contributing

Thanks for working on Cued. The project handles private local communication data, so changes should preserve local-only behavior, clear integration boundaries, and predictable migrations.

## Development Setup

Prerequisites:

- Node.js 24
- pnpm 10
- macOS 13+ on Apple Silicon for the packaged app path
- Swift 6 for native macOS changes
- Go 1.25.1+ for helper changes

Common setup:

```bash
pnpm install
pnpm build
pnpm test
```

For source CLI iteration:

```bash
pnpm dev -- help
```

For packaged app work:

```bash
pnpm build:app:macos
pnpm dev -- install
```

## Architecture Rules

- Treat the repo root app in `src/` as the canonical runtime.
- Keep user data local to `~/.cued/` and `~/.cued/local.db`.
- Store integration secrets in Keychain or equivalent platform secret storage.
- Prefer app-local utilities in `src/` over recreating a package layer.
- Do not add new code against legacy `@cued/*` packages.
- Do not reintroduce Electron or Convex/cloud assumptions.
- Do not modify generated or build output in `native/macos/dist/`.

## Integration Rules

New integrations must follow `docs/integration-policy.md`.

At minimum:

- document the auth model
- document what data is synced
- keep credentials out of the repo and logs
- use least privilege where the platform supports it
- make auth invalidation explicit
- include a clean local smoke path

Telegram is intentionally not part of the public integration surface right now. It should come back only as a managed integration with release-injected app credentials and source-build overrides.

## Tests

Minimum checks for most root runtime changes:

```bash
pnpm check:biome
pnpm build
pnpm typecheck
pnpm test
```

When native macOS code changes:

```bash
swift build --package-path native/macos/CuedNative -c release
```

When helper code changes, run the relevant helper tests or builds:

```bash
GOWORK=off go test ./...
GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper
```

## Pull Requests

Good PRs include:

- a focused description of the behavior change
- the tests or smoke checks run
- notes about migrations, permissions, auth, or local data changes
- screenshots only when UI changed and no private data is visible

Do not include real databases, message exports, local browser profiles, Keychain payloads, tokens, cookies, OAuth client secrets, or private logs.

## Contribution Licensing

Cued is licensed under Apache-2.0. Unless explicitly stated otherwise, contributions submitted to this repository are provided under the same license.

This project does not currently require a CLA or DCO sign-off.
