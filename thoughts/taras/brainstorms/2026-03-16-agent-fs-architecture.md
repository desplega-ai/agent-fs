---
date: 2026-03-16T00:00:00-05:00
author: Taras & Claude
topic: "Understanding agent-fs architecture — user perspective and internals"
tags: [brainstorm, architecture, agent-fs, components, mcp, daemon]
status: complete
exploration_type: workflow
last_updated: 2026-03-16
last_updated_by: Claude
---

# Understanding agent-fs Architecture — Brainstorm

## Context

Taras wants to build a deep understanding of how agent-fs works, both from a user's perspective and internally. The monorepo has four packages: `core`, `cli`, `mcp`, and `server`. Key areas to explore:

- What each component does and its dependencies on other components
- MCP embedded vs not embedded mode — what's the difference and when to use each
- What the daemon does and why it exists
- How files are stored and accessed (SQLite? MinIO? S3?)
- The full request flow from user action to storage

This is an exploration/understanding session, not a problem-solving one. The goal is to have a clear mental model of the system.

## Exploration

### Q: Why do two modes exist and what does this mean for distribution?

Currently agent-fs has two runtime modes:

1. **MCP (embedded)** — `agent-fs mcp` spawns a process that directly accesses SQLite + S3 via core. No HTTP. Used by Claude Code via stdio.
2. **CLI → Daemon (HTTP)** — CLI commands talk to a background Hono HTTP server via `ApiClient`.

The MCP server is always "embedded" — it creates its own DB and S3 client directly. The HTTP daemon exists for CLI commands but MCP never uses it.

**Taras's insight:** If we want to distribute/host the MCP server, it would need to either:
- **Path A:** Become a thin client that wraps the HTTP API (MCP → HTTP → core)
- **Path B:** Live inside the HTTP server itself (serve MCP over SSE/streamable-http transport)

**Implications:**
- Currently there's no shared path between MCP and HTTP — they're parallel stacks that both depend on core
- The CLI already proves the HTTP API works for all operations
- MCP bypasses it entirely, which is fine for local but blocks hosted/multi-user

### Q: Which distribution scenario are we solving for?

**Answer:** All of them — it's a maturity progression:
1. Local single-agent (works today)
2. Local + remote S3 (partially — S3 configurable but SQLite is local)
3. Self-hosted shared (partially — HTTP server exists, identity has orgs/drives)
4. Hosted multi-tenant (not yet — MCP hardcoded to local core)

**Key bottleneck:** The MCP server directly instantiates core (DB + S3). There's no abstraction where MCP tools could target either local core or a remote HTTP API. The CLI's `ApiClient` already solves this for CLI commands but MCP doesn't use it.

## Synthesis

### Q: How does the storage layer work?

**Dual-storage model:**
- **SQLite (local file)** — All metadata: file records, versions, identity (users/orgs/drives/roles), comments, events, and both search indexes (FTS5 keyword + sqlite-vec vector)
- **S3 (MinIO or any S3-compatible)** — Actual file content as blobs, with optional S3 versioning

**Search is two-layered:**
1. FTS5 — keyword search with snippets and ranking
2. sqlite-vec — semantic vector search using 768-dim embeddings (OpenAI, Gemini, or local llama.cpp via `node-llama-cpp`)

**Key architectural observation:** SQLite holds ALL state except blob content. This is why "local + remote S3" only partially solves sharing — the S3 blobs can be remote, but metadata/identity/search indexes are locked to the local SQLite file.

### Q: How does the identity model work?

**Three-level hierarchy: User → Org → Drive**

- **Users:** email + API key (hashed). Local mode auto-creates `local@agent-fs.local` via `ensureLocalUser()`.
- **Orgs:** grouping container. Each user gets a personal org (`isPersonal=true`). Teams share non-personal orgs.
- **Drives:** the actual file namespace. Files scoped to `(path, driveId)`. Each org has a default drive.

**RBAC:** viewer < editor < admin, assigned per-drive. Every op has a minimum role.

**Context resolution cascade:** explicit driveId → explicit orgId's default drive → user's personal org's default drive.

**Observation:** The multi-tenant model (users, orgs, drives, RBAC) is fully built in the schema and enforced by RBAC. But it's all stored in local SQLite, so multiple machines can't share identity state without a central server.

### Q: How does the ops system work and why is it the natural seam?

**The ops registry** (`packages/core/src/ops/index.ts`) is a map of `{ name → { description, handler, zodSchema } }`. There are ~22 ops: write, cat, edit, append, ls, stat, rm, mv, cp, tail, log, diff, revert, recent, grep, fts, search, reindex, tree, glob, plus 6 comment ops.

