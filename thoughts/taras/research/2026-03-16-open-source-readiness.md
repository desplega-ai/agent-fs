---
date: 2026-03-16T13:30:00Z
topic: "Open-Source Readiness Assessment"
researcher: "Claude (with Taras)"
goal: "Evaluate agent-fs readiness for public open-source release"
status: complete
---

# Open-Source Readiness Assessment

**Goal:** Evaluate agent-fs readiness for public open-source release, focusing on: local functionality, onboarding, remote S3/embeddings, deployment path, API documentation, and agent DX.

---

## Executive Summary

agent-fs is **functionally complete for a v0.1 open-source release** but has several gaps that would hurt adoption. The core is solid — 26 operations, versioning, RBAC, search, comments — but the developer experience around onboarding, documentation, and deployment needs work. The biggest blockers are: (1) no OpenAPI spec, (2) no docker-compose for easy local setup, (3) README doesn't clearly convey the "agentmail for files" value prop, and (4) no deployment guide for hosted/multi-agent scenarios.

### Readiness Scorecard

| Area | Score | Status |
|------|-------|--------|
| Core functionality | 9/10 | Solid — 26 ops, versioning, RBAC, search |
| Local "it works" | 7/10 | Works but MinIO docker setup is manual |
| Onboarding (new user) | 5/10 | Too many steps, unclear quickstart |
| Remote S3 + OpenAI | 5/10 | S3 works, embeddings broken in CLI/daemon |
| Deployment path | 3/10 | No guide, no docker-compose, no hosting docs |
| API documentation | 2/10 | No OpenAPI spec, no API reference |
| Agent DX (MCP) | 8/10 | Good tool descriptions, auto-bootstrap |
| Testing | 8/10 | 85+ automated tests, manual test checklist |
| CI/CD & Release | 9/10 | Multi-platform builds, npm publish, install script |

---

## 1. Local Functionality — Does It Work?

### What works well

- **CLI binary** builds and runs on macOS (arm64/x64) and Linux
- **26 file operations** all pass automated tests (write, cat, edit, append, ls, stat, rm, mv, cp, tail, log, diff, revert, recent, grep, fts, search, reindex, tree, glob, + 6 comment ops)
- **Embedded mode** — CLI auto-detects when no daemon is running and operates in-process (no server needed)
- **MCP server** — stdio mode works out of the box for Claude Code
- **Versioning** — full version history with S3 versioning support
- **FTS5 search** — fast tokenized keyword search
- **Semantic search** — works with OpenAI, Gemini, and local llama.cpp
- **RBAC** — viewer/editor/admin roles enforced at dispatcher level
- **Comments** — threaded annotations with line ranges

### What needs attention

- **MinIO dependency** — local mode requires Docker to run MinIO. No alternative for users without Docker.
  - `agent-fs init --local -y` starts a MinIO container, but if Docker isn't installed, the user is stuck
  - **Suggestion:** Consider a local filesystem backend for zero-dependency local usage (was discussed and parked in architecture review)

- **macOS SQLite issue** — requires Homebrew's SQLite for extension support (Apple's bundled SQLite lacks `loadExtension`). The build script handles this for compiled binaries, but developing from source requires `brew install sqlite`.
  - This is documented nowhere in README or CONTRIBUTING.md

- **Native extension complexity** — sqlite-vec requires `.dylib`/`.so` files alongside the binary. Build script handles it, but it's a fragile setup.

### Verdict: 7/10 — Works, but Docker dependency and SQLite quirks add friction

---

## 2. Onboarding — Is It Clear and Easy?

### Current onboarding flow

1. Install: `curl -fsSL ... | sh` or `bun add -g @desplega-ai/agent-fs`
2. Run: `agent-fs init --local -y` (requires Docker for MinIO)
3. Use: `agent-fs write /hello.md --content "Hello"`

### Problems

- **README doesn't sell the product** — it lists features but doesn't explain *why* you'd use it. The "agentmail for files" positioning isn't there. A developer landing on the repo has no idea this is meant for multi-agent file sharing.

- **No "zero to working" quickstart** — README has a "Quick Start" section but it's buried after feature lists. Should be front and center with a 3-command getting-started.

- **MCP setup undocumented for external users** — `.mcp.json` exists for local dev but there's no guide for "how to add agent-fs to your Claude Code / agent setup". This is the primary use case!

- **No docker-compose.yml** — users must rely on `agent-fs init --local` which spawns a Docker container imperatively. A `docker-compose.yml` would be clearer and more standard.

