#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/native/helpers/signal-cli/.build"
DOWNLOADS_DIR="$BUILD_ROOT/downloads"
OUTPUT_DIR="$BUILD_ROOT/cued-signal-cli"

SIGNAL_VERSION="0.14.1"
SIGNAL_ARCHIVE_NAME="signal-cli-${SIGNAL_VERSION}.tar.gz"
SIGNAL_ARCHIVE_URL="https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_VERSION}/${SIGNAL_ARCHIVE_NAME}"
SIGNAL_ARCHIVE_SHA256="cecda4b12c42c1884467f3a1f01377536212c2a5cfb210a5f361e82f8c1636e8"

TEMURIN_VERSION="25.0.2+10"
TEMURIN_VERSION_LABEL="25.0.2_10"

case "$(uname -m)" in
  arm64|aarch64)
    JRE_ARCHIVE_NAME="OpenJDK25U-jre_aarch64_mac_hotspot_${TEMURIN_VERSION_LABEL}.tar.gz"
    JRE_ARCHIVE_SHA256="ada9e68c0e525e36ecd354877866da3eb51bfdd5926ef43cdf881d9c4fd03f17"
    ;;
  x86_64)
    JRE_ARCHIVE_NAME="OpenJDK25U-jre_x64_mac_hotspot_${TEMURIN_VERSION_LABEL}.tar.gz"
    JRE_ARCHIVE_SHA256="df93fe61138672424ccb4cca5133903dc1f0d773c14c2afe0db7ce139e261264"
    ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

JRE_ARCHIVE_URL="https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.2%2B10/${JRE_ARCHIVE_NAME}"

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

  curl -fsSL "$url" -o "$output"

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

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/cued-signal-cli.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

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

echo "$OUTPUT_DIR"
