# API Reference

agent-fs exposes a single HTTP API. All file operations go through one dispatch endpoint.

## Base URL

```
http://localhost:7433
```

## Authentication

All endpoints (except `/health` and `/auth/register`) require a Bearer token:

```
Authorization: Bearer <api-key>
```

Get an API key by registering:

```bash
curl -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

## Endpoints

### `GET /health`

Health check. No auth required.

```bash
curl http://localhost:7433/health
# {"ok":true,"version":"0.1.1"}
```

### `POST /auth/register`

Register a new user. Returns user ID, org ID, drive ID, and API key.

```bash
curl -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "agent@example.com"}'
```

### `GET /auth/me`

Get current user info with default org/drive context.

```bash
curl http://localhost:7433/auth/me \
  -H "Authorization: Bearer <api-key>"
# {"userId":"...","email":"...","defaultOrgId":"...","defaultDriveId":"..."}
```

### `ALL /mcp`

MCP endpoint (Streamable HTTP transport). Accepts JSON-RPC requests from MCP clients. Stateless — each request creates a fresh MCP server instance.

```bash
curl -X POST http://localhost:7433/mcp \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
```

In practice, use `agent-fs mcp` (stdio proxy) rather than calling `/mcp` directly. The proxy handles the MCP lifecycle (initialize, tools/list, tool calls) automatically.

### `POST /orgs/{orgId}/ops`

Dispatch any file operation. The `op` field determines which operation runs.

```bash
curl -X POST http://localhost:7433/orgs/<orgId>/ops \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"op": "write", "path": "/hello.md", "content": "# Hello"}'
```

An optional `driveId` field targets a specific drive. The drive **must belong to `{orgId}`** — a `driveId` from another org returns `404 NOT_FOUND`, the same response as a nonexistent drive, so drive IDs cannot be probed across tenants. Each op requires a minimum drive role (see [Access control](#access-control)).

See the [OpenAPI spec](./openapi.json) for the full schema of each operation, or browse it interactively:

- **Live endpoint**: `GET /docs/openapi.json` (when server is running)
- **Static file**: [`docs/openapi.json`](./openapi.json) (committed to repo)

Import either into [Swagger Editor](https://editor.swagger.io) or [Scalar](https://scalar.com) for interactive exploration.

### Raw file bytes

Use the raw file route for binary-safe uploads and downloads:

```bash
curl -X PUT http://localhost:7433/orgs/<orgId>/drives/<driveId>/files/assets/logo.png/raw \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @logo.png

curl http://localhost:7433/orgs/<orgId>/drives/<driveId>/files/assets/logo.png/raw \
  -H "Authorization: Bearer <api-key>" \
  -o logo.png
```

The raw route preserves bytes exactly. Text indexing runs only for valid, indexable UTF-8 payloads.

`PUT /raw` requires the **editor** role (or better) on the target drive — viewers get `403 PERMISSION_DENIED`, matching the JSON `write` op. `GET /raw` is viewer-accessible. As with the ops route, the `driveId` in the path must belong to the `orgId` in the path; mismatches return `404`.

## Access control

All routes authenticate via API key and authorize against explicit memberships:

- **Strict drive membership** — a drive is only visible and accessible to users with an explicit drive membership row. Creating a drive grants the creator an admin membership automatically.
- **Per-op role gates** — read ops (`ls`, `cat`, `search`, `signed-url`, ...) require `viewer`; write ops (`write`, `edit`, `append`, `rm`, `mv`, `cp`, `revert`, `comment-add`, ...) require `editor`; `reindex` requires `admin`.
- **Member management is admin-only** — inviting, listing, updating, and removing org members requires org `admin`. Drive member routes require drive `admin` or admin of the owning org.
- **No existence oracle** — requests that reference an org or drive you have no access to return `404`, identical to the response for IDs that don't exist.
- **Scoped comment IDs** — comment IDs only resolve within the org/drive context they were created in; cross-tenant IDs return `404`.

### Signed URLs are bearer secrets

The `signed-url` op is viewer-accessible and RBAC is checked **only at generation time**. The returned URL is a presigned S3 URL: it requires no authentication and grants download access to **anyone who has it** until it expires (default 24h, max 7 days). Treat signed URLs like bearer tokens — don't log them, don't post them anywhere you wouldn't post a credential, and use the shortest expiry that works (`expiresIn`).

## Operations

All 26 operations are dispatched through `POST /orgs/{orgId}/ops`. Each expects `{"op": "<name>", ...params}`.

| Category | Operations |
|----------|-----------|
| **Content** | `write`, `cat`, `edit`, `append`, `tail` |
| **Navigation** | `ls`, `stat`, `tree`, `glob` |
| **File Management** | `rm`, `mv`, `cp` |
| **Version Control** | `log`, `diff`, `revert` |
| **Search** | `grep`, `fts`, `search` |
| **Maintenance** | `recent`, `reindex` |
| **Comments** | `comment-add`, `comment-list`, `comment-get`, `comment-update`, `comment-delete`, `comment-resolve` |

For parameter details, see the [OpenAPI spec](./openapi.json).
