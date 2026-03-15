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

## 1. Infrastructure (✅ all automated)

- ✅ `bun install` — clean (262 packages)
- ✅ `bun run typecheck` — passes (tsc --build, TS 5.9.3)
- ✅ `bun run test` — 82/82 pass (0 fail without MinIO: 55 skip)
- ✅ `drizzle-kit generate` — 8 tables detected
- ✅ `migrate.ts` creates `config.json` + `agentfs.db`
- ✅ sqlite3 shows all 10 tables (8 regular + 2 virtual)
- ✅ WAL mode + foreign keys enabled

## 2. S3 Integration (✅ all automated against MinIO)

- ✅ putObject + getObject roundtrip
- ✅ copyObject, deleteObject, headObject, listObjects
- ✅ Versioning enable + listObjectVersions

## 3. File Operations (✅ all automated against MinIO)

- ✅ write + cat roundtrip
- ✅ cat with offset/limit + truncation
- ✅ edit exact match + version creation + diffSummary
- ✅ edit conflict (not found / multiple matches)
- ✅ append
- ✅ head / tail
- ✅ ls (files + directories)
- ✅ stat metadata
- ✅ rm soft-delete
- ✅ mv (copy + delete + version)
- ✅ cp
- ✅ mkdir
- ✅ log version history ordering
- ✅ diff between versions (S3 content fetch + jsdiff)
- ✅ revert restores old content as new version
- ✅ recent activity feed

## 4. Search (✅ automated for FTS5; ✅ manual for embeddings)

- ✅ FTS5 find keyword search
- ✅ FTS5 find with path filter
- ✅ grep regex with line numbers
- ✅ Write auto-indexes for FTS5
- ✅ rm removes from FTS5 index
- ✅ OpenAI embeddings: 768-dim vectors, semantic search ranks correctly
- ✅ Local embeddings (nomic-embed-text-v1.5): auto-download, 768-dim, semantic search ranks correctly

## 5. Identity & RBAC (✅ all automated)

- ✅ createUser + personal org + default drive auto-creation
- ✅ API key generation (af_ prefix, SHA-256 hash stored)
- ✅ getUserByApiKey / getUserByEmail
- ✅ Org invitation flow
- ✅ Admin can do anything, viewer can read, viewer blocked from write
- ✅ Permission error includes required_role + your_role
- ✅ Role upgrade allows previously blocked ops
- ✅ Drive context resolution (default / explicit org / explicit drive)

## 6. REST API (✅ all automated via Hono test client)

- ✅ GET /health → 200
- ✅ POST /auth/register → API key + userId + orgId
- ✅ GET /auth/me → user info
- ✅ Unauthenticated → 401
- ✅ Invalid API key → 401
- ✅ write + cat roundtrip via POST /orgs/:orgId/ops
- ✅ Missing op → 400
- ✅ GET /orgs, GET /orgs/:id, GET /orgs/:id/drives

## 7. MCP (✅ registration automated)

- ✅ All 18 ops registered as MCP tools
- ✅ Op definitions have valid Zod schemas

---

## 8. Tests for Taras — CLI E2E Flow

```bash
# Make sure MinIO is running
docker start agentfs-minio
```

### 8.1 Daemon lifecycle

- ☐ `agentfs daemon start` — starts daemon, shows PID
- ☐ `agentfs daemon status` — shows "running"
- ☐ `ls ~/.agentfs/agentfs.pid` — PID file exists
- ☐ `cat ~/.agentfs/agentfs.log` — shows startup log

### 8.2 Registration & auth

- ☐ `agentfs auth register you@example.com` — returns API key, saves to config
- ☐ `agentfs auth whoami` — shows user info
- ☐ `agentfs config get auth.apiKey` — shows the saved key

### 8.3 File operations via CLI

