---
date: 2026-03-16
planner: Claude
status: completed
autonomy: autopilot
research: thoughts/taras/research/2026-03-16-mcp-inside-api.md
brainstorm: thoughts/taras/brainstorms/2026-03-16-agent-fs-architecture.md
review: thoughts/taras/plans/2026-03-16-mcp-inside-api-review.md
repository: agent-fs
branch: main
tags: [plan, mcp, hono, transport, streamable-http, architecture]
---

# Embed MCP Inside the HTTP API Server — Implementation Plan

## Overview

Embed MCP (Streamable HTTP transport) inside the existing Hono server so that a single daemon process serves both REST and MCP endpoints. Rewrite `agent-fs mcp` as a thin stdio-to-HTTP proxy, then remove embedded mode entirely. This collapses two parallel execution stacks into one.

## Current State Analysis

Two separate execution paths exist:

1. **MCP (stdio)**: `agent-fs mcp` → `packages/mcp/src/index.ts` → creates its OWN `db`, `s3`, `embeddingProvider` → standalone MCP server over stdio
2. **CLI/HTTP**: `agent-fs <op>` → detects daemon via `isDaemonRunning()` → if running: HTTP API client → daemon; if not: embedded mode (own `db`/`s3` in-process)

Problems:
- Two independent database/S3 connections (MCP vs daemon) can conflict
- Embedded mode (`packages/cli/src/embedded.ts`) is a third code path that duplicates context setup
- MCP server can't be shared over a network (stdio only)

### Key Discoveries:
- `WebStandardStreamableHTTPServerTransport` already in SDK v1.27.1 — works natively with Hono's `c.req.raw` / `Response` (`packages/mcp` already depends on `@modelcontextprotocol/sdk ^1.27.1`)
- SDK tool handlers receive `extra.authInfo` (`AuthInfo` type with `token`, `clientId`, `scopes`, `extra` fields) — enables per-request auth from Hono middleware without AsyncLocalStorage
- **Per-request transport**: The SDK's own Hono example (`examples/server/honoWebStandardStreamableHttp.js`) creates a **new transport AND new McpServer per request** in stateless mode. A shared transport has internal state (`_initialized`, `_streamMapping`) that doesn't support concurrent multi-user access.
- `StreamableHTTPClientTransport` in SDK handles session IDs, SSE parsing, and auth headers for the proxy
- `@hono/mcp` is NOT needed — the raw SDK transport is cleaner (no extra dependency). **Note**: The research doc said "DECIDED: use @hono/mcp" but this was reversed after discovering the SDK's built-in `WebStandardStreamableHTTPServerTransport` works natively with Hono and provides the `authInfo` flow we need.

## Desired End State

```
Claude Code ──stdio──→ [agent-fs mcp proxy] ──HTTP──→ ┐
agent-fs CLI ──HTTP────────────────────────────────────┤
                                                       ▼
                                              [daemon/server]
                                              ├── REST /orgs/:orgId/ops
                                              ├── MCP  /mcp (Streamable HTTP)
                                              └── core (shared DB/S3/embeddings)
```

- Single daemon process owns all state (db, s3, embeddings)
- `agent-fs mcp` is a stateless stdio↔HTTP proxy (~40 lines)
- No embedded mode — CLI always talks to daemon via HTTP
- Both local and remote servers supported via `AGENT_FS_API_URL`

## Quick Verification Reference

Common commands:
- `bun run typecheck` — TypeScript type checking
- `bun run test` — run tests
- `bun run build` — bundle CLI

Key files being modified:
- `packages/mcp/src/server.ts` — MCP server factory (DI refactor, becomes sync)
- `packages/mcp/src/tools.ts` — tool registration (pass `extra` through)
- `packages/mcp/src/index.ts` — becomes stdio proxy
- `packages/server/src/app.ts` — mount `/mcp` route (stays sync)
- `packages/server/src/index.ts` — init embedding provider (top-level await)
- `packages/server/src/routes/ops.ts` — accept embeddingProvider param
- `packages/cli/src/embedded.ts` — **deleted**
- `packages/cli/src/commands/ops.ts` — remove embedded fallback
- `packages/cli/src/commands/comment.ts` — remove embedded fallback (same pattern as ops.ts)