- **CONTRIBUTING.md missing prereqs** — doesn't mention Homebrew SQLite requirement on macOS, doesn't mention Docker for MinIO.

- **No examples directory** — no code examples showing how to use agent-fs from an agent, from a script, or via the API.

### Specific gaps

| What's missing | Impact | Priority |
|---|---|---|
| Clear "what is this" at top of README | First impression — people leave | P0 |
| 3-command quickstart | Onboarding friction | P0 |
| MCP integration guide | Primary use case undocumented | P0 |
| docker-compose.yml for local dev | Standard setup expectation | P1 |
| Homebrew SQLite note in CONTRIBUTING.md | Dev setup fails silently | P1 |
| Examples directory | No working code to copy | P2 |
| Video/gif demo | Shows value instantly | P2 |

### Verdict: 5/10 — Functional but confusing for newcomers

---

## 3. Remote S3 + OpenAI Embeddings

### Tested: 2026-03-16 against Cloudflare R2 + OpenAI

Actual E2E tests were run against Cloudflare R2 (S3-compatible) with `OPENAI_API_KEY` set.

**S3 Configuration:**
- Set via config file at `~/.agent-fs/config.json` under `s3.*` keys
- Tested with: Cloudflare R2 (`forcePathStyle: true`, region `auto`)

**OpenAI Embeddings:**
- Auto-detected from `OPENAI_API_KEY` env var (only in MCP mode — see bugs below)
- Model: `text-embedding-3-small` (768 dimensions)
- Also supports `GEMINI_API_KEY` for Google Gemini

### What works (verified against R2)

- **write** — files stored to R2 successfully, returns `{version, path, size}`
- **cat** — reads content back from R2 correctly
- **stat** — returns file metadata (size, author, version, dates)
- **ls** — lists directory entries from R2
- **tree** — recursive listing works
- **grep** — content search via FTS5 works (matches "SHA256" in auth doc)
- **fts** — full-text search works (finds "API keys" with snippet highlighting)
- **recent** — activity log returns all writes in order
- **rm** — deletes files from R2
- **comment-add/list** — comments stored and retrieved correctly
- S3 client is standard `@aws-sdk/client-s3` — compatible with any S3 provider
- `forcePathStyle: true` ensures MinIO/R2 compatibility

### Bugs found during testing

- **BUG: Embedding provider not initialized in CLI or daemon** — `OPENAI_API_KEY` env var is only detected in MCP mode (`packages/mcp/src/server.ts:24-42`). Both the CLI embedded mode (`packages/cli/src/embedded.ts:30-36`) and the HTTP server (`packages/server/src/routes/ops.ts:29-35`) build `OpContext` without `embeddingProvider`. Result: semantic search returns `"No embedding provider configured"` hint in CLI and daemon modes. **Only MCP mode supports embeddings.** This is a critical bug for the open-source launch.

- **BUG: CLI `edit` command broken** — `--old`/`--new` flags map to `{old, new}` params but core Zod schema expects `{old_string, new_string}`. No mapping exists in `packages/cli/src/commands/ops.ts` (only `expected-version` → `expectedVersion` is handled at line 80). Error: `"old_string" Required`.

- **Minor: `glob` returns empty** — `glob "*.md"` with no `--path` prefix returns `{matches: []}` even with 4 `.md` files in `/test/`. May need explicit path prefix to scope the search.

- **Minor: `reindex` returns 0** — `reindex --json` returns `{reindexed: 0, failed: 0, skipped: 0}` even with files at `embedding_status: "pending"`. Likely because reindex only picks up "failed" status, not "pending".

### What needs attention (from code review)

- **No remote S3 documentation** — README only mentions local MinIO. No guide for connecting to AWS S3, R2, etc.

- **No config validation** — if you misconfigure S3 (wrong endpoint, bad credentials), you get cryptic AWS SDK errors. No `agent-fs config validate` or health check for S3 connectivity.

- **No `agent-fs init` for remote** — the init wizard only supports `--local` (MinIO). No guided setup for remote S3.

- **Embedding failures are silent** — `stat` shows `embedding_status: failed` but there's no error message stored.

- **S3 versioning optional but important** — the system works without S3 versioning, but `revert` and `diff` degrade. This isn't clearly communicated.

- **No cost guidance** — OpenAI embeddings cost money. No documentation on expected costs per file or strategies to minimize API calls.

### Verdict: 5/10 — S3 works well, but embeddings broken in CLI/daemon (only MCP works)

---

