---
date: 2026-03-19T12:00:00Z
topic: "Shareable URLs & Signed URLs"
status: completed
autonomy: critical-questions
---

# Shareable URLs & Signed URLs

## Summary

Two related features:
1. **Shareable URLs in the live app** — URL updates on file selection to `/file/~/<org_id>/<drive_id>/<path>`, with copy buttons for path and URL
2. **`app_url` in API responses** — CLI and MCP responses include a shareable link to the live app
3. **`signed-url` op** — S3 presigned URL generation with configurable expiry (default 24h), exposed via CLI and MCP

---

## Phase 1: Live App — URL-based file navigation

**Goal:** When a user selects a file, the browser URL updates to `/file/~/<org_id>/<drive_id>/<full_path>`. Opening that URL directly loads the file. Copy buttons allow sharing.

### Changes

#### 1.1 Update routes in `live/src/App.tsx`

Current routes:
- `/files/*` → detail view (full page)
- `/files` → browser view (sidebar + viewer)
- `*` → redirect to `/files`

New routes:
- `/file/~/:orgId/:driveId/*` → browser view with file selected (primary shareable route)
- `/detail/~/:orgId/:driveId/*` → detail view (full-page with version history, comments sidebar, metadata) — replaces old `/files/<path>`
- `/files` → browser view, no file selected (landing/browse mode)
- `/credentials` → credentials page (unchanged)
- `*` → redirect to `/files`

**Keep `FileDetailPage`** — it has version history, comments sidebar, and file metadata that `FileBrowserPage` lacks. Just update its route from `/files/<path>` to `/detail/~/:orgId/:driveId/<path>` so it uses the same URL scheme. The "expand" button on `ViewerHeader` navigates to the detail route.

#### 1.2 Update `BrowserProvider` to sync with URL

The `BrowserProvider` currently stores `selectedFile` in sessionStorage and doesn't interact with the URL. Changes:

- On mount: parse the URL to extract `orgId`, `driveId`, and file path. If present, set `selectedFile` and sync auth context (orgId/driveId).
- On `selectFile(path)`: navigate to `/file/~/<orgId>/<driveId>/<path>` using `react-router`'s `useNavigate`. Remove sessionStorage usage.
- On `selectFile(null)`: navigate to `/files`.
- Handle org/drive from URL: if URL specifies an org/drive, the `AuthProvider` should respect it (set activeOrgId/activeDriveId from URL params rather than localStorage on initial load).

This requires `BrowserProvider` to have access to URL params (via `useParams`) and navigation (via `useNavigate`).

#### 1.3 Add copy buttons to `ViewerHeader` in `live/src/components/viewers/FileViewer.tsx`

Add two icon buttons next to the filename in `ViewerHeader`:

- **Copy path** — copies the file path (e.g., `src/components/Button.tsx`) to clipboard
- **Copy URL** — copies the full shareable URL (e.g., `https://live.agent-fs.dev/file/~/org-123/drive-456/src/components/Button.tsx`) to clipboard

Use `navigator.clipboard.writeText()`. For copy feedback, use a brief inline state change (icon switches to `Check` for 1.5s, then reverts) — no toast library needed since the app doesn't have one. Use `Copy` and `Link` icons from `lucide-react` (already a dependency).

The base URL comes from `window.location.origin` (works for any deployment).

#### 1.4 Handle initial load from URL

When the app loads at `/file/~/:orgId/:driveId/some/file.ts`:
1. `AuthProvider` checks URL params and sets `activeOrgId`/`activeDriveId` from them (overriding localStorage defaults)
2. `BrowserProvider` sets `selectedFile` from the URL splat param
3. The viewer loads the file content

**Note:** The file tree currently has **no auto-expand capability** — all nodes start collapsed with local `useState(false)`. Auto-expanding to the selected file's parent path is out of scope for this plan. The file will load and display correctly; the user just needs to manually expand the tree to find it. Auto-expand can be added as a follow-up.

**Implementation approach:** Create a wrapper component at the route level that reads params and passes them to `AuthProvider`/`BrowserProvider` as initial values via props.

### Verification

```bash
# Build should pass
cd live && pnpm build

# Manual checks:
# 1. Navigate to /files — shows browser with no file selected
# 2. Click a file — URL changes to /file/~/<orgId>/<driveId>/<path>
# 3. Refresh — same file is loaded
# 4. Copy URL button — pastes the correct URL
# 5. Copy path button — pastes just the file path
# 6. Open URL in new tab — loads directly to that file
# 7. Change org/drive — URL updates accordingly
```

