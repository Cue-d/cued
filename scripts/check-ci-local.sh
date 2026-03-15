#!/bin/sh
set -eu

pnpm check:app-quality

if [ "$(uname -s)" = "Darwin" ]; then
  pnpm check:native:macos
else
  printf '%s\n' "Skipping native macOS build on $(uname -s)."
fi
