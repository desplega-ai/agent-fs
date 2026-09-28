---
date: 2026-09-24T12:00:00Z
topic: "Anonymized telemetry for agent-fs"
status: done
---

# Anonymized telemetry for agent-fs

## Goal

The agent-fs server sends anonymous adoption events to `https://proxy.desplega.sh/v1/events` (product `agent-fs`): `server.started` at boot and `server.heartbeat` every 24h with aggregate counts. The `live/` web UI sends one `live.session_started` per browser session. `ANONYMIZED_TELEMETRY=false` or `DO_NOT_TRACK` turns it off. Docs describe what is sent. The proxy accepts browser calls from `*.agent-fs.dev`.

Research: `thoughts/taras/research/2026-09-24-anonymized-telemetry.md`.

## Decisions

- Install ID write touches only `telemetry.installId` in the raw config file, because `setConfigValue` persists env overrides (S3 keys) to disk (assumed).
- Emitter is the API server only, not the CLI process (asked).
- Hosted and self-hosted both send. `AGENT_FS_CLOUD=true` (set in `fly.toml`) marks hosted events with `is_cloud` (asked, env name assumed).
- Install ID: random `install_<16 hex>` in `config.json` at `telemetry.installId` (asked).
- Events: `server.started` + 24h `server.heartbeat` with counts and op counts since the last beat. No per-op events (asked).
- Opt-out: `ANONYMIZED_TELEMETRY=false` and `DO_NOT_TRACK` (any value except empty/`0`/`false`/`no`/`off`) (asked).
- Consent: docs note only (asked).
- `live/` sends `live.session_started` (asked). Enabled in production builds by default. `VITE_ANONYMIZED_TELEMETRY=false` at build time or browser `navigator.doNotTrack === "1"` disables it (assumed, mirrors the server default-on).
- Storage provider is sent through an allowlist (`minio|s3|r2|tigris|local`, else `other`), because `s3.provider` is an open string (assumed).
- Proxy: add `agent-fs.dev` + HTTPS subdomains to the default CORS policy, pushed to proxy `main` (asked). Done in `96f3faa`.
- agent-fs ships as branch + PR with a patch release bump (asked).

## Todo

- [x] Proxy CORS change, tests, push to main (`96f3faa`)
- [x] `packages/core/src/telemetry.ts`: enable check, install ID, `track`, op counters, `startServerTelemetry`
- [x] Count ops in `dispatchOp()` and `writeRaw()`
- [x] Start telemetry in `packages/server/src/index.ts`
- [x] `AGENT_FS_CLOUD=true` in `fly.toml`
- [x] Kill switch in `scripts/e2e.ts` `testEnv()`, `scripts/e2e-remote-mount.ts`, `daemon-respawn.test.ts`
- [x] Core unit tests for telemetry
- [x] `live/` session event
- [x] Docs: `docs/telemetry.md`, `DEPLOYMENT.md` env table, landing docs index, skill check
- [x] Release bump + PR

## Verification

- `bun run typecheck`
- `bun test packages/core/src/__tests__/telemetry.test.ts`
- `bun run test`
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
- `cd live && pnpm build`
- `cd ../proxy && go test ./... ./apps/telemetry-ingest/...`

## Review notes

- Standards: trimmed `@/core` barrel to `startServerTelemetry` only (fixed). Kept a colon separator in `landing/content/markdown.ts` instead of the em dash sibling lines use (house rule: no em dashes).
- Spec: e2e `localEnv()` and the Docker FUSE container lacked the kill switch (fixed: `process.env` set at the top of `scripts/e2e.ts`, plus the container env). `DO_NOT_TRACK` docs now match code (`no`/`off` also count as unset). Docs now list metadata fields and `DESPLEGA_TELEMETRY_ENV`.
- Minor, not fixed: first heartbeat fires 24h after boot, and op counts are lost on restart, so short-lived laptop daemons report only `server.started`. FUSE `stat`/`ls` inflate `ops_stat`/`ops_ls`. No test covers the heartbeat interval or the `dispatchOp` counter wiring.
- Prod check: proxy `/v1/events` accepted an `agent-fs` test event (202), and preflight from `https://live.agent-fs.dev` returns `Access-Control-Allow-Origin` after `96f3faa` deployed.
