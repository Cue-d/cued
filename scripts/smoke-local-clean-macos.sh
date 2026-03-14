#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TIMEOUT_SECONDS="${CUED_SMOKE_TIMEOUT_SECONDS:-60}"
KEEP_SANDBOX=1
BUILD_APP=1
NO_SCREENSHOTS=0
SANDBOX_ROOT="${CUED_SMOKE_SANDBOX_ROOT:-}"
INSTALL_MODE="sandbox"
APPLICATIONS_APP_PATH="/Applications/Cued.app"

CURRENT_USER_HOME="${HOME}"
REAL_CUED_HOME="$CURRENT_USER_HOME/.cued"
APP_SOURCE="$ROOT_DIR/native/macos/dist/Cued.app"

log() {
  printf '[cued-smoke] %s\n' "$*"
}

warn() {
  printf '[cued-smoke] warning: %s\n' "$*" >&2
}

die() {
  printf '[cued-smoke] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  bash scripts/smoke-local-clean-macos.sh [options]

Options:
  --sandbox <path>      Reuse a specific sandbox root instead of creating a new temp one
  --applications        Install the built app into /Applications/Cued.app and smoke test that path
  --skip-build          Skip pnpm check:ci-local and pnpm build:app:macos
  --cleanup             Remove the sandbox on success
  --no-screenshots      Skip screencapture checkpoints
  --help                Show this help

Notes:
  - This smoke run keeps all Cued-owned runtime state under a temp sandbox.
  - The onboarding window must stay open while you grant permissions.
  - Contacts and Full Disk Access still require manual macOS interaction.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox)
      SANDBOX_ROOT="${2:-}"
      [[ -n "$SANDBOX_ROOT" ]] || die "--sandbox requires a path"
      shift 2
      ;;
    --applications)
      INSTALL_MODE="applications"
      shift
      ;;
    --skip-build)
      BUILD_APP=0
      shift
      ;;
    --cleanup)
      KEEP_SANDBOX=0
      shift
      ;;
    --no-screenshots)
      NO_SCREENSHOTS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "this smoke script only works on macOS"

if [[ -z "$SANDBOX_ROOT" ]]; then
  SANDBOX_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cued-smoke.XXXXXX")"
else
  mkdir -p "$SANDBOX_ROOT"
fi

APP_UNDER_TEST="$SANDBOX_ROOT/Cued.app"
HOME_UNDER_TEST="$SANDBOX_ROOT/home"
CUED_HOME_UNDER_TEST="$HOME_UNDER_TEST/.cued"
ARTIFACTS_DIR="$SANDBOX_ROOT/artifacts"
APP_LOG="$SANDBOX_ROOT/app.log"
NOTES_PATH="$ARTIFACTS_DIR/notes.md"
REAL_CUED_BEFORE="$ARTIFACTS_DIR/real-cued-before.txt"
REAL_CUED_AFTER="$ARTIFACTS_DIR/real-cued-after.txt"
REAL_CUED_DIFF="$ARTIFACTS_DIR/real-cued-diff.txt"
INSTALLED_APP_BACKUP="$SANDBOX_ROOT/original-installed-Cued.app"
APP_PID=""
ONBOARDING_PROCESS_NAME=""

mkdir -p "$HOME_UNDER_TEST" "$ARTIFACTS_DIR"

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi

  if [[ $KEEP_SANDBOX -eq 0 ]]; then
    rm -rf "$SANDBOX_ROOT"
  fi
}

trap cleanup EXIT

note() {
  printf -- '- %s\n' "$*" | tee -a "$NOTES_PATH" >/dev/null
}

capture_screenshot() {
  local name="$1"
  if [[ $NO_SCREENSHOTS -eq 1 ]]; then
    return
  fi
  screencapture -x "$ARTIFACTS_DIR/${name}.png" >/dev/null 2>&1 || true
}

snapshot_path_manifest() {
  local target="$1"
  local output="$2"

  if [[ ! -e "$target" ]]; then
    printf '<absent>\n' >"$output"
    return
  fi

  find "$target" -exec stat -f '%N|%m|%z|%Sp' {} \; | sort >"$output"
}

smoke_env() {
  env \
    HOME="$HOME_UNDER_TEST" \
    CUED_HOME="$CUED_HOME_UNDER_TEST" \
    CUED_DB_PATH="$CUED_HOME_UNDER_TEST/local.db" \
    CUED_SKIP_AUTO_PREREQUISITES=1 \
    "$@"
}

