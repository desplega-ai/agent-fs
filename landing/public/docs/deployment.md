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
