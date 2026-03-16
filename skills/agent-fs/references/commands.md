# agent-fs Command Reference

Complete reference for every agent-fs CLI command with syntax, flags, and expected output.

---

## File Operations

### write

Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates a new version.

```
agent-fs write <path> [--content <text>] [-m, --message <msg>] [--expected-version <n>]
```

**Arguments:**
- `<path>` (required) — file path (e.g., `docs/readme.md`)

**Options:**
- `--content <text>` — file content. If omitted, reads from stdin.
- `-m, --message <msg>` — version message for auditability
- `--expected-version <n>` — optimistic concurrency: fails if file is not at this version

**Examples:**
```bash
# Write via stdin (preferred for multi-line)
echo "Hello world" | agent-fs write hello.txt -m "initial"

# Write via --content flag
agent-fs write config.json --content '{"key": "value"}' -m "add config"

# Optimistic concurrency — only succeed if file is at version 3
agent-fs write config.json --content '{"updated": true}' --expected-version 3
```

**Output:**
```json
{
  "path": "hello.txt",
  "version": 1,
  "size": 12,
  "sha256": "a1b2c3..."
}
```

---

### cat

Read file content.

```
agent-fs cat <path> [--offset <n>] [--limit <n>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `--offset <n>` — start reading from this line number
- `--limit <n>` — maximum number of lines to return

**Examples:**
```bash
# Read entire file
agent-fs cat docs/readme.md