run_cli() {
  smoke_env "$CLI" "$@"
}

capture_cli() {
  local label="$1"
  shift
  local output="$ARTIFACTS_DIR/${label}.txt"
  log "running: cued $*"
  run_cli "$@" 2>&1 | tee "$output"
}

wait_for_socket() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if [[ -S "$CUED_HOME_UNDER_TEST/cued.sock" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

find_onboarding_process_name() {
  osascript <<'APPLESCRIPT'
tell application "System Events"
  repeat with appProcess in application processes
    try
      if exists window "Cued Settings" of appProcess then
        return name of appProcess as text
      end if
    end try
  end repeat
end tell
return ""
APPLESCRIPT
}

wait_for_onboarding_window() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    local process_name
    process_name="$(find_onboarding_process_name | tr -d '\r')"
    if [[ -n "$process_name" ]]; then
      ONBOARDING_PROCESS_NAME="$process_name"
      return 0
    fi
    sleep 1
  done
  return 1
}

activate_onboarding_app() {
  [[ -n "$ONBOARDING_PROCESS_NAME" ]] || return 1
  osascript <<APPLESCRIPT >/dev/null 2>&1
tell application "System Events"
  tell process "$ONBOARDING_PROCESS_NAME"
    set frontmost to true
  end tell
end tell
APPLESCRIPT
}

click_onboarding_button() {
  local button_name="$1"
  [[ -n "$ONBOARDING_PROCESS_NAME" ]] || return 1

  osascript <<APPLESCRIPT >/dev/null 2>&1
tell application "System Events"
  tell process "$ONBOARDING_PROCESS_NAME"
    set frontmost to true
    if exists button "$button_name" of window "Cued Settings" then
      click button "$button_name" of window "Cued Settings"
      return
    end if
  end tell
end tell
error "button not found"
APPLESCRIPT
}

pause_for_user() {
  local prompt="$1"
  printf '\n[cued-smoke] %s\n' "$prompt"
  read -r -p "[cued-smoke] Press Enter to continue..."
}

confirm_user() {
  local prompt="$1"
  local response
  while true; do
    read -r -p "[cued-smoke] ${prompt} [y/n]: " response
    case "$response" in
      y|Y) return 0 ;;
      n|N) return 1 ;;
    esac
  done
}

extract_run_id() {
  local file="$1"
  node -e 'const fs = require("node:fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(data.runId ?? "");' "$file"
}

extract_run_status() {
  local file="$1"
  local run_id="$2"
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const runId = process.argv[2];
    const run = (data.recentRuns ?? []).find((candidate) => candidate.id === runId);
    process.stdout.write(run?.status ?? "");
  ' "$file" "$run_id"
}

poll_run_until_terminal() {
  local label="$1"
  local run_id="$2"
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local attempt=0

  while (( SECONDS < deadline )); do
    local status_path="$ARTIFACTS_DIR/${label}-status-${attempt}.json"
    run_cli status >"$status_path"
    local run_status
    run_status="$(extract_run_status "$status_path" "$run_id")"
    note "${label}: status=${run_status:-missing}"
    case "$run_status" in
      completed)
        return 0
        ;;
      failed)
        warn "${label} failed"
        return 1
        ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done

  warn "${label} timed out after ${TIMEOUT_SECONDS}s"
  return 1
}

queue_and_poll_run() {
  local label="$1"
  shift
  local kickoff_path="$ARTIFACTS_DIR/${label}-kickoff.json"
  run_cli "$@" >"$kickoff_path"
  cat "$kickoff_path"
  local run_id
  run_id="$(extract_run_id "$kickoff_path")"
  [[ -n "$run_id" ]] || die "could not extract run id for ${label}"
  note "${label}: queued runId=${run_id}"
  poll_run_until_terminal "$label" "$run_id"
}

if [[ -S "$REAL_CUED_HOME/cued.sock" ]]; then
  warn "detected an existing socket at $REAL_CUED_HOME/cued.sock; stop any other local Cued instance before trusting the isolation diff"
  note "warning: real ~/.cued socket existed before smoke run"
fi

printf '# Cued Local Smoke Notes\n\n' >"$NOTES_PATH"
note "sandbox_root=$SANDBOX_ROOT"
note "app_source=$APP_SOURCE"

snapshot_path_manifest "$REAL_CUED_HOME" "$REAL_CUED_BEFORE"

