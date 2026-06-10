---
id: step-4
name: MCP member tool RBAC
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: MCP member tool RBAC

## Overview

Harden MCP-only member management tools so they follow the same tenant and admin rules as HTTP routes. Regular MCP file ops already go through `dispatchOp()`; this step closes the direct-helper bypasses in `member-list`, `member-invite`, `member-update-role`, and `member-remove`.

## Changes Required:

#### 1. MCP Member Tool Authorization
**File**: `packages/mcp/src/server.ts`
**Changes**: Use core identity helpers for each member tool. Require org admin for org member list/invite/update/remove. Require drive admin or org admin for drive member list/update/remove. Bind drive-scoped requests to the active/current org before listing or mutating.

#### 2. MCP Visibility Cleanup
**File**: `packages/mcp/src/server.ts`
**Changes**: Update `whoami` to use user-visible drives instead of listing every drive in the org with `role: null`, unless the caller is allowed to see those drives under strict membership.

#### 3. MCP Tests
**File**: `packages/mcp/src/__tests__/tools.test.ts`
**Changes**: Add or extend test harness coverage for invoking custom MCP member handlers with viewer/editor/admin auth contexts.

**File**: `packages/mcp/src/__tests__/mcp.test.ts`
**Changes**: Add registration/behavior checks if helper refactoring changes manual tool registration expectations.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
- [x] MCP tests pass: `bun test packages/mcp/src/__tests__/tools.test.ts packages/mcp/src/__tests__/mcp.test.ts`.
- [x] Server tests still pass for `/mcp` auth behavior: `bun test packages/server/src/__tests__/server.test.ts`.
- [x] Typecheck passes: `bun run typecheck`.

#### Automated QA:
- [x] MCP member RBAC scenario passes: `bun test packages/mcp/src/__tests__/tools.test.ts --test-name-pattern "member tool RBAC"`.
- [x] MCP visibility scenario passes: `bun test packages/mcp/src/__tests__/tools.test.ts --test-name-pattern "whoami hides inaccessible drives"`.

#### Manual Verification:
- [ ] Taras confirms MCP member management should follow the same admin policy as HTTP member management.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
