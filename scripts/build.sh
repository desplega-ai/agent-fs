#!/bin/bash
# Build agent-fs binary with native extensions alongside it.
# Usage: ./scripts/build.sh [--target bun-darwin-arm64] [--outfile dist/agent-fs]
set -euo pipefail

TARGET=""
OUTFILE="dist/agent-fs"

while [[ $# -gt 0 ]]; do
  case $1 in
    --target) TARGET="$2"; shift 2 ;;
    --outfile) OUTFILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

OUTDIR=$(dirname "$OUTFILE")
mkdir -p "$OUTDIR"

# Compile binary
if [ -n "$TARGET" ]; then
  bun build --compile --minify --target="$TARGET" packages/cli/src/index.ts --outfile "$OUTFILE"
else
  bun build --compile packages/cli/src/index.ts --outfile "$OUTFILE"
fi

# Detect platform from target flag or current system
if [ -n "$TARGET" ]; then
  case "$TARGET" in
    *darwin*) BUILD_PLATFORM="darwin" ;;
    *linux*)  BUILD_PLATFORM="linux" ;;
    *windows*) BUILD_PLATFORM="windows" ;;
    *) echo "Unknown target platform: $TARGET" >&2; exit 1 ;;
  esac
  case "$TARGET" in
    *arm64*) BUILD_ARCH="arm64" ;;
    *x64*)   BUILD_ARCH="x64" ;;
    *) echo "Unknown target arch: $TARGET" >&2; exit 1 ;;
  esac
else
  BUILD_PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
  case $(uname -m) in
    arm64|aarch64) BUILD_ARCH="arm64" ;;
    x86_64|amd64)  BUILD_ARCH="x64" ;;
  esac
fi

# Determine extension suffix and package name
case "$BUILD_PLATFORM" in
  darwin) EXT="dylib"; VEC_PKG="sqlite-vec-darwin-${BUILD_ARCH}" ;;
  linux)  EXT="so";    VEC_PKG="sqlite-vec-linux-${BUILD_ARCH}" ;;
  windows) EXT="dll";  VEC_PKG="sqlite-vec-windows-${BUILD_ARCH}" ;;
esac

# Copy vec0 extension
VEC_PATH=$(find node_modules -path "*/${VEC_PKG}/vec0.${EXT}" -type f 2>/dev/null | head -1)
if [ -n "$VEC_PATH" ]; then
  cp "$VEC_PATH" "${OUTDIR}/vec0.${EXT}"
  echo "Copied vec0.${EXT}"
else
  echo "Warning: Could not find vec0.${EXT} for ${VEC_PKG}" >&2
fi

# On macOS, also copy Homebrew's libsqlite3 (bun's built-in doesn't support loadExtension)
if [ "$BUILD_PLATFORM" = "darwin" ]; then
  for SQLITE_PATH in /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib /usr/local/opt/sqlite3/lib/libsqlite3.dylib; do
    if [ -f "$SQLITE_PATH" ]; then
      cp "$SQLITE_PATH" "${OUTDIR}/libsqlite3.dylib"
      echo "Copied libsqlite3.dylib"
      break
    fi
  done
fi

echo "Build complete: ${OUTFILE} + native extensions in ${OUTDIR}/"
ls -la "$OUTDIR"/