## 4. Deployment Path (Multi-Agent Architecture)

### Current state

The server can run in two modes:
1. **Daemon mode** — `agent-fs daemon start` runs HTTP server on localhost
2. **Foreground** — `agent-fs server` runs in foreground

The HTTP API (Hono) supports:
- Bearer token auth (`af_*` API keys)
- Multi-org/multi-drive RBAC
- CORS (permissive — all origins)

### What's missing for production deployment

| Gap | Description | Priority |
|---|---|---|
| **No deployment guide** | Zero docs on how to deploy the server for multi-agent use | P0 |
| **No Dockerfile** | Can't containerize the server | P0 |
| **No docker-compose for hosted** | Need server + MinIO/S3 + optional embedding service | P0 |
| **No rate limiting** | API has no rate limits — open to abuse | P1 |
| **CORS too permissive** | Allows all origins — fine for local, bad for hosted | P1 |
| **No HTTPS/TLS** | Server is HTTP only — needs reverse proxy docs | P1 |
| **No health check endpoint docs** | `/health` exists but isn't documented | P2 |
| **No monitoring/observability** | No structured logging, no metrics, no tracing | P2 |
| **No backup/restore** | SQLite DB has no backup strategy documented | P2 |
| **No scaling guidance** | Single-instance SQLite — what are the limits? | P2 |

### Multi-agent architecture considerations

For the "agentmail for files" vision, users need to:
1. Deploy agent-fs server somewhere accessible
2. Give each agent its own API key
3. Share drives between agents for collaboration
4. Optionally isolate with separate orgs

**None of this is documented.** The identity model (users -> orgs -> drives) supports multi-tenancy, but there's no guide explaining how to use it.

### Specific deployment scenarios to document

1. **Single developer, local** — `agent-fs init --local` (exists, mostly works)
2. **Team, shared server** — deploy server + S3, invite members (no docs)
3. **Multi-agent, hosted** — deploy server, register agents as users, share drives (no docs)
4. **Production, managed** — deploy with monitoring, backups, TLS (no docs at all)

### Verdict: 3/10 — Technically capable but no guidance whatsoever

---

## 5. API Documentation

### Current state

**There is no OpenAPI spec.** No Swagger UI. No API reference. No Postman collection.

### What exists

- The operation registry has Zod schemas for all 26 operations
- Each op has a description string
- Error responses are well-structured with codes, messages, and suggestions
- The API follows a consistent pattern: `POST /orgs/{orgId}/ops` with `{op, ...params}`

### What's needed

| Item | Priority | Notes |
|---|---|---|
| **OpenAPI 3.1 spec** | P0 | Can be generated from Zod schemas + route definitions |
| **API reference page** | P0 | HTML docs from OpenAPI spec (Scalar, Redocly, etc.) |
| **Auth endpoint docs** | P0 | `POST /auth/register`, `GET /auth/me` |
| **Org/drive endpoint docs** | P1 | CRUD for orgs and drives |
| **Error catalog** | P1 | All error codes with descriptions and solutions |
| **Example requests/responses** | P1 | curl examples for each operation |
| **Postman/Bruno collection** | P2 | For easy API exploration |
| **SDK/client library** | P2 | TypeScript client for programmatic access (beyond CLI) |

### Auto-generation opportunity

The codebase already has:
- Zod schemas for every operation -> can convert to JSON Schema -> OpenAPI
- `getRegisteredOps()` and `getOpDefinition()` -> programmatic op listing
- Consistent error types with `toJSON()`

A script that generates an OpenAPI spec from the registry would be straightforward. Hono also has `@hono/zod-openapi` which could be integrated.

### Verdict: 2/10 — Zero API docs; the building blocks exist to generate them

---

## 6. Agent Developer Experience

### MCP Integration (Primary Interface)

**Strengths:**
- 26 tools auto-registered from core registry
- Rich descriptions on each tool (post-architecture-cleanup)
- Zod schemas provide parameter validation
- Auto-bootstrap creates local user (zero-config for agents)
- Embedding provider auto-detected from env vars
- JSON output for easy parsing

**Weaknesses:**
- No `init` or `health` MCP tools — agent can't check if system is ready
- No `whoami` MCP tool — agent can't check its identity/permissions
- Semantic search fails silently if no embedding provider configured
- No guidance on which search tool to use (grep vs fts vs search)

### CLI Integration (Secondary Interface)

**Strengths:**
- `--json` flag for machine-readable output
- stdin support for piping content
- Auto-detection of daemon vs embedded mode
- Pretty-print defaults for human readability

