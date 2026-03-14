#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${CUED_NODE_PATH:-$(command -v node)}"
PLAYWRIGHT_CLI="$ROOT_DIR/node_modules/.bin/playwright"
PLAYWRIGHT_CACHE_DIR="${CUED_PLAYWRIGHT_BROWSER_CACHE_DIR:-${TMPDIR:-/tmp}/cued-playwright-browsers}"

if [[ ! -x "$PLAYWRIGHT_CLI" ]]; then
  echo "Playwright CLI not found at $PLAYWRIGHT_CLI" >&2
  exit 1
fi

mkdir -p "$PLAYWRIGHT_CACHE_DIR"

PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_CACHE_DIR" \
  PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  "$PLAYWRIGHT_CLI" install chromium >/dev/null

PLAYWRIGHT_EXECUTABLE_PATH="$(
  cd "$ROOT_DIR"
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_CACHE_DIR" \
    "$NODE_BIN" -e 'const { chromium } = require("playwright"); process.stdout.write(chromium.executablePath());'
)"

if [[ -z "$PLAYWRIGHT_EXECUTABLE_PATH" || ! -x "$PLAYWRIGHT_EXECUTABLE_PATH" ]]; then
  echo "Could not resolve the installed Playwright Chromium executable" >&2
  exit 1
fi

PLAYWRIGHT_PAYLOAD_DIR="$(cd "$(dirname "$PLAYWRIGHT_EXECUTABLE_PATH")/../../.." && pwd)"
if [[ ! -d "$PLAYWRIGHT_PAYLOAD_DIR" ]]; then
  echo "Could not resolve the installed Playwright Chromium payload directory" >&2
  exit 1
fi

printf '%s\n' "$PLAYWRIGHT_PAYLOAD_DIR"
