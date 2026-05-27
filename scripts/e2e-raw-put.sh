#!/usr/bin/env bash
#
# E2E round-trip for the binary `PUT /raw` route.
#
# Required env:
#   DAEMON_URL   — e.g. http://127.0.0.1:PORT  (daemon started by scripts/e2e.ts)
#   AGENT_FS_API_KEY
#   ORG_ID
#   DRIVE_ID
#
# Asserts:
#   (0) PUT/GET preserves arbitrary non-UTF-8 bytes
#   (a) PUT without If-Match creates v1 and returns X-Agent-FS-Version: 1
#   (b) PUT with matching If-Match: 1 returns X-Agent-FS-Version: 2
#   (c) PUT with stale If-Match: 1 (after v2) returns HTTP 409
#   (d) PUT with identical body + If-Match: 2 returns X-Agent-FS-Deduped: 1
#       and the same version (no bump)
#
# Run standalone for manual debugging:
#   DAEMON_URL=... AGENT_FS_API_KEY=... ORG_ID=... DRIVE_ID=... \
#     ./scripts/e2e-raw-put.sh
#
# Exits non-zero on first assertion failure.

set -euo pipefail

: "${DAEMON_URL:?DAEMON_URL required}"
: "${AGENT_FS_API_KEY:?AGENT_FS_API_KEY required}"
: "${ORG_ID:?ORG_ID required}"
: "${DRIVE_ID:?DRIVE_ID required}"

PATH_SEG="e2e-raw-$(date +%s)-$$.txt"
BASE="${DAEMON_URL}/orgs/${ORG_ID}/drives/${DRIVE_ID}/files/${PATH_SEG}/raw"
AUTH="Authorization: Bearer ${AGENT_FS_API_KEY}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

extract_header() {
  # $1 = header name (case-insensitive grep), $2 = headers file
  grep -i "^$1:" "$2" | head -1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r\n'
}

assert_eq() {
  if [ "$1" != "$2" ]; then
    echo "ASSERTION FAILED: expected '$2', got '$1' ($3)" >&2
    exit 1
  fi
}

# (0) Binary PUT + GET — bytes must round-trip exactly.
echo "→ PUT/GET preserves binary bytes"
BIN_PATH="e2e-raw-binary-$(date +%s)-$$.png"
BIN_BASE="${DAEMON_URL}/orgs/${ORG_ID}/drives/${DRIVE_ID}/files/${BIN_PATH}/raw"
printf '\211PNG\r\n\032\n\000\377\376' > "$tmp/in.bin"
curl -sS -X PUT \
  -H "$AUTH" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$tmp/in.bin" \
  -D "$tmp/h0" -o "$tmp/b0" \
  "$BIN_BASE"
status=$(head -1 "$tmp/h0" | awk '{print $2}')
assert_eq "$status" "200" "binary PUT status"
curl -sS \
  -H "$AUTH" \
  -D "$tmp/h0get" -o "$tmp/out.bin" \
  "$BIN_BASE"
status=$(head -1 "$tmp/h0get" | awk '{print $2}')
assert_eq "$status" "200" "binary GET status"
cmp -s "$tmp/in.bin" "$tmp/out.bin" || {
  echo "ASSERTION FAILED: binary GET bytes differ from PUT bytes" >&2
  exit 1
}

# (a) Initial PUT — no If-Match → v1
echo "→ PUT (no If-Match) creates v1"
curl -sS -X PUT \
  -H "$AUTH" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "hello world v1" \
  -D "$tmp/h1" -o "$tmp/b1" \
  "$BASE"
status=$(head -1 "$tmp/h1" | awk '{print $2}')
assert_eq "$status" "200" "PUT v1 status"
v1=$(extract_header "x-agent-fs-version" "$tmp/h1")
assert_eq "$v1" "1" "x-agent-fs-version after first PUT"
dedup1=$(extract_header "x-agent-fs-deduped" "$tmp/h1")
assert_eq "$dedup1" "0" "x-agent-fs-deduped after first PUT"

# (b) PUT with matching If-Match: 1 → v2
echo "→ PUT (If-Match: 1) creates v2"
curl -sS -X PUT \
  -H "$AUTH" \
  -H "Content-Type: application/octet-stream" \
  -H "If-Match: 1" \
  --data-binary "hello world v2" \
  -D "$tmp/h2" -o "$tmp/b2" \
  "$BASE"
status=$(head -1 "$tmp/h2" | awk '{print $2}')
assert_eq "$status" "200" "PUT v2 status"
v2=$(extract_header "x-agent-fs-version" "$tmp/h2")
assert_eq "$v2" "2" "x-agent-fs-version after If-Match: 1"

# (c) PUT with stale If-Match: 1 (head is now 2) → 409
echo "→ PUT (stale If-Match: 1) returns 409"
status=$(curl -sS -X PUT \
  -H "$AUTH" \
  -H "Content-Type: application/octet-stream" \
  -H "If-Match: 1" \
  --data-binary "stale write" \
  -o "$tmp/b3" -w "%{http_code}" \
  "$BASE")
assert_eq "$status" "409" "stale If-Match should return 409"

# (d) PUT with identical body + matching If-Match → deduped
echo "→ PUT (identical body, If-Match: 2) is deduped"
curl -sS -X PUT \
  -H "$AUTH" \
  -H "Content-Type: application/octet-stream" \
  -H "If-Match: 2" \
  --data-binary "hello world v2" \
  -D "$tmp/h4" -o "$tmp/b4" \
  "$BASE"
status=$(head -1 "$tmp/h4" | awk '{print $2}')
assert_eq "$status" "200" "dedup PUT status"
v_after=$(extract_header "x-agent-fs-version" "$tmp/h4")
assert_eq "$v_after" "2" "dedup PUT must NOT bump version"
dedup=$(extract_header "x-agent-fs-deduped" "$tmp/h4")
assert_eq "$dedup" "1" "x-agent-fs-deduped on identical body"

echo "OK: PUT /raw round-trip"
