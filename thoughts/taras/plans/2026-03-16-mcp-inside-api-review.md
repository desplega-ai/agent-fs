---
date: 2026-03-16T22:00:00-05:00
topic: "Review: Embed MCP Inside the HTTP API Server Plan"
reviewer: Claude
status: complete
type: review
reviewed_plan: thoughts/taras/plans/2026-03-16-mcp-inside-api.md
tags: [review, plan, mcp, hono, transport, streamable-http]
---

# Review: Embed MCP Inside the HTTP API Server -- Implementation Plan

## Summary

Solid, well-structured plan with correct architectural direction and accurate understanding of the SDK internals. The `authInfo` flow through `WebStandardStreamableHTTPServerTransport` -> `protocol.js` -> `extra.authInfo` in tool handlers is verified correct. However, there are several concrete issues that need attention before implementation: a single-transport-instance concurrency concern, an incomplete refactor of the `whoami` tool, a missing `getOrgId()` fix in the CLI entry point, and the plan's Phase 2 `createApp` signature change needs to propagate to more callers than listed.

## Findings

### Critical Issues (must fix before implementation)

1. **Single transport instance serving all requests may not support per-request `authInfo` correctly**
   - **File**: `packages/server/src/app.ts` (Phase 2, Section 4)
   - The plan creates ONE `WebStandardStreamableHTTPServerTransport` and ONE `McpServer`, then calls `transport.handleRequest(c.req.raw, { authInfo })` for every incoming request. While the SDK does forward `authInfo` per-call through `onmessage` extra, the transport maintains internal state (`_streamMapping`, `_requestResponseMap`, `_initialized`). In stateless mode (`sessionIdGenerator: undefined`), initialization happens on the first `handleRequest` call. Subsequent requests from different users will share the same transport state. This should work for stateless JSON responses (`enableJsonResponse: true`), but the `_initialized` flag means the first POST must be an `initialize` request, and the plan's `app.all("/mcp", ...)` handler doesn't distinguish between initial and subsequent requests.
   - **Fix**: The SDK's Hono example (referenced in the research at `node_modules/.../examples/server/honoWebStandardStreamableHttp.js`) likely creates a new transport per session or per request. Verify this. If per-request transport is needed, the pattern becomes: create a new transport + connect on each request. Alternatively, for truly stateless mode, confirm that a single pre-initialized transport+server pair can handle concurrent requests from multiple clients (the `_initialized` check in `handlePostRequest` may reject non-initialize requests before the first client initializes).

2. **`whoami` tool uses closure-captured `apiKey` and `db` directly -- not `getContext(extra)`**
   - **File**: `packages/mcp/src/server.ts:92-126`
   - The plan (Phase 1, Section 1) says to update `health` and `whoami` tools to "accept and use `extra` parameter." But the `whoami` tool (lines 92-126) calls `getUserByApiKey(db, apiKey)` directly using the closure-captured static `apiKey` -- it does NOT go through `getContext()`. After the DI refactor removes the static `apiKey`, `whoami` must be rewritten to extract the user from `extra.authInfo.extra.user` instead. The plan does not show this code change explicitly, only the `getContext` refactor. The `health` tool calls `getContext()` which will be updated, but `whoami` has its own independent user lookup that will break.
   - **Fix**: Explicitly document that `whoami` must be refactored to derive user info from `extra.authInfo.extra.user` (or call a new helper). Show the code diff.

### Important Issues (should fix)

3. **`getOrgId()` in `packages/cli/src/index.ts` opens its own DB connection**
   - **File**: `packages/cli/src/index.ts:28-50`
   - Phase 4 Section 3 says "Remove any imports from `./embedded.js`" but does NOT address `getOrgId()` which calls `createDatabase()` and `getUserByApiKey()` directly (lines 36-41). After removing embedded mode, the CLI should NOT be opening its own DB -- it should resolve org context via the API or config. This is a leftover embedded-mode pattern.
   - **Fix**: Either (a) add an API endpoint to resolve org context, (b) read it from the config file directly without touching the DB, or (c) accept that the CLI still needs local DB access for org resolution and document this as a known limitation for Phase 4.

4. **`createApp` becoming async requires updates to BOTH `index.ts` AND test files**
   - **File**: `packages/server/src/index.ts:13`, `packages/server/src/__tests__/api.test.ts`
   - Phase 2 Section 3 shows updating `index.ts` to `await createApp(...)`, and Section 4 makes `createApp` async. But the plan only mentions `index.ts` as the caller. The test file (`api.test.ts`) also calls `createApp()` and will need `await`. The plan should mention this.
   - **Fix**: Add a note that `api.test.ts` (and any other callers) must also be updated to `await createApp(...)`.

5. **`createApp` signature change propagates to CLI `server` command**
   - **File**: `packages/cli/src/index.ts:72-77`
   - The `server` command does `await import("@/server/index.js")` which triggers the top-level module execution. Since `index.ts` will now use top-level `await` for `createEmbeddingProviderFromEnv`, this should work with Bun. But if any other code directly imports `createApp`, it needs the new `embeddingProvider` parameter. Verify no other callers exist.

6. **Research vs Plan disagreement on `@hono/mcp`**
   - The research document (Section 2) says "DECIDED: use this" for `@hono/mcp`, but the plan (Section "What We're NOT Doing") explicitly rejects it: "Adding `@hono/mcp` dependency (raw SDK transport suffices)." This is the right call -- the raw SDK is cleaner and avoids an extra dependency. However, the research should be updated to reflect this decision reversal, or at minimum the plan should note it explicitly so future readers aren't confused by the contradicting research.

