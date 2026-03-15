---
date: 2026-03-15T00:00:00Z
author: Taras & Claude
topic: "agent-fs Testing Coverage Enhancement"
tags: [plan, agent-fs, testing, coverage]
status: in-progress
autonomy: autopilot
---

# agent-fs Testing Coverage Enhancement Plan

## Overview

Systematically increase test coverage across the agent-fs monorepo from ~15% to >80% file coverage. The approach prioritizes high-value pure logic first, then DB-dependent operations, then integration layers.

## Current State

| Package | Source Files | Tested | Coverage | Notes |
|---------|-------------|--------|----------|-------|
| **core** | 50 | 9 | 18% | Foundation of everything — highest priority |
| **cli** | 9 | 0 | 0% | Zero tests |
| **mcp** | 3 | 1 | 33% | Minimal |
| **server** | 9 | 1 | 11% | Minimal |
| **Total** | 71 | 11 | ~15% | |

### Existing Test Patterns

- Framework: `bun:test` (native, no external deps)
- File naming: `*.test.ts` in `__tests__/` subdirectories or colocated
- Manual tests: `__manual_tests__/` for tests requiring external services
- Skip pattern: Tests check service availability and conditionally skip
- CI: `bun run test` runs in GitHub Actions on push/PR to main

### What's Already Tested

- `config.ts` — config loading/saving
- `db/` — database creation basics
- `identity/` — user/org/drive creation
- `ops/` — operation dispatch, search
- `s3/client.ts` — S3 operations (integration, skips without MinIO)
- `mcp/` — MCP server tool registration
- `server/` — API endpoint basics

---

## Phase 0: Test Infrastructure

**Goal:** Enable coverage reporting and create shared test utilities.

### Tasks

1. **Add coverage to `bun test`**
   - Update root `package.json` scripts:
     ```json
     "test": "bun test packages/*/src/",
     "test:coverage": "bun test --coverage packages/*/src/"
     ```
   - Add `bunfig.toml` coverage config:
     ```toml
     [test]
     coverage = false
     coverageThreshold = { line = 60 }
     ```

2. **Add CI coverage reporting**
   - Add `bun run test:coverage` step to `.github/workflows/ci.yml`
   - Coverage output goes to stdout (Bun native) — no extra reporter needed

3. **Enhance `test-utils.ts`**
   - Read existing `packages/core/src/test-utils.ts`
   - Ensure it provides:
     - `createTestDb()` — in-memory SQLite with full schema + migrations
     - `createTestS3()` — mock S3 client (or MinIO skip helper)
     - `createTestContext()` — full `OpContext` with test db, mock s3, test user/org/drive
     - `cleanupTestDb()` — teardown helper
   - This is the foundation for all subsequent phases

### Verification

```bash
bun run test:coverage
# Should show coverage percentages per file
bun run typecheck
```

---

## Phase 1: Core Pure Functions

**Goal:** Test all pure functions that have zero external dependencies. Easiest wins, highest confidence.

### 1.1 Error Classes (`core/src/errors.ts`)

- Test each error subclass construction (NotFoundError, PermissionDeniedError, EditConflictError, IndexingInProgressError, ValidationError)
- Test `toJSON()` serialization includes correct fields
- Test error `code` and `statusCode` properties
- Test `instanceof` chain (subclass → AgentFSError → Error)

### 1.2 RBAC Role Mapping (`core/src/identity/rbac.ts`)

- Test `getRequiredRole()` returns correct role for every op:
  - Viewer ops: ls, cat, head, tail, stat, grep, find, search, log, diff, recent
  - Editor ops: write, edit, append, rm, mv, cp, mkdir, revert
  - Admin ops: reindex
- Test `getRequiredRole()` throws for unknown op name
- Test role hierarchy logic in `checkPermission()`

### 1.3 Path Utilities (`core/src/ops/paths.ts`)

- Test path normalization
- Test path validation (disallowed characters, traversal attempts)
- Test edge cases: root path, trailing slashes, double slashes

### 1.4 S3 Key Generation (`core/src/ops/versioning.ts`)

- Test `getS3Key(orgId, driveId, path)` formats correctly
- Test with various path formats (nested, root-level, special chars)

### 1.5 Content Chunker (`core/src/search/chunker.ts`)

- Test small content (below chunk threshold) → single chunk
- Test large content → multiple chunks with correct overlap
- Test empty content
- Test content with only whitespace
- Test chunk `charOffset` values are correct
- Test fallback chunking when chonkie is unavailable

### 1.6 Op Registry (`core/src/ops/index.ts`)

- Test `getRegisteredOps()` returns all 20 ops
- Test `getOpDefinition(name)` returns schema + handler for each op
- Test `getOpDefinition(unknown)` returns undefined/throws

### Verification

```bash
bun test packages/core/src/
bun run typecheck
```

---

## Phase 2: Core DB-Dependent Tests

**Goal:** Test identity management, RBAC enforcement, and file operations that depend on SQLite.

