---
date: 2026-03-17
planner: Claude
status: done
autonomy: autopilot
research: thoughts/taras/research/2026-03-17-flyio-deployment.md
repository: agent-fs
branch: main
git_commit: c73c0f0
tags: [plan, deployment, fly.io, docker, ghcr, ci, config]
---

# Fly.io Deployment Implementation Plan

## Overview

Add Fly.io deployment support to agent-fs: env var config overrides, improved Dockerfile, GHCR Docker image publishing CI, fly.toml, an interactive deploy script, and documentation. This enables both `fly deploy` (build on Fly) and pre-built GHCR image deployments, with Tigris or BYOK S3 storage.

## Current State Analysis

- **Config**: `getConfig()` at `packages/core/src/config.ts:99-112` reads only from `config.json` — no env var overrides for S3, server, or auth settings. Shallow merge (`{ ...DEFAULT_CONFIG, ...parsed }`) doesn't deep-merge nested sections.
- **Dockerfile**: Multi-stage `oven/bun:1` → `oven/bun:1-slim`, no OCI labels, no `.dockerignore`.
- **CI**: Two workflows — `ci.yml` (push/PR validation) and `npm-publish.yml` (tag-triggered npm release). No Docker image publishing.
- **Deployment docs**: `DEPLOYMENT.md` covers npm publishing only. No Fly.io, no Docker registry.
- **Missing files**: No `fly.toml`, `litefs.yml`, `.dockerignore`, `.env.production.example`, or `scripts/fly-deploy.ts`.

### Key Discoveries:
- `getConfig()` shallow merge at `config.ts:111` means if `config.json` has a partial `s3` block, defaults for missing `s3` fields are lost — this is a pre-existing bug that env var override work should also fix.
- `config.auth.apiKey` is **client-side only** — server auth validates keys against the DB via SHA-256 hash lookup (`middleware/auth.ts:29`, `identity/users.ts:51-64`). First-time Fly.io users register via `POST /auth/register` (public endpoint).
- Embedding provider factory at `core/src/search/embeddings/index.ts:39-80` already has env var overrides (`OPENAI_API_KEY`, `GEMINI_API_KEY`) — this pattern should be replicated for S3 and server config.
- `createDatabase()` at `core/src/db/index.ts:19` resolves DB path independently via `getDbPath()` → `getHome()` — no config object needed, works with `AGENT_FS_HOME` env var already.
- Server calls `getConfig()` twice: once in `index.ts:5` (bootstrap) and once in `app.ts:19` (CORS/rate-limit). Both are synchronous reads of the same file.
- Release script (`scripts/release.sh`) pushes a `v*` tag — this already triggers `npm-publish.yml`. A new GHCR workflow on the same trigger means `release.sh` needs zero changes.

## Desired End State

1. Server is fully configurable via environment variables (priority: env vars > config.json > defaults)
2. Docker image published to GHCR on every release tag (`ghcr.io/desplega-ai/agent-fs`)
3. `fly deploy` works out of the box with `fly.toml` in the repo
4. Users can deploy with Tigris (zero-config) or BYOK S3 (via `fly secrets set`)
5. Interactive `scripts/fly-deploy.ts` automates the full setup flow
6. `DEPLOYMENT.md` documents both npm and Fly.io/Docker deployment paths

### How to verify (E2E):
```bash
# After all phases complete:

# 1. Config env vars work
AGENT_FS_HOME=/tmp/test-config S3_ENDPOINT=http://fake:9000 S3_BUCKET=test bun run packages/server/src/index.ts &
curl http://localhost:7433/health  # should return {"ok":true}
kill %1

# 2. Docker builds and runs
docker build -t agent-fs-test .
docker run --rm -p 7433:7433 -e AGENT_FS_HOME=/data -e S3_ENDPOINT=http://host.docker.internal:9000 agent-fs-test &
curl http://localhost:7433/health
docker stop $(docker ps -q --filter ancestor=agent-fs-test)

# 3. fly.toml validates
fly config validate  # (requires fly CLI)

# 4. Deploy script has help
bun run scripts/fly-deploy.ts --help
```

