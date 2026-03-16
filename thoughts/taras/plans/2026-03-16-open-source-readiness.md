---
date: 2026-03-16
topic: "Open-Source Readiness Implementation"
author: "Claude (with Taras)"
status: ready
research: "thoughts/taras/research/2026-03-16-open-source-readiness.md"
autonomy: critical
---

# Open-Source Readiness Implementation Plan

## Overview

Prepare agent-fs for public open-source release by fixing critical bugs, adding standard OSS scaffolding, rewriting documentation with clear "agentmail for files" positioning, improving onboarding with a guided `onboard` command, and hardening for production use. Based on the comprehensive readiness assessment in the research document.

## Current State Analysis

**What works well:**
- 26 file operations, all passing automated tests
- MCP server with 26 auto-registered tools, rich descriptions, Zod validation
- Multi-platform CI/CD builds (linux/darwin x64/arm64) + npm publish
- Dual-path CLI (daemon HTTP or direct SQLite fallback)
- RBAC with viewer/editor/admin roles
- Version history with S3 versioning support
- FTS5 + semantic search (OpenAI, Gemini, local llama.cpp)

**What's broken or missing:**
- 3 confirmed bugs (embedding init, CLI edit mapping, reindex query)
- No LICENSE file (README references MIT but file doesn't exist)
- README doesn't convey the product value prop or show MCP setup
- Zero API documentation (no OpenAPI spec)
- No Dockerfile, no docker-compose
- No deployment guide for hosted/multi-agent scenarios
- `init` command only handles local MinIO — no guided remote/embedding setup
- No CODE_OF_CONDUCT, SECURITY.md, issue/PR templates
- CONTRIBUTING.md missing macOS SQLite and Docker prereqs

### Key Discoveries:
- `createEmbeddingProvider()` exists only in `packages/mcp/src/server.ts:23-52` — absent from CLI (`packages/cli/src/embedded.ts:30-36`) and server (`packages/server/src/routes/ops.ts:29-35`)
- CLI edit `--old`/`--new` flags produce `{old, new}` but Zod schema expects `{old_string, new_string}` — only `expected-version` → `expectedVersion` mapping exists at `packages/cli/src/commands/ops.ts:79-83`
- `packages/core/src/ops/reindex.ts:26-29` queries only `failed` and `NULL` statuses, not `pending` despite comment saying so
- Glob `*.md` is not a bug — single-star regex `[^/]*` correctly doesn't match nested paths. Users need `**/*.md`. This is a docs/UX issue.
- LICENSE file is missing despite README badge linking to `./LICENSE`

## Desired End State

A repository that a developer landing on for the first time can:
1. Understand what agent-fs is in 10 seconds (README)
2. Get it running in 3 commands (quickstart)
3. Add it to Claude Code / any MCP client with a copy-paste config snippet
4. Deploy it for multi-agent use with a docker-compose
5. Browse a complete API reference (OpenAPI)
6. Set up local or remote S3 + embeddings via a guided `onboard` wizard
7. Trust that core operations work correctly (bugs fixed)
8. Contribute with clear prereqs and templates

### Verification of end state:
- `bun run typecheck` passes
- `bun run test` passes
- `agent-fs onboard --local -y` works end-to-end
- `agent-fs edit /test.md --old "foo" --new "bar"` works
- Semantic search works in CLI mode (not just MCP)
- `agent-fs config validate` reports healthy
- OpenAPI spec serves at `/docs` or exists as `openapi.yaml`
- `docker compose up` starts server + MinIO
- README has quickstart, MCP snippet, architecture diagram

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `agent-fs --help`

Key files to check:
- `packages/core/src/ops/reindex.ts` — reindex query fix
- `packages/core/src/embeddings/` — shared embedding provider factory
- `packages/cli/src/commands/ops.ts` — CLI param mapping
- `packages/cli/src/commands/init.ts` → `onboard.ts` — new onboard command
- `README.md` — rewritten
- `docs/` — new documentation directory

## What We're NOT Doing

- Website or landing page (P2)
- Logo or branding (P2)
- TypeScript client SDK (P2 — API is simple enough with curl/fetch)
- Video/GIF demos (P2)
- Discord bot integration
- Backup/restore tooling
- Scaling beyond single-instance SQLite
- Monitoring/observability (structured logging, metrics, tracing)
- User switching (`auth switch`) — deferred to post-launch

## Implementation Approach

Five phases, ordered by dependency and value:
1. **Bug fixes first** — unblock core functionality before anything else
2. **OSS scaffolding** — make the repo look like a real open-source project
3. **Documentation suite** — give developers the docs they need
4. **Infrastructure & onboarding** — smooth the setup experience
5. **Production hardening** — ready for hosted/multi-agent deployments

Each phase is independently shippable. Commit after each phase passes verification.

---

## Phase 0: Bug Fixes

### Overview
Fix the 3 confirmed bugs that break core functionality. These must land before any documentation or onboarding work, since the docs would describe broken behavior.

### Changes Required:

#### 1. Extract embedding provider factory to core
**File**: `packages/core/src/embeddings/provider-factory.ts` (new)
**Changes**: Extract the `createEmbeddingProvider()` function from `packages/mcp/src/server.ts:23-52` into a new shared module in core. The function checks `OPENAI_API_KEY` and `GEMINI_API_KEY` env vars, dynamically imports the appropriate provider, and returns an `EmbeddingProvider | null`.

**File**: `packages/mcp/src/server.ts`
**Changes**: Replace inline `createEmbeddingProvider()` with import from `@/core/embeddings/provider-factory`. Remove the function definition (lines 23-52). Update the `embeddingProvider` assignment at line 61.

**File**: `packages/cli/src/embedded.ts`
**Changes**: Import `createEmbeddingProviderFromEnv` from `@/core/embeddings/provider-factory`. Call it and add the result to the `OpContext` returned at lines 30-36.

**File**: `packages/server/src/routes/ops.ts`
**Changes**: Import `createEmbeddingProviderFromEnv` from `@/core/embeddings/provider-factory`. Initialize at server startup (or lazily on first op dispatch). Add `embeddingProvider` to the `ctx` object at lines 29-35.

#### 2. Fix CLI edit param mapping
**File**: `packages/cli/src/commands/ops.ts`
**Changes**: Add two param mappings after the existing `expected-version` → `expectedVersion` mapping at lines 79-83:
```typescript
if (params["old"] !== undefined) {
  params.old_string = params["old"];
  delete params["old"];
}
if (params["new"] !== undefined) {
  params.new_string = params["new"];
  delete params["new"];
}
```

#### 3. Fix reindex to include pending files
**File**: `packages/core/src/ops/reindex.ts`
**Changes**: Add `eq(schema.files.embeddingStatus, "pending")` to the `or()` clause at lines 26-29, so the query becomes:
```typescript
or(
  eq(schema.files.embeddingStatus, "failed"),
  isNull(schema.files.embeddingStatus),
  eq(schema.files.embeddingStatus, "pending"),
),
```

#### 4. Improve glob help text
**File**: `packages/core/src/ops/glob.ts`
**Changes**: Update the operation description to clarify pattern behavior: `*.md` matches root-level files only, `**/*.md` matches recursively. This is a Zod schema description update, not a code change.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run typecheck`
- [ ] All tests pass: `bun run test`
- [ ] Build succeeds: `bun run build`

#### Manual Verification:
- [ ] `agent-fs edit /test.md --old "hello" --new "world"` works (after writing a test file)
- [ ] `OPENAI_API_KEY=sk-... agent-fs search "test query"` returns results (not "No embedding provider configured")
- [ ] `agent-fs reindex --json` picks up files with `pending` embedding status
- [ ] `agent-fs glob "**/*.md"` returns nested markdown files
- [ ] `agent-fs glob "*.md"` returns only root-level markdown files

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 1: OSS Foundation

### Overview
Add the standard open-source project scaffolding and rewrite the README to clearly communicate what agent-fs is, why you'd use it, and how to get started. This phase transforms the repo from "internal project" to "open-source project".

### Changes Required:

#### 1. Add LICENSE file
**File**: `LICENSE` (new)
**Changes**: Standard MIT license text with "2025-2026 desplega.ai" copyright. The README already references `./LICENSE` but the file doesn't exist.

#### 2. Add CODE_OF_CONDUCT.md
**File**: `CODE_OF_CONDUCT.md` (new)
**Changes**: Contributor Covenant v2.1 (standard for OSS projects).

#### 3. Add SECURITY.md
**File**: `SECURITY.md` (new)
**Changes**: Security vulnerability reporting policy. Include email (security@desplega.ai or similar), expected response time, and scope (what counts as a vulnerability).

#### 4. Add CHANGELOG.md
**File**: `CHANGELOG.md` (new)
**Changes**: Initialize with current version. Use Keep a Changelog format. Include a brief entry for v0.1.0 covering the initial public release.

#### 5. Add GitHub issue templates
**File**: `.github/ISSUE_TEMPLATE/bug_report.md` (new)
**Changes**: Bug report template with sections: description, steps to reproduce, expected behavior, actual behavior, environment (OS, Bun version, agent-fs version), logs.

**File**: `.github/ISSUE_TEMPLATE/feature_request.md` (new)
**Changes**: Feature request template with sections: problem description, proposed solution, alternatives considered, additional context.

#### 6. Add PR template
**File**: `.github/PULL_REQUEST_TEMPLATE.md` (new)
**Changes**: PR template with sections: summary, type of change (bug fix/feature/docs/refactor), testing done, checklist (typecheck, tests, docs updated).

#### 7. Update CONTRIBUTING.md
**File**: `CONTRIBUTING.md`
**Changes**:
- Add **macOS prerequisite**: Homebrew SQLite (`brew install sqlite`) required for extension support (Apple's bundled SQLite lacks `loadExtension`)
- Add **Docker prerequisite**: Required for local development (MinIO container)
- Add **Environment setup** section: copy `.env.example` to `.env`, configure API keys
- Add link to CODE_OF_CONDUCT.md
- Add link to SECURITY.md

#### 8. Rewrite README.md
**File**: `README.md`
**Changes**: Complete rewrite with this structure:

1. **Hero section**: "agentmail for files" — one-sentence description making it immediately clear this is a shared filesystem for AI agents
2. **3-command quickstart**: install → init → use (with both CLI and MCP examples)
3. **MCP setup snippet**: Copy-paste JSON config for Claude Code / Cursor
4. **Why agent-fs**: 3-4 bullet points from PRODUCT.md (shared storage, semantic search, comments, self-hostable)
5. **Architecture overview**: Diagram showing CLI / MCP / HTTP → core → SQLite + S3
6. **Feature table**: All 26 operations grouped by category
7. **Development** section (condensed)
8. **Contributing** link
9. **License**

Key messaging from PRODUCT.md to incorporate:
- "agent-fs is to files what agentmail is to email"
- Agent-first API, MCP-native, self-hostable, semantic search
- Target users: agent developers, platform teams, individual developers

### Success Criteria:

#### Automated Verification:
- [ ] LICENSE file exists: `test -f LICENSE`
- [ ] CODE_OF_CONDUCT exists: `test -f CODE_OF_CONDUCT.md`
- [ ] SECURITY.md exists: `test -f SECURITY.md`
- [ ] CHANGELOG.md exists: `test -f CHANGELOG.md`
- [ ] Issue templates exist: `ls .github/ISSUE_TEMPLATE/`
- [ ] PR template exists: `test -f .github/PULL_REQUEST_TEMPLATE.md`
- [ ] README has quickstart: `grep -q "Quick Start" README.md`
- [ ] README has MCP config: `grep -q "mcp" README.md`
- [ ] TypeScript still compiles: `bun run typecheck`
- [ ] Tests still pass: `bun run test`

#### Manual Verification:
- [ ] README reads well — a developer landing on the repo understands what agent-fs is within 10 seconds
- [ ] MCP config snippet in README is correct and copy-pasteable
- [ ] CONTRIBUTING.md prereqs are accurate (try a fresh `bun install` on macOS)
- [ ] LICENSE badge in README resolves to the actual file
- [ ] Issue templates render correctly on GitHub (check after push)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Documentation Suite

### Overview
Create the documentation developers need to actually use agent-fs: MCP integration guide, deployment guide, and OpenAPI spec. These go in a new `docs/` directory.

### Changes Required:

#### 1. Create docs directory structure
**Files**: `docs/` directory with:
- `docs/mcp-setup.md` — MCP integration guide
- `docs/deployment.md` — Deployment guide
- `docs/api-reference.md` — API reference (generated from OpenAPI or manual)

#### 2. Write MCP integration guide
**File**: `docs/mcp-setup.md` (new)
**Changes**: Complete guide covering:

- **Claude Code setup**: JSON config for `.mcp.json` with `agent-fs mcp` command, env vars for embedding API keys
- **Cursor setup**: equivalent config for Cursor's MCP integration
- **Generic MCP client**: stdio transport configuration
- **Available tools**: Table of all 26 MCP tools with brief descriptions (can be generated from the op registry)
- **Search tool guidance**: When to use `grep` (keyword) vs `fts` (full-text) vs `search` (semantic) — this was identified as a gap in agent DX
- **Environment variables**: `OPENAI_API_KEY`, `GEMINI_API_KEY` for embeddings, `AGENT_FS_API_URL`/`AGENT_FS_API_KEY` for remote server

#### 3. Write deployment guide
**File**: `docs/deployment.md` (new)
**Changes**: Guide covering 4 deployment scenarios:

1. **Single developer, local**: `agent-fs init --local` (existing flow, documented properly)
2. **Single developer, remote S3**: Configure R2/AWS S3 in `config.json`, run daemon
3. **Team, shared server**: Deploy server + S3, register users, share drives
4. **Multi-agent, hosted**: Deploy server, register agents as users, assign API keys, share drives via RBAC

Each scenario includes:
- Prerequisites
- Step-by-step setup commands
- Config file examples
- Environment variables reference
- Common troubleshooting

Additional sections:
- **Bind address**: Document that default `127.0.0.1:7433` blocks external connections, use `0.0.0.0` for hosted
- **S3 providers**: Tested configurations for MinIO, Cloudflare R2, AWS S3 (with `forcePathStyle` notes)
- **Embedding providers**: Cost guidance for OpenAI, setup for Gemini, local llama.cpp instructions
- **S3 versioning**: Explain that `revert` and `diff` degrade without S3 versioning enabled

#### 4. Generate OpenAPI spec (dynamic endpoint + synced static file)
**File**: `packages/core/src/openapi.ts` (new) — spec generator module
**File**: `packages/server/src/routes/docs.ts` (new) — serves spec dynamically
**File**: `docs/openapi.yaml` (new) — committed static copy for offline use / GitHub browsing

**Approach — two-layer strategy:**

**Layer 1: Dynamic generation at runtime.** Write a `generateOpenAPISpec()` function in core that:
1. Imports `getRegisteredOps()` from the core op registry
2. Converts each op's Zod schema to JSON Schema via `zod-to-json-schema`
3. Builds an OpenAPI 3.1 document with:
   - `POST /orgs/{orgId}/ops` endpoint (the single dispatch endpoint)
   - `POST /auth/register` endpoint
   - `GET /auth/me` endpoint
   - `GET /health` endpoint
   - Per-operation request/response schemas (using `oneOf` or documented as individual ops in the spec)
4. Returns the spec as a JS object

**Layer 2: Serve dynamically + sync statically.**
- Add `GET /docs/openapi.json` route in the server that calls `generateOpenAPISpec()` and returns the result. This is always up-to-date with the running code.
- Add a `scripts/sync-openapi.sh` script that runs the generator and writes `docs/openapi.yaml`. This keeps the committed copy in sync.
- Add a CI check (in `.github/workflows/ci.yml`) that runs the sync script and fails if the output differs from the committed `docs/openapi.yaml` — catches staleness on every PR.

**Why both?** The dynamic endpoint ensures the spec is always accurate for running servers. The static file ensures GitHub browsers and offline users can read the spec without running the server. The CI check prevents them from drifting apart.

#### 5. Update README with docs links
**File**: `README.md`
**Changes**: Add a "Documentation" section linking to `docs/mcp-setup.md`, `docs/deployment.md`, and the API reference.

### Success Criteria:

#### Automated Verification:
- [ ] Docs directory exists: `ls docs/`
- [ ] MCP guide exists: `test -f docs/mcp-setup.md`
- [ ] Deployment guide exists: `test -f docs/deployment.md`
- [ ] OpenAPI spec exists: `test -f docs/openapi.yaml`
- [ ] OpenAPI spec is valid YAML: `bun -e "import yaml from 'yaml'; yaml.parse(require('fs').readFileSync('docs/openapi.yaml','utf8'))"`
- [ ] README links to docs: `grep -q "docs/" README.md`
- [ ] TypeScript compiles: `bun run typecheck`
- [ ] Tests pass: `bun run test`

#### Manual Verification:
- [ ] MCP guide: follow the Claude Code setup instructions from scratch — does it work?
- [ ] Deployment guide: follow the "single developer, local" scenario — does it match reality?
- [ ] OpenAPI spec: import into Swagger Editor or Scalar — does it render correctly?
- [ ] Search tool guidance in MCP guide is clear — a developer knows which search tool to use

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Infrastructure & Onboarding

### Overview
Add Docker infrastructure for easy local/hosted setup and replace the `init` command with a comprehensive `onboard` wizard that handles API mode, S3 backend, embedding provider, and daemon startup.

### Changes Required:

#### 1. Add Dockerfile
**File**: `Dockerfile` (new)
**Changes**: Multi-stage build:
- Stage 1: `oven/bun:1` — install deps, run `bun run build`
- Stage 2: Minimal runtime with the compiled binary + sqlite-vec native extensions
- Expose port 7433
- CMD: `["./agent-fs", "server"]`
- Health check: `HEALTHCHECK CMD curl -f http://localhost:7433/health || exit 1`

#### 2. Add docker-compose.yml for local development
**File**: `docker-compose.yml` (new)
**Changes**: Two services:
```yaml
services:
  minio:
    image: minio/minio
    ports: ["9000:9000", "9001:9001"]
    volumes: ["minio-data:/data"]
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"

  agent-fs:
    build: .
    ports: ["7433:7433"]
    depends_on: [minio]
    environment:
      AGENT_FS_HOME: /data
    volumes: ["agent-fs-data:/data"]
    # S3 config via env or config.json mount

volumes:
  minio-data:
  agent-fs-data:
```

Add a `docker-compose.hosted.yml` variant that uses external S3 instead of MinIO.

#### 3. Replace `init` with `onboard` command
**File**: `packages/cli/src/commands/onboard.ts` (new)
**File**: `packages/cli/src/commands/init.ts` (modify — keep as alias)
**File**: `packages/cli/src/index.ts` (modify — register onboard command)

**Onboard wizard flow** (interactive if no flags, fully automatable via flags):

```
Step 0: API mode
  --remote <url>  → Register or connect to remote API (WIP — stub with clear error for now)
  --local         → Local mode (default)

Step 1: Storage backend
  --s3-endpoint, --s3-bucket, --s3-access-key, --s3-secret-key, --s3-region
  → If --local and no S3 flags: start MinIO Docker container (existing logic)
  → If S3 flags provided: configure remote S3

Step 2: Embedding provider
  --embeddings=openai|gemini|local|none
  --openai-key, --gemini-key
  → openai: prompt for OPENAI_API_KEY, save to config
  → gemini: prompt for GEMINI_API_KEY, save to config
  → local: configure local llama.cpp (if available)
  → none: skip (semantic search disabled)

Step 3: Start daemon?
  --no-daemon     → Skip
  → Default: offer to start daemon
```

**Idempotency / re-run behavior**: Running `onboard` when config already exists must:
1. Detect existing `~/.agent-fs/config.json` and print current settings
2. Ask "Keep current settings or reconfigure?" for each step (interactive mode)
3. In non-interactive mode (`-y`), keep existing values unless explicitly overridden by flags
4. Never silently overwrite — always confirm or require explicit flag

**Remote mode scope**: The `--remote <url>` path is **WIP for this plan**. Implement the flag parsing and a clear "remote mode is not yet supported, use `agent-fs config set` manually" message. Full remote onboarding is deferred to a future iteration.

**Config storage**: All settings go to `~/.agent-fs/config.json`. The embedding config uses the new `embedding` section in the default config (already exists at `config.ts:36-61`).

**`init` becomes alias**: Keep `agent-fs init` as an alias to `agent-fs onboard` for backwards compatibility. Add deprecation notice suggesting `onboard`.

#### 4. Add `config validate` command
**File**: `packages/cli/src/commands/config-cmd.ts` (modify)
**Changes**: Add a `config validate` subcommand that checks:
- S3 connectivity: attempt `ListBuckets` or `HeadBucket` on the configured bucket
- Embedding provider: if configured, attempt a test embedding call
- Config schema: validate all required fields are present and non-empty
- Database: check that SQLite file exists and is readable
- Report results as pass/fail with actionable error messages

#### 5. Update core config for embedding settings
**File**: `packages/core/src/config.ts`
**Changes**: The default config already has an `embedding` section. Ensure `createEmbeddingProviderFromEnv()` (from Phase 0) also checks `config.embedding` settings, not just env vars. Priority: env var > config file > none.

### Success Criteria:

#### Automated Verification:
- [ ] Docker builds: `docker build -t agent-fs .`
- [ ] Compose starts: `docker compose up -d && sleep 5 && curl http://localhost:7433/health && docker compose down`
- [ ] Onboard command registered: `agent-fs onboard --help`
- [ ] Init still works as alias: `agent-fs init --help`
- [ ] Config validate registered: `agent-fs config validate --help`
- [ ] TypeScript compiles: `bun run typecheck`
- [ ] Tests pass: `bun run test`
- [ ] Build succeeds: `bun run build`

#### Manual Verification:
- [ ] `agent-fs onboard --local -y` works end-to-end (starts MinIO, creates DB, registers user, prints API key)
- [ ] `agent-fs onboard --local --embeddings=none -y` works without embedding API keys
- [ ] `agent-fs onboard --local --embeddings=openai --openai-key=sk-test -y` saves the key to config
- [ ] `agent-fs config validate` reports healthy after a successful onboard
- [ ] `agent-fs config validate` reports specific errors for misconfigured S3 (e.g., wrong endpoint)
- [ ] `docker compose up -d` starts server + MinIO, `curl localhost:7433/health` returns OK
- [ ] `agent-fs init --local -y` still works (alias) and shows deprecation notice

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Production Hardening & Agent DX

### Overview
Harden the HTTP server for hosted/multi-agent deployments and add MCP tools that let agents check system health and their own identity.

### Changes Required:

#### 1. Configurable CORS
**File**: `packages/core/src/config.ts`
**Changes**: Add `server.cors.origins` to the config schema. Default: `["*"]` for local, document that hosted deployments should restrict this.

**File**: `packages/server/src/app.ts`
**Changes**: Read `config.server.cors.origins` and pass to the Hono CORS middleware instead of the current wildcard. If the array contains `"*"`, use wildcard (backwards compatible).

#### 2. Basic rate limiting
**File**: `packages/server/src/middleware/rate-limit.ts` (new)
**Changes**: Simple in-memory rate limiter:
- Per-API-key rate limiting
- Configurable via `config.server.rateLimit.requestsPerMinute` (default: 60)
- Returns `429 Too Many Requests` with `Retry-After` header
- Use a Map with sliding window or token bucket

**File**: `packages/server/src/app.ts`
**Changes**: Add rate limit middleware after auth middleware. Skip for `/health` endpoint.

**File**: `packages/core/src/config.ts`
**Changes**: Add `server.rateLimit.requestsPerMinute` to config schema with default 60.

#### 3. Add `health` MCP tool
**File**: `packages/mcp/src/server.ts`
**Changes**: Register a `health` MCP tool that returns:
- Database status (can connect, file count, version count)
- S3 status (can reach endpoint, bucket exists)
- Embedding provider status (configured or not, provider name)
- Server version
- Config summary (which features are enabled)

This lets agents check if the system is ready before attempting file operations.

#### 4. Add `whoami` MCP tool
**File**: `packages/mcp/src/server.ts`
**Changes**: Register a `whoami` MCP tool that returns:
- Current user email and ID
- Org memberships with roles
- Drive memberships with roles
- Current active org/drive context

This lets agents check their identity and permissions.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run typecheck`
- [ ] Tests pass: `bun run test`
- [ ] Build succeeds: `bun run build`
- [ ] Rate limit config exists in defaults: `grep -q "rateLimit" packages/core/src/config.ts`
- [ ] CORS config exists in defaults: `grep -q "cors" packages/core/src/config.ts`

#### Manual Verification:
- [ ] CORS: Set `server.cors.origins` to `["http://localhost:3000"]` in config, verify that requests from other origins are blocked
- [ ] Rate limiting: Send 61+ requests in under a minute, verify 429 response with `Retry-After` header
- [ ] Health MCP tool: In Claude Code with agent-fs MCP, call the health tool — verify it returns DB/S3/embedding status
- [ ] Whoami MCP tool: In Claude Code with agent-fs MCP, call whoami — verify it returns user info and permissions
- [ ] Backwards compatibility: Existing MCP configs (without health/whoami) still work

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Manual E2E Verification (Final)

After all phases are complete, run through these end-to-end scenarios:

### Scenario 1: Fresh install, local setup
```bash
# Clean slate
rm -rf ~/.agent-fs

# Install
bun run build

# Onboard
./dist/agent-fs onboard --local -y

# Basic operations
./dist/agent-fs write /hello.md --content "# Hello World"
./dist/agent-fs cat /hello.md
./dist/agent-fs edit /hello.md --old "Hello World" --new "Hello Agent"
./dist/agent-fs cat /hello.md  # should show "Hello Agent"
./dist/agent-fs ls /
./dist/agent-fs stat /hello.md
./dist/agent-fs glob "**/*.md"

# Config validate
./dist/agent-fs config validate
```

### Scenario 2: MCP integration (automated)

Add an MCP integration test that programmatically spawns the MCP server as a child process (stdio transport), sends JSON-RPC requests, and asserts responses. This replaces manual Claude Code testing for CI.

**File**: `packages/mcp/test/mcp-integration.test.ts` (new)
**Approach**: Use `Bun.spawn` to start `agent-fs mcp` as a subprocess with stdio pipes. Send MCP protocol messages (JSON-RPC over stdin) and parse responses from stdout. Test:
- `tools/list` — verify all 26+ tools are registered (including `health` and `whoami` from Phase 4)
- `tools/call` with `write` — write a file and verify success response
- `tools/call` with `cat` — read back the written file
- `tools/call` with `edit` — edit the file and verify
- `tools/call` with `search` — verify search returns results (with embedding provider mocked or using local)
- `tools/call` with `health` — verify system status response
- `tools/call` with `whoami` — verify user identity response

**Test setup**: Each test uses a temporary `AGENT_FS_HOME` directory with a fresh SQLite DB and local MinIO (or mock S3). Cleaned up after test.

```bash
# Run MCP integration tests
bun test packages/mcp/test/mcp-integration.test.ts
```

### Scenario 3: Docker deployment
```bash
docker compose up -d
sleep 5
curl http://localhost:7433/health
# Register a user
curl -X POST http://localhost:7433/auth/register -H "Content-Type: application/json" -d '{"email": "test@example.com"}'
# Use the returned API key for subsequent requests
docker compose down
```

### Scenario 4: Remote S3 (if R2/AWS credentials available)
```bash
./dist/agent-fs onboard --s3-endpoint=https://xxx.r2.cloudflarestorage.com --s3-bucket=agentfs --s3-access-key=xxx --s3-secret-key=xxx --s3-region=auto --embeddings=openai --openai-key=sk-xxx -y
./dist/agent-fs write /remote-test.md --content "Testing remote S3"
./dist/agent-fs cat /remote-test.md
./dist/agent-fs search "remote S3"
```

---

## Testing Strategy

**Baseline rule**: The total test count after each phase MUST be strictly higher than before. Record the count before starting (`bun run test 2>&1 | grep -E "pass|tests"`) and verify it increased after each phase.

- **Existing tests**: 85+ automated tests cover core operations. These must continue to pass throughout all phases.
- **New tests for Phase 0** (minimum +3):
  - Unit test for `createEmbeddingProviderFromEnv()` — returns provider when env var set, null when not
  - Unit test for CLI edit param mapping — `{old, new}` → `{old_string, new_string}`
  - Unit test for reindex with pending status — files with `embedding_status: "pending"` are picked up
- **New tests for Phase 2** (minimum +1):
  - CI check for OpenAPI staleness — `scripts/sync-openapi.sh` output matches committed `docs/openapi.yaml`
- **New tests for Phase 3** (minimum +3):
  - Onboard command flag parsing tests — verify flags map to correct config values
  - Onboard idempotency test — running twice doesn't corrupt config
  - Config validate tests — reports pass for valid config, specific errors for invalid
- **New tests for Phase 4** (minimum +4):
  - Rate limiting middleware — returns 429 after exceeding limit
  - CORS configuration — respects configured origins
  - MCP integration tests (see Scenario 2 above) — at least 2 tests covering tool listing and basic ops via stdio
- **Manual testing**: Each phase has manual verification steps. The final E2E scenarios above cover the full user journey.

**Enforcement**: Each phase's Success Criteria includes a test count check: `bun run test 2>&1 | tail -1` must show a higher number than the previous phase.

## References

- Research document: `thoughts/taras/research/2026-03-16-open-source-readiness.md`
- Product vision: `PRODUCT.md`
- Existing deployment docs: `DEPLOYMENT.md`
- Architecture cleanup plan: `thoughts/taras/plans/2026-03-16-architecture-cleanup.md`
- v1 plan: `thoughts/taras/plans/2026-03-15-agent-fs-v1.md`
