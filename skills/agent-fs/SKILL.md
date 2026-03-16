---
name: agent-fs
description: >-
  Use when the user wants to store, retrieve, search, or manage files in agent-fs —
  an agent-first filesystem backed by S3. Triggers on: "save this to agent-fs",
  "find that file", "store this document", "search agent-fs", "list my files",
  "show version history", "revert file", "set up agent-fs", file persistence for
  agents, shared agent filesystem, or any mention of the agent-fs CLI. Also use
  when the user needs to manage drives, check recent activity, or use semantic
  search across stored files. If the user mentions agent-fs in any context, always
  consult this skill.
---

# agent-fs CLI

agent-fs is an agent-first filesystem backed by S3 with full versioning, full-text search (FTS5), and semantic search. It provides a CLI that outputs JSON, making it ideal for agent workflows. Files are organized in drives within orgs.

## Quick Start

```bash
# 1. Initialize (local MinIO — requires Docker)
agent-fs init --local -y

# 2. Optionally start the daemon (CLI auto-detects and works without it)
agent-fs daemon start

# 3. Start using it
echo "hello world" | agent-fs write docs/readme.txt -m "initial version"
agent-fs cat docs/readme.txt
```

For custom S3 (AWS, R2, etc.), run `agent-fs init` without `--local` and configure with `agent-fs config set s3.endpoint <url>`.

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
| `ls` | `agent-fs ls <path>` | List directory contents |
| `stat` | `agent-fs stat <path>` | Show file metadata (size, version, timestamps) |
| `rm` | `agent-fs rm <path>` | Delete a file |
| `mv` | `agent-fs mv <from> <to> [-m <msg>]` | Move or rename a file |
| `cp` | `agent-fs cp <from> <to>` | Copy a file |
| `head` | `agent-fs head <path> [-n <lines>]` | First N lines (default: 20) |
| `tail` | `agent-fs tail <path> [-n <lines>]` | Last N lines (default: 20) |
| `mkdir` | `agent-fs mkdir <path>` | Create a directory |

### Versioning

| Command | Usage | Description |
|---------|-------|-------------|
| `log` | `agent-fs log <path> [--limit <n>]` | Show version history |
| `diff` | `agent-fs diff <path> [--v1 <n>] [--v2 <n>]` | Diff between versions |
| `revert` | `agent-fs revert <path> --version <n>` | Revert to a previous version |

### Search & Discovery

| Command | Usage | Description |
|---------|-------|-------------|
| `recent` | `agent-fs recent [path] [--since <duration>] [--limit <n>]` | Recent activity (e.g., `--since 24h`) |
| `grep` | `agent-fs grep <pattern> <path>` | Regex search in file content |
| `find` | `agent-fs find <pattern> [--path <prefix>]` | Full-text search (FTS5) across all files |
| `search` | `agent-fs search <query> [--limit <n>]` | Semantic search using embeddings |
| `reindex` | `agent-fs reindex [--path <prefix>]` | Re-index files with failed/missing embeddings |

### Setup & Auth

| Command | Usage | Description |
|---------|-------|-------------|
| `init` | `agent-fs init [--local] [-y]` | Set up agent-fs (S3 + database + first user) |
| `auth register` | `agent-fs auth register <email>` | Register a new user |
| `auth whoami` | `agent-fs auth whoami` | Show current user info |

### Drive Management

| Command | Usage | Description |
|---------|-------|-------------|
| `drive list` | `agent-fs drive list` | List drives in current org |
| `drive create` | `agent-fs drive create <name>` | Create a new drive |
| `drive current` | `agent-fs drive current` | Show current drive context |
| `drive invite` | `agent-fs drive invite <email> --role <role>` | Invite user (viewer/editor/admin) |

### Daemon

| Command | Usage | Description |
|---------|-------|-------------|
| `daemon start` | `agent-fs daemon start` | Start the background daemon |
| `daemon stop` | `agent-fs daemon stop` | Stop the daemon |
| `daemon status` | `agent-fs daemon status` | Check if daemon is running |

### Config

| Command | Usage | Description |
|---------|-------|-------------|
| `config get` | `agent-fs config get <key>` | Get config value (dot notation: `s3.bucket`) |
| `config set` | `agent-fs config set <key> <value>` | Set config value |
| `config list` | `agent-fs config list` | Show all configuration |

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
agent-fs find "quarterly revenue"

# Semantic search (finds conceptually related content)
agent-fs search "financial performance metrics" --limit 5
```

**When to use which:**
- `grep` — you know the exact pattern and path (regex)
- `find` — keyword search across all files (fast, FTS5-based)
- `search` — conceptual/semantic search ("find things about X")

### Review and revert changes

```bash
# View version history
agent-fs log docs/spec.md --limit 10

# Compare two versions
agent-fs diff docs/spec.md --v1 2 --v2 5

# Revert to version 2
agent-fs revert docs/spec.md --version 2
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

### Check recent activity

```bash
# What changed in the last hour?
agent-fs recent --since 1h

# Recent changes under a specific path
agent-fs recent docs/ --since 24h --limit 20
```

## Detailed Command Reference

For full command syntax, all flags, and detailed examples with expected JSON output shapes, read `references/commands.md`.
