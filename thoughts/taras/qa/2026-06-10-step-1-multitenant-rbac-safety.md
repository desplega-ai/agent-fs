---
date: 2026-06-10
author: Claude (QA sub-agent)
topic: "Step-1 multitenant-rbac-safety — core authz helpers + strict explicit drive membership"
tags: [qa, rbac, multi-tenant, drives, migrations, core]
status: pass
source_plan: thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/step-1.md
environment: local (isolated temp AGENT_FS_HOME, in-process Hono app, no MinIO/Docker)
last_updated: 2026-06-10
last_updated_by: Claude (QA sub-agent)
---

# Step-1 Multitenant RBAC Safety — QA Report

## Context

Functional validation of step-1 (uncommitted, branch `multitenant-rbac-safety`): core authorization helpers (`packages/core/src/identity/rbac.ts`), strict explicit drive membership (`drives.ts`), org/drive binding in `resolveContext()` (`context.ts`), and migration 3 backfill (`packages/core/src/db/migrate.ts`).

Working-tree diff at QA time: 9 files, +525/−50 (core identity/db + tests + plan doc).

Validation is **real functional testing**, not test rereading: two throwaway scripts ran the actual core functions and the actual HTTP app against fresh temp SQLite DBs.

- `/tmp/qa-step1-core.ts` — core-level, direct calls into `packages/core/src` with a temp `AGENT_FS_HOME` and raw SQLite verification connection. **12/12 pass.**
- `/tmp/qa-step1-http.ts` — HTTP-level, in-process `createApp(db, s3)` + `app.request()` (real routes, real auth middleware, real error handler; S3 client is a dead-end stub since no exercised route touches storage). **7/7 pass.**

Baseline: `bun test packages/core/src/identity/__tests__/identity.test.ts` → 33 pass / 0 fail; `bun run typecheck` clean; no stale `.js` files in `packages/*/src`.

## Scope

### In Scope
1. Drive creation with `creatorUserId` → explicit admin `drive_members` row + visibility in creator's `listDrivesForUser`.
2. Strict membership: same-org non-admin member without a `drive_members` row does not see the drive.
3. Cross-org binding: org A user + org B `driveId` → `NotFoundError` (core) and HTTP 404 (via `POST /orgs/:orgId/ops`).
4. Migration 3 backfill: zero-member drive + fresh DB open → org admins get admin rows; idempotency.
5. Known intermediate gap confirmation: `POST /orgs/:orgId/drives` does not yet pass `creatorUserId` (step-2 scope).

### Out of Scope
- File ops against real S3/MinIO (no storage-touching behavior changed in step-1).
- FUSE mount behavior, MCP tools, CLI commands (step-1 is core-only; later steps wire callers).
- Full `scripts/e2e.ts` regression run (deferred; core surface covered directly).

## Test Cases

### TC-1: Drive creation yields explicit creator admin membership
- **Steps**: `createUser(alice)` → `createOrg(acme, alice)` → `createDrive({orgId: acme, name: "proj", creatorUserId: alice})`; inspect `drive_members` via raw SQL; call `listDrivesForUser(db, acme, alice)`.
- **Expected**: exactly one `drive_members` row `(proj, alice, 'admin')`; `proj` in alice's list.
- **Actual**: `[{"user_id":"4f89...","role":"admin"}]`; alice sees `["default","proj"]`.
- **Status**: PASS

### TC-2: Strict membership — org member without drive_members row sees nothing
- **Steps**: `createUser(bob)`; `inviteToOrg(acme, bob, role: "editor")` (grants org membership + default-drive membership only); verify bob has no row on `proj`; call `listDrivesForUser(db, acme, bob)`.
- **Expected**: `proj` absent from bob's list.
- **Actual**: bob sees `["default"]` only.
- **Status**: PASS

