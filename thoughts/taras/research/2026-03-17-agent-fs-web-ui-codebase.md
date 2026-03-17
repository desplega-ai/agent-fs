---
date: 2026-03-17T12:00:00-05:00
researcher: Claude
git_commit: ccc3a8e
branch: main
repository: agent-fs
topic: "agent-fs Web UI — Codebase research for implementation planning"
tags: [research, codebase, web-ui, api, comments, types, server]
status: complete
autonomy: autopilot
last_updated: 2026-03-17
last_updated_by: Claude
---

# Research: agent-fs Web UI — Codebase for Plan Prep

**Date**: 2026-03-17
**Researcher**: Claude
**Git Commit**: ccc3a8e
**Branch**: main

## Research Question

What does the web UI need to know about the existing agent-fs codebase — API surface, server configuration, type definitions, comment system, and monorepo structure — to inform a solid implementation plan?

## Summary

The agent-fs backend is fully ready to support a browser-based SPA. CORS is enabled by default (`["*"]`), all operations dispatch through a single `POST /orgs/{orgId}/ops` endpoint with Bearer auth, and the necessary management endpoints (`GET /auth/me`, `GET /orgs/{orgId}/drives`) already exist. The comment system implements Google Docs-style line-anchored, flat-threaded comments with resolution — exactly what the brainstorm calls for.

The existing `ui/` directory is a marketing landing page (pnpm + Vite + React), **not** an application UI. The web app will need a new directory (brainstorm decided on `live/`). TypeScript types for all operation params/results are defined in `packages/core/src/ops/types.ts`, but the OpenAPI spec only has Zod schemas for requests — response shapes are generic. The UI will likely need to define its own response types (or generate them from the TypeScript source).

All `Date` fields arrive over the wire as ISO-8601 strings via `JSON.stringify`. The API has no response envelope — each op returns its own shape directly.

## Detailed Findings

### 1. API Surface — Endpoints

The server exposes these HTTP endpoints relevant to the web UI:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | No | Health check, returns `{ ok, version }` |
| POST | `/auth/register` | No | Register new user, returns `{ userId, orgId, driveId, apiKey }` |
| GET | `/auth/me` | Yes | Current user info, returns `{ id, email, createdAt }` |
| GET | `/orgs` | Yes | List user's orgs |
| GET | `/orgs/:orgId` | Yes | Get org details |
| GET | `/orgs/:orgId/drives` | Yes | List drives in org, returns `{ drives: [{ id, name, isDefault }] }` |
| POST | `/orgs/:orgId/ops` | Yes | Dispatch any file/comment operation |
| GET | `/docs/openapi.json` | No | OpenAPI 3.1.0 spec |

All authenticated endpoints require `Authorization: Bearer <apiKey>` header.

**The dispatch endpoint** accepts `{ op: string, driveId?: string, ...params }` in the JSON body. The `op` field selects the operation; remaining fields are op-specific params. Response shape varies per op (no envelope).

### 2. Read-Only File Operations (for the UI)

#### `ls` — List Directory
- **Params:** `path?` (default root)
- **Response:** `{ entries: [{ name, type: "file"|"directory", size, author?, modifiedAt? }] }`
- Types: `LsResult`, `LsEntry` (`types.ts:117-127`)

#### `tree` — Recursive Directory Tree
- **Params:** `path?`, `depth?`
- **Response:** `{ tree: [{ name, type, size?, author?, modifiedAt?, children?: TreeEntry[] }] }`
- Types: `TreeResult`, `TreeEntry` (`types.ts:298-309`)

#### `cat` — Read File Content
- **Params:** `path`, `offset?`, `limit?` (default 200 lines)
- **Response:** `{ content, totalLines, truncated }`
- Types: `CatResult` (`types.ts:100-104`)

#### `stat` — File Metadata
- **Params:** `path`
- **Response:** `{ path, size, contentType?, author, currentVersion?, createdAt, modifiedAt, isDeleted, embeddingStatus? }`
- Types: `StatResult` (`types.ts:129-139`)

#### `tail` — Last N Lines
- **Params:** `path`, `lines?` (default 20)
- **Response:** Same as `cat` — `{ content, totalLines, truncated }`
- Types: Reuses `CatResult`

