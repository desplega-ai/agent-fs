---
date: 2026-03-15T00:00:00Z
author: Claude
topic: "agent-fs v1 Manual Test Checklist"
tags: [testing, manual, agent-fs]
---

# agent-fs v1 — Manual Test Checklist

Tests that Claude verified automatically are marked with ✅.
Tests for Taras to verify locally are marked with ☐.

## Prerequisites

```bash
# MinIO should be running (Claude started it)
docker ps | grep agentfs-minio

# agentfs CLI should be linked
agentfs --version  # should show 0.1.0
```

---

## Automated Tests (✅ all passing)

- ✅ DB init: sqlite-vec, FTS5, vec0, all tables, WAL mode (5 tests)
- ✅ Config: AGENTFS_HOME override, defaults, persistence (4 tests)
- ✅ S3 client: constructor, versioning flag (2 tests)
- ✅ S3 integration: put/get/copy/delete/head/list/versioning against MinIO (9 tests)
- ✅ File ops: write/cat/edit/append/head/tail/ls/stat/rm/mv/cp/mkdir/log/diff/revert/recent (22 tests)
- ✅ Search: FTS5 find/grep, indexing integration, rm removes from index (7 tests)
- ✅ Identity & RBAC: user creation, API keys, org invite, permission checks (15 tests)
- ✅ REST API: health, register, auth, ops roundtrip, orgs/drives (11 tests)
- ✅ MCP: tool registration (2 tests)
- ✅ Chunker: large/small content (2 tests)
- ✅ OpenAI embeddings: 768-dim vectors, semantic search relevance (3 tests)
- ✅ Local embeddings (nomic-embed-text-v1.5): auto-download, semantic search relevance (3 tests)
- ✅ CI safety: 0 failures without MinIO/API keys (55 skipped)

---

## Tests for Taras

### 1. MCP in Claude Code (no setup needed)

`.mcp.json` is configured. Embedded mode auto-creates a local user — no registration needed.

Just restart Claude Code in this project, then:

- ☐ agentfs MCP tools appear in tool list
- ☐ `write` tool creates a file
- ☐ `cat` tool reads it back
- ☐ `ls` tool lists directory
- ☐ `edit` tool modifies content
- ☐ `log` tool shows version history
- ☐ stderr shows `[agent-fs] Running in embedded mode`

### 2. CLI E2E (requires daemon)

```bash
docker start agentfs-minio
agentfs daemon start
```

- ☐ `agentfs daemon start` — starts daemon, shows PID
- ☐ `agentfs daemon status` — shows "running"

```bash
agentfs auth register you@example.com
```

- ☐ Returns API key, saves to config

```bash
agentfs write /docs/readme.md --content "# My Project\n\nThis is agent-fs."
agentfs cat /docs/readme.md
agentfs edit /docs/readme.md --old "My Project" --new "Agent FS" -m "Renamed"
agentfs ls /docs/
agentfs stat /docs/readme.md
agentfs head /docs/readme.md -n 2
agentfs append /docs/readme.md --content "\n## Getting Started"
agentfs cp /docs/readme.md /backup/readme.md
agentfs mv /backup/readme.md /archive/readme.md
agentfs mkdir /reports/
```

- ☐ All return valid JSON
- ☐ `cat` shows edited + appended content

```bash
agentfs log /docs/readme.md
agentfs diff /docs/readme.md --v1 1 --v2 2
agentfs revert /docs/readme.md --version 1
agentfs cat /docs/readme.md               # should show original
```

- ☐ Log shows version chain
- ☐ Diff shows changes
- ☐ Revert restores original

```bash
agentfs find "agent"
agentfs grep "Getting.*Started" /docs/
agentfs recent / --limit 5
```

- ☐ find/grep/recent return results

```bash
agentfs rm /docs/readme.md
agentfs daemon stop
agentfs daemon status    # should show "not running"
```

- ☐ Daemon stops cleanly

### 3. Multi-user RBAC (requires daemon)

```bash
agentfs daemon start

# Register admin
curl -s -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com"}'
# → save API_KEY_ADMIN and ORG_ID

# Register viewer
curl -s -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"viewer@test.com"}'
# → save API_KEY_VIEWER

# Invite viewer
curl -s -X POST "http://localhost:7433/orgs/$ORG_ID/members/invite" \
  -H "Authorization: Bearer $API_KEY_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"email":"viewer@test.com","role":"viewer"}'

# Viewer reads (should 200)
curl -s -X POST "http://localhost:7433/orgs/$ORG_ID/ops" \
  -H "Authorization: Bearer $API_KEY_VIEWER" \
  -H "Content-Type: application/json" \
  -d '{"op":"ls","path":"/"}'

# Viewer writes (should 403)
curl -s -X POST "http://localhost:7433/orgs/$ORG_ID/ops" \
  -H "Authorization: Bearer $API_KEY_VIEWER" \
  -H "Content-Type: application/json" \
  -d '{"op":"write","path":"/test.md","content":"hi"}'
```

- ☐ Viewer can list (200)
- ☐ Viewer blocked from write (403)
- ☐ Error has `required_role` and `your_role`
