#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DISPLAY_NAME="Cued"
APP_BUNDLE_NAME="${APP_DISPLAY_NAME}.app"
APP_EXECUTABLE_NAME="CuedDaemon"
SWIFT_PACKAGE_DIR="$ROOT_DIR/native/macos/CuedNative"
SWIFT_BINARY="$SWIFT_PACKAGE_DIR/.build/release/CuedNative"
APP_DIST_DIR="$ROOT_DIR/native/macos/dist"
APP_BUNDLE="$APP_DIST_DIR/${APP_BUNDLE_NAME}"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/cued-runtime"
RUNTIME_NODE_ROOT="$RESOURCES_DIR/runtime/node"
RUNTIME_NODE_BIN_DIR="$RUNTIME_NODE_ROOT/bin"
PLAYWRIGHT_CHROMIUM_ROOT="$RESOURCES_DIR/runtime/chromium"
PLAYWRIGHT_CHROMIUM_PAYLOAD_DIR="$PLAYWRIGHT_CHROMIUM_ROOT/chrome"
PLAYWRIGHT_CHROMIUM_EXECUTABLE="$PLAYWRIGHT_CHROMIUM_PAYLOAD_DIR/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
HELPERS_DIR="$RESOURCES_DIR/helpers"
NATIVE_HELPER_NAME="cued-native-helper"
SIGNAL_FETCH_SCRIPT="$ROOT_DIR/scripts/fetch-signal-cli-macos.sh"
NODE_RUNTIME_FETCH_SCRIPT="$ROOT_DIR/scripts/fetch-node-runtime-macos.sh"
PLAYWRIGHT_CHROMIUM_FETCH_SCRIPT="$ROOT_DIR/scripts/fetch-playwright-chromium-macos.sh"
JIT_RUNTIME_ENTITLEMENTS="$ROOT_DIR/scripts/packaging/jit-runtime.entitlements.plist"
APP_PERMISSIONS_ENTITLEMENTS="$ROOT_DIR/scripts/packaging/app-permissions.entitlements.plist"
SIGNAL_HELPER_SOURCE_DIR="$ROOT_DIR/native/helpers/signal-cli/.build/cued-signal-cli"
WHATSAPP_HELPER_SOURCE="$ROOT_DIR/native/helpers/whatsapp-go/.build/cued-whatsapp-helper"
PERMISSIONS_SCRIPT_SOURCE="$ROOT_DIR/scripts/request-macos-access.sh"
TRAY_ICON_SOURCE="$ROOT_DIR/native/macos/CuedNative/Resources/trayIconTemplate.png"
CUED_MARK_SOURCE="$ROOT_DIR/native/macos/CuedNative/Resources/cued-mark.png"
NODE_PATH="${CUED_NODE_PATH:-$(command -v node)}"
RUNTIME_SYMLINK_PRUNER="$ROOT_DIR/dist/macos/runtime-symlinks.js"
APP_VERSION="$("$NODE_PATH" -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
NODE_VERSION="$("$NODE_PATH" -p 'process.versions.node')"
NODE_ARCH="$("$NODE_PATH" -p 'process.arch === "arm64" ? "arm64" : "x64"')"
RELEASE_CHANNEL="${CUED_RELEASE_CHANNEL:-internal}"
DAEMON_COMMAND="${CUED_DAEMON_COMMAND:-\"\$CUED_APP_PATH/Contents/Resources/cued-cli\" daemon}"
SETUP_COMMAND="${CUED_SETUP_COMMAND:-\"\$CUED_APP_PATH/Contents/Resources/cued-cli\" setup}"
PERMISSIONS_COMMAND="${CUED_PERMISSIONS_COMMAND:-\"\$CUED_APP_PATH/Contents/Resources/cued-cli\" permissions request --all}"
BETTER_SQLITE3_BINDING_SOURCE="$(find "$ROOT_DIR/node_modules/.pnpm" -path "*/better-sqlite3/build/Release/better_sqlite3.node" | head -n 1)"
DEPLOY_STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cued-runtime.XXXXXX")"

cleanup() {
  rm -rf "$DEPLOY_STAGING_DIR"
}

trap cleanup EXIT

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' \
          -e 's/</\&lt;/g' \
          -e 's/>/\&gt;/g'
}

