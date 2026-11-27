#!/usr/bin/env bash
#
# The one way to cut a Cued macOS release. See scripts/README.md ("Releasing").
#
# Runs, in order: preflight checks, the local quality gate, the signed + notarized build
# (scripts/build-cued-release-artifacts.sh), release metadata
# (scripts/build-cued-release-metadata.mjs), and, only with --publish, `gh release create`.
# Every check that can fail without building anything runs first, so a missing credential is
# reported in seconds, before anything is signed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/native/macos/dist"
APP_BUNDLE="$DIST_DIR/Cued.app"
RELEASE_ASSETS=(
  "$DIST_DIR/Cued.dmg"
  "$DIST_DIR/cued-macos-arm64.tar.gz"
  "$DIST_DIR/release.json"
  "$DIST_DIR/SHA256SUMS"
)

CHANNEL=""
VERSION=""
NOTES_FILE=""
PUBLISH=0
PREFLIGHT_ONLY=0
SKIP_CHECKS=0
REPO="${CUED_RELEASE_REPO:-Cue-d/cued}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release-cued-macos.sh --channel stable|prerelease --version X.Y.Z[-suffix] [options]

Required:
  --channel stable|prerelease  stable: a normal GitHub release, offered to every install.
                               prerelease: a GitHub prerelease, offered only to builds on the
                               internal channel. The version must then carry a suffix
                               (for example 0.2.0-internal.1).
  --version VERSION            Must equal "version" in package.json (bump it in a commit first).

Options:
  --notes-file PATH            Release notes (Markdown). Required with --publish.
  --publish                    Create the GitHub release and upload the artifacts. Without this
                               flag nothing leaves the machine except the notarization upload.
  --preflight-only             Run the checks and stop before building or signing anything.
  --skip-checks                Skip `pnpm check:ci-local` (only when it already passed on this commit).
  --help                       Show this help.

Environment:
  CUED_CODESIGN_IDENTITY                 Developer ID Application identity (name or SHA-1) in the keychain.
  CUED_NOTARY_PROFILE                    `xcrun notarytool store-credentials` profile name.
  CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE  Gmail OAuth desktop client JSON. Required for --channel stable.
  CUED_RELEASE_REPO                      GitHub repository (default: Cue-d/cued).
EOF
}

die() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '\n==> %s\n' "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      CHANNEL="${2:-}"
      shift 2 || die "--channel needs a value"
      ;;
    --channel=*)
      CHANNEL="${1#*=}"
      shift
      ;;
    --version)
      VERSION="${2:-}"
      shift 2 || die "--version needs a value"
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      shift 2 || die "--notes-file needs a value"
      ;;
    --notes-file=*)
      NOTES_FILE="${1#*=}"
      shift
      ;;
    --publish)
      PUBLISH=1
      shift
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=1
      shift
      ;;
    --skip-checks)
      SKIP_CHECKS=1
      shift
      ;;
    --)
      # `pnpm release:macos -- ...` passes the separator through.
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

# --- Preflight: arguments and version -----------------------------------------------------

[[ -n "$CHANNEL" ]] || { usage >&2; die "--channel is required (stable or prerelease)"; }
[[ -n "$VERSION" ]] || { usage >&2; die "--version is required"; }

case "$CHANNEL" in
  stable) RUNTIME_CHANNEL="stable" ;;
  prerelease) RUNTIME_CHANNEL="internal" ;;
  *) die "--channel must be stable or prerelease, not '$CHANNEL'" ;;
esac

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
[[ "$VERSION" =~ $SEMVER_RE ]] || die "--version '$VERSION' is not a semantic version (X.Y.Z or X.Y.Z-suffix)"
if [[ "$CHANNEL" == "stable" && "$VERSION" == *-* ]]; then
  die "stable releases cannot have a prerelease suffix ('$VERSION'); use --channel prerelease"
fi
if [[ "$CHANNEL" == "prerelease" && "$VERSION" != *-* ]]; then
  die "prerelease versions need a suffix such as $VERSION-internal.1, or stable installs would see it as final"
fi

if [[ "$PUBLISH" -eq 1 ]]; then
  [[ -n "$NOTES_FILE" ]] || die "--publish needs --notes-file with the release notes"
fi
if [[ -n "$NOTES_FILE" && ! -s "$NOTES_FILE" ]]; then
  die "notes file '$NOTES_FILE' does not exist or is empty"
fi

# --- Preflight: host and tools --------------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || die "releases are built on macOS"
[[ "$(uname -m)" == "arm64" ]] || die "release artifacts are Apple Silicon only; build on an arm64 Mac"

missing_tools=()
for tool in node pnpm swift go codesign security xcrun git; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
if [[ "$PUBLISH" -eq 1 ]]; then
  command -v gh >/dev/null 2>&1 || missing_tools+=("gh")
fi
[[ "${#missing_tools[@]}" -eq 0 ]] || die "missing required tools: ${missing_tools[*]}"

PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
[[ "$PACKAGE_VERSION" == "$VERSION" ]] ||
  die "--version $VERSION does not match package.json ($PACKAGE_VERSION); commit the version bump first"

TAG="v$VERSION"

# --- Preflight: git state -------------------------------------------------------------------

cd "$ROOT_DIR"
[[ -z "$(git status --porcelain)" ]] || die "working tree has uncommitted changes; release from a clean checkout"
COMMIT="$(git rev-parse HEAD)"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag $TAG already exists locally; pick a new version"
fi

# --- Preflight: credentials -----------------------------------------------------------------

missing_env=()
[[ -n "${CUED_CODESIGN_IDENTITY:-}" ]] || missing_env+=("CUED_CODESIGN_IDENTITY")
[[ -n "${CUED_NOTARY_PROFILE:-}" ]] || missing_env+=("CUED_NOTARY_PROFILE")
if [[ "$CHANNEL" == "stable" ]]; then
  [[ -n "${CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE:-}" ]] || missing_env+=("CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE")
fi
if [[ "${#missing_env[@]}" -gt 0 ]]; then
  die "missing required environment variables: ${missing_env[*]} (see scripts/README.md, \"Releasing\")"
fi

if ! security find-identity -v -p codesigning | grep -qF -- "$CUED_CODESIGN_IDENTITY"; then
  die "signing identity in CUED_CODESIGN_IDENTITY was not found among valid codesigning identities (security find-identity -v -p codesigning)"
fi

if ! xcrun notarytool history --keychain-profile "$CUED_NOTARY_PROFILE" >/dev/null 2>&1; then
  die "notary profile in CUED_NOTARY_PROFILE is missing or invalid (create it with: xcrun notarytool store-credentials <profile>)"
fi

if [[ "$CHANNEL" == "stable" ]]; then
  [[ -r "$CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE" ]] ||
    die "CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE does not point to a readable file"
  node -e '
    const { readFileSync } = require("node:fs");
    const parsed = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!parsed.installed?.client_id || !parsed.installed?.client_secret) process.exit(1);
  ' "$CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE" 2>/dev/null ||
    die "CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE must be a Google OAuth desktop client JSON with installed.client_id and installed.client_secret"
fi

if [[ "$PUBLISH" -eq 1 ]]; then
  gh auth status >/dev/null 2>&1 || die "gh is not signed in (gh auth login)"
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    die "release $TAG already exists on $REPO"
  fi
  git fetch --quiet origin main
  git merge-base --is-ancestor "$COMMIT" origin/main ||
    die "HEAD ($COMMIT) is not on origin/main; merge and push the release commit first"
fi

printf 'release: preflight passed for %s (%s channel, commit %s)\n' "$TAG" "$CHANNEL" "${COMMIT:0:12}"
if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  exit 0
fi

# --- Build, sign, notarize --------------------------------------------------------------------

export CUED_RELEASE_CHANNEL="$RUNTIME_CHANNEL"
export CUED_RELEASE_VERSION="$VERSION"
export CUED_RELEASE_TAG="$TAG"
export CUED_RELEASE_REPO="$REPO"

if [[ "$SKIP_CHECKS" -eq 0 ]]; then
  log "Quality gate (pnpm check:ci-local)"
  pnpm check:ci-local
fi

log "Build, sign, notarize and staple (scripts/build-cued-release-artifacts.sh)"
bash "$ROOT_DIR/scripts/build-cued-release-artifacts.sh"

log "Validate the signed app (scripts/validate-cued-release-artifact.sh)"
bash "$ROOT_DIR/scripts/validate-cued-release-artifact.sh" "$APP_BUNDLE"

log "Release metadata (scripts/build-cued-release-metadata.mjs)"
node "$ROOT_DIR/scripts/build-cued-release-metadata.mjs"

for asset in "${RELEASE_ASSETS[@]}"; do
  [[ -f "$asset" ]] || die "expected release asset missing: $asset"
done

# --- Publish (explicit only) ------------------------------------------------------------------

gh_args=(release create "$TAG" "${RELEASE_ASSETS[@]}"
  --repo "$REPO" --target "$COMMIT" --title "Cued $VERSION")
if [[ "$CHANNEL" == "prerelease" ]]; then
  gh_args+=(--prerelease)
fi

if [[ "$PUBLISH" -eq 0 ]]; then
  log "Built $TAG; not published (no --publish)"
  printf 'Artifacts:\n'
  printf '  %s\n' "${RELEASE_ASSETS[@]}"
  printf 'To publish these exact artifacts:\n  gh'
  printf ' %q' "${gh_args[@]}" --notes-file "<notes.md>"
  printf '\n'
  exit 0
fi

log "Publish $TAG to $REPO"
gh "${gh_args[@]}" --notes-file "$NOTES_FILE"
printf 'release: published %s\n' "$TAG"
