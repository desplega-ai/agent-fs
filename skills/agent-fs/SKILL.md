---
name: agent-fs
description: >-
  Use when the user wants to store, retrieve, search, or manage files in agent-fs —
  an agent-first filesystem backed by S3. Triggers on: "save this to agent-fs",
  "find that file", "store this document", "search agent-fs", "list my files",
  "show version history", "revert file", "set up agent-fs", "get a signed url",
  "share this file", "manage members", "invite user", "list members", "remove member",
  "update role", file persistence for agents, shared agent filesystem, or any
  mention of the agent-fs CLI. Also use when the user needs to manage drives,
  manage org/drive members, generate presigned URLs, check recent activity, or use
  semantic search across stored files. If the user mentions agent-fs in any context,
  always consult this skill.
---

# agent-fs CLI

agent-fs is an agent-first filesystem backed by S3 with full versioning, full-text search (FTS5), and semantic search. It provides a CLI that outputs JSON, making it ideal for agent workflows. Files are organized in drives within orgs.

## Quick Start

```bash
# 1. Set up (local MinIO — requires Docker)
agent-fs onboard -y

# 2. Optionally start the daemon (CLI auto-detects and works without it)
agent-fs daemon start

# 3. Start using it
echo "hello world" | agent-fs write docs/readme.txt -m "initial version"
agent-fs cat docs/readme.txt
```

For custom S3 (AWS, R2, etc.), use flags: `agent-fs onboard --s3-endpoint <url> --s3-bucket <name> --s3-access-key <key> --s3-secret-key <key>`.

## Essential Patterns

1. **All output is JSON** — always parse CLI output as JSON (except `daemon status` and `auth register` which print human-readable text).

2. **Auto-detection** — the CLI automatically detects whether the daemon is running. If it is, commands go via HTTP; otherwise, they use embedded mode directly. No user action needed.

3. **Stdin piping for content** — `write` and `append` accept content via stdin or `--content`:
   ```bash
   # Preferred for multi-line content
   echo "content here" | agent-fs write path/to/file.txt

   # Inline for short content
   agent-fs write path/to/file.txt --content "short text"
   ```

4. **Paths** — forward-slash separated, no leading slash required. Example: `docs/notes/meeting.md`

5. **Version messages** — optional but recommended for auditability:
   ```bash
   agent-fs write docs/spec.md --content "..." -m "added API section"
   ```

6. **Optimistic concurrency** — use `--expected-version` on `write` to prevent conflicts:
   ```bash
   agent-fs write config.json --content '{}' --expected-version 3
   # Fails if file is not at version 3
   ```

## Command Quick Reference

### File Operations

| Command | Usage | Description |
|---------|-------|-------------|
| `write` | `agent-fs write <path> [--content <text>] [-m <msg>] [--expected-version <n>]` | Write content (stdin or --content) |
| `cat` | `agent-fs cat <path> [--offset <n>] [--limit <n>]` | Read file content |
| `edit` | `agent-fs edit <path> --old <text> --new <text> [-m <msg>]` | Find-and-replace in file |
| `append` | `agent-fs append <path> [--content <text>] [-m <msg>]` | Append to file (stdin or --content) |
| `tail` | `agent-fs tail <path> [--lines <n>]` | Last N lines (default: 20) |
| `ls` | `agent-fs ls [path]` | List directory contents (defaults to /) |
| `stat` | `agent-fs stat <path>` | Show file metadata (size, version, timestamps) |
| `tree` | `agent-fs tree [path] [--depth <n>]` | Recursive directory listing |
| `glob` | `agent-fs glob <pattern> [path]` | Find files by pattern (`*.md`, `**/*.md`) |
| `rm` | `agent-fs rm <path>` | Delete a file |
| `mv` | `agent-fs mv <from> <to> [-m <msg>]` | Move or rename a file |
| `cp` | `agent-fs cp <from> <to>` | Copy a file |
| `signed-url` | `agent-fs signed-url <path> [--expires-in <seconds>]` | Generate a presigned URL for direct download (default: 24h, max: 7 days) |

