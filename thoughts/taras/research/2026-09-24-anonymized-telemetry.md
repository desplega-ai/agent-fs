---
date: 2026-09-24T00:00:00+02:00
researcher: Claude
git_commit: 6619092bb6c46bb579abb35518a41f30fc95f25a
branch: main
repository: desplega-ai/agent-fs
topic: "How agent-fs could add anonymized telemetry like agent-swarm, using the existing proxy"
tags: [research, telemetry, cli, server, mcp, proxy, agent-swarm]
status: complete
autonomy: critical
last_updated: 2026-09-24
last_updated_by: Claude (review)
---

# Research: Anonymized telemetry for agent-fs (agent-swarm pattern + proxy)

**Date**: 2026-09-24
**Researcher**: Claude
**Git Commit**: 6619092bb6c46bb579abb35518a41f30fc95f25a
**Branch**: main

## Research Question

How could agent-fs add anonymized telemetry the same way `../agent-swarm` does, given that `../proxy` already runs in prod?

This document maps three systems as they exist today: the agent-swarm telemetry client, the proxy ingestion service, and the agent-fs touchpoints where a client would attach.

## Summary

agent-swarm sends telemetry through one dependency-free module, `src/telemetry.ts`. It POSTs one JSON event per call to `https://proxy.desplega.sh/v1/events`. There is no auth, no batching, and no retries. Each call has a 5s timeout and never throws. An anonymous install ID (`install_<16 hex>`) is persisted in the `swarm_config` DB table. The env var `ANONYMIZED_TELEMETRY=false` disables everything, and it is checked on every event. Tests and E2E harnesses set it to `false`. A docs page lists every event and property.

The proxy is a Go service (`apps/telemetry-ingest`) that writes to a self-hosted ClickHouse. It is not a PostHog proxy. `/v1/events` accepts any non-empty `product` string. There is no product allowlist, no per-product key, no rate limit, and no body-size cap on that path. An agent-fs client can send `"product": "agent-fs"` today with no server change. The proxy design docs name agent-fs as an intended consumer. Browser callers from agent-fs domains would hit a CORS allowlist that only covers agent-swarm domains. `/v1/feedback` is agent-swarm-shaped (`swarm_version` is required).

agent-fs has no backend telemetry today. Only the two web apps load Plausible (always on in `landing/`, build-flag gated in `live/`). All ops (CLI via HTTP, MCP, FUSE IPC) go through one function, `dispatchOp()` in `packages/core`. The server has one Hono middleware chain for every HTTP request. The CLI has no global commander hook. Persistent local state lives in `~/.agent-fs/config.json`, read and written by `getConfig()` / `setConfigValue()`. `agent-fs config get|set` works for any new key without code changes. agent-fs has two deployment shapes: a local daemon per user, and hosted servers (Fly `agent-fs-taras`, Docker/GHCR).

## Detailed Findings

### 1. agent-swarm telemetry client (the reference pattern)

**Module**: `agent-swarm/src/telemetry.ts` (604 lines). Header says "No external dependencies (uses global fetch + node:crypto)" (`telemetry.ts:1-8`). No PostHog or other SDK exists in `package.json`.

**Emitters** (the `source` field):
- `api-server`: `initTelemetry("api-server", getConfig, setConfig, { generateIfMissing: true })` at `src/http/index.ts:676-684`. Only this process mints the install ID. MCP runs in this same process.
- `worker`: `src/commands/runner.ts:4788-4820`. Workers read and write config through the API over HTTP. If no install ID exists yet, the worker sends nothing (`runner.ts:4781-4785`).

**Event envelope** (`track()`, `telemetry.ts:435-497`):
```
{ product: "agent-swarm", event, occurred_at, source,
  actor_mode: "anonymous", actor_anonymous_id: installationId,
  properties: { ...callerProps, is_cloud, is_e2b, swarmVersion, has_* booleans, install_method },
  metadata:   { transport: "https", schema_version: 1, environment, is_cloud,
                organization_id?, organization_name?, install_preset?, install_created_at?, ...callerMetadata } }
```
Cohort fields spread last so callers cannot overwrite them (`telemetry.ts:459-469`, tests at `src/tests/telemetry-init.test.ts:466-479`).

