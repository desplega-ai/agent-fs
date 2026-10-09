---
date: 2026-10-09T15:50:42Z
topic: "HTML Rendering and HTML Sites"
author: Claude (with Taras)
planner: Claude
status: in-progress
autonomy: autopilot
---

# HTML Rendering and HTML Sites Implementation Plan

## Overview

Render `.html` files in the live UI with working relative paths. Let users publish a folder as a public "HTML site". Both features use one mechanism: a **site share**. A site share is a share whose `path` is a folder. The daemon serves it at `/site/<token>/<sub-path>`.

- **Motivation**: Agents write HTML reports, for example `research/2026-10-09-radar-agent-swarm-vs-paperclip/radar.html` in Taras's drive. Today the live UI shows HTML as source only. File shares treat HTML as download-only.
- **Related**: `live/src/components/viewers/FileViewer.tsx`, `packages/core/src/ops/share.ts`, `packages/server/src/routes/share.ts`, `packages/server/src/share/render.ts`

## Current State Analysis

**Live UI**
- `FileViewer.tsx` picks a viewer through a chain of early returns (`:294` to `:420`). `.html` is in `TEXT_EXTS` (`:108`). It reaches the final text block and renders as read-only Monaco source (`:477-484`). The pencil makes it editable (`:462-474`).
- The Source/Preview toggle already exists:
  - `showRaw` state (`:142`).
  - The `e` shortcut, gated on `isMd || isTabTxt` (`:267-272`).
  - The `ViewerHeader` button (`:825-842`), shown when `showViewToggle` is set.
  - Markdown uses `viewingRaw = isMd ? showRaw : true` (`:415`) and `showViewToggle={isMd && !isEditing}` (`:430`).
- `PdfViewer.tsx` is the closest pattern. It gets a URL from a hook, then renders an `<iframe>` (`:13-36`).
- The API client (`live/src/api/client.ts`) sends `Authorization: Bearer` on every request (`:98`). An iframe cannot send that header. `createShare` (`:187-194`) calls op `share-create`.
- Server capability detection: the live UI reads the `/health` `features` list with `healthQueryOptions` (`live/src/lib/upload-limit.ts:20`). The pattern for a flag is `supportsShareLinks` (`live/src/lib/share-link.ts:5-12`).
- The file tree context menu blocks folder shares: `canShareLink = !isDir && ...` (`live/src/components/file-tree/FileTreeContextMenu.tsx:113`).
- Tests: the root `bun run test` runs pure helper tests in `live/src/lib/__tests__/*.test.ts`. Playwright specs are in `live/tests/`.

**Core and server**
- The daemon has **no signing secret**. A share token is 32 random bytes, and the DB stores only its SHA-256 hash (`packages/core/src/ops/share.ts:29-47`). Shares expire and can be revoked. Every byte request re-authorizes against the DB (`authorizeShareBytes`, `share.ts:215`).
- `shares` table: `packages/core/src/db/schema.ts:237-257`, plus raw DDL in `packages/core/src/db/raw.ts:137-166`. Existing DBs get additive changes from `packages/core/src/db/migrate.ts`. There is no `kind` column, so a share is always one file.
- `shareCreate` (`share.ts:382-437`) calls `headObject`. A folder has no object, so a folder path fails with `NotFoundError` today.
- `shareRevoke` by path is an exact match on `normalizePath(path)` (`share.ts:452-515`).
- Share routes (`packages/server/src/routes/share.ts`) are mounted before auth at `packages/server/src/app.ts:54`:
  - The routes are `/:token`, `/:token/raw` and `/:token/download`.
  - Sub-paths under `/share/<token>/` would collide with `raw` and `download`.
