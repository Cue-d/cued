#!/bin/bash
# Build the Swift contacts binary for development
# This script is run automatically before electron-vite dev

set -e

# Path to llm directory (inside prm monorepo)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_DIR="$SCRIPT_DIR/../../../llm"
BINARY_PATH="$LLM_DIR/.build/release/prm-contacts"

# Check if binary already exists
if [ -f "$BINARY_PATH" ]; then
  echo "[build-swift] prm-contacts binary already exists"
  exit 0
fi

# Check if llm directory exists
if [ ! -d "$LLM_DIR" ]; then
  echo "[build-swift] Warning: llm directory not found at $LLM_DIR"
  echo "[build-swift] Contacts sync will use fallback mode"
  exit 0
fi

echo "[build-swift] Building prm-contacts..."
cd "$LLM_DIR"
swift build -c release --product prm-contacts

if [ -f "$BINARY_PATH" ]; then
  echo "[build-swift] Successfully built prm-contacts"
else
  echo "[build-swift] Warning: Build completed but binary not found"
fi
