---
date: 2026-03-17T12:00:00-04:00
researcher: Claude
git_commit: c73c0f0
branch: main
repository: agent-fs
topic: "Fly.io deployment with LiteFS, Tigris, GHCR CI, and one-click deploy"
tags: [research, deployment, fly.io, litefs, tigris, docker, ghcr, ci]
status: complete
autonomy: autopilot
last_updated: 2026-03-17
last_updated_by: Claude
---

# Research: Fly.io Deployment for agent-fs

**Date**: 2026-03-17
**Researcher**: Claude
**Git Commit**: c73c0f0
**Branch**: main

## Research Question

How to set up Fly.io deployment for agent-fs with: fly.toml configuration, LiteFS for SQLite persistence/backups, Tigris for S3 storage (with BYOK option), GHCR Docker image publishing CI, and a one-click deploy experience.

## Summary

agent-fs is well-positioned for Fly.io deployment. The daemon is a Hono HTTP server on Bun (port 7433) with SQLite metadata and S3-compatible object storage — both map cleanly to Fly.io primitives: a persistent volume for SQLite and Tigris for S3. The existing Dockerfile needs minor updates, and a **critical gap** must be addressed: the server reads all config from `config.json`, not environment variables, so `getConfig()` must be extended to support env var overrides for all config sections.

The deployment stack requires: updated `Dockerfile` (OCI label, alpine base), new `fly.toml`, new `.github/workflows/docker-publish.yml` (GHCR on tags), new `scripts/fly-deploy.ts` (interactive setup), new `.env.production.example` (documents all env vars), and a code change to `getConfig()` for env var overrides. LiteFS config is included as an optional upgrade path. Users get two S3 options: Tigris (auto-provisioned via `fly storage create`) or BYOK (any S3-compatible endpoint via Fly secrets).

## Detailed Findings

### 1. Current Daemon Architecture

The agent-fs server is a Hono-based HTTP API running on Bun:

- **Entry point**: `packages/server/src/index.ts` — bootstraps config, DB, S3, then `Bun.serve()` on `config.server.host:config.server.port`
- **Default port**: `7433` (configurable via `config.json` → `server.port`)
- **Default host**: `127.0.0.1` (must be `0.0.0.0` for Docker/Fly)
- **Health check**: `GET /health` → `{"ok": true, "version": "0.2.0"}` — public, no auth
- **Auth**: Bearer token on all routes except `/health` and `/auth/register`
- **Database**: SQLite at `<AGENT_FS_HOME>/agent-fs.db` via `bun:sqlite` + Drizzle ORM + `sqlite-vec` extension
- **Storage**: S3-compatible via `@aws-sdk/client-s3` with `forcePathStyle: true`
- **Config**: JSON file at `<AGENT_FS_HOME>/config.json` — NOT environment variables
- **Process lifecycle**: PID file at `<AGENT_FS_HOME>/agent-fs.pid`, SIGTERM handler for graceful shutdown

Key files:
| File | Description |
|------|-------------|
| `packages/server/src/index.ts` | Server bootstrap, `Bun.serve()` |
| `packages/server/src/app.ts` | Hono app, routes, middleware |
| `packages/server/src/daemon.ts` | Daemon start/stop/status |
| `packages/core/src/config.ts` | Config types, defaults, read/write |
| `packages/core/src/db/index.ts` | SQLite database creation |
| `packages/core/src/s3/client.ts` | `AgentS3Client` wrapper |

### 2. S3 Storage Layer — Tigris & BYOK Compatibility

**Current state**: The `AgentS3Client` at `packages/core/src/s3/client.ts:50-67` uses the standard AWS SDK with `forcePathStyle: true` and accepts an arbitrary `endpoint`. Swapping to any S3-compatible provider (Tigris, R2, Backblaze) requires only changing config values — no code changes.

**Config shape** (`packages/core/src/config.ts:13-22`):
```typescript
s3: {
  provider: string;      // "minio" | "s3" | "tigris" (display only, never read by client)
  bucket: string;        // default: "agentfs"
  region: string;        // default: "us-east-1"
  endpoint: string;      // default: "http://localhost:9000"
  accessKeyId: string;
  secretAccessKey: string;
  versioningEnabled?: boolean;
}
```

