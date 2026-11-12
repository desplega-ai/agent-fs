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

Register a new user. Returns user ID, org ID, drive ID, and API key. The key is shown only once — it isn't stored anywhere but the user's own `config.json`.

```bash
curl -X POST http://localhost:7433/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "agent@example.com"}'
```

Set `AGENT_FS_REGISTER_ALLOWED_DOMAINS` (comma-separated, e.g. `acme.com,acme.io`) to restrict sign-ups by email domain. The domain after the last `@` must exactly match an entry, case-insensitive. Other domains get `403 {"error":"REGISTRATION_DOMAIN_NOT_ALLOWED"}`; an email with no domain gets `400 {"error":"VALIDATION_ERROR"}`. Unset means open registration.

`agent-fs auth reset-key` rotates your own key while you still hold the current one — it calls `/auth/reset-key`, which sits behind the same auth middleware as every other endpoint, so it cannot help if the key is genuinely lost. It invalidates the old key immediately. An org admin can run `agent-fs member reset-key <email>` for a locked-out member, but the key that returns is scoped to the admin's org: it gives back access to that org only, never to the member's personal drive or other orgs, and the member's own keys are not touched. Nothing an org admin runs can rotate or replace a member's primary key. Keep a second unscoped key from `POST /auth/keys` as a backup: a user who loses every unscoped key cannot get one back through the API.

### API keys

A user can hold several keys at once. The key from register (and from a self `reset-key`) is the **primary** key. Keys the user mints for themselves work everywhere the primary does. Keys an org admin mints for a member are limited to that org (see below). All of them are listed and revoked here. Only a SHA-256 of each key is stored, so the plaintext comes back once, at creation.

| Method | Path | Who | Body | Response |
|---|---|---|---|---|
| `POST` | `/auth/keys` | self | `{"label":"dashboard"}` (1–100 chars) | `201 {"id","label","createdAt","apiKey"}` |
| `GET` | `/auth/keys` | self | — | `{"keys":[{"id","label","createdAt","lastUsedAt","primary","orgId","createdByUserId","current"}]}` |
| `DELETE` | `/auth/keys/{keyId}` | self | — | `{"ok":true}` |
| `POST` | `/orgs/{orgId}/members/{userId}/keys` | org admin | `{"label":"agent-swarm"}` | `201 {"id","label","createdAt","apiKey","userId","orgId"}` |

```bash
curl -X POST http://localhost:7433/auth/keys \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"label":"laptop"}'
# {"id":"...","label":"laptop","createdAt":"2026-11-04T09:00:00.000Z","apiKey":"af_..."}
```

