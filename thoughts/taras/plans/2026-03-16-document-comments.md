---
date: 2026-03-16
planner: claude
status: completed
autonomy: critical
commit_per_phase: true
research: thoughts/taras/research/2026-03-15-document-comments.md
tags: [comments, collaboration, api-design]
---

# Document Comments Implementation Plan

## Overview

Add Google Docs-style document comments to agent-fs. Comments can be anchored to file paths and optional line ranges, support flat threading (replies via `parentId`), resolve/reopen, and soft delete. A generic `events` table captures comment lifecycle events (creation, resolution, deletion) for future notification/audit use.

The implementation follows agent-fs's API-first design: 6 ops registered in `opRegistry` get automatic MCP, HTTP, and RBAC support. The CLI wraps these ops in a `comment` command group for ergonomic subcommands.

## Current State Analysis

- **Op system**: 20 ops registered in `opRegistry` (`packages/core/src/ops/index.ts:30-167`). Each op is `{handler, schema}` — `dispatchOp` handles RBAC + Zod validation + dispatch.
- **DB**: Dual-maintained — Drizzle schema (`packages/core/src/db/schema.ts`) and raw SQL (`packages/core/src/db/raw.ts`). Both run idempotently on every DB init via `createDatabase()`.
- **RBAC**: `OP_ROLES` map at `packages/core/src/identity/rbac.ts:15-36`. Unknown ops default to `admin`.
- **CLI**: Op commands registered flat via `OP_COMMANDS` array (`packages/cli/src/commands/ops.ts:12-33`). Command groups (drive, auth) registered via `program.addCommand()` (`packages/cli/src/index.ts:50-54`).
- **MCP/HTTP**: Auto-registered from opRegistry — zero code needed for new ops.
- **Tests**: `bun:test` with temp SQLite DB, auto-skip when MinIO unavailable (`packages/core/src/ops/__tests__/ops.test.ts`).

### Key Discoveries:
- `ON DELETE CASCADE` is not used anywhere in the codebase — we introduce it for `parent_id` only (`comments` table)
- The `rm` op (`packages/core/src/ops/rm.ts:27-53`) already has application-level cleanup for chunks/vectors — we add comment cleanup there
- `fileVersions.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` — safe to reference from `comments.file_version_id`
- CLI command groups (like `drive`) call core functions directly, but comment commands should use `embeddedCallOp`/`client.callOp` to get RBAC enforcement through `dispatchOp`

## Desired End State

- `agentfs comment add /docs/readme.md --body "Needs refactoring" --line 42` creates a comment
- `agentfs comment reply <id> --body "Fixed in abc123"` creates a threaded reply (auto-resolves path from parent)
- `agentfs comment list /docs/readme.md` shows open comments on a file
- `agentfs comment resolve <id>` / `agentfs comment reopen <id>` toggles resolution
- All 6 comment ops available via MCP tools and HTTP API automatically
- Deleting a file via `agentfs rm` cleans up its comments
- Events emitted for comment create/resolve/delete (no consumption yet)
- `bun run typecheck` passes, comment tests pass

## Quick Verification Reference

Common commands:
- `bun run typecheck` — TypeScript type checking
- `bun run test` — run all tests (comment tests don't need MinIO)
- `bun run build` — compile CLI binary

Key files:
- `packages/core/src/ops/comment.ts` — comment op handlers
- `packages/core/src/ops/types.ts` — param/result types
- `packages/core/src/ops/index.ts` — op registry entries
- `packages/core/src/db/schema.ts` — Drizzle schema
- `packages/core/src/db/raw.ts` — raw SQL
- `packages/core/src/identity/rbac.ts` — RBAC entries
- `packages/cli/src/commands/comment.ts` — CLI command group
- `packages/core/src/ops/__tests__/comment.test.ts` — tests

## What We're NOT Doing

- **Event consumption**: No read receipts, notification endpoints, or ack/dismiss flows. Events table is populated but not queried.
- **Real-time subscriptions**: No WebSocket/SSE for live comment updates.
- **Rich text**: Comments are plain text only (`body` field).
- **Line drift tracking**: We store `file_version_id` but do NOT implement automatic line remapping. Stale comments remain at their original line numbers — drift handling is a follow-up.
- **Cross-drive comments**: Comments are scoped to the drive in `OpContext`. No cross-drive referencing.
- **MCP plugin manifest updates**: The `manifest.json` file lists specific tools — new comment ops will auto-register via `registerTools()` but the manifest file won't be updated (it's for marketplace display, not runtime).