**Critical gap**: The server reads config exclusively from `config.json` (`packages/core/src/config.ts:99-112`). There is no env var fallback for S3 settings. On Fly.io, Tigris auto-injects env vars (`AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BUCKET_NAME`, `AWS_REGION`), and BYOK users would set these via `fly secrets set`. The config resolution must be extended to check env vars.

**Proposed env var mapping**:
| Env Var (Fly/Tigris) | Config Field |
|---|---|
| `AWS_ENDPOINT_URL_S3` or `S3_ENDPOINT` | `s3.endpoint` |
| `AWS_ACCESS_KEY_ID` or `S3_ACCESS_KEY_ID` | `s3.accessKeyId` |
| `AWS_SECRET_ACCESS_KEY` or `S3_SECRET_ACCESS_KEY` | `s3.secretAccessKey` |
| `BUCKET_NAME` or `S3_BUCKET` | `s3.bucket` |
| `AWS_REGION` or `S3_REGION` | `s3.region` |

This gives Tigris users zero-config (env vars auto-injected) and BYOK users a clean `fly secrets set S3_ENDPOINT=... S3_BUCKET=...` workflow.

### 3. Tigris on Fly.io

Tigris is Fly's native S3-compatible global object storage:

- **Provisioning**: `fly storage create` — auto-sets `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BUCKET_NAME`, `AWS_REGION` as Fly secrets
- **Endpoint**: `https://fly.storage.tigris.dev`
- **Region**: `auto` (global distribution)
- **Pricing**: Free tier 5GB storage + 10GB egress, then $0.02/GB/mo storage, $0.05/GB egress to internet, $0.00 within Fly network
- **Compatibility**: Full S3 API, works with `forcePathStyle: true`
- **Shadow buckets**: Can transparently proxy reads/writes to an existing S3 bucket for migration

### 4. LiteFS for SQLite Persistence

LiteFS is a FUSE-based distributed filesystem that replicates SQLite. For agent-fs's single-node deployment:

**Architecture**:
- LiteFS mounts a FUSE filesystem at `/litefs`
- App reads/writes SQLite at `/litefs/agent-fs.db` (normal file operations). LiteFS intercepts at the FUSE level, so WAL and SHM files are managed transparently — the app doesn’t need to know about them. LiteFS captures WAL frames as they’re written and replicates them to other nodes.
- LiteFS stores internal data on a persistent Fly volume at `/var/lib/litefs`
- For single-node: use `type: "static"` lease (no Consul needed)
- For multi-node: use Consul lease (`fly consul attach`)

**Backup strategy**: LiteFS itself is alive and actively maintained — the speedrun guide and all FUSE-based replication works fine. Only *LiteFS Cloud* (the managed backup SaaS) was sunset in Oct 2024. For backups without LiteFS Cloud:
- **Option A — litefs-backup**: Self-hosted service streaming to S3/Tigris. Point-in-time restore.
- **Option B — Litestream**: Continuous WAL streaming to S3/Tigris. Can run as sidecar.
- Both options can use the same Tigris bucket as agent-fs file storage.

**FUSE requirement**: LiteFS needs `fuse3` installed in the container and runs with elevated privileges (handled automatically by Fly Machines).

**SQLite compatibility note**: agent-fs uses `PRAGMA journal_mode=WAL` and loads `sqlite-vec` extension. Both are compatible with LiteFS. The `setup-sqlite.ts` macOS Homebrew swap is irrelevant in the Linux container.

### 5. Existing Docker Setup

**Current Dockerfile** (`Dockerfile`):
- Multi-stage: `oven/bun:1` builder → `oven/bun:1-slim` runtime
- Builder: installs deps, copies source, runs `bun run build`
- Runtime: production deps only, copies `packages/cli/dist/`, sets `AGENT_FS_HOME=/data`
- Exposes port 7433, healthcheck via `curl -f http://localhost:7433/health`
- CMD: `bun run packages/cli/dist/cli.js server --host 0.0.0.0`

**Two approaches for persistence** (decided: start simple, upgrade if needed):