All tests in this phase use `createTestDb()` + `createTestContext()` from test-utils.

### 2.1 Identity — Users (`core/src/identity/users.ts`)

- Test `createUser()` generates valid ID and API key
- Test API key format: `af_` prefix + 64 hex chars
- Test `hashApiKey()` produces consistent SHA256 hashes
- Test `getUserByApiKey()` finds user by hashed key
- Test `getUserByEmail()` lookup
- Test duplicate email handling
- Test personal org + default drive auto-creation

### 2.2 Identity — Orgs (`core/src/identity/orgs.ts`)

- Test `createOrg()` with and without `isPersonal`
- Test `listUserOrgs()` returns only user's orgs
- Test `getOrg()` returns null for missing org
- Test `inviteToOrg()` adds membership with correct role

### 2.3 Identity — Drives (`core/src/identity/drives.ts`)

- Test `createDrive()` with and without `isDefault`
- Test `listDrives()` scoped to org
- Test `getDrive()` returns null for missing drive
- Test `setDriveMember()` adds/updates membership

### 2.4 Identity — Context Resolution (`core/src/identity/context.ts`)

- Test valid context: user → org → drive chain
- Test invalid user → throws
- Test user not in org → throws
- Test user not in drive → throws
- Test drive not in org → throws

### 2.5 RBAC Enforcement (`core/src/identity/rbac.ts`)

- Test `getUserDriveRole()` returns correct role
- Test `checkPermission()` allows viewer for viewer ops
- Test `checkPermission()` denies viewer for editor ops
- Test `checkPermission()` allows admin for all ops
- Test `checkPermission()` throws PermissionDeniedError with useful message

### 2.6 Versioning (`core/src/ops/versioning.ts`)

- Test `getNextVersion()` returns 1 for new file
- Test `getNextVersion()` increments for existing file
- Test `createVersion()` inserts version record + upserts file metadata

### 2.7 FTS Indexing (`core/src/search/fts.ts`)

- Test `indexFile()` inserts searchable content
- Test `indexFile()` upserts (re-index same path)
- Test `removeFromIndex()` removes content
- Test `ftsQuery()` matches content
- Test `ftsQuery()` with `pathPrefix` filtering
- Test `ftsQuery()` returns correct snippet extraction

### Verification

```bash
bun test packages/core/src/
bun run typecheck
```

---

## Phase 3: Core Operations (with Mock S3)

**Goal:** Test the 20 filesystem operations end-to-end using test DB + mock/real S3.

Tests should use the existing skip pattern: check if MinIO is available, skip if not. But also provide a mock S3 layer for CI where MinIO isn't running.

### 3.1 Mock S3 Client

- Create `packages/core/src/__tests__/mock-s3.ts`
- In-memory key-value store implementing the same interface as `AgentS3Client`
- Supports: putObject, getObject, deleteObject, copyObject, listObjects, headObject
- Supports versioning (track version history per key)

### 3.2 Write Operation (`core/src/ops/write.ts`)

- Test basic write creates file + version record
- Test content size limit (>10MB fails with ValidationError)
- Test `expectedVersion` succeeds when matching
- Test `expectedVersion` fails when mismatched (EditConflictError)
- Test S3 content is stored correctly
- Test FTS indexing is triggered

### 3.3 Cat Operation (`core/src/ops/cat.ts`)

- Test reading existing file returns content
- Test reading non-existent file throws NotFoundError
- Test reading specific version

### 3.4 Edit Operation (`core/src/ops/edit.ts`)

- Test successful string replacement
- Test `old_string` not found → throws
- Test `old_string` found multiple times → throws
- Test version is incremented after edit
- Test diff summary is recorded

### 3.5 Delete Operation (`core/src/ops/rm.ts`)

- Test soft delete marks file as deleted
- Test reading deleted file throws NotFoundError
- Test ls excludes deleted files

### 3.6 Move/Copy (`core/src/ops/mv.ts`, `core/src/ops/cp.ts`)

- Test move updates path in DB + copies S3 object
- Test copy creates new file with same content
- Test move to existing path behavior

### 3.7 Directory Operations (`core/src/ops/ls.ts`, `core/src/ops/mkdir.ts`)

- Test ls returns files in directory
- Test ls with path prefix filtering
- Test mkdir creates directory marker
- Test ls shows directories

### 3.8 Read Operations (`core/src/ops/head.ts`, `core/src/ops/tail.ts`, `core/src/ops/stat.ts`)

- Test head returns first N lines
- Test tail returns last N lines
- Test stat returns file metadata (size, author, dates, version count)

### 3.9 History Operations (`core/src/ops/log.ts`, `core/src/ops/diff.ts`, `core/src/ops/revert.ts`, `core/src/ops/recent.ts`)

- Test log returns version history for a file
- Test diff between two versions produces correct patch
- Test revert restores previous version content
- Test recent returns recently modified files

### 3.10 Search Operations (`core/src/ops/grep.ts`, `core/src/ops/find.ts`)

