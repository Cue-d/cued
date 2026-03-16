# Cued

Local-only message and contact sync for agents.

## Product Direction

Cued is being rebuilt as a local-first system:

- the repo root package is the canonical daemon + CLI runtime
- `native/macos/CuedNative` is the macOS host app and permission identity
- `~/.cued/local.db` is the agent-facing SQLite database
- browser-session auth and sync are local only
- optional hooks live in `~/.cued/hooks.toml`

The old cloud web/mobile product is no longer part of the repo.

## Current Runtime

```text
native/macos/CuedNative (menu bar host, permissions, native windows)
        |
        v
repo root app (daemon, auth/session model, sync orchestration, projection)
        |
        v
~/.cued/local.db (raw events + projected canonical state)
```

## Prerequisites

| Requirement | Version                      | Check             |
| ----------- | ---------------------------- | ----------------- |
| Node.js     | 22+                          | `node --version`  |
| pnpm        | 10+                          | `pnpm --version`  |
| macOS       | 13+ (Apple Silicon)          | `sw_vers`         |
| Swift       | 6+                           | `swift --version` |
| Go          | 1.25.1+ (source builds only) | `go version`      |

## Quick Start

```bash
pnpm install
pnpm build
swift build --package-path native/macos/CuedNative -c release
GOWORK=off go build -C native/helpers/whatsapp-go

cued install
cued setup
```

Useful commands:

```bash
cued status
cued doctor
cued integrations status
cued sync run imessage
cued sync run contacts
```

## Permissions

Request macOS permissions with:

```bash
pnpm permissions:macos -- --all
```

Then verify:

```bash
cued permissions doctor
cued doctor
```

## Project Structure

```text
src/             Local daemon and CLI source
native/
  macos/
    CuedNative/  macOS host app, permissions, menu bar runtime
```

## Scripts

| Script                     | Description                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm build`               | Build the root app                                                                 |
| `pnpm dev`                 | Run the local CLI in dev mode                                                      |
| `pnpm check:biome`         | Run formatting, lint, and import checks                                            |
| `pnpm typecheck`           | Type check the root app                                                            |
| `pnpm test`                | Run the root app tests                                                             |
| `pnpm test:perf`           | Run synthetic sync/projection latency benchmarks                                   |
| `pnpm test:perf:daemon-memory` | Run the macOS daemon idle-memory benchmark                                    |
| `pnpm build:app:macos`     | Build the local `Cued.app` dev bundle                                              |
| `pnpm build:dmg:macos`     | Build signed/notarized release artifacts and output the DMG path                   |
| `pnpm build:tarball:macos` | Build signed/notarized release artifacts and output the Apple Silicon tarball path |
| `pnpm sign:notarize:macos` | Build signed/notarized release artifacts                                           |
| `pnpm permissions:macos`   | Open/request macOS permissions                                                     |

## Memory Benchmarking

Use the macOS daemon benchmark before and after each memory optimization:

```bash
pnpm build
pnpm test:perf:daemon-memory -- --scenario=clean --baseline=src/runtime/perf/daemon-memory-baseline.json
pnpm test:perf
```

Recommended workflow:

1. Benchmark `main` or the parent commit.
2. Implement one memory change only.
3. Rebuild with `pnpm build`.
4. Rerun `pnpm test:perf:daemon-memory`.
5. Run `pnpm test:perf`.
6. Attach a before/after delta table to the PR or commit notes.

Benchmark defaults:

- `clean_idle` is the required scenario for every memory change.
- `cloned_profile_idle` is available via `--scenario=cloned`, but it is informational until the cloned-profile startup failure is fixed.
- `--baseline=...` enables regression checks for startup latency, main RSS, tree RSS, physical footprint, and tree RSS spikes.
- `--write-baseline=...` updates the checked-in baseline after a merged improvement, not during experiments.

## Notes

- The root app is the only product runtime moving forward.
- The repo no longer ships the Electron app or the old shared/cloud packages.
- Internal release artifacts currently target Apple Silicon Macs only.
- The native macOS package currently has a build check but no dedicated Swift test target.
