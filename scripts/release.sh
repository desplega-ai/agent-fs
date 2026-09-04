#!/bin/sh
set -e

# Bump the release version and hand off to CI.
#
# Usage:
#   ./scripts/release.sh 0.13.0   # bump to an explicit version
#   ./scripts/release.sh          # re-sync whatever root package.json already says
#
# Tagging and publishing are handled by .github/workflows/auto-release.yml the
# moment the version change lands on main. This script deliberately does NOT
# create the tag — doing so would race the workflow, which pushes the tag itself
# as soon as it sees the version change.

VERSION="${1:-$(jq -r .version package.json)}"
TAG="v${VERSION}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if git rev-parse "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "Error: ${TAG} already exists — pick a new version." >&2
  exit 1
fi

# sync-versions.ts is the source of truth: it rewrites every package.json, the
# FUSE Cargo.toml + Cargo.lock, the plugin metadata, and the optionalDependencies
# pins, so a one-liner jq loop is not enough.
bun run scripts/sync-versions.ts "$VERSION"
bun run scripts/sync-openapi.ts

# The same gate the Docker build runs. sync-versions.ts rewrote the bun.lock
# workspace versions above; any other lockfile drift fails here instead of in
# docker-publish, after the tag already exists and cannot be fixed.
bun install --frozen-lockfile

# Belt and braces — the same gate CI enforces, run before anything is pushed.
bun run scripts/sync-versions.ts --check

if git diff --quiet -- package.json bun.lock Cargo.lock docs/openapi.json packages/ .claude-plugin/ 2>/dev/null; then
  echo "Nothing to commit — already at ${VERSION}."
else
  git add package.json bun.lock Cargo.lock docs/openapi.json \
    packages/*/package.json packages/*/Cargo.toml .claude-plugin/plugin.json 2>/dev/null || true
  git commit -m "chore: release v${VERSION}"
fi

git push origin "HEAD:${BRANCH}"

echo ""
if [ "$BRANCH" = "main" ]; then
  echo "Pushed ${VERSION} to main. CI will tag ${TAG}, publish to npm, and build the image:"
  echo "  https://github.com/desplega-ai/agent-fs/actions"
else
  echo "Pushed ${VERSION} to ${BRANCH}. Open a PR — the release fires when it merges to main."
fi
