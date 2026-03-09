#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILDER="$ROOT_DIR/scripts/build-cued-daemon-app.sh"
DIST_DIR="$ROOT_DIR/native/macos/dist"
APP_BUNDLE="$DIST_DIR/CuedDaemon.app"
DMG_PATH="$DIST_DIR/CuedDaemon.dmg"
STAGING_DIR="$DIST_DIR/dmg-staging"

if [[ ! -d "$APP_BUNDLE" ]]; then
  bash "$APP_BUILDER" >/dev/null
fi

rm -rf "$STAGING_DIR" "$DMG_PATH"
mkdir -p "$STAGING_DIR"
cp -R "$APP_BUNDLE" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "CuedDaemon" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

rm -rf "$STAGING_DIR"
echo "$DMG_PATH"
