#!/bin/sh
# Install script for agentfs
# Usage: curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-fs/main/install.sh | sh
set -eu

REPO="desplega-ai/agent-fs"
BINARY="agentfs"

detect_platform() {
  platform=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$platform" in
    linux) echo "linux" ;;
    darwin) echo "darwin" ;;
    *)
      echo "Error: Unsupported platform: $platform" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "Error: Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac
}

PLATFORM=$(detect_platform)
ARCH=$(detect_arch)
VERSION="${1:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

ARTIFACT="${BINARY}-${PLATFORM}-${ARCH}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ARTIFACT}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}"
fi

echo "Installing ${BINARY} (${PLATFORM}/${ARCH})..."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if command -v curl > /dev/null 2>&1; then
  HTTP_CODE=$(curl -fsSL -w '%{http_code}' -o "${TMP}/${ARTIFACT}" "$URL" 2>/dev/null) || true
  if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "302" ]; then
    echo "Error: Download failed (HTTP ${HTTP_CODE})" >&2
    echo "URL: ${URL}" >&2
    exit 1
  fi
elif command -v wget > /dev/null 2>&1; then
  wget -qO "${TMP}/${ARTIFACT}" "$URL" || {
    echo "Error: Download failed" >&2
    echo "URL: ${URL}" >&2
    exit 1
  }
else
  echo "Error: curl or wget is required" >&2
  exit 1
fi

# Extract tarball
tar xzf "${TMP}/${ARTIFACT}" -C "${TMP}"

# Install binary and native extensions
chmod +x "${TMP}/${BINARY}"

if [ -w "$INSTALL_DIR" ]; then
  mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  # Copy native extensions next to binary
  for ext in "${TMP}"/*.dylib "${TMP}"/*.so; do
    [ -f "$ext" ] && mv "$ext" "${INSTALL_DIR}/" 2>/dev/null || true
  done
else
  echo "Need sudo to install to ${INSTALL_DIR}"
  sudo mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  for ext in "${TMP}"/*.dylib "${TMP}"/*.so; do
    [ -f "$ext" ] && sudo mv "$ext" "${INSTALL_DIR}/" 2>/dev/null || true
  done
fi

echo "Installed ${BINARY} to ${INSTALL_DIR}/${BINARY}"
echo "Run '${BINARY} --help' to get started"
