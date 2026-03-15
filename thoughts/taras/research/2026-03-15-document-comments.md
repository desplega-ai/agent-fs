---
date: 2026-03-15
researcher: claude
git_branch: main
git_commit: 6cd3cab
tags: [comments, collaboration, api-design]
status: complete
last_updated: 2026-03-15
---

# Research: Document Comments for agent-fs

## Research Question

How should we add Google Docs-style document comments to agent-fs? The feature should support: creating comments anchored to file locations, threading/replies, resolving, updating, and deleting comments. It must follow the API-first design (core exposes API, CLI and MCP are thin wrappers).

## Summary

The research studied three reference systems (file-review, Google Drive API, Notion/GitHub APIs) and the existing agent-fs architecture to design a comment system. The recommended approach is:

- **Storage**: A single `comments` SQLite table with self-referential `parent_id` for threading, plus an `events` table for read receipts/notifications
- **Core API**: Register comment operations in the existing `opRegistry` to get automatic MCP, HTTP, and RBAC support for free
- **CLI**: A `comment` command group (like `drive`) for ergonomic subcommands
- **Data model**: Comments anchored to file path + line range (optional — file-level comments supported), flat threading via `parent_id`, resolved state, version linking, and author tracking

## Detailed Findings

### 1. Reference Implementation: file-review

**Source**: `/Users/taras/Documents/code/ai-toolbox/file-review`

file-review is a Tauri desktop app for reviewing files with inline comments. Key characteristics:

| Aspect | file-review approach |
|--------|---------------------|
| **Storage** | In-file HTML comment markers (`...`) |
| **Data model** | Flat `ReviewComment` with id, text, comment_type (inline/line), marker_pos, highlight_start, highlight_end |
| **Threading** | None — flat, independent comments |
| **Resolved state** | None — comments are present or deleted |
| **Persistence** | The file itself IS the storage; markers are stripped on load, re-inserted on save |
| **Position tracking** | UTF-16 code unit offsets, remapped through editor changes via CodeMirror `mapPos()` |