**Weaknesses:**
- Exit codes not documented
- Error output format not guaranteed (mix of JSON and plain text)

### HTTP API (Tertiary Interface)

**Strengths:**
- Single endpoint pattern (`POST /orgs/{orgId}/ops`) is simple
- Bearer token auth is standard
- RBAC is robust

**Weaknesses:**
- No OpenAPI spec for code generation
- No client SDK
- Single endpoint pattern is unconventional — harder to discover

### Verdict: 8/10 for MCP, 6/10 for CLI, 4/10 for HTTP API

---

## 7. Additional Open-Source Readiness Items

### What's good

- **MIT License** — permissive, standard
- **CONTRIBUTING.md** — exists (needs updates)
- **CI/CD** — GitHub Actions for CI + multi-platform release builds
- **npm publishing** — automated via release workflow
- **Install script** — curl one-liner works
- **Code quality** — TypeScript strict mode, Zod validation, comprehensive error types

### What's missing

| Item | Priority | Notes |
|---|---|---|
| **Issue templates** | P1 | Bug report, feature request |
| **PR template** | P1 | Checklist for contributors |
| **Code of conduct** | P1 | Standard for open-source projects |
| **Security policy** | P1 | `SECURITY.md` for vulnerability reporting |
| **Changelog** | P1 | `CHANGELOG.md` or use GitHub releases |
| **Logo/branding** | P2 | Visual identity for the project |
| **Website/landing page** | P2 | Beyond GitHub README |
| **Discord/community** | P2 | Support channel |

---

## 8. Recommended Action Plan

### Phase 1: Must-have before open-source (P0)

1. **Rewrite README** — lead with “agentmail for files” positioning, 3-command quickstart, architecture diagram
2. **Generate OpenAPI spec** — from existing Zod schemas + route definitions
3. **Add docker-compose.yml** — server + MinIO for local dev
4. **Write MCP integration guide** — how to add agent-fs to Claude Code / any MCP client
5. **Write deployment guide** — single server, multi-agent setup, env vars

### Phase 2: Should-have for adoption (P1)

6. **Replace `init` with `onboard` command** — unified setup wizard (see detailed flow below)
7. **Add `config validate`** — check S3 connectivity, embedding provider, config schema
8. **Fix `auth register`** — guard against re-registration when auth already configured
9. **Add user switching** — `agent-fs auth switch` for multiple locally registered users
10. **Tighten CORS** — configurable origins instead of wildcard
11. **Add rate limiting** — basic per-key rate limits
12. **Issue/PR templates + SECURITY.md + Code of conduct**
13. **Fix CONTRIBUTING.md** — add macOS SQLite prereq, Docker prereq
14. **Add health/whoami MCP tools**

#### `agent-fs onboard` — Detailed Flow

Replaces current `init`. Each step configurable via CLI flags, interactive if omitted.

```
0. Remote or local API?
   0.1. Remote API:
        0.1.1. Register → ask email + verification → receive API key
        0.1.2. Already registered → set existing API key
   0.2. Local (default):
        Auto-generate local user (email overridable)

1. Storage backend?
   1.1. Local → start MinIO docker container
   1.2. Remote S3 → ask for endpoint, bucket, credentials

2. Embedding provider?
   2.1. Local → download nomic model (~330MB)
   2.2. OpenAI → ask for OPENAI_API_KEY
   2.3. Gemini → ask for GEMINI_API_KEY
   2.4. None → skip (semantic search disabled)

3. Start daemon API? (y/n)
```

Requirements:
- All steps settable via flags (e.g. `--s3-endpoint`, `--openai-key`, `--no-daemon`)
- Clear help text with examples for each flag
- Config stored in `~/.agent-fs/config.json` — document the schema
- `config validate` verifies all configured services are reachable

---

## 9. Competitive Positioning Notes

For open-source launch messaging, position agent-fs as:

> **"agentmail for files"** — just as agentmail gives each agent an email inbox, agent-fs gives agents a shared, searchable filesystem they can read, write, and collaborate through.

**Key differentiators to highlight:**
- MCP-native (works with Claude Code, Cursor, etc. out of the box)
- Self-hostable (own your data, no vendor lock-in)
- Semantic search built-in (find files by meaning, not just keywords)
- Multi-tenant RBAC (share drives between agents with role-based permissions)
- Version history (every write is versioned, revert anytime)
- Comments/annotations (agents can leave feedback on files, like Google Docs)