## Quick Verification Reference

Common commands:
- `bun run typecheck` — TypeScript type checking
- `bun run test` — Run tests
- `bun run build` — Bundle CLI
- `docker build -t agent-fs-test .` — Docker build

Key files to check:
- `packages/core/src/config.ts` — Config with env var overrides
- `packages/core/src/config.test.ts` — Config tests
- `Dockerfile` — Updated multi-stage build
- `.github/workflows/docker-publish.yml` — GHCR publish workflow
- `fly.toml` — Fly.io app config
- `scripts/fly-deploy.ts` — Interactive deploy script

## What We're NOT Doing

- **LiteFS active by default** — included as reference config (`litefs.yml`) but not active. Simple volume mount is the MVP persistence strategy.
- **Multi-node replication** — single-node deployment only. Consul lease config documented but not implemented.
- **Automated backups** — Litestream/litefs-backup integration is a future enhancement. Volume snapshots (14-day retention in `fly.toml`) provide basic backup.
- **Alpine base image switch** — keeping `oven/bun:1-slim` for now to avoid potential compatibility issues with native deps (sqlite-vec). Can be evaluated separately.
- **fly.io button / deploy-on-fly badge** — requires the app to be public on Fly. Out of scope.
- **Modifying release.sh** — the GHCR workflow triggers on the same `v*` tags, so no changes needed.

## Implementation Approach

Six phases, ordered by dependency:

1. **Config env var overrides** (code change, tests) — foundation for everything else
2. **Dockerfile + .dockerignore** (container improvements) — needed before GHCR
3. **GHCR Docker publish workflow** (CI) — enables pre-built image deploys
4. **Fly.io config files** (fly.toml, .env.production.example, litefs.yml) — deployment config
5. **Interactive deploy script** (scripts/fly-deploy.ts) — user experience
6. **Documentation** (DEPLOYMENT.md update) — tie it all together

---

## Phase 1: Config Env Var Overrides

### Overview
Extend `getConfig()` to support environment variable overrides with priority: env vars > config.json > defaults. Fix the shallow merge bug. Add tests.

### Changes Required:

#### 1. Deep merge + env var overrides in getConfig()
**File**: `packages/core/src/config.ts`
**Changes**:

Add a `deepMerge()` helper to replace the shallow spread. Then add an `applyEnvOverrides()` function that checks specific env vars and overrides nested config fields. Call both in `getConfig()` before returning.

Env var mapping (Tigris-injected `AWS_*` names take precedence over `S3_*` names):

| Env Var | Config Path | Notes |
|---------|------------|-------|
| `AWS_ENDPOINT_URL_S3` / `S3_ENDPOINT` | `s3.endpoint` | Tigris auto-injects `AWS_ENDPOINT_URL_S3` |
| `AWS_ACCESS_KEY_ID` / `S3_ACCESS_KEY_ID` | `s3.accessKeyId` | Tigris auto-injects `AWS_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` / `S3_SECRET_ACCESS_KEY` | `s3.secretAccessKey` | Tigris auto-injects `AWS_SECRET_ACCESS_KEY` |
| `BUCKET_NAME` / `S3_BUCKET` | `s3.bucket` | Tigris auto-injects `BUCKET_NAME` |
| `AWS_REGION` / `S3_REGION` | `s3.region` | Tigris auto-injects `AWS_REGION` |
| `S3_PROVIDER` | `s3.provider` | Display-only field |
| `SERVER_PORT` | `server.port` | Parse as integer |
| `SERVER_HOST` | `server.host` | |
| `EMBEDDING_PROVIDER` | `embedding.provider` | Must be "local" / "openai" / "gemini" |
| `EMBEDDING_MODEL` | `embedding.model` | |
| `EMBEDDING_API_KEY` | `embedding.apiKey` | |

