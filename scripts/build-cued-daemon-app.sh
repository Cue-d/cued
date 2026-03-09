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
CLI_DIST_DIR="$ROOT_DIR/apps/cued/dist"
CLI_WRAPPER_SOURCE="$ROOT_DIR/apps/cued/bin/cued-wrapper"
TRAY_ICON_SOURCE="$ROOT_DIR/apps/electron/resources/trayIconTemplate.png"
NODE_PATH="${CUED_NODE_PATH:-$(command -v node)}"
CLI_PATH="${CUED_CLI_PATH:-$CLI_DIST_DIR/cli.js}"
DB_PATH="${CUED_DB_PATH_OVERRIDE:-$HOME/.cued/local.db}"
DAEMON_COMMAND="${CUED_DAEMON_COMMAND:-\"$NODE_PATH\" \"$CLI_PATH\" daemon}"
SETUP_COMMAND="${CUED_SETUP_COMMAND:-\"$NODE_PATH\" \"$CLI_PATH\" setup}"
PERMISSIONS_COMMAND="${CUED_PERMISSIONS_COMMAND:-cd \"$ROOT_DIR\" && pnpm permissions:macos -- --all}"

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' \
          -e 's/</\&lt;/g' \
          -e 's/>/\&gt;/g'
}

mkdir -p "$APP_DIST_DIR"

pnpm --dir "$ROOT_DIR/apps/cued" build >/dev/null
swift build --package-path "$SWIFT_PACKAGE_DIR" -c release >/dev/null

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$SWIFT_BINARY" "$MACOS_DIR/$APP_NAME"
chmod +x "$MACOS_DIR/$APP_NAME"

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
exec "$NODE_PATH" "$CLI_PATH" "\$@"
EOF
chmod +x "$RESOURCES_DIR/cued-cli"

cp "$CLI_WRAPPER_SOURCE" "$RESOURCES_DIR/cued-dev-wrapper"
chmod +x "$RESOURCES_DIR/cued-dev-wrapper"

cp "$TRAY_ICON_SOURCE" "$RESOURCES_DIR/trayIconTemplate.png"

echo "$APP_BUNDLE"
