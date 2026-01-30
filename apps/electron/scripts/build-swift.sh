#!/bin/bash
# Build the Swift contacts binary for development
# This script is run automatically before electron-vite dev

set -e

# Path to swift directory (inside apps/electron)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$SCRIPT_DIR/../swift"
BINARY_PATH="$SWIFT_DIR/.build/release/cued-contacts"

# Check if binary already exists
if [ -f "$BINARY_PATH" ]; then
  echo "[build-swift] cued-contacts binary already exists"
  exit 0
fi

# Check if swift directory exists
if [ ! -d "$SWIFT_DIR" ]; then
  echo "[build-swift] Warning: swift directory not found at $SWIFT_DIR"
  echo "[build-swift] Contacts sync will use fallback mode"
  exit 0
fi

echo "[build-swift] Building cued-contacts..."
cd "$SWIFT_DIR"
swift build -c release --product cued-contacts

if [ -f "$BINARY_PATH" ]; then
  echo "[build-swift] Successfully built cued-contacts"
else
  echo "[build-swift] Warning: Build completed but binary not found"
fi