Note: `auth.apiKey` is deliberately **not** overridable via env var — it's a client-side stored credential, not server config. Server auth validates keys against the DB.

The `applyEnvOverrides()` function should be a simple, explicit mapping — no dynamic reflection or auto-discovery. Example shape:

```typescript
function applyEnvOverrides(config: AgentFSConfig): AgentFSConfig {
  const env = process.env;
  // S3 — Tigris AWS_* names take precedence over S3_* names
  if (env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT)
    config.s3.endpoint = env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT!;
  if (env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID)
    config.s3.accessKeyId = env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID!;
  // ... etc for each field
  return config;
}
```

#### 2. Fix shallow merge
**File**: `packages/core/src/config.ts`
**Changes**:

Replace `{ ...DEFAULT_CONFIG, ...parsed }` with a proper deep merge. A simple two-level deep merge is sufficient (AgentFSConfig has exactly two levels of nesting):

```typescript
function deepMergeConfig(defaults: AgentFSConfig, overrides: Partial<AgentFSConfig>): AgentFSConfig {
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof AgentFSConfig)[]) {
    if (overrides[key] && typeof overrides[key] === "object" && !Array.isArray(overrides[key])) {
      result[key] = { ...defaults[key], ...overrides[key] } as any;
    } else if (overrides[key] !== undefined) {
      result[key] = overrides[key] as any;
    }
  }
  return result;
}
```

#### 3. Tests for env var overrides
**File**: `packages/core/src/config.test.ts`
**Changes**:

Add test cases:
- Env vars override config.json values (set `S3_ENDPOINT`, verify `config.s3.endpoint`)
- Tigris `AWS_*` vars take precedence over `S3_*` vars
- `SERVER_PORT` parsed as integer
- Env vars override defaults when no config.json exists
- Deep merge preserves nested defaults (e.g., partial `s3` in config.json + defaults for missing fields)

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] Config tests cover env var overrides: `bun test packages/core/src/config.test.ts`

#### Manual Verification:
- [x] Start server with S3 env vars, verify config is picked up: `S3_ENDPOINT=http://test:9000 S3_BUCKET=mybucket bun run packages/server/src/index.ts` (check startup log or config dump)
- [x] Verify Tigris `AWS_*` vars take precedence over `S3_*` vars
- [x] Verify `SERVER_PORT` env var changes the listening port

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Dockerfile + .dockerignore

### Overview
Add `.dockerignore` to speed up builds and avoid leaking secrets. Add OCI label to Dockerfile for GHCR linkage.

### Changes Required:

#### 1. Create .dockerignore
**File**: `.dockerignore` (new)
**Contents**:
```
node_modules
.git
.env
.env.*
!.env.example
!.env.production.example
*.md
!README.md
thoughts/
.claude/
.mcp.json
.wts-setup.ts
docker-compose*.yml
fly.toml
litefs.yml
scripts/
docs/
.github/
```

#### 2. Add OCI label to Dockerfile
**File**: `Dockerfile`
**Changes**: Add `LABEL org.opencontainers.image.source="https://github.com/desplega-ai/agent-fs"` in the runtime stage (before `EXPOSE`). This is required for GHCR to link the image to the repository.

### Success Criteria:

#### Automated Verification:
- [x] Docker build succeeds: `docker build -t agent-fs-test .`
- [x] OCI label present: `docker inspect agent-fs-test | grep opencontainers`
- [x] Sensitive files excluded: `docker build -t agent-fs-test . 2>&1 | grep -v ".env"` (context should be small)

#### Manual Verification:
- [x] `.dockerignore` excludes `thoughts/`, `.claude/`, `.env`, `.mcp.json`
- [x] Docker image still runs correctly: `docker run --rm -p 7433:7433 agent-fs-test` → `curl http://localhost:7433/health`

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: GHCR Docker Publish Workflow

