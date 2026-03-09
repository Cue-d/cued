# Cued

Local-only message and contact sync for agents.

## Product Direction

Cued is being rebuilt as a local-first system:

- `apps/cued` is the canonical daemon + CLI runtime
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
apps/cued (daemon, auth/session model, sync orchestration, projection)
        |
        v
~/.cued/local.db (raw events + projected canonical state)
```

Reference-only legacy code still exists in `apps/electron` until local parity is complete.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 22+ | `node --version` |
| pnpm | 9+ | `pnpm --version` |
| macOS | 15+ | `sw_vers` |
| Swift | 6+ | `swift --version` |

## Quick Start

```bash
pnpm install
pnpm --dir apps/cued build
swift build --package-path native/macos/CuedNative -c release

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
apps/
  cued/          Local daemon and CLI
  electron/      Legacy reference implementation during cutover

native/
  macos/
    CuedNative/  macOS host app, permissions, menu bar runtime

packages/
  ai/            LLM tools and contact resolution
  convex/        Legacy cloud backend code, pending removal
  env/           Shared env schemas
  integrations/  Shared integration helpers
  shared/        Shared types and utilities
  ui/            Legacy shared UI package, pending removal
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm build` | Build the workspace |
| `pnpm typecheck` | Type check the workspace |
| `pnpm test` | Run tests |
| `pnpm build:app:macos` | Build `CuedDaemon.app` |
| `pnpm build:dmg:macos` | Build the DMG |
| `pnpm sign:notarize:macos` | Sign and notarize the app |
| `pnpm permissions:macos` | Open/request macOS permissions |

## Notes

- `apps/cued` is the only product runtime moving forward.
- `apps/electron` remains only as a migration reference until parity is complete.
- `packages/convex`, `packages/ui`, and other cloud-era code are still present but are not part of the local-only end state.