**Event names**: namespaced helpers (`telemetry.ts:526-583`) produce `server.*`, `task.*`, `session.*`, `schedule.*`, `workflow.*`, `integration.connected`, `compaction.triggered`. The full table is in `docs-site/content/docs/(documentation)/reference/telemetry.mdx:12-33`.

**Install ID** (`telemetry.ts:307-390`):
- Key `telemetry_installation_id` in `swarm_config`. Format `install_` + 16 hex chars from `randomUUID()` (`telemetry.ts:348`).
- If the config read fails, the server uses an unpersisted `ephemeral_<hex>` ID (`telemetry.ts:356-362`).
- `telemetry_installed_at` is written only with a new ID. Old installs never get a backfilled date (`telemetry.ts:333-346,380-390`).

**Anonymization rules**:
- No task content, prompts, outputs, agent names, or error messages (`telemetry.mdx:10,52`).
- Hostnames reduce to a boolean `is_cloud` (`telemetry.ts:70-72`).
- Free-form strings map to closed enums or are dropped (`KNOWN_INSTALL_PRESETS`, `IntegrationProvider`, `telemetry.ts:118-249`). Tests cover PII-looking input (`telemetry-init.test.ts:901-916,953-967`).
- Channel/key presence is sent only as booleans (`telemetry.ts:256-285`).
- Exception: `SWARM_ORG_ID` / `SWARM_ORG_NAME` are sent when an operator sets them (`telemetry.ts:399-412`).

**Transport** (`telemetry.ts:14-16,488-496`): `POST`, header `Content-Type: application/json` only. One `fetch` per event. `AbortSignal.timeout(5000)`. `.catch(() => {})` plus an outer try/catch. No queue, no retry.

**Opt-out**:
- `ANONYMIZED_TELEMETRY` (default `true`), parsed by `isEnvFlagEnabled` (`telemetry.ts:29-31`, `src/utils/env-flag.ts:49-55`). Checked at init and on every `track()` (`telemetry.ts:313,436`).
- When off: no events, no install ID written (`telemetry.mdx:82-85`).
- `DESPLEGA_TELEMETRY_ENV` sets `metadata.environment`. Default is `production`, and `test` when `NODE_ENV=test` (`telemetry.ts:424-432`).
- No interactive consent prompt. Disclosure is docs plus `.env.example:237-244`.