sign_app_bundle() {
  sign_nested_binaries
  sign_embedded_archives
  sign_nested_code_containers
  sign_macos_binary "$APP_BUNDLE" "$APP_PERMISSIONS_ENTITLEMENTS"
}

sign_macos_binary() {
  local target="$1"
  local entitlements="${2:-}"

  if [[ -n "${CUED_CODESIGN_IDENTITY:-}" ]]; then
    if [[ -n "$entitlements" ]]; then
      codesign \
        --force \
        --timestamp \
        --options runtime \
        --entitlements "$entitlements" \
        --sign "$CUED_CODESIGN_IDENTITY" \
        "$target" >/dev/null
      return
    fi

    codesign \
      --force \
      --timestamp \
      --options runtime \
      --sign "$CUED_CODESIGN_IDENTITY" \
      "$target" >/dev/null
    return
  fi

  if [[ -n "$entitlements" ]]; then
    codesign \
      --force \
      --entitlements "$entitlements" \
      --sign - \
      "$target" >/dev/null
    return
  fi

  codesign \
    --force \
    --sign - \
    "$target" >/dev/null
}

runtime_entitlements_for_binary() {
  local target="$1"

  case "$target" in
    "$MACOS_DIR/$APP_EXECUTABLE_NAME")
      printf '%s\n' "$APP_PERMISSIONS_ENTITLEMENTS"
      ;;
    "$HELPERS_DIR/$NATIVE_HELPER_NAME")
      printf '%s\n' "$APP_PERMISSIONS_ENTITLEMENTS"
      ;;
    "$RUNTIME_NODE_BIN_DIR/node"|"$HELPERS_DIR"/signal-cli/jre/Contents/Home/bin/java|"$PLAYWRIGHT_CHROMIUM_ROOT"/*)
      printf '%s\n' "$JIT_RUNTIME_ENTITLEMENTS"
      ;;
  esac
}

runtime_entitlements_for_bundle() {
  local target="$1"

  case "$target" in
    "$PLAYWRIGHT_CHROMIUM_ROOT"/*)
      printf '%s\n' "$JIT_RUNTIME_ENTITLEMENTS"
      ;;
  esac
}

sign_nested_binaries() {
  local path
  local entitlements

  while IFS= read -r -d '' path; do
    if ! file -b "$path" | grep -q "Mach-O"; then
      continue
    fi

    entitlements="$(runtime_entitlements_for_binary "$path")"
    sign_macos_binary "$path" "$entitlements"
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
    local entitlements

    bundle_root="$(dirname "$(dirname "$info_plist")")"
    if [[ "$bundle_root" != "$APP_BUNDLE" ]]; then
      entitlements="$(runtime_entitlements_for_bundle "$bundle_root")"
      sign_macos_binary "$bundle_root" "$entitlements"
    fi
  done < <(find "$APP_BUNDLE/Contents" -type f -path '*/Contents/Info.plist' -print0 | sort -rz)
}

copy_better_sqlite3_binary() {
  local built_binary
  local staged_module_dir

  built_binary="$(find "$ROOT_DIR/node_modules/.pnpm" -path '*/better-sqlite3/build/Release/better_sqlite3.node' -print -quit)"
  staged_module_dir="$(find "$DEPLOY_STAGING_DIR/node_modules/.pnpm" -path '*/node_modules/better-sqlite3' -type d -print -quit)"

  if [[ -z "$built_binary" ]]; then
    echo "Could not locate the built better_sqlite3.node in node_modules" >&2
    exit 1
  fi

  if [[ -z "$staged_module_dir" ]]; then
    echo "Could not locate better-sqlite3 in the deploy staging directory" >&2
    exit 1
  fi

  mkdir -p "$staged_module_dir/build/Release"
  cp "$built_binary" "$staged_module_dir/build/Release/better_sqlite3.node"
}

mkdir -p "$APP_DIST_DIR"

