# Cued Codebase Guide

## What This Is

Cued is a local-only message and contact datastore for agents.

Current runtime:

```text
native/macos/CuedNative (menu bar host, permissions, native windows)
        |
        v
repo root app (daemon, CLI, sync orchestration, projection)
        |
        v
~/.cued/local.db
```

## Active Code

```text
src/                Local daemon and CLI
native/
  macos/
    CuedNative/     macOS host app
  helpers/
    whatsapp-go/    Native WhatsApp helper
```

The Electron app and legacy shared packages are gone. Do not add new code against `@cued/*` packages.

## Behaviors

### DO

- Treat the repo root app as the canonical runtime.
- Keep data local to `~/.cued/local.db`.
- Prefer app-local utilities in `src/` instead of recreating a package layer.
- Run relevant tests when changing daemon, CLI, sync, or DB behavior.
- Run `swift build --package-path native/macos/CuedNative -c release` when changing the macOS host.

### DON'T

- Don't reintroduce Electron-only architecture.
- Don't add Convex/cloud assumptions to the active runtime.
- Don't modify generated or build output in `native/macos/dist/`.

## Key Files

| Feature               | Files                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| CLI entrypoint        | `src/cli.ts`                                                                                               |
| Daemon server         | `src/runtime/daemon/`                                                                                      |
| Platform auth/state   | `src/platforms/core/auth/`, `src/platforms/core/state/`                                                    |
| Platform implementations | `src/platforms/`                                                                                         |
| Database layer        | `src/db/`                                                                                                  |
| Diagnostics           | `src/runtime/doctor.ts`                                                                                    |
| macOS install helpers | `src/macos/install.ts`                                                                                     |
| App bundle build      | `scripts/build-cued-daemon-app.sh`                                                                         |
| DMG/signing           | `scripts/build-cued-dmg.sh`, `scripts/sign-and-notarize-cued-app.sh`                                       |
| Native host           | `native/macos/CuedNative/Sources/CuedNative/`                                                              |

## Commands

```bash
pnpm install
pnpm build
pnpm check:biome
pnpm typecheck
pnpm test
pnpm build:app:macos
swift build --package-path native/macos/CuedNative -c release
```

## Testing

```bash
pnpm test
swift build --package-path native/macos/CuedNative -c release
```

## Common Issues

| Problem                             | Solution                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| "Error accessing messages database" | Grant Full Disk Access to the app or terminal                    |
| "Contacts access denied"            | Grant Contacts access in System Settings                         |
| Native helper issues                | Rebuild the macOS app bundle and rerun `cued permissions doctor` |