- `classifyShareFile` (`packages/server/src/share/render.ts:79`) maps HTML and SVG to download-only. That stays true for file shares.
- `getObject` buffers the whole body (`packages/core/src/storage/adapter.ts:78-127`). The local adapter has no presigned URLs (`packages/core/src/storage/local-adapter.ts:98`).
- Folders are implicit S3 prefixes. `ls` lists one level with `listObjects(prefix, { delimiter: "/" })` (`packages/core/src/ops/ls.ts:7-68`).
- Ops become MCP tools and HTTP ops automatically (`packages/mcp/src/tools.ts:12-65`). CLI commands are a hard-coded list (`packages/cli/src/commands/ops.ts:37-85`). Output formatters are in `packages/cli/src/formatters.ts:318-332`.
- Server tests: `packages/server/src/__tests__/share.test.ts` holds the harness (`createTestDb`, `MockS3Client`, `app.request`, `setSystemTime`).
- E2E: `scripts/e2e.ts`, "share links" section, lines `1814-2077`. It runs in both `--local-only` and MinIO modes.

**Test file Taras wants to use**
- `radar.html` (10 KB) is self-contained. It has inline CSS, inline SVG, and Google Fonts from `fonts.googleapis.com`. It has no relative references.
- It tests basic rendering and external font loading. The CSP must not block external styles and fonts.
- The same folder holds `data.json` and `radar-agent-swarm-vs-paperclip.png`. A small fixture page in that folder can test relative `fetch` and `<img>`.

## Desired End State

1. A user opens an `.html` file in the live UI. It renders in a sandboxed iframe by default. The Source toggle (button or `e`) shows Monaco source. The pencil still edits the source.
2. Relative references work in the rendered page: `<img src="x.png">`, `<link href="style.css">`, `<script src="app.js">`, `<script type="module">`, `fetch("data.json")`, and CSS `url()`. All of them resolve inside the file's folder.
3. `agent-fs share-create site/` on a folder returns `https://<daemon>/site/<token>/`. Anyone with the link sees `site/index.html`, and relative assets load. The link expires and can be revoked, like a file share.
4. The live UI file tree offers a share link on folders.
5. Rendered pages cannot read the live UI's localStorage. They cannot reach drive files outside the shared folder.

## What We're NOT Doing

- A separate user-content origin (phase 3 of the discussion). Pages run in an opaque sandbox origin. Inside them, `localStorage`, `sessionStorage` and cookies throw errors or have no effect.
- An HMAC signing secret. Site shares reuse the DB-backed share tokens. This avoids a new secret to configure, rotate and keep in sync across machines.
- SPA fallback routing, custom `404.html`, and custom domains.
- View limits (`maxViews`) on site shares. One page load fetches many assets, so a view count has no clear meaning. `share-create` rejects `maxViews` for folders.
- A share-list op, or a UI to manage existing shares.
- Rendering SVG files, or rendering HTML on file share pages (`/share/<token>`). Those stay download-only.
- Directory listing pages for folders with no `index.html`.

## Implementation Approach

- **One mechanism.** A site share is a `shares` row with `kind = 'site'` and a folder `path`.
  - The private viewer in the live UI mints a short-lived site share (1 hour) for the folder of the HTML file.
  - A public site is the same thing with a longer TTL.
  - Result: one route, one auth path, one set of tests.
  - Trade-off: the private viewer creates one `shares` row per folder per hour. Its URL is a bearer link that works without login until it expires. An HMAC token would also be a bearer link. The row cost is small, and revocation comes for free.
- **New route prefix `/site/:token/*`.** It avoids the `raw`/`download` collision under `/share/<token>/`. `GET /share/<token>` for a site share redirects to `/site/<token>/`.
- **The daemon proxies every response.** No 302 to presigned URLs, for three reasons:
  - A sandboxed page has an opaque origin, so `fetch` and module scripts need CORS headers. S3/R2 bucket CORS is outside our control.
  - Proxying keeps HTML documents on the daemon URL, so relative paths resolve.
  - One code path serves both the S3 and the local adapters.
  - Limit: 25 MB per request, because `getObject` buffers the body. Larger files get 413 with a plain message.
- **Security headers on every `/site` response:**
  - `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors *`.
    - No `allow-same-origin`, so the page gets an opaque origin.
    - No `default-src` limit, so external fonts and CDNs work. radar.html needs Google Fonts.
  - `Referrer-Policy: no-referrer`, because the token is in the path.
  - `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`.
  - `Access-Control-Allow-Origin: *`, so `fetch` from the opaque origin works. Any token holder can already read the content.
  - No `X-Frame-Options`, so the live UI (a different origin) can frame the page.
  - The content type comes from `detectMimeType` (`packages/core/src/ops/mime.ts:56`). `text/html` is allowed on this route.