### TC-3: Cross-org binding rejected (core + HTTP)
- **Steps (core)**: `createOrg(borg, carol)`; `resolveContext(db, {userId: alice, orgId: acme, driveId: borgDefaultDrive})`.
- **Expected**: throws `NotFoundError` with `code === "NOT_FOUND"`.
- **Actual**: `NotFoundError: Drive not found: a145...` — same error shape as a missing drive (no cross-tenant existence probing).
- **Steps (HTTP)**: register alice+carol via `POST /auth/register`; create orgs via `POST /orgs`; `POST /orgs/{acme}/ops` with body `{op:"ls", driveId:<borg default>}` as alice.
- **Expected**: HTTP 404, `error: "NOT_FOUND"`.
- **Actual**: `status=404 body={"error":"NOT_FOUND","message":"Drive not found: 83b9...","suggestion":"Check the driveId belongs to the org you are addressing"}`.
- **Positive control**: same route with alice's own org+drive, DB-only op `recent` → `status=200 body={"entries":[]}`. (Core control: `resolveContext` with matching org/drive returns `role: "admin"`.)
- **Status**: PASS

### TC-4: Migration 3 backfills org admins on zero-member drives
- **Steps**: raw-SQL insert a `drives` row ("legacy") with zero `drive_members` rows; confirm invisible even to org admin alice; re-open DB via `createDatabase(path)` (runs `runMigrations()`); inspect rows; re-open a third time for idempotency.
- **Expected**: post-migration exactly one row `(legacy, alice, 'admin')`; bob (editor) gets nothing; row count stays 1 on re-run.
- **Actual**: pre: 0 rows, alice sees `["proj","default"]`; post: `[{"user_id":"4f89...(alice)","role":"admin"}]`, alice sees `["legacy","proj","default"]`, bob still `["default"]`; after third open rows=1.
- **Status**: PASS

### TC-5: Known intermediate gap — HTTP drive creation lacks creatorUserId (expected, NOT a failure)
- **Steps**: `POST /orgs/{acme}/drives {name:"via-http"}` as alice; inspect `drive_members`; `GET /orgs/{acme}/drives` as alice.
- **Expected (current intermediate state)**: 201; zero member rows; drive invisible to its creator.
- **Actual**: 201; 0 member rows; alice's list = `["default"]` (no `via-http`). Matches `packages/server/src/routes/orgs.ts:52` — `createDrive(db, { orgId, name })` without `creatorUserId`. Step-2 plan item 2 explicitly covers this ("Pass the authenticated user into createDrive()").
- **Status**: PASS (gap confirmed as documented)

## Edge Cases & Exploratory Testing

- **Zero-member drive invisible to everyone, including org admins, pre-backfill** (TC-4a) — confirms "public drive" fallback is fully gone, not just narrowed.
- **Error indistinguishability**: cross-org mismatch returns the same `NOT_FOUND` shape as a genuinely missing drive — no existence oracle for cross-tenant probers.
- **Step-2-scope probe**: non-member carol `POST /orgs/{acme}/drives` → currently **201** (no route-level org role check yet). Expected intermediate state; step-2 plan item 1 covers it ("Require org admin for drive creation"). Re-verify at step-2 QA.
- **Observation (pre-existing, not step-1)**: `inviteToOrg()` grants the invitee membership on "the default drive" selected via `db.select().from(drives).where(eq(drives.orgId, orgId)).get()` **without an `isDefault` filter or ordering** (`packages/core/src/identity/orgs.ts:241-247`) — it picks the first drive row in the org. Works today because the default drive is created first, but it is order-dependent. Minor; worth a follow-up.

## Evidence

### Logs & Output

Core-level run (`bun /tmp/qa-step1-core.ts`):