## Implementation Approach

1. **Schema first** — Add both tables so all subsequent phases can reference them
2. **Core ops next** — Implement all 6 handlers in a single file, register in opRegistry + RBAC
3. **Event emission** — Thin layer that writes to events table from comment handlers
4. **rm integration** — Add comment cleanup to existing rm handler
5. **CLI last** — Thin command group wrapping the ops
6. **Tests** — Comment-specific tests (DB-only, no S3/MinIO needed)
7. **Exports + typecheck** — Clean up exports and verify everything compiles

---

## Phase 1: Database Schema

### Overview
Add `comments` and `events` tables to both the Drizzle schema and raw SQL. Add indexes for query performance.

### Changes Required:

#### 1. Drizzle Schema
**File**: `packages/core/src/db/schema.ts`
**Changes**: Add `comments` and `events` table definitions after `contentChunks`.

```typescript
// comments (document comments with threading)
export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),  // self-ref, NULL = root comment
  orgId: text("org_id").notNull().references(() => orgs.id),
  driveId: text("drive_id").notNull().references(() => drives.id),
  path: text("path").notNull(),
  lineStart: integer("line_start"),  // NULL = file-level comment
  lineEnd: integer("line_end"),
  quotedContent: text("quoted_content"),
  fileVersionId: integer("file_version_id"),  // references fileVersions.id
  body: text("body").notNull(),
  author: text("author").notNull().references(() => users.id),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  resolvedBy: text("resolved_by"),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
});

// events (generic event/notification table)
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  type: text("type").notNull(),  // e.g. "comment_created", "comment_resolved"
  resourceType: text("resource_type").notNull(),  // e.g. "comment"
  resourceId: text("resource_id").notNull(),
  actor: text("actor").notNull().references(() => users.id),
  target: text("target"),  // NULL = all drive members
  status: text("status", { enum: ["created", "ack", "deleted"] }).notNull().default("created"),
  metadata: text("metadata"),  // JSON blob
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
```

**Note on `parentId`**: We intentionally do NOT use `.references(() => comments.id)` in Drizzle because self-referential FKs in Drizzle can cause circular initialization issues. The FK constraint is enforced via raw SQL.

#### 2. Raw SQL
**File**: `packages/core/src/db/raw.ts`
**Changes**: Add `CREATE TABLE` statements for `comments` and `events` to `CREATE_TABLES_SQL`, plus index creation.

```sql
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  drive_id TEXT NOT NULL REFERENCES drives(id),
  path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  quoted_content TEXT,
  file_version_id INTEGER REFERENCES file_versions(id),
  body TEXT NOT NULL,
  author TEXT NOT NULL REFERENCES users(id),
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(drive_id, path);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_org ON comments(org_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  target TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'ack', 'deleted')),
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] DB initializes without errors: `bun run build && ./dist/agentfs auth register test@test.com 2>&1 | head -5` (verifies DB init runs the new CREATE TABLE statements)

#### Manual Verification:
- [ ] Confirm `comments` table SQL matches Drizzle schema (column names, types, defaults)
- [ ] Confirm `events` table SQL matches Drizzle schema
- [ ] Confirm `ON DELETE CASCADE` only on `parent_id`, not elsewhere
- [ ] Confirm indexes are created with `IF NOT EXISTS`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Core Types & Comment Handlers

### Overview
Add TypeScript param/result interfaces, implement all 6 comment op handlers in a single file, register them in `opRegistry` with Zod schemas, and add RBAC entries.

### Changes Required:

#### 1. Type Definitions
**File**: `packages/core/src/ops/types.ts`
**Changes**: Add param and result interfaces for all 6 comment ops.

```typescript
// --- Comment types ---