7. **Phase 3 proxy: `client.listTools()` return type may not match `Server.setRequestHandler` expected response**
   - **File**: `packages/mcp/src/index.ts` (Phase 3 proposed code)
   - The plan's proxy does:
     ```typescript
     server.setRequestHandler(ListToolsRequestSchema, async () => {
       return await client.listTools();
     });
     ```
   - The `client.listTools()` returns `ListToolsResult` which includes `tools` array and `_meta`. The `Server.setRequestHandler` for `ListToolsRequestSchema` expects a `ServerResult`. These types should be compatible, but verify at implementation time. The `CallToolRequestSchema` handler similarly forwards `request.params` -- make sure the response shape matches.

8. **Rate limiting does NOT cover `/mcp` route**
   - **File**: `packages/server/src/app.ts:31-35`
   - Rate limiting is currently applied only to `/orgs/*` and `/auth/*`. The new `/mcp` endpoint won't be rate-limited. For a tool like `agent-fs` where MCP calls can trigger heavy operations (S3 reads/writes, embedding generation), this could be a concern.
   - **Fix**: Consider adding `app.use("/mcp", rateLimitMiddleware(rpm))` or document it as a known gap for later.

### Minor Issues (nice to have)

9. **`enableJsonResponse: true` may lose SSE streaming capability**
   - The plan sets `enableJsonResponse: true` on the transport for "simpler tool calls." This means ALL responses are JSON, not SSE. For simple tool calls this is fine, but if you ever want server-sent notifications or streaming results, you'll need to remove this flag. Worth a comment in the code.

10. **`console.error("[agent-fs] MCP proxy connected to " + apiUrl)` in Phase 3 proxy**
    - This goes to stderr, which is correct for stdio mode. But the message says "connected" after `server.connect(stdioTransport)`, not after `client.connect(httpTransport)`. The message should be after the client connect (which it is in the code), but the placement after `server.connect(stdioTransport)` at the end means it prints after both connections succeed. This is fine -- just noting the output will appear after the stdio transport is ready, which is the right time.

11. **Phase 1 `defaultUser` is throwaway work**
    - Phase 1 adds `defaultUser?: { id: string; email: string }` to `McpServerOptions` for backward compat during the transition, then Phase 3 removes it. This is acknowledged in the plan but worth flagging: it's ~20 lines of code written only to be deleted one phase later. Consider whether Phase 1 and Phase 3 can be combined or whether the standalone MCP can be left broken between phases (since it's an intermediate state not shipped).

12. **`docs` route placement**
    - Not related to the plan, but `docsRoutes()` in `app.ts` is not behind auth. The plan doesn't touch this, which is correct.

### Questions to Resolve

1. **Concurrency model for the transport**: Can a single `WebStandardStreamableHTTPServerTransport` + `McpServer` pair handle concurrent requests from different authenticated users in stateless mode? The SDK example should be checked. If not, the plan needs a per-request transport pattern (create transport, connect, handleRequest, close -- on every request).

2. **Should the MCP endpoint be behind the `/orgs/:orgId/` prefix?** Currently the plan mounts at `/mcp` (root level). The REST API uses `/orgs/:orgId/ops`. With MCP, the org is resolved server-side from the user. Is this intentional? It simplifies the MCP client but means MCP always uses the user's default org, with no way to override.

3. **Session ID handling**: The plan uses stateless mode (`sessionIdGenerator: undefined`). The proxy in Phase 3 uses `StreamableHTTPClientTransport` which may send/expect session IDs. Confirm that the client transport gracefully handles a server that never returns `Mcp-Session-Id`.

4. **`createEmbeddingProviderFromEnv` failure**: Phase 2 moves embedding provider init to server startup (eagerly). Currently it's lazy-loaded. If the embedding provider fails to initialize (bad API key, network issue), the entire server won't start. The current lazy approach degrades gracefully. Is this acceptable?

## Strengths

- **Correct architectural insight**: Collapsing two parallel stacks into one is the right move. The analysis of the current three code paths (MCP standalone, daemon, embedded) is accurate.
- **SDK type verification**: The `authInfo` flow through `HandleRequestOptions` -> `onmessage` extra -> `RequestHandlerExtra.authInfo` is correctly traced and verified against the actual SDK source.
- **Phased approach with verification**: Each phase has clear success criteria and manual verification steps. The "pause for manual confirmation" gates are appropriate.
- **Explicit "What We're NOT Doing" section**: Prevents scope creep and sets clear boundaries.
- **Correct rejection of `@hono/mcp`**: Using the raw SDK transport avoids an unnecessary dependency and gives more control over auth integration.
- **Clean proxy design**: The stdio-to-HTTP proxy using SDK `Client` + `Server` is the right approach -- handles session management, error recovery, and concurrent requests properly.

## Recommendation

**Approve with changes**. The critical issues (1 and 2) must be resolved before starting implementation. Issue 1 (single transport concurrency) needs a quick verification against the SDK example code or a small spike. Issue 2 (whoami refactor) is a straightforward code fix to add to Phase 1. The important issues (3-8) should be addressed in the plan but are not blockers -- they can be caught during implementation if necessary.
