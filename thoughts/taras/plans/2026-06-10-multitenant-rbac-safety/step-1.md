---
id: step-1
name: Core authz helpers and strict drive membership
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Core authz helpers and strict drive membership

## Overview

Create the shared authorization foundation for hosted multi-tenant safety. This step adds reusable core identity helpers, binds explicit drives to orgs, removes zero-member public-drive visibility, and ensures all existing/new drives have explicit drive membership rows so later HTTP, MCP, raw, and comment hardening can use one rule set.

## Changes Required:

#### 1. Core Authorization Helpers
**File**: `packages/core/src/identity/rbac.ts`
**Changes**: Add reusable helpers for org role lookup/checks, drive role checks, drive-to-org binding, and admin-or-better checks. Preserve `checkPermission()` compatibility for existing op dispatch while exposing clearer helpers for routes and MCP tools.

#### 2. Context Resolution Binding
**File**: `packages/core/src/identity/context.ts`
**Changes**: When both `orgId` and explicit `driveId` are provided, reject mismatches instead of silently returning the drive's stored org. Keep existing default personal-org and default-drive behavior.

#### 3. Strict Drive Membership
**File**: `packages/core/src/identity/drives.ts`
**Changes**: Change `listDrivesForUser()` to return only drives where the user has an explicit `drive_members` row. Update `createDrive()` so callers can create an initial admin membership for the creator where appropriate.

#### 4. Existing Drive Backfill
**File**: `packages/core/src/db/migrate.ts`
**Changes**: Add an idempotent migration that gives org admins explicit `drive_members` admin rows for any existing drive with zero member rows. This prevents strict membership from orphaning older drives while removing public-drive semantics.

#### 5. Exports and Tests
**File**: `packages/core/src/identity/index.ts`
**Changes**: Export the new helper functions.

**File**: `packages/core/src/index.ts`
**Changes**: Re-export helper functions needed by server and MCP packages.

**File**: `packages/core/src/identity/__tests__/identity.test.ts`
**Changes**: Add tests proving strict drive membership, new-drive creator membership, route org/drive mismatch rejection, org/drive admin helper behavior, and migration/backfill behavior.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
- [x] Targeted identity tests pass: `bun test packages/core/src/identity/__tests__/identity.test.ts`.
- [x] RBAC mapping tests still pass: `bun test packages/core/src/__tests__/rbac-mapping.test.ts`.
- [x] Core op integration RBAC tests still pass: `bun test packages/core/src/ops/__tests__/ops-integration.test.ts`.
- [x] Typecheck passes: `bun run typecheck`.

#### Automated QA:
- [x] Creator visibility scenario passes: `bun test packages/core/src/identity/__tests__/identity.test.ts --test-name-pattern "newly-created drive has explicit creator membership"`.
- [x] Empty-drive backfill scenario passes: `bun test packages/core/src/identity/__tests__/identity.test.ts --test-name-pattern "backfills empty drive members for org admins"`.

#### Manual Verification:
- [x] Taras confirms strict drive membership is the intended behavior change and accepts that formerly zero-member drives become admin-only until explicitly shared.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
