# Deployment Guide

Four deployment scenarios, from simplest to most complex.

## 1. Single Developer, Local

Everything runs on your machine. SQLite for metadata, MinIO (Docker) for file storage.

### Prerequisites

- [Bun](https://bun.sh) v1.2+
- [Docker](https://docker.com) (for MinIO)

### Setup

```bash
# Install agent-fs
bun add -g @desplega.ai/agent-fs

# Initialize (starts MinIO container, creates DB, registers local user)
agent-fs init --local

# Verify
agent-fs config show
agent-fs write /hello.md --content "Hello from agent-fs"
agent-fs cat /hello.md
```

This creates `~/.agent-fs/` with:
- `agent-fs.db` — SQLite database (metadata, FTS5 index, embeddings)
- `config.json` — S3 endpoint, credentials, embedding settings
- `agent-fs.pid` / `agent-fs.log` — daemon PID and logs (when running as daemon)

### Running as a daemon

```bash
agent-fs daemon start   # Start background daemon
agent-fs daemon status  # Check if running
agent-fs daemon stop    # Stop daemon
```

The daemon serves both the HTTP REST API and the MCP endpoint on `127.0.0.1:7433`. The CLI and `agent-fs mcp` proxy both require a running daemon.

## 2. Single Developer, Remote S3

Use Cloudflare R2, AWS S3, or any S3-compatible storage instead of local MinIO.

### Setup

```bash
agent-fs init --local

# Then configure remote S3
agent-fs config set s3.endpoint "https://<account-id>.r2.cloudflarestorage.com"
agent-fs config set s3.bucket "agent-fs"
agent-fs config set s3.accessKeyId "<your-access-key>"
agent-fs config set s3.secretAccessKey "<your-secret-key>"
agent-fs config set s3.region "auto"
```

### S3 Provider Notes

| Provider | `endpoint` | `region` | `forcePathStyle` |
|----------|-----------|----------|------------------|
| **MinIO** (local) | `http://localhost:9000` | `us-east-1` | `true` |
| **Cloudflare R2** | `https://<account>.r2.cloudflarestorage.com` | `auto` | `true` |
| **AWS S3** | `https://s3.<region>.amazonaws.com` | your region | `false` |
| **DigitalOcean Spaces** | `https://<region>.digitaloceanspaces.com` | your region | `false` |

### S3 Versioning

Enable S3 versioning on your bucket for full `diff` and `revert` support. Without versioning, these operations degrade (no content-level diffs, revert creates from latest only).

```bash
# AWS
aws s3api put-bucket-versioning --bucket agent-fs --versioning-configuration Status=Enabled

# MinIO
mc version enable myminio/agent-fs
```

## 3. Team, Shared Server

Deploy the HTTP server so multiple developers or agents can share the same filesystem.

### Setup

```bash
# On the server
agent-fs init --local
agent-fs server --host 0.0.0.0 --port 7433
```

> **Important**: The default bind address is `127.0.0.1` (localhost only). Use `--host 0.0.0.0` to accept external connections.

### Register users

```bash
# Each team member gets their own identity
curl -X POST http://your-server:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
# Returns: { "apiKey": "..." }
```

### Client configuration

Each team member configures their CLI or MCP client:

```bash
agent-fs config set api.url "http://your-server:7433"
agent-fs config set api.key "<their-api-key>"
```

Or via environment variables:

```bash
export AGENT_FS_API_URL="http://your-server:7433"
export AGENT_FS_API_KEY="<their-api-key>"
```

### RBAC

Users have roles per-organization and per-drive:

| Role | Permissions |
|------|-------------|
| `viewer` | Read files, search, list |
| `editor` | Read + write, edit, delete files |
| `admin` | Full access + manage users, drives, orgs |

Key rules:

- **Drive membership is explicit.** A drive is only visible and usable for users with a drive membership row. New drives grant the creator admin membership automatically. Use `agent-fs --drive <driveId> member invite <email> --role <role>` to add an existing org member to another drive; an org invite grants access to the default drive only.
- **Member management is admin-only.** Inviting, listing, updating, and removing org members requires org `admin`. Managing drive members requires drive `admin` or admin of the owning org. Creating drives in an org requires org `admin`.
- **Drive member listing is viewer-level.** Every drive member can list drive member emails and display names with `drive-members`. Roles stay admin-only.
- **Write paths all enforce editor-or-better** — the JSON ops route, the binary `PUT /raw` route, and FUSE mounts share the same check. Viewers can read everywhere they're a member but cannot write through any surface.
- **Org/drive IDs are bound.** A request that addresses a drive under the wrong org — or any org/drive the caller has no membership in — returns `404`, indistinguishable from a nonexistent ID.

## 4. Multi-Agent, Hosted

Deploy agent-fs as shared infrastructure for autonomous agents.

### Architecture

```
Agent A (Claude Code) ──┐
Agent B (Cursor)     ───┤──→ agent-fs server ──→ SQLite + S3
Agent C (custom)     ───┘        :7433
```

### Setup

1. Deploy server with remote S3 (see scenario 2 for S3 config)
2. Register each agent as a user with its own API key
3. Create shared drives and assign access via RBAC
4. Configure each agent's MCP client with its API key

```bash
# Register agents
curl -X POST http://agent-fs:7433/auth/register -d '{"email": "agent-a@agents.local"}'
curl -X POST http://agent-fs:7433/auth/register -d '{"email": "agent-b@agents.local"}'
```

Each agent gets its own identity, so file operations are attributed to the agent that performed them. Use `log` to see who wrote what.

### Multi-tenant isolation model

When mutually distrustful users or agents share one server, understand what the boundary is — and is not:

- **Isolation is enforced at the application layer** by RBAC: every HTTP, MCP, raw, and FUSE operation proves the caller has an explicit role on the target org/drive before touching data. Cross-tenant org/drive/comment IDs resolve to `404`, so tenants can't probe each other's resources.
- **Storage is a single shared S3 bucket**, namespaced by `<orgId>/drives/<driveId>/...` key prefixes. There is no per-tenant bucket, credential, or encryption key — anyone holding the *server's* S3 credentials (or the server's SQLite DB) can read all tenants' data. Tenant isolation holds only as long as the server host and its credentials are trusted.
- **Signed URLs are an intentional escape hatch.** Generation is RBAC-checked (viewer-or-better on the drive), but the resulting presigned S3 URL is an unauthenticated bearer secret until it expires. A tenant who shares a signed URL is sharing read access to that file with anyone who has the URL.

If you need isolation that survives a server-credential leak, run separate agent-fs instances (or buckets) per tenant.

## Embedding Providers

Semantic search requires an embedding provider. Configure via environment variable or `config.json`.

| Provider | Env Variable | Cost | Notes |
|----------|-------------|------|-------|
| **OpenAI** | `OPENAI_API_KEY` | ~$0.02/1M tokens | Best quality, requires API key |
| **Google Gemini** | `GEMINI_API_KEY` | Free tier available | Good quality, generous free tier |
| **Local (llama.cpp)** | — | Free | Requires local model download, slower |

Priority: environment variable > `config.json` > none (semantic search disabled).

### Configuring in config.json

```json
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "sk-..."
  }
}
```

## Configuration Reference

The config file lives at `~/.agent-fs/config.json` (or `$AGENT_FS_HOME/config.json`).

```json
{
  "s3": {
    "endpoint": "http://localhost:9000",
    "bucket": "agent-fs",
    "region": "us-east-1",
    "accessKeyId": "minioadmin",
    "secretAccessKey": "minioadmin",
    "forcePathStyle": true
  },
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "sk-..."
  },
  "server": {
    "host": "127.0.0.1",
    "port": 7433
  }
}
```

## Upgrading

### Automatic file path normalization

Versions up to 0.15.x could store a path without its leading slash. For example, `notes.md` and `/notes.md` could exist as two different files. The server now changes every path to the `/` form before it uses it. When the daemon starts, it also rewrites the old bare paths in the database. You do not have to do anything.

What the daemon does at startup, before it accepts requests:

- It finds paths without a leading `/` in files, versions, comments, shares, search chunks, and full-text rows.
- It renames each bare path to its `/` form.
- If both forms have history, it merges them into one file. It orders the versions by time and numbers them again. The comments move to the merged file.
- It keeps the search rows of the newest form. A text file without search rows goes back to `pending`, so the indexer builds them again.
- It skips a path that has no safe `/` form (a trailing `/` or a `//`). It logs the count and up to 10 examples.

All changes occur in one transaction. On a 1 GB database with about 1,800 bare paths, it took about 4 seconds on a laptop SSD. A slower disk takes longer. The server does not answer `/health` until the migration ends, so give your health check a grace period. After the first run, the check at each start takes milliseconds.

When there is nothing to change, the daemon logs nothing. When it changes data, it logs one line:

```
file path migration: 62 renamed, 24 merged, 180 versions renumbered, 3 comments remapped, 0 skipped
```

Before you upgrade:

- Make a backup of `agent-fs.db`. For example: `sqlite3 ~/.agent-fs/agent-fs.db ".backup agent-fs-backup.db"`.
- To see how many rows have a bare path, run this read-only query:

  ```bash
  sqlite3 ~/.agent-fs/agent-fs.db "SELECT
    (SELECT COUNT(*) FROM files WHERE path NOT LIKE '/%') AS files,
    (SELECT COUNT(*) FROM file_versions WHERE path NOT LIKE '/%') AS versions,
    (SELECT COUNT(*) FROM comments WHERE path NOT LIKE '/%') AS comments"
  ```

  If all three counts are `0`, the migration has almost certainly nothing to do.

If the migration fails, the transaction rolls back and the daemon logs `file path migration failed (will retry on next start)`. The daemon then starts normally. Files that are only in the bare form stay hidden until a start completes the migration. The daemon tries again at each start.

If you go back to an older version, it reads the migrated data correctly. If the older version writes new bare paths, the next start of a new version migrates them.

Only the server runs this migration: the local daemon, or the server process in a hosted deployment. `agent-fs init` and the other CLI commands do not change existing paths.

## Troubleshooting

### "SQLITE_ERROR: no such module: fts5"

On macOS, Apple's bundled SQLite doesn't support extensions. Install via Homebrew:

```bash
brew install sqlite
```

Bun will use the Homebrew version automatically.

### MinIO container won't start

Check if port 9000 is already in use:

```bash
lsof -i :9000
```

The MinIO container is named `agent-fs-minio`. Check its status:

```bash
docker ps -a --filter name=agent-fs-minio
docker logs agent-fs-minio
```

### Daemon won't start

Check for stale PID file:

```bash
cat ~/.agent-fs/agent-fs.pid
kill -0 $(cat ~/.agent-fs/agent-fs.pid) 2>/dev/null && echo "running" || echo "stale"
```

If stale, remove the PID file and restart:

```bash
rm ~/.agent-fs/agent-fs.pid
agent-fs daemon start
```
