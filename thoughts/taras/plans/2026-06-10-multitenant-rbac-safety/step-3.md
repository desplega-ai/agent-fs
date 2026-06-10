---
id: step-3
name: Raw HTTP and IPC/FUSE write RBAC
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: Raw HTTP and IPC/FUSE write RBAC

## Overview

Close the viewer-write bypass in binary/raw write paths. This step enforces editor-or-better permissions for `writeRaw()` usage across HTTP `PUT /raw` and IPC/FUSE write operations while preserving viewer read access and existing optimistic concurrency semantics.

## Changes Required:

#### 1. Shared Raw Write Permission Check
**File**: `packages/core/src/ops/write.ts`
**Changes**: Enforce editor-or-better for `writeRaw()` or a shared raw-write boundary using the step-1 core helper. Preserve existing `write()` behavior through `dispatchOp()` and avoid duplicate user-visible errors where possible.

#### 2. HTTP Raw Route Behavior
**File**: `packages/server/src/routes/files.ts`
**Changes**: Let `GET /raw` remain viewer-accessible. Ensure `PUT /raw` returns a permission-denied response for viewers and still supports binary payloads, `If-Match`, `If-None-Match`, dedup, and JSON-body rejection for editors/admins.

#### 3. IPC/FUSE Write Behavior
**File**: `packages/server/src/ipc/handlers.ts`
**Changes**: Ensure `open_write`, `create_file`, and `truncate` require editor-or-better. Confirm `unlink` and `rename` remain protected through `dispatchOp()`. Keep read/list/getattr paths viewer-accessible.

#### 4. Raw and IPC Tests
**File**: `packages/server/src/__tests__/files-raw.test.ts`
**Changes**: Add viewer read success, viewer `PUT /raw` denial, and editor/admin `PUT /raw` success cases without weakening existing binary/concurrency tests.

**File**: `packages/server/src/ipc/__tests__/server.test.ts`
**Changes**: Add IPC tests for viewer write denial and editor write success using the existing msgpack round-trip harness.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
- [x] Raw HTTP tests pass: `bun test packages/server/src/__tests__/files-raw.test.ts`.
- [x] IPC tests pass: `bun test packages/server/src/ipc/__tests__/server.test.ts`.
- [x] Core raw write tests still pass: `bun test packages/core/src/ops/__tests__/binary.test.ts packages/core/src/ops/__tests__/dedup.test.ts packages/core/src/ops/__tests__/concurrency.test.ts`.
- [x] FUSE helper tests pass where Rust is available: `cargo test -p agent-fs-fuse`.
- [x] Typecheck passes: `bun run typecheck`.

#### Automated QA:
- [x] Raw HTTP viewer/editor scenario passes: `bun test packages/server/src/__tests__/files-raw.test.ts --test-name-pattern "viewer raw read but not raw write"`.
- [x] IPC viewer/editor scenario passes: `bun test packages/server/src/ipc/__tests__/server.test.ts --test-name-pattern "viewer cannot open_write but editor can"`.

#### Manual Verification:
- [ ] Taras confirms the raw/FUSE write error shape is acceptable for agents and FUSE clients, especially the HTTP status/error code surfaced for viewer write attempts.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