- `GET /auth/keys` lists active keys, primary first (id `primary`, `createdAt` and `lastUsedAt` null). It never returns hashes or plaintext. `lastUsedAt` is refreshed at most once per minute per key. `orgId` is null for a key that reaches the whole account and set for an org-scoped key; `createdByUserId` says who minted it. `current` is true for the key the request came in with.
- `DELETE /auth/keys/{keyId}` takes an id from the list, or `primary`. Any key can be revoked, including the one making the request and the last one left. A user with no keys left is locked out of the account: an org admin's `agent-fs member reset-key <email>` gives back a key scoped to that org only. Unknown, foreign or already-revoked ids return 404.
- `POST /orgs/{orgId}/members/{userId}/keys` uses the same guard as the admin `reset-key`: the caller must be an org admin (else 403) and `userId` must be a member of that org (else 404). The member's existing keys keep working.
- `POST /orgs/{orgId}/members/{userId}/reset-key` for another member mints a new org-scoped key, created by the admin, and revokes the member's other keys scoped to that org. It returns `{"apiKey","userId","email","keyId","orgId"}`. The member's primary key and their own keys keep working. For the caller's own `userId` it rotates the caller's primary key, like `/auth/reset-key`, and returns `{"apiKey","userId","email"}`.
- An admin-minted key is **scoped to that org**. It authenticates as the member only on `/orgs/{orgId}` and the routes under it, with the member's current role there. `GET /auth/me` answers it with identity only (see below). Every other path (the rest of `/auth/*`, `/mcp`, `/invites`, other orgs, the org list) returns 403, and the local FUSE daemon refuses it. It is revoked when the member leaves the org, when the admin who minted it leaves the org or stops being an admin there, and when the member runs their own `/auth/reset-key`. An admin `reset-key` of the member replaces it with a new scoped key.
- A self `/auth/reset-key` rotates the primary key and revokes every org-scoped key of the user. Keys from `POST /auth/keys` keep working.
- Creating and revoking keys records `api_key_created` / `api_key_revoked` audit events (the self routes use the caller's personal org).

### `GET /auth/me`

Get current user info with default org/drive context.

```bash
curl http://localhost:7433/auth/me \
  -H "Authorization: Bearer <api-key>"
# {"userId":"...","email":"...","displayName":null,"defaultOrgId":"...","defaultDriveId":"...","scopedOrgId":null}
```

For an org-scoped key the answer is identity only, without the personal defaults: `{"userId","email","displayName","scopedOrgId"}`. It is the only `/auth` route such a key may call.

### Org swarm URL

An org can name the agent-swarm dashboard it trusts for sign-in. When a browser with no key opens a deep link into that org (`/file/~/<orgId>/<driveId>/<path>?apiUrl=<this server>`), the live UI shows "Continue with <swarm host>", which opens `<swarmUrl>/fs/continue?return_to=<the live URL>`. The live URL carries `handoff=<nonce>` in its query: a single-use value the page stores in localStorage for 10 minutes when it shows the link, together with this server, so the return works in a new tab too. The swarm mints a key for the signed-in user and sends the browser back to `return_to`, query unchanged, with `#key=<af_...>&apiUrl=<this server>` in the fragment. The live UI removes the fragment from the address bar before any request. It saves the key and opens the original path only when `handoff` matches a stored nonce and `apiUrl` matches the server stored with it. Otherwise it ignores the key. When the org has no swarm URL (`null`), the live UI offers the hosted swarm, `https://app.agent-swarm.dev`. Org admins can change the URL in the live app, on the Members page. Servers that support this list `org-swarm-url` in the `/health` `features` array.

| Method | Path | Who | Body | Response |
|---|---|---|---|---|
| `PATCH` | `/orgs/{orgId}` | org admin | `{"swarmUrl":"https://swarm.example.com"}` or `{"swarmUrl":null}` | `{"id","name","isPersonal","swarmUrl"}` |
| `GET` | `/orgs/{orgId}` | org member | none | `{"id","name","isPersonal","swarmUrl","role"}` (`role` is the caller's role) |
| `GET` | `/orgs/{orgId}/public` | anyone (no key) | none | `{"swarmUrl"}` |

- `swarmUrl` must be an absolute `http` or `https` URL without credentials, query or fragment (max 2048 characters). A trailing slash is dropped. Anything else gets `400 {"error":"VALIDATION_ERROR","field":"swarmUrl"}`. Members below admin get 403, non-members 404. Sending the stored value again changes nothing, so a swarm can set it on every boot.
- `GET /orgs/{orgId}/public` sits before authentication with a per-IP limit of 120 requests per minute. It returns only `swarmUrl`. An unknown org gets the same `{"swarmUrl":null}` as an org without one.

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
- **Per-op role gates** — read ops (`ls`, `cat`, `search`, `signed-url`, ...) require `viewer`; write ops (`write`, `edit`, `append`, `rm`, `mv`, `cp`, `revert`, `comment-add`, ...) require `editor`; `reindex` requires `admin`. The `webhook-*` ops need drive membership at dispatch, then the handler requires drive `admin` or org `admin` for a drive webhook and org `admin` for an org webhook.
- **Member management is admin-only** — inviting, listing, updating, and removing org members requires org `admin`. Drive member routes require drive `admin` or admin of the owning org.
- **No existence oracle** — requests that reference an org or drive you have no access to return `404`, identical to the response for IDs that don't exist.
- **Scoped comment IDs** — comment IDs only resolve within the org/drive context they were created in; cross-tenant IDs return `404`.

### Signed URLs are bearer secrets

The `signed-url` op is viewer-accessible and RBAC is checked **only at generation time**. The returned URL is a presigned S3 URL: it requires no authentication and grants download access to **anyone who has it** until it expires (default 24h, max 7 days). Treat signed URLs like bearer tokens — don't log them, don't post them anywhere you wouldn't post a credential, and use the shortest expiry that works (`expiresIn`).

### Share links are bearer secrets

`share-create` mints a public `GET /share/{token}` page on the API host. The token (256 random bits) is the only credential: anyone who has the link can open it until it expires (default 24h, max 7 days), is revoked with `share-revoke`, reaches `maxViews`, or its creator is removed from the drive or org. `expiresIn: null` (CLI: `--expires-in never`) mints a link with no time limit: it ends only when revoked or at `maxViews`, and the response carries `expiresIn: null, expiresAt: null`. Servers that accept it list `share-no-expiry` in the `/health` `features` array; older servers reject `null`. Only the SHA-256 of the token is stored. The response's `url` is absolute when the server knows its address, and `urlSource` says how it was built: `"configured"` from `AGENT_FS_PUBLIC_URL` (hand out `url` as is), `"request"` from the request's `Host` (build `<the address you reached the API at>` + `sharePath`). The page is server-rendered under a strict `Content-Security-Policy` (`nosniff`, `no-store`) that runs only the page's own two inline scripts, allowed by hash, plus, when a markdown file needs them, version-pinned mermaid, KaTeX and highlight.js files loaded with Subresource Integrity; markdown is rendered with raw HTML and images stripped (frontmatter card, table of contents, callouts, footnotes, math and mermaid diagrams, light/dark theme), SVG files are download-only, and the page shows no API keys, org names or member details. `/share/*` sits before authentication and has its own per-IP rate limit (`AGENT_FS_SHARE_RATE_LIMIT`, default 120/min). Expired, revoked, used-up and unknown links all render the same "link expired" page. See the Sharing row below.

**HTML files.** A shared `.html` or `.htm` file renders in a sandboxed `<iframe>` on its page, with an "Open full page" link. Both load `GET /share/{token}/raw`, which always proxies the page (never a presigned redirect, at most 25 MB, else `413`) with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors 'self'`. The page runs in an opaque origin. Only that file is shared: relative assets next to it return `404`. Share the folder (a site share, below) when a page needs its assets. Download still sends `application/octet-stream`.

**Site shares.** `share-create` on a folder returns `kind: "site"` and a `/site/{token}/` URL instead of a `/share/{token}` page. `GET /site/{token}/{path}` serves the folder's files as they are, so a published HTML page loads its relative CSS, scripts, images and `fetch` calls. An empty path or a trailing slash serves `index.html`. A folder with no `index.html` gets a `302` to its only `.html`/`.htm` file, or else an HTML listing of its HTML pages (names escaped, relative links). Other files and sub-folders are never listed. A folder with no HTML page returns `404`. A sub-folder without its trailing slash gets a `301` to `{path}/` when that serves a page. The path is decoded once and a `.`, `..` or NUL segment is rejected (`400` or `404`), so a request never reaches outside the shared folder. Every response is proxied by the daemon (no presigned redirects, at most 25 MB per file, else `413`) and carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors *`. With no `allow-same-origin` the page runs in an opaque origin: it has no `localStorage`, `sessionStorage` or cookies and cannot read the API host's storage. External fonts and CDNs still load. Responses also send `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`, `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`, and `OPTIONS` answers CORS preflights. **A page can read every file under its folder while the link is valid**, so do not publish a folder that also holds secrets. Site shares have no view limits (`maxViews` is rejected for folders) and record no `share_viewed` events; they end on expiry, `share-revoke` (`path` accepts the folder) or the creator's removal from the drive or org, after which they return `410`. `GET /share/{token}` with a site token redirects to `/site/{token}/`. `/site/*` sits before authentication with its own per-IP rate limit (`AGENT_FS_SITE_RATE_LIMIT`, default 600/min, because one page load makes many requests). Servers that support site shares list `html-sites` in the `/health` `features` array.

**Listing links.** `share-list` returns link metadata (`id`, `drive`, `path`, `kind`, `status` of `active`/`expired`/`exhausted`/`revoked`, `createdAt`, `createdBy`, `expiresAt` with `null` for never, `views`, `maxViews`, `lastViewedAt`, `revokedAt`, `revokedBy` (who revoked it, `{ userId, email, displayName }`; `null` while active, for links revoked before revokers were recorded, and for links that ended when their creator was removed from the drive or org), `canRevoke`), never the token, its hash or a URL: a link is shown only once, by `share-create`. `scope: "drive"` (default) lists the active drive's links; drive admins (and org admins who are drive members) see every member's links, everyone else only their own (`visibility: "all"` or `"own"`). With `path`, it returns the links on that file or folder plus folder links on any parent folder that also publish it (`relation: "exact"` or `"covering"`). `scope: "mine"` lists the caller's own links in every drive of the current org they are a member of; it never spans orgs, and a link in a drive the caller has left is listed only for that drive's admins. Active links only unless `includeInactive: true`; newest first, paged by `limit` (default 100, max 500) and `offset` with an exact `total`. Revoke with `share-revoke` and the row's `id` on the drive in `drive.id`. Servers that support it list `share-list` in the `/health` `features` array.

**Comments on HTML pages.** With `?__afs_comments=1`, `GET /site/{token}/{path}` appends a small script to a `text/html` file. The web app uses it to comment on the rendered page: the script reports the page text and the reader's selection to the parent window over `postMessage` and paints the highlights the parent sends back. It holds no credentials and receives no comment text, and it does nothing unless a parent window answers its handshake. Headers, the CSP and the sandbox are unchanged, and every other response is the stored bytes as they are. Comments are stored as usual, with a `quote` and, when the text is in the source, its lines. Servers that support this list `html-comments` in the `/health` `features` array.

## Operations

All operations are dispatched through `POST /orgs/{orgId}/ops`. Each expects `{"op": "<name>", ...params}`.

| Category | Operations |
|----------|-----------|
| **Content** | `write`, `cat`, `edit`, `append`, `tail` |
| **Navigation** | `ls`, `stat`, `tree`, `glob`, `find` |
| **File Management** | `rm`, `mv`, `cp` |
| **Version Control** | `log`, `diff`, `revert` |
| **Search** | `grep`, `fts`, `search` |
| **Maintenance** | `recent`, `reindex` |
| **Comments** | `comment-add`, `comment-list` (supports `pathPrefix`), `comment-get`, `comment-update`, `comment-delete`, `comment-resolve` |
| **Drive Members** | `drive-members` |
| **Favorites** | `favorite-add`, `favorite-remove`, `favorite-list` (per user, see below) |
| **Sharing** | `signed-url`, `share-create` (a file gets a `/share/{token}` page, a folder gets a `/site/{token}/` HTML site), `share-revoke`, `share-list` |
| **Webhooks** | `webhook-create`, `webhook-list`, `webhook-update`, `webhook-delete`, `webhook-test`, `webhook-deliveries`, `webhook-redeliver` (signed comment events, see below) |

**Favorites.** Each user stars files and folders for themselves: `favorite-add {path}`, `favorite-remove {path}` and `favorite-list {}`. The user is always the one the API key belongs to; the ops take no user id, and one user never sees another's favorites. Favorites are kept per drive and need viewer role. `favorite-add` returns `404` for a path that does not exist. Moving or renaming a file moves every user's star with it, deleting a file removes the stars on it, and a folder's star is removed once the folder is gone. Servers that support favorites list `favorites` in the `/health` `features` array.

**Webhooks.** `webhook-create {url, eventTypes, scope?, description?, pathPrefix?}` registers a URL that receives a signed POST for each listed event: the comment events (`comment.created`, `comment.mentioned`, `comment.updated`, `comment.resolved`, `comment.reopened`, `comment.deleted`) and `file.changed` (one per new file version, metadata only, never content). `file.changed` is sent only to webhooks that list it; `pathPrefix` limits it to one directory. The response carries the `whsec_` signing secret once; `webhook-list` never returns it. `webhook-test {id}` sends a signed `ping` inline. `webhook-deliveries {id, status?, limit?, cursor?, includePayload?}` lists a webhook's delivery log (payloads only with `includePayload`), and `webhook-redeliver {deliveryId}` queues one delivery to be sent again. Delivery needs `AGENT_FS_WEBHOOK_WORKER=true` on the server. Servers that support webhooks list `webhooks` in the `/health` `features` array. See [Webhooks](./webhooks.md) for payloads, signature checks, retries and URL rules.

For parameter details, see the [OpenAPI spec](./openapi.json).