### Overview
New GitHub Actions workflow that builds and pushes multi-arch Docker images to GHCR on `v*` tag pushes — triggered by the same tags as `npm-publish.yml`.

### Changes Required:

#### 1. New GHCR publish workflow
**File**: `.github/workflows/docker-publish.yml` (new)
**Changes**:

Create workflow with:
- **Trigger**: `push: tags: ["v*"]` (same as npm-publish.yml)
- **Permissions**: `contents: read`, `packages: write`, `id-token: write`
- **Steps**:
  1. `actions/checkout@v4`
  2. `docker/setup-qemu-action@v3` (for multi-arch)
  3. `docker/setup-buildx-action@v3`
  4. `docker/login-action@v3` with `registry: ghcr.io`, auth via `GITHUB_TOKEN`
  5. `docker/metadata-action@v5` — generates tags: `{{version}}`, `{{major}}.{{minor}}`, `{{major}}`, `sha`, `latest`
  6. `docker/build-push-action@v6` — context `.`, push `true`, platforms `linux/amd64,linux/arm64`, GHA cache

Full workflow content as specified in research doc section 9.

### Success Criteria:

#### Automated Verification:
- [x] Workflow YAML is valid: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker-publish.yml'))"`
- [x] Typecheck still passes: `bun run typecheck`

#### Manual Verification:
- [x] Review workflow file structure matches the pattern in `npm-publish.yml`
- [x] Verify tag patterns, permissions, and multi-arch platforms are correct
- [x] Confirm `GITHUB_TOKEN` is used (no additional secrets needed)

**Implementation Note**: This workflow can only be fully tested by pushing a tag. After merging, the next `release.sh` run will trigger both npm and Docker publishing.

---

## Phase 4: Fly.io Configuration Files

### Overview
Create `fly.toml`, `.env.production.example`, and `litefs.yml` (reference config). These are the static configuration files users need for Fly.io deployment.

### Changes Required:

#### 1. fly.toml
**File**: `fly.toml` (new)
**Changes**:

Create fly.toml with the configuration from research doc section 7:
- App name: `agent-fs` (users override with `fly launch`)
- Primary region: `ord`
- HTTP service on port 7433 with health check at `/health`
- Volume mount at `/data` (1GB initial, auto-extend at 80%)
- VM: `shared-cpu-1x`, 512mb
- `auto_stop_machines = "stop"`, `min_machines_running = 1`
- Commented-out `image = "ghcr.io/desplega-ai/agent-fs:latest"` alternative in `[build]`

#### 2. .env.production.example
**File**: `.env.production.example` (new)
**Changes**:

Document all env vars with placeholder values and comments explaining Tigris auto-injection vs BYOK manual setup. Content as specified in research doc section 10.

#### 3. litefs.yml (reference)
**File**: `litefs.yml` (new)
**Changes**:

Include the single-node static lease config from research doc section 8, with clear header comments explaining this is an optional upgrade path and not active by default. Include commented-out Consul multi-node config below.

### Success Criteria:

#### Automated Verification:
- [x] fly.toml syntax valid: `fly config validate` (if fly CLI installed, otherwise manual review)
- [x] All three files exist: `ls fly.toml .env.production.example litefs.yml`

#### Manual Verification:
- [x] `fly.toml` port matches server default (7433)
- [x] `.env.production.example` documents all env vars from Phase 1's mapping table
- [x] `litefs.yml` exec command matches Dockerfile CMD path
- [x] Volume mount path (`/data`) matches `AGENT_FS_HOME` env var in fly.toml

**Implementation Note**: `fly.toml` app name is a placeholder — users override it with `fly launch`. Pause for review before Phase 5.

---

## Phase 5: Interactive Deploy Script

