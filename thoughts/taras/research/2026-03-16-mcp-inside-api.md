---
date: 2026-03-16T20:00:00-05:00
researcher: Claude
git_commit: a8c85b9
branch: main
repository: agent-fs
topic: "Embedding MCP inside the HTTP API server"
tags: [research, mcp, hono, transport, streamable-http, architecture]
status: complete
autonomy: autopilot
last_updated: 2026-03-16
last_updated_by: Claude
---

# Research: Embedding MCP Inside the HTTP API Server

**Date**: 2026-03-16
**Researcher**: Claude
**Git Commit**: a8c85b9
**Branch**: main

## Research Question

How to embed MCP inside the agent-fs HTTP API server so that:
1. A single server process serves both REST endpoints AND MCP (via Streamable HTTP transport)
2. `agent-fs mcp` becomes a thin stdio proxy to that server
3. CLI embedded mode is removed (everything goes through the API)

## Summary

The MCP SDK (v1.27.1, already installed) ships with `WebStandardStreamableHTTPServerTransport` which works natively with Hono + Bun. Even better, the official `@hono/mcp` middleware (v0.2.4) provides a `StreamableHTTPTransport` that takes Hono's `Context` directly — the cleanest integration path. For the stdio proxy, the SDK provides `StreamableHTTPClientTransport` which handles session IDs, SSE parsing, and auth headers out of the box. The entire change is ~100 lines of new code plus removing `embedded.ts`.

## Detailed Findings

### 1. MCP Transport Options

The MCP SDK supports three server transports:

| Transport | Import | Status | Runtime |
|-----------|--------|--------|---------|
| `StdioServerTransport` | `sdk/server/stdio.js` | Active | Any |
| `SSEServerTransport` | `sdk/server/sse.js` | **Deprecated** | Node.js |
| `StreamableHTTPServerTransport` | `sdk/server/streamableHttp.js` | Recommended | Node.js |
| `WebStandardStreamableHTTPServerTransport` | `sdk/server/webStandardStreamableHttp.js` | Recommended | **Bun/Deno/Workers** |

**SSE is deprecated** (protocol version 2024-11-05, being removed). **Streamable HTTP** (protocol version 2025-11-25) is the standard — single endpoint, supports stateless mode, JSON-only mode, and session management via `Mcp-Session-Id` header.

The `WebStandardStreamableHTTPServerTransport` variant uses Web Standard `Request`/`Response` (no Node.js types) — perfect for Hono + Bun.

### 2. Integration Approach: `@hono/mcp` (Recommended)

The official Hono middleware `@hono/mcp` (v0.2.4) is the cleanest path: **DECIDED: use this.**

```typescript
import { StreamableHTTPTransport } from "@hono/mcp";

const transport = new StreamableHTTPTransport();

app.all("/mcp", async (c) => {
  if (!mcpServer.isConnected()) {
    await mcpServer.connect(transport);
  }
  return transport.handleRequest(c);  // Takes Hono Context directly
});
```

**Why this over raw SDK:**
- `handleRequest(c)` accepts Hono's `Context` directly — no `fetch-to-node` conversion
- Works natively on Bun (Fetch API based)
- Handles GET/POST/DELETE routing internally
- Stateless by design — no session management complexity
- Single dependency: `@hono/mcp ^0.2.4`

**Alternative**: The raw SDK's `WebStandardStreamableHTTPServerTransport` also works but requires slightly more boilerplate:

```typescript
import { WebStandardStreamableHTTPServerTransport } from
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);  // Takes raw Request
});
```

The SDK even ships a Hono example at `node_modules/.bun/@modelcontextprotocol+sdk@1.27.1/.../examples/server/honoWebStandardStreamableHttp.js`.

### 3. Server-Side Changes (`packages/server`)

#### 3a. `createMcpServer()` needs dependency injection

Currently (`packages/mcp/src/server.ts:30-35`):
```typescript
const db = createDatabase();        // Creates its OWN db
const s3 = new AgentS3Client(...);  // Creates its OWN s3
```

Needs to become:
```typescript
export async function createMcpServer(options: {
  db: DB;                           // Injected
  s3: AgentS3Client;                // Injected
  apiKey?: string;
}) { ... }
```

This lets the server share its `db` and `s3` instances with the MCP server.

#### 3b. Mount MCP route in `createApp()`

In `packages/server/src/app.ts`:

```typescript
import { StreamableHTTPTransport } from "@hono/mcp";
import { createMcpServer } from "@/mcp/server.js";

export async function createApp(db: DB, s3: AgentS3Client) {
  const app = new Hono<AppEnv>();

  // ... existing middleware and routes ...

  // Mount MCP endpoint
  const transport = new StreamableHTTPTransport();
  const mcpServer = await createMcpServer({ db, s3 });
  await mcpServer.connect(transport);

  app.all("/mcp", async (c) => {
    return transport.handleRequest(c);
  });

  return app;
}
```

Note: `createApp` becomes async (it's currently sync). The caller in `packages/server/src/index.ts` already awaits nothing, but can easily add `await`.

#### 3c. Auth middleware consideration

The existing auth middleware (`packages/server/src/middleware/auth.ts:6`) has `PUBLIC_PATHS` that skip auth. The MCP endpoint would need to either:
- Be added to `PUBLIC_PATHS` (MCP handles its own auth via the API key in the transport)
- Or use the existing Bearer auth — the MCP client would pass the API key as `Authorization: Bearer af_xxx`

The second option is cleaner — reuse the same auth for both REST and MCP.

### 4. stdio Proxy (`agent-fs mcp` command)

Two approaches for the proxy:

#### 4a. SDK-level proxy (recommended, ~50 lines)

Use `StreamableHTTPClientTransport` from the SDK:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const config = getConfig();
const serverUrl = `http://${config.server.host}:${config.server.port}/mcp`;

// Client side: connects to agent-fs daemon's /mcp endpoint
const httpTransport = new StreamableHTTPClientTransport(
  new URL(serverUrl),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${config.auth.apiKey}` },
    },
  }
);
const client = new Client({ name: "agent-fs-proxy", version: VERSION });
await client.connect(httpTransport);

// Server side: presents as stdio MCP server to Claude Code
const proxyServer = new Server(
  { name: "agent-fs", version: VERSION },
  { capabilities: { tools: {} } }
);

// Forward all requests to the real server
proxyServer.setRequestHandler("tools/list", (req) => client.request(req));
proxyServer.setRequestHandler("tools/call", (req) => client.request(req));

const stdioTransport = new StdioServerTransport();
await proxyServer.connect(stdioTransport);
```

#### 4b. Raw JSON-RPC forwarding (~30 lines, simpler but less robust)

```typescript
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin });
let sessionId: string | undefined;

rl.on("line", async (line) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(serverUrl, { method: "POST", headers, body: line });
  const sid = res.headers.get("Mcp-Session-Id");
  if (sid) sessionId = sid;

  if (res.headers.get("Content-Type")?.includes("application/json")) {
    process.stdout.write(JSON.stringify(await res.json()) + "\n");
  }
});
```

**Recommendation: Approach 4a** — SDK handles session management, SSE parsing, error recovery, and concurrent requests properly.

### 5. Changes Per Package

#### `packages/server` (the main change)
- `app.ts`: Mount `/mcp` route, make `createApp` async
- `index.ts`: `await createApp(db, s3)` instead of `createApp(db, s3)`
- `package.json`: Add `@hono/mcp: ^0.2.4` dependency
- Auth middleware: MCP requests use existing Bearer auth (no changes needed if MCP clients send `Authorization` header)

#### `packages/mcp` (refactor)
- `server.ts`: Change `createMcpServer()` to accept `{ db, s3 }` instead of creating them internally
- `index.ts`: Keep as-is for direct stdio mode (backward compat), OR rewrite as proxy
- `tools.ts`: No changes needed — already clean
- `package.json`: No changes

#### `packages/cli` (simplify)
- `index.ts`: `agent-fs mcp` command → rewrite to proxy mode (or keep import for fallback)
- `embedded.ts`: **Delete entirely**
- `commands/ops.ts`: Remove `isDaemonRunning()` / `embeddedCallOp()` fallback — always require daemon
- `api-client.ts`: No changes

### 6. Existing Libraries for Reference

| Library | Purpose | Downloads |
|---------|---------|-----------|
| `@hono/mcp` | Official Hono MCP middleware | - |
| `mcp-remote` | stdio→HTTP proxy with OAuth | ~148K/week |
| `@pyroprompts/mcp-stdio-to-streamable-http-adapter` | Pure stdio→HTTP adapter | - |
| `mcp-proxy` | Reverse: stdio→HTTP server | - |
| `@modelcontextprotocol/hono` | Official MCP Hono app helper | - |

## Code References

| File | Line | Description |
|------|------|-------------|
| `packages/server/src/app.ts` | 15 | `createApp(db, s3)` — where MCP route would be mounted |
| `packages/server/src/index.ts` | 7-13 | DB/S3 creation and app startup |
| `packages/server/src/middleware/auth.ts` | 6 | `PUBLIC_PATHS` — may need `/mcp` added |
| `packages/mcp/src/server.ts` | 24-35 | `createMcpServer()` — needs DI refactor |
| `packages/mcp/src/tools.ts` | 7-39 | `registerTools()` — reusable as-is |
| `packages/mcp/src/index.ts` | 1-8 | stdio entry point — becomes proxy or kept as fallback |
| `packages/cli/src/index.ts` | 63-69 | `agent-fs mcp` command |
| `packages/cli/src/embedded.ts` | 1-83 | **To be deleted** — embedded mode |
| `packages/cli/src/commands/ops.ts` | 101-106 | `isDaemonRunning()` fallback — to be removed |

## Architecture Documentation

### Current Architecture (two parallel stacks)

```
Claude Code ──stdio──→ [agent-fs mcp] ──direct──→ core (own DB/S3)
agent-fs CLI ──HTTP──→ [daemon/server] ──direct──→ core (own DB/S3)
```

### Target Architecture (single stack)

```
Claude Code ──stdio──→ [agent-fs mcp proxy] ──HTTP──→ ┐
agent-fs CLI ──HTTP────────────────────────────────────┤
                                                       ▼
                                              [daemon/server]
                                              ├── REST /orgs/:orgId/ops
                                              ├── MCP  /mcp (Streamable HTTP)
                                              └── core (shared DB/S3)
```

### `agent-fs mcp` in target architecture

```
Claude Code                     agent-fs daemon
    │                               │
    │ stdin (JSON-RPC)              │
    ▼                               │
[agent-fs mcp]                      │
    │                               │
    │ HTTP POST /mcp                │
    │ Authorization: Bearer af_xxx  │
    │ Mcp-Session-Id: <sid>         │
    ▼                               ▼
    ├──────────────────────────────→ Hono app
    │                               ├── authMiddleware
    │                               ├── StreamableHTTPTransport
    │                               ├── McpServer (shared db/s3)
    │                               │   ├── registerTools()
    │                               │   ├── health
    │                               │   └── whoami
    │                               │
    │ HTTP Response (JSON or SSE)   │
    ◄──────────────────────────────┤
    │
    │ stdout (JSON-RPC)
    ▼
Claude Code
```

## Historical Context (from thoughts/)

The brainstorm at `thoughts/taras/brainstorms/2026-03-16-agent-fs-architecture.md` identified:
- MCP embedded mode as the key bottleneck for distribution (L2/L3 scenarios)
- The ops system (`dispatchOp`) as the natural abstraction boundary
- CLI embedded mode as unnecessary complexity (three code paths)
- Path B (MCP inside server) as the preferred approach over Path A (MCP as thin HTTP client)

## Related Research

- `thoughts/taras/brainstorms/2026-03-16-agent-fs-architecture.md` — Full architecture brainstorm

## Decisions (resolved from review)

1. **Auth model** — Reuse existing Bearer auth middleware. MCP clients pass `Authorization: Bearer af_xxx` like any other API client.
2. **Session mode** — Stateless. Each tool call is independent, no server-initiated notifications needed.
3. **Transport library** — Use `@hono/mcp` (official Hono middleware). Adds one dependency but cleanest integration.
4. **Embedding provider** — Init once at server startup, share across both REST and MCP paths (cleanest approach).
5. **No fallback to embedded** — `agent-fs mcp` should fail with a clear error if no backend is available: "Cannot connect to agent-fs. Start a daemon with `agent-fs daemon start` or set `AGENT_FS_API_URL` to connect to a remote server."
6. **External API support** — Both `agent-fs mcp` and `agent-fs` CLI should support connecting to an external API (not just local daemon). The `AGENT_FS_API_URL` env var already exists for CLI; the MCP proxy should use the same config. This enables the full L1→L2→L3 progression without code changes on the client side:
   - Local: `AGENT_FS_API_URL=http://localhost:7433` (default, local daemon)
   - Team: `AGENT_FS_API_URL=https://agent-fs.team.internal` (self-hosted)
   - Cloud: `AGENT_FS_API_URL=https://api.agent-fs.io` (hosted)