- **Path rules for `/site/<token>/<rest>`:**
  - Read `rest` from the raw request URL (`new URL(c.req.url).pathname`), not from a Hono param that may be decoded already. Decode it exactly once, then run `assertPathInsideDrive` on the decoded value. Then join it to the share folder.
  - An empty `rest` or a trailing slash serves `index.html`.
  - If `rest` names no object but `rest/index.html` exists, return 301 to `rest/`. Relative paths need the slash.
  - Otherwise return 404.
- **Order:** core and server first, testable with `app.request`. Then the live UI viewer. Then the publishing surfaces (CLI, MCP, UI folder share, skill, docs, E2E). Then release and a check on prod.
- **Feature flag:** add `"html-sites"` to `SERVER_FEATURES`. The live UI shows the rendered view only when the daemon reports this flag. Otherwise it shows source, as today.

## Quick Verification Reference

- `bun run typecheck`
- `bun run test`
- `bun test packages/server/src/__tests__/site.test.ts`
- `cd live && pnpm build`
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (needs Docker)

---

## Phase 1: Site shares in core and the `/site` route

### Overview

The daemon serves folders at `/site/<token>/<path>`. `share-create` accepts a folder path and returns a site URL. A new server test file covers path resolution, auth, expiry, revocation and headers.

### Changes Required:

#### 1. Schema: `kind` column
**Files**: `packages/core/src/db/schema.ts`, `packages/core/src/db/raw.ts`, `packages/core/src/db/migrate.ts`
**Changes**:
- Add `kind TEXT NOT NULL DEFAULT 'file'` to `shares` in the Drizzle schema and in the raw DDL.
- Add an idempotent `ALTER TABLE shares ADD COLUMN kind ...` step to `runMigrations`. Use the same style as the existing additive steps.

#### 2. `shareCreate` accepts folders
**File**: `packages/core/src/ops/share.ts`
**Changes**:
- After `normalizePath` and `assertPathInsideDrive`, try `headObject`. If the object exists, keep today's file behavior.
- If it is not found, list one level at `getS3Key(org, drive, normalizePrefix(path))`, with no recursion.
  - If the level has any object or sub-prefix, create a share with `kind = 'site'`.
  - Otherwise throw `NotFoundError` with the message "File or folder not found".
- Allow the drive root (`/`) as a site.
- Reject `maxViews` with a validation error when the path is a folder.
- Return `kind` in the result. For sites, set `sharePath` to `/site/<token>/` and `url` to `apiUrl + sharePath`.
- Export a helper `siteObjectKey(share, rest)`:
  - It decodes `rest`.
  - It rejects `.`, `..` and NUL with `assertPathInsideDrive`.
  - It joins `rest` to the share folder and returns the storage key, or null if the path is not valid.

#### 3. `shareRevoke` by path matches folders
**File**: `packages/core/src/ops/share.ts`
**Changes**: Normalize the path the same way for both kinds, so `share-revoke --path site/` and `--path site` both revoke the folder share. Add a unit test for this.

#### 4. `/site` route
**File**: `packages/server/src/routes/site.ts` (new). Mount it in `packages/server/src/app.ts` next to `/share`, before `authMiddleware`.
**Changes**:
- `GET`/`HEAD /site/:token` returns 301 to `/site/:token/`.
- `GET`/`HEAD /site/:token/*`:
  1. Call `findShareByToken`, then `getShareState`. Return plain-text 404 for an unknown token or `kind !== 'site'`. Return 410 for an expired or revoked share.
  2. Resolve the key with the path rules above (index.html, and 301 for a folder without a slash).
  3. Call `getObject`. Return 413 if the body is larger than 25 MB.
  4. Re-authorize after the read with a fresh clock. This is the same idea as `stillAllowed` in `streamObject` (`routes/share.ts:293`).
  5. Respond with the content type and the security headers from the Implementation Approach.
