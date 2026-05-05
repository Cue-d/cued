# Scripts

Local build, packaging, and macOS permission helpers for the packaged Cued runtime.

## Common development scripts

| Script | Purpose |
| ------ | ------- |
| `build-cued-daemon-app.sh` | Build `native/macos/dist/Cued.app` for local development and packaging checks. |
| `build-cued-dmg.sh` | Produce the signed/notarized DMG release artifact. |
| `build-cued-tarball.sh` | Produce the signed/notarized Apple Silicon tarball release artifact. |
| `sign-and-notarize-cued-app.sh` | Sign and notarize the app bundle and helpers. |
| `install-cued-release.sh` | Install the latest GitHub release from the terminal. |
| `request-macos-access.sh` | Trigger or open the relevant macOS privacy prompts and panes. |
| `fetch-node-runtime-macos.sh` | Fetch the Node runtime bundled into the app. |
| `fetch-playwright-chromium-macos.sh` | Fetch the Chromium payload bundled into the app. |
| `fetch-signal-cli-macos.sh` | Fetch the Signal helper payload bundled into the app. |

## App bundle build

```bash
pnpm build:app:macos
```

This script builds the packaged development app at `native/macos/dist/Cued.app`. In practice it:

- rebuilds the root TypeScript runtime
- rebuilds the native Swift host
- stages production Node dependencies
- bundles the Node runtime and Chromium payload
- bundles helper binaries such as the native macOS helper, Signal helper, and WhatsApp helper
- signs the app bundle for local execution

## macOS Permissions

```bash
pnpm bootstrap:signal:macos
pnpm permissions:macos
pnpm permissions:macos -- --contacts --full-disk-access
pnpm permissions:macos -- --messages
pnpm permissions:macos -- --full-disk-access --open-only
```

This bootstrap script will:

- trigger the Contacts permission prompt through the native macOS helper
- open the Full Disk Access pane when requested
- trigger Apple Events automation access for Messages when explicitly requested

macOS does not allow scripts or apps to self-grant Full Disk Access. The script opens the correct pane and prints the manual steps instead.

Other files in this directory are invoked directly from the root workspace scripts or local packaging flow.
