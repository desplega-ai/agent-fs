---
id: step-5
name: Comment ID scoping
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Comment ID scoping

## Overview

Make comment IDs tenant-safe by scoping every comment and parent-comment lookup to the active org and drive. This step prevents users who know a comment ID from reading, replying to, resolving, editing, or deleting comments outside the current org/drive context.

## Changes Required:

#### 1. Scoped Comment Lookup Helper
**File**: `packages/core/src/ops/comment.ts`
**Changes**: Add a local helper that fetches comments by `id + ctx.orgId + ctx.driveId + isDeleted=false`. Use it for `comment-get`, `comment-update`, `comment-delete`, `comment-resolve`, and parent lookup inside `comment-add`.

#### 2. Scoped Reply Queries and Mutations
**File**: `packages/core/src/ops/comment.ts`
**Changes**: Scope inline reply queries by `ctx.orgId` and `ctx.driveId`. Ensure update/delete/resolve statements include scoped predicates or operate only after a scoped lookup has proven ownership and tenancy.

#### 3. Comment Tests
**File**: `packages/core/src/ops/__tests__/comment.test.ts`
**Changes**: Add cross-drive and cross-org tests for comment get, reply, update, delete, resolve, and inline reply listing. Preserve existing author-only edit/delete behavior inside the same drive.

#### 4. Registry/RBAC Sanity
**File**: `packages/core/src/ops/__tests__/registry.test.ts`
**Changes**: Add coverage only if the comment hardening changes op registration or role expectations.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
- [x] Comment tests pass: `bun test packages/core/src/ops/__tests__/comment.test.ts`.
- [x] Registry tests pass: `bun test packages/core/src/ops/__tests__/registry.test.ts`.
- [x] Core op integration tests still pass: `bun test packages/core/src/ops/__tests__/ops-integration.test.ts`.
- [x] Typecheck passes: `bun run typecheck`.

#### Automated QA:
- [x] Cross-tenant comment ID scenario passes: `bun test packages/core/src/ops/__tests__/comment.test.ts --test-name-pattern "cross-tenant comment IDs are not found"`.
- [x] Same-drive author guard scenario passes: `bun test packages/core/src/ops/__tests__/comment.test.ts --test-name-pattern "author-only comment mutations still apply"`.

#### Manual Verification:
- [x] Taras confirms cross-tenant comment access should return not found rather than exposing that the comment exists but is forbidden.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
