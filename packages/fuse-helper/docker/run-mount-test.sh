#!/usr/bin/env bash
# Docker harness for the agent-fs FUSE helper.
#
# Builds the test image, runs it with FUSE caps, mounts the helper against a
# stub Unix socket, and asserts the mount table looks right.
#
# Intended for Darwin developers who can't natively mount FUSE, and for CI
# runners that allow privileged FUSE caps.
#
# Optional env (CI sets both):
# - AGENT_FS_FUSE_TEST_IMAGE: run this already-built image, skip docker build.
# - AGENT_FS_FUSE_BIN: helper path inside the container (under /work); the
#   container runs it instead of building the helper itself.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IMAGE_TAG="${AGENT_FS_FUSE_TEST_IMAGE:-agent-fs-fuse-test:local}"

cd "$REPO_ROOT"

if [ -n "${AGENT_FS_FUSE_TEST_IMAGE:-}" ]; then
    echo "== using prebuilt image: $IMAGE_TAG =="
else
    echo "== docker build =="
    docker build \
        -f packages/fuse-helper/docker/Dockerfile.test \
        -t "$IMAGE_TAG" \
        .
fi

echo "== docker run --cap-add SYS_ADMIN --device /dev/fuse =="
# - SYS_ADMIN + /dev/fuse: required for FUSE mounts inside the container.
# - Bind-mount the repo at /work so the in-container script can cargo build
#   the source tree without baking it into the image.
# - --security-opt apparmor=unconfined: needed on Ubuntu hosts where the
#   default profile blocks /dev/fuse access. Harmless on Darwin Docker
#   Desktop where AppArmor isn't enforced.
docker run --rm \
    --cap-add SYS_ADMIN \
    --device /dev/fuse \
    --security-opt apparmor=unconfined \
    -e AGENT_FS_FUSE_BIN \
    -v "$REPO_ROOT":/work \
    "$IMAGE_TAG"

echo "harness OK"
