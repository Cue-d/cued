#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <Cued.app> <output.dmg>" >&2
  exit 64
fi

APP_BUNDLE="$1"
DMG_PATH="$2"
APP_BUNDLE="$(cd "$(dirname "$APP_BUNDLE")" && pwd)/$(basename "$APP_BUNDLE")"
VOLUME_NAME="Cued"
DMG_DIR="$(dirname "$DMG_PATH")"
mkdir -p "$DMG_DIR"
DMG_PATH="$(cd "$DMG_DIR" && pwd)/$(basename "$DMG_PATH")"
CONFIG_JSON="$(mktemp "${TMPDIR:-/tmp}/cued-dmg-config.XXXXXX").json"
BACKGROUND_PATH="$(mktemp "${TMPDIR:-/tmp}/cued-dmg-background.XXXXXX").png"
BACKGROUND_SWIFT="$(mktemp "${TMPDIR:-/tmp}/cued-dmg-background.XXXXXX").swift"

cleanup() {
  rm -f "$CONFIG_JSON" "$BACKGROUND_PATH" "$BACKGROUND_SWIFT"
}
trap cleanup EXIT

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 66
fi

mkdir -p "$DMG_DIR"

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

swift "$BACKGROUND_SWIFT" "$BACKGROUND_PATH" >/dev/null

node --input-type=module - "$CONFIG_JSON" "$APP_BUNDLE" "$BACKGROUND_PATH" "$VOLUME_NAME" <<'NODE'
import { writeFileSync } from "node:fs";

const [configPath, appBundle, backgroundPath, volumeName] = process.argv.slice(2);
writeFileSync(
  configPath,
  JSON.stringify(
    {
      title: volumeName,
      background: backgroundPath,
      "icon-size": 124,
      window: {
        size: {
          width: 760,
          height: 400,
        },
      },
      contents: [
        {
          x: 190,
          y: 205,
          type: "file",
          path: appBundle,
        },
        {
          x: 570,
          y: 205,
          type: "link",
          path: "/Applications",
        },
      ],
    },
    null,
    2,
  ),
);
NODE

rm -f "$DMG_PATH"
env npm_config_ignore_scripts=false npx -y appdmg "$CONFIG_JSON" "$DMG_PATH" >/dev/null

echo "$DMG_PATH"
