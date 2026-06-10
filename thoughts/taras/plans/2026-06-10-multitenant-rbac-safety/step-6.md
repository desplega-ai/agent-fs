---
id: step-6
name: Integration docs and release updates
depends_on: [step-2, step-3, step-4, step-5]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: Integration docs and release updates

## Overview

Stitch the parallel hardening slices together and make the public contract/release artifacts match the new hosted multi-tenant safety behavior. This step adds cross-surface E2E coverage, documents the signed-url escape hatch and RBAC semantics, updates the agent-fs skill if workflows changed, and performs the required patch version bump.

## Changes Required:

#### 1. Cross-Surface E2E Coverage
**File**: `scripts/e2e.ts`
**Changes**: Add or extend E2E scenarios proving strict drive membership, HTTP admin/member/drive checks, org/drive mismatch rejection, raw HTTP viewer write denial, MCP member-tool denial, and comment ID cross-tenant denial. Keep tests isolated with the existing MinIO harness.

#### 2. Public API and Deployment Docs
**File**: `docs/api-reference.md`
**Changes**: Document that raw writes require editor-or-better, route drive IDs must belong to route org IDs, and signed URLs are unauthenticated bearer URLs after generation until expiry.

**File**: `docs/deployment.md`
**Changes**: Clarify hosted multi-tenant RBAC expectations: explicit drive membership, admin-only member management, and single-bucket namespace isolation limits.

**File**: `docs/fuse-mount.md`
**Changes**: Document that FUSE writes require editor-or-better and viewer mounts are read-only for file writes.

**File**: `docs/mcp-setup.md`
**Changes**: Document MCP member-tool RBAC if the exposed MCP management behavior is described there.

#### 3. Skill and Plugin Release Checklist
**File**: `skills/agent-fs/SKILL.md`
**Changes**: Update member, drive, FUSE, and signed-url guidance to reflect hardened hosted behavior if any command behavior or workflow explanation changed.

**File**: `.claude-plugin/plugin.json`
**Changes**: Bump plugin version if `skills/agent-fs/SKILL.md` changes.

#### 4. Version and Generated Artifacts
**File**: `package.json`
**Changes**: Bump patch version from `0.7.5` to the next patch release for the security hardening.

**File**: `docs/openapi.json`
**Changes**: Regenerate if `packages/core/src/openapi.ts` output changes, especially if op descriptions or version metadata changed.

**File**: `scripts/sync-versions.ts`
**Changes**: Use the existing script; do not modify it unless it fails to update all versioned files that this repository expects.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
- [x] Whole-repo typecheck passes: `bun run typecheck`.
- [x] Full test suite passes: `bun run test`. (376 pass / 57 skip / 0 fail)
- [x] CLI bundle builds: `bun run build`.
- [x] Full E2E suite passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`. (81/81 passed, 10 FUSE cases skipped on Darwin)
- [x] FUSE helper tests pass where Rust is available: `cargo test -p agent-fs-fuse`. (64 pass / 0 fail)
- [x] Landing docs build passes if docs changed: `pnpm --dir landing build`.
- [x] OpenAPI is fresh if generated output changes: `bun run scripts/sync-openapi.ts`. (only `info.version` changed: 0.7.5 → 0.7.6)
- [x] OpenAPI generated diff is reviewed: `git diff -- docs/openapi.json packages/core/src/openapi.ts`. (openapi.ts untouched; openapi.json diff is the version bump only)

#### Automated QA:
- [x] Hosted hardening E2E scenario passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`. (13 new `rbac:` tests cover strict membership, admin gates, org/drive binding 404s, raw viewer write denial, MCP whoami/member-tool gating, comment ID scoping — all pass)
- [x] Signed-url tests still pass after docs-only escape-hatch handling: `bun test packages/core/src/ops/__tests__/signed-url.test.ts packages/core/src/ops/__tests__/urls.test.ts`. (15 pass)
- [x] Version dry-run shows all expected package/plugin files for `0.7.6`: `bun run scripts/sync-versions.ts 0.7.6 --dry-run`. (11 files listed; then applied for real)

#### Manual Verification:
- [ ] Taras confirms the final E2E output and docs describe the intended hosted multi-tenant safety boundary without overclaiming storage-layer isolation.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
