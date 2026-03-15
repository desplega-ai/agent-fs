---
name: agentfs
description: >-
  Use when the user wants to store, retrieve, search, or manage files in agentfs —
  an agent-first filesystem backed by S3. Triggers on: "save this to agentfs",
  "find that file", "store this document", "search agentfs", "list my files",
  "show version history", "revert file", "set up agentfs", file persistence for
  agents, shared agent filesystem, or any mention of the agentfs CLI. Also use
  when the user needs to manage drives, check recent activity, or use semantic
  search across stored files. If the user mentions agentfs in any context, always
  consult this skill.
---

# agentfs CLI

agentfs is an agent-first filesystem backed by S3 with full versioning, full-text search (FTS5), and semantic search. It provides a CLI that outputs JSON, making it ideal for agent workflows. Files are organized in drives within orgs.

## Quick Start

```bash
# 1. Initialize (local MinIO — requires Docker)
agentfs init --local -y

# 2. Optionally start the daemon (CLI auto-detects and works without it)
agentfs daemon start

# 3. Start using it
echo "hello world" | agentfs write docs/readme.txt -m "initial version"
agentfs cat docs/readme.txt
```

For custom S3 (AWS, R2, etc.), run `agentfs init` without `--local` and configure with `agentfs config set s3.endpoint <url>`.

## Essential Patterns

1. **All output is JSON** — always parse CLI output as JSON (except `daemon status` and `auth register` which print human-readable text).

2. **Auto-detection** — the CLI automatically detects whether the daemon is running. If it is, commands go via HTTP; otherwise, they use embedded mode directly. No user action needed.

3. **Stdin piping for content** — `write` and `append` accept content via stdin or `--content`:
   ```bash
   # Preferred for multi-line content
   echo "content here" | agentfs write path/to/file.txt

   # Inline for short content
   agentfs write path/to/file.txt --content "short text"
   ```

4. **Paths** — forward-slash separated, no leading slash required. Example: `docs/notes/meeting.md`

5. **Version messages** — optional but recommended for auditability:
   ```bash
   agentfs write docs/spec.md --content "..." -m "added API section"
   ```

6. **Optimistic concurrency** — use `--expected-version` on `write` to prevent conflicts:
   ```bash
   agentfs write config.json --content '{}' --expected-version 3
   # Fails if file is not at version 3
   ```

## Command Quick Reference

### File Operations

| Command | Usage | Description |
|---------|-------|-------------|
| `write` | `agentfs write <path> [--content <text>] [-m <msg>] [--expected-version <n>]` | Write content (stdin or --content) |
| `cat` | `agentfs cat <path> [--offset <n>] [--limit <n>]` | Read file content |
| `edit` | `agentfs edit <path> --old <text> --new <text> [-m <msg>]` | Find-and-replace in file |
| `append` | `agentfs append <path> [--content <text>] [-m <msg>]` | Append to file (stdin or --content) |
| `ls` | `agentfs ls <path>` | List directory contents |
| `stat` | `agentfs stat <path>` | Show file metadata (size, version, timestamps) |
| `rm` | `agentfs rm <path>` | Delete a file |
| `mv` | `agentfs mv <from> <to> [-m <msg>]` | Move or rename a file |
| `cp` | `agentfs cp <from> <to>` | Copy a file |
| `head` | `agentfs head <path> [-n <lines>]` | First N lines (default: 20) |
| `tail` | `agentfs tail <path> [-n <lines>]` | Last N lines (default: 20) |
| `mkdir` | `agentfs mkdir <path>` | Create a directory |

### Versioning

| Command | Usage | Description |
|---------|-------|-------------|
| `log` | `agentfs log <path> [--limit <n>]` | Show version history |
| `diff` | `agentfs diff <path> [--v1 <n>] [--v2 <n>]` | Diff between versions |
| `revert` | `agentfs revert <path> --version <n>` | Revert to a previous version |

### Search & Discovery

| Command | Usage | Description |
|---------|-------|-------------|
| `recent` | `agentfs recent [path] [--since <duration>] [--limit <n>]` | Recent activity (e.g., `--since 24h`) |
| `grep` | `agentfs grep <pattern> <path>` | Regex search in file content |
| `find` | `agentfs find <pattern> [--path <prefix>]` | Full-text search (FTS5) across all files |
| `search` | `agentfs search <query> [--limit <n>]` | Semantic search using embeddings |
| `reindex` | `agentfs reindex [--path <prefix>]` | Re-index files with failed/missing embeddings |

### Setup & Auth

| Command | Usage | Description |
|---------|-------|-------------|
| `init` | `agentfs init [--local] [-y]` | Set up agentfs (S3 + database + first user) |
| `auth register` | `agentfs auth register <email>` | Register a new user |
| `auth whoami` | `agentfs auth whoami` | Show current user info |

### Drive Management

| Command | Usage | Description |
|---------|-------|-------------|
| `drive list` | `agentfs drive list` | List drives in current org |
| `drive create` | `agentfs drive create <name>` | Create a new drive |
| `drive current` | `agentfs drive current` | Show current drive context |
| `drive invite` | `agentfs drive invite <email> --role <role>` | Invite user (viewer/editor/admin) |

### Daemon

| Command | Usage | Description |
|---------|-------|-------------|
| `daemon start` | `agentfs daemon start` | Start the background daemon |
| `daemon stop` | `agentfs daemon stop` | Stop the daemon |
| `daemon status` | `agentfs daemon status` | Check if daemon is running |

### Config

| Command | Usage | Description |
|---------|-------|-------------|
| `config get` | `agentfs config get <key>` | Get config value (dot notation: `s3.bucket`) |
| `config set` | `agentfs config set <key> <value>` | Set config value |
| `config list` | `agentfs config list` | Show all configuration |

## Common Workflows

### Store and retrieve a document

```bash
# Write a document (multi-line via stdin)
cat <<'EOF' | agentfs write reports/q1-summary.md -m "Q1 summary draft"
# Q1 Summary
Revenue grew 15% quarter over quarter.
EOF

# Read it back
agentfs cat reports/q1-summary.md

# Check metadata
agentfs stat reports/q1-summary.md
```

### Search across files

```bash
# Regex search within a specific path
agentfs grep "revenue|growth" reports/

# Full-text search across all files (FTS5 — fast keyword matching)
agentfs find "quarterly revenue"

# Semantic search (finds conceptually related content)
agentfs search "financial performance metrics" --limit 5
```

**When to use which:**
- `grep` — you know the exact pattern and path (regex)
- `find` — keyword search across all files (fast, FTS5-based)
- `search` — conceptual/semantic search ("find things about X")

### Review and revert changes

```bash
# View version history
agentfs log docs/spec.md --limit 10

# Compare two versions
agentfs diff docs/spec.md --v1 2 --v2 5

# Revert to version 2
agentfs revert docs/spec.md --version 2
```

### Set up a new drive and invite users

```bash
# Create a shared drive
agentfs drive create "team-docs"

# Invite a teammate
agentfs drive invite alice@company.com --role editor

# Check current drive context
agentfs drive current
```

### Check recent activity

```bash
# What changed in the last hour?
agentfs recent --since 1h

# Recent changes under a specific path
agentfs recent docs/ --since 24h --limit 20
```

## Detailed Command Reference

For full command syntax, all flags, and detailed examples with expected JSON output shapes, read `references/commands.md`.
