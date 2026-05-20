#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <Cued.app> <output.dmg>" >&2
  exit 64
fi

APP_BUNDLE="$1"
DMG_PATH="$2"
APP_NAME="$(basename "$APP_BUNDLE")"
VOLUME_NAME="Cued"
DMG_DIR="$(dirname "$DMG_PATH")"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cued-dmg-staging.XXXXXX")"
RW_DMG="$(mktemp "${TMPDIR:-/tmp}/cued-dmg.XXXXXX").dmg"
MOUNT_DIR=""
BACKGROUND_RELATIVE_PATH=".background/background.png"
BACKGROUND_SWIFT="$(mktemp "${TMPDIR:-/tmp}/cued-dmg-background.XXXXXX").swift"

cleanup() {
  if [[ -n "$MOUNT_DIR" && -d "$MOUNT_DIR" ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
  fi
  rm -rf "$STAGING_DIR" "$RW_DMG" "$BACKGROUND_SWIFT"
}
trap cleanup EXIT

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 66
fi

mkdir -p "$DMG_DIR"
cp -R "$APP_BUNDLE" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
mkdir -p "$STAGING_DIR/.background"

cat >"$BACKGROUND_SWIFT" <<'SWIFT'
import AppKit

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: render-dmg-background <output.png>\n".utf8))
  exit(64)
}

let outputPath = CommandLine.arguments[1]
let size = NSSize(width: 760, height: 400)
let image = NSImage(size: size)

image.lockFocus()
NSColor(calibratedWhite: 0.965, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

let vignette = NSGradient(colors: [
  NSColor(calibratedWhite: 1, alpha: 0.65),
  NSColor(calibratedWhite: 0.91, alpha: 0.18)
])
vignette?.draw(in: NSRect(x: 0, y: 0, width: size.width, height: size.height), angle: 90)

let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 292, y: 218))
arrow.curve(
  to: NSPoint(x: 468, y: 218),
  controlPoint1: NSPoint(x: 350, y: 253),
  controlPoint2: NSPoint(x: 410, y: 253)
)
NSColor(calibratedWhite: 0.66, alpha: 0.95).setStroke()
arrow.lineWidth = 1.6
arrow.stroke()

let arrowHead = NSBezierPath()
arrowHead.move(to: NSPoint(x: 468, y: 218))
arrowHead.curve(to: NSPoint(x: 455, y: 228), controlPoint1: NSPoint(x: 464, y: 224), controlPoint2: NSPoint(x: 460, y: 227))
arrowHead.move(to: NSPoint(x: 468, y: 218))
arrowHead.curve(to: NSPoint(x: 453, y: 211), controlPoint1: NSPoint(x: 462, y: 215), controlPoint2: NSPoint(x: 458, y: 213))
arrowHead.lineWidth = 1.6
arrowHead.stroke()

let installAttributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 15, weight: .medium),
  .foregroundColor: NSColor(calibratedWhite: 0.62, alpha: 1)
]
let installText = "Drag to install" as NSString
let installTextSize = installText.size(withAttributes: installAttributes)
installText.draw(
  at: NSPoint(x: (size.width - installTextSize.width) / 2, y: 182),
  withAttributes: installAttributes
)

image.unlockFocus()

guard
  let tiff = image.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiff),
  let png = bitmap.representation(using: .png, properties: [:])
else {
  FileHandle.standardError.write(Data("failed to render dmg background\n".utf8))
  exit(1)
}

try png.write(to: URL(fileURLWithPath: outputPath))
SWIFT

swift "$BACKGROUND_SWIFT" "$STAGING_DIR/$BACKGROUND_RELATIVE_PATH" >/dev/null

hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDRW \
  "$RW_DMG" >/dev/null

MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cued-dmg-mount.XXXXXX")"
hdiutil attach "$RW_DMG" -mountpoint "$MOUNT_DIR" -nobrowse -quiet
BACKGROUND_MOUNT_PATH="$MOUNT_DIR/$BACKGROUND_RELATIVE_PATH"

osascript <<APPLESCRIPT >/dev/null
tell application "Finder"
  set volumeFolder to POSIX file "$MOUNT_DIR" as alias
  set backgroundImage to POSIX file "$BACKGROUND_MOUNT_PATH" as alias
  tell folder volumeFolder
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {190, 145, 950, 545}
    set arrangement of icon view options of container window to not arranged
    set icon size of icon view options of container window to 124
    set text size of icon view options of container window to 16
    set background picture of icon view options of container window to backgroundImage
    set position of item "$APP_NAME" of container window to {190, 205}
    set position of item "Applications" of container window to {570, 205}
    close
  end tell
end tell
APPLESCRIPT

sync
hdiutil detach "$MOUNT_DIR" -quiet
rmdir "$MOUNT_DIR" 2>/dev/null || true
MOUNT_DIR=""

hdiutil convert "$RW_DMG" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  -o "$DMG_PATH" >/dev/null

echo "$DMG_PATH"
