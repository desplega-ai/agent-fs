#!/bin/sh
# Remove files from a production `bun install` that the server image never
# loads. Run from the app directory, in the same RUN step as the install so
# the removed bytes never land in a layer.
#
# What goes, and why it is safe on the server path:
# - node-llama-cpp GPU builds (CUDA, Vulkan) and the builds for other CPU
#   architectures: getLlama() falls back to the CPU build for this
#   architecture, which stays.
# - musl builds (duckdb, canvas, sharp, reflink): the image is Debian (glibc).
# - onnxruntime-node binaries for macOS, Windows and other architectures.
# - onnxruntime-web: transformers' Node build bundles the part it needs and
#   loads onnxruntime-node for inference.
# - typescript and sql.js: dependencies of just-bash, which only the tests use.
# - bun's install cache.
set -eu

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "prune-node-modules: unknown architecture $(uname -m), skipping" >&2; exit 0 ;;
esac

store=node_modules/.bun
before=$(du -sm node_modules | cut -f1)

for dir in "$store"/*; do
  name=${dir#"$store"/}
  case "$name" in
    @node-llama-cpp+linux-"$arch"@*) ;;
    @node-llama-cpp+*) rm -rf "$dir" ;;
    *musl*) rm -rf "$dir" ;;
    onnxruntime-web@* | typescript@* | sql.js@*) rm -rf "$dir" ;;
  esac
done

for bin in "$store"/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*; do
  [ -d "$bin" ] || continue
  for os_dir in "$bin"/*; do
    case "${os_dir##*/}" in
      linux)
        for arch_dir in "$os_dir"/*; do
          [ "${arch_dir##*/}" = "$arch" ] || rm -rf "$arch_dir"
        done
        ;;
      *) rm -rf "$os_dir" ;;
    esac
  done
done

# Links into removed packages now point nowhere.
find node_modules -type l ! -exec test -e {} \; -delete

rm -rf "${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}"

after=$(du -sm node_modules | cut -f1)
echo "prune-node-modules: node_modules ${before} MB -> ${after} MB"