**`dispatchOp(ctx, opName, params)`** is the single entry point:
1. Lookup op in registry
2. RBAC check (`checkPermission`)
3. Zod validation
4. Call handler with `OpContext` (db, s3, orgId, driveId, userId, embeddingProvider)

**Both MCP and HTTP route through `dispatchOp`:**
- MCP: auto-registers all ops as tools via `getRegisteredOps()` loop — zero manual mapping
- HTTP: `POST /orgs/:orgId/ops` dispatches `{ op, ...params }`

**Key observation:** The ops system is already the right abstraction boundary. The only difference between MCP and HTTP is how `OpContext` is constructed (direct DB/S3 vs server-managed). To support MCP-over-HTTP, you'd replace `dispatchOp()` calls in MCP tools with HTTP API calls — the API already supports every op.

### Q: What does the architecture look like at each deployment level?

#### Level 1: Local Single User (works today)

```
┌─────────────────────────────────────────────────────────┐
│                     Your Machine                         │
│                                                          │
│  ┌──────────────┐    stdio     ┌──────────────────────┐ │
│  │  Claude Code  │────────────→│  agent-fs mcp        │ │
│  │  (MCP client) │←────────────│  (embedded mode)     │ │
│  └──────────────┘              │                      │ │
│                                │  ┌────────────────┐  │ │
│  ┌──────────────┐    HTTP      │  │   core          │  │ │
│  │  agent-fs CLI │────────┐    │  │  ┌──────────┐  │  │ │
│  └──────────────┘         │    │  │  │ dispatchOp│  │  │ │
│                           │    │  │  └─────┬─────┘  │  │ │
│                           ▼    │  │        │        │  │ │
│                    ┌───────────┐│  │   ┌────┴────┐  │  │ │
│                    │  daemon   ││  │   │ SQLite  │  │  │ │
│                    │ (Hono API)││  │   │ (local) │  │  │ │
│                    └───────────┘│  │   └─────────┘  │  │ │
│                        │       │  └────────────────┘  │ │
│                        │       └──────────┬───────────┘ │
│                        │                  │             │
│                        ▼                  ▼             │
│                    ┌──────────────────────────┐         │
│                    │  MinIO (Docker) or S3    │         │
│                    │  (file blob storage)     │         │
│                    └──────────────────────────┘         │
└─────────────────────────────────────────────────────────┘

Notes:
- MCP ↔ core is in-process (no network)
- CLI → daemon is HTTP (localhost)
- Both MCP and daemon create their own DB + S3 client
- auto-bootstrapped user: local@agent-fs.local
- SQLite + MinIO both on local disk
```

#### Level 2: Self-Hosted Team (partially built)

```
┌─────────────────────────┐     ┌──────────────────────────┐
│     Machine A            │     │       Machine B           │
│                          │     │                           │
│  ┌──────────────┐        │     │  ┌──────────────┐         │
│  │  Claude Code  │        │     │  │  Claude Code  │         │
│  │  (Agent 1)    │        │     │  │  (Agent 2)    │         │
│  └──────┬───────┘        │     │  └──────┬───────┘         │
│         │ stdio          │     │         │ stdio           │
│         ▼                │     │         ▼                 │
│  ┌──────────────┐        │     │  ┌──────────────┐         │
│  │  MCP client   │        │     │  │  MCP client   │         │
│  │  (thin, HTTP) │───┐    │     │  │  (thin, HTTP) │───┐     │
│  └──────────────┘   │    │     │  └──────────────┘   │     │
│                      │    │     │                      │     │
└──────────────────────┼────┘     └──────────────────────┼─────┘
                       │                                 │
                       ▼                                 ▼
              ┌──────────────────────────────────────────────┐
              │           Team Server                         │
              │                                               │
              │  ┌────────────────────────────────────────┐   │
              │  │  agent-fs server (Hono)                 │   │
              │  │  + MCP over SSE/streamable-http         │   │
              │  │                                         │   │
              │  │  ┌──────────────────────────────────┐   │   │
              │  │  │           core                     │   │   │
              │  │  │  dispatchOp + RBAC + identity      │   │   │
              │  │  │                                    │   │   │
              │  │  │  ┌──────────┐  ┌───────────────┐   │   │   │
              │  │  │  │  SQLite  │  │  Embeddings   │   │   │   │
              │  │  │  │ (central)│  │  (server-side) │   │   │   │
              │  │  │  └──────────┘  └───────────────┘   │   │   │
              │  │  └──────────────────────────────────┘   │   │
              │  └────────────────────────────────────────┘   │
              │                      │                         │
              │                      ▼                         │
              │  ┌──────────────────────────────────────┐     │
              │  │  S3 (shared bucket - MinIO or AWS)    │     │
              │  └──────────────────────────────────────┘     │
              └──────────────────────────────────────────────┘

What changes from Level 1:
- MCP becomes a thin HTTP client (NOT embedded core)
- Single central SQLite = shared metadata, identity, search
- RBAC matters: Agent 1 = editor on drive-A, Agent 2 = viewer
- Orgs + drives organize team files
- One S3 bucket shared by all agents
- NOT YET BUILT: MCP thin client mode, MCP-over-SSE
```

