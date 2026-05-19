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

See the [OpenAPI spec](./openapi.json) for the full schema of each operation, or browse it interactively:

- **Live endpoint**: `GET /docs/openapi.json` (when server is running)
- **Static file**: [`docs/openapi.json`](./openapi.json) (committed to repo)

Import either into [Swagger Editor](https://editor.swagger.io) or [Scalar](https://scalar.com) for interactive exploration.

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