export interface CommentAddParams {
  path?: string;           // required for root comments, optional for replies (resolved from parent)
  body: string;
  parentId?: string;       // set = reply, null = root comment
  lineStart?: number;
  lineEnd?: number;
  quotedContent?: string;
}

export interface CommentAddResult {
  id: string;
  path: string;
  body: string;
  parentId?: string;
  lineStart?: number;
  lineEnd?: number;
  author: string;
  createdAt: Date;
}

export interface CommentListParams {
  path?: string;           // filter by file path
  parentId?: string;       // filter by parent (list replies)
  resolved?: boolean;      // filter by resolved state
  orgId?: string;          // filter by org
  limit?: number;
  offset?: number;
}

export interface CommentEntry {
  id: string;
  parentId?: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  quotedContent?: string;
  body: string;
  author: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: Date;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommentListResult {
  comments: CommentEntry[];
}

export interface CommentGetParams {
  id: string;
}

export interface CommentGetResult {
  comment: CommentEntry;
  replies: CommentEntry[];
}

export interface CommentUpdateParams {
  id: string;
  body: string;
}

export interface CommentUpdateResult {
  id: string;
  body: string;
  updatedAt: Date;
}

export interface CommentDeleteParams {
  id: string;
}

export interface CommentDeleteResult {
  deleted: boolean;
}

export interface CommentResolveParams {
  id: string;
  resolved: boolean;
}

export interface CommentResolveResult {
  id: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: Date;
}
```

#### 2. Comment Handler Implementation
**File**: `packages/core/src/ops/comment.ts` (new file)
**Changes**: Implement all 6 handlers.

Key implementation details:
- **`commentAdd`**: Generate UUID via `crypto.randomUUID()`. If `parentId` is set and `path` is missing, look up the parent comment's path. Validate parent exists and is a root comment (no nested replies). Insert into `comments` table via Drizzle. Capture current file version ID from `fileVersions` table.
- **`commentList`**: Query `comments` table with optional filters (path, parentId, resolved). Default: exclude resolved root comments unless `resolved=true`. Include `replyCount` via a subquery or post-query count. Pagination via `limit`/`offset`.
- **`commentGet`**: Fetch the comment by ID, plus all its replies (where `parent_id = id`). Return as `{comment, replies}`.
- **`commentUpdate`**: Verify the requesting user (`ctx.userId`) is the comment author. Update `body` and `updated_at`.
- **`commentDelete`**: Verify the requesting user is the author (or the comment is their own). Soft-delete by setting `is_deleted = 1`. For root comments, `ON DELETE CASCADE` in the FK handles reply cleanup — but since we're soft-deleting (not hard-deleting), we also soft-delete replies in the handler.
- **`commentResolve`**: Verify the comment is a root comment (`parent_id IS NULL`). Toggle `resolved`, set `resolved_by` and `resolved_at`.

**Author check pattern**: `commentUpdate` and `commentDelete` check `ctx.userId === comment.author`. This is a handler-level check beyond RBAC (RBAC checks drive-level role, author check ensures you can only edit/delete your own comments).

**Soft delete note**: `commentDelete` sets `is_deleted = 1` on the root comment and all its replies. `commentList` and `commentGet` filter out `is_deleted = 1` entries. We do NOT use SQL `DELETE` (which would trigger `ON DELETE CASCADE`) — we soft-delete consistently with the `files` table pattern.

#### 3. Op Registry Registration
**File**: `packages/core/src/ops/index.ts`
**Changes**:
- Import comment handlers: `import { commentAdd, commentList, commentGet, commentUpdate, commentDelete, commentResolve } from "./comment.js";`
- Add 6 entries to `opRegistry`:
  - `"comment-add"`: schema validates `path` (optional string), `body` (required string), `parentId` (optional string), `lineStart` (optional int), `lineEnd` (optional int), `quotedContent` (optional string)
  - `"comment-list"`: schema validates `path?`, `parentId?`, `resolved?` (boolean), `orgId?`, `limit?` (int min 1), `offset?` (int min 0)
  - `"comment-get"`: schema validates `id` (required string)
  - `"comment-update"`: schema validates `id` (required string), `body` (required string)
  - `"comment-delete"`: schema validates `id` (required string)
  - `"comment-resolve"`: schema validates `id` (required string), `resolved` (required boolean)
- Add to re-export line: `export { commentAdd, commentList, commentGet, commentUpdate, commentDelete, commentResolve };`

#### 4. RBAC Entries
**File**: `packages/core/src/identity/rbac.ts`
**Changes**: Add to `OP_ROLES` map:

```typescript
"comment-add": "editor",
"comment-list": "viewer",
"comment-get": "viewer",
"comment-update": "editor",
"comment-delete": "editor",
"comment-resolve": "editor",
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] No import errors: `bun -e "import { commentAdd } from './packages/core/src/ops/comment.js'"`