#### Level 3: Cloud Multi-Tenant (not yet built)

```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Tenant A  │ │ Tenant B  │ │ Tenant C  │ │ Tenant D  │
│ Agent(s)  │ │ Agent(s)  │ │ Agent(s)  │ │ Agent(s)  │
└─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
      │              │              │              │
      │    MCP (SSE/streamable-http) or HTTP API   │
      └──────────┬───┴──────┬───────┴──────┬───────┘
                 │          │              │
                 ▼          ▼              ▼
        ┌─────────────────────────────────────────────┐
        │          agent-fs Cloud Platform              │
        │                                               │
        │  ┌─────────────────────────────────────────┐  │
        │  │  API Gateway / Load Balancer              │  │
        │  │  (auth, rate limiting, tenant routing)    │  │
        │  └──────────────────┬────────────────────┘  │
        │                     │                        │
        │  ┌──────────────────▼────────────────────┐  │
        │  │  agent-fs server instances (stateless)  │  │
        │  │  core + dispatchOp + RBAC               │  │
        │  └──────────┬────────────────┬───────────┘  │
        │             │                │               │
        │  ┌──────────▼──────┐  ┌──────▼───────────┐  │
        │  │  PostgreSQL     │  │  S3              │  │
        │  │  (replaces      │  │  (per-tenant     │  │
        │  │   SQLite)       │  │   prefix or      │  │
        │  │                 │  │   per-tenant     │  │
        │  │  - metadata     │  │   bucket)        │  │
        │  │  - identity     │  │                  │  │
        │  │  - versions     │  │                  │  │
        │  │  - comments     │  │                  │  │
        │  │  - FTS (pg_trgm)│  │                  │  │
        │  └─────────────────┘  └──────────────────┘  │
        │             │                                │
        │  ┌──────────▼──────────────────────────┐    │
        │  │  Vector DB (pgvector or dedicated)   │    │
        │  │  (replaces sqlite-vec)               │    │
        │  └─────────────────────────────────────┘    │
        └─────────────────────────────────────────────┘

What changes from Level 2:
- SQLite → PostgreSQL (multi-tenant, concurrent, replicated)
- sqlite-vec → pgvector or dedicated vector DB
- FTS5 → PostgreSQL full-text (pg_trgm / tsvector)
- Server instances become stateless (no local SQLite)
- Tenant isolation: per-org S3 prefixes, row-level security
- API gateway handles auth tokens (not local config files)
- core's DB interface needs abstraction (Drizzle helps here)
- Horizontal scaling: multiple server instances behind LB
```

### Q: How does RBAC actually work? What about directory-level access?

**Permissions are per-drive only.** There is no per-directory or per-file ACL.

`dispatchOp()` calls `checkPermission(userId, driveId, requiredRole)` — once that passes, the handler runs with full access to every path in the drive.

**The isolation boundary is the drive.** To share some files but not others, you put them in different drives (like Google Drive shared drives). Example:
- Drive "shared" → both agents are editors
- Drive "agent-1-private" → only agent-1 has access
- Drive "agent-2-private" → only agent-2 has access

**Implication:** If you want fine-grained access control (e.g. per-directory ACLs), the drive model is the wrong granularity. But drives-as-isolation-units is simpler and avoids the complexity of path-based ACLs.

**📌 PINNED — Future feature: path-level access control.** Tree-based model: grant access from a path downwards (e.g. "viewer on /docs/*" within a drive). This would allow sharing subtrees without creating separate drives. Design considerations: how does this interact with drive-level roles? Is it additive (path grants stack on top of drive role) or restrictive (path rules narrow drive-wide access)?

### Q: Should the CLI have an embedded mode (direct core access without daemon)?

**Current behavior:** CLI auto-detects daemon → HTTP if running, else falls back to direct core access via `embedded.ts`.

**Problems with embedded CLI mode:**
1. Inconsistency: same command, different backend depending on daemon state
2. Complexity: three code paths to `dispatchOp` (MCP embedded, CLI→HTTP, CLI embedded)
3. Breaks L2/L3 progression where CLI must always go through API
4. SQLite locking risk if daemon + embedded CLI run concurrently

**Recommendation:** Remove CLI embedded mode. CLI always requires daemon. If not running, error: "run `agent-fs daemon start` first". MCP stays embedded (different use case — lifecycle managed by MCP client).