## What We're NOT Doing

- OAuth/OIDC for MCP (Bearer token auth is sufficient for now)
- Session/stateful MCP mode (stateless is correct — each tool call is independent)
- MCP resource/prompt capabilities (only tools)
- Removing the `agent-fs server` foreground command (still useful for dev)
- Changing the REST API routes or behavior
- Adding `@hono/mcp` dependency (raw SDK transport suffices)
- ~~Refactoring CLI `getOrgId()` to use API instead of local DB~~ — Done in Phase 5

## Known Limitations

1. ~~**`getOrgId()` still opens a local DB**~~ **Resolved in Phase 5**: `getOrgId()` now resolves exclusively via the `GET /auth/me` API. The CLI no longer touches SQLite directly — fully consistent with the daemon-required architecture.

2. **MCP always uses default org**: The `/mcp` endpoint resolves org from the authenticated user's default context. There's no way to override the org per-request via MCP (unlike REST which has `/orgs/:orgId/ops`). This is intentional for simplicity — agents typically operate in one org context.

## Implementation Approach

Four phases, each independently verifiable:

1. **Refactor `createMcpServer()` for dependency injection** — accept shared `db`/`s3`/`embeddingProvider`, per-request auth via `extra.authInfo`, make function sync
2. **Mount MCP endpoint on Hono server** — add `/mcp` route with per-request transport + server (matching SDK pattern)
3. **Rewrite `agent-fs mcp` as stdio proxy** — replace standalone MCP with SDK Client/Server forwarding
4. **Remove embedded mode** — delete `embedded.ts`, simplify CLI ops routing

---

## Phase 1: Refactor `createMcpServer()` for Dependency Injection

### Overview

Change `createMcpServer()` to accept shared infrastructure (`db`, `s3`, `embeddingProvider`) and per-request auth via the SDK's `extra.authInfo` instead of a static API key. Make the function **synchronous** (no internal async init). Update `registerTools()` and inline tools (`health`, `whoami`) to forward `extra` to `getContext`.

### Changes Required:

#### 1. MCP Server Options Interface and Factory
**File**: `packages/mcp/src/server.ts`
**Changes**:
- Replace `McpServerOptions` interface: remove `apiKey`, add `db`, `s3`, `embeddingProvider`, `defaultUser?`
- Change function signature from `async` to sync: `export function createMcpServer(options: McpServerOptions)`
- Remove internal `createDatabase()`, `AgentS3Client()`, `createEmbeddingProviderFromEnv()` calls (lines 30-35)
- Remove `ensureLocalUser()` / static `apiKey` logic (lines 38-40)
- Change `getContext` from `() => OpContext` to `(extra) => OpContext` using `extra.authInfo`
- Add `defaultUser` fallback for transitional standalone mode (removed in Phase 3)

New interface and factory:
```typescript
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export interface McpServerOptions {
  db: DB;
  s3: AgentS3Client;
  embeddingProvider: EmbeddingProvider | null;
  /** Fallback user when authInfo is absent (standalone stdio mode). Removed in Phase 3. */
  defaultUser?: { id: string; email: string };
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function createMcpServer(options: McpServerOptions) {
  const { db, s3, embeddingProvider, defaultUser } = options;

  const server = new McpServer({
    name: "agent-fs",
    version: VERSION,
  });

  const getContext = (extra: Extra): OpContext => {
    let userId: string;

    if (extra.authInfo?.extra?.user) {
      const user = extra.authInfo.extra.user as { id: string };
      userId = user.id;
    } else if (defaultUser) {
      userId = defaultUser.id;
    } else {
      throw new Error("No auth context — MCP must be accessed through the HTTP server");
    }

    const resolved = resolveContext(db, { userId });
    return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId, embeddingProvider };
  };

  registerTools(server, getContext);
  // ... health + whoami tools (see below) ...

  return server; // sync return, no longer async
}
```

#### 2. Refactor `health` tool (lines 60-89)
**File**: `packages/mcp/src/server.ts`
**Changes**: The `health` tool already uses `getContext()`. Update to pass `extra`:

