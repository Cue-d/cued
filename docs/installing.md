# Installing Cued

This guide covers both supported install paths: the normal GitHub Releases flow for users, and the source build flow for contributors.

Recommended path: install from [GitHub Releases](https://github.com/Cue-d/cued/releases), open `Cued.app`, complete onboarding, then use the CLI once `~/.local/bin/cued` exists.

## What gets installed

Both install paths result in:

- `/Applications/Cued.app` or `~/Applications/Cued.app` as the stable app bundle path macOS permissions attach to
- `~/.local/bin/cued` as a symlink to the bundled CLI inside the installed app
- `~/.cued/` as the local runtime home for logs, browser data, integration state, attachments, hooks, and updates
- `~/.cued/local.db` as the canonical local SQLite database

## Install from GitHub Releases

This is the default path for most users.

### Option 1: download the DMG

1. Open [GitHub Releases](https://github.com/Cue-d/cued/releases).
2. Download the latest `Cued.dmg`.
3. Drag `Cued.app` into `/Applications`.
4. Open `Cued.app`.
5. Complete onboarding and approve the requested permissions.

The app onboarding flow can configure the CLI symlink and login item automatically, so a DMG install does not require a terminal first.

### Option 2: terminal installer

```bash
curl -fsSL https://raw.githubusercontent.com/Cue-d/cued/main/scripts/install-cued-release.sh | bash
```

This installer:

- fetches the latest release tarball from `Cue-d/cued`
- installs `Cued.app` into `/Applications` if writable, otherwise `~/Applications`
- creates `~/.local/bin/cued`
- opens the installed app when finished

If `~/.local/bin` is not on your `PATH`, add it before using `cued` from the terminal.

## Grant macOS permissions

From the DMG flow, you can do this directly in the app onboarding flow. From the terminal installer flow, you can use either the app onboarding flow or the CLI:

```bash
cued permissions request --all
```

This performs three different actions:

- triggers the Contacts prompt through the native helper
- triggers the Messages Apple Events automation prompt through AppleScript
- opens the Full Disk Access pane and prints the manual step for granting it

macOS does not allow Cued to self-grant Full Disk Access. You must manually add and enable the installed app or binary shown by the command.

## Finish setup

If you installed from the DMG and stayed in the app UI, continue through onboarding. If you want the CLI-driven setup screen after the symlink exists, run:

```bash
cued setup
```

The setup TUI summarizes install state, daemon state, permissions, and next actions. It also points to follow-up commands such as:

- `cued login-item enable`
- `cued integrations connect slack default`
- `cued integrations connect linkedin default`

## Verify

After the app has created `~/.local/bin/cued`, you can verify the install from the terminal:

```bash
cued status
cued doctor
cued permissions doctor
cued integrations status
```

Useful checks:

- `cued status` confirms the daemon metadata and install metadata
- `cued doctor` summarizes permissions, helper availability, integrations, and recent local runtime state
- `cued permissions doctor` focuses on macOS permission readiness
- `cued integrations status` shows which local integrations are connected

## Install from source

Use this path when you are developing on the repo itself.

### Prerequisites

| Requirement | Version | Why it is needed |
| ----------- | ------- | ---------------- |
| Node.js | 22+ | Builds and runs the root daemon and CLI runtime. |
| pnpm | 10+ | Installs dependencies and drives the workspace scripts. |
| macOS | 13+ on Apple Silicon | Matches the current native packaging and release target. |
| Swift | 6+ | Builds the native host and macOS helper binaries. |
| Go | 1.25.1+ | Builds the WhatsApp helper when you want local WhatsApp support from source. |

### Build and install

```bash
pnpm install
pnpm build
swift build --package-path native/macos/CuedNative -c release
GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper
pnpm dev -- install
```

### Under the hood

`pnpm dev -- install` is the safest first-run entrypoint because the `cued` symlink does not exist yet. Under the hood, that command routes into the source CLI, which builds the packaged app bundle if needed and then installs it.

The packaging portion assembles `native/macos/dist/Cued.app`. It rebuilds the root app, rebuilds the Swift host, stages production dependencies, bundles the Node runtime, bundles the Playwright Chromium payload, pulls in helper binaries, and signs the resulting app bundle for local use.

The install portion copies that bundle into `/Applications/Cued.app` and refreshes the CLI symlink at `~/.local/bin/cued`. Keeping the installed app path stable matters because macOS privacy grants follow the app bundle identity and path.

If you want to exercise the script directly while developing, use:

```bash
pnpm permissions:macos -- --all
```

After `pnpm dev -- install` completes, you can use `cued permissions request --all` instead.

## Common problems

| Problem | Fix |
| ------- | --- |
| Not sure which asset to download | Use `Cued.dmg` if you are installing manually from the Releases page. |
| `cued: command not found` after install | Add `~/.local/bin` to `PATH` or invoke the bundled CLI directly from the installed app. |
| Contacts prompt does not appear | Re-run `cued permissions request --contacts` or open the Contacts privacy pane with `pnpm permissions:macos -- --contacts --open-only`. |
| Messages sync cannot read the database | Grant Full Disk Access to `/Applications/Cued.app` or the terminal you are using, then restart Cued. |
| WhatsApp helper is missing | Rebuild it with `GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper` or use the packaged app bundle. |
| The setup screen says the app is not installed | Run `pnpm dev -- install` again. |