### Q: How do the three search modes work together?

| Mode | Engine | Indexed | Use case |
|------|--------|---------|----------|
| `grep` | JS RegExp over FTS5 stored content | Sync (instant) | Exact pattern matching with line numbers |
| `fts` | SQLite FTS5 MATCH + BM25 ranking | Sync (instant) | Keyword discovery with snippets |
| `search` | sqlite-vec KNN on embeddings | Async (fire-and-forget) | Meaning-based semantic search |

**FTS5 stores full file content** — this is how `grep` works without hitting S3 for each file.

**Embedding pipeline is async:** write succeeds immediately, `scheduleEmbedding()` runs in background with a semaphore (max 2 concurrent) for cost control. Status tracked per-file: pending → indexed | failed.

### Key Decisions

1. **The ops registry is the right abstraction boundary.** Both MCP and HTTP already route through `dispatchOp()`. Any future mode (MCP-over-HTTP, hosted MCP) should use this same dispatch layer.
2. **RBAC is per-drive, not per-path.** This is intentionally simple. The drive is the isolation boundary (like Google Drive shared drives).
3. **Dual storage: SQLite (metadata + search) + S3 (blobs).** This is elegant for local use but SQLite is the blocker for multi-user/hosted scenarios.
4. **MCP is always embedded (direct core).** This works for local use but needs a thin-client HTTP mode for team/cloud.
5. **CLI embedded mode should probably go away.** It adds a third code path for no clear benefit. CLI should always require the daemon.

### Open Questions

1. **Path-level access control** — Should drives support sub-tree permissions (e.g. "viewer on /docs/* within drive-X")? What model — additive or restrictive relative to drive role?
2. **MCP-over-HTTP vs MCP-in-server** — For hosted: should MCP become a thin HTTP client (Path A) or should the server embed MCP via SSE transport (Path B)? Path B is likely better (one deployment, one port).
3. **SQLite → PostgreSQL migration path** — How painful is the Drizzle ORM transition? FTS5 → pg_trgm/tsvector and sqlite-vec → pgvector are the hard parts.
4. **Multi-process SQLite safety** — If MCP (embedded) and daemon both run locally, are they fighting over the same SQLite file? WAL mode helps but is it sufficient?

### Constraints Identified

1. **SQLite is single-machine.** Every feature that touches metadata, identity, or search is bound to a local file. Sharing across machines requires a central server.
2. **Bun-only runtime.** No Node.js compat means deployment options are narrower (no Lambda without Bun layer, etc).
3. **Embedding provider dependency.** Semantic search requires an API key (OpenAI/Gemini) or local model. Without it, `search` returns empty. FTS + grep always work.
4. **S3 is required.** Even for local, you need MinIO (Docker) or some S3-compatible store. No pure-SQLite fallback for blobs.

### Architecture Summary

```
                    ┌─────────────────┐
                    │   CLI (Commander)│
                    └────┬──────┬─────┘
                         │      │
              ┌──────────┘      └──────────┐
              │ HTTP                       │ stdio
              ▼                            ▼
    ┌─────────────────┐          ┌─────────────────┐
    │ Server (Hono)    │          │  MCP (SDK)       │
    │ - auth middleware│          │  - auto-bootstrap│
    │ - rate limiting  │          │  - 24 tools      │
    │ - CORS           │          │  - health/whoami │
    └────────┬────────┘          └────────┬────────┘
             │                            │
             └────────────┬───────────────┘
                          ▼
              ┌───────────────────────┐
              │    Core               │
              │  ┌─────────────────┐  │
              │  │ dispatchOp()     │  │
              │  │ + RBAC + Zod     │  │
              │  └────────┬────────┘  │
              │           │           │
              │  ┌────────▼────────┐  │
              │  │ 22 Op Handlers  │  │
              │  └──┬──────────┬───┘  │
              │     │          │      │
              │  ┌──▼───┐ ┌───▼───┐  │
              │  │SQLite│ │  S3   │  │
              │  │+FTS5 │ │ blobs │  │
              │  │+vec  │ │       │  │
              │  └──────┘ └───────┘  │
              │                      │
              │  Identity: User→Org→Drive  │
              │  Search: grep/fts/semantic  │
              └───────────────────────┘
```

## Next Steps

- **Immediate:** Consider removing CLI embedded mode (`embedded.ts`) — simplifies the system and aligns with the "daemon-required" model.
- **Short-term:** Research MCP-over-SSE/streamable-http to support hosted MCP (Path B: MCP embedded in server).
- **Medium-term:** Plan the SQLite → PostgreSQL migration for L3 (cloud multi-tenant). Drizzle supports both, but search indexes are the hard part.
- **Future feature (pinned):** Path-level access control within drives (tree-based model).
