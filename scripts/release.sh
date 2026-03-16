#!/bin/sh
set -e

VERSION=$(jq -r .version package.json)
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag ${TAG} already exists" >&2
  exit 1
fi

# Sync version to all sub-packages
for pkg in packages/*/package.json; do
  jq --arg v "$VERSION" '.version = $v' "$pkg" > "$pkg.tmp" && mv "$pkg.tmp" "$pkg"
done

# Commit if versions changed
if ! git diff --quiet packages/*/package.json; then
  git add packages/*/package.json
  git commit -m "chore: sync sub-package versions to ${VERSION}"
  git push origin main
fi

echo "Creating release ${TAG}..."
git tag "$TAG"
git push origin "$TAG"
echo "Release ${TAG} triggered. Check: https://github.com/desplega-ai/agent-fs/actions"