```bash
# Write
agentfs write /docs/readme.md --content "# My Project\n\nThis is agent-fs."

# Read
agentfs cat /docs/readme.md

# Edit
agentfs edit /docs/readme.md --old "My Project" --new "Agent FS" -m "Renamed project"

# List
agentfs ls /docs/

# Metadata
agentfs stat /docs/readme.md

# Head/tail
agentfs head /docs/readme.md -n 2

# Append
agentfs append /docs/readme.md --content "\n## Getting Started\n\nRun agentfs daemon start."

# Copy & move
agentfs cp /docs/readme.md /backup/readme.md
agentfs mv /backup/readme.md /archive/readme.md

# Directory
agentfs mkdir /reports/
```

- ☐ All commands above return valid JSON output
- ☐ `agentfs cat /docs/readme.md` shows edited + appended content

### 8.4 Versioning via CLI

```bash
agentfs log /docs/readme.md               # should show 3+ versions
agentfs diff /docs/readme.md --v1 1 --v2 2  # should show edit diff
agentfs revert /docs/readme.md --version 1   # revert to original
agentfs cat /docs/readme.md                  # should show original content
```

- ☐ Log shows version chain (write → edit → append → revert)
- ☐ Diff shows old/new changes
- ☐ Revert restores original content

### 8.5 Search via CLI

```bash
agentfs find "agent"                         # FTS5 keyword search
agentfs grep "Getting.*Started" /docs/       # regex search
agentfs search "project documentation"       # semantic (needs embeddings configured)
```

- ☐ find returns matches
- ☐ grep returns line-level matches
- ☐ search returns semantically relevant results (if embedding provider configured)

### 8.6 Activity feed

```bash
agentfs recent / --limit 5
```

- ☐ Shows recent operations across all files

### 8.7 Cleanup

```bash
agentfs rm /docs/readme.md
agentfs daemon stop
agentfs daemon status   # should show "not running"
```

- ☐ rm confirms deletion
- ☐ daemon stops cleanly

---

## 9. Tests for Taras — MCP Integration

`.mcp.json` is already configured in the project root:
```json
{
  "mcpServers": {
    "agentfs": {
      "command": "bun",
      "args": ["run", "./packages/mcp/src/index.ts", "--embedded"],
      "env": {}
    }
  }
}
```

### In a new Claude Code session in this project:

- ☐ agentfs MCP tools appear in tool list
- ☐ Use `write` tool to create a file
- ☐ Use `cat` tool to read it back
- ☐ Use `ls` tool to list directory
- ☐ Use `edit` tool to modify content
- ☐ Use `log` tool to see version history
- ☐ stderr shows `[agent-fs] Running in embedded mode`

---

## 10. Tests for Taras — Multi-user RBAC

```bash
# Start daemon
agentfs daemon start

# Register two users (in separate terminals or save keys)
curl -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com"}'
# Save API_KEY_ADMIN and ORG_ID

curl -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"viewer@test.com"}'
# Save API_KEY_VIEWER

# Invite viewer to admin's org
curl -X POST http://localhost:7433/orgs/$ORG_ID/members/invite \
  -H "Authorization: Bearer $API_KEY_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"email":"viewer@test.com","role":"viewer"}'

# Viewer can read
curl -X POST http://localhost:7433/orgs/$ORG_ID/ops \
  -H "Authorization: Bearer $API_KEY_VIEWER" \
  -H "Content-Type: application/json" \
  -d '{"op":"ls","path":"/"}'
# Should succeed

# Viewer cannot write
curl -X POST http://localhost:7433/orgs/$ORG_ID/ops \
  -H "Authorization: Bearer $API_KEY_VIEWER" \
  -H "Content-Type: application/json" \
  -d '{"op":"write","path":"/test.md","content":"hi"}'
# Should return 403 with required_role and your_role
```

- ☐ Viewer can list files (200)
- ☐ Viewer blocked from writing (403 with actionable error)
- ☐ Error response includes `required_role: "editor"` and `your_role: "viewer"`
