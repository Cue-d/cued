#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_PACKAGE_DIR="$ROOT_DIR/native/macos/CuedNative"
DEFAULT_NATIVE_BINARY="$NATIVE_PACKAGE_DIR/.build/release/CuedNative"
if [[ -z "${CUED_APP_PATH:-}" ]]; then
  APP_BUNDLE_CANDIDATE="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || true)"
  if [[ -n "$APP_BUNDLE_CANDIDATE" && "$(basename "$APP_BUNDLE_CANDIDATE")" == *.app ]]; then
    CUED_APP_PATH="$APP_BUNDLE_CANDIDATE"
  fi
fi
IS_BUNDLED_APP=0
if [[ -n "${CUED_APP_PATH:-}" && -d "${CUED_APP_PATH}/Contents/Resources" ]]; then
  IS_BUNDLED_APP=1
fi
if [[ $IS_BUNDLED_APP -eq 1 ]]; then
  DEFAULT_NATIVE_BINARY="${CUED_APP_PATH}/Contents/Resources/helpers/cued-native-helper"
fi
NATIVE_BINARY="${CUED_NATIVE_BINARY:-$DEFAULT_NATIVE_BINARY}"
PERMISSION_TARGET="${CUED_PERMISSION_TARGET:-${CUED_APP_PATH:-$NATIVE_BINARY}}"

REQUEST_CONTACTS=0
REQUEST_FULL_DISK=0
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
  --all                 Request Contacts and open the Full Disk Access pane
  --contacts            Trigger the macOS Contacts permission prompt using the native exporter
  --full-disk-access    Open the Full Disk Access pane and print manual instructions
  --open-only           Skip prompt attempts and only open the relevant System Settings panes
  --skip-build          Do not build the native macOS helper before requesting Contacts access
  --help                Show this help

Notes:
  - Contacts can prompt automatically.
  - Full Disk Access cannot be granted programmatically on macOS.
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

  if [[ $IS_BUNDLED_APP -eq 1 ]]; then
    die "bundled native binary not found at $NATIVE_BINARY"
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

if [[ $# -eq 0 ]]; then
  REQUEST_CONTACTS=1
  REQUEST_FULL_DISK=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      ;;
    --all)
      REQUEST_CONTACTS=1
      REQUEST_FULL_DISK=1
      ;;
    --contacts)
      REQUEST_CONTACTS=1
      ;;
    --full-disk-access)
      REQUEST_FULL_DISK=1
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

if [[ $REQUEST_CONTACTS -eq 0 && $REQUEST_FULL_DISK -eq 0 ]]; then
  die "nothing requested; use --help for options"
fi

if [[ $REQUEST_CONTACTS -eq 1 ]]; then
  request_contacts_access
fi

if [[ $REQUEST_FULL_DISK -eq 1 ]]; then
  open_full_disk_access_help
fi

log "done"
