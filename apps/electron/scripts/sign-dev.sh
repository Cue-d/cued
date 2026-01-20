#!/bin/bash
# Sign native modules for development on macOS 26+
# Uses ad-hoc signing (no certificate required)

set -e

# Skip on non-macOS (codesign is macOS-only)
if [[ "$(uname)" != "Darwin" ]]; then
    echo "Skipping code signing (not macOS)"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MONOREPO_ROOT="$(dirname "$(dirname "$PROJECT_ROOT")")"

echo "Signing native modules for development..."

# Sign better-sqlite3 in pnpm hoisted location (handles any version)
find "$MONOREPO_ROOT/node_modules/.pnpm" -path "*/better-sqlite3/build/Release/better_sqlite3.node" -type f 2>/dev/null | while read -r node_file; do
    echo "Signing: $node_file"
    codesign --force --sign - "$node_file"
done

# Also sign any .node files directly in the electron app's node_modules (if not symlinked)
find "$PROJECT_ROOT/node_modules" -name "*.node" -type f 2>/dev/null | while read -r node_file; do
    echo "Signing: $node_file"
    codesign --force --sign - "$node_file" 2>/dev/null || true
done

echo "Done! Native modules are now ad-hoc signed for development."
