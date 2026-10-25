#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/native/helpers/signal-cli/.build"
DOWNLOADS_DIR="$BUILD_ROOT/downloads"
OUTPUT_DIR="$BUILD_ROOT/cued-signal-cli"
INSTALL_ROOT=""
if [[ "${1:-}" == "--install-root" && -n "${2:-}" ]]; then
  INSTALL_ROOT="$2"
  BUILD_ROOT="$INSTALL_ROOT"
  DOWNLOADS_DIR="$BUILD_ROOT/downloads"
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--install-root <directory>]" >&2
  exit 1
fi
umask 077

MANIFEST="$(dirname "${BASH_SOURCE[0]}")/packaging/signal-runtime.json"
manifest_value() { /usr/bin/plutil -extract "$1" raw -o - "$MANIFEST"; }
SIGNAL_VERSION="$(manifest_value signalVersion)"
SIGNAL_ARCHIVE_NAME="signal-cli-${SIGNAL_VERSION}.tar.gz"
SIGNAL_ARCHIVE_URL="https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_VERSION}/${SIGNAL_ARCHIVE_NAME}"
SIGNAL_ARCHIVE_SHA256="$(manifest_value signalArchiveSha256)"

TEMURIN_VERSION="$(manifest_value jreVersion)"
TEMURIN_VERSION_LABEL="$(manifest_value jreVersionLabel)"

case "$(uname -m)" in
  arm64|aarch64)
    RUNTIME_ARCH="arm64"
    JRE_ARCHIVE_NAME="OpenJDK25U-jre_aarch64_mac_hotspot_${TEMURIN_VERSION_LABEL}.tar.gz"
    JRE_ARCHIVE_SHA256="$(manifest_value arm64.jreArchiveSha256)"
    ;;
  x86_64)
    RUNTIME_ARCH="x64"
    JRE_ARCHIVE_NAME="OpenJDK25U-jre_x64_mac_hotspot_${TEMURIN_VERSION_LABEL}.tar.gz"
    JRE_ARCHIVE_SHA256="$(manifest_value x64.jreArchiveSha256)"
    ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

JRE_ARCHIVE_URL="https://github.com/adoptium/temurin25-binaries/releases/download/$(manifest_value jreRelease)/${JRE_ARCHIVE_NAME}"

# Runtime installs are immutable/versioned; publishing current is one atomic rename.
# Serialize independent CLI/daemon processes so they never share partial downloads.
mkdir -p "$BUILD_ROOT"
# A kernel advisory lock is released after crashes/reboots. Keep the same inode
# for all contenders; never delete the lock file as part of cleanup.
exec 9>"$BUILD_ROOT/.install.lock"
/usr/bin/lockf -t 360 9
tmp_dir=""
cleanup() {
  [[ -z "$tmp_dir" ]] || rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ -n "$INSTALL_ROOT" ]]; then
  OUTPUT_DIR="$BUILD_ROOT/signal-${SIGNAL_VERSION}-jre-${TEMURIN_VERSION_LABEL}-${RUNTIME_ARCH}-${SIGNAL_ARCHIVE_SHA256:0:16}-${JRE_ARCHIVE_SHA256:0:16}"
  if [[ -x "$OUTPUT_DIR/cued-signal-cli" ]]; then
    tmp_dir="$(mktemp -d "$BUILD_ROOT/.publish.XXXXXX")"
    ln -s "$(basename "$OUTPUT_DIR")" "$tmp_dir/current"
    mv -fh "$tmp_dir/current" "$BUILD_ROOT/current"
    echo "$OUTPUT_DIR"
    exit 0
  fi
fi

download_and_verify() {
  local url="$1"
  local checksum="$2"
  local output="$3"

  if [[ -f "$output" ]]; then
    local existing
    existing="$(shasum -a 256 "$output" | awk '{print $1}')"
    if [[ "$existing" == "$checksum" ]]; then
      return
    fi
    rm -f "$output"
  fi

  curl --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 -fsSL "$url" -o "$output"

  local downloaded
  downloaded="$(shasum -a 256 "$output" | awk '{print $1}')"
  if [[ "$downloaded" != "$checksum" ]]; then
    echo "Checksum verification failed for $(basename "$output")" >&2
    echo "Expected: $checksum" >&2
    echo "Actual:   $downloaded" >&2
    exit 1
  fi
}

mkdir -p "$DOWNLOADS_DIR"

SIGNAL_ARCHIVE_PATH="$DOWNLOADS_DIR/$SIGNAL_ARCHIVE_NAME"
JRE_ARCHIVE_PATH="$DOWNLOADS_DIR/$JRE_ARCHIVE_NAME"

download_and_verify "$SIGNAL_ARCHIVE_URL" "$SIGNAL_ARCHIVE_SHA256" "$SIGNAL_ARCHIVE_PATH"
download_and_verify "$JRE_ARCHIVE_URL" "$JRE_ARCHIVE_SHA256" "$JRE_ARCHIVE_PATH"

tmp_dir="$(mktemp -d "$BUILD_ROOT/.stage.XXXXXX")"

tar -xzf "$SIGNAL_ARCHIVE_PATH" -C "$tmp_dir"
tar -xzf "$JRE_ARCHIVE_PATH" -C "$tmp_dir"

signal_extracted_dir="$tmp_dir/signal-cli-${SIGNAL_VERSION}"
jre_extracted_dir="$tmp_dir/jdk-${TEMURIN_VERSION}-jre"

if [[ ! -d "$signal_extracted_dir" ]]; then
  echo "signal-cli archive did not extract as expected" >&2
  exit 1
fi

if [[ ! -d "$jre_extracted_dir" ]]; then
  echo "Temurin JRE archive did not extract as expected" >&2
  exit 1
fi

stage_dir="$tmp_dir/cued-signal-cli"
mkdir -p "$stage_dir"
mv "$signal_extracted_dir" "$stage_dir/signal-cli"
mv "$jre_extracted_dir" "$stage_dir/jre"

cat > "$stage_dir/cued-signal-cli" <<'EOF'
#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export JAVA_HOME="${SCRIPT_DIR}/jre/Contents/Home"
export PATH="${JAVA_HOME}/bin:${PATH}"
exec "${SCRIPT_DIR}/signal-cli/bin/signal-cli" "$@"
EOF
chmod +x "$stage_dir/cued-signal-cli"

cat > "$stage_dir/metadata.json" <<EOF
{
  "signalVersion": "${SIGNAL_VERSION}",
  "signalArchive": "${SIGNAL_ARCHIVE_NAME}",
  "signalArchiveSha256": "${SIGNAL_ARCHIVE_SHA256}",
  "jreVersion": "${TEMURIN_VERSION}",
  "jreArchive": "${JRE_ARCHIVE_NAME}",
  "jreArchiveSha256": "${JRE_ARCHIVE_SHA256}"
}
EOF

rm -rf "$OUTPUT_DIR"
mkdir -p "$BUILD_ROOT"
mv "$stage_dir" "$OUTPUT_DIR"
if [[ -n "$INSTALL_ROOT" ]]; then
  ln -s "$(basename "$OUTPUT_DIR")" "$tmp_dir/current"
  mv -fh "$tmp_dir/current" "$BUILD_ROOT/current"
  # The extracted runtime is sufficient; do not retain a second compressed copy.
  rm -f "$SIGNAL_ARCHIVE_PATH" "$JRE_ARCHIVE_PATH"
fi

echo "$OUTPUT_DIR"