```typescript
// Before (line 60):
server.tool("health", "...", {}, async () => {
  const ctx = getContext();

// After:
server.tool("health", "...", {}, async (_params, extra) => {
  const ctx = getContext(extra);
```

#### 3. Refactor `whoami` tool (lines 92-126) — **Critical fix**
**File**: `packages/mcp/src/server.ts`
**Changes**: The `whoami` tool currently calls `getUserByApiKey(db, apiKey)` directly using the closure-captured static `apiKey` (line 93). After removing the static apiKey, this MUST be rewritten to derive user from `extra.authInfo` or `getContext(extra)`:

```typescript
// Before (lines 92-126):
server.tool("whoami", "...", {}, async () => {
  const user = getUserByApiKey(db, apiKey);  // ← uses static apiKey, will break
  if (!user) { ... }
  const orgs = listUserOrgs(db, user.id);
  // ...
  const ctx = getContext();  // ← also uses static apiKey internally

// After:
server.tool("whoami", "...", {}, async (_params, extra) => {
  const ctx = getContext(extra);  // gets userId from authInfo
  const user = getUserByApiKey(db, /* need to get apiKey from somewhere */);

  // Actually, we don't need the apiKey lookup anymore.
  // We already have userId from getContext. Refactor to:
  const userId = ctx.userId;
  const orgs = listUserOrgs(db, userId);
  const orgDetails = orgs.map((org) => {
    const drives = listDrives(db, org.id);
    return {
      orgId: org.id,
      orgName: org.name,
      drives: drives.map((d) => ({
        driveId: d.id,
        driveName: d.name,
        role: getUserDriveRole(db, userId, d.id),
      })),
    };
  });

  // For email: either pass it through authInfo.extra or look up by userId
  // getUserById or similar may be needed — check core exports
  const result = {
    userId,
    activeOrg: ctx.orgId,
    activeDrive: ctx.driveId,
    memberships: orgDetails,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
});
```

**Note**: The `email` field in the current `whoami` response comes from `user.email` via `getUserByApiKey`. After the refactor, we can either: (a) look up user by ID from core, (b) pass email through `authInfo.extra.user.email`, or (c) drop email from the MCP whoami response. Option (b) is cleanest since we already pass user data through authInfo.

#### 4. Tool Registration
**File**: `packages/mcp/src/tools.ts`
**Changes**:
- Change `getContext` parameter type from `() => OpContext` to `(extra: Extra) => OpContext`
- Update each tool handler to pass `extra` to `getContext`:
  ```typescript
  // Before:
  server.tool(opName, description, shape, async (params) => {
    const ctx = getContext();
  // After:
  server.tool(opName, description, shape, async (params, extra) => {
    const ctx = getContext(extra);
  ```

#### 5. Standalone Entry Point (temporary backward compat)
**File**: `packages/mcp/src/index.ts`
**Changes**:
- Create `db`, `s3`, `embeddingProvider` locally (moved from `server.ts`)
- Call `ensureLocalUser(db)` locally to get user
- Pass resources + `defaultUser` to `createMcpServer`:

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createDatabase, getConfig, AgentS3Client,
  ensureLocalUser, getUserByApiKey, createEmbeddingProviderFromEnv,
} from "@/core";
import { createMcpServer } from "./server.js";

const config = getConfig();
const embeddingProvider = await createEmbeddingProviderFromEnv(config.embedding);
const db = createDatabase();
const s3 = new AgentS3Client(config.s3);

const apiKey = process.env.AGENT_FS_API_KEY;
let user: { id: string; email: string };
if (apiKey) {
  const found = getUserByApiKey(db, apiKey);
  if (!found) throw new Error("Invalid API key");
  user = found;
} else {
  const local = ensureLocalUser(db);
  user = getUserByApiKey(db, local.apiKey)!;
}

const server = createMcpServer({ db, s3, embeddingProvider, defaultUser: user });
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[agent-fs] MCP server ready");
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] ~~MCP server still works standalone~~ — obsolete: Phase 1+3 collapsed, standalone mode replaced by proxy

