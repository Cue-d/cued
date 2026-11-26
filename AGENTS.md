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
    slack-go/       Native Slack helper
    whatsapp-go/    Native WhatsApp helper
scripts/            Packaging plus bundled runtime/helper fetch scripts
```

Signal support ships as a bundled `signal-cli` payload fetched by `scripts/fetch-signal-cli-macos.sh` and staged into the app bundle.

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
| Helper binaries       | `native/helpers/slack-go/`, `native/helpers/whatsapp-go/`, `scripts/fetch-signal-cli-macos.sh`            |
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
swift test --package-path native/macos/CuedNative
```

## Responsiveness

The daemon is single-threaded and its SQLite calls are synchronous, so anything slow on its
thread stalls every request, and the app with it. `pnpm test:perf:responsiveness` starts an
isolated daemon on a real-scale database and fails (with `--assert`) if the event loop stalls
for more than 50 ms or a UI request takes more than 20 ms at p95.

```bash
pnpm build && pnpm test:perf:responsiveness --assert
# Against a private, temporary copy of a real database (deleted afterwards):
CUED_PERF_DB_KEY=... pnpm test:perf:responsiveness --db ~/.cued/local.db \
  --remove <platform:account> --toggle <platform:account>
```

Keep slow work off the daemon thread: bulk reads and background deletes go through the
database worker (`src/db/db-worker-jobs.ts`), anything that spawns a process is awaited rather
than run synchronously, and unavoidable work on the thread is done in slices of a few
milliseconds. When the loop does stall, the daemon logs `event loop stalled` with what it was
running.

## Common Issues

| Problem                             | Solution                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| "Error accessing messages database" | Grant Full Disk Access to the app or terminal                    |
| "Contacts access denied"            | Grant Contacts access in System Settings                         |
| Native helper issues                | Rebuild the macOS app bundle and rerun `cued permissions doctor` |
