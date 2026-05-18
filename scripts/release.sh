#!/bin/sh
set -e

VERSION=$(jq -r .version package.json)
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag ${TAG} already exists" >&2
  exit 1
fi

# Sync version across every package.json, the FUSE helper Cargo.toml, and the plugin metadata.
# scripts/sync-versions.ts is the source of truth — it also rewrites the optionalDependencies
# pins for the FUSE sub-packages so a one-liner jq loop is no longer enough.
bun run scripts/sync-versions.ts "$VERSION"

# Commit if anything was rewritten.
if ! git diff --quiet packages/ .claude-plugin/ 2>/dev/null; then
  git add packages/*/package.json packages/*/Cargo.toml .claude-plugin/plugin.json 2>/dev/null || true
  git commit -m "chore: sync sub-package versions to ${VERSION}"
  git push origin main
fi

echo "Creating release ${TAG}..."
git tag "$TAG"
git push origin "$TAG"
echo "Release ${TAG} triggered. Check: https://github.com/desplega-ai/agent-fs/actions"