#### Manual Verification:
- [x] `agent-fs mcp` starts and connects to daemon — verified: prints "MCP proxy connected to http://127.0.0.1:7433"
- [ ] `health` and `whoami` tools return correct data — **requires Claude Code** (tools need full MCP lifecycle: init → notify → call)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Mount MCP Endpoint on Hono Server

### Overview

Add per-request `WebStandardStreamableHTTPServerTransport` + `McpServer` to the Hono server. Following the SDK's own Hono example, each `/mcp` request creates a fresh transport and server instance (stateless mode). MCP requests go through existing Bearer auth middleware — user is passed to tool handlers via `authInfo`.

**Key design**: `createApp()` stays **synchronous**. The MCP server is created per-request inside the async route handler, not at app creation time. This means no changes to test files that call `createApp`.

### ⚠️ REQUIRED SPIKE: Per-Request Transport Validation

**Before writing any Phase 2 code**, run this 5-minute validation spike:

1. Copy the SDK's Hono example to a temp file:
   ```bash
   cp node_modules/.bun/@modelcontextprotocol+sdk@1.27.1/node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/honoWebStandardStreamableHttp.js /tmp/mcp-spike.ts
   ```
2. Run it: `bun run /tmp/mcp-spike.ts`
3. Send an `initialize` POST, then a **separate** `tools/list` POST (different curl, no shared session):
   ```bash
   # First: initialize
   curl -s -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'

   # Second: tools/list (hits a FRESH per-request transport)
   curl -s -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
   ```
4. **If `tools/list` returns a valid response** → per-request pattern works, proceed as planned.
5. **If `tools/list` returns a 400 "Server not initialized"** → **STOP**. Switch to session-based transport with a Map:
   ```typescript
   // Fallback: session-based transport map
   const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
   app.all("/mcp", async (c) => {
     const sessionId = c.req.header("mcp-session-id");
     let transport = sessionId ? transports.get(sessionId) : undefined;
     if (!transport) {
       transport = new WebStandardStreamableHTTPServerTransport({
         sessionIdGenerator: () => crypto.randomUUID(),
         onsessioninitialized: (sid) => transports.set(sid, transport!),
         onsessionclosed: (sid) => transports.delete(sid),
       });
       const mcpServer = createMcpServer({ db, s3, embeddingProvider });
       await mcpServer.connect(transport);
     }
     return transport.handleRequest(c.req.raw, { authInfo: ... });
   });
   ```
   This is a small scope change, not a plan rewrite. Adjust Phase 2 Section 4 accordingly.

### Changes Required:

#### 1. Add MCP + SDK Dependencies to Server Package
**File**: `packages/server/package.json`
**Changes**:
- Add `"@desplega.ai/agent-fs-mcp": "workspace:*"` to dependencies (to import `createMcpServer`)
- Add `"@modelcontextprotocol/sdk": "^1.27.1"` to dependencies (for `WebStandardStreamableHTTPServerTransport`)

#### 2. Update TypeScript Project References
**File**: `packages/server/tsconfig.json`
**Changes**:
- Add `{ "path": "../mcp" }` to `references` array (currently only references `../core`)
- This allows `@/mcp` imports to resolve in the server package

#### 3. Init Embedding Provider at Server Startup (with graceful failure)
**File**: `packages/server/src/index.ts`
**Changes**:
- Import `createEmbeddingProviderFromEnv` from `@/core`
- Init embedding provider eagerly with try-catch (if it fails, server still starts — semantic search unavailable)
- Make the module use top-level await (Bun supports this)
- Pass `embeddingProvider` to `createApp`

```typescript
import { createDatabase, getConfig, AgentS3Client, createEmbeddingProviderFromEnv } from "@/core";
import type { EmbeddingProvider } from "@/core";

const config = getConfig();
const db = createDatabase();
const s3 = new AgentS3Client(config.s3);

let embeddingProvider: EmbeddingProvider | null = null;
try {
  embeddingProvider = await createEmbeddingProviderFromEnv(config.embedding);
} catch (err: any) {
  console.warn("Embedding provider failed to initialize:", err.message);
  console.warn("Semantic search will be unavailable.");
}

const app = createApp(db, s3, embeddingProvider);  // still sync!
// ... rest unchanged (Bun.serve, shutdown handlers)
```

