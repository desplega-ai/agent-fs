---
date: 2026-06-10
author: Claude (verification sub-agent)
plan: thoughts/taras/plans/2026-06-10-multitenant-rbac-safety
baseline: 90e73a8
head: 800e1f1 (branch multitenant-rbac-safety)
verdict: pass-with-notes
---

# Verification Report — Multi-Tenant RBAC Safety (DAG plan)

Post-implementation audit cross-referencing the plan (root.md + step-1..6.md, all `done`, root `completed`) against commits `4e4cdc7..800e1f1` (baseline `90e73a8`), with all automated Success Criteria re-run on 2026-06-10.

## Verdict: PASS (with notes)

Every step's Changes Required maps to real diffs (or to an explicitly accepted no-op deviation), all Automated Verification and Automated QA criteria re-ran green, version/release artifacts are consistent at 0.8.0, and no scope creep into "What We're NOT Doing" items was found. Notes are informational only.

## 1. Checkbox Audit

| Metric | Count |
|---|---|
| Total checkbox items (root + 6 steps) | 60 |
| Checked | 54 |
| Unchecked Automated Verification | 0 |
| Unchecked Automated QA | 0 |
| Unchecked Manual Verification | 6 (one per step — Taras confirmation boxes) |

All automated buckets are fully checked. The 6 unchecked items are the per-step "Taras confirms…" boxes. The substantive decisions they cover are documented as user-confirmed elsewhere (e.g. root.md:127 records the 0.8.0 minor-bump confirmation), but the boxes themselves were never ticked — see Notes.

## 2. Git Diff Correlation (90e73a8..800e1f1, 51 files, +2326/−215)

### step-1 — Core authz helpers and strict drive membership (4e4cdc7)
All planned files changed; implementation verified at HEAD:
- `packages/core/src/identity/rbac.ts` — new helpers `getUserOrgRole` (:59), `requireDriveRole` (:101), `requireOrgRole` (:143), `requireDriveAdmin` (:179), `assertDriveInOrg` (:215); `checkPermission` preserved (:132). ✓
- `packages/core/src/identity/context.ts` — `resolveContext` rejects org/drive mismatch with `NotFoundError`, identical to "missing drive" so cross-tenant callers cannot probe existence. ✓
- `packages/core/src/identity/drives.ts` — `createDrive` gained `creatorUserId` → explicit admin `drive_members` row; `listDrivesForUser` is strict (INNER JOIN on `drive_members`, :65-79). ✓
- `packages/core/src/db/migrate.ts` — Migration 3 (:35-52): idempotent `INSERT OR IGNORE` backfill granting org admins admin rows on zero-member drives. ✓
- `packages/core/src/identity/index.ts` + `packages/core/src/index.ts` — all new helpers + `Role`/`ResolvedContext` exported. ✓
- `identity.test.ts` — new describes: Context org/drive binding (:207), Strict drive membership (:251), authorization helpers (:311), backfill migration (:404). ✓
- **Extra file (benign)**: `packages/core/src/identity/orgs.ts` — `createOrg` refactored to use `creatorUserId` instead of a manual member insert; in service of the step.
- **Accepted deviation (a)**: no changes to `ops/index.ts` / `db/schema.ts`. The step file never listed them in Changes Required, so nothing is stale; nothing needed recording.

### step-2 — HTTP admin routes and org-drive binding (6e67123)
- `packages/server/src/routes/orgs.ts` — local `requireOrgMember` (404, anti-probe) and `requireOrgAdmin` (403 for sub-admin members) helpers (:30-57). Org details (:75) and drive listing (:84, via `listDrivesForUser`) require membership; drive creation (:92, with `creatorUserId`), invite (:103), org member list/patch/delete (:114/:123/:136) require org admin; drive member routes (:155-187) run `assertDriveInOrg` then `requireDriveAdmin`. ✓ Matches the admin policy stated in step-2's Manual Verification item.
- `server.test.ts` — "Multi-tenant RBAC" describe (:254) with 4 tests incl. both QA scenarios. ✓
- **Accepted deviation (b)**: `routes/ops.ts` / `routes/files.ts` untouched — both already pass route `orgId` + body/path `driveId` into `resolveContext` (ops.ts:26; files.ts:29,118), and step-1's mismatch rejection enforces binding centrally. Behavior is proven by server.test.ts cross-tenant test and E2E `rbac: org/drive mismatch rejected with 404`. Not annotated in step-2.md — see Notes.
- `api.test.ts` not extended — plan said "if needed"; conditional, OK.