**Approach A — Simple Volume Mount (MVP, recommended to start)**:
- Mount a Fly volume at `/data`, set `AGENT_FS_HOME=/data`
- Both `config.json` and `agent-fs.db` persist on the volume naturally
- No FUSE, no litefs.yml, no extra dependencies
- CMD stays as-is: `bun run packages/cli/dist/cli.js server --host 0.0.0.0`
- Backups: periodic `sqlite3 .backup` to Tigris, or Litestream sidecar

**Approach B — LiteFS (upgrade path for replication)**:
1. Add `COPY --from=flyio/litefs:0.5 /usr/local/bin/litefs /usr/local/bin/litefs`
2. Install `fuse3` (and `ca-certificates`) in runtime stage
3. Copy `litefs.yml` to `/etc/litefs.yml`
4. Change ENTRYPOINT to `litefs mount` (LiteFS supervises the app)
5. Point `AGENT_FS_HOME` to `/litefs` so the DB lives on the FUSE mount

**Common changes for both approaches**:
- Add OCI label: `LABEL org.opencontainers.image.source="https://github.com/desplega-ai/agent-fs"`
- Consider switching to `oven/bun:1-alpine` for smaller images (~120MB vs ~400MB)
- Dockerfile stays general-purpose (LiteFS binary is harmless if unused, ENTRYPOINT overridable)

**Existing docker-compose files**:
- `docker-compose.yml`: MinIO + agent-fs for local dev
- `docker-compose.hosted.yml`: agent-fs only, external S3 (env vars documented as comments)

### 6. Existing CI/CD

**Workflows**:
- `.github/workflows/ci.yml`: Push/PR to main → typecheck, build, test, coverage, OpenAPI freshness
- `.github/workflows/npm-publish.yml`: Tag `v*` → verify version, typecheck, test, build, `npm publish`, GitHub Release

**Release flow** (`scripts/release.sh`):
1. Read version from root `package.json`
2. Sync to sub-package `package.json` files
3. Commit + push to main
4. Create + push git tag `v{version}`

**No GHCR publishing exists**. A new workflow is needed.

### 7. Proposed fly.toml

```toml
app = "agent-fs"
primary_region = "ord"
kill_signal = "SIGTERM"
kill_timeout = "5s"
swap_size_mb = 256

[build]
  dockerfile = "Dockerfile"
  # Alternative: deploy pre-built image from GHCR (no local Docker needed)
  # image = "ghcr.io/desplega-ai/agent-fs:latest"

[env]
  AGENT_FS_HOME = "/data"
  PORT = "7433"

[http_service]
  internal_port = 7433
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [http_service.concurrency]
    type = "requests"
    soft_limit = 250
    hard_limit = 300

  [[http_service.checks]]
    grace_period = "10s"
    interval = "15s"
    method = "GET"
    timeout = "3s"
    path = "/health"
    protocol = "http"

[mounts]
  source = "agent_fs_data"
  destination = "/data"
  initial_size = "1gb"
  snapshot_retention = 14
  auto_extend_size_threshold = 80
  auto_extend_size_increment = "1gb"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Note: Volume at `/data` holds both `config.json` and `agent-fs.db`. Env vars (from Tigris or BYOK secrets) override config.json values at runtime.

**Instance sizing options**:
- `shared-cpu-1x` + 256mb–2gb: ~$3.19/mo (dev/staging)
- `shared-cpu-2x` + 512mb–4gb: ~$6.38/mo (small production)
- `performance-1x` + 2048mb–8gb: dedicated CPU (high-traffic production)

### 8. LiteFS Configuration (optional upgrade path)

Not needed for the MVP (simple volume mount). Include `litefs.yml` in the repo for users who want replication later:

```yaml
# litefs.yml — only needed if upgrading from simple volumes to LiteFS replication
fuse:
  dir: "/litefs"

data:
  dir: "/var/lib/litefs"

exec:
  - cmd: "bun run /app/packages/cli/dist/cli.js server --host 0.0.0.0"

lease:
  type: "static"
  candidate: true
  hostname: "localhost"
  advertise-url: "http://localhost:20202"
