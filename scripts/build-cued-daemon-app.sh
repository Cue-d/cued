#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="CuedDaemon"
SWIFT_PACKAGE_DIR="$ROOT_DIR/native/macos/CuedNative"
SWIFT_BINARY="$SWIFT_PACKAGE_DIR/.build/release/CuedNative"
APP_DIST_DIR="$ROOT_DIR/native/macos/dist"
APP_BUNDLE="$APP_DIST_DIR/${APP_NAME}.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/cued-runtime"
RUNTIME_NODE_DIR="$RESOURCES_DIR/runtime/node/bin"
PERMISSIONS_SCRIPT_SOURCE="$ROOT_DIR/scripts/request-macos-access.sh"
TRAY_ICON_SOURCE="$ROOT_DIR/apps/electron/resources/trayIconTemplate.png"
NODE_PATH="${CUED_NODE_PATH:-$(command -v node)}"
DB_PATH="${CUED_DB_PATH_OVERRIDE:-$HOME/.cued/local.db}"
DAEMON_COMMAND="${CUED_DAEMON_COMMAND:-\"\$CUED_APP_PATH/Contents/Resources/cued-cli\" daemon}"
SETUP_COMMAND="${CUED_SETUP_COMMAND:-\"\$CUED_APP_PATH/Contents/Resources/cued-cli\" setup}"
PERMISSIONS_COMMAND="${CUED_PERMISSIONS_COMMAND:-\"\$CUED_APP_PATH/Contents/Resources/cued-cli\" permissions request --all}"
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

mkdir -p "$APP_DIST_DIR"

pnpm --dir "$ROOT_DIR/apps/cued" build >/dev/null
swift build --package-path "$SWIFT_PACKAGE_DIR" -c release >/dev/null
pnpm --filter ./apps/cued deploy --legacy --prod "$DEPLOY_STAGING_DIR" >/dev/null

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$RUNTIME_DIR" "$RUNTIME_NODE_DIR"

cp "$SWIFT_BINARY" "$MACOS_DIR/$APP_NAME"
chmod +x "$MACOS_DIR/$APP_NAME"
cp "$NODE_PATH" "$RUNTIME_NODE_DIR/node"
chmod +x "$RUNTIME_NODE_DIR/node"
cp -R "$DEPLOY_STAGING_DIR/." "$RUNTIME_DIR/"
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
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>dev.cued.$APP_NAME</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
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
APP_EXEC="\$SCRIPT_DIR/../MacOS/$APP_NAME"
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
exec "\$NODE_BIN" "\$RUNTIME_ROOT/dist/cli.js" "\$@"
EOF
chmod +x "$RESOURCES_DIR/cued-cli"

cp "$TRAY_ICON_SOURCE" "$RESOURCES_DIR/trayIconTemplate.png"

echo "$APP_BUNDLE"