#### Manual Verification:
- [ ] Verify `commentAdd` resolves path from parent when `parentId` is set
- [ ] Verify `commentAdd` rejects replies to replies (flat threading enforced)
- [ ] Verify `commentUpdate`/`commentDelete` check author === ctx.userId
- [ ] Verify `commentResolve` rejects calls on replies (parentId !== null)
- [ ] Verify `commentList` excludes soft-deleted comments
- [ ] Verify `commentDelete` soft-deletes replies along with root comment

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Event Emission

### Overview
Add a thin helper to emit events into the `events` table, and call it from the comment handlers on create, resolve, and delete.

### Changes Required:

#### 1. Event Helper
**File**: `packages/core/src/ops/comment.ts` (same file, add helper)
**Changes**: Add a private `emitEvent()` function that inserts into the `events` table.

```typescript
function emitEvent(ctx: OpContext, params: {
  type: string;
  resourceType: string;
  resourceId: string;
  target?: string;
  metadata?: Record<string, unknown>;
}) {
  ctx.db.insert(schema.events).values({
    id: crypto.randomUUID(),
    orgId: ctx.orgId,
    type: params.type,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    actor: ctx.userId,
    target: params.target ?? null,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: new Date(),
  }).run();
}
```

#### 2. Emit from Handlers
**File**: `packages/core/src/ops/comment.ts`
**Changes**: Call `emitEvent()` at the end of:
- `commentAdd` → `type: "comment_created"`, metadata includes `{path, parentId?}`
- `commentResolve` → `type: "comment_resolved"` or `"comment_reopened"` based on `resolved` value
- `commentDelete` → `type: "comment_deleted"`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`

#### Manual Verification:
- [ ] Verify events are fire-and-forget (no error propagation to caller)
- [ ] Verify event metadata is valid JSON

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: rm Op Integration

### Overview
Add comment cleanup to the `rm` op handler so that deleting a file also soft-deletes its comments.

### Changes Required:

#### 1. Comment Cleanup in rm
**File**: `packages/core/src/ops/rm.ts`
**Changes**: After the existing chunk/vector cleanup (line 53), add comment soft-delete:

```typescript
// 5. Soft-delete comments on this file
ctx.db
  .update(schema.comments)
  .set({ isDeleted: true, updatedAt: new Date() })
  .where(
    and(
      eq(schema.comments.path, params.path),
      eq(schema.comments.driveId, ctx.driveId)
    )
  )
  .run();