---

## Phase 2: `signed-url` op (core + server)

**Goal:** Generate an S3 presigned URL for a file's content, with configurable expiry.

### Changes

#### 2.1 Add `getPresignedUrl` to `AgentS3Client` (`packages/core/src/s3/client.ts`)

Add a new method using `@aws-sdk/s3-request-presigner`:

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async getPresignedUrl(key: string, expiresIn: number = 86400): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: this.bucket,
    Key: key,
  });
  return getSignedUrl(this.client, command, { expiresIn });
}
```

**Dependency:** `@aws-sdk/s3-request-presigner` needs to be added to `packages/core/package.json`.

#### 2.2 Create `signed-url` op (`packages/core/src/ops/signed-url.ts`)

```typescript
import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePath } from "./paths.js";

export interface SignedUrlParams {
  path: string;
  expiresIn?: number; // seconds, default 86400 (24h)
}

export interface SignedUrlResult {
  url: string;
  path: string;
  expiresIn: number;
  expiresAt: string; // ISO date
}

export async function signedUrl(
  ctx: OpContext,
  params: SignedUrlParams
): Promise<SignedUrlResult> {
  const normalizedPath = normalizePath(params.path);
  const key = getS3Key(ctx.orgId, ctx.driveId, normalizedPath);
  const expiresIn = params.expiresIn ?? 86400;

  // Verify file exists (throws 404 if not)
  await ctx.s3.headObject(key);

  const url = await ctx.s3.getPresignedUrl(key, expiresIn);

  return {
    url,
    path: normalizedPath,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}
```

#### 2.3 Register in op registry (`packages/core/src/ops/index.ts`)

Add to imports, registry, and re-exports:

```typescript
import { signedUrl } from "./signed-url.js";

// In opRegistry:
"signed-url": {
  description: "Generate a temporary presigned URL for direct file download. Default expiry is 24 hours (86400 seconds). The URL requires no authentication. Returns { url, path, expiresIn, expiresAt }.",
  handler: signedUrl,
  schema: z.object({
    path: z.string(),
    expiresIn: z.number().int().min(60).max(604800).optional(), // 1 min to 7 days
  }),
},
```

> **Note:** org/drive are **not** in the op schema — they come from `OpContext`, same as every other op (`cat`, `stat`, `write`, etc.). The API route `POST /orgs/:orgId/ops` and CLI global flags `--org`/`--drive` handle org/drive selection at a higher level.

#### 2.4 Add RBAC mapping (`packages/core/src/identity/rbac.ts`)

Add `"signed-url": "viewer"` to the `OP_ROLES` constant — if you can read a file, you can get a presigned URL for it. Without this entry, the default fallback is `"admin"` which would block non-admin users.

### Verification

```bash
bun run typecheck
bun run test

# Manual E2E:
bun run packages/cli/src/index.ts -- signed-url /some/file.txt
bun run packages/cli/src/index.ts -- signed-url /some/file.txt --expires-in 3600
# Should return a presigned URL that works in browser without auth
curl "<returned-url>" # should download the file
```

---

## Phase 3: CLI + MCP exposure for `signed-url`

**Goal:** Expose the signed-url op via CLI command and MCP tool.

### Changes

#### 3.1 Add CLI command (`packages/cli/src/commands/ops.ts`)

Add to `OP_COMMANDS` array:

```typescript
{
  name: "signed-url",
  args: [{ name: "path", required: true }],
  options: [{ flag: "--expires-in <seconds>", description: "Expiry in seconds (default: 86400 = 24h)" }],
},
```

Add `"expiresIn"` to the numeric parsing list (line ~95).

#### 3.2 Add formatter (`packages/cli/src/formatters.ts`)

```typescript
function formatSignedUrl(result: any): string {
  return `${result.url}\n\nExpires: ${formatDate(result.expiresAt)} (${result.expiresIn}s)`;
}

// Add to formatters registry:
"signed-url": formatSignedUrl,
```

#### 3.3 MCP — automatic

No changes needed. The MCP tool registration in `packages/mcp/src/tools.ts` auto-registers all ops from the core registry. Adding `signed-url` to the op registry automatically exposes it as an MCP tool.

### Verification

```bash
bun run typecheck

# CLI:
bun run packages/cli/src/index.ts -- signed-url /test.txt
bun run packages/cli/src/index.ts -- signed-url /test.txt --expires-in 3600
bun run packages/cli/src/index.ts -- signed-url /test.txt --json

# MCP: the tool should appear in ListTools
```

---

## Phase 4: `app_url` in API responses

**Goal:** File-related ops return an `appUrl` field pointing to the live app.

### Changes

#### 4.1 Add `AGENT_FS_APP_URL` config (`packages/core/src/config.ts`)

Add `appUrl` to `AgentFSConfig`:

```typescript
appUrl?: string; // e.g., "https://live.agent-fs.dev"
```

Add env override in `applyEnvOverrides`:

```typescript
if (env.AGENT_FS_APP_URL) config.appUrl = env.AGENT_FS_APP_URL;
```

#### 4.2 Add `appUrl` to `OpContext` (`packages/core/src/ops/types.ts`)

```typescript
export interface OpContext {
  // ... existing fields
  appUrl?: string; // Base URL for the live app
}
```

#### 4.3 Create `buildAppUrl` helper (`packages/core/src/ops/urls.ts`)

```typescript
export function buildAppUrl(
  baseUrl: string,
  orgId: string,
  driveId: string,
  path: string
): string {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${baseUrl}/file/~/${orgId}/${driveId}/${cleanPath}`;
}
```

#### 4.4 Add `appUrl` to relevant op responses

Rather than modifying each op individually, add a post-processing step in `dispatchOp` that enriches results with `appUrl` when:
1. `ctx.appUrl` is set
2. The result contains a `path` field

```typescript
// In dispatchOp, after handler returns:
if (ctx.appUrl && result && typeof result === "object" && "path" in result) {
  (result as any).appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, (result as any).path);
}
```

This automatically applies to: `write`, `stat`, `signed-url`, `rm`, `mv` (has `from`/`to` not `path` — skip), `cp` (same), `edit`, `append`, `cat`, `tail`, `log`, `revert`, `grep` matches, etc.

For `mv` and `cp` which have `from`/`to` instead of `path`, we can add a second check:

```typescript
if (ctx.appUrl && result && typeof result === "object" && "to" in result) {
  (result as any).appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, (result as any).to);
}
```

#### 4.5 Pass `appUrl` when constructing `OpContext`

**Important:** `opsRoutes()` receives `db, s3, embeddingProvider` as function params — it does NOT import config. Config IS available in `createApp()` (which calls `opsRoutes()`). The cleanest approach:

1. In `packages/server/src/app.ts` — `createApp()` already calls `getConfig()`. Read `config.appUrl` and pass it as a new param to `opsRoutes()`:

```typescript
// In createApp():
const config = getConfig();
app.route("/orgs", opsRoutes(db, s3, embeddingProvider, config.appUrl));
```

2. In `packages/server/src/routes/ops.ts` — accept `appUrl` as a 4th param and include it in the context:

```typescript
export function opsRoutes(db: DB, s3: AgentS3Client, embeddingProvider: EmbeddingProvider | null = null, appUrl?: string) {
  // ...inside handler:
  const ctx = { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: user.id, embeddingProvider, appUrl };
}
```

3. For MCP — same pattern. Pass `appUrl` to `createMcpServer()` options and include it in the context factory.

#### 4.6 Update CLI formatters

Add `appUrl` to the stat formatter if present:

```typescript
if (result.appUrl) {
  pairs.push(["App URL", result.appUrl]);
}
```

Update `signed-url` formatter to show it too:

```typescript
function formatSignedUrl(result: any): string {
  let out = `${result.url}\n\nExpires: ${formatDate(result.expiresAt)} (${result.expiresIn}s)`;
  if (result.appUrl) out += `\nApp:     ${result.appUrl}`;
  return out;
}
```

### Verification

```bash
bun run typecheck

# Set env and test:
AGENT_FS_APP_URL=https://live.agent-fs.dev bun run packages/cli/src/index.ts -- stat /test.txt
# Should show App URL field

AGENT_FS_APP_URL=https://live.agent-fs.dev bun run packages/cli/src/index.ts -- write /test.txt --content "hello"
# JSON output should include appUrl

AGENT_FS_APP_URL=https://live.agent-fs.dev bun run packages/cli/src/index.ts -- signed-url /test.txt --json
# Should include both url (presigned) and appUrl (live app)
```

---

## Phase 5: Version bump & skill update

**Goal:** Bump the package version and update the agent-fs MCP skill to document the new `signed-url` tool and `appUrl` field.

### Changes

#### 5.1 Bump version in root `package.json`

Patch bump (e.g., `0.x.y` → `0.x.y+1`).

#### 5.2 Update MCP skill / tool descriptions

If there's an agent-fs skill file (e.g., in a Claude Code plugin or SKILL.md), update it to document:
- `signed-url` tool: what it does, parameters, example usage
- `appUrl` field: when it appears in responses, what `AGENT_FS_APP_URL` controls

### Verification

```bash
# Check version matches
cat package.json | grep version
```

---

## Phase 6: E2E verification

### Automated E2E (scripts/e2e.ts) — DONE ✓

Added 7 signed-url tests to the E2E suite. All 50/50 tests pass.

| Test | What it verifies |
|------|-----------------|
| `signed-url` | CLI returns url, path, expiresIn (86400), expiresAt |
| `signed-url with custom expiry` | `--expires-in 3600` overrides default |
| `signed-url presigned URL is fetchable` | `curl <url>` returns actual file content ("Hello, agent-fs!") |
| `signed-url nonexistent file fails` | Proper `NOT_FOUND` error with "File not found: /path" message |
| `signed-url via API` | `POST /orgs/:orgId/ops` with `{ op: "signed-url" }` returns 200 + url |
| `signed-url via API — 404` | Same endpoint returns 404 + `{ error: "NOT_FOUND" }` for missing file |
| `signed-url via MCP` | MCP `tools/call` returns JSON with url, path, expiresIn |

Also fixed:
- Default rate limit bumped from 60 → 600 rpm
- E2E config uses 5000 rpm to prevent test flakiness
- `signed-url` error for missing files now returns proper `NotFoundError` instead of raw AWS SDK error

### Manual verification still needed

```bash
# Live app (Phase 1):
# 1. Navigate to /files, select a file, verify URL changes to /file/~/orgId/driveId/path
# 2. Refresh — same file is loaded
# 3. Copy URL button — pastes the correct URL
# 4. Copy path button — pastes just the file path
# 5. Open URL in new tab — loads directly to that file

# appUrl enrichment (Phase 4):
AGENT_FS_APP_URL=https://live.agent-fs.dev bun run packages/cli/src/index.ts -- stat /test.txt
# Should show "App URL" field
```

---

## Dependency summary

| Package | New dependency | Version |
|---------|---------------|---------|
| `packages/core` | `@aws-sdk/s3-request-presigner` | latest |

## Files modified

| File | Phase | Change |
|------|-------|--------|
| `live/src/App.tsx` | 1 | New route patterns: `/file/~/...` (browser) and `/detail/~/...` (detail) |
| `live/src/contexts/browser.tsx` | 1 | Sync selectedFile with URL navigation |
| `live/src/contexts/auth.tsx` | 1 | Accept orgId/driveId from URL params |
| `live/src/components/viewers/FileViewer.tsx` | 1 | Add copy path + copy URL buttons to ViewerHeader |
| `live/src/pages/FileBrowser.tsx` | 1 | May need updates for URL-based file selection |
| `live/src/pages/FileDetail.tsx` | 1 | Update route to `/detail/~/:orgId/:driveId/*` pattern |
| `packages/core/package.json` | 2 | Add `@aws-sdk/s3-request-presigner` |
| `packages/core/src/s3/client.ts` | 2 | Add `getPresignedUrl` method |
| `packages/core/src/ops/signed-url.ts` | 2 | New file — signed-url op |
| `packages/core/src/ops/index.ts` | 2 | Register signed-url op |
| `packages/core/src/identity/rbac.ts` | 2 | Add signed-url → viewer role mapping |
| `packages/cli/src/commands/ops.ts` | 3 | Add signed-url to OP_COMMANDS |
| `packages/cli/src/formatters.ts` | 3, 4 | Add signed-url formatter, update stat formatter |
| `packages/core/src/config.ts` | 4 | Add `appUrl` config + env override |
| `packages/core/src/ops/types.ts` | 4 | Add `appUrl` to OpContext |
| `packages/core/src/ops/urls.ts` | 4 | New file — buildAppUrl helper |
| `packages/core/src/ops/index.ts` | 4 | Post-process results with appUrl |
| `packages/server/src/routes/ops.ts` | 4 | Pass appUrl to OpContext |
| `packages/server/src/app.ts` | 4 | Pass appUrl to MCP context |
