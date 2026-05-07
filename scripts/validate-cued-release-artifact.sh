#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${1:-$ROOT_DIR/native/macos/dist/Cued.app}"
CLI_PATH="$APP_BUNDLE/Contents/Resources/cued-cli"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
SKILL_PATH="$APP_BUNDLE/Contents/Resources/skills/cued/SKILL.md"
SKILL_ACTIONS_DIR="$APP_BUNDLE/Contents/Resources/skills/cued/actions"
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

REQUIRED_SKILL_ACTION_FILES=(
  contact.enrichment.recommend.json
  contact-enrichment-recommend.cjs
  contact.followup.recommend.json
  contact-followup-recommend.cjs
  contact.introduction.recommend.json
  contact-introduction-recommend.cjs
  contact.message.draft.json
  contact-message-draft.cjs
  contact.merge.json
  contact-merge.cjs
  contact.memory.add.json
  contact-memory-add.cjs
  contact.memory.stale.json
  contact-memory-stale.cjs
  conversation.followup.recommend.json
  conversation-followup-recommend.cjs
  conversation.summary.draft.json
  conversation-summary-draft.cjs
)

for file in "${REQUIRED_SKILL_ACTION_FILES[@]}"; do
  if [[ ! -f "$SKILL_ACTIONS_DIR/$file" ]]; then
    echo "Bundled Cued action file missing at $SKILL_ACTIONS_DIR/$file" >&2
    exit 1
  fi
done

BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
if [[ "$BUNDLE_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Bundle version mismatch: expected $EXPECTED_VERSION, found $BUNDLE_VERSION" >&2
  exit 1
fi

HELP_OUTPUT="$("$CLI_PATH" help)"
if [[ "$HELP_OUTPUT" != *"cued skill install-global|install-local [skill-root]|status|status-local [skill-name]"* ]]; then
  echo "Bundled cued-cli help is missing the skill command" >&2
  exit 1
fi

SKILL_STATUS_OUTPUT="$("$CLI_PATH" skill status)"
if [[ "$SKILL_STATUS_OUTPUT" != *'"status"'* ]]; then
  echo "Bundled cued-cli skill status returned unexpected output" >&2
  exit 1
fi

echo "Validated $APP_BUNDLE for tag $EXPECTED_TAG and version $EXPECTED_VERSION"