#### `fts` — Full-Text Search
- **Params:** `pattern`, `path?`
- **Response:** `{ matches: [{ path, snippet, rank }], hint? }`
- Snippet uses `<b>...</b>` markers and `...` ellipsis
- Types: `FtsResult`, `FtsOpMatch` (defined locally in `ops/fts.ts:9-18`, not in `types.ts`)

#### `search` — Semantic/Vector Search
- **Params:** `query`, `limit?`
- **Response:** `{ results: [{ path, score, snippet, author?, modifiedAt? }] }`
- Score: `1 / (1 + distance)`, closer to 1.0 = more relevant
- Snippet: first 200 chars of matching chunk
- Types: `SearchResult`, `SearchResultItem` (defined locally in `ops/search.ts:11-21`)
- Returns `{ results: [], hint: "..." }` if no embedding provider configured

#### `glob` — Pattern-Based File Search
- **Params:** `pattern`, `path?`
- **Response:** `{ matches: [{ path, size, modifiedAt? }] }`
- Types: `GlobResult`, `GlobMatch` (`types.ts:318-326`)

#### `grep` — Regex Content Search
- **Params:** `pattern`, `path`
- **Response:** `{ matches: [{ path, lineNumber, content }] }`
- Line numbers are 1-indexed
- Types: `GrepResult`, `GrepMatch` (defined locally in `ops/grep.ts:10-18`)

#### `log` — Version History
- **Params:** `path`, `limit?` (default 50)
- **Response:** `{ versions: [{ version, author, createdAt, operation, message?, diffSummary?, size? }] }`
- `operation`: `"write" | "edit" | "append" | "delete" | "revert"`
- Types: `LogResult`, `VersionEntry` (`types.ts:158-170`)

#### `diff` — Version Diff
- **Params:** `path`, `v1`, `v2`
- **Response:** `{ changes: [{ type: "add"|"remove"|"context", content, lineNumber? }] }`
- Note: `lineNumber` is declared in the type but **never populated** by the implementation
- Types: `DiffResult`, `DiffChange` (`types.ts:172-180`)

#### `recent` — Activity Feed
- **Params:** `path?`, `since?`, `limit?` (default 50)
- **Response:** `{ entries: [{ path, version, author, createdAt, operation, message?, diffSummary?, size? }] }`
- Types: `RecentResult`, `RecentEntry` extends `VersionEntry` + `path` (`types.ts:187-193`)

### 3. Comment Operations

#### Data Model

Comments live in a single SQLite `comments` table:

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `parent_id` | TEXT | FK to self (flat threading — max 1 level deep) |
| `org_id` | TEXT | FK to orgs |
| `drive_id` | TEXT | FK to drives |
| `path` | TEXT | File path |
| `line_start` | INTEGER | Optional line anchor start |
| `line_end` | INTEGER | Optional line anchor end |
| `quoted_content` | TEXT | Optional selected text |
| `file_version_id` | INTEGER | FK to file_versions (auto-captured, **not exposed in API responses**) |
| `body` | TEXT | Comment body |
| `author` | TEXT | FK to users |
| `resolved` | BOOLEAN | Only root comments can be resolved |
| `resolved_by` | TEXT | Who resolved |
| `resolved_at` | TIMESTAMP | When resolved |
| `is_deleted` | BOOLEAN | Soft delete |

Indexes: `(drive_id, path)`, `(parent_id)`, `(org_id)`.

#### `CommentEntry` — The Core Shape (`types.ts:226-241`)
```
{ id, parentId?, path, lineStart?, lineEnd?, quotedContent?, body, author,
  resolved, resolvedBy?, resolvedAt?, replyCount, createdAt, updatedAt }
```

#### `CommentListEntry` — Root + Replies (`types.ts:243-245`)
```
extends CommentEntry + { replies: CommentEntry[] }
```

#### Operations

