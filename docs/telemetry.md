# Telemetry

agent-fs sends a small amount of anonymous usage data. We use it to see how many installs are active and which versions and backends people run. It never contains your files, file paths, file content, names, emails, hostnames, or keys.

Telemetry is on by default. You can turn it off at any time (see [Opt out](#opt-out)).

## What the server sends

Only the agent-fs server (the local daemon or a hosted server) sends events. The CLI process and the MCP bridge send nothing directly.

| Event | When | Properties |
|-------|------|------------|
| `server.started` | Each time the server starts | Counts of `users`, `orgs`, `drives`, and `files`. `storage_provider` (`minio`, `s3`, `r2`, `tigris`, `local`, or `other`). `embedding_provider` (`local`, `openai`, `gemini`, or `other`). `os`, `arch`. |
| `server.heartbeat` | Every 24 hours while the server runs | The same properties as `server.started`, plus the number of successful operations since the last heartbeat: `ops_total` and one `ops_<name>` count per operation (for example `ops_write`, `ops_search`). |

Every event also carries `version` (the agent-fs version) and `is_cloud` (`true` only on servers that the agent-fs team hosts). Event metadata holds only `transport`, `schema_version`, `environment` (`production`, or `test` under test runners), and `is_cloud`. Set `DESPLEGA_TELEMETRY_ENV` to override `environment`.

## What the live UI sends

The web UI at `live.agent-fs.dev` sends one `live.session_started` event per browser session. It carries a random browser ID and `is_cloud`. Nothing else.

## How the data stays anonymous

- Each install gets a random ID (`install_` + 16 hex characters) the first time the server starts. The server stores it in `config.json` under `telemetry.installId`. The ID is not derived from your machine, user, or network.
- The live UI stores its own random ID (`browser_` + 16 hex characters) in the browser's local storage.
- Events go to `https://proxy.desplega.sh/v1/events`, a Desplega-owned service. It does not store IP addresses.
- Each event is one HTTPS request with a 5 second timeout. A failed request is dropped. Telemetry never blocks or slows an operation.

## Opt out

Set either variable in the server environment and restart the server:

```bash
ANONYMIZED_TELEMETRY=false
# or the cross-tool convention:
DO_NOT_TRACK=1
```

Any `DO_NOT_TRACK` value except empty, `0`, `false`, `no`, or `off` turns telemetry off.

When telemetry is off, the server sends no events and does not create an install ID.

For a self-hosted build of the live UI, build with `VITE_ANONYMIZED_TELEMETRY=false`. The live UI also sends nothing when the browser has Do Not Track turned on, and never in development builds.