### Versioning

| Command | Usage | Description |
|---------|-------|-------------|
| `log` | `agent-fs log <path> [--limit <n>]` | Show version history |
| `diff` | `agent-fs diff <path> --v1 <n> --v2 <n>` | Diff between versions |
| `revert` | `agent-fs revert <path> --version <n>` | Revert to a previous version |

### Search & Discovery

| Command | Usage | Description |
|---------|-------|-------------|
| `grep` | `agent-fs grep <pattern> <path>` | Regex search in file content |
| `fts` | `agent-fs fts <pattern> [path]` | Full-text search (FTS5) across all files |
| `search` | `agent-fs search <query> [--limit <n>]` | Semantic search using embeddings |
| `recent` | `agent-fs recent [path] [--since <duration>] [--limit <n>]` | Recent activity (e.g., `--since 24h`) |
| `reindex` | `agent-fs reindex [path]` | Re-index files with failed/missing embeddings |

**When to use which:**
- `grep` — you know the exact pattern and path (regex)
- `fts` — keyword search across all files (fast, FTS5-based)
- `search` — conceptual/semantic search ("find things about X")

### Comments

| Command | Usage | Description |
|---------|-------|-------------|
| `comment add` | `agent-fs comment add <path> --body <text> [--line-start <n>] [--line-end <n>]` | Add a comment to a file |
| `comment reply` | `agent-fs comment reply <comment-id> --body <text>` | Reply to a comment |
| `comment list` | `agent-fs comment list [path]` | List comments (with inline replies) |
| `comment get` | `agent-fs comment get <id>` | Get a comment with its replies |
| `comment update` | `agent-fs comment update <id> --body <text>` | Update a comment (author only) |
| `comment delete` | `agent-fs comment delete <id>` | Soft-delete a comment (author only) |
| `comment resolve` | `agent-fs comment resolve <id>` | Resolve a comment |

### Setup & Auth

| Command | Usage | Description |
|---------|-------|-------------|
| `onboard` | `agent-fs onboard [--local] [-y] [--embeddings <provider>]` | Set up agent-fs (S3 + database + user) |
| `init` | `agent-fs init [--local] [-y]` | Alias for `onboard` |
| `auth register` | `agent-fs auth register <email>` | Register a new user |
| `auth whoami` | `agent-fs auth whoami` | Show current user info |

### Member Management

| Command | Usage | Description |
|---------|-------|-------------|
| `member list` | `agent-fs member list` | List org members (use `--drive <id>` for drive members) |
| `member invite` | `agent-fs member invite <email> --role <role>` | Invite user to org (viewer/editor/admin) |
| `member update-role` | `agent-fs member update-role <email> --role <role>` | Update org role (use `--drive <id>` for drive role) |
| `member remove` | `agent-fs member remove <email>` | Remove from org (use `--drive <id>` for drive only) |

The `--drive` flag is a global option — place it before the subcommand: `agent-fs --drive <id> member list`.

### Drive Management

| Command | Usage | Description |
|---------|-------|-------------|
| `drive list` | `agent-fs drive list` | List drives in current org |
| `drive create` | `agent-fs drive create <name>` | Create a new drive |
| `drive current` | `agent-fs drive current` | Show current drive context |
| `drive invite` | `agent-fs drive invite <email> --role <role>` | Invite user (viewer/editor/admin) |

### Config & Daemon

| Command | Usage | Description |
|---------|-------|-------------|
| `config get` | `agent-fs config get <key>` | Get config value (dot notation: `s3.bucket`) |
| `config set` | `agent-fs config set <key> <value>` | Set config value |
| `config list` | `agent-fs config list` | Show all configuration |
| `config validate` | `agent-fs config validate` | Check S3, database, auth, embeddings health |
| `daemon start` | `agent-fs daemon start` | Start the background daemon |
| `daemon stop` | `agent-fs daemon stop` | Stop the daemon |
| `daemon status` | `agent-fs daemon status` | Check if daemon is running |

