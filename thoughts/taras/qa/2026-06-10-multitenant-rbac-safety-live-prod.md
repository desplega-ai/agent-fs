---
date: 2026-06-10T21:30:00-07:00
author: Claude
topic: "Multi-tenant RBAC safety — live production QA after merge + Fly deploy (0.8.0)"
tags: [qa, rbac, multi-tenant, production, live, cli, smoke, existence-oracle]
status: pass
source_plan: thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/root.md
related_pr: https://github.com/desplega-ai/agent-fs/pull/16 (merged, 8dca70d)
environment: production (https://agent-fs-taras.fly.dev, Fly app agent-fs-taras, version 0.8.0)
last_updated: 2026-06-10
last_updated_by: Claude
---

# Multi-Tenant RBAC Safety — Live Production QA (0.8.0)

## Context

After PR #16 merged to `main` (merge commit `8dca70d`) the Fly deploy redeployed the backend.
`GET https://agent-fs-taras.fly.dev/health` → `{"ok":true,"version":"0.8.0"}`, confirming the merged
RBAC + oracle code is serving. This pass validates the feature **against the live production
backend** — both the local `agent-fs` CLI 0.8.0 driving prod over the wire, and direct-HTTP RBAC
oracle probes confirming commit `72e8955`'s fix in production. Run as two parallel sub-agents
(workflow `wf_810f0348-547`), scratch users + data only, all created files cleaned up.

## Scope

### In Scope
1. **CLI smoke** — local `agent-fs` (0.8.0) against prod via `AGENT_FS_API_URL`/`AGENT_FS_API_KEY`:
   write/cat/append/edit/log/ls/stat/tree/signed-url/fts/search/comment/recent + rm cleanup.
2. **RBAC oracle probe** — two scratch users; cross-org/cross-drive/raw/auth denials must be
   byte-identical 404s with zero 500s (the deployed `72e8955` behavior), 401 on missing/bad auth,
   200 on legit own-drive access.

### Out of Scope
- Pre-existing user data (never touched/enumerated).
- FUSE live mount (Darwin host).
- Admin/destructive ops beyond the scratch flow.

## Test Cases

### TC-1: RBAC + existence-oracle probe over raw HTTP (8/8 pass) — PRIMARY
Two scratch users (userA, userB; no shared org/drive). userA wrote one scratch file into its
default drive (`910effa2-…`).
- **P1** userB ops on userA's org, no driveId → **404** `No default drive for org: <id>`. **pass**
- **P2** userB ops on a ghost org uuid → 404; body **byte-identical** to P1 (org id normalized).
  `P1_P2_IDENTICAL=true`. **pass**
- **P3** userB ops on its own org with `driveId=<userA's drive>` → **404** `Drive not found: <id>`
  + `suggestion`. **pass**
- **P4** userB ops with a missing driveId → 404; body **byte-identical** to P3 (driveId normalized).
  `P3_P4_IDENTICAL=true`. **pass**
- **P5** userB `GET /orgs/{userA.org}/drives/{userA.drive}/files/…/raw` → **404** (drive-level
  NOT_FOUND; resolveContext fires before file lookup — no file-existence leak). **pass**
- **P6** no Authorization header → **401**; bogus bearer → **401**. **pass**
- **P7** **no-500 sweep**: per-probe statuses `[P1:404, P2:404, P3:404, P4:404, P5:404, P6a:401,
  P6b:401, P8:200]` — `P7_ANY_500=false`. **pass**
- **P8** userB ops on its **own** org default drive → **200** (no legit-access regression). **pass**
**Status:** pass — the deployed oracle fix holds in production.

### TC-2: Local CLI 0.8.0 smoke against prod (9/10 functional steps pass)
`agent-fs --version` → 0.8.0 (matches prod). Scratch prefix `qa-live-4a8a5c5e/`.
- **write** → v1, 11 B. **pass**
- **cat** → exact bytes `hello world`. **pass**
- **append** → content `hello world more` (16 B). **pass** (cosmetic: printed `v1`; the write+append
  coalesced into a single v1 per the authoritative `log`).
- **edit** (`more`→`extra`) → v2, content `hello world extra` (17 B). **pass**
- **log** → 2 entries `[v2 edit (17B), v1 append (16B)]`. **pass**
- **ls / stat / tree** → stat authoritative (size 17, currentVersion 2, embeddingStatus indexed).
  **pass** (cosmetic: `ls` showed stale size 11 vs stat's 17).
- **signed-url** → Tigris URL; unauthenticated `GET` → 200, 17 bytes, current content. **pass**
  (bearer-secret semantics, as designed).
- **fts / search** → distinctive word found by both keyword (`fts`) and semantic (`search`,
  score 0.0327). **pass** (no embedding-latency miss).
- **comment add/list** → round-trip clean (id `79acda4b…`, body echoed, `resolved:false`). **pass**
- **recent `--since 1h`** → **FAIL** (see Issues Found). `recent` (no `--since`) and
  `recent --since <ISO>` both work and list the scratch files.
- **cleanup** → both files `rm`'d; `ls` empty; `cat` on deleted → "File not found". **pass**
**Status:** pass with one defect (the `--since` duration shorthand).

## Edge Cases & Exploratory Testing
- Production 404 bodies are **byte-identical** (not just same-status) across cross-org, cross-drive,
  and raw surfaces — confirmed in the live environment, matching the local re-validation.
- `signed-url` serves bytes unauthenticated until expiry (bearer-secret model) — works in prod.
- Semantic `search` returned the scratch file immediately — prod embedding pipeline is live.
- Harness note (not product bugs): the public register endpoint is `POST /auth/register` (not
  `/register`); and a stale local `~/.agent-fs/config.json` `defaultOrg` shadows a freshly-registered
  org, worked around with `--org` (no config mutated).

## Evidence

```
HEALTH   GET /health -> {"ok":true,"version":"0.8.0"}
TC-1     8/8 probes pass; P1_P2_IDENTICAL=true; P3_P4_IDENTICAL=true; P7_ANY_500=false
         statuses=[P1:404 P2:404 P3:404 P4:404 P5:404 P6a:401 P6b:401 P8:200]
TC-2     9/10 CLI steps pass; cleanup verified (ls empty, cat->File not found)
         FAIL: `recent --since 1h` -> {"code":"invalid_date","path":["since"],"message":"Invalid date"}
```
Workflow: `wf_810f0348-547` (2 agents). API keys redacted. All scratch files removed.

## Issues Found

- [ ] **Minor — `agent-fs recent --since <duration>` is broken (doc/contract mismatch).** The CLI
  forwards the literal duration string (`1h`) to the server; the core `recent` schema coerces
  `since` with `z.coerce.date()` (`packages/core/src/ops/index.ts:159`), so `new Date("1h")` →
  Invalid Date → `400 invalid_date`. But the CLI help and `skills/agent-fs/SKILL.md` both advertise
  `--since <duration> (e.g., 1h, 24h)`. **Fix:** translate the duration shorthand to an absolute ISO
  timestamp in the CLI before sending (`packages/cli/src/commands/ops.ts`, where `since` is currently
  passed untransformed) — keeps the core/MCP `z.coerce.date()` contract intact (still accepts ISO /
  epoch / Date). Pre-existing; unrelated to the RBAC branch; not a regression from this merge.
- [ ] **Cosmetic — `ls` size lag.** `ls` reported the original write size (11) while `stat` showed
  the current size (17). `stat` is authoritative; `ls` size appears to lag a same-window mutation.
- [ ] **Cosmetic — `append` version label.** A write immediately followed by `append` coalesced into
  a single `v1` (the printed label said `v1`); `log` is consistent. Likely intentional same-window
  coalescing; worth confirming the printed label matches intent.

## Verdict

**Status**: PASS

**Summary**: The multi-tenant RBAC + existence-oracle hardening is validated **in production**
(0.8.0): 8/8 live RBAC probes pass with byte-identical 404s and zero 500s, and the local CLI 0.8.0
round-trips cleanly against prod across 9/10 functional surfaces. The single failure
(`recent --since 1h`) is a pre-existing, RBAC-unrelated CLI/doc contract bug (duration shorthand not
translated to a date) with a clear localized fix; two further findings are cosmetic. No security or
tenant-isolation issue; the deployed fix behaves exactly as the local re-validation predicted.

## Appendix
- **PR**: https://github.com/desplega-ai/agent-fs/pull/16 (merged `8dca70d`)
- **Prior QA**: `…-multitenant-rbac-safety-full.md`, `…-multitenant-rbac-safety-oracle-fix.md`,
  `…-step-1-multitenant-rbac-safety.md`
- **Plan**: `thoughts/taras/plans/2026-06-10-multitenant-rbac-safety/root.md`
- **Notes**: Production scratch users persist (API has no user-delete); only two were created.
