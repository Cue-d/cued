# Cued Codebase Guide

## What This Is

Cued is a local-first message and contact datastore for agents.

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

## Active Repository Layout

```text
apps/
  cued/             Local daemon and CLI

native/
  macos/
    CuedNative/     macOS host app
  helpers/
    whatsapp-go/    Native WhatsApp helper
```

The repository no longer includes the Electron runtime or the old shared/cloud package layer.

## Development Rules

- Use `apps/cued` as the source of truth for active runtime behavior.
- Keep data flow local. Avoid introducing cloud sync, Convex, or web/mobile assumptions.
- Prefer local modules in `apps/cued/src/` over rebuilding a package abstraction.
- Do not modify generated app bundles in `native/macos/dist/`.
- Run the relevant tests before shipping changes.

## Key Files

| Feature | Files |
|---------|-------|
| CLI entrypoint | `apps/cued/src/cli.ts` |
| Setup flow | `apps/cued/src/setup.ts` |
| Daemon | `apps/cued/src/daemon/` |
| Integrations | `apps/cued/src/integrations/` |
| Database | `apps/cued/src/db/` |
| Diagnostics | `apps/cued/src/diagnostics/doctor.ts` |
| macOS install helpers | `apps/cued/src/macos/install.ts` |
| App bundle build | `scripts/build-cued-daemon-app.sh` |
| Packaging and signing | `scripts/build-cued-dmg.sh`, `scripts/build-cued-tarball.sh`, `scripts/sign-and-notarize-cued-app.sh` |
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
| Messages DB access fails | Grant Full Disk Access |
| Contacts access denied | Grant Contacts access in System Settings |
| Permission prompts do not appear | Run `pnpm permissions:macos -- --all` or `cued permissions request --all` |
