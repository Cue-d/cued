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
RUNTIME_NODE_DIR="$RESOURCES_DIR/runtime/node/bin"
HELPERS_DIR="$RESOURCES_DIR/helpers"
SIGNAL_FETCH_SCRIPT="$ROOT_DIR/scripts/fetch-signal-cli-macos.sh"
SIGNAL_HELPER_SOURCE_DIR="$ROOT_DIR/native/helpers/signal-cli/.build/cued-signal-cli"
WHATSAPP_HELPER_SOURCE="$ROOT_DIR/native/helpers/whatsapp-go/.build/cued-whatsapp-helper"
PERMISSIONS_SCRIPT_SOURCE="$ROOT_DIR/scripts/request-macos-access.sh"
TRAY_ICON_SOURCE="$ROOT_DIR/native/macos/CuedNative/Resources/trayIconTemplate.png"
CUED_MARK_SOURCE="$ROOT_DIR/native/macos/CuedNative/Resources/cued-mark.png"
NODE_PATH="${CUED_NODE_PATH:-$(command -v node)}"
RUNTIME_SYMLINK_PRUNER="$ROOT_DIR/dist/macos/runtime-symlinks.js"
DB_PATH="${CUED_DB_PATH_OVERRIDE:-$HOME/.cued/local.db}"
APP_VERSION="$("$NODE_PATH" -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
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
  if [[ -n "${CUED_CODESIGN_IDENTITY:-}" ]]; then
    codesign \
      --force \
      --deep \
      --timestamp \
      --options runtime \
      --sign "$CUED_CODESIGN_IDENTITY" \
      "$APP_BUNDLE" >/dev/null
    return
  fi

  codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null
}

mkdir -p "$APP_DIST_DIR"

pnpm --dir "$ROOT_DIR" build >/dev/null
swift build --package-path "$SWIFT_PACKAGE_DIR" -c release >/dev/null
SWIFT_RESOURCE_BUNDLES=("$SWIFT_PACKAGE_DIR"/.build/*/release/*.bundle)
bash "$SIGNAL_FETCH_SCRIPT" >/dev/null
mkdir -p "$(dirname "$WHATSAPP_HELPER_SOURCE")"
(cd "$ROOT_DIR/native/helpers/whatsapp-go" && GOWORK=off go build -o "$WHATSAPP_HELPER_SOURCE" .) >/dev/null
npm_config_ignore_scripts=true pnpm --dir "$ROOT_DIR" --filter . deploy --legacy --prod "$DEPLOY_STAGING_DIR" >/dev/null

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$RUNTIME_DIR" "$RUNTIME_NODE_DIR" "$HELPERS_DIR"

cp "$SWIFT_BINARY" "$MACOS_DIR/$APP_EXECUTABLE_NAME"
chmod +x "$MACOS_DIR/$APP_EXECUTABLE_NAME"
for resource_bundle in "${SWIFT_RESOURCE_BUNDLES[@]}"; do
  cp -R "$resource_bundle" "$RESOURCES_DIR/$(basename "$resource_bundle")"
done
cp "$NODE_PATH" "$RUNTIME_NODE_DIR/node"
chmod +x "$RUNTIME_NODE_DIR/node"
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

mkdir -p "$RESOURCES_DIR/scripts"
cp "$PERMISSIONS_SCRIPT_SOURCE" "$RESOURCES_DIR/scripts/request-macos-access.sh"
chmod +x "$RESOURCES_DIR/scripts/request-macos-access.sh"

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
  <key>CuedDBPath</key>
  <string>$(xml_escape "$DB_PATH")</string>
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
export PATH="\$(dirname "\$NODE_BIN"):\$PATH"
export CUED_APP_PATH="\${CUED_APP_PATH:-\$APP_BUNDLE_PATH}"
export CUED_BUNDLED_RUNTIME_ROOT="\${CUED_BUNDLED_RUNTIME_ROOT:-\$RUNTIME_ROOT}"
export CUED_BUNDLED_SCRIPT_ROOT="\${CUED_BUNDLED_SCRIPT_ROOT:-\$SCRIPT_ROOT}"
export CUED_IMESSAGE_NATIVE_BINARY="\${CUED_IMESSAGE_NATIVE_BINARY:-\$APP_EXEC}"
export CUED_CONTACTS_NATIVE_BINARY="\${CUED_CONTACTS_NATIVE_BINARY:-\$APP_EXEC}"
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
