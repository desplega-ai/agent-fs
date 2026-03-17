# Deployment

## Prerequisites

- `NPM_TOKEN` secret set in GitHub repo settings (granular access token for `@desplega-ai` scope)
- `@desplega-ai` org exists on npm

## Release Process

1. Update `version` in root `package.json`
2. Commit the version bump
3. Run `./scripts/release.sh`

This creates a git tag `v{version}` and pushes it, triggering the release workflow which:

- **Runs typecheck and tests** to validate the release
- **Publishes to npm** as `@desplega.ai/agent-fs` with provenance
- **Creates a GitHub Release** with install instructions

## npm Package

- **Name:** `@desplega.ai/agent-fs`
- **Scope:** public
- **Runtime:** Bun-only (`engines.bun >= 1.2.0`)
- **Contents:** Bundled CLI (`dist/cli.js`) with external npm dependencies

### Install

```bash
bun add -g @desplega.ai/agent-fs
agent-fs --help
```

## Build Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Bundle CLI for npm to `packages/cli/dist/cli.js` |

## Manual npm Publish (if needed)

```bash
bun run build
cd packages/cli && bun publish --access public
```

Requires `NPM_CONFIG_TOKEN` env var set with a valid npm token.

## Notes

- `bun publish` auto-resolves `workspace:*` dependencies to real versions
- Auth uses `NPM_CONFIG_TOKEN` (not `NODE_AUTH_TOKEN` — Bun ignores that)
- No `--provenance` support in `bun publish` yet; use `npm publish` if needed

## Docker / GHCR

Pre-built multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR on every release.

```bash
docker pull ghcr.io/desplega-ai/agent-fs:latest
docker run -d -p 7433:7433 -v agent-fs-data:/data ghcr.io/desplega-ai/agent-fs:latest
```

Images are tagged with the full version (`0.2.0`), major.minor (`0.2`), major (`0`), git SHA, and `latest`. Browse available tags at [ghcr.io/desplega-ai/agent-fs](https://github.com/desplega-ai/agent-fs/pkgs/container/agent-fs).

## Fly.io Deployment

### Quick Start (Interactive Script)

The deploy script walks you through app creation, storage provisioning, and deployment:

```bash
git clone https://github.com/desplega-ai/agent-fs && cd agent-fs
bun run scripts/fly-deploy.ts
```

Pass `-y` to accept all defaults (app name `agent-fs`, region `ord`, Tigris storage, `shared-cpu-1x`):

```bash
bun run scripts/fly-deploy.ts -y
```

### Manual Setup

If you prefer to run the `fly` commands yourself:

```bash
# 1. Create the app (uses fly.toml from the repo)
fly launch --no-deploy --copy-config

# 2. Create a persistent volume for SQLite data
fly volumes create agent_fs_data --size 1 --region ord -y

# 3. Provision storage (pick one)

# Option A: Tigris (zero-config, auto-injects AWS_* env vars)
fly storage create

# Option B: BYOK S3-compatible storage
fly secrets set \
  S3_ENDPOINT=https://your-s3-endpoint.com \
  S3_BUCKET=your-bucket \
  S3_ACCESS_KEY_ID=your-key \
  S3_SECRET_ACCESS_KEY=your-secret

# 4. Deploy
fly deploy
```

After deployment, register your first API key:

```bash
curl -X POST https://your-app.fly.dev/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

### Tigris vs BYOK Storage

| | Tigris | BYOK (Bring Your Own) |
|---|---|---|
| **Setup** | `fly storage create` — zero config | `fly secrets set S3_*=...` |
| **Auth** | Auto-injected `AWS_*` env vars | Manual secret management |
| **Regions** | Globally distributed via Tigris CDN | Depends on your provider |
| **Cost** | Included in Fly.io billing | Separate billing |
| **Use case** | Default — simplest path | When you need a specific provider (AWS S3, Cloudflare R2, MinIO, etc.) |

### Instance Sizing

| Size | CPU | Memory | Use Case |
|------|-----|--------|----------|
| `shared-cpu-1x` | 1 shared | 256–512 MB | Development, personal use |
| `shared-cpu-2x` | 2 shared | 512 MB–1 GB | Small teams, moderate traffic |
| `performance-1x` | 1 dedicated | 2 GB | Production, heavy embedding workloads |

The default `fly.toml` uses `shared-cpu-1x` with 512 MB. Adjust in `fly.toml` under `[[vm]]` or pass the instance size when prompted by the deploy script.

## Environment Variables Reference

All environment variables supported by the server. Priority: env vars > config.json > defaults.

| Env Var | Config Path | Default | Notes |
|---------|------------|---------|-------|
| `AGENT_FS_HOME` | — | `~/.agent-fs` | Data directory (SQLite DB, logs, pid file) |
| `AWS_ENDPOINT_URL_S3` / `S3_ENDPOINT` | `s3.endpoint` | `http://localhost:9000` | Tigris auto-injects `AWS_ENDPOINT_URL_S3` |
| `AWS_ACCESS_KEY_ID` / `S3_ACCESS_KEY_ID` | `s3.accessKeyId` | — | Tigris auto-injects `AWS_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` / `S3_SECRET_ACCESS_KEY` | `s3.secretAccessKey` | — | Tigris auto-injects `AWS_SECRET_ACCESS_KEY` |
| `BUCKET_NAME` / `S3_BUCKET` | `s3.bucket` | `agentfs` | Tigris auto-injects `BUCKET_NAME` |
| `AWS_REGION` / `S3_REGION` | `s3.region` | `us-east-1` | Tigris auto-injects `AWS_REGION` |
| `S3_PROVIDER` | `s3.provider` | `minio` | Display-only (e.g., `minio`, `tigris`, `r2`) |
| `SERVER_PORT` | `server.port` | `7433` | |
| `SERVER_HOST` | `server.host` | `127.0.0.1` | Set to `0.0.0.0` in containers |
| `EMBEDDING_PROVIDER` | `embedding.provider` | `local` | `local`, `openai`, or `gemini` |
| `EMBEDDING_MODEL` | `embedding.model` | — | Model name for the chosen provider |
| `EMBEDDING_API_KEY` | `embedding.apiKey` | — | API key for `openai` or `gemini` providers |

When both `AWS_*` and `S3_*` variants are set, the `AWS_*` variant takes precedence (Tigris injects `AWS_*` automatically).

## LiteFS Upgrade Path

For users who need SQLite replication across multiple Fly.io instances, a reference `litefs.yml` configuration is included in the repository root. LiteFS is **not active by default** — the standard deployment uses a single-node volume mount.

To enable LiteFS, you would need to switch the Dockerfile base image to include the LiteFS binary and update the `CMD` to run via `litefs mount`. See `litefs.yml` for the static lease (single-node) and commented-out Consul (multi-node) configurations.
