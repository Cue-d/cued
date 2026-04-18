#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/native/macos/dist/Cued.app"
RELEASE_BUILDER="$ROOT_DIR/scripts/build-cued-release-artifacts.sh"
DMG_PATH="$ROOT_DIR/native/macos/dist/Cued.dmg"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/sign-and-notarize-cued-app.sh

Environment:
  CUED_CODESIGN_IDENTITY   Developer ID Application identity to use for codesign
  CUED_NOTARY_PROFILE      notarytool keychain profile name

Notes:
  - This script builds signed release artifacts.
  - It requires both Developer ID signing and notarytool configuration.
EOF
  exit 0
fi

if [[ -z "${CUED_CODESIGN_IDENTITY:-}" ]]; then
  echo "CUED_CODESIGN_IDENTITY is required" >&2
  exit 1
fi

if [[ -z "${CUED_NOTARY_PROFILE:-}" ]]; then
  echo "CUED_NOTARY_PROFILE is required" >&2
  exit 1
fi

bash "$RELEASE_BUILDER" >/dev/null

echo "$APP_BUNDLE"
echo "$DMG_PATH"
