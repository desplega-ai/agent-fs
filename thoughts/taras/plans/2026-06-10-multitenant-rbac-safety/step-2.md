---
id: step-2
name: HTTP admin routes and org-drive binding
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: HTTP admin routes and org-drive binding

## Overview

Apply the shared core authorization helpers to HTTP org, drive, and member routes. This step makes authenticated HTTP administration tenant-safe: non-members cannot inspect org/member surfaces, viewers/editors cannot manage membership, admins can still administer their org/drives, and every supplied `driveId` must belong to the route `orgId`.

## Changes Required:

#### 1. Org and Drive Route Authorization
**File**: `packages/server/src/routes/orgs.ts`
**Changes**: Require org membership for org details and drive listing. Require org admin for drive creation and org member list/invite/update/remove. Require drive admin or org admin for drive member list/update/remove. Bind `:driveId` to `:orgId` before any drive member operation.

#### 2. Drive Creation Membership
**File**: `packages/server/src/routes/orgs.ts`
**Changes**: Pass the authenticated user into `createDrive()` or the new core helper so created drives get an explicit admin membership row and remain visible under strict membership.

#### 3. Ops Route Binding
**File**: `packages/server/src/routes/ops.ts`
**Changes**: Use the step-1 context/binding behavior so `/orgs/:orgId/ops` rejects a body `driveId` from another org before dispatching any op. *(Resolved with no edits: the route already flows through `resolveContext`, which enforces this since step-1.)*

#### 4. Raw Route Binding
**File**: `packages/server/src/routes/files.ts`
**Changes**: Use the same route org/drive binding for `GET /raw` and `PUT /raw`; write-role enforcement happens in step-3, but org/drive mismatch rejection belongs here. *(Resolved with no edits: both raw routes already resolve via `resolveContext`, which enforces this since step-1.)*

#### 5. HTTP Tests
**File**: `packages/server/src/__tests__/server.test.ts`
**Changes**: Add non-member, viewer, editor, admin, and org/drive mismatch tests for org/member/drive routes.

**File**: `packages/server/src/__tests__/api.test.ts`
**Changes**: Extend MinIO-backed API coverage if needed for route binding and drive creation behavior.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
- [x] HTTP route tests pass: `bun test packages/server/src/__tests__/server.test.ts`. (24 pass, 0 fail)
- [x] MinIO-backed API tests pass when MinIO is available: `bun test packages/server/src/__tests__/api.test.ts`. (11 auto-skipped without MinIO env — repo convention; 0 fail)
- [x] Core identity tests still pass: `bun test packages/core/src/identity/__tests__/identity.test.ts`. (33 pass, 0 fail)
- [x] Typecheck passes: `bun run typecheck`.

#### Automated QA:
- [x] Cross-tenant HTTP route scenario passes: `bun test packages/server/src/__tests__/server.test.ts --test-name-pattern "cross-tenant org and drive routes"`. (1 pass)
- [x] Admin drive-management scenario passes: `bun test packages/server/src/__tests__/server.test.ts --test-name-pattern "org admin can create list and manage drive members"`. (1 pass)

#### Manual Verification:
- [x] Taras confirms the chosen admin policy is correct: org member list requires org admin, drive member list requires drive admin or org admin, and drive creation requires org admin.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
