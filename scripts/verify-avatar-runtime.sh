#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Avatar Verification: shared utility tests =="
pnpm -C packages/shared test --run src/__tests__/avatar.test.ts src/__tests__/exports.test.ts

echo "== Avatar Verification: electron protocol/lookup tests =="
pnpm -C apps/electron test \
  src/main/platforms/contacts/__tests__/avatar-cache.test.ts \
  src/main/platforms/contacts/__tests__/avatar-lookup.test.ts

echo "== Avatar Verification: convex avatar merge/priority tests =="
pnpm -C packages/convex test --run tests/avatar-utils.test.ts tests/shared.test.ts

echo "== Avatar Verification: typechecks for touched apps/packages =="
pnpm -C apps/electron typecheck
pnpm -C packages/ui typecheck

cat <<'EOF'
Avatar verification checks passed.

Manual runtime smoke checklist:
1. Cued daemon: confirm projected contacts preserve preferred avatar URLs.
2. Electron reference app: confirm Contacts list/detail resolves local macOS avatar URLs.
EOF