## Common Workflows

### Store and retrieve a document

```bash
# Write a document (multi-line via stdin)
cat <<'EOF' | agent-fs write reports/q1-summary.md -m "Q1 summary draft"
# Q1 Summary
Revenue grew 15% quarter over quarter.
EOF

# Read it back
agent-fs cat reports/q1-summary.md

# Check metadata
agent-fs stat reports/q1-summary.md
```

### Search across files

```bash
# Regex search within a specific path
agent-fs grep "revenue|growth" reports/

# Full-text search across all files (FTS5 — fast keyword matching)
agent-fs fts "quarterly revenue"

# Semantic search (finds conceptually related content)
agent-fs search "financial performance metrics" --limit 5
```

### Review and revert changes

```bash
# View version history
agent-fs log docs/spec.md --limit 10

# Compare two versions
agent-fs diff docs/spec.md --v1 2 --v2 5

# Revert to version 2
agent-fs revert docs/spec.md --version 2
```

### Comments and collaboration

```bash
# Add a comment to a file
agent-fs comment add docs/spec.md --body "Needs more detail on auth"

# Reply to a comment
agent-fs comment reply <comment-id> --body "Added in v3"

# List comments
agent-fs comment list docs/spec.md

# Resolve a comment
agent-fs comment resolve <comment-id>
```

### Set up a new drive and invite users

```bash
# Create a shared drive
agent-fs drive create "team-docs"

# Invite a teammate
agent-fs drive invite alice@company.com --role editor

# Check current drive context
agent-fs drive current
```

### Manage members

```bash
# List org members
agent-fs member list

# List drive members
agent-fs --drive <driveId> member list

# Invite a user
agent-fs member invite alice@company.com --role editor

# Change role
agent-fs member update-role alice@company.com --role admin

# Remove from org (cascades to all drives)
agent-fs member remove alice@company.com

# Remove from a specific drive only (keeps org membership)
agent-fs --drive <driveId> member remove alice@company.com
```

### Check recent activity

```bash
# What changed in the last hour?
agent-fs recent --since 1h

# Recent changes under a specific path
agent-fs recent docs/ --since 24h --limit 20
```

### Generate a shareable download link

```bash
# Default expiry (24 hours)
agent-fs signed-url docs/report.pdf

# Custom expiry (1 hour)
agent-fs signed-url docs/report.pdf --expires-in 3600

# JSON output (useful for agents)
agent-fs signed-url docs/report.pdf --json
# → { "url": "https://...", "path": "/docs/report.pdf", "expiresIn": 86400, "expiresAt": "2026-03-20T..." }
```

The presigned URL requires no authentication — anyone with the link can download the file until it expires. Signed URLs serve the correct `Content-Type` header based on file extension (e.g., `application/pdf` for `.pdf`, `image/png` for `.png`), so browsers render them natively.

**MIME types on upload:** `write`, `edit`, `append`, and `revert` automatically detect and set the correct `Content-Type` on S3 objects based on file extension. The content type is also stored in the database and visible in `stat` output via the `contentType` field.

### App URL in responses

When `AGENT_FS_APP_URL` is set (e.g., `https://live.agent-fs.dev`), file-related ops automatically include an `appUrl` field pointing to the file in the live web app:

```bash
AGENT_FS_APP_URL=https://live.agent-fs.dev agent-fs stat docs/report.pdf --json
# → { ..., "appUrl": "https://live.agent-fs.dev/file/~/org-id/drive-id/docs/report.pdf" }
```

This applies to any op that returns a `path` or `to` field (write, stat, edit, append, rm, cp, mv, signed-url, etc.).

### Validate your setup

```bash
agent-fs config validate
```