#### 4. Mount MCP Route in App (per-request pattern)
**File**: `packages/server/src/app.ts`
**Changes**:
- `createApp` stays **sync** but adds `embeddingProvider` param (optional, defaults to `null` so tests don't break):
  ```typescript
  export function createApp(db: DB, s3: AgentS3Client, embeddingProvider: EmbeddingProvider | null = null)
  ```
- Import `WebStandardStreamableHTTPServerTransport` from SDK
- Import `createMcpServer` from `@/mcp/server.js`
- Mount `app.all("/mcp", ...)` handler that creates fresh transport + server per request (matching SDK Hono example)
- Add rate limiting for `/mcp`

```typescript
import { WebStandardStreamableHTTPServerTransport } from
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/mcp/server.js";
import type { EmbeddingProvider } from "@/core";

export function createApp(db: DB, s3: AgentS3Client, embeddingProvider: EmbeddingProvider | null = null) {
  const app = new Hono<AppEnv>();
  // ... existing middleware (cors, bodyLimit, auth) ...

  // Rate limiting — add /mcp alongside existing routes
  const rpm = config.server?.rateLimit?.requestsPerMinute ?? 60;
  if (rpm > 0) {
    app.use("/orgs/*", rateLimitMiddleware(rpm));
    app.use("/auth/*", rateLimitMiddleware(rpm));
    app.use("/mcp", rateLimitMiddleware(rpm));  // NEW
  }

  // ... error handler, health check ...

  // MCP endpoint — per-request transport + server (stateless, following SDK pattern)
  app.all("/mcp", async (c) => {
    const user = c.get("user");

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // stateless
      enableJsonResponse: true,       // JSON responses (no SSE needed for tool calls)
    });

    const mcpServer = createMcpServer({ db, s3, embeddingProvider });  // sync, fast (~22 tools registered)
    await mcpServer.connect(transport);

    return transport.handleRequest(c.req.raw, {
      authInfo: {
        token: c.req.header("Authorization")?.slice(7) ?? "",
        clientId: user.id,
        scopes: [],
        extra: { user: { id: user.id, email: user.email } },
      },
    });
  });

  // ... existing routes (auth, orgs, ops, docs) ...
  return app;
}
```

**Why per-request?** The SDK's own Hono example creates new transport + server per request. The transport has internal state (`_initialized`, `_streamMapping`, `_requestResponseMap`) that doesn't support concurrent access from multiple users. Since `createMcpServer` is now sync and just registers ~22 tools into Maps, the per-request overhead is negligible (microseconds).

**Auth note**: The `/mcp` route is NOT added to `PUBLIC_PATHS`. The existing `authMiddleware` validates the Bearer token and sets `c.get("user")` before the MCP handler runs. MCP and REST use identical auth.

#### 5. Update Ops Routes to Accept Embedding Provider
**File**: `packages/server/src/routes/ops.ts`
**Changes**:
- Accept `embeddingProvider` as parameter instead of lazy-init:
  ```typescript
  export function opsRoutes(db: DB, s3: AgentS3Client, embeddingProvider: EmbeddingProvider | null)
  ```
- Remove the lazy `getEmbeddingProvider()` function and its module-level state (lines 9-21)
- Use the passed-in `embeddingProvider` directly in the context (line 49)
- Update the call in `app.ts`: `opsRoutes(db, s3, embeddingProvider)`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test` (no test changes needed — `createApp` stays sync, `embeddingProvider` defaults to `null`)
- [x] Build succeeds: `bun run build`

#### Manual Verification:
- [x] Start daemon: `agent-fs daemon start` — **covered by E2E** (`scripts/e2e.ts` setup)
- [x] MCP endpoint responds (initialize + tools capability) — **covered by E2E** (`mcp initialize` + `mcp tools/list via batch` tests)
- [x] REST endpoints still work normally: `agent-fs ls /` — **covered by E2E** (21 CLI ops tests)
- [x] Unauthenticated MCP requests return 401 — **covered by E2E** (`mcp unauthenticated returns 401` test)

**Implementation Note**: After completing this phase, pause for manual confirmation. The standalone `agent-fs mcp` still works via the old entry point during this phase.

---

## Phase 3: Rewrite `agent-fs mcp` as stdio-to-HTTP Proxy

### Overview

Replace the standalone MCP server entry point with a thin proxy that bridges stdio (for Claude Code) to the daemon's `/mcp` HTTP endpoint. Uses SDK's `Client` + `StreamableHTTPClientTransport` for the HTTP side and `Server` + `StdioServerTransport` for the stdio side.

### Changes Required:

#### 1. Rewrite MCP Entry Point as Proxy
**File**: `packages/mcp/src/index.ts`
**Changes**:
- Remove all standalone MCP server code
- Implement stdio↔HTTP proxy using SDK classes:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getConfig, VERSION } from "@/core";

const config = getConfig();
const apiUrl = process.env.AGENT_FS_API_URL ?? `http://${config.server.host}:${config.server.port}`;
const apiKey = process.env.AGENT_FS_API_KEY ?? config.auth?.apiKey;

if (!apiKey) {
  console.error("Error: No API key. Register with `agent-fs auth register` or set AGENT_FS_API_KEY.");
  process.exit(1);
}

// HTTP client → daemon's /mcp endpoint
const httpTransport = new StreamableHTTPClientTransport(
  new URL(`${apiUrl}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }
);

const client = new Client({ name: "agent-fs-proxy", version: VERSION });

try {
  await client.connect(httpTransport);
} catch (err) {
  console.error(
    `Cannot connect to agent-fs at ${apiUrl}.\n` +
    `Start a daemon with \`agent-fs daemon start\` or set AGENT_FS_API_URL to connect to a remote server.`
  );
  process.exit(1);
}

// stdio server → Claude Code
const server = new Server(
  { name: "agent-fs", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await client.listTools();
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await client.callTool(request.params);
});

const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

console.error("[agent-fs] MCP proxy connected to " + apiUrl);
```

**Type compatibility note**: `client.listTools()` returns `ListToolsResult` and `client.callTool()` returns `CallToolResult`. The `Server.setRequestHandler` expects matching return types. These should be compatible — verify at implementation time and adjust if the compiler complains (may need explicit type assertions or spreading).

#### 2. Clean Up `createMcpServer` — Remove `defaultUser`
**File**: `packages/mcp/src/server.ts`
**Changes**:
- Remove `defaultUser` from `McpServerOptions` (no longer needed — standalone mode is gone)
- Simplify `getContext` to always require `extra.authInfo`:

```typescript
const getContext = (extra: Extra): OpContext => {
  const authInfo = extra.authInfo;
  if (!authInfo?.extra?.user) {
    throw new Error("No auth context — MCP must be accessed through the HTTP server");
  }
  const user = authInfo.extra.user as { id: string; email: string };
  const resolved = resolveContext(db, { userId: user.id });
  return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: user.id, embeddingProvider };
};
```

#### 3. Update MCP Package Dependencies (if needed)
**File**: `packages/mcp/package.json`
**Changes**:
- Verify `@modelcontextprotocol/sdk` is available (already is: `^1.27.1`)
- The `Client` and `StreamableHTTPClientTransport` come from the same package — no new deps

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] Build succeeds: `bun run build`

#### Manual Verification:
- [x] Start daemon: `agent-fs daemon start` — **covered by E2E**
- [x] MCP proxy starts: `agent-fs mcp` — verified: prints "MCP proxy connected to http://127.0.0.1:7433"
- [x] MCP proxy fails gracefully without daemon — verified: prints "Cannot connect to agent-fs" and exits
- [ ] Claude Code can discover and call tools via the proxy — **requires Claude Code** (stdio proxy not testable programmatically)
- [x] Tools return correct results (same as before) — **covered by E2E** (21 CLI ops + comments all pass through daemon)

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the most critical phase — verify Claude Code integration thoroughly.

---

## Phase 4: Remove Embedded Mode and Clean Up

### Overview

Delete embedded mode, simplify CLI ops routing to always use the HTTP API client, and clean up dependencies.

### Changes Required:

#### 1. Delete Embedded Mode
**File**: `packages/cli/src/embedded.ts`
**Action**: **Delete this file entirely**

#### 2. Simplify Ops Command Routing
**File**: `packages/cli/src/commands/ops.ts`
**Changes**:
- Remove import of `isDaemonRunning`, `embeddedCallOp`, `getEmbeddedOrgId` from `../embedded.js`
- Replace the `isDaemonRunning()` conditional with a direct API call + connection error handling:

```typescript
// Before:
if (await isDaemonRunning()) {
  result = await client.callOp(getOrgId(), def.name, params);
} else {
  const orgId = getEmbeddedOrgId();
  result = await embeddedCallOp(orgId, def.name, params);
}