**Tests / CI**: E2E SUT sets `ANONYMIZED_TELEMETRY: "false"` (`scripts/e2e/sut.ts:159`). Eval sandboxes pin `DESPLEGA_TELEMETRY_ENV=test` (`CHANGELOG.md:632`, #974). Unit tests stub `globalThis.fetch` and force the flag on (`telemetry-init.test.ts:23`).

**Docs**: `reference/telemetry.mdx` (events, anonymization, ID lifecycle, opt-out, endpoint) and `reference/environment-variables.mdx:495-500`.

**History**: no single design doc. Decisions are in `CHANGELOG.md` entries #325 (initial), #476, #826, #901, #974, #1022-1026, #1324.

Note: agent-swarm also has a separate OpenTelemetry surface (`src/otel.ts`) for self-hosted tracing. It is unrelated to the proxy.

### 2. Proxy (`../proxy`, telemetry-ingest)

**What it is**: a Go service that validates events against an OpenAPI contract and writes them to ClickHouse table `raw_events` (`docs/telemetry-ingest.md:1-19`). The origin brainstorm names agent-swarm, desplega.ai, and agent-fs as intended consumers (`thoughts/taras/brainstorms/2026-04-09-telemetry-service-monorepo.md:16`).

**Endpoints** (`handler.go:92-98`, `contracts/telemetry/openapi.yaml:27-135`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/events` | one telemetry event, returns `202 {status, ingest_id}` |
| POST | `/v1/feedback` | one feedback submission (agent-swarm-shaped) |
| GET | `/health`, `/healthz` | liveness |
| GET | `/ready`, `/readyz` | ClickHouse ping |

**Event contract** (`openapi.yaml:162-292`, validation `handler.go:162-258`):
- Required: `product`, `event`, `occurred_at` (RFC3339), `source`, `actor_mode`, `properties` (object), `metadata` (object).
- Optional: `tier`, `actor_org_id`.
- `actor_mode: anonymous` requires `actor_anonymous_id` and forbids `actor_id` / `actor_email`.
- `actor_mode: identified` requires the shared header `X-Telemetry-Identified-Token` (`TELEMETRY_IDENTIFIED_TOKEN`). Without the env var, identified events get 403.
- Strict decode: `DisallowUnknownFields`, no trailing JSON (`handler.go:165-178`). An extra top-level field fails the request.

**Product onboarding**: none needed. `product` is an open string (`handler.go:182-185`, `openapi.yaml:188-191`). No allowlist or per-product key exists. The implementation plan kept real product integrations out of scope (`thoughts/taras/plans/2026-04-09-telemetry-service-monorepo-implementation.md:58`).

**Product-specific code in the proxy**:
- CORS default allowlist covers only `agent-swarm.dev`, `agent-swarm.cloud` and subdomains, plus localhost (`cors.go:73-84`). `FEEDBACK_CORS_ALLOWED_ORIGINS` replaces the whole default list (`cors.go:48-60`). CORS affects only browser callers. CLI and server calls send no `Origin`.
- `/v1/feedback` fields are agent-swarm-specific: required `swarm_version`, and `user_id` / `install_id` described as agent-swarm identifiers (`openapi.yaml:26,355-365`).

**Limits**: `/v1/events` has no rate limit and no app-level body cap. `/v1/feedback` has 5 req/min per IP and an 8 KiB cap (`rate_limit.go`, `feedback.go:17,77`).

**Privacy on the server**: no IP column in `raw_events` or `feedback_submissions`. The IP is used only in memory by the feedback rate limiter (`rate_limit.go:19-57`).

**Storage**: ClickHouse over HTTP (`store.go:78-90,129-146`). `environment` and `environment_version` are lifted from `metadata` into typed columns (`store.go:171-172,236-256`). Derived views in `infra/clickhouse/init/002_derived_views.sql` group by `product`.

**Deployment**: `docker-compose.prod.yml` (ClickHouse + telemetry-ingest) and root `Dockerfile`. `proxy.desplega.sh` appears in the proxy repo only as a docs example. The live evidence that it serves traffic is the agent-swarm constant `TELEMETRY_ENDPOINT` and Taras's statement that it runs in prod.

**Client helpers**: `contracts/telemetry/generated/types.ts` (TS types from the OpenAPI spec), `tools/telemetry-ts-client/smoke.ts` (example caller), `contracts/telemetry/examples/*.json` (fixtures), and copy-paste clients in `docs/integration-guide.md`. No published SDK.

### 3. agent-fs today

**Existing analytics**: only Plausible in the web apps.
- `landing/index.html:59-64`: always-on snippet.
- `live/vite.config.ts:1-52`: injected only when `VITE_PLAUSIBLE_ANALYTICS` is true. `DEPLOYMENT.md:45-58` says self-hosted and local builds ship with no analytics.
- No telemetry, Sentry, OTel, `DO_NOT_TRACK`, or CI detection in `packages/*` runtime code.

**Version**: `VERSION` from root `package.json` (`packages/core/src/version.ts:1-3`, currently `0.13.8`). Used by CLI `--version`, MCP server info, and `/health` (`packages/server/src/app.ts:47`).

**Central op dispatch**: `dispatchOp()` in `packages/core/src/ops/index.ts:326-360`. It looks up the op in `opRegistry` (30 ops, `ops/index.ts:47-324`), checks RBAC, validates with Zod, and runs the handler. Callers:
- HTTP `POST /orgs/:orgId/ops` (`packages/server/src/routes/ops.ts:9-44`), which the CLI uses via `ApiClient.callOp()` (`packages/cli/src/api-client.ts:72-74`).
- MCP tools, registered in `packages/mcp/src/tools.ts:8-63`.
- FUSE IPC (`packages/server/src/ipc/handlers.ts`). Raw byte writes use `writeRaw` instead (`handlers.ts:323,343,367`).
- Raw HTTP upload/download routes (`api-client.ts:84-210`) also bypass `dispatchOp`.

All ops therefore execute inside the server/daemon process, not in the CLI process.

**Server request pipeline** (`packages/server/src/app.ts:19-79`): CORS, `requestLogMiddleware` (`middleware/request-log.ts:12-31`, logs method, path, ms, user), 50MB body limit, auth, rate limit, `onError(handleError)` (`middleware/error.ts:11-37`).

**Server startup** (`packages/server/src/index.ts:1-127`): reads config, opens SQLite, creates the storage adapter and embedding provider, builds the app, calls `Bun.serve()`, starts the lag watchdog and FUSE IPC socket, and registers SIGTERM/SIGINT shutdown (`index.ts:118-126`).

**CLI** (`packages/cli/src/index.ts:1-153`): commander. Global flags `--org`, `--drive`, `--json` (`index.ts:27-29`). Command families are added at `index.ts:108-124`. No `preAction` / `postAction` hook. Each command has its own try/catch and `process.exit(1)` (e.g. `commands/ops.ts:236-247`). `agent-fs mcp` and `agent-fs server` re-exec the MCP and server entrypoints (`index.ts:127-140`).

**MCP**: `agent-fs mcp` is a stdio-to-HTTP bridge (`packages/mcp/src/index.ts:1-53`). The real `McpServer` is mounted in the daemon at `/mcp` (`packages/server/src/app.ts:50-69`, `packages/mcp/src/server.ts:39-93`). MCP tool calls run in the daemon process.

**Config and state** (`packages/core/src/config.ts`):
- Home: `AGENT_FS_HOME` or `~/.agent-fs` (`resolveHome()`, `config.ts:13`). Contains `config.json`, `agent-fs.db`, `.pid`, `.log`, `.sock`, `storage/`.
- `AgentFSConfig` (`config.ts:66`) has no telemetry field or install ID today.
- `getConfig()` re-reads disk on every call and applies env overrides (`applyEnvOverrides` at `config.ts:203`, `getConfig` at `config.ts:277`). `setConfigValue(path, value)` persists a dot-path (`config.ts:300`).
- `agent-fs config get|set|list` handles any dot-path key (`packages/cli/src/commands/config-cmd.ts:17-48`). `config validate` prints a status checklist (`config-cmd.ts:58-187`).
- Nearest existing "mint once, persist" pattern: `ensureLocalUser()` writes a generated API key into `config.auth.apiKey` (`packages/core/src/identity/bootstrap.ts:10-23`). User IDs use `crypto.randomUUID()` (`identity/users.ts:22,84`).
- First-run flow: `agent-fs onboard` / `init` (`packages/cli/src/commands/onboard.ts:21-141`). It prompts interactively unless `-y`.

**Deployment shapes**:
- Local: `onboard` + `daemon start`, daemon on `127.0.0.1:7433` (`config.ts:109-118`, `docs/deployment.md:5-42`). Each local install has its own `config.json` and SQLite DB.
- Team server: same binary with `--host 0.0.0.0` (`docs/deployment.md:82-137`).
- Hosted: `Dockerfile` (`AGENT_FS_HOME=/data`), `fly.toml` app `agent-fs-taras` with a volume at `/data`, GHCR images (`DEPLOYMENT.md:60-69`).
- On hosted deploys, `config.json` lives on the `/data` volume, so a value written there persists across restarts.

**CI / tests**:
- `scripts/e2e.ts` starts an isolated backend and daemon. Every spawned process gets its env from `testEnv()` (`scripts/e2e.ts:89`, used at `:159`, `:169`). CI runs `--local-only`.
- Server unit tests (`packages/server/src/__tests__/{api,server,files-raw,profile,capability-gating,upload-limit}.test.ts`) build the app with `createApp()` directly. They do not run `packages/server/src/index.ts`. Code placed in `index.ts` does not run in these tests. Code placed in `createApp()` or `dispatchOp()` does.
- No telemetry kill switch exists because no telemetry exists.

**Docs**: no privacy or telemetry doc. Env vars are listed in `DEPLOYMENT.md:154-174`. `AGENT_FS_MAX_UPLOAD_BYTES` (added in HEAD `6619092`) is also read by the server. `docs/` has no telemetry page. `PRODUCT.md` says nothing about data collection.

### 4. Pattern mapping (agent-swarm element to agent-fs equivalent that exists today)

| agent-swarm element | agent-fs equivalent today |
|---|---|
| `src/telemetry.ts`, dependency-free fetch | None. `packages/core` is shared by CLI, server, MCP |
| `api-server` process mints the install ID | Daemon / server process (`packages/server/src/index.ts`) |
| `worker` source | No worker. CLI, MCP bridge, and FUSE helper all call the daemon |
| Install ID in `swarm_config` DB table | `~/.agent-fs/config.json` via `setConfigValue` (or SQLite `agent-fs.db`) |
| `server.started` / `shutdown` hooks | `Bun.serve()` start and SIGTERM/SIGINT handlers in `server/src/index.ts` |
| Task/session lifecycle call sites | `dispatchOp()` (one choke point for all 30 ops) plus raw upload/download routes |
| `ANONYMIZED_TELEMETRY` env flag | Env overrides in `applyEnvOverrides` (`config.ts:203`), `config set` |
| `swarmVersion` property | `VERSION` from `packages/core/src/version.ts` |
| `is_cloud` / `SWARM_CLOUD` | No equivalent signal. Fly sets `AGENT_FS_HOME=/data`, `SERVER_HOST=0.0.0.0` |
| `install_method` / `install_preset` via onboard wizard | `agent-fs onboard` flow (`onboard.ts`) |
| E2E sets `ANONYMIZED_TELEMETRY=false` | `scripts/e2e.ts` spawns the daemon, no kill switches yet |
| `reference/telemetry.mdx` | `docs/` + `landing/content/markdown.ts` for `/llms.txt` |
| Proxy product `agent-swarm` | `agent-fs` accepted with no proxy change |

## Code References

| File | Line | Description |
|------|------|-------------|
| `../agent-swarm/src/telemetry.ts` | 14-16 | Endpoint `https://proxy.desplega.sh/v1/events`, 5s timeout |
| `../agent-swarm/src/telemetry.ts` | 307-390 | Install ID mint, persist, ephemeral fallback |
| `../agent-swarm/src/telemetry.ts` | 435-497 | `track()` envelope and fire-and-forget POST |
| `../agent-swarm/src/telemetry.ts` | 526-583 | Namespaced event helpers |
| `../agent-swarm/src/http/index.ts` | 676-684 | Server-side `initTelemetry` |
| `../agent-swarm/scripts/e2e/sut.ts` | 159 | E2E disables telemetry |
| `../agent-swarm/docs-site/content/docs/(documentation)/reference/telemetry.mdx` | 12-85 | Public telemetry docs |
| `../proxy/contracts/telemetry/openapi.yaml` | 162-292 | Event schema |
| `../proxy/apps/telemetry-ingest/internal/httpapi/handler.go` | 162-258 | Strict decode and validation |
| `../proxy/apps/telemetry-ingest/internal/httpapi/cors.go` | 48-84 | CORS default allowlist (agent-swarm only) |
| `../proxy/apps/telemetry-ingest/internal/store/clickhouse/store.go` | 129-256 | ClickHouse insert, env columns |
| `../proxy/contracts/telemetry/generated/types.ts` | - | Generated TS types |
| `packages/core/src/ops/index.ts` | 326-360 | `dispatchOp()` choke point |
| `packages/core/src/config.ts` | 13, 66, 203, 277, 300 | `resolveHome`, `AgentFSConfig`, `applyEnvOverrides`, `getConfig`, `setConfigValue` |
| `packages/core/src/version.ts` | 1-3 | `VERSION` |
| `packages/server/src/index.ts` | 1-127 | Daemon startup and shutdown |
| `packages/server/src/app.ts` | 19-79 | HTTP middleware chain, `/mcp` mount |
| `packages/cli/src/index.ts` | 26-140 | CLI commander setup |
| `packages/cli/src/commands/onboard.ts` | 21-141 | First-run flow |
| `packages/cli/src/commands/config-cmd.ts` | 17-187 | `config get/set/list/validate` |
| `packages/mcp/src/tools.ts` | 8-63 | MCP tool registration over `dispatchOp` |
| `live/vite.config.ts` | 1-52 | Plausible, build-flag gated |
| `landing/index.html` | 59-64 | Plausible, always on |
| `DEPLOYMENT.md` | 45-58, 154-174 | Analytics note, env var list |

## Decisions (from Taras's review, 2026-09-24)

- **Emitter**: the API server (daemon or hosted server) only. The CLI process does not send events.
- **Hosted vs self-hosted**: the Fly prod server sends the same events. Events carry an `is_cloud`-style flag. agent-fs has no cloud signal today, so the plan must define one.
- **Install ID**: random `install_<hex>` saved in `config.json`, like agent-swarm. Taras asked about a deterministic hash. A machine-ID hash can change on each Docker/Fly deploy, so the random ID won. On Fly, `config.json` lives on the `/data` volume, so the ID stays stable.
- **Event granularity**: the goal is adoption and growth, not per-op tracing. Prefer overall metrics (for example, server start, periodic counts) over one event per `dispatchOp()` call.
- **Opt-out**: honor both `ANONYMIZED_TELEMETRY=false` and `DO_NOT_TRACK`. The common `DO_NOT_TRACK` convention treats `1` (any non-empty, non-`0` value) as opt-out. agent-swarm does not read `DO_NOT_TRACK` today.
- **Consent UX**: a note in the docs only. No prompt in `onboard`.
- **Proxy host**: `https://proxy.desplega.sh/v1/events`, the same endpoint agent-swarm uses.
- **Browser telemetry**: the `live/` web UI also sends anonymous events to the proxy. `live/` is served at `live.agent-fs.dev` (`DEPLOYMENT.md:47`). The proxy CORS allowlist (`cors.go:73-84`) must then include that origin.

## Open Questions

- Which exact events and properties give adoption and growth signals (for example, a daily heartbeat with op counts, drive count, storage backend)?
- How does `live/` get an anonymous ID (browser `localStorage`), and does it link to the server install ID?
- How do adoption metrics count the hosted server? One Fly deploy is one install ID, but it serves many orgs and users. Per-install events alone do not show hosted growth. Aggregate counts (orgs, users, drives) on the server heartbeat would.
- Where does the kill switch attach for tests? `testEnv()` covers E2E. Server unit tests call `createApp()`, so they see telemetry only if the code lives in `createApp()` or `dispatchOp()`.
- How is the CORS change delivered: a code change in `cors.go`, or `FEEDBACK_CORS_ALLOWED_ORIGINS` (which replaces the defaults)?

## Appendix

- **Architecture notes**: agent-swarm keeps telemetry in one file with no SDK. The proxy accepts any product and needs no onboarding. In agent-fs, the daemon is the one process that sees every op, MCP call, and FUSE call.
- **Release checklist (agent-fs CLAUDE.md)**: a telemetry change touches core/CLI/server, so a plan must include `skills/agent-fs/SKILL.md` review, `scripts/e2e.ts` coverage (at least a kill switch in the spawned daemon env), and `./scripts/release.sh <version>`.
- **Historical context (from thoughts/)**:
  - `../proxy/thoughts/taras/brainstorms/2026-04-09-telemetry-service-monorepo.md`: proxy built for agent-swarm, desplega.ai, agent-fs.
  - `../proxy/thoughts/taras/plans/2026-04-09-telemetry-service-monorepo-implementation.md:58`: product integrations deferred.
  - agent-fs `thoughts/` has no prior telemetry research.

## Review Errata

_Reviewed: 2026-09-24 by Claude_

### Applied
- [x] `config.ts` line references were stale (HEAD `6619092` changed the file). Updated to current lines. (auto-applied)
- [x] Env var list missed `AGENT_FS_MAX_UPLOAD_BYTES`. Added. (auto-applied)
- [x] Test surface was incomplete: server unit tests call `createApp()` directly, and E2E uses `testEnv()`. Added, because it decides where a kill switch must attach. (auto-applied)
- [x] Browser decision did not name the origin. Added `live.agent-fs.dev`. (auto-applied)
- [x] `DO_NOT_TRACK` semantics were not stated. Added the common convention. (auto-applied)
- [x] Adoption-metrics gap for the multi-tenant hosted server. Added as an open question. (auto-applied)
