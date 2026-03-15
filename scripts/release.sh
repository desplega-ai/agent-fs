#!/bin/sh
set -e

VERSION=$(jq -r .version package.json)
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag ${TAG} already exists" >&2
  exit 1
fi

echo "Creating release ${TAG}..."
git tag "$TAG"
git push origin "$TAG"
echo "Release ${TAG} triggered. Check: https://github.com/desplega-ai/agent-fs/actions"