// After:
try {
  result = await client.callOp(getOrgId(), def.name, params);
} catch (err: any) {
  if (err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("fetch failed")) {
    console.error(
      "Cannot connect to agent-fs daemon.\n" +
      "Start with: agent-fs daemon start\n" +
      "Or set AGENT_FS_API_URL to connect to a remote server."
    );
    process.exit(1);
  }
  throw err;
}
```

#### 3. Remove Embedded Mode from Comment Commands
**File**: `packages/cli/src/commands/comment.ts`
**Changes**:
- Remove import of `isDaemonRunning`, `embeddedCallOp`, `getEmbeddedOrgId` from `../embedded.js`
- Replace `callOp` helper's `isDaemonRunning()` conditional with try/catch + ECONNREFUSED error handling (same pattern as `ops.ts`)

#### 4. Clean Up CLI Entry Point
**File**: `packages/cli/src/index.ts`
**Changes**:
- Remove any imports from `./embedded.js`
- The `mcp` command stays as-is (it already does `await import("@/mcp/index.js")`)
- **Note**: `getOrgId()` (lines 28-50) still opens a local DB to resolve the org. This is a known limitation documented above — will be addressed in a follow-up.

#### 5. Clean Up CLI Dependencies
**File**: `packages/cli/package.json`
**Changes**:
- Review if any dependencies were only used by embedded mode and can be removed
- Keep `@modelcontextprotocol/sdk` since the CLI bundles `@/mcp/index.js` (the proxy) via `bun build`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] Build succeeds: `bun run build`
- [x] `embedded.ts` is gone: `! test -f packages/cli/src/embedded.ts`
- [x] No references to embedded: `grep -r "embedded" packages/cli/src/ --include="*.ts"` returns nothing

#### Manual Verification:
- [x] CLI ops work with daemon running — **covered by E2E** (21 CLI ops + comments all go through daemon)
- [x] CLI shows clear error without daemon — verified: "Cannot connect to agent-fs daemon at http://127.0.0.1:7433"
- [ ] MCP proxy works end-to-end with Claude Code — **requires Claude Code**
- [x] `agent-fs daemon start` still starts correctly — **covered by E2E** (setup)
- [x] `agent-fs daemon stop` still stops correctly — **covered by E2E** (cleanup)

**Implementation Note**: After completing this phase, pause for final confirmation.

---

## Phase 5 (Unplanned): Fix `getOrgId()` to Work via HTTP API

### Overview

Address Known Limitation #1: `getOrgId()` in `packages/cli/src/index.ts` opened a local SQLite database to resolve the user's default org ID. This broke remote-only setups where only `AGENT_FS_API_URL` + `AGENT_FS_API_KEY` are configured (no local DB). The fix enhances the existing `GET /auth/me` endpoint to return org/drive context, adds a `getMe()` method to the CLI's `ApiClient`, and makes `getOrgId()` purely API-based (no local DB fallback). The CLI no longer touches SQLite directly.

### Changes Required:

#### 1. Enhance `GET /auth/me` Endpoint
**File**: `packages/server/src/routes/auth.ts`
**Changes**:
- Import `resolveContext` from `@/core`
- Expand the existing `GET /me` handler to call `resolveContext(db, { userId: user.id })` and return `{ userId, email, defaultOrgId, defaultDriveId }`
- Gracefully handle `resolveContext` failures (return nulls for org/drive fields)

#### 2. Add `getMe()` to ApiClient
**File**: `packages/cli/src/api-client.ts`
**Changes**:
- Add `getMe()` method that calls `GET /auth/me` and returns typed response `{ userId, email, defaultOrgId, defaultDriveId }`

#### 3. Make `getOrgId()` Async with API-First Strategy
**File**: `packages/cli/src/index.ts`
**Changes**:
- Change `getOrgId()` from sync `() => string` to async `() => Promise<string>`
- Resolution order: (1) `--org` flag, (2) `GET /auth/me` via ApiClient, (3) exit with error
- No local DB fallback — CLI is purely API-based, consistent with the daemon-required architecture
- ECONNREFUSED errors show a helpful "start daemon" message

#### 4. Update Call Sites for Async `getOrgId`
**Files**: `packages/cli/src/commands/ops.ts`, `packages/cli/src/commands/comment.ts`
**Changes**:
- Update `getOrgId` parameter type from `() => string` to `() => string | Promise<string>`
- Add `await` to `getOrgId()` calls (both are already inside async action handlers)

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test` (269 pass, 0 fail — pre-existing embedding timeout excluded)
- [x] Build succeeds: `bun run build`