**What to take from file-review**: The UX concept of anchoring comments to specific file regions. **What NOT to take**: In-file storage (doesn't work for a multi-user API system), lack of threading/resolve.

### 2. Google Drive API Comment Model

**Source**: [Google Drive API v3 Comments Resource](https://developers.google.com/drive/api/reference/rest/v3/comments)

The Google Drive API comment resource has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID (output only) |
| `content` | string | Plain text content (settable) |
| `htmlContent` | string | HTML-formatted content (output only) |
| `createdTime` | datetime | RFC 3339 creation time |
| `modifiedTime` | datetime | Last modified time (comment or any reply) |
| `resolved` | boolean | Whether the comment has been resolved |
| `deleted` | boolean | Whether deleted (output only) |
| `author` | object | `{displayName, emailAddress, photoLink, me}` |
| `anchor` | string | JSON string representing region in document |
| `quotedFileContent` | object | `{mimeType, value}` — the quoted text the comment refers to |
| `replies[]` | array | List of reply objects |

**Reply resource fields**: `id`, `content`, `htmlContent`, `createdTime`, `modifiedTime`, `deleted`, `author`, `action` (enum: `resolve`, `reopen`).

**Key design patterns**:
- Threading is **flat** (one level of replies per comment, not nested)
- Resolve/reopen is done via a **reply with action** — not a separate endpoint
- Comments have an `anchor` for positioning and `quotedFileContent` for the selected text
- CRUD: `create`, `get`, `list`, `update`, `delete` on comments; same on replies

### 3. Notion & GitHub Comment Models

**Notion**: Comments have `id`, `parent` (page/block ref), `discussion_id` (groups thread), `created_time`, `last_edited_time`, `created_by`, `rich_text[]`. Threading is via shared `discussion_id`.

**GitHub PR Review Comments**: `id`, `body`, `path`, `line`/`start_line`, `position`, `in_reply_to_id`, `created_at`, `updated_at`, `commit_id`, `diff_hunk`, `subject_type`. Threading via `in_reply_to_id`.

### 4. Current agent-fs Architecture (relevant to design)

The system uses a central `dispatchOp()` pattern:

```
CLI (commander)  ──→  embeddedCallOp() or client.callOp()
MCP (mcp-sdk)    ──→  registerTools() auto-loop
HTTP (hono)      ──→  POST /orgs/:orgId/ops
                        │
                        ▼
                   dispatchOp(ctx, opName, params)
                        │
                        ├─ RBAC check (checkPermission)
                        ├─ Zod validation (schema.parse)
                        └─ handler(ctx, validatedParams)
```

**Adding an op to `opRegistry`** automatically makes it available via MCP (zero code) and HTTP (zero code). CLI ops registered in the `OP_COMMANDS` array also auto-register. Non-op commands (like `drive`, `auth`) are registered as Commander command groups.

**Existing DB pattern**: Drizzle ORM schema in `packages/core/src/db/schema.ts` + raw SQL in `packages/core/src/db/raw.ts` (both must be maintained in parallel). Tables use composite PKs, integer timestamps, soft deletes, and foreign keys to `drives`.

## Proposed Design

### Data Model

Single `comments` table with self-referential `parent_id` for threading (replies are just comments with a `parent_id`). This follows GitHub's `in_reply_to_id` pattern — simpler than two separate tables.

#### `comments` table

```sql
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,                                          -- UUID
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,     -- NULL = root comment, set = reply
  org_id TEXT NOT NULL REFERENCES orgs(id),                     -- for easier org-level querying
  drive_id TEXT NOT NULL REFERENCES drives(id),
  path TEXT NOT NULL,                                           -- file path
  line_start INTEGER,                                           -- starting line (1-based, NULL for file-level comments)
  line_end INTEGER,                                             -- ending line (inclusive, NULL for file-level)
  quoted_content TEXT,                                          -- snapshot of the text being commented on
  file_version_id INTEGER REFERENCES file_versions(id),          -- version when comment was created
  body TEXT NOT NULL,                                           -- comment text
  author TEXT NOT NULL REFERENCES users(id),
  resolved INTEGER NOT NULL DEFAULT 0,                          -- boolean: 0=open, 1=resolved (only meaningful on root)
  resolved_by TEXT REFERENCES users(id),                        -- who resolved it
  resolved_at INTEGER,                                          -- timestamp: when resolved
  created_at INTEGER NOT NULL,                                  -- timestamp
  updated_at INTEGER NOT NULL,                                  -- timestamp
  is_deleted INTEGER NOT NULL DEFAULT 0                         -- soft delete
);

CREATE INDEX idx_comments_path ON comments(drive_id, path);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_org ON comments(org_id);
```

**Note on `ON DELETE CASCADE`**: This is a new pattern in agent-fs — no existing tables use cascade deletes. We're introducing it here deliberately for `parent_id` (reply cleanup). File→comment cleanup is handled at the application level in the `rm` op handler since `comments(path, drive_id)` is not a composite FK to `files(path, drive_id)`.

#### `events` table (for read receipts / notifications)

A generic events table reusable beyond comments:

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,                                          -- UUID
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL,                                           -- e.g. "comment_created", "comment_resolved", "comment_deleted"
  resource_type TEXT NOT NULL,                                  -- e.g. "comment"
  resource_id TEXT NOT NULL,                                    -- FK to the resource (e.g. comment id)
  actor TEXT NOT NULL REFERENCES users(id),                     -- who triggered the event
  target TEXT REFERENCES users(id),                             -- who the event is for (NULL = all drive members)
  status TEXT NOT NULL DEFAULT 'created',                       -- "created", "ack", "deleted"
  metadata TEXT,                                                -- JSON blob for extra context
  created_at INTEGER NOT NULL
);
```

**Design decisions**:
- **Single table with `parent_id`**: Replies are just comments pointing to a parent. Simplifies CRUD — one set of ops handles both root comments and replies. `ON DELETE CASCADE` ensures deleting a root comment removes all its replies.
- **Line-based anchoring** (not character offsets): Simpler, more stable across edits, CLI-friendly. `NULL` line_start/line_end means a file-level comment.
- **Flat threading**: Only one level of nesting enforced at the application level (replies can't have replies). `parent_id` is always a root comment ID.
- **`org_id` + `drive_id`**: Both stored for easier querying at org and drive level, even though drive implies org.
- **`file_version_id`**: Links the comment to the file version it was created on. When lines drift, this allows showing the comment in context of the original version.
- **`quoted_content`**: Snapshot of the commented text at creation time.
- **Cascade deletes**: Deleting a root comment cascades to replies via `ON DELETE CASCADE` on `parent_id`. Deleting a file cascades to its comments via application-level cleanup in the `rm` op handler (not FK cascade, since `path + drive_id` is not a composite FK to `files`).
- **Generic `events` table**: Reusable for any notification/audit use case. Status field enables read receipts: `created` → `ack` (acknowledged/read). Can be used for comment events now and extended to file events, drive events, etc. later.
- **Line drift strategy**: When a file is edited and line numbers shift, stale comments are promoted to file-level (line_start/line_end set to NULL) and linked to their original version via `file_version_id`. The user can view the original context by checking that version.

### Core Operations

Register these in `opRegistry` for automatic MCP + HTTP + RBAC:

| Op Name | Role | Params | Returns |
|---------|------|--------|---------|
| `comment-add` | editor | `{path, body, parentId?, lineStart?, lineEnd?, quotedContent?}` | `{id, path, body, ...}` |
| `comment-list` | viewer | `{path?, parentId?, resolved?, orgId?, limit?, offset?}` | `{comments: [...]}` |
| `comment-get` | viewer | `{id}` | `{comment with replies}` |
| `comment-update` | editor | `{id, body}` | `{updated comment}` |
| `comment-delete` | editor | `{id}` | `{deleted: true}` |
| `comment-resolve` | editor | `{id, resolved}` | `{comment}` (toggle resolve/reopen, root comments only) |

**6 ops** instead of 9 — replies use the same `comment-add` (with `parentId`), `comment-update`, and `comment-delete` ops.

**Authorization note**: `comment-update` and `comment-delete` should additionally check that the requesting user is the author of the comment (or an admin). This is a handler-level check beyond RBAC role.

**Resolve constraint**: `comment-resolve` must reject calls on replies (`parent_id != NULL`). Only root comments can be resolved/reopened. This is enforced at the handler level.

### CLI Interface

Use a `comment` command group (Pattern B from existing codebase — like `drive`, `auth`):

```
agentfs comment add <path> --body "General feedback on this file"
agentfs comment add <path> --body "Needs refactoring" --line 42
agentfs comment add <path> --body "This whole section" --line-start 10 --line-end 25
agentfs comment list [path]                         # list comments, optionally filtered by file
agentfs comment list --resolved                     # include resolved comments
agentfs comment get <id>                            # show comment + replies
agentfs comment update <id> --body "Updated text"
agentfs comment delete <id>
agentfs comment resolve <id>
agentfs comment reopen <id>                         # alias for resolve with resolved=false
agentfs comment reply <comment-id> --body "Done, see commit abc123"
```

Note: `comment reply` is syntactic sugar for `comment add --parent <comment-id>`.

**CLI registration**: Export a `commentCommands(client, getOrgId)` function from `packages/cli/src/commands/comment.ts`, register in `index.ts` via `program.addCommand(commentCommands(...))`.

**Important**: The CLI commands should call the core ops (via `dispatchOp` or `client.callOp`), not implement logic directly. The CLI is a thin wrapper.

### MCP & HTTP

**MCP**: Zero code needed. All `comment-*` ops auto-register as MCP tools via `registerTools()`.

**HTTP**: Zero code needed. The generic `POST /orgs/:orgId/ops` endpoint dispatches all ops.

### Implementation Touchpoints

| Step | File | What |
|------|------|------|
| 1 | `packages/core/src/db/schema.ts` | Add Drizzle `comments` and `events` tables |
| 2 | `packages/core/src/db/raw.ts` | Add matching `CREATE TABLE IF NOT EXISTS` SQL |
| 3 | `packages/core/src/ops/types.ts` | Add param/result types for all comment ops |
| 4 | `packages/core/src/ops/comment.ts` | Implement all 6 handlers |
| 5 | `packages/core/src/ops/index.ts` | Import + register all 6 ops in `opRegistry` |
| 6 | `packages/core/src/identity/rbac.ts` | Add comment ops to `OP_ROLES` map |
| 7 | `packages/core/src/index.ts` | Export new types |
| 8 | `packages/cli/src/commands/comment.ts` | New file: `commentCommands()` function |
| 9 | `packages/cli/src/index.ts` | Register: `program.addCommand(commentCommands(...))` |
| 10 | MCP — nothing | Auto-registered |
| 11 | HTTP — nothing | Auto-registered |
| 12 | `packages/core/src/ops/__tests__/` | Add comment operation tests |

## Code References

- Op registry: `packages/core/src/ops/index.ts:30-167`
- Dispatcher: `packages/core/src/ops/index.ts:169-192`
- DB schema (Drizzle): `packages/core/src/db/schema.ts`
- DB schema (raw SQL): `packages/core/src/db/raw.ts`
- Types pattern: `packages/core/src/ops/types.ts`
- RBAC roles map: `packages/core/src/identity/rbac.ts:15-36`
- CLI op commands: `packages/cli/src/commands/ops.ts`
- CLI command group pattern: `packages/cli/src/commands/drive.ts`
- MCP auto-registration: `packages/mcp/src/tools.ts:7-39`
- HTTP ops route: `packages/server/src/routes/ops.ts:9-39`
- Embedded mode: `packages/cli/src/embedded.ts`
- file-review data model: `../ai-toolbox/file-review/src/comments.ts:4-11`
- file-review serialization: `../ai-toolbox/file-review/src/comments.ts:222-263`

## Resolved Questions

1. **Line drift**: Store `file_version_id` linking the comment to the version it was created on. When lines become stale, promote the comment to file-level (NULL line_start/line_end). The original context is recoverable via the linked version.

2. **File-level vs line-level comments**: Both supported. `line_start = NULL` means file-level. CLI makes `--line` optional.

3. **Comment on deleted files**: Cascade delete — deleting a file deletes its comments.

4. **Cross-drive comments**: Comments include both `org_id` and `drive_id` for flexible querying. Comments are scoped to a single drive.

5. **Notifications / read receipts**: Generic `events` table with `status` field (`created` → `ack`). Reusable for future event types beyond comments. Event types: `comment_created`, `comment_resolved`, `comment_deleted`.

## Review Errata

_Reviewed: 2026-03-15 by claude_

### Important — All Resolved

- [x] **`ON DELETE CASCADE` is a new pattern** — Added explicit note in schema section documenting this as a conscious new pattern, localized to comments `parent_id` only.
- [x] **File→comment cascade delete needs application-level handling** — Updated design decisions to specify `rm` op handler cleanup (not FK cascade).
- [x] **Missing `file_version_id` FK constraint** — Added `REFERENCES file_versions(id)` to the proposed SQL.
- [x] **Missing indexes** — Added `idx_comments_path`, `idx_comments_parent`, `idx_comments_org` index definitions.
- [x] **`comment-resolve` on replies not constrained** — Added resolve constraint note: handler must reject calls on replies (`parent_id != NULL`).
- [x] **`comment-list` missing `org_id` filter** — Added `orgId?` to `comment-list` params.

### Resolved

- [x] All code reference line numbers verified against codebase — accurate
- [x] Op registry auto-registration claim verified — confirmed (MCP iterates registry, HTTP dispatches dynamically)
- [x] `file_versions.id` is confirmed as `INTEGER PRIMARY KEY AUTOINCREMENT` — safe to reference
- [x] `OpContext` fields match exactly
- [x] RBAC roles map location confirmed at `rbac.ts:15-36`