- Test grep matches regex patterns in indexed content
- Test grep returns correct line numbers
- Test find matches file paths by glob pattern

### 3.11 Reindex (`core/src/ops/reindex.ts`)

- Test reindex re-indexes all files in drive
- Test reindex updates FTS content

### 3.12 Dispatch Integration

- Test `dispatchOp()` routes to correct handler
- Test `dispatchOp()` enforces RBAC before execution
- Test `dispatchOp()` with invalid op name

### Verification

```bash
bun test packages/core/src/
bun run typecheck
```

---

## Phase 4: Server Package

**Goal:** Test HTTP API layer — middleware, routes, error handling.

### 4.1 Auth Middleware (`server/src/middleware/auth.ts`)

- Test valid Bearer token → attaches user to context
- Test missing Authorization header → 401
- Test invalid token → 401
- Test malformed header (no "Bearer" prefix) → 401

### 4.2 Error Middleware (`server/src/middleware/error.ts`)

- Test AgentFSError subclasses map to correct HTTP status codes:
  - NotFoundError → 404
  - PermissionDeniedError → 403
  - EditConflictError → 409
  - ValidationError → 400
- Test unknown errors → 500
- Test JSON response format includes code, message, suggestion

### 4.3 Auth Routes (`server/src/routes/auth.ts`)

- Test POST /auth/register creates user and returns API key
- Test POST /auth/register with duplicate email
- Test POST /auth/login with valid credentials
- Test POST /auth/login with invalid credentials

### 4.4 Org Routes (`server/src/routes/orgs.ts`)

- Test GET /orgs returns user's orgs
- Test POST /orgs creates org

### 4.5 Ops Route (`server/src/routes/ops.ts`)

- Test POST /orgs/{orgId}/ops dispatches correctly
- Test with valid op + params → success
- Test with unknown op → error
- Test RBAC enforcement through HTTP layer
- Test drive resolution from params

### 4.6 Health Check

- Test GET /health returns 200

### Verification

```bash
bun test packages/server/src/
bun run typecheck
```

---

## Phase 5: MCP Package

**Goal:** Test MCP tool registration and mode detection.

### 5.1 Tool Registration (`mcp/src/tools.ts`)

- Test all 20 ops are registered as MCP tools
- Test Zod schema → MCP tool schema conversion
- Test tool handler calls dispatchOp with correct params
- Test tool response JSON format

### 5.2 Mode Detection (`mcp/src/server.ts`)

- Test daemon mode detection (mock health check response)
- Test embedded mode fallback (no daemon available)

### Verification

```bash
bun test packages/mcp/src/
bun run typecheck
```

---

## Phase 6: CLI Package

**Goal:** Test API client and command handlers.

### 6.1 API Client (`cli/src/api-client.ts`)

- Test URL resolution from config
- Test request headers (Authorization, Content-Type)
- Test error response parsing and message formatting
- Test `callOp()` constructs correct POST body

### 6.2 Command Handlers

- Test ops command registration (all 20 ops have CLI commands)
- Test org ID resolution fallback chain (flag → config → error)
- Test --help output for key commands (smoke test)

### Verification

```bash
bun test packages/cli/src/
bun run typecheck
```

---

## Phase 7: CI & Coverage Gates

**Goal:** Enforce coverage thresholds and prevent regression.

### Tasks

1. Update `.github/workflows/ci.yml` to run coverage
2. Add coverage threshold in `bunfig.toml` (start at 60%, increase over time)
3. Consider adding per-package coverage reporting

### Verification

```bash
# Full suite
bun run test:coverage
bun run typecheck
bun run build
```

---

## Manual E2E Verification

After all phases are complete, run the full test suite and verify coverage:

```bash
# Run all tests with coverage
bun run test:coverage

# Verify no type errors
bun run typecheck

# Verify build still works
bun run build

# Check test count
bun test packages/*/src/ 2>&1 | tail -5

# Verify CI passes locally
bun run typecheck && bun run build && bun run test
```

---

## Implementation Order & Estimates

| Phase | Scope | Priority | Depends On |
|-------|-------|----------|------------|
| 0 | Test infrastructure | P0 | — |
| 1 | Pure functions | P0 | Phase 0 |
| 2 | DB-dependent | P0 | Phase 0 |
| 3 | Operations (mock S3) | P1 | Phase 0, 2 |
| 4 | Server | P1 | Phase 0 |
| 5 | MCP | P2 | Phase 0 |
| 6 | CLI | P2 | Phase 0 |
| 7 | CI gates | P1 | Phase 0 |

Phases 1-2 can run in parallel. Phases 3-6 can run in parallel after Phase 2.

---

## Notes

- All tests should use `bun:test` — no new test framework dependencies
- Follow existing patterns: `__tests__/` subdirectories, `.test.ts` suffix
- Tests requiring external services (MinIO, embedding APIs) should auto-skip when unavailable
- Mock S3 client (Phase 3.1) is the key enabler for testing ops without MinIO
- Coverage threshold starts at 60% and should increase as coverage improves