#### Manual Verification:
- [ ] CLI works with remote-only setup: `AGENT_FS_API_URL=<remote> AGENT_FS_API_KEY=<key> agent-fs ls /` — org resolved via API, no local DB needed
- [ ] CLI still works with local daemon (backward compat): `agent-fs ls /` — API-first, falls back to local DB if needed
- [ ] `--org` flag still takes priority: `agent-fs --org <id> ls /` — skips both API and DB lookup

---

## Testing Strategy

**Unit tests**: Existing tests in `packages/*/src/__tests__/` should continue to pass. `createApp` signature is backward-compatible (`embeddingProvider` defaults to `null`), so `api.test.ts` needs no changes.

**Integration tests**: The existing `packages/server/src/__tests__/api.test.ts` covers REST endpoints. MCP endpoint testing is manual (via curl and Claude Code) since it requires a running server with MCP client negotiation.

**Manual E2E**: See section below.

## Manual E2E Verification

After all phases are complete, run through this full verification:

```bash
# 1. Clean start
agent-fs daemon stop 2>/dev/null
bun run typecheck
bun run test
bun run build

# 2. Start daemon
agent-fs daemon start

# 3. REST API still works
agent-fs ls /
agent-fs write /test-e2e.txt --content "hello from e2e"
agent-fs cat /test-e2e.txt
agent-fs rm /test-e2e.txt

# 4. MCP endpoint works via curl (each curl creates fresh transport)
API_KEY=$(agent-fs config get auth.apiKey 2>/dev/null || echo "your_key_here")
curl -s -X POST http://localhost:7433/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'

# 5. MCP proxy works
agent-fs mcp  # Should connect; Ctrl+C to exit

# 6. Claude Code integration
# Configure in .mcp.json: { "agent-fs": { "command": "agent-fs", "args": ["mcp"] } }
# Ask Claude to: "List files in root", "Write a test file", "Read it back"

# 7. Error handling
agent-fs daemon stop
agent-fs ls /         # Should show "Cannot connect to agent-fs daemon" error
agent-fs mcp          # Should show "Cannot connect to agent-fs" error

# 8. Remote server support
AGENT_FS_API_URL=http://localhost:7433 agent-fs daemon start
AGENT_FS_API_URL=http://localhost:7433 agent-fs ls /  # Works via env var
```

## References

- Research: `thoughts/taras/research/2026-03-16-mcp-inside-api.md`
- Brainstorm: `thoughts/taras/brainstorms/2026-03-16-agent-fs-architecture.md`
- Review: `thoughts/taras/plans/2026-03-16-mcp-inside-api-review.md`
- SDK Hono example: `node_modules/.bun/@modelcontextprotocol+sdk@1.27.1/.../examples/server/honoWebStandardStreamableHttp.js`
- SDK type flow: `HandleRequestOptions.authInfo` → `onmessage extra` → `RequestHandlerExtra.authInfo` in tool handlers
