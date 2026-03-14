#!/bin/sh
set -eu

pnpm check:biome
pnpm build
pnpm typecheck
pnpm test
swift build --package-path native/macos/CuedNative -c release