| Op | Params | Response | Notes |
|----|--------|----------|-------|
| `comment-add` | `body`, `path?`, `parentId?`, `lineStart?`, `lineEnd?`, `quotedContent?` | `{ id, path, body, parentId?, lineStart?, lineEnd?, author, createdAt }` | Replies inherit path from parent. Replies to replies rejected. |
| `comment-list` | `path?`, `parentId?`, `resolved?`, `orgId?`, `limit?`, `offset?` | `{ comments: CommentListEntry[] }` | Defaults to unresolved root comments. Replies inlined. Limit 50, ordered `createdAt DESC`. |
| `comment-get` | `id` | `{ comment: CommentEntry, replies: CommentEntry[] }` | Single comment with all replies. |
| `comment-update` | `id`, `body` | `{ id, body, updatedAt }` | Author-only. |
| `comment-delete` | `id` | `{ deleted: true }` | Author-only. Soft delete. Root delete cascades to replies. |
| `comment-resolve` | `id`, `resolved` | `{ id, resolved, resolvedBy?, resolvedAt? }` | Any editor/admin can resolve. Root comments only. |

#### RBAC

| Op | Min Role |
|----|----------|
| `comment-list`, `comment-get` | `viewer` |
| `comment-add`, `comment-update`, `comment-delete`, `comment-resolve` | `editor` |

#### Key Behaviors
- **Flat threading**: Only 1 level of replies. Replying to a reply throws `ValidationError`.
- **Line anchoring**: `lineStart`/`lineEnd` + `quotedContent` anchor to file content.
- **fileVersionId**: Auto-captured at creation (latest version of the file), but **not surfaced in any API response**. Exists only in DB.
- **Soft delete**: All deletes set `isDeleted = true`. Deleting a root comment cascades to replies. Deleting a file cascades to all its comments.
- **Event emission**: All comment mutations emit to an `events` table.

### 4. Server Configuration

#### CORS
- Default: `["*"]` (permissive, all origins) — configured at `config.ts:64-66`
- Customizable via `~/.agent-fs/config.json` under `server.cors.origins`
- No env var override for CORS specifically
- Implementation: Hono's built-in `cors()` middleware (`app.ts:22-27`)

#### Auth
- Bearer token in `Authorization` header
- API key is SHA-256 hashed and looked up in `users` table
- Public paths (no auth): `/auth/register`, `/health`
- User context set as `{ id, email }` on Hono context

#### Rate Limiting
- Default: 60 requests/minute, sliding window
- Applied to `/orgs/*`, `/auth/*`, `/mcp` only
- Key: Bearer token > `x-forwarded-for` > `"unknown"`
- In-memory (not distributed)

#### Body Size Limit
- 50 MB max (`app.ts:29`)

#### Error Responses
All errors follow `{ error: "<CODE>", message: "<msg>", suggestion?: "<hint>" }` with additional fields per error type:
- `NotFoundError` (404): adds `path`
- `PermissionDeniedError` (403): adds `required_role`, `your_role`
- `EditConflictError` (409): adds `path`
- `ValidationError` (400): adds `field`
- Generic errors: 500 with `{ error: "INTERNAL_ERROR", message }`

### 5. Monorepo Structure

```
agent-fs/
├── packages/              # Bun workspace (packages/*)
│   ├── core/              # DB, S3, ops, identity, search, config, OpenAPI
│   ├── server/            # Hono HTTP server + MCP endpoint
│   ├── cli/               # Commander CLI (published as @desplega.ai/agent-fs)
│   └── mcp/               # MCP stdio proxy
├── ui/                    # Marketing landing page (standalone pnpm project, NOT in workspace)
├── docs/openapi.json      # Generated OpenAPI spec (static copy)
├── scripts/               # sync-openapi.ts, e2e.ts, release.sh, etc.
└── thoughts/              # Research, plans, brainstorms
```

#### Dependency Graph
```
core  ←  mcp  ←  server  ←  cli (bundles all)
core  ←────────  server
core  ←───────────────────  cli
```

#### TypeScript Config
- Base: `tsconfig.base.json` — ES2022, ESNext modules, bundler resolution, strict
- Path aliases: `@/core`, `@/server`, `@/mcp` → `./packages/*/src/`
- All packages: `composite: true`, `outDir: dist`
- Project references mirror dependency graph

### 6. Existing `ui/` Directory

