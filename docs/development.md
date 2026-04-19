# Development

This repo is centered on the root app in `src/` plus the native macOS host in `native/macos/CuedNative`. There is no active Electron runtime and no cloud backend in the current product shape.

## Active code areas

```text
src/                Local daemon and CLI
native/
  macos/
    CuedNative/     macOS host app
  helpers/
    slack-go/       Native Slack helper
    whatsapp-go/    Native WhatsApp helper
```

Signal support uses a bundled `signal-cli` payload fetched by `scripts/fetch-signal-cli-macos.sh` and staged into the packaged app.

## Fast local loop

For most root-runtime work:

```bash
pnpm install
pnpm dev -- help
pnpm build
pnpm test
```

Use `pnpm dev -- <command>` to run the CLI directly from source through `tsx` when you do not need the packaged app bundle.

## When to rebuild which part

| Area changed | Rebuild or rerun |
| ------------ | ---------------- |
| `src/` TypeScript runtime | `pnpm build` and relevant CLI commands or tests |
| `native/macos/CuedNative/` | `swift build --package-path native/macos/CuedNative -c release` |
| `native/helpers/whatsapp-go/` | `GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper` |
| Packaging, bundled runtime, permissions, app resources | `pnpm build:app:macos` |
| Markdown, formatting, imports | `pnpm check:biome` |

## Validation

Minimum checks for most root app changes:

```bash
pnpm check:biome
pnpm build
pnpm typecheck
pnpm test
```

When the native macOS host changed, also run:

```bash
swift build --package-path native/macos/CuedNative -c release
```

## Local runtime and data

Important local paths:

- `~/.cued/local.db` for the canonical database
- `~/.cued/cued.sock` for daemon communication
- `~/.cued/logs/daemon.log` for daemon logs
- `~/.cued/hooks.toml` for optional local hook configuration

Useful commands while debugging:

```bash
cued status
cued doctor
cued logs
cued integrations status
cued sync run imessage
cued sync run contacts
```

## Packaged app development

Use the packaged app path when your change affects permissions, login items, bundling, or native app behavior:

```bash
pnpm build:app:macos
pnpm dev -- install
cued login-item enable
cued permissions request --all
```

`pnpm build:app:macos` creates `native/macos/dist/Cued.app`. On a first run, use `pnpm dev -- install` so the source CLI can create the installed app and the `~/.local/bin/cued` symlink. After that bootstrap step, `cued install` is fine for refreshing `/Applications/Cued.app`, which is the stable path Cued expects for macOS privacy and login-item behavior.

## Release-oriented scripts

These are not part of the normal inner loop, but they matter when validating packaging:

- `pnpm build:dmg:macos`
- `pnpm build:tarball:macos`
- `pnpm sign:notarize:macos`

See [../scripts/README.md](../scripts/README.md) for the script-level details.