```

To enable: change `AGENT_FS_HOME` to `/litefs`, mount volume at `/var/lib/litefs`, add `[processes] app = "litefs mount"` to fly.toml, and install fuse3 in Dockerfile.

For multi-node with Consul:
```yaml
lease:
  type: "consul"
  advertise-url: "http://${HOSTNAME}.vm.${FLY_APP_NAME}.internal:20202"
  candidate: ${FLY_REGION == PRIMARY_REGION}
  promote: true
  consul:
    url: "${FLY_CONSUL_URL}"
    key: "litefs/${FLY_APP_NAME}"
```

### 9. Proposed GHCR Workflow

```yaml
# .github/workflows/docker-publish.yml
name: Publish Docker Image
on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  packages: write
  id-token: write

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=sha
            type=raw,value=latest,enable={{is_default_branch}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Triggers on the same `v*` tags as the npm publish workflow, so `release.sh` triggers both.

### 10. One-Click Deploy Experience

**User flow** (manual):
```bash
fly launch --from https://github.com/desplega-ai/agent-fs
fly storage create                     # Tigris (auto-sets S3 env vars)
fly secrets set AUTH_SECRET=...        # App secrets
fly deploy
```

**Interactive setup script** (`scripts/fly-deploy.ts`):
A Bun TS script that automates the full flow with interactive prompts and a `-y` flag for autopilot:

```typescript
// scripts/fly-deploy.ts
// Usage: bun run scripts/fly-deploy.ts [-y]
//
// Interactive prompts:
// 1. App name (default: agent-fs)
// 2. Region (default: ord)
// 3. Storage: Tigris (auto) vs BYOK (prompts for endpoint/bucket/keys)
// 4. Instance size: shared-cpu-1x / shared-cpu-2x / performance-1x
//
// With -y flag: uses all defaults, Tigris, shared-cpu-1x
//
// Steps executed:
// 1. fly launch --name <app> --region <region> --no-deploy
// 2. fly volumes create agent_fs_data --size 1 --region <region>
// 3. fly storage create (if Tigris) OR fly secrets set S3_*=... (if BYOK)
// 4. fly secrets set AUTH_SECRET=<generated>
// 5. fly deploy
```

This keeps the manual steps documented above for users who prefer CLI, while giving a streamlined experience for the common case.

**Secrets management**: fly.toml's `[env]` section is for non-sensitive values only (committed to git). Secrets must be set via `fly secrets set` or bulk-imported: `fly secrets import < .env.production`. A `.env.production.example` file in the repo documents all available env vars with placeholder values:

```bash
# .env.production.example — Copy to .env.production and fill in values
# Then import: fly secrets import < .env.production

# S3 Storage — Option A: Tigris (auto-set by `fly storage create`, skip these)
# S3 Storage — Option B: BYOK (set these manually)
S3_ENDPOINT=https://your-s3-endpoint.com
S3_BUCKET=agentfs
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_REGION=us-east-1

# Server
SERVER_HOST=0.0.0.0
SERVER_PORT=7433

# Auth
AUTH_API_KEY=your-secret-api-key

# Embeddings (optional)
# EMBEDDING_PROVIDER=openai
# EMBEDDING_MODEL=text-embedding-3-small
# EMBEDDING_API_KEY=sk-...
```

The `fly-deploy.ts` script would:
1. Check for `.env.production` — if it exists, offer to import it via `fly secrets import`
2. If not, prompt for Tigris vs BYOK and set secrets interactively
3. With `-y` flag: use Tigris (auto), skip the prompt

### 11. Storage Mode Decision Tree

```
┌─────────────────────────────────┐
│ How should S3 storage be set up?│
├─────────────────────────────────┤
│                                 │
│  A) Tigris (recommended)        │
│     fly storage create          │
│     → auto-injects env vars     │
│     → zero config               │
│                                 │
│  B) BYOK (any S3-compatible)    │
│     fly secrets set             │
│       S3_ENDPOINT=...           │
│       S3_BUCKET=...             │
│       S3_ACCESS_KEY_ID=...      │
│       S3_SECRET_ACCESS_KEY=...  │
│       S3_REGION=...             │
│                                 │
└─────────────────────────────────┘
```

## Code References

| File | Line(s) | Description |
|------|---------|-------------|
| `packages/server/src/index.ts` | 1-41 | Server bootstrap: config → DB → S3 → app → Bun.serve() |
| `packages/server/src/app.ts` | 44 | Health check endpoint `/health` |
| `packages/core/src/config.ts` | 13-22 | S3 config type definition |
| `packages/core/src/config.ts` | 47-78 | Default config values |
| `packages/core/src/config.ts` | 99-112 | `getConfig()` — reads config.json, no env var fallback |
| `packages/core/src/s3/client.ts` | 50-67 | `AgentS3Client` constructor — uses `forcePathStyle: true` |
| `packages/core/src/db/index.ts` | 19-43 | `createDatabase()` — SQLite + WAL + sqlite-vec |
| `packages/server/src/daemon.ts` | 14-48 | `startDaemon()` — PID file, detached spawn |
| `Dockerfile` | 1-31 | Existing multi-stage build |
| `docker-compose.hosted.yml` | 1-20 | Hosted deployment template (external S3) |
| `.github/workflows/npm-publish.yml` | 1-70 | Existing release workflow (npm + GitHub Release) |
| `scripts/release.sh` | 1-27 | Release script (version sync + tag push) |

## Architecture Documentation

### Config Resolution — Env Var Override

The most important code change: `getConfig()` at `packages/core/src/config.ts:99-112` reads only from `config.json`. Must be extended so env vars override all config sections. Priority: env vars > config.json > defaults.

**Env var naming convention**:
- S3: `AWS_ENDPOINT_URL_S3`/`S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`/`S3_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`/`S3_SECRET_ACCESS_KEY`, `BUCKET_NAME`/`S3_BUCKET`, `AWS_REGION`/`S3_REGION`
- Server: `SERVER_PORT`, `SERVER_HOST`
- Auth: `AUTH_API_KEY`
- Embedding: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`

Tigris-injected `AWS_*` names take precedence over `S3_*` names.

### Deployment Architecture

```
Fly Volume at /data (persistent):
  /data/config.json    ← persisted defaults, overridden by env vars at runtime
  /data/agent-fs.db    ← SQLite database (WAL mode)
  /data/agent-fs.log   ← daemon log
  /data/agent-fs.pid   ← PID file

Tigris (or BYOK S3):
  File content storage (objects, versions)

Env vars (Fly secrets):
  S3 credentials (auto-injected by Tigris or manual BYOK)
  Auth secrets
  Optional: server/embedding config overrides
```

### Dockerfile Architecture (general-purpose)

```
oven/bun:1 (builder)
  → install deps
  → copy source
  → bun run build

oven/bun:1-alpine (runtime)
  → COPY --from=flyio/litefs:0.5 litefs binary (available but not active by default)
  → ca-certificates
  → production deps only
  → copy dist/
  → AGENT_FS_HOME=/data
  → CMD ["bun", "run", "packages/cli/dist/cli.js", "server", "--host", "0.0.0.0"]
  → (LiteFS users override: ENTRYPOINT ["litefs", "mount"])
```

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-15-architecture-review.md` — Full architecture review including DB and S3 layer
- `thoughts/taras/research/2026-03-16-npm-distribution-migration.md` — npm publishing and distribution approach

## Resolved Decisions

1. **Dockerfile**: General-purpose single Dockerfile. LiteFS binary included (harmless if unused), ENTRYPOINT overridable. No separate `Dockerfile.fly`.

2. **Persistence strategy**: Start with **simple Fly volume mount** at `/data` (holds both `config.json` and `agent-fs.db`). LiteFS is an optional upgrade path for replication — config included in repo but not active by default. Volumes are sufficient for single-node.

3. **Multi-arch Docker images**: Yes — `linux/amd64` + `linux/arm64` for both Fly.io and local Apple Silicon dev.

4. **fly.toml build strategy**: Start with `dockerfile = "Dockerfile"`, include commented-out `image = "ghcr.io/desplega-ai/agent-fs:latest"` for users who prefer pre-built images.

5. **Env var override scope**: ALL config sections should support env var overrides (S3, server, auth, embedding). The Fly volume at `/data` persists config.json alongside the DB — env vars override at runtime, config.json provides defaults on the volume.

6. **Setup script**: New `scripts/fly-deploy.ts` — interactive Bun script with `-y` flag for autopilot. Handles `fly launch`, `fly volumes create`, `fly storage create` (Tigris) or BYOK secrets, and `fly deploy`.
