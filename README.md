<p align="center">
  <img src="native/macos/CuedNative/Resources/cued-mark.png" alt="Cued logo" width="120" />
</p>

# Cued

Local-only message and contact sync for agents.

[Releases](https://github.com/Cue-d/cued/releases) · [Installing](docs/installing.md) · [Development](docs/development.md)

## Install

For most people, install Cued from [GitHub Releases](https://github.com/Cue-d/cued/releases).

Recommended setup: install `Cued.dmg`, open the app, finish onboarding, then configure permissions and integrations in the app's onboarding and permissions UI or from the CLI if you prefer.

### Recommended: download the app

1. Open [GitHub Releases](https://github.com/Cue-d/cued/releases).
2. Download the latest `Cued.dmg`.
3. Drag `Cued.app` into `/Applications`.
4. Open `Cued.app`.
5. Complete onboarding and grant the requested macOS permissions.

What this does:

- installs the signed app bundle at a stable path macOS permissions can track
- opens the onboarding flow, which can configure the CLI symlink and login item for you
- keeps all runtime state local under `~/.cued/`

### Optional: terminal install from the latest release

```bash
curl -fsSL https://raw.githubusercontent.com/Cue-d/cued/main/scripts/install-cued-release.sh | bash
```

That installer downloads the latest release tarball from GitHub Releases, installs `Cued.app` into `/Applications` when writable or `~/Applications` otherwise, creates `~/.local/bin/cued`, and opens the app.

If `~/.local/bin` is not already on your `PATH`, add it before relying on the `cued` command.

## Quick Start

After the app is installed:

- use the onboarding flow and permissions UI in `Cued.app` to grant access and finish setup
- or use the CLI once onboarding has created the symlink in `~/.local/bin/cued`

CLI path:

```bash
cued doctor
cued integrations status
cued sync run imessage
cued sync run contacts
```

Use `cued setup` any time you want to revisit install state, permissions, and next actions from one screen.

### Verify the install

After onboarding has finished and the CLI symlink exists:

```bash
cued status
cued doctor
cued permissions doctor
cued integrations status
```

Expected local state after a successful install:

- `Cued.app` exists at `/Applications/Cued.app` or `~/Applications/Cued.app`
- `cued` points to the bundled CLI in `~/.local/bin/cued`
- `~/.cued/` exists for runtime state, logs, browser sessions, attachments, and hooks
- `~/.cued/local.db` is the canonical local SQLite database

More detail: [docs/installing.md](docs/installing.md)

## Runtime

Cued runs entirely on your Mac. The repo root app is the daemon and CLI, `native/macos/CuedNative` is the menu bar host and permission identity, and the canonical datastore lives in `~/.cued/local.db`.

```text
native/macos/CuedNative (menu bar host, permissions, native windows)
        |
        v
repo root app (daemon, CLI, sync orchestration, projection)
        |
        v
~/.cued/local.db (raw events + projected canonical state)
```

The old cloud web/mobile product is gone. Do not add new code against legacy `@cued/*` packages.

## Normalization

Adapters are platform-specific. The projector is not.

Cued normalizes platform data into one shared cross-platform event model so projection, replay, and rebuild do not branch on provider-specific schema names. Provider-specific detail stays in payload metadata or provenance.

## Platform Capability Matrix

This matrix documents current shipped behavior, not roadmap promises.

| Platform | Send | Receive | Realtime ingest | Full history sync | Message edits | Deletes | Reactions | Threads / replies | Read receipts | Attachments | Contact sync |
| -------- | ---- | ------- | --------------- | ----------------- | ------------- | ------- | --------- | ----------------- | ------------- | ----------- | ------------ |
| Contacts | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| iMessage | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ◐ | ✅ | ◐ |
| LinkedIn | ❌ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ |
| Signal | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ◐ |
| Slack | ❌ | ✅ | ✅ | ✅ | ◐ | ❌ | ◐ | ✅ | ❌ | ✅ | ✅ |
| WhatsApp | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ◐ | ✅ | ◐ |

Legend: `✅` supported, `◐` partial, `❌` unsupported.

The source of truth lives in `src/platforms/core/types.ts`. To inspect the current shipped matrix from the runtime, run:

```bash
cued integrations capabilities
```

LinkedIn history is currently partial: Cued imports inbox-visible threads and bounded per-conversation backfill, but not every archived or non-inbox thread.

## Install From Source

### Prerequisites

| Requirement | Version                      | Check             |
| ----------- | ---------------------------- | ----------------- |
| Node.js     | 22+                          | `node --version`  |
| pnpm        | 10+                          | `pnpm --version`  |
| macOS       | 13+ on Apple Silicon         | `sw_vers`         |
| Swift       | 6+                           | `swift --version` |
| Go          | 1.25.1+ for WhatsApp builds  | `go version`      |

### First install

```bash
pnpm install
pnpm build
swift build --package-path native/macos/CuedNative -c release
GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper

pnpm dev -- install
pnpm dev -- permissions request --all
pnpm dev -- setup
```

What each step does:

| Command | What it does |
| ------- | ------------ |
| `pnpm install` | Installs workspace dependencies and native Node modules such as `better-sqlite3`. |
| `pnpm build` | Compiles the root CLI and daemon into `dist/`. |
| `swift build --package-path native/macos/CuedNative -c release` | Builds the native macOS host/helper used for permissions, menu bar control, and native windows. |
| `GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper` | Builds the local WhatsApp helper in a path Cued can actually discover during development. |
| `pnpm dev -- install` | Uses the source CLI to build or refresh `Cued.app`, copy it into `/Applications/Cued.app`, and write the `~/.local/bin/cued` symlink for future invocations. |
| `pnpm dev -- permissions request --all` | Triggers Contacts and Messages automation prompts and opens Full Disk Access settings for the manual step macOS requires. |
| `pnpm dev -- setup` | Opens the interactive setup flow so you can verify permissions, install state, and next actions from one place. |

Once `pnpm dev -- install` has completed, you can switch to the installed `cued` command. If `~/.local/bin` is not already on your `PATH`, add it before relying on that symlink.

## Development

### Day-to-day commands

| Command | Description |
| ------- | ----------- |
| `pnpm dev -- help` | Run the CLI directly from source through `tsx`. |
| `pnpm build` | Rebuild the TypeScript CLI and daemon. |
| `pnpm typecheck` | Type check the root app. |
| `pnpm test` | Run the root app test suite. |
| `pnpm check:biome` | Run formatting, lint, and import checks. |
| `pnpm build:app:macos` | Rebuild the local `Cued.app` development bundle. |
| `swift build --package-path native/macos/CuedNative -c release` | Rebuild the native macOS host after Swift changes. |
| `pnpm permissions:macos -- --all` | Exercise the macOS permission helper without going through the CLI. |

### Contributor workflow

1. Run `pnpm install`.
2. Use `pnpm dev -- ...` for CLI-only iteration.
3. Rebuild with `pnpm build` before running the packaged CLI or app bundle.
4. Rebuild the native host with `swift build --package-path native/macos/CuedNative -c release` when touching `native/macos/CuedNative`.
5. Rebuild the WhatsApp helper with `GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper` when touching `native/helpers/whatsapp-go`.
6. Rebuild the packaged app with `pnpm build:app:macos` when changing packaging, permissions, or bundled runtime behavior.
7. Run `pnpm test` for root runtime changes, and also run the Swift build check when native code changed.

More detail: [docs/development.md](docs/development.md)

## Project Structure

```text
src/                Local daemon and CLI source
native/
  macos/
    CuedNative/     macOS host app
  helpers/
    slack-go/       Native Slack helper
    whatsapp-go/    Native WhatsApp helper
scripts/            Packaging, runtime fetch, signing, and permission helpers
```

Signal support ships as a bundled `signal-cli` payload fetched by `scripts/fetch-signal-cli-macos.sh` and staged into the app bundle.

## Packaging And Release Scripts

| Script                     | Description                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm build`               | Build the root app                                                                 |
| `pnpm dev`                 | Run the local CLI in dev mode                                                      |
| `pnpm check:biome`         | Run formatting, lint, and import checks                                            |
| `pnpm typecheck`           | Type check the root app                                                            |
| `pnpm test`                | Run the root app tests                                                             |
| `pnpm test:perf`           | Run synthetic sync/projection latency benchmarks                                   |
| `pnpm test:perf:daemon-memory` | Run the macOS daemon performance benchmark                                     |
| `pnpm build:app:macos`     | Build the local `Cued.app` dev bundle                                              |
| `pnpm build:dmg:macos`     | Build signed/notarized release artifacts and output the DMG path                   |
| `pnpm build:tarball:macos` | Build signed/notarized release artifacts and output the Apple Silicon tarball path |
| `pnpm sign:notarize:macos` | Build signed/notarized release artifacts                                           |
| `pnpm permissions:macos`   | Open/request macOS permissions                                                     |

More detail: [scripts/README.md](scripts/README.md)

## Daemon Benchmarking

Use the macOS daemon benchmark before and after each residency or scheduler optimization:

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

Benchmark scenarios:

- `clean_idle` is the required scenario for every memory change.
- `cloned_profile_idle` is available via `--scenario=cloned`, but it is informational until the cloned-profile startup failure is fixed.
- `idle_cpu_power` runs a 10-minute post-ready idle sample and captures CPU, process churn, and a best-effort power proxy.
- `active_sync_projection` runs replay-style sync + projection work and captures active CPU and memory behavior.
- `--baseline=...` enables regression checks for startup latency, main RSS, tree RSS, physical footprint, tree RSS spikes, and idle CPU.
- `--write-baseline=...` updates the checked-in baseline after a merged improvement, not during experiments.

Summary metrics emitted per scenario:

- `startupReadyMs`
- `mainRssMedianMb`
- `treeRssMedianMb`
- `physicalFootprintMb`
- `cpuMedianPct`
- `cpuP95Pct`
- `treeRssMaxMb`
- `processCount`
- `processChurnCount`
- `powerProxy` when available

## Notes

- The root app is the only supported runtime moving forward.
- Data stays local in `~/.cued`.
- Optional hooks live in `~/.cued/hooks.toml`.
- Internal release artifacts currently target Apple Silicon Macs only.
- The native macOS package currently has a build check but no dedicated Swift test target.
