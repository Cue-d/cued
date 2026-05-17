#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${1:-$ROOT_DIR/native/macos/dist/Cued.app}"
CLI_PATH="$APP_BUNDLE/Contents/Resources/cued-cli"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
RUNTIME_PATH="$APP_BUNDLE/Contents/Resources/cued-runtime"
SKILL_PATH="$APP_BUNDLE/Contents/Resources/skills/cued/SKILL.md"
EXPECTED_VERSION="${CUED_RELEASE_VERSION:-$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")}"
EXPECTED_TAG="${CUED_RELEASE_TAG:-v$EXPECTED_VERSION}"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Cued.app not found at $APP_BUNDLE" >&2
  exit 1
fi

if [[ ! -f "$CLI_PATH" ]]; then
  echo "Bundled cued-cli not found at $CLI_PATH" >&2
  exit 1
fi

if [[ ! -f "$SKILL_PATH" ]]; then
  echo "Bundled Cued skill missing at $SKILL_PATH" >&2
  exit 1
fi

if [[ ! -d "$RUNTIME_PATH/dist" || ! -d "$RUNTIME_PATH/node_modules" ]]; then
  echo "Bundled runtime is missing compiled JS or production dependencies at $RUNTIME_PATH" >&2
  exit 1
fi

for forbidden_path in \
  "$RUNTIME_PATH/scripts" \
  "$RUNTIME_PATH/src" \
  "$RUNTIME_PATH/native" \
  "$RUNTIME_PATH/skills" \
  "$RUNTIME_PATH/docs" \
  "$RUNTIME_PATH/bin" \
  "$RUNTIME_PATH/google-oauth-assets" \
  "$RUNTIME_PATH/packaging" \
  "$RUNTIME_PATH/.github" \
  "$RUNTIME_PATH/.husky" \
  "$RUNTIME_PATH/.turbo" \
  "$RUNTIME_PATH/AGENTS.md" \
  "$RUNTIME_PATH/CLAUDE.md" \
  "$RUNTIME_PATH/CONTRIBUTING.md" \
  "$RUNTIME_PATH/CODE_OF_CONDUCT.md" \
  "$RUNTIME_PATH/PRIVACY.md" \
  "$RUNTIME_PATH/ROADMAP.md" \
  "$RUNTIME_PATH/SECURITY.md" \
  "$RUNTIME_PATH/biome.json" \
  "$RUNTIME_PATH/pnpm-workspace.yaml" \
  "$RUNTIME_PATH/tsconfig.json" \
  "$RUNTIME_PATH/tsconfig.base.json" \
  "$RUNTIME_PATH/tsconfig.build.json" \
  "$RUNTIME_PATH/vitest.config.ts" \
  "$RUNTIME_PATH/.env.example" \
  "$RUNTIME_PATH/.nvmrc"; do
  if [[ -e "$forbidden_path" ]]; then
    echo "Development-only file shipped in bundled runtime: $forbidden_path" >&2
    exit 1
  fi
done

if find "$RUNTIME_PATH/dist" -type f \( -name '*.test.js' -o -name '*.js.map' \) | grep -q .; then
  echo "Bundled runtime contains test files or source maps under $RUNTIME_PATH/dist" >&2
  exit 1
fi

BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
if [[ "$BUNDLE_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Bundle version mismatch: expected $EXPECTED_VERSION, found $BUNDLE_VERSION" >&2
  exit 1
fi

HELP_OUTPUT="$("$CLI_PATH" help)"
if [[ "$HELP_OUTPUT" != *"cued skill install-global|status"* ]]; then
  echo "Bundled cued-cli help is missing the skill command" >&2
  exit 1
fi

SKILL_STATUS_OUTPUT="$("$CLI_PATH" skill status)"
if [[ "$SKILL_STATUS_OUTPUT" != *'"status"'* ]]; then
  echo "Bundled cued-cli skill status returned unexpected output" >&2
  exit 1
fi

echo "Validated $APP_BUNDLE for tag $EXPECTED_TAG and version $EXPECTED_VERSION"
