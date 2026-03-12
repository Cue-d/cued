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
| `pnpm build:app:macos`     | Build the local `Cued.app` dev bundle                                              |
| `pnpm build:dmg:macos`     | Build signed/notarized release artifacts and output the DMG path                   |
| `pnpm build:tarball:macos` | Build signed/notarized release artifacts and output the Apple Silicon tarball path |
| `pnpm sign:notarize:macos` | Build signed/notarized release artifacts                                           |
| `pnpm permissions:macos`   | Open/request macOS permissions                                                     |

## Notes

- The root app is the only product runtime moving forward.
- The repo no longer ships the Electron app or the old shared/cloud packages.
- Internal release artifacts currently target Apple Silicon Macs only.
- The native macOS package currently has a build check but no dedicated Swift test target.
