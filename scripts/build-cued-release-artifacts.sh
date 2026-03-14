#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILDER="$ROOT_DIR/scripts/build-cued-daemon-app.sh"
DIST_DIR="$ROOT_DIR/native/macos/dist"
APP_BUNDLE="$DIST_DIR/Cued.app"
DMG_PATH="$DIST_DIR/Cued.dmg"
TARBALL_PATH="$DIST_DIR/cued-macos-arm64.tar.gz"
STAGING_DIR="$DIST_DIR/dmg-staging"
JIT_RUNTIME_ENTITLEMENTS="$ROOT_DIR/scripts/packaging/jit-runtime.entitlements.plist"
APP_PERMISSIONS_ENTITLEMENTS="$ROOT_DIR/scripts/packaging/app-permissions.entitlements.plist"

if [[ -z "${CUED_CODESIGN_IDENTITY:-}" ]]; then
  echo "CUED_CODESIGN_IDENTITY is required for shareable release artifacts" >&2
  exit 1
fi

if [[ -z "${CUED_NOTARY_PROFILE:-}" ]]; then
  echo "CUED_NOTARY_PROFILE is required for shareable release artifacts" >&2
  exit 1
fi

runtime_entitlements_for_binary() {
  local target="$1"

  case "$target" in
    "$APP_BUNDLE/Contents/MacOS/CuedDaemon")
      printf '%s\n' "$APP_PERMISSIONS_ENTITLEMENTS"
      ;;
    "$APP_BUNDLE/Contents/Resources/runtime/node/bin/node"|\
    "$APP_BUNDLE/Contents/Resources/helpers/signal-cli/jre/Contents/Home/bin/java")
      printf '%s\n' "$JIT_RUNTIME_ENTITLEMENTS"
      ;;
  esac
}

sign_macos_binary() {
  local target="$1"
  local entitlements="${2:-}"

  if [[ -n "$entitlements" ]]; then
    codesign \
      --force \
      --timestamp \
      --options runtime \
      --entitlements "$entitlements" \
      --sign "$CUED_CODESIGN_IDENTITY" \
      "$target"
    return
  fi

  codesign \
    --force \
    --timestamp \
    --options runtime \
    --sign "$CUED_CODESIGN_IDENTITY" \
    "$target"
}

sign_nested_binaries() {
  local entitlements

  while IFS= read -r -d '' path; do
    if file -b "$path" | grep -q "Mach-O"; then
      entitlements="$(runtime_entitlements_for_binary "$path")"
      sign_macos_binary "$path" "$entitlements"
    fi
  done < <(find "$APP_BUNDLE/Contents" -type f -print0 | sort -rz)
}

sign_archive_macos_binaries() {
  local archive="$1"
  local archive_abs
  local temp_dir
  local updated=0
  local -a entries=()

  archive_abs="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
  while IFS= read -r entry; do
    entries+=("$entry")
  done < <(zipinfo -1 "$archive_abs" | grep -E '\.(dylib|jnilib|node|so)$' || true)
  if [[ "${#entries[@]}" -eq 0 ]]; then
    return
  fi

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/cued-archive-sign.XXXXXX")"
  for entry in "${entries[@]}"; do
    unzip -qq "$archive_abs" "$entry" -d "$temp_dir"
    if file -b "$temp_dir/$entry" | grep -q "Mach-O"; then
      sign_macos_binary "$temp_dir/$entry"
      updated=1
    fi
  done

  if [[ "$updated" -eq 1 ]]; then
    (cd "$temp_dir" && zip -q -X "$archive_abs" "${entries[@]}")
  fi

  rm -rf "$temp_dir"
}

sign_embedded_archives() {
  while IFS= read -r -d '' archive; do
    sign_archive_macos_binaries "$archive"
  done < <(find "$APP_BUNDLE/Contents" -type f \( -name '*.jar' -o -name '*.zip' \) -print0 | sort -z)
}

sign_nested_code_containers() {
  while IFS= read -r -d '' info_plist; do
    local bundle_root

    bundle_root="$(dirname "$(dirname "$info_plist")")"
    if [[ "$bundle_root" != "$APP_BUNDLE" ]]; then
      sign_macos_binary "$bundle_root"
    fi
  done < <(find "$APP_BUNDLE/Contents" -type f -path '*/Contents/Info.plist' -print0 | sort -rz)
}

bash "$APP_BUILDER" >/dev/null
sign_nested_binaries
sign_embedded_archives
sign_nested_code_containers
sign_macos_binary "$APP_BUNDLE" "$APP_PERMISSIONS_ENTITLEMENTS"

rm -rf "$STAGING_DIR" "$DMG_PATH"
mkdir -p "$STAGING_DIR"
cp -R "$APP_BUNDLE" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "Cued" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

rm -rf "$STAGING_DIR"
codesign --force --timestamp --sign "$CUED_CODESIGN_IDENTITY" "$DMG_PATH"
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$CUED_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP_BUNDLE"
xcrun stapler staple "$DMG_PATH"

rm -f "$TARBALL_PATH"
tar -czf "$TARBALL_PATH" -C "$DIST_DIR" "Cued.app"

echo "$APP_BUNDLE"
echo "$DMG_PATH"
echo "$TARBALL_PATH"
