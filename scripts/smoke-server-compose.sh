#!/usr/bin/env bash
# Builds the server image and runs the repo's docker-compose.yml (agent-fs +
# MinIO), then checks what a user of that stack depends on: the image
# HEALTHCHECK passes, the published port answers from the host, and a file
# written through the API reads back from the MinIO bucket compose created.
# Usage: scripts/smoke-server-compose.sh
set -euo pipefail

cd "$(dirname "$0")/.."
project="afs-smoke-$$"
override=$(mktemp)
fail=0

# Embeddings would download a model on the first write; the smoke does not need them.
cat > "$override" <<'EOF'
services:
  agent-fs:
    environment:
      AGENT_FS_EMBEDDING_MAX_BYTES: "1"
      ANONYMIZED_TELEMETRY: "false"
EOF

compose() { docker compose -p "$project" -f docker-compose.yml -f "$override" "$@"; }
cleanup() {
  if [[ $fail -ne 0 ]]; then compose logs --no-color --tail 80 || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$override"
}
trap cleanup EXIT

check() {
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: expected [$3], got [$2]"
    fail=1
  fi
}

# --wait returns once every service with a healthcheck reports healthy, so it
# fails here if the image HEALTHCHECK cannot pass.
if ! compose up -d --build --wait --wait-timeout 180; then
  fail=1
  echo "FAIL compose up --wait (a service never became healthy)"
  exit 1
fi

cid=$(compose ps -q agent-fs)
check "agent-fs container health" "$(docker inspect --format '{{.State.Health.Status}}' "$cid")" "healthy"
image=$(docker inspect --format '{{.Image}}' "$cid")
# Unpacked size from inside the image, and the size of what a pull downloads
# (docker save of the containerd image store exports compressed layers).
unpacked=$(docker run --rm --entrypoint sh "$image" -c 'du -sxm / | cut -f1')
echo "info image size: ${unpacked} MB unpacked, $(( $(docker save "$image" | wc -c) / 1000000 )) MB compressed"

base="http://127.0.0.1:7433"
check "/health from the host" "$(curl -s -o /dev/null -w '%{http_code}' "$base/health")" "200"

reg=$(curl -fs -X POST "$base/auth/register" -H 'content-type: application/json' -d '{"email":"smoke@agent-fs.local"}')
key=$(jq -r .apiKey <<<"$reg")
org=$(jq -r .orgId <<<"$reg")
op() { curl -s -X POST "$base/orgs/$org/ops" -H "authorization: Bearer $key" -H 'content-type: application/json' -d "$1"; }

check "write through MinIO" "$(op '{"op":"write","path":"/smoke/a.md","content":"compose smoke"}' | jq -r .path)" "/smoke/a.md"
check "read back" "$(op '{"op":"cat","path":"/smoke/a.md"}' | jq -r .content)" "compose smoke"

exit $fail