### step-3 — Raw HTTP and IPC/FUSE write RBAC (c3429ee)
- `packages/core/src/ops/write.ts` — `writeRaw` enforces `requireDriveRole(..., requiredRole: "editor")` (:47-51); JSON path stays single-checked via dispatcher (`writeInternal` split). ✓
- `packages/server/src/routes/files.ts` / `packages/server/src/ipc/handlers.ts` — comment-level changes only; enforcement deliberately lives inside `writeRaw` (one shared boundary), `unlink`/`rename` remain on `dispatchOp`. Behavior proven by tests, not just comments. ✓
- Tests: `files-raw.test.ts` "raw RBAC — viewer vs editor vs admin" (:303-358: viewer read OK, viewer PUT 403, editor/admin succeed); `ipc/__tests__/server.test.ts` "viewer cannot open_write but editor can" (:261). Existing binary/concurrency/dedup tests intact. ✓
- **Extra file (benign)**: `Cargo.lock` — stale `agent-fs-fuse` version 0.7.2→0.7.5 catch-up.

### step-4 — MCP member tool RBAC (bbfaeff)
- `packages/mcp/src/server.ts` — shared guard (:119-121): drive-scoped → `requireDriveAdmin`, org-scoped → `requireOrgRole(admin)`; applied to `member-list`/`member-invite`/`member-update-role`/`member-remove` (:163-243); `whoami` (:126) lists only explicit-membership drives. ✓
- `tools.test.ts` — "member tool RBAC" (:168, 11 tests incl. anti-probing :252 and cross-org driveId rejection :320); "whoami hides inaccessible drives" (:345, 2 tests). `mcp.test.ts` — `registerIdentityTools` registration check (:33). ✓

### step-5 — Comment ID scoping (b444199)
- `packages/core/src/ops/comment.ts` — `getScopedComment` (:59-72) scopes by `id + ctx.orgId + ctx.driveId + isDeleted=false`; used for parent lookup in comment-add (:106), get (:259), update (:310), delete (:344), resolve (:401). List/inline-reply/mutation queries all carry `ctx.orgId`/`ctx.driveId` predicates (14 call sites). ✓
- `comment.test.ts` — "cross-tenant comment scoping" describe (:330) with both QA scenarios + cross-drive list/inline-reply test. ✓
- `registry.test.ts` untouched — conditional plan item; op registration/roles unchanged. OK.
- **Accepted deviation (c)**: optional `orgId` param kept on `comment-list` schema (`packages/core/src/ops/index.ts:245`). Handler scopes by `ctx.orgId`/`ctx.driveId` regardless (comment.ts:192-193), so it is inert for tenancy.

### step-6 — Integration docs, E2E, release (800e1f1)
- `scripts/e2e.ts` — 13 new `rbac:` tests (strict membership, viewer admin-denials, non-member 404, drive-member-list gating, org/drive mismatch 404, raw viewer write denial, comment scoping, MCP whoami/member-tool gating). ✓
- Docs: `docs/api-reference.md` (+Access control section, PUT /raw editor rule, 404 binding, "Signed URLs are bearer secrets"); `docs/deployment.md` (+"Multi-tenant isolation model" incl. single-bucket limits — no storage-isolation overclaim); `docs/fuse-mount.md` (+Write permissions, EACCES for viewers); `docs/mcp-setup.md` (+Identity & Member Management table + admin-gating paragraph). ✓
- `skills/agent-fs/SKILL.md` updated (admin-gated member commands, org-admin drive create, strict membership, FUSE editor rule, signed-url bearer warning); `.claude-plugin/plugin.json` 0.7.5→0.8.0. ✓
- Versions: `package.json`, all sub-package package.jsons, `Cargo.toml`, `Cargo.lock`, `plugin.json`, `docs/openapi.json` `info.version` all 0.8.0; landing doc copies synced. ✓
- **Accepted deviation (d)**: shipped 0.8.0 instead of the plan's 0.7.6 — recorded with rationale at root.md:127 ("minor per AGENTS.md breaking-change rule for strict drive membership — confirmed by Taras").

