# Cued Codebase Guide

## What This Is

Cued is a local-only message and contact datastore for agents.

Current runtime:

```text
native/macos/CuedNative (menu bar host, permissions, native windows)
        |
        v
apps/cued (daemon, CLI, sync orchestration, projection)
        |
        v
~/.cued/local.db
```

## Active Code

```text
apps/
  cued/             Local daemon and CLI

native/
  macos/
    CuedNative/     macOS host app
  helpers/
    whatsapp-go/    Native WhatsApp helper
```

The Electron app and legacy shared packages are gone. Do not add new code against `@cued/*` packages.

## Behaviors

### DO

- Treat `apps/cued` as the canonical runtime.
- Keep data local to `~/.cued/local.db`.
- Prefer app-local utilities in `apps/cued/src/` instead of recreating a package layer.
- Run relevant tests for `apps/cued` when changing daemon, CLI, sync, or DB behavior.
- Run `swift test --package-path native/macos/CuedNative` when changing the macOS host.

### DON'T

- Don't reintroduce Electron-only architecture.
- Don't add Convex/cloud assumptions to the active runtime.
- Don't modify generated or build output in `native/macos/dist/`.

## Key Files

| Feature | Files |
|---------|-------|
| CLI entrypoint | `apps/cued/src/cli.ts` |
| Daemon server | `apps/cued/src/daemon/` |
| Integrations and auth | `apps/cued/src/integrations/` |
| Database layer | `apps/cued/src/db/` |
| Diagnostics | `apps/cued/src/diagnostics/doctor.ts` |
| macOS install helpers | `apps/cued/src/macos/install.ts` |
| App bundle build | `scripts/build-cued-daemon-app.sh` |
| DMG/signing | `scripts/build-cued-dmg.sh`, `scripts/sign-and-notarize-cued-app.sh` |
| Native host | `native/macos/CuedNative/Sources/CuedNative/` |

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm build:app:macos
swift build --package-path native/macos/CuedNative -c release
```

## Testing

```bash
cd apps/cued && pnpm test
cd native/macos/CuedNative && swift test
```

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to the app or terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Native helper issues | Rebuild the macOS app bundle and rerun `cued permissions doctor` |
