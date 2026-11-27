# Cued Codebase Guide

This is the single guide for agents working in this repository. `CLAUDE.md` only points here.

## What This Is

Cued is a local-first message and contact datastore for agents.

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

## Repository Layout

```text
src/                Local daemon and CLI
native/
  macos/
    CuedNative/     macOS host app
  helpers/
    slack-go/       Native Slack helper
    whatsapp-go/    Native WhatsApp helper
scripts/            Packaging, release, benchmark and permission helpers (see scripts/README.md)
skills/cued/        Agent skill bundled into Cued.app
```

Signal's `signal-cli` and Java runtime are downloaded (pinned, SHA-256 verified) the first time
Signal is connected and stored under `~/.cued/helpers/signal-cli`. Set `CUED_BUNDLE_SIGNAL=1`
for `pnpm build:app:macos` to stage it into the app bundle instead
(`scripts/fetch-signal-cli-macos.sh`).

The Electron app and the old shared/cloud package layer are gone.

## Development Rules

### DO

- Treat the repo root app as the source of truth for runtime behavior.
- Keep data flow local, in `~/.cued/local.db`.
- Prefer app-local modules in `src/` over rebuilding a package abstraction.
- Run the relevant tests before shipping changes (daemon, CLI, sync and DB behavior: `pnpm test`).
- Run `swift build --package-path native/macos/CuedNative -c release` when changing the macOS host.

### DON'T

- Don't reintroduce Electron-only architecture or `@cued/*` shared packages.
- Don't add cloud sync, Convex, or web/mobile assumptions to the runtime.
- Don't modify generated app bundles or build output in `native/macos/dist/`.

## Key Files

| Feature                  | Files                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| CLI entrypoint           | `src/cli.ts`                                                                                  |
| Setup flow               | `src/setup.ts`                                                                                |
| Daemon                   | `src/runtime/daemon/`                                                                         |
| Platform auth/state      | `src/platforms/core/auth/`, `src/platforms/core/state/`                                       |
| Platform implementations | `src/platforms/`                                                                              |
| Database                 | `src/db/`                                                                                     |
| Diagnostics              | `src/runtime/doctor.ts`                                                                       |
| macOS install helpers    | `src/macos/install.ts`                                                                        |
| Helper binaries          | `native/helpers/slack-go/`, `native/helpers/whatsapp-go/`, `scripts/fetch-signal-cli-macos.sh` |
| App bundle build         | `scripts/build-cued-daemon-app.sh`                                                            |
| Release (entry point)    | `scripts/release-cued-macos.sh` (steps and credentials: `scripts/README.md`, "Releasing")     |
| Native host              | `native/macos/CuedNative/Sources/CuedNative/`                                                 |

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

`pnpm check:ci-local` (run by the pre-push hook) is `pnpm check:app-quality` plus the Swift build.

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

Other benchmarks (projection throughput, daemon memory) are listed in `scripts/README.md`,
"Benchmarks".

## Common Issues

| Problem                          | Solution                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| Messages DB access fails         | Grant Full Disk Access to the app or terminal                             |
| Contacts access denied           | Grant Contacts access in System Settings                                  |
| Permission prompts do not appear | Run `pnpm permissions:macos -- --all` or `cued permissions request --all` |
| Native helper issues             | Rebuild the macOS app bundle and rerun `cued permissions doctor`          |
