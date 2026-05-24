#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Cued release install is only supported on macOS right now." >&2
  exit 1
fi

REPO="Cue-d/cued"
CHANNEL="stable"
API_BASE="https://api.github.com"
APP_NAME="Cued.app"
TARBALL_NAME="cued-macos-arm64.tar.gz"
DESTINATION=""
OPEN_APP="1"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cued-install.XXXXXX")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel|--release-channel)
      CHANNEL="${2:-}"
      shift 2
      ;;
    --destination)
      DESTINATION="${2:-}"
      shift 2
      ;;
    --no-open)
      OPEN_APP="0"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$CHANNEL" in
  stable|internal) ;;
  *)
    echo "Unsupported Cued release channel: $CHANNEL" >&2
    exit 1
    ;;
esac

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Cued internal releases currently support Apple Silicon Macs only." >&2
  exit 1
fi

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

pick_destination() {
  if [[ -n "$DESTINATION" ]]; then
    printf '%s\n' "$DESTINATION"
    return
  fi

  if [[ -w /Applications ]]; then
    printf '/Applications/%s\n' "$APP_NAME"
  else
    printf '%s/Applications/%s\n' "$HOME" "$APP_NAME"
  fi
}

validate_app_bundle() {
  local app_path="$1"

  if [[ ! -d "$app_path" ]]; then
    echo "Release archive did not contain ${APP_NAME}" >&2
    exit 1
  fi

  if [[ ! -x "$app_path/Contents/Resources/cued-cli" ]]; then
    echo "Release archive did not contain an executable bundled Cued CLI" >&2
    exit 1
  fi

  local bundle_version
  bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$bundle_version" != "$VERSION" ]]; then
    echo "Bundle version mismatch: expected ${VERSION}, found ${bundle_version:-unknown}" >&2
    exit 1
  fi

  codesign --verify --deep --strict "$app_path" >/dev/null
  spctl --assess --type execute "$app_path" >/dev/null
}

release_json_path="$TMP_DIR/releases.json"
curl -fsSL -H 'Accept: application/vnd.github+json' "${API_BASE}/repos/${REPO}/releases" -o "$release_json_path"

release_info="$(python3 - "$CHANNEL" "$release_json_path" <<'PY'
import json
import sys

channel = sys.argv[1]
desired_prerelease = channel != "stable"
with open(sys.argv[2], encoding="utf-8") as handle:
    releases = json.load(handle)
release = next((r for r in releases if bool(r.get("prerelease")) == desired_prerelease), None)
if release is None and releases:
    release = releases[0]
if release is None:
    raise SystemExit("No GitHub releases found for Cued")

assets = {asset.get("name"): asset.get("browser_download_url") for asset in release.get("assets", [])}
tarball = assets.get("cued-macos-arm64.tar.gz")
if not tarball:
    raise SystemExit("Latest release is missing cued-macos-arm64.tar.gz")

print(release.get("tag_name", "").lstrip("v"))
print(tarball)
print(release.get("html_url", ""))
PY
)"

VERSION="$(printf '%s\n' "$release_info" | sed -n '1p')"
TARBALL_URL="$(printf '%s\n' "$release_info" | sed -n '2p')"
RELEASE_URL="$(printf '%s\n' "$release_info" | sed -n '3p')"
ARCHIVE_PATH="$TMP_DIR/$TARBALL_NAME"
STAGING_DIR="$TMP_DIR/staging"
TARGET_APP="$(pick_destination)"

echo "Installing Cued ${VERSION} from ${RELEASE_URL}"
curl -fsSL "$TARBALL_URL" -o "$ARCHIVE_PATH"
mkdir -p "$STAGING_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$STAGING_DIR"

SOURCE_APP="$STAGING_DIR/$APP_NAME"
validate_app_bundle "$SOURCE_APP"

mkdir -p "$(dirname "$TARGET_APP")"
mkdir -p "$TARGET_APP"
rsync -a --delete "${SOURCE_APP}/" "${TARGET_APP}/"

mkdir -p "$HOME/.local/bin"
ln -sf "$TARGET_APP/Contents/Resources/cued-cli" "$HOME/.local/bin/cued"

if [[ "$OPEN_APP" == "1" ]]; then
  open "$TARGET_APP"
fi

echo "Installed: $TARGET_APP"
echo "CLI: $HOME/.local/bin/cued"
