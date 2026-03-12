#!/bin/sh
set -eu

if ! command -v git >/dev/null 2>&1; then
  exit 0
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  exit 0
fi

git config core.hooksPath .githooks