if [[ $BUILD_APP -eq 1 ]]; then
  log "running local baseline build and checks"
  pnpm --dir "$ROOT_DIR" check:ci-local
  pnpm --dir "$ROOT_DIR" build:app:macos
else
  log "skipping build by request"
fi

[[ -d "$APP_SOURCE" ]] || die "built app bundle not found at $APP_SOURCE"

if [[ "$INSTALL_MODE" == "applications" ]]; then
  if [[ -d "$APPLICATIONS_APP_PATH" ]]; then
    log "backing up existing installed app to $INSTALLED_APP_BACKUP"
    rm -rf "$INSTALLED_APP_BACKUP"
    rsync -a --delete "$APPLICATIONS_APP_PATH/" "$INSTALLED_APP_BACKUP/"
    note "installed_app_backup=$INSTALLED_APP_BACKUP"
  fi

  log "installing built app into $APPLICATIONS_APP_PATH"
  mkdir -p "$(dirname "$APPLICATIONS_APP_PATH")"
  rsync -a --delete "$APP_SOURCE/" "$APPLICATIONS_APP_PATH/"
  APP_UNDER_TEST="$APPLICATIONS_APP_PATH"
else
  log "staging temp app bundle into $APP_UNDER_TEST"
  rm -rf "$APP_UNDER_TEST"
  rsync -a --delete "$APP_SOURCE/" "$APP_UNDER_TEST/"
fi

CLI="$APP_UNDER_TEST/Contents/Resources/cued-cli"
APP_BIN="$APP_UNDER_TEST/Contents/MacOS/CuedDaemon"

capture_screenshot "00-before-launch"

log "launching temp app bundle"
smoke_env "$APP_BIN" --menu-bar >"$APP_LOG" 2>&1 &
APP_PID="$!"
echo "$APP_PID" >"$ARTIFACTS_DIR/app.pid"
note "app_pid=$APP_PID"

wait_for_socket || die "temp daemon socket did not appear at $CUED_HOME_UNDER_TEST/cued.sock"
wait_for_onboarding_window || die "onboarding window did not appear"
note "onboarding_process=${ONBOARDING_PROCESS_NAME}"
capture_screenshot "01-onboarding-open"

if click_onboarding_button "Open Permissions"; then
  note "clicked onboarding Open Permissions button"
elif click_onboarding_button "Grant Access"; then
  note "clicked onboarding Grant Access button"
else
  warn "could not click the onboarding permission button automatically"
  note "automatic onboarding permission click failed"
  pause_for_user "Click the onboarding permission button manually and keep the Cued Settings window open."
fi

capture_screenshot "02-after-open-permissions"
pause_for_user "Grant Contacts and Full Disk Access while the onboarding window stays open. If macOS opens System Settings, complete the grants there, then return to Cued Settings."

activate_onboarding_app || true
sleep 2
capture_screenshot "03-after-permissions-return"

if confirm_user "Did the onboarding UI refresh away from the failing permission state without restarting the app?"; then
  note "user confirmed onboarding refreshed after permissions"
else
  note "user reported onboarding did not refresh after permissions"
fi

capture_cli "status-after-ui" status
capture_cli "permissions-status" permissions status
capture_cli "permissions-doctor" permissions doctor
capture_cli "doctor-initial" doctor
capture_cli "integrations-refresh" integrations refresh

queue_and_poll_run "contacts-sync" sync run contacts
queue_and_poll_run "imessage-sync" sync run imessage
queue_and_poll_run "rebuild" rebuild

capture_cli "status-final" status
capture_cli "doctor-final" doctor
capture_cli "permissions-doctor-final" permissions doctor
capture_cli "logs-final" logs --tail 200

snapshot_path_manifest "$REAL_CUED_HOME" "$REAL_CUED_AFTER"
if diff -u "$REAL_CUED_BEFORE" "$REAL_CUED_AFTER" >"$REAL_CUED_DIFF"; then
  note "real ~/.cued unchanged during smoke run"
else
  warn "real ~/.cued changed during smoke run; inspect $REAL_CUED_DIFF"
  note "real ~/.cued changed during smoke run"
fi

if [[ -e "$CUED_HOME_UNDER_TEST/local.db" ]]; then
  note "temp database created at $CUED_HOME_UNDER_TEST/local.db"
else
  warn "temp database missing at $CUED_HOME_UNDER_TEST/local.db"
  note "temp database missing"
fi

capture_screenshot "04-final"

log "smoke run artifacts are in $ARTIFACTS_DIR"
log "temp sandbox root: $SANDBOX_ROOT"
