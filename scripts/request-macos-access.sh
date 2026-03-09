#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_PACKAGE_DIR="$ROOT_DIR/native/macos/CuedNative"
DEFAULT_NATIVE_BINARY="$NATIVE_PACKAGE_DIR/.build/release/CuedNative"
NATIVE_BINARY="${CUED_NATIVE_BINARY:-$DEFAULT_NATIVE_BINARY}"
PERMISSION_TARGET="${CUED_PERMISSION_TARGET:-$NATIVE_BINARY}"

REQUEST_CONTACTS=0
REQUEST_MESSAGES=0
REQUEST_FULL_DISK=0
REQUEST_ACCESSIBILITY=0
BUILD_NATIVE=1
OPEN_ONLY=0

log() {
  printf '[cued-access] %s\n' "$*"
}

warn() {
  printf '[cued-access] warning: %s\n' "$*" >&2
}

die() {
  printf '[cued-access] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  bash scripts/request-macos-access.sh [options]

Options:
  --all                 Request Contacts + Messages automation and open the manual privacy panes
  --contacts            Trigger the macOS Contacts permission prompt using the native exporter
  --messages            Trigger Apple Events automation permission for Messages via AppleScript
  --full-disk-access    Open the Full Disk Access pane and print manual instructions
  --accessibility       Open the Accessibility pane and print manual instructions
  --open-only           Skip prompt attempts and only open the relevant System Settings panes
  --skip-build          Do not build the native macOS helper before requesting Contacts access
  --help                Show this help

Notes:
  - Contacts and Apple Events automation can prompt automatically.
  - Full Disk Access and Accessibility cannot be granted programmatically on macOS.
  - The process that runs this script is the one macOS authorizes for AppleScript automation.
EOF
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    die "this script only works on macOS"
  fi
}

ensure_native_binary() {
  if [[ -x "$NATIVE_BINARY" ]]; then
    return
  fi

  if [[ $BUILD_NATIVE -eq 0 ]]; then
    die "native binary not found at $NATIVE_BINARY and --skip-build was set"
  fi

  log "building native macOS helper"
  swift build --package-path "$NATIVE_PACKAGE_DIR" -c release >/dev/null
}

open_privacy_pane() {
  local anchor="$1"
  if ! open "x-apple.systempreferences:com.apple.preference.security?${anchor}" >/dev/null 2>&1; then
    open "/System/Library/PreferencePanes/Security.prefPane" >/dev/null 2>&1 || true
  fi
}

request_contacts_access() {
  if [[ $OPEN_ONLY -eq 1 ]]; then
    log "opening Contacts privacy pane"
    open_privacy_pane "Privacy_Contacts"
    return
  fi

  ensure_native_binary

  log "requesting Contacts access"
  if "$NATIVE_BINARY" contacts dump >/dev/null 2>&1; then
    log "Contacts access granted"
    return
  fi

  warn "Contacts access was not granted. Opening the Contacts privacy pane."
  open_privacy_pane "Privacy_Contacts"
}

request_messages_automation_access() {
  if [[ $OPEN_ONLY -eq 1 ]]; then
    log "opening Automation privacy pane"
    open_privacy_pane "Privacy_Automation"
    return
  fi

  log "requesting Apple Events automation access for Messages"
  if osascript <<'APPLESCRIPT' >/dev/null 2>&1
tell application "Messages"
  count of services
end tell
APPLESCRIPT
  then
    log "Messages automation access granted"
    return
  fi

  warn "Automation access was not granted. Opening the Automation privacy pane."
  open_privacy_pane "Privacy_Automation"
}

open_full_disk_access_help() {
  log "opening Full Disk Access privacy pane"
  open_privacy_pane "Privacy_AllFiles"
  cat <<EOF

Manual step required:
  1. Add this app or binary to Full Disk Access:
     $PERMISSION_TARGET
  2. Enable Full Disk Access for that app.
  3. Restart the app after granting access so SQLite access to Messages data is refreshed.

EOF
}

open_accessibility_help() {
  log "opening Accessibility privacy pane"
  open_privacy_pane "Privacy_Accessibility"
  cat <<'EOF'

Manual step required:
  1. Add the app that runs cued commands.
  2. Enable Accessibility for that app.

This is only needed for workflows that rely on UI scripting or desktop automation.

EOF
}

if [[ $# -eq 0 ]]; then
  REQUEST_CONTACTS=1
  REQUEST_MESSAGES=1
  REQUEST_FULL_DISK=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      ;;
    --all)
      REQUEST_CONTACTS=1
      REQUEST_MESSAGES=1
      REQUEST_FULL_DISK=1
      REQUEST_ACCESSIBILITY=1
      ;;
    --contacts)
      REQUEST_CONTACTS=1
      ;;
    --messages)
      REQUEST_MESSAGES=1
      ;;
    --full-disk-access)
      REQUEST_FULL_DISK=1
      ;;
    --accessibility)
      REQUEST_ACCESSIBILITY=1
      ;;
    --open-only)
      OPEN_ONLY=1
      ;;
    --skip-build)
      BUILD_NATIVE=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

ensure_macos

if [[ $REQUEST_CONTACTS -eq 0 && $REQUEST_MESSAGES -eq 0 && $REQUEST_FULL_DISK -eq 0 && $REQUEST_ACCESSIBILITY -eq 0 ]]; then
  die "nothing requested; use --help for options"
fi

if [[ $REQUEST_CONTACTS -eq 1 ]]; then
  request_contacts_access
fi

if [[ $REQUEST_MESSAGES -eq 1 ]]; then
  request_messages_automation_access
fi

if [[ $REQUEST_FULL_DISK -eq 1 ]]; then
  open_full_disk_access_help
fi

if [[ $REQUEST_ACCESSIBILITY -eq 1 ]]; then
  open_accessibility_help
fi

log "done"
