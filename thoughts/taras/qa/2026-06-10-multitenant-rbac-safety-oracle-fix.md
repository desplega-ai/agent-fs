---
date: 2026-06-10T21:00:00-07:00
author: Claude
topic: "Multi-tenant RBAC safety — HEAD re-validation after oracle + invite fixes (72e8955)"
tags: [qa, rbac, multi-tenant, security, existence-oracle, invite, regression]
status: pass
source_plan: thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/root.md
related_pr: n/a (branch multitenant-rbac-safety, HEAD 72e8955)
environment: local (real daemon + isolated MinIO containers; Docker)
last_updated: 2026-06-10
last_updated_by: Claude
---

# Multi-Tenant RBAC Safety — HEAD Re-Validation QA Report (72e8955)

## Context

The full-feature QA pass (`thoughts/taras/qa/2026-06-10-multitenant-rbac-safety-full.md`, 60/60 at
HEAD `800e1f1`) flagged three minor, fail-closed issues. Commit `72e8955` ("Fix intra-org drive
existence oracle and inviteToOrg default-drive grant") subsequently fixed two of them:

1. `resolveContext()` no-role-on-existing-drive now throws `NotFoundError` with a message
   byte-identical to the missing/cross-org branch (`packages/core/src/identity/context.ts:41-47`),
   and the org-default-drive branch does the same against the no-default-drive case
   (`context.ts:72-73`) — collapsing the intra-org existence oracle and eliminating the 500s.
2. `inviteToOrg` now selects the default-drive membership target with an `isDefault = true`
   predicate (`packages/core/src/identity/orgs.ts`), removing the order-dependent unscoped query.

This session re-validates the branch at the new HEAD: targeted black-box proof of both fixes plus
full regression (adversarial harness, unit tests, typecheck, CLI+MCP E2E). Executed as four
parallel sub-agents via a workflow (run `wf_5eb80d31-5ad`), per Autopilot autonomy.

## Scope

### In Scope
1. **Fix 1 — intra-org existence oracle**: existing-but-inaccessible driveId vs missing driveId
   must be byte-indistinguishable 404s, on JSON ops and the raw file route; non-member org-default
   ops must 404 identically to a nonexistent org; zero 500s on any authz path.
2. **Fix 2 — invite default-drive grant**: with extra non-default drives present, a fresh invite
   grants drive membership *only* on the `isDefault` drive, role mapped from the org role.
3. **Full regression at HEAD**: the prior 60-check adversarial harness, `bun run typecheck`,
   `bun run test`, and the 81-case `scripts/e2e.ts` suite.

### Out of Scope
- FUSE live-mount write RBAC over `/dev/fuse` (Darwin host; FUSE/IPC shares `writeRaw()`/
  `dispatchOp()` with the HTTP raw path validated here; FUSE E2E tests auto-skipped as designed).
- The known MCP member-management personal-org scoping limitation (informational; unchanged by
  this commit — see Issues Found).
- S3 hard isolation / bucket-per-tenant (explicit plan non-goal).

## Test Cases

### TC-1: Adversarial harness rerun at HEAD (60 checks)
**Steps:** Copy `/tmp/qa-mtrbac.ts` → `/tmp/qa-mtrbac-rerun.ts`; run against HEAD `72e8955`
(isolated MinIO + real daemon, all assertions over the wire via HTTP + MCP).
**Expected:** 60/60 pass; the two checks that previously documented pre-fix behavior now show the
corrected statuses; no 500 anywhere in the log.
**Actual:** 60/60 passed. `B-NONMEMBER-ops` now `404 NOT_FOUND` (was `500 INTERNAL_ERROR`);
`B-SAMEORG-edge` now `existing(secret)=404/NOT_FOUND missing=404/NOT_FOUND` (was 500 vs 404 —
oracle closed); `grep 500` over the full log: no matches. `X-INVITE-ORDER` still green.
**Status:** pass

### TC-2: Oracle-fix probes — new focused harness (10 checks, OFX-1..10)
**Steps:** New black-box harness `/tmp/qa-oracle-fix.ts` (own MinIO container, temp
`AGENT_FS_HOME`, daemon from repo source, bearer-key API). Org `acme` (admin alice, org-member
bob, private drive `secret` bob can't access, extra non-default drive `extra`), outsider mallory,
fresh invitee frank.
**Expected/Actual — all pass:**
- **OFX-1** bob ops with `driveId=secret` → 404 NOT_FOUND (not 500). **pass**
- **OFX-2** full body of that 404 byte-identical (ids normalized) to a missing-driveId 404:
  `{"error":"NOT_FOUND","message":"Drive not found: <driveId>","suggestion":"Check the driveId belongs to the org you are addressing"}` — identical. **pass**
- **OFX-3** same status (404) for both. **pass**
- **OFX-4** mallory ops on acme with no driveId → 404 `No default drive for org: <acme>` (was 500). **pass**
- **OFX-5** that body byte-identical (org ids normalized) to the same call against a nonexistent
  org uuid — no org existence oracle on `/ops`. **pass**
- **OFX-6** cross-org driveId from mallory's own org → 404, body identical to missing-id probe. **pass**
- **OFX-7** no legit-access regression: alice `ls` on `secret` → 200; bob default-drive ops → 200. **pass**
- **OFX-8** invite frank (org editor) with `secret` + `extra` present → frank appears **only** in
  the default drive's member list, role `editor`; absent from `secret` and `extra`. **pass**
- **OFX-9** raw route (`GET /orgs/:orgId/drives/:driveId/files/:path/raw`) for bob on `secret` →
  404 with the drive-level message (resolveContext fires before file lookup). **pass**
- **OFX-10** zero 500s across all 22 collected responses. **pass**
**Status:** pass (10/10)

### TC-3: Unit gates
**Steps:** `bun run typecheck`; `bun run test`.
**Expected:** 0 type errors; 0 test failures (manual/integration auto-skip without env).
**Actual:** typecheck exit 0. Tests: `380 pass / 57 skip / 0 fail`, 1290 expect() calls, 437 tests
across 42 files. Skips are the expected env-gated manual/integration tests.
**Status:** pass

### TC-4: CLI+MCP E2E regression suite
**Steps:** `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (isolated MinIO,
unique container name).
**Expected:** 0 failures; FUSE-tagged tests auto-skip on Darwin.
**Actual:** `Results: 81/81 passed (10 skipped)` — all 10 skips FUSE-tagged (Darwin, expected).
The mid-run stderr `Error: Cannot remove members from a personal org` is the expected output of
the passing negative test "member remove last admin fails".
**Status:** pass

## Edge Cases & Exploratory Testing

- **The 404s are byte-identical, not merely same-status.** OFX-2/OFX-5 normalize the echoed ids
  and compare full response bodies — message template and `suggestion` field included — so neither
  intra-org members nor outsiders can distinguish real from fake ids by error shape on `/ops` or
  the raw route.
- **Raw route degrades to the drive-level 404** for a no-role caller (drive resolution precedes
  file lookup), which is the correct fail-closed ordering — no file-existence information leaks
  through a drive the caller can't access.
- **Personal-org fallback still throws plain `Error`s** (`context.ts:91,104,107` — "No personal
  org found", "No default drive found", "No access to your default drive"). These would surface
  as 500s, but are only reachable for a caller whose *own* account is in a broken state — they
  cannot be used to probe other tenants' resources. Cosmetic; not a hole.
- **Invite grant determinism**: with `secret` and `extra` both present before frank's invite, the
  membership landed exactly on the `isDefault` drive — the previously order-dependent behavior is
  now semantically pinned, confirmed black-box (OFX-8) and by the rerun's `X-INVITE-ORDER`.

## Evidence

### Logs & Output
```
TC-1  === SUMMARY: 60/60 passed, 0 failed ===                       (/tmp/qa-mtrbac-rerun.log)
      PASS B-NONMEMBER-ops ... :: status=404 error=NOT_FOUND            (was 500 pre-fix)
      PASS B-SAMEORG-edge ... :: existing(secret)=404/NOT_FOUND missing=404/NOT_FOUND
TC-2  === SUMMARY: 10/10 passed, 0 failed ===                       (/tmp/qa-oracle-fix.log)
      PASS OFX-2 ... identical=true   PASS OFX-5 ... identical=true
      PASS OFX-8 :: default=present(role=editor) secret=absent extra=absent
TC-3  380 pass / 57 skip / 0 fail  (437 tests, 42 files)            (/tmp/qa-unit-gates.log)
TC-4  Results: 81/81 passed (10 skipped)                            (/tmp/qa-e2e-rerun.log)
```

### External Links
- Harnesses: `/tmp/qa-mtrbac-rerun.ts` (rerun copy), `/tmp/qa-oracle-fix.ts` (new, this session)
- HEAD verified by every agent: `72e89553357c63cdc39f11fdaee008c854202eb5`
- All MinIO containers torn down post-run (verified `docker ps`); repo working tree untouched by
  test execution.

## Issues Found

- [ ] **Minor (informational, carried over) — MCP member management scoped to the caller's
  personal org.** Unchanged by this commit; shared-org admins still cannot manage shared-org
  members via MCP (fail-closed capability gap, documented in the full QA report).
- [ ] **Cosmetic — personal-org fallback paths still throw plain `Error` → 500**
  (`packages/core/src/identity/context.ts:91,104,107`). Only reachable for a caller's own broken
  account state; no cross-tenant or intra-org probing value. Worth converting to typed errors
  whenever the file is next touched.

## Verdict

**Status**: PASS

**Summary**: Both fixes in `72e8955` are proven black-box — the intra-org existence oracle is
collapsed (no-role 404s byte-identical to missing-id 404s on ops and raw, zero 500s across every
authz path probed) and invites now grant exactly the `isDefault` drive — with full regression
green at HEAD: 60/60 adversarial checks, 10/10 fix probes, 380/380 unit tests, 81/81 E2E. The
two fixed issues from the prior QA report are closed; one informational item (MCP personal-org
scoping) remains open by design.

## Appendix

- **Plan**: `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/root.md` (+ `step-1..6.md`)
- **Prior QA (full feature, HEAD 800e1f1)**: `thoughts/taras/qa/2026-06-10-multitenant-rbac-safety-full.md`
- **Prior QA (core/step-1)**: `thoughts/taras/qa/2026-06-10-step-1-multitenant-rbac-safety.md`
- **Verification**: `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety-verification.md`
- **Notes**: Executed via background workflow `wf_5eb80d31-5ad` (4 parallel sub-agents). FUSE
  live-mount RBAC remains validated indirectly (shared `writeRaw()`/`dispatchOp()` code path +
  `cargo test`); run `packages/fuse-helper/docker/run-mount-test.sh` for a live-mount smoke if
  desired before release.