```
PASS  1a: explicit admin drive_members row for creator — [{"user_id":"4f894c5d-...","role":"admin"}]
PASS  1b: drive appears in creator's listDrivesForUser — alice sees in acme: ["default","proj"]
PASS  2-pre: bob has no drive_members row on proj
PASS  2: org member without membership does NOT see drive — bob sees in acme: ["default"]
PASS  3a: cross-org resolveContext throws NotFoundError — NotFoundError: Drive not found: a145388c-...
PASS  3b: positive control — matching org/drive resolves, role=admin — {"orgId":"d9f1...","driveId":"81e3...","role":"admin"}
PASS  4-pre: legacy drive has zero member rows
PASS  4a: zero-member drive invisible even to org admin (strict membership) — alice sees: ["proj","default"]
PASS  4b: backfill grants org admin (alice) an admin row, and only her — [{"user_id":"4f89...","role":"admin"}]
PASS  4c: legacy drive now visible to org admin — ["legacy","proj","default"]
PASS  4d: backfill did NOT grant non-admin bob access to legacy — ["default"]
PASS  4e: migration idempotent on re-run — rows=1

RESULT: 12 pass, 0 fail
```

HTTP-level run (`bun /tmp/qa-step1-http.ts`, in-process `createApp` + `app.request`):

```
PASS  setup: registered alice + carol
PASS  setup: created org A (acme/alice) + org B (borg/carol)
PASS  setup: both default drives visible to their creators
PASS  3-http: POST /orgs/{orgA}/ops with orgB driveId returns 404 NOT_FOUND — status=404 body={"error":"NOT_FOUND","message":"Drive not found: 83b9dcb0-...","suggestion":"Check the driveId belongs to the org you are addressing"}
PASS  3-http positive control: own org+drive op returns 200 — status=200 body={"entries":[]}
PASS  5-pre: POST /orgs/:orgId/drives returns 201 — status=201
INFO  5-gap: HTTP-created drive has 0 member rows; creator's drive list = ["default"] (expected intermediate gap until step-2: 0 rows, drive invisible)
PASS  5: gap confirmed as documented (0 member rows, invisible to creator)
INFO  step-2-scope probe: non-member POST /orgs/{orgA}/drives -> status=201 (401/403 expected after step-2; currently permitted = known intermediate gap)

RESULT: 7 pass, 0 fail
```

Baseline:

```
bun test packages/core/src/identity/__tests__/identity.test.ts
 33 pass / 0 fail (77 expect() calls)
bun run typecheck  ->  clean
```

Harness note: an initial positive-control attempt used op `ls`, which calls `ctx.s3.listObjects` and failed (400) against the dead-end stub S3 client — harness artifact, not a product bug; switched to DB-only op `recent`.

### External Links
- Plan: `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/step-1.md`
- Step-2 (covers the confirmed gaps): `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/step-2.md`

## Issues Found

No step-1 defects. Two items confirmed as known intermediate state (step-2 scope) plus one pre-existing minor:

1. **(known/intermediate — step-2)** `POST /orgs/:orgId/drives` creates drives with no `creatorUserId` → drive has 0 member rows and is invisible to its creator (`packages/server/src/routes/orgs.ts:52`).
2. **(known/intermediate — step-2)** No route-level org role checks on `POST /orgs/:orgId/drives`: a non-member of the org can create a drive in it (201). Step-2 plan item 1 requires org admin.
3. **(minor, pre-existing)** `inviteToOrg()` default-drive grant selects the org's first drive row without `isDefault` filter/ordering (`packages/core/src/identity/orgs.ts:241-247`). Order-dependent; suggest follow-up.

## Verdict

**PASS.** All five step-1 behaviors validated functionally against real core APIs and the real HTTP app: explicit creator admin membership, strict membership visibility, cross-org 404 binding (core + HTTP), idempotent admin backfill, and the documented step-2 gap confirmed exactly as planned.

## Appendix

- Test scripts (throwaway, `/tmp` only): `/tmp/qa-step1-core.ts`, `/tmp/qa-step1-http.ts`. Each creates an isolated temp `AGENT_FS_HOME` + SQLite DB and removes it on exit.
- No Docker containers, MinIO, or daemons were started; HTTP was exercised in-process via Hono `app.request()`. Cleanup verified (no leftover temp dirs/containers/processes).
