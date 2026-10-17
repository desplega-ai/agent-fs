# Deployment

This file covers **what gets deployed and where**. For how a release is cut, tagged, and published — plus recovery when a publish fails — see **[RELEASING.md](./RELEASING.md)**.

## Release Process

Releases are automatic: a version change landing on `main` tags and publishes.

```bash
./scripts/release.sh 0.13.0
```

Full process, version-sync rules, and recovery steps: **[RELEASING.md](./RELEASING.md)**.

## npm Package

- **Name:** `@desplega.ai/agent-fs`
- **Scope:** public
- **Runtime:** Bun-only (`engines.bun >= 1.4.0`)
- **Contents:** Bundled CLI (`dist/cli.js`) with external npm dependencies

### just-bash Adapter Package

- **Name:** `@desplega.ai/agent-fs-just-bash`
- **Scope:** public
- **Contents:** ESM TypeScript build exposing `AgentFsFileSystem`, a structurally compatible implementation of the `just-bash` async filesystem interface

### Install

```bash
bun add -g @desplega.ai/agent-fs
agent-fs --help
```

## Build Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Bundle CLI for npm to `packages/cli/dist/cli.js` |

## Manual npm Publish

A last resort for when GitHub Actions itself is broken — see [Publishing from a laptop](./RELEASING.md#publishing-from-a-laptop) in RELEASING.md.

## Live UI (Vercel)

The `live/` app is deployed at `live.agent-fs.dev`. Plausible analytics is opt-in
at build time. Only our hosted deployment sets the flag; self-hosted and local
builds ship with no analytics script by default.

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `VITE_PLAUSIBLE_ANALYTICS` | Off | Set to `1` or `true` (case-insensitive, whitespace trimmed) to inject the Plausible script and init snippet at build time. |
| `VITE_PLAUSIBLE_SCRIPT_ID` | `4ExgxHDFIoeAnKsDUlJ1U` | Override the Plausible site script ID (the `pa-<id>.js` part). Whitespace is trimmed; empty values use the default. |

To enable production analytics, set `VITE_PLAUSIBLE_ANALYTICS=1` in the Vercel
project for `live` and rebuild/redeploy. Changing these variables requires a new
build.

Separately, production builds of `live` send one anonymous `live.session_started`
telemetry event per browser session (see [docs/telemetry.md](./docs/telemetry.md)).
Build with `VITE_ANONYMIZED_TELEMETRY=false` to remove it.

## Docker / GHCR

Pre-built multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR on every release.

```bash
docker pull ghcr.io/desplega-ai/agent-fs:latest
docker run -d -p 7433:7433 -v agent-fs-data:/data ghcr.io/desplega-ai/agent-fs:latest
```

Images are tagged with the full version (`0.2.0`), major.minor (`0.2`), major (`0`), git SHA, and `latest`. Browse available tags at [ghcr.io/desplega-ai/agent-fs](https://github.com/desplega-ai/agent-fs/pkgs/container/agent-fs).

### Live UI image

Each release also publishes `ghcr.io/desplega-ai/agent-fs-live` with the same tags: the `live/` app served by nginx on port 8080 as a non-root user, with `/healthz` for probes. It needs only `/tmp` writable:

```bash
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges -p 8080:8080 ghcr.io/desplega-ai/agent-fs-live:<version>
```

Use the same `<version>` as your server image, and enter the server URL and API key in the UI. `VITE_*` values are compiled in, so runtime env vars do not configure it. The image is built with `VITE_ANONYMIZED_TELEMETRY=false`, so it sends no telemetry. To opt in, build it with `docker build -f Dockerfile.live --build-arg VITE_ANONYMIZED_TELEMETRY=true .`.

To keep the UI and the API on one origin (no CORS), serve the API under a path prefix such as `/fs` on the UI host, strip the prefix before it reaches the server, and enter `https://<ui-host>/fs` as the endpoint. The API's own routes (`/orgs/...`) collide with the UI's routes, so they cannot share the root. Check an image locally with `bash scripts/smoke-live-image.sh <image>`.

## Fly.io Deployment

### Quick Start (Interactive Script)

The deploy script walks you through app creation, storage provisioning, and deployment:

```bash
git clone https://github.com/desplega-ai/agent-fs && cd agent-fs
bun run scripts/fly-deploy.ts
```

Pass `-y` to accept all defaults (app name `agent-fs`, region `ord`, Tigris storage, `shared-cpu-1x`):

```bash
bun run scripts/fly-deploy.ts -y
```

### Manual Setup

If you prefer to run the `fly` commands yourself:

```bash
# 1. Create the app (uses fly.toml from the repo)
fly launch --no-deploy --copy-config

# 2. Create a persistent volume for SQLite data
fly volumes create agent_fs_data --size 1 --region ord -y

# 3. Provision storage (pick one)

# Option A: Tigris (zero-config, auto-injects AWS_* env vars)
fly storage create

# Option B: BYOK S3-compatible storage
fly secrets set \
  S3_ENDPOINT=https://your-s3-endpoint.com \
  S3_BUCKET=your-bucket \
  S3_ACCESS_KEY_ID=your-key \
  S3_SECRET_ACCESS_KEY=your-secret

# 4. Deploy
fly deploy
```

After deployment, register your first API key:

```bash
curl -X POST https://your-app.fly.dev/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

### Tigris vs BYOK Storage

| | Tigris | BYOK (Bring Your Own) |
|---|---|---|
| **Setup** | `fly storage create` — zero config | `fly secrets set S3_*=...` |
| **Auth** | Auto-injected `AWS_*` env vars | Manual secret management |
| **Regions** | Globally distributed via Tigris CDN | Depends on your provider |
| **Cost** | Included in Fly.io billing | Separate billing |
| **Use case** | Default — simplest path | When you need a specific provider (AWS S3, Cloudflare R2, MinIO, etc.) |

### Instance Sizing

| Size | CPU | Memory | Use Case |
|------|-----|--------|----------|
| `shared-cpu-1x` | 1 shared | 256–512 MB | Development, personal use |
| `shared-cpu-2x` | 2 shared | 512 MB–1 GB | Small teams, moderate traffic |
| `performance-1x` | 1 dedicated | 2 GB | Production, heavy embedding workloads |

The repo's `fly.toml` uses `performance-1x` with 2 GB. On `shared-cpu-1x`, a large index (100k+ chunks) used up the shared CPU budget: searches took seconds and health checks failed. `flyctl deploy` applies the `[[vm]]` size on every deploy, so a manual `fly scale vm` is undone by the next one. Adjust in `fly.toml` under `[[vm]]` or pass the instance size when prompted by the deploy script.

## Upgrading to 0.13.1: search index migration

0.13.1 changes how the full-text index is stored. Before, every write (including binary uploads) scanned the whole index twice to find one row, which on a GB-scale index froze the daemon for tens of seconds per write. The new layout keys the index by `(drive, path)`, so writes are constant-time again.

Existing databases migrate themselves on the first start of 0.13.1:

1. **At startup, before listening:** one new index on `content_chunks` is built. This reads the table once. Budget roughly 10-20 s per GB of database on a laptop, several minutes on a `shared-cpu-1x` Fly machine. `/health` is not served during this step.
2. **In the background, after listening:** the old index rows are copied into the new layout in small committed batches. Progress is logged as `search index migration: ...`. A restart resumes where it left off. Search stays complete during the copy: both layouts are queried until the copy finishes. Expect a few multi-second stalls on large indexes (FTS5 merges and the final drop of the old table), then nothing.

Nothing to do by hand. If you prefer the startup cost outside a traffic window, start the new version once off-peak. If search results ever look incomplete after an upgrade, `agent-fs reindex` rebuilds the index from storage.

## Upgrading to 0.16.5: embeddings re-embedded

0.16.5 stores every embedding at unit length, so `vec-search` scores are cosine similarity (1 is identical, about 0.3 is unrelated) instead of `1 / (1 + distance)`. The local model returns vectors with a norm near 23, so the old scores sat near 0.05 for every result.

On the first start, the daemon marks every indexed file `pending` and embeds it again in the background, one file at a time, in the same embedding slots that new writes use. Progress is logged as `embedding migration: ...`, and a restart resumes. Search keeps working meanwhile. The same re-embed runs again whenever the embedding provider changes.

The re-embed pauses after each file so it uses at most a quarter of the CPU time (`AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE`, default `0.25`). Requests run during the pauses. A `shared-cpu-1x` Fly machine gets a guaranteed 1/16 of a core and runs out of burst budget during a long re-embed. The API then answers in seconds and health checks fail. On such a machine, either set `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE=0.05` or scale up for the run (`fly scale vm performance-1x`), then scale back. Set `1` to run at full speed on a dedicated host.

Text files larger than 2,000,000 characters are not embedded, on write or in the re-embed. Chunking them blocked the daemon for many minutes, and their batch was over the OpenAI request limits anyway. Their status is cleared, like a binary file.

## Upgrading to 0.16.6: local embeddings re-embedded

Only the `local` provider is affected. Before 0.16.6 it embedded in batches of 512 tokens, so a chunk longer than that got a wrong vector. That was 60% of the chunks in a sample corpus. 0.16.6 embeds each chunk in one batch.

On the first start, the daemon re-embeds every file once more, in the background, the same way as in 0.16.5. If the 0.16.5 run has not finished yet, the two runs merge: files still `pending` are embedded once, with the fixed batch. `openai` and `gemini` keep their vectors, and nothing runs for them.

## Vector search cost

`vec-search` and the semantic half of `search` compare the query with every stored chunk vector, in one scan per search. The cost grows with the total chunk count across all drives: on a dedicated CPU, 150k chunks take about 400 ms per scan.

The scan runs on a worker thread with its own read-only connection, so a slow search never stalls other requests or `/health`. Right after start, the worker scans once to load the vectors into the OS page cache. On a large index that takes a while (about 25 s for 470 MB of vectors on a Fly volume), and searches sent meanwhile wait for it.

0.16.7 had an opt-in `AGENT_FS_VECTOR_INDEX=int8` index. It was slower than the exact scan on a real disk, so 0.16.8 removes it and drops its table on start.

## Upgrading to 0.17.1: failed embeddings retried once

Until 0.17.1 nothing retried a file whose embedding failed. Three causes are fixed:
- Blank text sent an empty request, which providers reject. Blank files are now skipped, like binary files.
- OpenAI got a large file in one request, over its limits of 2,048 inputs and 300,000 tokens. The OpenAI provider now splits a file into several requests.
- A transient error (rate limit, network) left the file failed for good.

Chunking a large file used to block the server for seconds (a 1.4 MB CSV took over 9 s on a laptop), which can fail health checks. Text over 64 KB is now chunked in segments, with a yield to the event loop between them.

On the first start of 0.17.1, every `failed` file is marked `pending` and the background job embeds it again, with the same CPU pacing as a re-embed. This happens once (and again after a provider change). The log names each file that still fails, with the provider error.

## Upgrading to 0.17.0: explicit EMBEDDING_PROVIDER wins

An explicit, non-empty `EMBEDDING_PROVIDER` now takes priority over `OPENAI_API_KEY` and `GEMINI_API_KEY`.
The selected cloud provider uses `embedding.apiKey` first, then its own API key environment variable.
`EMBEDDING_API_KEY` supplies `embedding.apiKey`.
Production configurations with `EMBEDDING_PROVIDER=openai` and `EMBEDDING_API_KEY` keep the same behavior and vectors.
Without an explicit provider, selection still tries `OPENAI_API_KEY`, `GEMINI_API_KEY`, then the configuration.

## Environment Variables Reference

All environment variables supported by the server. Priority: env vars > config.json > defaults.

| Env Var | Config Path | Default | Notes |
|---------|------------|---------|-------|
| `AGENT_FS_MAX_UPLOAD_BYTES` | — | `52428800` (50 MiB) | Raw upload and HTTP body limit in bytes; positive safe integer, invalid values use the default. Restart the daemon after changing. |
| `AGENT_FS_HOME` | — | `~/.agent-fs` | Data directory (SQLite DB, logs, pid file) |
| `AWS_ENDPOINT_URL_S3` / `S3_ENDPOINT` | `s3.endpoint` | `http://localhost:9000` | Tigris auto-injects `AWS_ENDPOINT_URL_S3` |
| `AWS_ACCESS_KEY_ID` / `S3_ACCESS_KEY_ID` | `s3.accessKeyId` | — | Tigris auto-injects `AWS_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` / `S3_SECRET_ACCESS_KEY` | `s3.secretAccessKey` | — | Tigris auto-injects `AWS_SECRET_ACCESS_KEY` |
| `BUCKET_NAME` / `S3_BUCKET` | `s3.bucket` | `agentfs` | Tigris auto-injects `BUCKET_NAME` |
| `AWS_REGION` / `S3_REGION` | `s3.region` | `us-east-1` | Tigris auto-injects `AWS_REGION` |
| `S3_PROVIDER` | `s3.provider` | `minio` | Display-only (e.g., `minio`, `tigris`, `r2`) |
| `S3_PUBLIC_ENDPOINT` | `s3.publicEndpoint` | _(falls back to `S3_ENDPOINT`)_ | Externally-reachable S3 endpoint used only when generating presigned URLs. Falls back to `S3_ENDPOINT`. |
| `SERVER_PORT` | `server.port` | `7433` | |
| `SERVER_HOST` | `server.host` | `127.0.0.1` | Set to `0.0.0.0` in containers |
| `EMBEDDING_PROVIDER` | `embedding.provider` | `local` | `local`, `openai`, or `gemini`. A non-empty value takes priority over API key variables. |
| `EMBEDDING_MODEL` | `embedding.model` | — | Model name for the chosen provider |
| `EMBEDDING_API_KEY` | `embedding.apiKey` | _(unset)_ | API key for `openai` or `gemini`. An explicit provider uses this key before its own API key variable. |
| `OPENAI_API_KEY` | _(env only)_ | _(unset)_ | Selects OpenAI when `EMBEDDING_PROVIDER` is absent. Supplies the key for explicit OpenAI when `embedding.apiKey` is empty. |
| `GEMINI_API_KEY` | _(env only)_ | _(unset)_ | Selects Gemini when the explicit provider and `OPENAI_API_KEY` are absent. Supplies the key for explicit Gemini when `embedding.apiKey` is empty. |
| `ANONYMIZED_TELEMETRY` | _(env only)_ | `true` | Set to `false` to stop anonymous usage events. See [docs/telemetry.md](./docs/telemetry.md). |
| `DO_NOT_TRACK` | _(env only)_ | _(unset)_ | Any value except empty, `0`, `false`, `no`, or `off` also stops telemetry. |
| `AGENT_FS_PUBLIC_URL` | `server.publicUrl` | _(derived from the request)_ | Public address of this API server (e.g. `https://agent-fs-acme.fly.dev`), used to build absolute `/share/<token>` links. Set it when a proxy does not forward `Host` / `X-Forwarded-Proto`. |
| `AGENT_FS_SHARE_RATE_LIMIT` | `server.shareRateLimit.requestsPerMinute` | `120` | Per-IP requests per minute for the public `/share/*` routes; `0` disables. Behind a reverse proxy other than Fly, all traffic shares the proxy's address, so raise it. |
| `AGENT_FS_SITE_RATE_LIMIT` | `server.siteRateLimit.requestsPerMinute` | `600` | Per-IP requests per minute for the public `/site/*` routes (folder shares); `0` disables. One page load fetches many files, so it is higher than the share limit. |
| `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE` | _(env only)_ | `0.25` | Share of CPU time the background re-embed may use, above 0 and at most 1. It pauses after each file. `1` runs without pauses. Invalid values use the default. See [Upgrading to 0.16.5](#upgrading-to-0165-embeddings-re-embedded). |
| `AGENT_FS_CLOUD` | _(env only)_ | _(unset)_ | Set to `true` only on servers the agent-fs team hosts. Marks telemetry events with `is_cloud`. |

When both `AWS_*` and `S3_*` variants are set, the `AWS_*` variant takes precedence (Tigris injects `AWS_*` automatically).

### Upload size

Set `AGENT_FS_MAX_UPLOAD_BYTES=104857600` on the server to allow 100 MiB raw
uploads, then restart the daemon. The HTTP server and embedded `writeRaw` use
this env-only setting; `/health` reports `maxUploadBytes` and the web UI fetches
it at runtime (50 MiB fallback for older/unreachable servers). No UI rebuild is
needed. JSON/MCP `write` remains capped at 10 MiB for indexing costs.

FUSE retains its separate **64 MiB encoded IPC frame** cap in both the daemon
and Rust helper. Protocol overhead means the usable file size is below 64 MiB;
raising the upload setting does not raise that cap. Use HTTP raw uploads for
larger files. Uploads are buffered in memory, so provision memory for the chosen
limit and concurrent uploads, and align any reverse-proxy request limits.


## LiteFS Upgrade Path

For users who need SQLite replication across multiple Fly.io instances, a reference `litefs.yml` configuration is included in the repository root. LiteFS is **not active by default** — the standard deployment uses a single-node volume mount.

To enable LiteFS, you would need to switch the Dockerfile base image to include the LiteFS binary and update the `CMD` to run via `litefs mount`. See `litefs.yml` for the static lease (single-node) and commented-out Consul (multi-node) configurations.