### Overview
Create `scripts/fly-deploy.ts` — a Bun TypeScript script that automates Fly.io setup with interactive prompts and a `-y` autopilot flag.

### Changes Required:

#### 1. Deploy script
**File**: `scripts/fly-deploy.ts` (new)
**Changes**:

Interactive Bun script that:
1. Checks `fly` CLI is installed (`which fly`)
2. Checks user is authenticated (`fly auth whoami`)
3. Prompts for (or uses defaults with `-y`):
   - App name (default: `agent-fs`)
   - Region (default: `ord`)
   - Storage: Tigris (auto) vs BYOK (prompts for endpoint/bucket/keys)
   - Instance size: `shared-cpu-1x` / `shared-cpu-2x` / `performance-1x`
4. Executes in order:
   - `fly launch --name <app> --region <region> --no-deploy --copy-config`
   - `fly volumes create agent_fs_data --size 1 --region <region> -y`
   - `fly storage create` (Tigris) OR `fly secrets set S3_*=...` (BYOK)
   - `fly secrets set AUTH_SECRET=<generated>` (generate random secret for initial admin)
   - `fly deploy`
5. Prints success message with app URL and next steps (register API key)

Use `Bun.spawn` for fly CLI commands with stdout/stderr passthrough. Use `process.stdin` for interactive prompts (or a simple readline wrapper).

The script should handle errors gracefully — if any `fly` command fails, print the error and suggest manual steps.

### Success Criteria:

#### Automated Verification:
- [x] Script compiles: `bun build --target=bun scripts/fly-deploy.ts --outfile /dev/null`
- [x] Typecheck passes: `bun run typecheck`
- [x] Help flag works: `bun run scripts/fly-deploy.ts --help`

#### Manual Verification:
- [x] Script detects missing `fly` CLI gracefully
- [x] Script lists prompts correctly in interactive mode
- [x] `-y` flag skips all prompts and uses defaults
- [x] (Optional) Full deploy to Fly.io test app works end-to-end

**Implementation Note**: Full E2E testing requires a Fly.io account. Verify script structure and error handling locally. Pause for review before Phase 6.

---

## Phase 6: Documentation

### Overview
Update `DEPLOYMENT.md` with Fly.io and Docker deployment sections. Add Fly.io section to `README.md`. Update `.gitignore`.

### Changes Required:

#### 1. Update DEPLOYMENT.md
**File**: `DEPLOYMENT.md`
**Changes**:

Add new sections after the existing npm content:

- **Docker / GHCR** — How to pull and run the pre-built image, link to GHCR package page
- **Fly.io Deployment** — Quick start (manual `fly` commands), interactive script (`scripts/fly-deploy.ts`), Tigris vs BYOK storage options, instance sizing guide
- **Environment Variables Reference** — Complete table of all env vars with descriptions, defaults, and which are auto-injected by Tigris
- **LiteFS Upgrade Path** — Brief section pointing to `litefs.yml` for users who need replication

#### 2. Update .gitignore
**File**: `.gitignore`
**Changes**:

Add entries for Fly.io artifacts if not already present:
- `.fly/` (Fly CLI state directory)

#### 3. Update README.md (minimal)
**File**: `README.md`
**Changes**:

Add a "Deploy to Fly.io" section in the deployment/installation area with a 3-line quick start:
```bash
git clone https://github.com/desplega-ai/agent-fs && cd agent-fs
bun run scripts/fly-deploy.ts
```

### Success Criteria:

#### Automated Verification:
- [x] No broken links in docs: `grep -r 'http.*localhost' DEPLOYMENT.md` (should only reference localhost in examples)
- [x] Typecheck still passes: `bun run typecheck`

#### Manual Verification:
- [x] DEPLOYMENT.md env var table matches Phase 1's mapping table exactly
- [x] README.md deploy section is concise and accurate
- [x] `.gitignore` includes `.fly/`

**Implementation Note**: Final phase — review all documentation for consistency with the implemented changes.

