#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILDER="$ROOT_DIR/scripts/build-cued-daemon-app.sh"
DIST_DIR="$ROOT_DIR/native/macos/dist"
APP_BUNDLE="$DIST_DIR/Cued.app"
DMG_PATH="$DIST_DIR/Cued.dmg"
TARBALL_PATH="$DIST_DIR/cued-macos-arm64.tar.gz"
STAGING_DIR="$DIST_DIR/dmg-staging"

if [[ -z "${CUED_CODESIGN_IDENTITY:-}" ]]; then
  echo "CUED_CODESIGN_IDENTITY is required for shareable release artifacts" >&2
  exit 1
fi

if [[ -z "${CUED_NOTARY_PROFILE:-}" ]]; then
  echo "CUED_NOTARY_PROFILE is required for shareable release artifacts" >&2
  exit 1
fi

bash "$APP_BUILDER" >/dev/null
codesign --force --deep --options runtime --sign "$CUED_CODESIGN_IDENTITY" "$APP_BUNDLE"

rm -rf "$STAGING_DIR" "$DMG_PATH"
mkdir -p "$STAGING_DIR"
cp -R "$APP_BUNDLE" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "Cued" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

rm -rf "$STAGING_DIR"
codesign --force --sign "$CUED_CODESIGN_IDENTITY" "$DMG_PATH"
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$CUED_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP_BUNDLE"
xcrun stapler staple "$DMG_PATH"

rm -f "$TARBALL_PATH"
tar -czf "$TARBALL_PATH" -C "$DIST_DIR" "Cued.app"

echo "$APP_BUNDLE"
echo "$DMG_PATH"
echo "$TARBALL_PATH"