### Unexpected changes
None problematic. Extras beyond plan-named files: `identity/orgs.ts` (step-1, supports creator membership), `Cargo.lock` (step-3 catch-up; step-6 version sync), `landing/public/docs/*` (repo-convention doc sync; the landing api-reference copy was stale pre-plan and caught up here, hence its larger diff), per-package `package.json`s + `Cargo.toml` (sync-versions output), `thoughts/taras/qa/2026-06-10-step-1-multitenant-rbac-safety.md` (process artifact).

## 3. Scope Verification ("What We're NOT Doing")

No scope creep found: no per-tenant buckets/credentials (deployment.md explicitly documents the single shared bucket as a limit), no tenant-key encryption, no signed-url expiry/disable changes (docs-only treatment, expiry text unchanged: default 24h / max 7d), no auth-model redesign, no management UI.

## 4. Success Criteria Re-run (2026-06-10, this audit)

| Check | Claimed | Re-run result |
|---|---|---|
| `bun run typecheck` | pass | PASS |
| `bun run test` | 376 pass / 57 skip / 0 fail | 376 pass / 57 skip / 0 fail (433 tests, 42 files) |
| `bun run build` | pass | PASS |
| `bun run scripts/e2e.ts ...` (Docker MinIO) | 81/81, 10 FUSE skips on Darwin | 81/81 passed (10 skipped); all 13 `rbac:` tests pass |
| `cargo test -p agent-fs-fuse` | 64 pass | 64 pass (31+12+20+1), 0 fail |
| `pnpm --dir landing build` | pass | PASS (exit 0) |
| `bun run scripts/sync-versions.ts 0.8.0 --dry-run` | applied | "No changes — every file already at 0.8.0" |
| `bun run scripts/sync-openapi.ts` freshness | fresh | re-ran; zero git diff (FRESH) |
| signed-url + urls tests | 15 pass | 15 pass |
| Step QA scenarios (8 `--test-name-pattern` runs across steps 1-5) | pass | all PASS (1 each; MCP "member tool RBAC" = 11 pass, "whoami hides…" = 2 pass) |

Working tree remained clean after all re-runs (no regen drift).

## 5. Findings

### Blocking
None.

### Warning
None.

### Info
1. **6 Manual Verification boxes unchecked** while root is `completed`. The decisions are user-confirmed in substance (root.md:127 for versioning; step-level admin policy, strict membership, comment 404-vs-403 semantics, raw/FUSE error shape were accepted during implementation review), but the checkboxes were never ticked. Cosmetic; tick them or leave as a record that confirmation happened out-of-band.
2. **Deviation (b) not annotated in the plan**: step-2.md Changes Required items 3-4 still name `routes/ops.ts` / `routes/files.ts`, which received no step-2 edits (binding is enforced by step-1's `resolveContext`). The wording ("Use the step-1 context/binding behavior…") is compatible with a no-op, and behavior is test-proven, but a one-line note in step-2.md would prevent a future reader from hunting for missing diffs. Deviations (a) and (c) need no plan annotation (the step files never required those changes); (d) is recorded at root.md:127; (e) is recorded in thoughts/taras/qa/2026-06-10-step-1-multitenant-rbac-safety.md:83 and :144.
3. **Stale 0.7.6 annotations inside step-6.md** (:64 "0.7.5 → 0.7.6", :70 "sync-versions.ts 0.7.6 … then applied for real"): superseded by the 0.8.0 bump recorded in root.md:127. Shipped artifacts are uniformly 0.8.0.
4. **Known follow-up (e), out of scope and recorded**: `inviteToOrg()` default-drive grant selects the org's first drive row without an `isDefault` filter/ordering (`packages/core/src/identity/orgs.ts:241-255`). Pre-existing, order-dependent; flagged in the step-1 QA doc as a follow-up.

## 6. Plan Freshness

File paths and descriptions in all six step files match the implementation, with the two Info-level exceptions above (step-2 ops/files wording, step-6 0.7.6 annotations). Root status `completed` is accurate; per-step `status: done` frontmatter is accurate.
