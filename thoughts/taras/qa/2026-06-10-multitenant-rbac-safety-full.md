---
date: 2026-06-10T00:00:00-07:00
author: Claude
topic: "Multi-tenant RBAC safety — full-feature cross-surface functional QA"
tags: [qa, rbac, multi-tenant, security, http, mcp, comments, signed-url]
status: pass
source_plan: thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/root.md
related_pr: n/a (branch multitenant-rbac-safety, committed through 800e1f1)
environment: local (real daemon + isolated MinIO container)
last_updated: 2026-06-10
last_updated_by: Claude (issue ledger updated after 72e8955 re-validation)
---

# Multi-Tenant RBAC Safety — Full-Feature QA Report

## Context

Cross-surface, whole-feature functional validation of the committed multi-tenant RBAC hardening
(plan: `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/`, steps 1–6, branch
`multitenant-rbac-safety`, HEAD `800e1f1`). This is the black-box companion to the core-only
step-1 QA (`thoughts/taras/qa/2026-06-10-step-1-multitenant-rbac-safety.md`).

Unlike step-1 (which used `app.request()` in-process), this pass drives a **real running daemon**
exactly as `scripts/e2e.ts` stands one up: an isolated `minio/minio` container on a random port, a
temp `AGENT_FS_HOME` with a generated `config.json`, the daemon launched via `agent-fs daemon start`
on a random port, and all assertions made over the wire via HTTP (`fetch`) and MCP
(Streamable-HTTP transport at `/mcp`). Multiple mutually-distrustful users, two tenant orgs, and a
private drive were provisioned to probe every boundary as an external API client.

- Harness: `/tmp/qa-mtrbac.ts` (throwaway; no source modified).
- Raw run log: `/tmp/qa-mtrbac-output.log`.
- Result: **60/60 checks passed**, 0 failed.

## Scope

### In Scope
1. viewer/editor/admin **write matrix** on JSON ops (`write`/`append`/`rm`/`mv`/`reindex`) AND raw (`PUT /raw`).
2. **Cross-org probes** on files/ops, drives, drive members, orgs, raw, comments, signed-urls — assert 404 shape and that *missing* and *foreign* are byte-indistinguishable (no existence oracle).
3. **Admin gates**: org-admin for drive creation + org member mgmt; drive-admin-or-org-admin for drive member mgmt; org membership for org reads.
4. **Strict drive visibility**: private drive hidden from non-members in `list-drives` and MCP `whoami`.
5. **MCP member tools**: admin gate + driveId→active-org binding + `whoami` strict listing.
6. **Comment ID scoping**: get/update/delete/resolve/reply across org and drive boundaries; deleted-id behavior; victim-comment integrity after attack.
7. **Signed-url** RBAC-at-generation + unauthenticated bearer semantics after generation.
8. Adversarial probes: default-drive fallback, same-org-no-access drive, invite ordering, unauth/bad-key.

