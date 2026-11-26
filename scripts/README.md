# Scripts

Local build, packaging, and macOS permission helpers for the packaged Cued runtime.

## Common development scripts

| Script | Purpose |
| ------ | ------- |
| `build-cued-daemon-app.sh` | Build `native/macos/dist/Cued.app` for local development and packaging checks. |
| `build-cued-dmg.sh` | Produce the signed/notarized DMG release artifact. |
| `create-cued-dmg.sh` | Create the drag-install DMG volume layout from an existing `Cued.app`. |
| `build-cued-tarball.sh` | Produce the signed/notarized Apple Silicon tarball release artifact. |
| `sign-and-notarize-cued-app.sh` | Sign and notarize the app bundle and helpers. |
| `install-cued-release.sh` | Install the latest GitHub release from the terminal. |
| `request-macos-access.sh` | Trigger or open the relevant macOS privacy prompts and panes. |
| `fetch-node-runtime-macos.sh` | Fetch the Node runtime bundled into the app. |
| `fetch-signal-cli-macos.sh` | Fetch the Signal helper payload bundled into the app. |

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
OAuth credentials into `Cued.app/Contents/Resources/oauth/google-oauth-client.json`. The stable
GitHub release workflow materializes this file from the `CUED_GOOGLE_OAUTH_CLIENT_JSON` secret and
fails the release if the secret is missing or malformed.

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

Other files in this directory are invoked directly from the root workspace scripts or local packaging flow.

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