- Rate limit: one page load can make 10 to 30 requests. Give `/site` its own `ipRateLimitMiddleware` instance.
  - Config: `config.server.siteRateLimit.requestsPerMinute`, default 600.
  - Env: `AGENT_FS_SITE_RATE_LIMIT`, parsed in `packages/core/src/config.ts` next to the share limit (`:286`).
- Do not record `share_viewed` events and do not increment `views` for site shares. The live UI mints a site share every time a user views an HTML file, so events would flood the activity feed and the change stream.
- `OPTIONS /site/:token/*` returns 204 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD` and `Access-Control-Allow-Headers: *`, so preflighted `fetch` calls from pages work.
- Text types get `charset=utf-8` through `withUtf8Charset` (`packages/core/src/ops/mime.ts`).

#### 5. File share page redirects for sites
**File**: `packages/server/src/routes/share.ts`
**Changes**:
- In `GET /:token`, return 302 to `/site/<token>/` if the share has `kind = 'site'`.
- `/raw` and `/download` return 404 for site shares.

#### 6. Feature flag and OpenAPI
**Files**: `packages/server/src/features.ts`, `packages/core/src/openapi.ts`
**Changes**:
- Add `"html-sites"` to `SERVER_FEATURES`.
- Document `GET /site/{token}/{path}` next to the share routes.
- Regenerate `docs/openapi.json`: `bun run scripts/sync-openapi.ts`. `scripts/release.sh` also runs it.

#### 7. Tests
**File**: `packages/server/src/__tests__/site.test.ts` (new). Copy the harness from `share.test.ts:14-65`.
**Cases**:
- `share-create`:
  - A folder share returns `kind: "site"` and a `/site/<token>/` URL.
  - A missing folder returns 404.
  - `maxViews` on a folder is rejected.
- Path resolution:
  - `/site/<t>/` serves `index.html` as `text/html`.
  - `/site/<t>/sub` with `sub/index.html` returns 301 to `sub/`.
  - `/site/<t>/data.json` serves JSON.
- Escapes: `/site/<t>/../other.txt`, `%2e%2e`, double-encoded `%252e%252e`, `%2F`-joined segments and NUL return 400 or 404. They never return bytes from outside the folder.
- Site share views write no `share_viewed` event and leave `views` at 0.
- `OPTIONS` returns 204 with the CORS headers.
- Kind separation:
  - A file share token on `/site/` returns 404.
  - A site token on `/share/<t>` returns 302 to `/site/<t>/`.
- Lifecycle: an expired share (`setSystemTime`) returns 410. A revoked share returns 410.
- Response headers:
  - The CSP contains `sandbox allow-scripts` and does not contain `allow-same-origin`.
  - `Referrer-Policy: no-referrer`, `nosniff` and `Access-Control-Allow-Origin: *` are set.
  - `X-Frame-Options` is absent.
- The 25 MB limit returns 413. Use a mock object larger than the limit.
- Both adapters: run the main cases with `presignedUrls: false` and `true`.
- Migration: an existing DB without `kind` gets the column, and old rows read as `'file'`.

### Success Criteria:

#### Automated Verification:
- [x] Types check: `bun run typecheck`
- [x] New route tests pass: `bun test packages/server/src/__tests__/site.test.ts`
- [x] Existing share tests still pass: `bun test packages/server/src/__tests__/share.test.ts`
- [x] Full suite passes: `bun run test`
- [x] No stale `.js` in src: `find packages/*/src -maxdepth 1 -name "*.js"` prints nothing

#### Automated QA:
- [x] Start a local daemon with the S3 variables cleared, because the repo `.env` points at R2 (see the memory note).
  - Write `qa-site/index.html` (with `<img src="pic.png">` and `fetch("data.json")`), `qa-site/pic.png` and `qa-site/data.json` with the CLI.
  - Run `share-create qa-site`.
  - Run `curl -sI` on the returned URL and `curl -s <url>data.json`.
  - Confirm 200, `text/html`, the CSP header and the JSON body.
- [x] `curl -s -o /dev/null -w '%{http_code}' '<url>..%2F..%2Fsecret.txt'` returns 400 or 404.

#### Manual Verification:
- [ ] Taras reviews the security header list and the decision to proxy every response (no presigned redirects).

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 2: HTML viewer in the live UI

### Overview

`.html` and `.htm` files render in a sandboxed iframe by default, with a Source toggle and edit support. The iframe loads a site share URL for the folder of the file, so relative paths work.

### Changes Required:

#### 1. Client type and helper module
**Files**: `live/src/api/client.ts`, `live/src/lib/html-view.ts` (new)
**Changes**:
- `ShareCreateResult` gets `kind?: "file" | "site"`.
- `html-view.ts` exports:
  - `HTML_SITES_FEATURE = "html-sites"` and `supportsHtmlSites(health)`, the same pattern as `share-link.ts:5-12`.
  - `isHtmlPath(path)`, true for `html` and `htm`.
  - `folderOf(path)` and `siteUrlFor(endpoint, sharePath, fileName)`. The function URL-encodes each segment of the file name.
  - A cache keyed by `endpoint/org/drive/folder`, stored in `localStorage` (key `liveui:site-tokens`), so reloads and new tabs reuse it. Each entry holds the site URL and its expiry. The API key is already in `localStorage`, so this adds no new exposure.
    - Mint with `client.createShare(org, drive, folder, { expiresIn: 900 })` (15 minutes). Page scripts can read this token, so a short TTL limits the damage if one sends it out.
    - Mint again when less than 3 minutes are left. Drop expired entries on read.
    - On a cache hit, send `fetch(url, { method: "HEAD" })` first. The parent page cannot read the status of a cross-origin iframe load, but this CORS `fetch` can. If the status is 404 or 410 (for example after `share-revoke --path`), drop the entry and mint again once.
    - This keeps the count to about four share rows per folder per hour per browser.

#### 2. `HtmlViewer` component
**File**: `live/src/components/viewers/HtmlViewer.tsx` (new)
**Changes**:
- A hook gets the site URL. Show a spinner while it loads and an error state on failure, the same shape as `PdfViewer.tsx:13-36`.
- Render `<iframe src={url} title={path} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals" referrerPolicy="no-referrer" className="w-full h-full border-0 bg-white" />`.
- Never add `allow-same-origin`.
- Give the iframe a `key` that changes after a save, so it reloads with the new content.
- **Drive-root confirm.** If the folder is the drive root, show a confirm panel in place of the iframe before minting: "This page can read every file in this drive for 15 minutes while it is open. Render it?" with Render and Show source buttons. Remember the choice per `org/drive/path` in `localStorage` (key `liveui:html-root-ok`). Show source sets `showRaw`.

#### 3. Wire into `FileViewer`
**File**: `live/src/components/viewers/FileViewer.tsx`
**Changes** (Option B from the research, so the content fetch, Source view and edit keep working):
- Add `htm` to `TEXT_EXTS` (`:108`).
- Set `const isHtml = isHtmlPath(path) && supportsHtmlSites(health)`. Read health with `useQuery(healthQueryOptions(client))`, as `use-file-actions.ts:19` does.
- Set `viewingRaw = (isMd || isHtml) ? showRaw : true` (`:415`).
- Set `showViewToggle={(isMd || isHtml) && !isEditing}` (`:430`).
- Extend the `e` shortcut gate to `isMd || isTabTxt || isHtml` (`:267`).
- In the body ternary (`:485`), render `<HtmlViewer>` when `isHtml` and not raw. Put this arm before the `<MarkdownViewer>` arm.
- Reset `showRaw` to `false` on a path change, if the code does not do this already, so each HTML file opens rendered.

#### 4. Glyph
**File**: `live/src/lib/file-glyphs.ts`
**Changes**: Add an `html`/`htm` case with the `Globe` icon and its own tint, next to the `FileCode` case (`:53-57`).

#### 5. Tests
**Files**: `live/src/lib/__tests__/html-view.test.ts` (new), `live/tests/html-viewer.spec.ts` (new Playwright spec)
**Cases**:
- Unit tests (fake client, modeled on `share-link.test.ts:81`):
  - `isHtmlPath`.
  - `folderOf` for a root file and a nested file.
  - `siteUrlFor` encoding of spaces, `#` and unicode.
  - Cache reuse within the TTL, across a fresh module load (simulated reload).
  - A new mint near expiry, and expired entries dropped.
- Playwright (follow the setup of the existing specs):
  - Open an HTML file. Assert the iframe exists, and its `sandbox` contains `allow-scripts` and not `allow-same-origin`.
  - Open an HTML file at the drive root. Assert the confirm panel shows and no iframe exists until Render is clicked.
  - Press `e`. Assert that Monaco source shows.

### Success Criteria:

#### Automated Verification:
- [x] Types check: `bun run typecheck`
- [x] Unit tests pass: `bun test live/src/lib/__tests__/html-view.test.ts`
- [x] Full suite passes: `bun run test`
- [x] Live UI builds: `cd live && pnpm build`
- [x] Playwright spec passes: `cd live && pnpm test:e2e tests/html-viewer.spec.ts`

#### Automated QA:
- [x] Use `agent-browser` against `pnpm dev` and a local MinIO daemon (see the memory note on live UI browser E2E).
  - Seed `qa-site/` from phase 1 and open `qa-site/index.html`.
  - Take a screenshot. Confirm that the image and the fetched JSON show.
- [x] Press `e` and confirm Monaco source shows. Press `e` again and confirm the rendered view returns.
- [x] Edit the HTML and save. Confirm the iframe shows the new content.
- [x] In the iframe, run a script that reads `parent.localStorage` and `localStorage`. Confirm both throw (opaque origin).
- [x] Point the UI at a daemon without `html-sites` (an older build or a stubbed `/health`). Confirm `.html` shows source with no toggle.
- _QA ran against an S3-compatible moto server, not MinIO: the MinIO community binary is no longer published (410) and the AIStor build refuses S3 operations without a license. Vite was started directly (`vite --host 127.0.0.1`) because `pnpm dev` wraps it in `portless`. The older server was a proxy that strips `html-sites` from `/health`._

#### Manual Verification:
- [ ] Taras checks that the rendered view looks right and the toggle placement feels natural.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 3: Publishing surfaces (CLI, MCP, UI folder shares, docs, E2E)

### Overview

Users and agents publish a folder as a site from the CLI, MCP and the live UI file tree. The skill and the docs explain the feature. E2E covers it in both modes.

### Changes Required:

#### 1. CLI output and op description
**Files**: `packages/cli/src/formatters.ts`, `packages/core/src/ops/index.ts`
**Changes**:
- `formatShareCreate` (`:318-326`) prints `Site: <url>` and drops the `Views:` line when `kind === "site"`.
- The `share-create` command needs no new flags, because the op detects folders.
- Update the op `description` (`ops/index.ts:262-270`) to say "file or folder". MCP picks this up automatically.

#### 2. MCP test
**File**: `packages/mcp/src/__tests__/tools.test.ts`
**Changes**: Add a case: `share-create` on a folder returns `kind: "site"` and a `/site/` URL.

#### 3. Live UI folder share
**File**: `live/src/components/file-tree/FileTreeContextMenu.tsx`
**Changes**:
- At `:113`, allow folders when `supportsHtmlSites(health)` is true.
- `copyShareLink` already uses `result.sharePath`, so the copied link is the site URL.
- Label the menu item "Copy site link" for folders.

#### 4. Skill
**File**: `skills/agent-fs/SKILL.md`
**Changes**:
- Update the `share-create` row (`:142`) to say "file or folder".
- Add a workflow section, "Publish an HTML site from a folder", after "Share a file with someone who has no account" (`:455-480`). Cover these points:
  - `index.html` is the entry point.
  - Relative paths work.
  - Pages have an opaque origin, so there is no localStorage and no cookies.
  - No view limits. The maximum expiry is 7 days.
  - Revoke with `share-revoke --path`.
  - A rendered page can read every file under its folder while its link is valid. Do not put secrets next to HTML you publish.
- Add triggers to the frontmatter description: "publish a site", "host this html", "share a folder".

#### 5. Docs
**File**: `docs/api-reference.md`
**Changes**: Describe site shares, the `/site/<token>/` route and the sandbox limits. Put this under "Share links are bearer secrets" (`:127`) and in the Sharing ops list (`:145`). No new docs page, so `landing/` needs no change.

#### 6. E2E
**File**: `scripts/e2e.ts`
**Changes**: Add a "site shares" block after the share links section (`~:2077`). It runs in both modes.
- Write `site-e2e/index.html`, `site-e2e/app.js`, `site-e2e/data.json` and `site-e2e/sub/index.html`.
- `share-create site-e2e --json` returns `kind: "site"` and a URL that contains `/site/`.
- `GET <url>` returns `text/html` with the CSP sandbox header.
- `GET <url>app.js` returns JavaScript.
- `GET <url>sub` returns 301 to `sub/`.
- `GET <url>..%2Fshare-e2e.md` returns no file bytes.
- `share-create site-e2e --max-views 1` fails.
- After `share-revoke --path site-e2e`, `GET <url>` returns 410.
- `/health` features include `html-sites`.
- Creating a site share through the HTTP ops route and through MCP works (same style as `:2003`).

### Success Criteria:

#### Automated Verification:
- [ ] Types check: `bun run typecheck`
- [ ] Full suite passes: `bun run test`
- [ ] MCP tests pass: `bun test packages/mcp/src/__tests__/tools.test.ts`
- [ ] Local E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
- [ ] Full E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`
- [ ] Live UI builds: `cd live && pnpm build`

#### Automated QA:
- [ ] CLI walkthrough on a local daemon:
  - `share-create qa-site` prints `Site: http://127.0.0.1:<port>/site/<token>/`.
  - Open the URL with `agent-browser`, with no login.
  - Take a screenshot that shows the page with its assets loaded.
- [ ] `agent-browser` on the live UI: right-click a folder and click "Copy site link". Confirm the copied URL contains `/site/`.

#### Manual Verification:
- [ ] Taras reads the new skill section and the docs paragraph.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 4: Release and prod check

### Overview

A new version is on npm, Fly (daemon) and Vercel (live UI). Taras's `radar.html` renders on `live.agent-fs.dev`.

### Changes Required:

#### 1. Version bump
**Command**: `./scripts/release.sh 0.15.3`
- This is a patch release: a new feature with no breaking change, per the release checklist.
- Never edit `package.json` or `.claude-plugin/plugin.json` by hand.
- See [RELEASING.md](../../../RELEASING.md).

#### 2. Lockfile
**Command**: `bun install --frozen-lockfile`. If `bun.lock` changed, commit it with the version bump.

### Success Criteria:

#### Automated Verification:
- [ ] Version targets agree: `bun run scripts/sync-versions.ts --check`
- [ ] Lockfile is in sync: `bun install --frozen-lockfile`
- [ ] CI is green on the PR: `gh pr checks <pr-number>`

#### Automated QA:
- [ ] After the merge, `curl -s https://<prod-daemon>/health | jq .features` includes `html-sites`.
- [ ] Use `agent-browser` on the radar URL in the Manual E2E section. The screenshot shows the rendered radar with Google Fonts, not source.

#### Manual Verification:
- [ ] Taras confirms that the radar page renders on prod and the Source toggle works.

**Implementation Note**: A merge to `main` deploys prod: the daemon on Fly and the live UI on Vercel. Get Taras's approval before the merge.

---

## Manual E2E

Run these steps on prod after Phase 4 deploys.
- `<org>` = `648a5f3c-35c8-4f11-8673-b89de52cd6bd`
- `<drive>` = `2faf73ba-4eee-4472-8b3b-359c4ed6bfbb`
- `<dir>` = `research/2026-10-09-radar-agent-swarm-vs-paperclip`

1. **Self-contained HTML in the viewer.**
   - Open `https://live.agent-fs.dev/file/~/<org>/<drive>/<dir>/radar.html`.
   - Expect the rendered radar with the Instrument Serif and Geist fonts.
   - Press `e` and expect source. Press `e` again and expect the rendered view.

2. **Relative paths.** This step writes one file to Taras's drive, so ask first.
   ```bash
   agent-fs --org <org> --drive <drive> write <dir>/relative-test.html --content '<!doctype html><img src="radar-agent-swarm-vs-paperclip.png" width="400"><pre id="o"></pre><script>fetch("data.json").then(r=>r.text()).then(t=>o.textContent=t)</script>'
   ```
   - Open `.../<dir>/relative-test.html` in the live UI. Expect the PNG and the `data.json` text.
   - Delete the file afterwards: `agent-fs --org <org> --drive <drive> rm <dir>/relative-test.html`.

3. **Public site from a folder.**
   ```bash
   agent-fs --org <org> --drive <drive> share-create <dir> --expires-in 3600 --json
   ```
   - Expect `kind: "site"`.
   - Open `<url>radar.html` in a private window (no login) and expect the radar.
   - Open `<url>` alone and expect 404, because the folder has no `index.html`.

4. **Revoke.**
   ```bash
   agent-fs --org <org> --drive <drive> share-revoke --path <dir>
   ```
   - Reload `<url>radar.html` and expect 410.

5. **Escape attempt.**
   - Run `curl -s -o /dev/null -w '%{http_code}\n' '<url>..%2F..%2FREADME.md'`.
   - Expect 400 or 404.

---

## Appendix

- **Follow-up plans**:
  - A separate user-content origin, so pages get a real origin with localStorage and cookies (phase 3 of the discussion).
  - SPA fallback and `404.html` support.
- **Derail notes**:
  - `getObject` buffers whole bodies. A streaming `getObject` would remove the 25 MB limit. It is out of scope.
  - The root `bun run test` glob does not include `live/src/stores/__tests__` or `live/src/hooks/__tests__`.
  - The local `agent-fs` CLI is 0.13.4, two minor versions behind the repo. Upgrade it before the Manual E2E.
- **References**:
  - Share op: `packages/core/src/ops/share.ts`
  - Share routes and headers: `packages/server/src/routes/share.ts`, `packages/server/src/share/render.ts`
  - Viewer: `live/src/components/viewers/FileViewer.tsx`, `live/src/components/viewers/PdfViewer.tsx`
  - Release process: `RELEASING.md`

## Review Errata

_Reviewed: 2026-10-09 by Claude (autopilot)_

### Critical
- [x] **Decided (Taras, option 2): an HTML file can read its whole folder subtree.** Phase 2 now uses a 15-minute viewer TTL and a one-time confirm for drive-root HTML files. Original finding: The rendered page gets a bearer URL scoped to its folder, and page scripts can read `location.href`. A hostile HTML file can send the token, or the files themselves, to an outside server. The CSP has no `connect-src` limit, because pages need CDNs. For a file at the drive root, the scope is the whole drive for up to 1 hour. The plan accepts this risk today. Options:
  1. Accept it as is, and document it in the skill and the docs.
  2. Accept it, but cut the viewer TTL to 15 minutes, and show a one-time confirm before rendering an HTML file at the drive root.
  3. Ask before rendering any HTML file that the user did not write (compare `author` from `stat`).
  - Recommendation was option 2. Applied to Phase 2 (items 1, 2 and 5). Also document the scope in the skill section (Phase 3, item 4).

### Important
- [x] Site shares recorded `share_viewed` events. Every HTML view in the live UI mints a site share, so this would flood the activity feed and the change stream. Fixed: site shares write no view events and keep `views` at 0 (Phase 1, item 4 and tests).
- [x] Path decoding was not exact. A Hono param may be decoded already, so a second decode can turn `%252e%252e` into `..`. Fixed: read the raw pathname, decode once, check after the decode. A double-encoding test was added.
- [x] The token cache was in memory only, so every reload minted a new share row. Fixed: the cache is in `localStorage`, with a `HEAD` check to detect revoked tokens.

### Resolved
- [x] Frontmatter had no `planner` field. Added.
- [x] There was no `OPTIONS` handler for preflighted `fetch`. Added to Phase 1.
- [x] Text responses had no charset. They now use `withUtf8Charset`.
- [x] The OpenAPI regeneration step named a script that does not exist. It now names `bun run scripts/sync-openapi.ts`.