pnpm --dir "$ROOT_DIR" build >/dev/null
swift build --package-path "$SWIFT_PACKAGE_DIR" -c release >/dev/null
SWIFT_RESOURCE_BUNDLES=("$SWIFT_PACKAGE_DIR"/.build/*/release/*.bundle)
NODE_RUNTIME_SOURCE_DIR="$(bash "$NODE_RUNTIME_FETCH_SCRIPT" "$NODE_VERSION" "$NODE_ARCH")"
PLAYWRIGHT_CHROMIUM_SOURCE_DIR="$(bash "$PLAYWRIGHT_CHROMIUM_FETCH_SCRIPT")"
bash "$SIGNAL_FETCH_SCRIPT" >/dev/null
mkdir -p "$(dirname "$WHATSAPP_HELPER_SOURCE")"
(cd "$ROOT_DIR/native/helpers/whatsapp-go" && GOWORK=off go build -o "$WHATSAPP_HELPER_SOURCE" .) >/dev/null
npm_config_ignore_scripts=true pnpm --dir "$ROOT_DIR" --filter . deploy --legacy --prod "$DEPLOY_STAGING_DIR" >/dev/null
copy_better_sqlite3_binary

rm -rf "$APP_BUNDLE"
mkdir -p \
  "$MACOS_DIR" \
  "$RESOURCES_DIR" \
  "$RUNTIME_DIR" \
  "$RUNTIME_NODE_BIN_DIR" \
  "$PLAYWRIGHT_CHROMIUM_ROOT" \
  "$HELPERS_DIR"

cp "$SWIFT_BINARY" "$MACOS_DIR/$APP_EXECUTABLE_NAME"
chmod +x "$MACOS_DIR/$APP_EXECUTABLE_NAME"
cp "$SWIFT_BINARY" "$HELPERS_DIR/$NATIVE_HELPER_NAME"
chmod +x "$HELPERS_DIR/$NATIVE_HELPER_NAME"
for resource_bundle in "${SWIFT_RESOURCE_BUNDLES[@]}"; do
  cp -R "$resource_bundle" "$RESOURCES_DIR/$(basename "$resource_bundle")"
done
cp "$NODE_RUNTIME_SOURCE_DIR/bin/node" "$RUNTIME_NODE_BIN_DIR/node"
cp -R "$NODE_RUNTIME_SOURCE_DIR/lib" "$RUNTIME_NODE_ROOT/lib"
chmod +x "$RUNTIME_NODE_BIN_DIR/node"
cp -R "$PLAYWRIGHT_CHROMIUM_SOURCE_DIR" "$PLAYWRIGHT_CHROMIUM_PAYLOAD_DIR"
cp -R "$DEPLOY_STAGING_DIR/." "$RUNTIME_DIR/"
cp -R "$SIGNAL_HELPER_SOURCE_DIR" "$HELPERS_DIR/signal-cli"
cp "$WHATSAPP_HELPER_SOURCE" "$HELPERS_DIR/cued-whatsapp-helper"
chmod +x "$HELPERS_DIR/cued-whatsapp-helper"

if [[ -z "$BETTER_SQLITE3_BINDING_SOURCE" ]]; then
  echo "better-sqlite3 native binding not found in node_modules" >&2
  exit 1
fi
BETTER_SQLITE3_RUNTIME_DIR="$(find "$RUNTIME_DIR/node_modules/.pnpm" -maxdepth 3 -type d -path "*/better-sqlite3" | head -n 1)"
if [[ -z "$BETTER_SQLITE3_RUNTIME_DIR" ]]; then
  echo "better-sqlite3 package missing from deployed runtime" >&2
  exit 1
fi
mkdir -p "$BETTER_SQLITE3_RUNTIME_DIR/build/Release"
cp "$BETTER_SQLITE3_BINDING_SOURCE" "$BETTER_SQLITE3_RUNTIME_DIR/build/Release/better_sqlite3.node"

# Remove symlinks that escape the bundled runtime or no longer resolve after deploy.
"$NODE_PATH" "$RUNTIME_SYMLINK_PRUNER" "$RUNTIME_DIR" >/dev/null
# `pnpm deploy --legacy --prod` can still leave a handful of dangling package links behind.
find -L "$RUNTIME_DIR" -type l -exec rm -f {} +
rm -rf "$RUNTIME_DIR/node_modules/cued" "$RUNTIME_DIR/node_modules/@cued/app"
# The bundled CLI only needs compiled JS plus runtime dependencies. Shipping the
# repo's native helper sources/build output duplicates unsigned binaries inside
# the portable runtime and breaks notarization.
rm -rf "$RUNTIME_DIR/native"

mkdir -p "$RESOURCES_DIR/scripts"
cp "$PERMISSIONS_SCRIPT_SOURCE" "$RESOURCES_DIR/scripts/request-macos-access.sh"
chmod +x "$RESOURCES_DIR/scripts/request-macos-access.sh"

INFO_PLIST_DB_PATH_BLOCK=""
if [[ -n "${CUED_DB_PATH_OVERRIDE:-}" ]]; then
  INFO_PLIST_DB_PATH_BLOCK=$(cat <<EOF
  <key>CuedDBPath</key>
  <string>$(xml_escape "$CUED_DB_PATH_OVERRIDE")</string>
EOF
)
fi

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_DISPLAY_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$APP_EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>dev.cued.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_DISPLAY_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$APP_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Cued uses Apple Events to automate Messages when you explicitly ask it to send or control native messaging flows.</string>
  <key>NSContactsUsageDescription</key>
  <string>Cued reads local contacts so your local message database can resolve people consistently across platforms.</string>
  <key>CuedDaemonCommand</key>
  <string>$(xml_escape "$DAEMON_COMMAND")</string>
  <key>CuedSetupCommand</key>
  <string>$(xml_escape "$SETUP_COMMAND")</string>
  <key>CuedPermissionsCommand</key>
  <string>$(xml_escape "$PERMISSIONS_COMMAND")</string>
$INFO_PLIST_DB_PATH_BLOCK
</dict>
</plist>
EOF

cat > "$RESOURCES_DIR/cued-cli" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP_EXEC="\$SCRIPT_DIR/../MacOS/$APP_EXECUTABLE_NAME"
APP_BUNDLE_PATH="\$(cd "\$SCRIPT_DIR/../.." && pwd)"
RUNTIME_ROOT="\$SCRIPT_DIR/cued-runtime"
SCRIPT_ROOT="\$SCRIPT_DIR/scripts"
NODE_BIN="\$SCRIPT_DIR/runtime/node/bin/node"
NATIVE_HELPER="\$SCRIPT_DIR/helpers/$NATIVE_HELPER_NAME"
export PATH="\$(dirname "\$NODE_BIN"):\$PATH"
export CUED_APP_PATH="\${CUED_APP_PATH:-\$APP_BUNDLE_PATH}"
export CUED_BUNDLED_RUNTIME_ROOT="\${CUED_BUNDLED_RUNTIME_ROOT:-\$RUNTIME_ROOT}"
export CUED_BUNDLED_SCRIPT_ROOT="\${CUED_BUNDLED_SCRIPT_ROOT:-\$SCRIPT_ROOT}"
export CUED_NATIVE_BINARY="\${CUED_NATIVE_BINARY:-\$NATIVE_HELPER}"
export CUED_IMESSAGE_NATIVE_BINARY="\${CUED_IMESSAGE_NATIVE_BINARY:-\$NATIVE_HELPER}"
export CUED_CONTACTS_NATIVE_BINARY="\${CUED_CONTACTS_NATIVE_BINARY:-\$NATIVE_HELPER}"
export CUED_AUTH_NATIVE_BINARY="\${CUED_AUTH_NATIVE_BINARY:-\$APP_EXEC}"
export CUED_CHROMIUM_EXECUTABLE_PATH="\${CUED_CHROMIUM_EXECUTABLE_PATH:-\$SCRIPT_DIR/runtime/chromium/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"
export CUED_WHATSAPP_HELPER_BINARY="\${CUED_WHATSAPP_HELPER_BINARY:-\$SCRIPT_DIR/helpers/cued-whatsapp-helper}"
export CUED_APP_VERSION="\${CUED_APP_VERSION:-$APP_VERSION}"
export CUED_RELEASE_CHANNEL="\${CUED_RELEASE_CHANNEL:-$RELEASE_CHANNEL}"
exec "\$NODE_BIN" "\$RUNTIME_ROOT/dist/cli.js" "\$@"
EOF
chmod +x "$RESOURCES_DIR/cued-cli"

cp "$TRAY_ICON_SOURCE" "$RESOURCES_DIR/trayIconTemplate.png"
cp "$CUED_MARK_SOURCE" "$RESOURCES_DIR/cued-mark.png"

# Sign the assembled app bundle so LaunchServices accepts it as an app.
sign_app_bundle

echo "$APP_BUNDLE"