---

## Testing Strategy

- **Unit tests**: Config env var overrides in `packages/core/src/config.test.ts` — test each env var mapping, precedence rules, deep merge
- **E2E tests**: Extend `scripts/e2e.ts` with env-var-only configuration test (start daemon with S3 env vars instead of config.json)
- **Docker tests**: Manual `docker build` + `docker run` + `curl /health` verification
- **CI validation**: Workflow YAML syntax check, review against existing workflow patterns
- **Deploy script**: Local `--help` + error handling tests, full E2E only with Fly.io account

## Manual E2E Verification

After all phases are complete, run these commands to verify the full deployment pipeline:

```bash
# 1. Verify env var config overrides work (no config.json needed)
TMPDIR=$(mktemp -d)
AGENT_FS_HOME=$TMPDIR \
  S3_ENDPOINT=http://localhost:9000 \
  S3_BUCKET=agentfs \
  S3_ACCESS_KEY_ID=minioadmin \
  S3_SECRET_ACCESS_KEY=minioadmin \
  SERVER_PORT=17433 \
  bun run packages/server/src/index.ts &
SERVER_PID=$!
sleep 2
curl -s http://localhost:17433/health | grep '"ok":true'
kill $SERVER_PID
rm -rf $TMPDIR

# 2. Docker build + run
docker build -t agent-fs-test .
docker inspect agent-fs-test | grep "org.opencontainers.image.source"
docker run --rm -d -p 7433:7433 --name agent-fs-e2e agent-fs-test
sleep 3
curl -s http://localhost:7433/health | grep '"ok":true'
docker stop agent-fs-e2e

# 3. fly.toml validation
fly config validate

# 4. Deploy script help
bun run scripts/fly-deploy.ts --help

# 5. GHCR workflow syntax
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker-publish.yml')); print('valid')"
```

## Deviations from Plan

Bugs found and fixed during E2E testing:

1. **fly.toml health check format** — Plan specified `[http_service.checks.health]` (named map), but Fly expects `[[http_service.checks]]` (array). Fixed.
2. **Dockerfile CMD `--host 0.0.0.0`** — CLI `server` command doesn't accept `--host` flag. Fixed by removing it and adding `SERVER_HOST=0.0.0.0` to fly.toml `[env]` section.
3. **Deploy script prompts** — `process.stdin.stream()` doesn't exist in Bun. Replaced with Bun's built-in `prompt()` function.
4. **Deploy script org selection** — Added `--org` flag and interactive org picker (fetches from `fly orgs list --json`).
5. **Deploy script Tigris bucket naming** — Added interactive prompt for bucket name to handle global uniqueness collisions.
6. **Default region** — Changed from `ord` (Chicago) to `ams` (Amsterdam) per Taras's preference.
7. **`fly launch` rewrites fly.toml** — Expected behavior; our `SERVER_HOST` env var survives the rewrite.

## E2E Verification Results (2026-03-17)

- Server with env var overrides: PASS
- Tigris AWS_* precedence over S3_*: PASS
- SERVER_PORT as integer: PASS
- Docker build: PASS
- Docker health check: PASS
- OCI label in image: PASS
- `fly config validate`: PASS
- Deploy script `--help`: PASS
- Deploy script error handling (missing fly CLI): PASS
- Full Fly.io deploy (`agent-fs-dev` on `desplega` org): PASS
- Health check on deployed app: PASS (`{"ok":true,"version":"0.2.0"}`)
- Auth registration on deployed app: PASS
- File write/read via CLI against deployed app: PASS
- GHCR workflow: UNTESTED (triggers on next `v*` tag push)

## References
- Research: `thoughts/taras/research/2026-03-17-flyio-deployment.md`
- Architecture review: `thoughts/taras/research/2026-03-15-architecture-review.md`
- npm distribution: `thoughts/taras/research/2026-03-16-npm-distribution-migration.md`