```

This uses soft-delete (consistent with comment system design) rather than hard SQL DELETE.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Existing tests pass: `bun run test`

#### Manual Verification:
- [ ] Verify rm handler imports `schema` (already imported) and `comments` table is accessible
- [ ] Verify the soft-delete updates both root comments and replies on the file

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 5: CLI Comment Commands

### Overview
Add a `comment` command group to the CLI with subcommands for all comment operations.

### Changes Required:

#### 1. Comment Command Group
**File**: `packages/cli/src/commands/comment.ts` (new file)
**Changes**: Export a `commentCommands(client, getOrgId)` function returning a Commander `Command`.

Subcommands:
- `comment add <path>` — `--body`, `--line`, `--line-start`, `--line-end`, `--quoted-content`
- `comment reply <comment-id>` — `--body` (syntactic sugar for `comment-add` with `parentId`)
- `comment list [path]` — `--resolved`, `--limit`, `--offset`
- `comment get <id>`
- `comment update <id>` — `--body`
- `comment delete <id>`
- `comment resolve <id>`
- `comment reopen <id>` — alias for `comment-resolve` with `resolved=false`

Each subcommand dispatches via the same embedded/daemon pattern as `ops.ts`:
```typescript
if (await isDaemonRunning()) {
  result = await client.callOp(getOrgId(), "comment-add", params);
} else {
  const orgId = getEmbeddedOrgId();
  result = await embeddedCallOp(orgId, "comment-add", params);
}
```

#### 2. Register in CLI Index
**File**: `packages/cli/src/index.ts`
**Changes**:
- Import: `import { commentCommands } from "./commands/comment.js";`
- Register: `program.addCommand(commentCommands(client, getOrgId));`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] CLI builds: `bun run build`
- [x] Help text shows: `./dist/agentfs comment --help`

#### Manual Verification:
- [ ] Verify all 8 subcommands appear in `comment --help`
- [ ] Verify `comment reply` maps to `comment-add` op with `parentId`
- [ ] Verify `comment reopen` maps to `comment-resolve` op with `resolved=false`
- [ ] Verify each subcommand uses the embedded/daemon dispatch pattern

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 6: Tests

### Overview
Add comment operation tests. Comment ops are DB-only (no S3), so tests can run without MinIO.

### Changes Required:

#### 1. Comment Test File
**File**: `packages/core/src/ops/__tests__/comment.test.ts` (new file)
**Changes**: Follow existing test pattern from `ops.test.ts` but WITHOUT the MinIO skip guard (comments don't need S3).

Test setup:
- Create temp SQLite DB
- Seed required FK data (users, orgs, drives, org_members, drive_members)
- Create an `OpContext` with a mock/null S3 client (comment ops don't use S3)

Test cases:
1. **commentAdd — root comment**: Create a file-level comment, verify returned fields
2. **commentAdd — line range comment**: Create comment with lineStart/lineEnd, verify
3. **commentAdd — reply**: Create root comment, then reply. Verify reply auto-resolves path from parent
4. **commentAdd — reject nested reply**: Create root → reply → attempt reply-to-reply, expect error
5. **commentAdd — reply resolves path from parent**: Create root with path, reply without path, verify reply has same path
6. **commentList — filter by path**: Create comments on two files, list by path, verify filtering
7. **commentList — filter by resolved**: Create + resolve a comment, list with/without resolved filter
8. **commentList — excludes soft-deleted**: Soft-delete a comment, verify it's excluded from list
9. **commentGet — with replies**: Create root + 2 replies, get root, verify replies included
10. **commentUpdate — author check**: Create comment as user A, attempt update as user B, expect error
11. **commentUpdate — success**: Create comment, update body, verify new body and updated_at
12. **commentDelete — soft delete with replies**: Create root + reply, delete root, verify both soft-deleted
13. **commentResolve — resolve and reopen**: Create root, resolve, verify fields, reopen, verify fields
14. **commentResolve — reject on reply**: Create reply, attempt resolve, expect error
15. **events emitted**: Verify events table has entries after commentAdd, commentResolve, commentDelete

### Success Criteria:

#### Automated Verification:
- [x] All comment tests pass: `bun test packages/core/src/ops/__tests__/comment.test.ts`
- [x] Full test suite passes: `bun run test`

#### Manual Verification:
- [ ] Verify tests don't require MinIO (no S3 operations in comment handlers)
- [ ] Verify test coverage covers all 6 ops and edge cases (author check, flat threading, soft delete)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 7: Exports & Typecheck

### Overview
Export new types from the core package index and run a final typecheck to verify everything compiles cleanly.

### Changes Required:

#### 1. Core Package Exports
**File**: `packages/core/src/index.ts`
**Changes**: Add exports for comment op handlers and types:

```typescript
export {
  commentAdd, commentList, commentGet,
  commentUpdate, commentDelete, commentResolve,
} from "./ops/index.js";
export type {
  CommentAddParams, CommentAddResult,
  CommentListParams, CommentListResult, CommentEntry,
  CommentGetParams, CommentGetResult,
  CommentUpdateParams, CommentUpdateResult,
  CommentDeleteParams, CommentDeleteResult,
  CommentResolveParams, CommentResolveResult,
} from "./ops/types.js";
```

### Success Criteria:

#### Automated Verification:
- [x] Full typecheck passes: `bun run typecheck`
- [x] Full test suite passes: `bun run test`
- [x] CLI builds successfully: `bun run build`

#### Manual Verification:
- [ ] Verify all comment types are accessible from `@agentfs/core` package

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

- **Unit/integration tests**: `packages/core/src/ops/__tests__/comment.test.ts` — DB-only tests that don't need MinIO. Covers all 6 ops, edge cases (author checks, flat threading, resolve constraints, soft delete cascade), and event emission.
- **No S3 dependency**: Comment ops operate entirely on SQLite. Tests create a temp DB, seed FK data, and test handlers directly.
- **Existing test compatibility**: Comment tests use the same `bun:test` pattern but without `isMinioAvailable()` skip guard.

## Manual E2E Verification

**Executed 2026-03-16** against MinIO (docker: `agentfs-minio`) in an isolated `AGENTFS_HOME` temp directory.

| Step | Command | Result |
|------|---------|--------|
| 1 | `auth register test@test.com` | User/org/drive created, API key saved |
| 2 | `write /test/readme.md` (stdin) | version=1, size=25 (S3 via MinIO) |
| 3 | `comment add /test/readme.md --body "General feedback"` | Created, returned id + path + author + createdAt |
| 4 | `comment add /test/readme.md --body "Refactoring" --line-start 2 --line-end 3` | Created with lineStart=2, lineEnd=3 |
| 5 | `comment list /test/readme.md` | Both comments listed, replyCount=0 |
| 6 | `comment get <id>` | Returns comment object, empty replies array |
| 7 | `comment reply <id> --body "Fixed"` | Reply created with parentId, path resolved from parent |
| 8 | `comment get <id>` (after reply) | replyCount=1, reply in replies array |
| 9 | `comment resolve <id>` | resolved=true, resolvedBy + resolvedAt set |
| 10 | `comment list --resolved` | Shows both resolved + unresolved root comments |
| 11 | `comment reopen <id>` | resolved=false, resolvedBy/At cleared |
| 12 | `comment update <id> --body "Updated"` | body updated, updatedAt bumped |
| 13 | `comment delete <id>` | deleted=true (root + reply soft-deleted) |
| 14 | `comment list` (after delete) | Deleted comment + reply excluded from results |
| 15 | `comment add` + `rm /test/readme.md` | rm soft-deletes all comments on file; `comment list` returns empty |

All 15 steps passed.

## References

- Research: `thoughts/taras/research/2026-03-15-document-comments.md`
- Op registry: `packages/core/src/ops/index.ts:30-167`
- Dispatcher: `packages/core/src/ops/index.ts:169-192`
- DB schema (Drizzle): `packages/core/src/db/schema.ts`
- DB schema (raw SQL): `packages/core/src/db/raw.ts`
- Types pattern: `packages/core/src/ops/types.ts`
- RBAC roles map: `packages/core/src/identity/rbac.ts:15-36`
- CLI command group pattern: `packages/cli/src/commands/drive.ts`
- CLI op commands: `packages/cli/src/commands/ops.ts`
- rm handler (cascade pattern): `packages/core/src/ops/rm.ts`
- Test pattern: `packages/core/src/ops/__tests__/ops.test.ts`
- Error types: `packages/core/src/errors.ts`
