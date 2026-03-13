#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: bash scripts/fetch-node-runtime-macos.sh <node-version> <arch>" >&2
  exit 1
fi

NODE_VERSION="$1"
NODE_ARCH="$2"
CACHE_DIR="${CUED_NODE_RUNTIME_CACHE_DIR:-${TMPDIR:-/tmp}/cued-node-runtime}"
DIST_NAME="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
ARCHIVE_PATH="$CACHE_DIR/${DIST_NAME}.tar.gz"
RUNTIME_DIR="$CACHE_DIR/${DIST_NAME}"

mkdir -p "$CACHE_DIR"

if [[ ! -x "$RUNTIME_DIR/bin/node" ]]; then
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/${DIST_NAME}.tar.gz" \
    --output "$ARCHIVE_PATH"
  tar -xzf "$ARCHIVE_PATH" -C "$CACHE_DIR"
fi

printf '%s\n' "$RUNTIME_DIR"