The `ui/` directory is a **marketing/landing page**, not an application UI:
- **Stack**: Vite 8 + React 19 + Tailwind CSS 4 + shadcn/ui (base-nova style)
- **Package manager**: pnpm (not bun) — `"packageManager": "pnpm@10.10.0"`
- **Deployment**: Vercel (`vercel.json` with SPA rewrite)
- **Content**: Navbar, Hero, Features, HowItWorks, Footer sections
- **Zero application code**: No API client, no auth flow, no file browser, no connection to the backend

The web app will need a **separate directory** (brainstorm decided `live/`).

### 7. Type Reuse Strategy for the UI

#### Where types live

| Category | Location | Reusable? |
|----------|----------|-----------|
| File op params/results | `packages/core/src/ops/types.ts` | Yes, but it's a Bun workspace package |
| FTS/search/grep results | Locally in each op file | No direct export path |
| Comment types | `packages/core/src/ops/types.ts:195-289` | Yes, same file |
| Auth types | `packages/server/src/types.ts` | Server-only |
| Config types | `packages/core/src/config.ts` | Yes |
| Error types | `packages/core/src/errors.ts` | Yes |
| Zod request schemas | `packages/core/src/ops/index.ts` | Request-only, no response schemas |

#### Options for the UI
1. **Copy types manually** — simplest, but drift risk
2. **Generate from OpenAPI spec** — the spec only has request schemas; response is `type: "object"` (generic). Would need to enhance the OpenAPI generator first.
3. **Import from core package** — would require making `@desplega.ai/agent-fs-core` a dependency of the UI project, which adds the entire core package (DB, S3, etc.) as baggage. Not ideal for a browser SPA.
4. **Extract a shared types package** — cleanest long-term, but adds monorepo complexity.
5. **Generate from TypeScript source** — use a tool to extract the interfaces from `types.ts` into a standalone `.d.ts` or `.ts` file that the UI imports.

#### Key Note: Date Serialization
All `Date` fields in the TypeScript types become ISO-8601 strings on the wire (via `JSON.stringify`). The UI's API client must parse these back to `Date` objects or use string representations.

### 8. OpenAPI Spec Details

