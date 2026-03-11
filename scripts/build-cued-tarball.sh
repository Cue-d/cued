#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_BUILDER="$ROOT_DIR/scripts/build-cued-release-artifacts.sh"
DIST_DIR="$ROOT_DIR/native/macos/dist"
TARBALL_PATH="$DIST_DIR/cued-macos-arm64.tar.gz"

bash "$RELEASE_BUILDER" >/dev/null
echo "$TARBALL_PATH"
