# Scripts

Local build, packaging, and macOS permission helpers for the packaged Cued runtime.

## Common development scripts

| Script | Purpose |
| ------ | ------- |
| `build-cued-daemon-app.sh` | Build `native/macos/dist/Cued.app` for local development and packaging checks. |
| `release-cued-macos.sh` | **The release entry point.** Checks, builds, signs, notarizes and (only with `--publish`) publishes. See [Releasing](#releasing). |
| `build-cued-release-artifacts.sh` | Release step: build, sign, notarize and staple `Cued.app`, `Cued.dmg` and the tarball. Called by `release-cued-macos.sh`. |
| `build-cued-release-metadata.mjs` | Release step: write `release.json` and `SHA256SUMS` for signed artifacts. Called by `release-cued-macos.sh`. |
| `validate-cued-release-artifact.sh` | Check a built `Cued.app` (contents, version, signature, bundled helpers). |
| `create-cued-dmg.sh` | Create the drag-install DMG volume layout from an existing `Cued.app`. |
| `build-cued-tarball.sh` | Run the release build and print the tarball path (same build as the release, no metadata or publish). |
| `install-cued-release.sh` | Install the latest GitHub release from the terminal. |
| `request-macos-access.sh` | Trigger or open the relevant macOS privacy prompts and panes. |
| `fetch-node-runtime-macos.sh` | Fetch the Node runtime bundled into the app. |
| `fetch-signal-cli-macos.sh` | Fetch the Signal helper payload bundled into the app. |
| `check-ci-local.sh` | `pnpm check:ci-local`: the app quality gate plus the Swift build. Run by the pre-push hook. |
| `bench-daemon-memory-macos.sh` | `pnpm test:perf:daemon-memory`: daemon memory, startup and idle CPU. See [Benchmarks](#benchmarks). |
| `smoke-auth-lifecycle.ts` | `pnpm smoke:auth-lifecycle`: connect / disconnect / remove / reconnect each integration against fake auth results. |
| `smoke-local-clean-macos.sh` | Interactive first-run check of a built `Cued.app` in a sandboxed home (needs a person to grant permissions). |
| `monitor-upstreams.mjs` | `pnpm monitor:upstreams`: report drift between pinned helper dependencies and their upstreams. |

## App bundle build

```bash
pnpm build:app:macos
```

This script builds the packaged development app at `native/macos/dist/Cued.app`. In practice it:

- rebuilds the root TypeScript runtime
- rebuilds the native Swift host
- stages production Node dependencies
- bundles the Node runtime (no browser: see [Sign-in browser](#sign-in-browser))
- bundles helper binaries such as the native macOS helper, Signal helper, and WhatsApp helper
- signs the app bundle for local execution

Set `CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE=/path/to/google-oauth-client.json` to bundle Gmail
OAuth credentials into `Cued.app/Contents/Resources/oauth/google-oauth-client.json`. Stable
releases require it: `release-cued-macos.sh` refuses to start without a valid file.

## Sign-in browser

Chromium is not bundled. Browser-based sign-ins (Slack, LinkedIn, Discord) open in a
Chromium-family browser that is already installed, tried in this order from `/Applications`
and then `~/Applications`: Google Chrome, Chromium, Microsoft Edge, Brave Browser. If one fails
to launch, the next is tried. Each browser gets its own Cued profile under
`~/.cued/browser/<platform>/<account>/<browser>`, separate from the person's own browser
profile, so their running browser is not touched.

When no installed browser works, Cued downloads the Chromium build pinned in
`packaging/chromium-runtime.json` (the build Playwright installs, from Playwright's CDN) into
`~/.cued/browsers/`, verifies its SHA-256, and uses it. The download reports progress in the
sign-in's auth session (`resultSummary.browserDownload`). `cued browser status` shows which
browser will be used; `cued browser install` downloads the fallback ahead of time;
`cued doctor` reports it as the `auth_browser` check. `CUED_CHROMIUM_EXECUTABLE_PATH` overrides
all of this with a single browser and never downloads.

When Playwright is upgraded, update the pin: take `revision` and `browserVersion` for
`chromium` from `playwright-core/browsers.json`, and the SHA-256 of both archives
(`chromium-mac-arm64.zip`, `chromium-mac.zip`). A unit test fails until the pin matches.
`validate-cued-release-artifact.sh` fails if a browser is bundled again.

## macOS Permissions

```bash
pnpm bootstrap:signal:macos
pnpm permissions:macos
pnpm permissions:macos -- --contacts
pnpm permissions:macos -- --full-disk-access --open-only
```

This bootstrap script will:

- trigger the Contacts permission prompt through the native macOS helper
- open the Full Disk Access pane when requested or when a prompt cannot be granted automatically

macOS does not allow scripts or apps to self-grant Full Disk Access. The script opens the correct pane and prints the manual steps instead.

## DMG layout

```bash
bash scripts/create-cued-dmg.sh native/macos/dist/Cued.app native/macos/dist/Cued.dmg
```

The release builder uses this helper after the app bundle has been built,
signed, and validated. The helper keeps the opened DMG volume intentionally
simple: `Cued.app` on the left, an `/Applications` alias on the right, icon
view, and no custom background asset. Keeping the layout script-only avoids a
checked-in binary `.DS_Store` while still making the manual drag-to-Applications
install path explicit.

## Releasing

Releases are built, signed, notarized and published from a Mac that holds the signing
credentials. There is no CI release workflow: GitHub-hosted runners have neither the Developer
ID identity nor the notary profile. One script runs every step in order:

```bash
bash scripts/release-cued-macos.sh --channel stable --version 0.2.0 --preflight-only
bash scripts/release-cued-macos.sh --channel stable --version 0.2.0
bash scripts/release-cued-macos.sh --channel stable --version 0.2.0 --notes-file notes.md --publish
```

(`pnpm release:macos -- <same arguments>` runs the same script.)

### Required environment

| Variable | Needed for | What it is |
| -------- | ---------- | ---------- |
| `CUED_CODESIGN_IDENTITY` | every release | Name or SHA-1 of a "Developer ID Application" identity in your keychain (`security find-identity -v -p codesigning`), e.g. `Developer ID Application: <Team Name> (<TEAMID>)`. |
| `CUED_NOTARY_PROFILE` | every release | Keychain profile created once with `xcrun notarytool store-credentials <profile-name>`. |
| `CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE` | `--channel stable` | Path to the Gmail OAuth desktop client JSON (`installed.client_id`, `installed.client_secret`). Keep it outside the repository. |
| `CUED_RELEASE_REPO` | optional | GitHub repository to publish to. Default `Cue-d/cued`. |

Never commit these values or paste them into issues, PRs or logs.

### Channels and versions

- `--channel stable`: a normal GitHub release, offered to every install. The version must be
  plain `X.Y.Z`.
- `--channel prerelease`: a GitHub prerelease. The app is built with the `internal` runtime
  channel, and only `internal` builds are offered prereleases by the updater. The version must
  carry a suffix, e.g. `0.2.0-internal.1`.
- `--channel stable --staged`: the same stable build and plain `X.Y.Z` version, published as a
  GitHub prerelease. Stable installs skip GitHub prereleases, so nobody is offered it until you
  promote the same artifacts with `gh release edit vX.Y.Z --prerelease=false --latest`. Use
  this to try a release on your own machine before everyone gets it.
- `--version` must equal `version` in `package.json`: bump it in a commit (and merge it to
  `main`) before releasing. The bundle version comes from `package.json`.

### What it does

1. **Preflight** (nothing is built yet; fails in seconds with the reason): arguments and
   version rules, Apple Silicon macOS and required tools, a clean working tree, the tag not
   already existing, the environment variables above, the signing identity present in the
   keychain, the notary profile usable (`xcrun notarytool history`), the OAuth client file
   valid (stable). With `--publish`, also `gh auth status`, no existing GitHub release for the
   tag, and `HEAD` already on `origin/main`. `--preflight-only` stops here.
2. **Quality gate**: `pnpm check:ci-local` (skip with `--skip-checks` only if it already
   passed on this commit).
3. **Build, sign, notarize**: `build-cued-release-artifacts.sh` builds `Cued.app`, signs every
   nested binary and the bundle with the hardened runtime, runs
   `validate-cued-release-artifact.sh`, creates and signs `Cued.dmg`, submits it to the notary
   service, staples app and DMG, and packs `cued-macos-arm64.tar.gz`.
4. **Validate** the signed app again with `validate-cued-release-artifact.sh`.
5. **Metadata**: `build-cued-release-metadata.mjs` writes `release.json` and `SHA256SUMS`
   (and refuses an ad-hoc signed app).
6. **Publish, only with `--publish`**: `gh release create v<version>` with the four files
   above, `--target` set to the built commit, `--prerelease` for the prerelease channel, and
   your `--notes-file`. Without `--publish` the script prints the exact `gh` command instead,
   so you can inspect the artifacts first.

### Verifying the result

```bash
bash scripts/validate-cued-release-artifact.sh native/macos/dist/Cued.app
(cd native/macos/dist && shasum -a 256 -c SHA256SUMS)
spctl --assess --type execute --verbose native/macos/dist/Cued.app
xcrun stapler validate native/macos/dist/Cued.dmg
```

## Benchmarks

| Command | Measures | Gate |
| ------- | -------- | ---- |
| `pnpm build && pnpm test:perf:responsiveness --assert` | Event-loop stalls and UI request latency on an isolated daemon at real scale, plus resting cost. | The responsiveness gate (see `AGENTS.md`). |
| `pnpm test:perf` | Synthetic sync-bundle and projection throughput (incremental, realtime, catch-up, 10k replay), in-process. | None by default. `--write-baseline=<file>` records a local baseline, `--baseline=<file>` fails on a >10% median regression against it. Baselines are machine-specific; do not commit one. |
| `pnpm build && pnpm test:perf:daemon-memory -- --scenario=clean --baseline=src/runtime/perf/daemon-memory-baseline.json` | Daemon startup time, RSS, physical footprint and idle CPU (`clean`), a 10-minute idle CPU/process-churn sample (`idle_cpu_power`), or memory during a contacts sync and rebuild (`active_sync_projection`). | `--baseline=<file>` fails on regression. |
| `pnpm exec tsx src/runtime/perf/projection-cache.ts [conversations] [events]` | Projection batch time against a large existing conversation table. | None; prints JSON. |

All of them run on temporary data directories with throwaway database keys. None reads
`~/.cued`, the Keychain database key, Messages or call history.

