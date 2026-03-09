#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILDER="$ROOT_DIR/scripts/build-cued-daemon-app.sh"
APP_BUNDLE="${1:-$ROOT_DIR/native/macos/dist/CuedDaemon.app}"
DMG_BUILDER="$ROOT_DIR/scripts/build-cued-dmg.sh"
DMG_PATH="$ROOT_DIR/native/macos/dist/CuedDaemon.dmg"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/sign-and-notarize-cued-app.sh [app-bundle-path]

Environment:
  CUED_CODESIGN_IDENTITY   Developer ID Application identity to use for codesign
  CUED_NOTARY_PROFILE      notarytool keychain profile name

Notes:
  - This script builds the app if needed.
  - It signs the app bundle and generated DMG.
  - It submits the DMG for notarization and staples both artifacts.
EOF
  exit 0
fi

if [[ -z "${CUED_CODESIGN_IDENTITY:-}" ]]; then
  echo "CUED_CODESIGN_IDENTITY is required" >&2
  exit 1
fi

if [[ ! -d "$APP_BUNDLE" ]]; then
  bash "$APP_BUILDER" >/dev/null
fi

codesign --force --deep --options runtime --sign "$CUED_CODESIGN_IDENTITY" "$APP_BUNDLE"

bash "$DMG_BUILDER" >/dev/null
codesign --force --sign "$CUED_CODESIGN_IDENTITY" "$DMG_PATH"

if [[ -n "${CUED_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$CUED_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler staple "$DMG_PATH"
fi

echo "$APP_BUNDLE"
echo "$DMG_PATH"