- **Format**: OpenAPI 3.1.0, version 0.2.0
- **Generated from code**: `packages/core/src/openapi.ts` reads the op registry and converts Zod schemas via `zodToJsonSchema()`
- **Sync script**: `scripts/sync-openapi.ts` writes to `docs/openapi.json`
- **Live endpoint**: `GET /docs/openapi.json` serves the same spec at runtime
- **Limitation**: Only request schemas are typed. All responses are `{ type: "object", description: "..." }` — not useful for client generation.
- **Missing endpoints in spec**: `GET /orgs`, `GET /orgs/:orgId`, `GET /orgs/:orgId/drives`, `POST /orgs/:orgId/drives`, `POST /orgs/:orgId/members/invite` are not in the OpenAPI spec (they exist as routes but weren't added to the spec generator).

## Code References

| File | Line | Description |
|------|------|-------------|
| `packages/core/src/ops/types.ts` | 1-327 | All operation param/result TypeScript interfaces |
| `packages/core/src/ops/index.ts` | 39-253 | Op registry with Zod schemas + `dispatchOp` |
| `packages/core/src/ops/comment.ts` | 1-441 | All 6 comment handler implementations |
| `packages/core/src/db/schema.ts` | 119-144 | Comments table Drizzle schema |
| `packages/core/src/db/raw.ts` | 70-93 | Comments table raw SQL + indexes |
| `packages/core/src/errors.ts` | 1-108 | Error class hierarchy with `toJSON()` |
| `packages/core/src/config.ts` | 13-167 | Config schema, defaults, env overrides |
| `packages/core/src/identity/rbac.ts` | 6-42 | RBAC roles and op-role mapping |
| `packages/core/src/openapi.ts` | 1-251 | OpenAPI spec generator |
| `packages/server/src/app.ts` | 17-72 | Hono app creation, middleware, route mounting |
| `packages/server/src/middleware/auth.ts` | 1-45 | Bearer token auth middleware |
| `packages/server/src/middleware/error.ts` | 1-32 | Error-to-HTTP-status mapping |
| `packages/server/src/routes/ops.ts` | 1-40 | Operations dispatch endpoint |
| `packages/server/src/routes/orgs.ts` | 36-40 | `GET /orgs/:orgId/drives` endpoint |
| `packages/server/src/routes/auth.ts` | 39 | `GET /auth/me` endpoint |
| `packages/cli/src/api-client.ts` | 1-59 | CLI HTTP client (reference for UI client) |
| `scripts/sync-openapi.ts` | 1-14 | OpenAPI spec sync script |
| `docs/openapi.json` | 1-999 | Generated OpenAPI 3.1.0 spec |
| `ui/package.json` | 1-28 | Marketing landing page (pnpm, Vite + React) |

## Architecture Documentation

### API Design Pattern
Single dispatch endpoint (`POST /orgs/{orgId}/ops`) with `op` field as discriminator. All 26 operations (file + comment) go through the same pipeline: Zod validation → RBAC check → handler → raw JSON response. No response envelope.

### Auth Model
API keys are hashed with SHA-256 and stored in the `users` table. The auth middleware extracts the Bearer token, hashes it, looks up the user, and sets `{ id, email }` on the request context. Org/drive resolution happens per-request in the ops endpoint via `resolveContext()`.

### Comment Architecture
Flat threading (1 level), soft delete, line-range anchoring with quoted content, version snapshot capture (not exposed). Events emitted for all mutations. Resolution is per-root-comment, any editor can resolve.

## Historical Context (from thoughts/)

- `thoughts/taras/brainstorms/2026-03-17-agent-fs-web-ui.md` — Complete brainstorm document defining the web UI scope, tech stack (Vite + React + Tailwind + Radix), features (credentials, file tree, split view, detail view, comments, search), and constraints (read-only v1, no backend).
- `thoughts/taras/research/2026-03-15-document-comments.md` — Earlier research on the comment system design.
- `thoughts/taras/research/2026-03-15-architecture-review.md` — Architecture review of the overall system.

## Open Questions (Resolved)

- ~~**Response type generation**~~: **DECIDED** — Enhance the OpenAPI spec generator to include typed response schemas. This enables proper client generation for the UI.
- ~~**Missing org/drive endpoints in OpenAPI**~~: **DECIDED** — Yes, add `GET /orgs`, `GET /orgs/:orgId`, `GET /orgs/:orgId/drives` to the OpenAPI spec.
- ~~**`fileVersionId` exposure**~~: **DECIDED** — Should be added to the comment API responses so the UI can show version context.
- ~~**`live/` vs `ui/` naming**~~: **DECIDED** — `live/` for the web app, `ui/` stays as the marketing landing page.

## Related Research

- `thoughts/taras/research/2026-03-15-document-comments.md` — Comment system design research
- `thoughts/taras/research/2026-03-15-architecture-review.md` — Overall architecture review

## Review Errata

_Reviewed: 2026-03-17 by Claude_

### Critical

_(none)_

### Important

- [ ] **Undocumented response shapes → OpenAPI response types** — The endpoint table (Section 1) lists `GET /orgs`, `GET /orgs/:orgId` without response shapes, and all op responses in the OpenAPI spec are generic `type: "object"`. This will be addressed by enhancing the OpenAPI spec generator to include typed response schemas (per resolved open question above).

- [ ] **`CommentListEntry` export claim is inaccurate** — Section 7 (Type Reuse) and the comment system notes say `CommentListEntry` is available via a re-export at `ops/index.ts:290`. Verification shows: `core/src/index.ts:40-54` explicitly lists comment types but **omits `CommentListEntry`**. The wildcard `export type *` at `ops/index.ts:290` exists but `index.ts:39` only re-exports `{ OpContext, OpDefinition }` from `ops/index.js`, so the wildcard does not chain to the package root. A consumer importing from `@desplega.ai/agent-fs-core` would **not** get `CommentListEntry`.

### Resolved

- [x] **Missing "Related Research" section** — added per template requirements
- [x] **Rate limiting for SPA** — dismissed by Taras (not a concern for v1)
- [x] **`ls` no pagination** — dismissed by Taras (fine for now)
- [x] **Binary file handling** — dismissed by Taras (fine for now)
- [x] **`ui/` stack overlap** — dismissed; `live/` confirmed as separate directory