**Avoid comparing to:**
- Traditional file storage (S3, GCS) — different category
- Knowledge bases (Notion, Confluence) — too broad
- Vector databases (Pinecone, Weaviate) — search is a feature, not the product

---

## 10. Bugs Found During E2E Testing

These must be fixed before open-source launch.

| Bug | Severity | Location | Description |
|-----|----------|----------|-------------|
| Embeddings broken in CLI/daemon | **Critical** | `cli/src/embedded.ts:30-36`, `server/src/routes/ops.ts:29-35` | `OpContext` built without `embeddingProvider`. Only MCP mode (`mcp/src/server.ts:24-42`) detects `OPENAI_API_KEY`/`GEMINI_API_KEY`. Semantic search returns "No embedding provider configured" in CLI and daemon. |
| CLI `edit` command broken | **Critical** | `cli/src/commands/ops.ts` | `--old`/`--new` flags produce `{old, new}` but core Zod schema expects `{old_string, new_string}`. No param mapping exists. |
| `glob` returns empty without path | Minor | `core/src/ops/glob.ts` | `glob "*.md"` returns `{matches: []}` even with `.md` files present. Needs `--path` prefix or default scope. |
| `reindex` skips pending files | Minor | `core/src/ops/reindex.ts` | Returns `{reindexed: 0}` for files at `embedding_status: "pending"`. May only pick up "failed" status. |
| Server binds to localhost only | Docs | `core/src/config.ts:50-53` | Default `127.0.0.1:7433` blocks external connections. Must document `0.0.0.0` for hosted deployments. |

---

## 11. Proposed Plan Structure

Based on all findings, here is the recommended structure for an implementation plan. Items are ordered by dependency and priority.

### Phase 0: Bug Fixes (blockers)

Fix before anything else — these break core functionality.

1. **Fix embedding provider initialization** — Extract the env-var detection from `mcp/src/server.ts` into a shared `createEmbeddingProviderFromEnv()` in core. Wire it into `cli/src/embedded.ts` and `server/src/routes/ops.ts`.
2. **Fix CLI `edit` param mapping** — Add `old` → `old_string`, `new` → `new_string` mapping in `cli/src/commands/ops.ts` (same pattern as `expected-version` → `expectedVersion`).
3. **Fix `glob` default scope** — Either default to drive root or document that `--path` is required.
4. **Fix `reindex` for pending files** — Include `embedding_status = "pending"` in the reindex query.

### Phase 1: Documentation & Onboarding (P0)

Minimum viable documentation for open-source launch.

5. **Rewrite README.md** — "agentmail for files" positioning, 3-command quickstart, architecture diagram, MCP snippet.
6. **Write MCP integration guide** — `docs/mcp-setup.md`: how to add agent-fs to Claude Code, Cursor, or any MCP client.
7. **Write deployment guide** — `docs/deployment.md`: local setup, remote S3, multi-agent architecture, env vars, bind address.
8. **Generate OpenAPI spec** — Script or `@hono/zod-openapi` integration. Serve at `/docs` or publish as `openapi.yaml`.
9. **Add docker-compose.yml** — `agent-fs-server` + MinIO for local dev. Separate compose for hosted (server + external S3).
10. **Fix CONTRIBUTING.md** — Add macOS Homebrew SQLite prereq, Docker prereq.

### Phase 2: Onboard Command & DX (P1)

Improve the setup experience and agent DX.

11. **Replace `init` with `onboard`** — Unified wizard: API mode (local/remote) → S3 backend → embedding provider → daemon. All steps flag-configurable.
12. **Add `config validate`** — Check S3 connectivity, embedding provider reachability, config schema validation.
13. **Fix `auth register`** — Guard against re-registration when already configured. Add `auth switch` for multiple local users.
14. **Add `health`/`whoami` MCP tools** — Let agents check system readiness and their own identity.
15. **Issue/PR templates + SECURITY.md + Code of conduct** — Standard OSS scaffolding.

### Phase 3: Production Hardening (P1)

For users deploying in shared/hosted environments.

16. **Configurable CORS** — Read allowed origins from config instead of wildcard `*`.
17. **Basic rate limiting** — Per-API-key rate limits (configurable).
18. **Dockerfile** — Multi-stage build for the server binary.

### Verification

Each phase should include:
- `bun run typecheck` passes
- `bun run test` passes (257+ tests)
- Manual E2E against local MinIO
- Manual E2E against remote R2 (using `.env` credentials)
- MCP tools verified in Claude Code
