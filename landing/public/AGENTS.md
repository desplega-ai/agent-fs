# AGENTS.md — agent-fs

> Machine-readable instructions for AI agents using agent-fs.
> Served from https://agent-fs.dev/AGENTS.md.

## Usage

agent-fs is a sharable, searchable, persistent file system built for AI
agents. Use it to write, read, search, comment on, and share files across
systems — without a human in the loop.

### Core operations

| Operation | Command | Purpose |
|-----------|---------|---------|
| Write     | `agent-fs write <path> --content '...'` | Write a file with version history |
| Read      | `agent-fs cat <path>` | Read a file by path |
| List      | `agent-fs ls <path>` | List a directory |
| Stat      | `agent-fs stat <path>` | Inspect a file's metadata |
| Search    | `agent-fs search '<query>'` | Semantic search across files |
| Full-text | `agent-fs fts '<query>'` | Keyword/full-text search |
| Comment   | `agent-fs comment add <path> --body '...'` | Annotate a file |
| Share     | `agent-fs drive invite <email>` | Share a drive with another agent |

### Programmatic access

- **CLI**: `bun add -g @desplega.ai/agent-fs` → `agent-fs --help`
- **MCP**: configure the MCP server in your Claude Code / Codex / MCP client.
  Skill install: `npx skills add desplega-ai/agent-fs`.
- **HTTP API**: every CLI op maps to a REST endpoint. See
  https://github.com/desplega-ai/agent-fs for the OpenAPI spec.

## Setup

### As an agent (consumer)

```sh
# 1. Install the CLI
bun add -g @desplega.ai/agent-fs

# 2. Onboard — generates a local user, drive, and API key
agent-fs onboard

# 3. Verify
agent-fs write hello.md --content "# Hello from an agent"
agent-fs cat hello.md
```

### As an MCP-compatible agent

Add the agent-fs skill to your Claude Code workspace:

```sh
npx skills add desplega-ai/agent-fs
```

This exposes the agent-fs ops as MCP tools and injects the SKILL.md so
your agent knows when to reach for them.

### Self-hosting (operators)

Clone https://github.com/desplega-ai/agent-fs and follow
[DEPLOYMENT.md](https://github.com/desplega-ai/agent-fs/blob/main/DEPLOYMENT.md).
Metadata lives in SQLite, blobs in any S3-compatible storage.

## Conventions

- **Paths** are POSIX-style, leading `/` optional. `thoughts/foo.md` and
  `/thoughts/foo.md` are equivalent.
- **Drives** namespace files. Each user has a personal drive; shared
  drives are invite-only. The CLI's default drive is your personal one.
  Pass `--org <orgId>` (or `--drive <driveId>`) to target a shared drive.
- **Versioning** is automatic. Every `write` creates a new revision; the
  previous content is retained.
- **Output is JSON** for all CLI commands — parse it directly in scripts
  and agent workflows.
- **Search is hybrid**. `agent-fs search` is semantic (vector embeddings),
  `agent-fs fts` is keyword (SQLite FTS5). Use both as needed.
- **Sharing requires a drive invite**, not file-level ACLs. Drive members
  see all files in the drive.
- **Comments are first-class.** Agents (and humans) can comment on any
  file. Comments are searchable.

## Testing

For agents consuming agent-fs:

```sh
# Sanity-check your install
agent-fs --version
agent-fs onboard --check   # verifies API key + drive access

# Write/read round-trip
agent-fs write _smoke.md --content "ok" -m "smoke"
agent-fs cat _smoke.md
agent-fs search "smoke"
```

For contributors to agent-fs itself: see
https://github.com/desplega-ai/agent-fs/blob/main/CLAUDE.md and run
`bun run test` + `bun run scripts/e2e.ts`.

## Links

- Website: https://agent-fs.dev
- Repository: https://github.com/desplega-ai/agent-fs
- Live service: https://live.agent-fs.dev
- Product overview: https://github.com/desplega-ai/agent-fs/blob/main/PRODUCT.md
- Deployment guide: https://github.com/desplega-ai/agent-fs/blob/main/DEPLOYMENT.md
- llms.txt: https://agent-fs.dev/llms.txt
- Sitemap: https://agent-fs.dev/sitemap.xml (and `/sitemap.md`)
- License: MIT
- Built by: Desplega Labs (https://www.desplega.sh)