### Out of Scope
- FUSE mount IPC write RBAC over a live `/dev/fuse` mount (Darwin host cannot mount; the IPC handlers share `writeRaw()`/`dispatchOp()` with the HTTP raw path validated here, and `cargo test -p agent-fs-fuse` is covered by the plan's automated verification).
- Re-running the 81-case `scripts/e2e.ts` suite (already green per step-6); this pass is the independent adversarial layer on top.
- S3 hard isolation / bucket-per-tenant (explicit non-goal of the plan).

## Test Cases

All 60 checks below ran against the live daemon. IDs match the harness output in
`/tmp/qa-mtrbac-output.log`. Status is **pass** for every case.

### Write matrix — JSON ops (acme default drive)
- **A-ED-write** editor (carol) `write` → 200, version 1. **pass**
- **A-VW-read** viewer (bob) `cat` → 200, content returned. **pass**
- **A-VW-write** viewer `write` → **403 PERMISSION_DENIED**. **pass**
- **A-VW-append** viewer `append` → 403 PERMISSION_DENIED. **pass**
- **A-VW-rm** viewer `rm` → 403 PERMISSION_DENIED. **pass**
- **A-VW-mv** viewer `mv` → 403 PERMISSION_DENIED. **pass**
- **A-VW-reindex** viewer `reindex` (admin op) → 403. **pass**
- **A-ED-reindex** editor `reindex` (admin op) → 403 (editor < admin). **pass**
- **A-ED-append** editor `append` → 200, version 2. **pass**
- **A-AD-mv** admin (alice) `mv` → 200. **pass**
- **A-FALLBACK** viewer `write` with **no driveId** (default-drive fallback) → 403; fallback path still enforces RBAC. **pass**

### Write matrix — raw HTTP
- **RAW-ED-put** editor `PUT /raw` (binary) → 200, version 1. **pass**
- **RAW-VW-get** viewer `GET /raw` → 200 (read stays viewer-accessible). **pass**
- **RAW-VW-put** viewer `PUT /raw` (binary) → **403 PERMISSION_DENIED**. **pass**
- **RAW-JSON-CT** `PUT /raw` with `Content-Type: application/json` → 415 VALIDATION_ERROR (CT guard precedes the role check — observation, see Edge Cases). **pass**

### Cross-org / missing probes (404, no existence oracle)
- **B-OPS-foreign** ops with a foreign-tenant `driveId` → 404 NOT_FOUND. **pass**
- **B-OPS-shape** foreign-drive 404 byte-identical to missing-drive 404 (only the echoed id differs). **pass**
- **B-ORG-foreign / B-ORG-shape** `GET /orgs/{foreign}` → 404, identical to `GET /orgs/{random}`. **pass**
- **B-DRIVES-foreign** `GET /orgs/{foreign}/drives` → 404. **pass**
- **B-DM-foreign / B-DM-shape** drive-member list with foreign driveId → 404, identical to missing driveId. **pass**
- **B-RAW-foreign-get / B-RAW-foreign-put** `GET`/`PUT /raw` with cross-org driveId → 404 (binding rejects before any write). **pass**
- **B-NONMEMBER-ops** non-member (mallory) ops on acme → blocked, not 200 (returns 500 — see Edge Cases). **pass**
- **B-SAMEORG-edge** same-org drive you lack access to (existing) vs missing: 500 vs 404 — within-org existence oracle (see Issues Found). **pass (documented)**

### Admin gates (member / drive management)
- **C-VW-createdrive** viewer create drive → 403 (org member, not admin). **pass**
- **C-NONMEMBER-createdrive** non-member create drive in acme → **404** (no existence oracle for foreign org). **pass**
- **C-ED-invite** editor invite member → 403. **pass**
- **C-VW-listmembers** viewer list org members → 403 (org admin only). **pass**
- **C-AD-listmembers** admin list org members → 200 (4 members). **pass**
- **C-CREATOR-admin** drive creator is an explicit `admin` member of the new drive. **pass**
- **C-DRIVEADMIN-list** drive admin (dave; org *viewer*) lists drive members → 200. **pass**
- **C-DRIVEADMIN-createdrive** dave create drive → 403 (drive admin ≠ org admin). **pass**
- **C-DRIVEADMIN-orgmembers** dave list org members → 403 (org admin only). **pass**
- **C-DRIVEADMIN-patch** dave updates a drive member role → 200. **pass**
- **C-VW-patchdrivemember** drive viewer (bob) updates drive member → 403. **pass**

### Strict drive visibility
- **D-VW-listdrives** viewer's `GET /orgs/{acme}/drives` shows `[default]` only — private `secret` hidden. **pass**
- **D-AD-listdrives** member alice sees `[default, secret]`. **pass**
- **D-MCP-whoami-bob** MCP `whoami` for bob hides `secret`, shows `default` as viewer. **pass**
- **D-MCP-whoami-alice** MCP `whoami` for alice shows `secret` with role `admin`. **pass**

### MCP member tools + binding
- **E-MCP-bind** bob `member-list{driveId: secret}` → isError "Drive not found in org" (driveId bound to active/personal org). **pass**
- **E-MCP-bind-alice** even alice (acme admin) `member-list{driveId: secret}` → not found, because MCP active org is the caller's *personal* org (see Edge Cases). **pass**
- **E-MCP-own-drive** alice `member-list{driveId: own personal default}` → 200, members listed. **pass**
- **E-MCP-org-personal** alice `member-list{}` lists personal-org members (active-org=personal limitation). **pass**

### Comment ID scoping
- **F-SETUP** `comment-add` works in each tenant. **pass**
- **F-XT-get** cross-tenant `comment-get` (mallory reads acme comment id) → 404. **pass**
- **F-XD-get** cross-drive `comment-get` (acme comment id under acme `secret` drive) → 404. **pass**
- **F-XT-mutate** cross-tenant `comment-update`/`delete`/`resolve` → 404/404/404. **pass**
- **F-XT-reply** cross-tenant reply (parentId from acme) → 404 parent not found. **pass**
- **F-INTACT** victim comment body unchanged and not deleted after the cross-tenant attack. **pass**
- **F-DELETED** deleted comment id → 404 (treated as missing; no resurrection). **pass**

### Signed-url (RBAC at generation + bearer semantics)
- **G-VW-generate** viewer can *generate* a signed-url (op is viewer-role by design). **pass**
- **G-BEARER** the generated URL serves bytes **unauthenticated** until expiry — bearer-secret semantics, documented, not a defect. **pass**
- **G-XORG-generate** cross-org signed-url generation → 404 (binding enforced at generation time). **pass**

### Adversarial / hygiene
- **X-INVITE-ORDER** inviting a fresh user *after* `secret` exists still grants only `default` (the unscoped default-drive query in `inviteToOrg` happened to pick `default`; see Issues Found — latent). **pass**
- **X-NOAUTH** missing bearer → 401 UNAUTHORIZED. **pass**
- **X-BADKEY** invalid api key → 401 UNAUTHORIZED. **pass**

## Edge Cases & Exploratory Testing

- **No write bypass found.** Every privileged mutation path I could reach as a viewer/editor was
  denied with the correct status: JSON ops, raw PUT, default-drive fallback (no `driveId`), and the
  admin-only `reindex`. `editor` is correctly blocked from `reindex` (admin), confirming the role
  ladder, not just viewer-vs-rest.
- **Cross-tenant is a clean 404 everywhere** and *byte-indistinguishable* from "missing" for ops,
  orgs, drive-members, and raw — verified by a normalize-and-compare assertion (`B-*-shape`), so a
  prober cannot use error text to confirm a foreign resource exists.
- **MCP member management binds to the caller's *personal* org.** `getContext()` resolves the active
  context with no org/drive params, so it always lands on the personal org's default drive
  (`packages/mcp/src/server.ts` → `resolveContext(db, {userId})`). Consequence: shared-org admins
  cannot manage shared-org members *via MCP* at all, and the org-level admin gate is never exercised
  against a shared org through the real transport (the caller is always admin of their own personal
  org). The *drive-scoped* binding guard (`assertDriveInOrg` against the personal org) is the
  reachable protection, and it correctly rejects foreign/other-org drive IDs. This is fail-closed —
  not a hole — but it is a real capability limitation worth noting for hosted MCP users.
- **`PUT /raw` content-type guard precedes the role check** (`files.ts`): a viewer sending a JSON
  body gets 415, not 403. Both are denials (no write occurs), but the surfaced code depends on
  content-type. Cosmetic only.
- **Invite ordering**: `inviteToOrg` selects the default-drive membership target with an *unscoped*
  `select(drives).where(orgId).get()` (no `isDefault` filter / ordering;
  `packages/core/src/identity/orgs.ts`). In this run a post-`secret`-creation invite still landed on
  `default` (SQLite returned the first-inserted row). It works today but is order-dependent — same
  latent issue flagged in the step-1 QA. Low severity (does not over-grant in practice).

## Evidence

### Logs & Output
Full run (60/60), abridged to the load-bearing lines:

```
PASS A-VW-write viewer (bob) write op DENIED (403 PERMISSION_DENIED) :: status=403 error=PERMISSION_DENIED
PASS RAW-VW-put viewer (bob) PUT /raw DENIED (403 PERMISSION_DENIED) :: status=403 error=PERMISSION_DENIED
PASS B-OPS-shape ops foreign-drive 404 indistinguishable from missing-drive 404 ::
  foreign='Drive not found: ef71b564-...' missing='Drive not found: 00000000-...'
PASS B-NONMEMBER-ops non-member (mallory) ops on acme drive → blocked (not 200) :: status=500 error=INTERNAL_ERROR
PASS B-SAMEORG-edge same-org existence oracle :: existing(secret)=500/INTERNAL_ERROR missing=404/NOT_FOUND
PASS C-NONMEMBER-createdrive non-member create drive in acme → 404 (no existence oracle) :: status=404 error=NOT_FOUND
PASS C-DRIVEADMIN-createdrive drive admin but org viewer (dave) create drive DENIED (403) :: status=403
PASS D-VW-listdrives viewer drive list excludes 'secret', includes default :: sees=[default]
PASS D-MCP-whoami-bob MCP whoami(bob) hides 'secret' :: drives=2 hasSecret=false hasDefault=true
PASS F-XT-mutate cross-tenant comment update/delete/resolve all → 404 :: upd=404 del=404 res=404
PASS F-INTACT acme comment intact after cross-tenant attack :: body='acme comment'
PASS G-BEARER signed-url works UNAUTHENTICATED until expiry :: unauthFetchOk=true bytes=17
PASS G-XORG-generate cross-org signed-url generation → 404 :: status=404 error=NOT_FOUND
=== SUMMARY: 60/60 passed, 0 failed ===
```

### External Links
- Harness: `/tmp/qa-mtrbac.ts`
- Full log: `/tmp/qa-mtrbac-output.log`

## Issues Found

- [x] **FIXED in `72e8955`** (re-validated black-box: `thoughts/taras/qa/2026-06-10-multitenant-rbac-safety-oracle-fix.md`, OFX-1..7,9,10) — **Minor — generic `Error`→500 on drive-access failure (intra-org existence oracle).**
  `resolveContext()` throws a plain `Error("You do not have access to this drive")` instead of a typed
  `PermissionDeniedError`/`NotFoundError` at `packages/core/src/identity/context.ts:38` and
  `:59` (also the no-default-drive cases at `:56`,`:90` and personal fallback at `:93`). The error
  middleware maps untyped errors to **500 INTERNAL_ERROR**. Effects:
  - A non-member hitting `POST /orgs/{orgId}/ops` (e.g. mallory on acme) gets 500, not 403/404.
  - **Within the same org**, an existing-but-inaccessible drive returns 500 while a non-existent
    driveId returns 404 (`assertDriveInOrg`/binding fires NotFoundError first) — so a same-org member
    can distinguish "real driveId" from "fake driveId". This is an **intra-org** existence oracle.
  - The **cross-tenant** boundary is unaffected: a different-org driveId trips the org-binding
    `NotFoundError` (404) *before* the role check, so foreign existence stays unprobeable. No data is
    ever read or written on these paths (fail-closed).
  - This is pre-existing `resolveContext` behavior, but strict membership makes it more reachable.
    Recommendation: throw `PermissionDeniedError` (403) for the no-role cases so authz failures stop
    surfacing as 500 and the intra-org oracle collapses. Severity: minor (no data leak, fail-closed,
    same-tenant only).

- [ ] **Minor (informational) — MCP member management is scoped to the caller's personal org.** See
  Edge Cases. Fail-closed; flagged as a capability/documentation gap, not a vulnerability.

- [x] **FIXED in `72e8955`** (re-validated black-box: same report, OFX-8) — **Minor (latent, pre-existing) — `inviteToOrg` default-drive grant is unscoped/order-dependent**
  (`packages/core/src/identity/orgs.ts`, the `select(drives).where(orgId).get()` for the default-drive
  membership). Works today; add an `isDefault` predicate to be safe. Matches the step-1 QA observation.

## Verdict

**Status**: PASS

**Summary**: All 60 cross-surface checks passed against a real running daemon — the multi-tenant
RBAC boundary holds across HTTP ops, raw writes, admin/member management, MCP member tools and
`whoami`, comment ID scoping, and signed-url generation, with cross-tenant errors byte-identical to
"missing" (no existence oracle). No write/read bypass was found. Three minor, fail-closed
observations remain (a generic-`Error`→500 path that creates an *intra-org* existence oracle and
surfaces authz failures as 500; MCP member mgmt limited to the personal org; the latent unscoped
`inviteToOrg` default-drive grant) — none break tenant isolation; the first is worth a small typed-error fix.

## Appendix

- **Plan**: `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/root.md` (+ `step-1..6.md`)
- **Companion QA (core/step-1)**: `thoughts/taras/qa/2026-06-10-step-1-multitenant-rbac-safety.md`
- **Harness**: `/tmp/qa-mtrbac.ts` (standalone bun; isolated MinIO + real daemon; deleted-able)
- **Notes**: Validated on Darwin; FUSE live-mount write RBAC not exercised (no `/dev/fuse`), but the
  FUSE/IPC write path shares `writeRaw()` + `dispatchOp()` with the HTTP raw path proven here. The
  container and daemon spun up for this run were torn down on completion.
```