# Read lines 10-30
agent-fs cat docs/readme.md --offset 10 --limit 20
```

**Output:**
```json
{
  "path": "docs/readme.md",
  "content": "file content here...",
  "version": 3
}
```

---

### edit

Find-and-replace text within a file. Creates a new version.

```
agent-fs edit <path> --old <string> --new <string> [-m, --message <msg>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `--old <string>` (required) — text to find
- `--new <string>` (required) — replacement text
- `-m, --message <msg>` — version message

**Examples:**
```bash
agent-fs edit docs/spec.md --old "draft" --new "final" -m "finalize spec"
```

---

### append

Append content to the end of an existing file. Creates a new version.

```
agent-fs append <path> [--content <text>] [-m, --message <msg>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `--content <text>` — content to append. If omitted, reads from stdin.
- `-m, --message <msg>` — version message

**Examples:**
```bash
# Append via stdin
echo "\n## New Section" | agent-fs append docs/readme.md -m "add section"

# Append via flag
agent-fs append log.txt --content "entry: task completed" -m "log update"
```

---

### ls

List files and directories at a path.

```
agent-fs ls <path>
```

**Arguments:**
- `<path>` (required) — directory path

**Examples:**
```bash
agent-fs ls docs/
agent-fs ls /
```

**Output:**
```json
{
  "path": "docs/",
  "entries": [
    { "name": "readme.md", "type": "file", "size": 1234 },
    { "name": "specs/", "type": "directory" }
  ]
}
```

---

### stat

Show file metadata including size, version, and timestamps.

```
agent-fs stat <path>
```

**Arguments:**
- `<path>` (required) — file path

**Examples:**
```bash
agent-fs stat docs/readme.md
```

**Output:**
```json
{
  "path": "docs/readme.md",
  "size": 1234,
  "version": 3,
  "sha256": "abc123...",
  "createdAt": "2025-01-15T10:00:00Z",
  "updatedAt": "2025-01-16T14:30:00Z"
}
```

---

### rm

Delete a file.

```
agent-fs rm <path>
```

**Arguments:**
- `<path>` (required) — file path

**Examples:**
```bash
agent-fs rm temp/scratch.txt
```

---

### mv

Move or rename a file. Creates a new version.

```
agent-fs mv <from> <to> [-m, --message <msg>]
```

**Arguments:**
- `<from>` (required) — source path
- `<to>` (required) — destination path

**Options:**
- `-m, --message <msg>` — version message

**Examples:**
```bash
agent-fs mv drafts/doc.md final/doc.md -m "promote to final"
```

---

### cp

Copy a file.

```
agent-fs cp <from> <to>
```

**Arguments:**
- `<from>` (required) — source path
- `<to>` (required) — destination path

**Examples:**
```bash
agent-fs cp templates/report.md reports/q1.md
```

---

### head

Show the first N lines of a file.

```
agent-fs head <path> [-n, --lines <n>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `-n, --lines <n>` — number of lines to show (default: 20)

**Examples:**
```bash
agent-fs head logs/app.log -n 50
```

---

### tail

Show the last N lines of a file.

```
agent-fs tail <path> [-n, --lines <n>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `-n, --lines <n>` — number of lines to show (default: 20)

**Examples:**
```bash
agent-fs tail logs/app.log -n 100
```

---

### mkdir

Create a directory.

```
agent-fs mkdir <path>
```

**Arguments:**
- `<path>` (required) — directory path

**Examples:**
```bash
agent-fs mkdir projects/new-app/src
```

---

## Versioning

### log

Show version history for a file.

```
agent-fs log <path> [--limit <n>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `--limit <n>` — maximum number of entries to return

**Examples:**
```bash
agent-fs log docs/spec.md
agent-fs log docs/spec.md --limit 5
```

**Output:**
```json
{
  "path": "docs/spec.md",
  "versions": [
    { "version": 3, "message": "add API section", "size": 2048, "createdAt": "2025-01-16T14:30:00Z" },
    { "version": 2, "message": "fix typos", "size": 1800, "createdAt": "2025-01-15T12:00:00Z" },
    { "version": 1, "message": "initial draft", "size": 1200, "createdAt": "2025-01-14T09:00:00Z" }
  ]
}
```

---

### diff

Show the difference between two versions of a file.

```
agent-fs diff <path> [--v1 <n>] [--v2 <n>]
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `--v1 <n>` — first version number
- `--v2 <n>` — second version number

**Examples:**
```bash
# Compare version 1 and version 3
agent-fs diff docs/spec.md --v1 1 --v2 3
```

---

### revert

Revert a file to a previous version. Creates a new version with the old content.

```
agent-fs revert <path> --version <n>
```

**Arguments:**
- `<path>` (required) — file path

**Options:**
- `--version <n>` (required) — version number to revert to

**Examples:**
```bash
agent-fs revert docs/spec.md --version 2
```

---

## Search & Discovery

### recent

Show recently modified files.

```
agent-fs recent [path] [--since <duration>] [--limit <n>]
```

**Arguments:**
- `[path]` (optional) — filter by path prefix

**Options:**
- `--since <duration>` — time filter (e.g., `1h`, `24h`, `7d`)
- `--limit <n>` — maximum entries to return

**Examples:**
```bash
# All recent activity
agent-fs recent --since 1h

# Recent changes under docs/
agent-fs recent docs/ --since 24h --limit 20
```

---

### grep

Search file content using a regex pattern within a specific path.

```
agent-fs grep <pattern> <path>
```

**Arguments:**
- `<pattern>` (required) — regex pattern
- `<path>` (required) — path to search within

**Examples:**
```bash
agent-fs grep "TODO|FIXME" src/
agent-fs grep "function.*export" lib/utils.ts
```

---

### find

Full-text search (FTS5) across all indexed files. Fast keyword matching.

```
agent-fs find <pattern> [--path <prefix>]
```

**Arguments:**
- `<pattern>` (required) — search query (FTS5 syntax)

**Options:**
- `--path <prefix>` — restrict search to a path prefix

**Examples:**
```bash
# Search everywhere
agent-fs find "quarterly revenue"

# Search only in reports/
agent-fs find "revenue growth" --path reports/
```

---

### search

Semantic search using vector embeddings. Finds conceptually related content even if exact keywords don't match.

```
agent-fs search <query> [--limit <n>]
```

**Arguments:**
- `<query>` (required) — natural language search query

**Options:**
- `--limit <n>` — maximum results to return

**Examples:**
```bash
agent-fs search "financial performance metrics" --limit 10
agent-fs search "how to deploy the application"
```

---

### reindex

Re-index files that have failed or missing embeddings. Useful after bulk writes or if semantic search returns incomplete results.

```
agent-fs reindex [--path <prefix>]
```

**Options:**
- `--path <prefix>` — only re-index files under this prefix

**Examples:**
```bash
# Re-index everything
agent-fs reindex

# Re-index only docs/
agent-fs reindex --path docs/
```

---

## Setup & Auth

### init

Set up agent-fs: configures S3 storage, initializes the database, and registers the first user.

```
agent-fs init [--local] [-y, --yes]
```

**Options:**
- `--local` — use a local MinIO Docker container for S3 (requires Docker)
- `-y, --yes` — accept all defaults without prompts (implies `--local`)

**Examples:**
```bash
# Quick local setup (Docker required)
agent-fs init --local -y

# Custom S3 setup (interactive)
agent-fs init
```

---

### auth register

Register a new user and save the API key to local config.

```
agent-fs auth register <email>
```

**Arguments:**
- `<email>` (required) — email address

**Examples:**
```bash
agent-fs auth register alice@company.com
```

**Output:** (human-readable text)
```
Registered successfully!
API Key: agentfs_abc123...
User ID: usr_xyz...
Org ID: org_def...

API key saved to config.
```

---

### auth whoami

Show the currently authenticated user.

```
agent-fs auth whoami
```

**Output:**
```json
{
  "id": "usr_xyz...",
  "email": "alice@company.com",
  "orgs": [{ "id": "org_def...", "name": "default" }]
}
```

---

## Drive Management

### drive list

List all drives in the current org.

```
agent-fs drive list
```

**Output:**
```json
{
  "drives": [
    { "id": "drv_abc...", "name": "default", "isDefault": true },
    { "id": "drv_def...", "name": "team-docs", "isDefault": false }
  ]
}
```

---

### drive create

Create a new drive in the current org.

```
agent-fs drive create <name>
```

**Arguments:**
- `<name>` (required) — drive name

**Examples:**
```bash
agent-fs drive create "project-alpha"
```

---

### drive current

Show the current drive context (org and active drive).

```
agent-fs drive current
```

**Output:**
```json
{
  "orgId": "org_abc...",
  "drive": { "id": "drv_abc...", "name": "default", "isDefault": true }
}
```

---

### drive invite

Invite a user to the current org with a specific role.

```
agent-fs drive invite <email> --role <role>
```

**Arguments:**
- `<email>` (required) — email address to invite

**Options:**
- `--role <role>` (required) — one of: `viewer`, `editor`, `admin`

**Examples:**
```bash
agent-fs drive invite bob@company.com --role editor
agent-fs drive invite admin@company.com --role admin
```

---

## Daemon

### daemon start

Start the agent-fs background daemon. The daemon serves HTTP requests for file operations. Optional — CLI works without it via embedded mode.

```
agent-fs daemon start
```

---

### daemon stop

Stop the running daemon.

```
agent-fs daemon stop
```

---

### daemon status

Check whether the daemon is running.

```
agent-fs daemon status
```

**Output:** (human-readable text)
```
Daemon running (PID: 12345)
```
or
```
Daemon is not running
```

---

## Config

Configuration is stored in `~/.agent-fs/config.json`. Keys use dot notation.

### config get

Get a configuration value.

```
agent-fs config get <key>
```

**Arguments:**
- `<key>` (required) — dot-notation key (e.g., `s3.bucket`, `auth.apiKey`)

**Examples:**
```bash
agent-fs config get s3.bucket
agent-fs config get s3
```

---

### config set

Set a configuration value.

```
agent-fs config set <key> <value>
```

**Arguments:**
- `<key>` (required) — dot-notation key
- `<value>` (required) — value (auto-parsed as JSON for objects/numbers/booleans)

**Examples:**
```bash
agent-fs config set s3.endpoint "https://s3.us-east-1.amazonaws.com"
agent-fs config set s3.bucket "my-agentfs-bucket"
```

---

### config list

Show all configuration values.

```
agent-fs config list
```

**Output:**
```json
{
  "s3": {
    "provider": "minio",
    "endpoint": "http://localhost:9000",
    "bucket": "agentfs",
    "region": "us-east-1",
    "accessKeyId": "minioadmin",
    "secretAccessKey": "minioadmin"
  },
  "auth": {
    "apiKey": "agentfs_abc123..."
  }
}
```
