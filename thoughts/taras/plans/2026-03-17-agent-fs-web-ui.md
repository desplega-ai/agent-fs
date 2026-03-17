---
date: 2026-03-17T14:00:00-05:00
author: Claude
topic: "agent-fs Web UI — Implementation Plan"
tags: [plan, agent-fs, web-ui, frontend, react, vite]
status: completed
autonomy: autopilot
source_research: thoughts/taras/research/2026-03-17-agent-fs-web-ui-codebase.md
source_brainstorm: thoughts/taras/brainstorms/2026-03-17-agent-fs-web-ui.md
last_updated: 2026-03-17T21:00:00-05:00
last_updated_by: Claude (verification)
---

# Plan: agent-fs Web UI (`live/`)

## Overview

Build a read-only web UI for humans to browse files and collaborate via comments on an agent-fs instance. Pure SPA — no backend-for-frontend. Each user brings their own API endpoint + API key.

**Product positioning:** Agents write files, humans review and comment.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Directory | `live/` at repo root | Separate from `ui/` (marketing). Not a Bun workspace package. |
| Package manager | pnpm | Matches `ui/`, Vercel-compatible |
| Stack | Vite 8 + React 19 + TypeScript | Same versions as `ui/` landing page |
| Styling | Tailwind CSS 4 + shadcn v4 (@base-ui/react) | Matches `ui/` stack. shadcn v4 uses Base UI, not Radix. |
| Icons | lucide-react | Already used in `ui/` |
| Router | React Router v7 | Mature, well-documented, SPA-friendly |
| Data fetching | TanStack Query v5 | Caching, polling, request deduplication |
| Syntax highlighting | Shiki (via @shikijs/react) | Modern, accurate, many languages |
| Markdown | react-markdown + remark-gfm | Standard, lightweight |
| Types | Manual — copied from `core/ops/types.ts` | Avoids importing entire core package. OpenAPI response types don't exist yet. Drift risk is low since core types are stable. |
| Deployment | Vercel (static SPA) | Same as `ui/` |

## Dependency Graph (Phases)

```
Phase 0 (Backend prep)
    ↓
Phase 1 (Scaffold)
    ↓
Phase 2 (API Client + Auth)
    ↓
Phase 3 (File Browser)
    ↓ ↘
Phase 4 (Split View)   Phase 5 (Search) ← can run parallel
    ↓ ↙
Phase 6 (Detail View)
    ↓
Phase 7 (Comments)
    ↓
Phase 8 (Polish & Mobile)
```

---

## Phase 0: Backend Prep

Small, targeted backend fixes needed before the UI can work properly.

### Tasks

1. **Add raw content endpoint for binary files**
   - File: `packages/server/src/routes/ops.ts` (or new route file)
   - New endpoint: `GET /orgs/:orgId/drives/:driveId/files/:path+/raw`
   - Reads from S3 via `getObject()` (returns `Uint8Array`), streams raw bytes with appropriate `Content-Type` header (from `stat` or S3 `headObject`)
   - Needed because: `cat` op forces `TextDecoder`, destroying binary content. The S3 layer stores raw bytes but no endpoint exposes them.
   - Auth: same Bearer token auth as other endpoints
   - Used by: Phase 4 ImageViewer (and future PDF/video viewers)

2. **Expose `fileVersionId` in comment API responses**
   - File: `packages/core/src/ops/comment.ts`
   - Currently `fileVersionId` is captured at creation but not included in any response
   - Add it to `comment-get`, `comment-list`, and `comment-add` responses
   - Update `CommentEntry` type in `ops/types.ts` to include `fileVersionId?: number`

### Verification

```bash
bun run typecheck
bun run test
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
# Verify raw endpoint manually:
curl -H "Authorization: Bearer <key>" http://localhost:<port>/orgs/<orgId>/drives/<driveId>/files/some-image.png/raw -o /tmp/test.png
file /tmp/test.png  # Should show PNG image data
```

### Manual Review Point

Review the raw content endpoint design — confirm the URL pattern and auth model are appropriate. The `CommentEntry` type change is additive (new optional field), backward-compatible.

---

## Phase 1: Project Scaffold

### Prerequisites

- **portless** must be installed globally: `npm install -g portless`
- First-time HTTPS setup: `portless proxy start --https` (prompts for sudo to trust local CA)
- Dev URL: `https://live.agent-fs.localhost/` (portless proxies to Vite's ephemeral port)

### Tasks

1. **Initialize `live/` directory**
   ```bash
   mkdir live && cd live
   pnpm init
   ```

2. **Install core dependencies**
   ```
   # Runtime
   react, react-dom, react-router, @tanstack/react-query
   tailwindcss, @tailwindcss/vite
   @base-ui/react, shadcn
   class-variance-authority, clsx, tailwind-merge
   lucide-react

   # Dev
   vite, @vitejs/plugin-react
   typescript, @types/react, @types/react-dom
   ```

3. **Configure dev script with portless** — `live/package.json`
   ```json
   {
     "scripts": {
       "dev": "portless live.agent-fs vite"
     }
   }
   ```
   portless auto-detects Vite and injects `--port <ephemeral> --host` flags. No Vite config changes needed for this.

4. **Configure Vite** — `live/vite.config.ts`
   - React plugin + Tailwind CSS plugin
   - `@` alias → `./src`
   - SPA fallback for React Router

5. **Configure TypeScript** — `live/tsconfig.json`
   - Target: ES2022, module: ESNext, bundler resolution
   - Strict mode
   - Path alias: `@/*` → `src/*`

6. **Set up Tailwind CSS** — `live/src/index.css`
   - `@import "tailwindcss"` (v4 syntax)
   - CSS custom properties for theming:
     ```css
     :root { --background: 0 0% 100%; --foreground: 0 0% 3.9%; /* ... */ }
     .dark { --background: 0 0% 3.9%; --foreground: 0 0% 98%; /* ... */ }
     ```

7. **Set up shadcn** — `pnpm dlx shadcn@latest init`
   - Style: new-york (Base UI variant)
   - This creates `src/components/ui/` and `src/lib/utils.ts`

8. **Theme system** — `live/src/hooks/use-theme.ts`
   - Three states: `"light" | "dark" | "system"`
   - Reads from localStorage, falls back to `prefers-color-scheme`
   - Sets `dark` class on `<html>` element
   - `ThemeProvider` context wrapper

9. **Base layout shell** — `live/src/components/layout/`
   - `Shell.tsx` — outer container with sidebar + main area
   - `Sidebar.tsx` — left panel (placeholder content)
   - `Header.tsx` — top bar with breadcrumbs area + theme toggle
   - `ThemeToggle.tsx` — sun/moon/monitor icon toggle

10. **Create `.gitignore`** — `live/.gitignore`
    - `node_modules/`, `dist/`, `.env`, `.env.local`

11. **Create `vercel.json`** — `live/vercel.json`
    - SPA rewrite: `/** → /index.html`

12. **React Router setup** — `live/src/App.tsx`
   - Routes:
     - `/` → redirect to `/files` or credentials page
     - `/credentials` → credentials page
     - `/files/*` → file browser + detail view

13. **TanStack Query** — wrap app in `QueryClientProvider`

14. **Entry point** — `live/index.html` + `live/src/main.tsx`

### Target File Structure

```
live/
├── index.html
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── vercel.json              # SPA rewrite: /** → /index.html
├── public/
├── src/
│   ├── main.tsx             # ReactDOM.createRoot + providers
│   ├── App.tsx              # Router + routes
│   ├── index.css            # Tailwind + theme vars
│   ├── lib/
│   │   └── utils.ts         # cn() helper (from shadcn init)
│   ├── hooks/
│   │   └── use-theme.ts
│   ├── contexts/
│   │   └── theme.tsx        # ThemeProvider
│   └── components/
│       ├── ui/              # shadcn components (generated)
│       └── layout/
│           ├── Shell.tsx
│           ├── Sidebar.tsx
│           ├── Header.tsx
│           └── ThemeToggle.tsx
```

### Verification

```bash
cd live && pnpm dev
# Browser: https://live.agent-fs.localhost/
# ✓ portless proxy starts, HTTPS works with no browser warnings
# ✓ Page loads with empty shell layout
# ✓ Theme toggle cycles light → dark → system
# ✓ Dark mode respects OS preference when set to "system"
pnpm exec tsc --noEmit  # TypeScript passes
```

### Manual Review Point

Review the shell layout and theme toggle before proceeding to API integration.

---

## Phase 2: API Client + Credentials

### Tasks

1. **Define API types** — `live/src/api/types.ts`
   - Manually port response types from multiple source files:
     - `packages/core/src/ops/types.ts` — `LsEntry`, `LsResult`, `TreeEntry`, `TreeResult`, `CatResult`, `StatResult`, `LogResult`, `DiffResult`, `RecentResult`, `GlobResult`, `CommentEntry`, `CommentListEntry`
     - `packages/core/src/ops/fts.ts:9-18` — `FtsResult`, `FtsOpMatch` (locally defined, not in types.ts)
     - `packages/core/src/ops/search.ts:11-21` — `SearchResult`, `SearchResultItem` (locally defined)
     - `packages/core/src/ops/grep.ts:10-18` — `GrepResult`, `GrepMatch` (locally defined)
   - Only **response** types (not op params — those are plain objects passed to the client)
   - All `Date` fields typed as `string` (ISO-8601 on the wire)
   - Auth types: `MeResponse { userId: string, email: string, defaultOrgId: string | null, defaultDriveId: string | null }`

2. **API client** — `live/src/api/client.ts`
   - Class: `AgentFsClient`
   - Constructor takes `{ endpoint: string, apiKey: string }`
   - Methods mirror the CLI's `ApiClient` pattern:
     - `request(path, opts)` — internal, adds Bearer header, parses JSON, throws on error
     - `get(path)` / `post(path, body)` — HTTP helpers
     - `callOp<T>(orgId, op, params): Promise<T>` — typed dispatch
     - `getMe()` — `GET /auth/me`
     - `getDrives(orgId)` — `GET /orgs/{orgId}/drives`
   - Error type: `ApiError { message, error, suggestion?, field?, path? }`
   - Singleton pattern via context (not global)

3. **Credential store** — `live/src/stores/credentials.ts`
   - Shape: `Credential { id: string, name: string, endpoint: string, apiKey: string }`
   - localStorage key: `agent-fs-credentials`
   - Active credential stored separately: `agent-fs-active-credential`
   - Functions: `getCredentials()`, `saveCredential(c)`, `removeCredential(id)`, `getActiveCredential()`, `setActiveCredential(id)`
   - Auto-generate slug name if not provided (e.g. `api-7f3a`)

4. **Auth context** — `live/src/contexts/auth.tsx`
   - `AuthProvider` wraps the app
   - Exposes: `credential`, `client` (AgentFsClient instance), `user` (from `/auth/me`), `orgId`, `driveId`, `drives`
   - On mount: loads active credential from localStorage, creates client, calls `getMe()`
   - `getMe()` returns `{ userId, email, defaultOrgId, defaultDriveId }` — use `defaultOrgId` as the org context
   - Then fetch drives via `getDrives(defaultOrgId)` for drive picker
   - If `defaultOrgId` is null → show error ("No org found for this API key")
   - If no credential or auth fails → redirect to `/credentials`

5. **Credentials page** — `live/src/pages/Credentials.tsx`
   - Full-screen gate (no sidebar/shell)
   - Form: Endpoint URL input, API Key input (password field with toggle), optional Name input
   - "Connect" button — validates by calling `GET /auth/me`, shows error if fails
   - Saved accounts list below the form
   - Each saved account: name, endpoint (truncated), "Connect" / "Remove" buttons
   - On successful connect: save to localStorage, set as active, redirect to `/files`

6. **Account switcher** — `live/src/components/AccountSwitcher.tsx`
   - Dropdown in the sidebar header or shell header
   - Shows current account name + endpoint
   - Lists other saved accounts
   - "Add account" option → navigates to `/credentials`
   - Switching accounts: sets active credential, recreates client, refetches everything

### Target File Structure (additions)

```
src/
├── api/
│   ├── types.ts          # Response types (ported from core)
│   └── client.ts         # AgentFsClient class
├── stores/
│   └── credentials.ts    # localStorage CRUD
├── contexts/
│   ├── theme.tsx          # (from Phase 1)
│   └── auth.tsx           # AuthProvider
├── pages/
│   └── Credentials.tsx
└── components/
    └── AccountSwitcher.tsx
```

### Verification

```bash
cd live && pnpm dev
# 1. First load → redirected to /credentials (no saved accounts)
# 2. Enter a valid endpoint + API key → "Connect" succeeds
# 3. Redirected to /files (empty shell, but authenticated)
# 4. Refresh page → still authenticated (credential in localStorage)
# 5. Account switcher shows current account
# 6. Enter invalid API key → error message shown
# 7. Add second account, switch between them
pnpm exec tsc --noEmit
```

---

## Phase 3: File Browser

### Tasks

1. **Drive discovery + picker** — `live/src/components/DrivePicker.tsx`
   - On auth, fetch drives via `GET /orgs/{orgId}/drives`
   - If single drive → auto-select, no UI
   - If multiple → dropdown in sidebar header to switch drives
   - Store active drive in context

2. **File tree** — `live/src/components/file-tree/`
   - `FileTree.tsx` — recursive tree component
   - `FileTreeNode.tsx` — single node (file or folder)
   - Lazy-loaded: each folder fetches children via `ls` op on expand
   - TanStack Query for caching: `queryKey: ["ls", driveId, path]`
   - Visual style: drive-like, not IDE-like
     - Folder icons (lucide `Folder` / `FolderOpen`), file icons (by extension)
     - Clean typography (not monospace)
     - Indentation with subtle tree lines
   - Click folder → expand/collapse (toggle)
   - Click file → select it (sets active file in context)
   - Highlight currently selected file

3. **File browser context** — `live/src/contexts/browser.tsx`
   - `BrowserProvider` manages:
     - `activeDriveId: string`
     - `currentPath: string` (directory being viewed)
     - `selectedFile: string | null` (file open in split view)
   - Navigation functions: `navigateToFolder(path)`, `selectFile(path)`

4. **Breadcrumb navigation** — `live/src/components/Breadcrumbs.tsx`
   - Shows: `Drive Name / folder / subfolder / filename`
   - Each segment is clickable → navigates to that folder
   - Root element shows drive name (or icon)

5. **Sidebar assembly** — Update `Sidebar.tsx`
   - Top: Account switcher + Drive picker
   - Middle: Search bar (placeholder — Phase 5)
   - Main: File tree (scrollable)

6. **Empty states**
   - Empty drive: "No files yet" message
   - Loading: skeleton tree nodes

### Verification

```bash
cd live && pnpm dev
# Against a running agent-fs instance with files:
# 1. Sidebar shows file tree with correct folder structure
# 2. Click folder → expands to show children
# 3. Click file → file is highlighted in tree
# 4. Breadcrumbs update as you navigate
# 5. Drive picker appears if multiple drives exist
# 6. Tree caches — re-expanding a folder is instant
pnpm exec tsc --noEmit
```

---

## Phase 4: Split View (File Viewer)

### Tasks

1. **Split layout** — Update `Shell.tsx`
   - Sidebar (left) + Content pane (right)
   - Content pane shows selected file or "Select a file" placeholder
   - Sidebar is resizable (optional: CSS `resize` or a drag handle)

2. **File content fetching** — `live/src/hooks/use-file-content.ts`
   - TanStack Query hook: `useFileContent(driveId, path)`
   - Calls `cat` op with default limit (200 lines)
   - Returns `{ content, totalLines, truncated, isLoading, error }`
   - For large files: "Show more" button fetches next chunk

3. **File metadata** — `live/src/hooks/use-file-stat.ts`
   - TanStack Query hook: `useFileStat(driveId, path)`
   - Calls `stat` op
   - Returns metadata: size, author, content type, versions, dates

4. **Text viewer** — `live/src/components/viewers/TextViewer.tsx`
   - Syntax highlighting via Shiki (`@shikijs/react` or `shiki` with manual highlighting)
   - Language detection from file extension
   - Line numbers in left gutter
   - Line-level highlighting support (for comment anchors later)
   - Monospace font (JetBrains Mono — already in `ui/` deps)
   - Truncation notice if file is truncated

5. **Markdown viewer** — `live/src/components/viewers/MarkdownViewer.tsx`
   - `react-markdown` with `remark-gfm` (tables, strikethrough, task lists)
   - Styled with Tailwind prose classes (`@tailwindcss/typography`)
   - Toggle between rendered markdown and raw source

6. **Image viewer** — `live/src/components/viewers/ImageViewer.tsx`
   - Uses the raw content endpoint from Phase 0: `GET /orgs/:orgId/drives/:driveId/files/:path+/raw`
   - Renders `<img>` with `src` pointing to the raw endpoint URL (with Bearer token via fetch + `URL.createObjectURL`, since `<img src>` can't set auth headers)
   - Pattern: fetch raw bytes → create Blob → `URL.createObjectURL(blob)` → set as `<img src>`
   - Revoke object URL on unmount to prevent memory leaks
   - Supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`

7. **Fallback viewer** — `live/src/components/viewers/FallbackViewer.tsx`
   - For unknown/binary file types
   - Shows: file metadata (size, type, author, dates)
   - "Content preview not available for this file type"

8. **Viewer router** — `live/src/components/viewers/FileViewer.tsx`
   - Takes a file path, fetches stat + content
   - Routes to correct viewer based on content type / extension:
     - `.md` → MarkdownViewer
     - `.png/.jpg/.gif/.svg` → ImageViewer
     - text/* → TextViewer
     - fallback → FallbackViewer
   - Loading state: skeleton

9. **Expand button** — in viewer header
   - "Open full page" icon button → navigates to `/files/{path}` (detail view route)

### New Dependencies

```
shiki (or @shikijs/react)
react-markdown
remark-gfm
@tailwindcss/typography
```

### Verification

```bash
cd live && pnpm dev
# 1. Click a .ts file → syntax-highlighted code with line numbers
# 2. Click a .md file → rendered markdown with GFM support
# 3. Toggle markdown raw/rendered view
# 4. Click an image file → image displayed (or fallback)
# 5. Click unknown binary → fallback metadata view
# 6. Large file → "Show more" or truncation notice
# 7. "Expand" button visible in viewer header
pnpm exec tsc --noEmit
```

---

## Phase 5: Search

Can be developed in parallel with Phase 4.

### Tasks

1. **Search bar** — `live/src/components/search/SearchBar.tsx`
   - Input field in sidebar header (above file tree)
   - Debounced input (300ms)
   - Clear button (X icon)
   - Keyboard: `Cmd+K` / `Ctrl+K` to focus

2. **Mode toggle** — `live/src/components/search/SearchModeToggle.tsx`
   - Segmented control / pill selector below search input
   - Three modes: "Files" | "Full-text" | "Semantic"
   - Default: "Files"

3. **Filename search** — client-side
   - Filters the file tree in-place
   - Uses already-fetched tree data (or calls `glob` op for deeper search)
   - Highlights matching text in file names

4. **Full-text search** — `live/src/hooks/use-fts-search.ts`
   - TanStack Query: calls `fts` op with pattern
   - Results: `{ matches: [{ path, snippet, rank }] }`
   - Snippet has `<b>` markers for highlighting

5. **Semantic search** — `live/src/hooks/use-semantic-search.ts`
   - TanStack Query: calls `search` op with query
   - Results: `{ results: [{ path, score, snippet }] }`
   - Shows relevance score as visual indicator
   - **Graceful degradation:** If no embedding provider is configured, the API returns `{ results: [], hint: "..." }`. Detect this (empty results + `hint` field) and either disable the "Semantic" toggle option with a tooltip explaining why, or show the hint message inline.

6. **Search results list** — `live/src/components/search/SearchResults.tsx`
   - Replaces file tree when search is active
   - Each result: file path (truncated) + snippet preview
   - Click result → select file (opens in split view)
   - "Back to tree" button / clear search to return
   - Empty state: "No results found"

### Verification

```bash
cd live && pnpm dev
# 1. Type in search bar → results appear after debounce
# 2. "Files" mode → filters tree by filename
# 3. "Full-text" mode → API results with highlighted snippets
# 4. "Semantic" mode → API results with relevance scores
# 5. Click result → file opens in split view
# 6. Clear search → returns to file tree
# 7. Cmd+K focuses search bar
pnpm exec tsc --noEmit
```

---

## Phase 6: Detail View

### Tasks

1. **Detail route** — `/files/*` in React Router
   - Catch-all route: path segments after `/files/` = file path
   - Example: `/files/docs/readme.md` → views `docs/readme.md`
   - URL-encoded paths for special characters

2. **Detail page layout** — `live/src/pages/FileDetail.tsx`
   - Full-width (no sidebar, or sidebar collapsed)
   - Header: breadcrumbs + back button + file metadata (size, author, modified date)
   - Main: file viewer (reuses Phase 4 `FileViewer` component)
   - Right panel: comment sidebar (Phase 7 — placeholder for now)

3. **Version history** — `live/src/components/VersionHistory.tsx`
   - Expandable panel / tab in the detail view
   - Uses `log` op to fetch version history
   - List: version number, author, date, operation type, message
   - Click a version → shows diff

4. **Diff viewer** — `live/src/components/viewers/DiffViewer.tsx`
   - Uses `diff` op with two version numbers
   - Renders add/remove/context lines with appropriate colors
   - Green background for additions, red for removals
   - **Note:** The `lineNumber` field in `DiffChange` is declared in the type but never populated by the backend implementation. The viewer should compute line numbers client-side by counting context/add/remove lines sequentially.

5. **Navigation integration**
   - "Expand" button in split view → navigates to `/files/{path}`
   - Back button in detail view → returns to split view
   - Browser back/forward works correctly
   - Direct URL access works (bookmarkable)

### Verification

```bash
cd live && pnpm dev
# 1. Click "Expand" on a file in split view → /files/{path} route loads
# 2. Direct URL /files/some/file.ts loads correctly
# 3. Back button returns to split view
# 4. Version history shows file versions
# 5. Click a version → diff displayed with colored lines
# 6. Breadcrumbs work on detail page
pnpm exec tsc --noEmit
```

---

## Phase 7: Comments

### Tasks

1. **Comment hooks** — `live/src/hooks/use-comments.ts`
   - `useComments(driveId, path)` — TanStack Query, calls `comment-list` op
     - `refetchInterval: 10_000` (poll every 10s for new comments)
   - `useAddComment()` — mutation, calls `comment-add` op
   - `useReplyComment()` — mutation, calls `comment-add` with `parentId`
   - `useResolveComment()` — mutation, calls `comment-resolve` op
   - `useUpdateComment()` — mutation, calls `comment-update` op (edit body, author-only)
   - `useDeleteComment()` — mutation, calls `comment-delete` op
   - All mutations invalidate the comments query on success

2. **Comment markers in gutter** — Update `TextViewer.tsx`
   - Fetch comments for current file
   - For each comment with `lineStart`/`lineEnd`: render a marker icon in the gutter
   - Marker color: blue (unresolved), gray (resolved)
   - Hover marker → tooltip with first comment text
   - Click marker → scroll to comment in sidebar (detail view) or show popover (split view)

3. **Comment sidebar** — `live/src/components/comments/CommentSidebar.tsx`
   - Right panel in detail view
   - Lists root comments with inline replies
   - Each comment shows:
     - Author + relative time
     - Quoted content (if present, with line reference)
     - Comment body
     - Reply count / expand replies
     - Resolve button (checkmark)
     - Delete button (if own comment, trash icon)
   - Resolved comments: collapsed by default, toggle to show

4. **Add comment flow** — `live/src/components/comments/AddComment.tsx`
   - **With text selection (inline):**
     1. User selects text in the text viewer
     2. Floating "Comment" button appears near selection
     3. Click → comment input appears (inline or in sidebar)
     4. Captures: `lineStart`, `lineEnd`, `quotedContent` from selection
     5. Submit → `comment-add` with anchoring data
   - **Without selection (file-level):**
     1. "Add comment" button in sidebar header
     2. Comment input appears at top of sidebar
     3. Submit → `comment-add` with just `path`

5. **Reply flow** — `live/src/components/comments/CommentThread.tsx`
   - "Reply" link on each root comment
   - Inline reply input below the comment
   - Submit → `comment-add` with `parentId`

6. **Resolve/Reopen** — in `CommentThread.tsx`
   - Checkmark button on root comments
   - Toggle: resolved ↔ unresolved
   - Resolved comments visually dimmed

7. **Edit comment** — in `CommentThread.tsx`
   - Pencil icon on own comments only (same author check as delete)
   - Click → comment body becomes editable textarea
   - Save/Cancel buttons
   - Calls `comment-update` op with new body

8. **Delete** — in `CommentThread.tsx`
   - Trash icon on own comments only
   - Confirmation dialog before delete
   - Calls `comment-delete` op

9. **Split view comment indicators**
   - In split view (not full detail): show gutter markers only
   - Small badge on the "expand" button showing comment count
   - No full sidebar in split view

### Verification

```bash
cd live && pnpm dev
# Full lifecycle test:
# 1. Open a text file in detail view
# 2. Select some text → "Comment" button appears
# 3. Add a comment with line anchoring → appears in sidebar
# 4. Reply to the comment → reply appears nested
# 5. Resolve the comment → visually dimmed, checkmark active
# 6. Reopen the comment → back to active state
# 7. Delete own comment → confirmation → removed
# 8. Return to split view → gutter markers visible
# 9. Wait 10s → new comments from other users appear (polling)
# 10. File-level comment (no selection) works
pnpm exec tsc --noEmit
```

### Manual Review Point

The text selection → comment anchoring UX is the most complex interaction in the app. Review this carefully before moving to Phase 8.

---

## Phase 8: Polish & Mobile

### Tasks

1. **Mobile responsive layout**
   - Sidebar: collapsible via hamburger menu on small screens
   - Split view: stacks vertically on mobile (tree above, content below), or sidebar hidden
   - Detail view: full-width, comment sidebar becomes a bottom sheet or full-page overlay
   - Touch-friendly: larger tap targets, swipe to dismiss sidebar

2. **Loading states**
   - File tree: skeleton nodes (animated)
   - File viewer: skeleton with line placeholders
   - Comments: skeleton cards
   - Search: spinner or skeleton results

3. **Error handling**
   - API errors: toast notification with error message + suggestion
   - Network errors: "Connection lost" banner with retry
   - 401/403: redirect to credentials with message
   - Error boundary: catch React rendering errors, show fallback

4. **Keyboard shortcuts**
   - `Cmd+K` / `Ctrl+K` → focus search
   - `Escape` → close sidebar panels, deselect file
   - `↑` / `↓` → navigate file tree
   - `Enter` → select/open file

5. **Edge cases**
   - Very large files: paginated loading with "Load more" (cat offset/limit)
   - Empty directories: "This folder is empty" message
   - Deleted files: graceful handling if file disappears
   - Long file names: truncation with tooltip
   - Deep nesting: horizontal scroll in tree

6. **Performance**
   - Lazy load Shiki languages (don't bundle all)
   - Virtualize file tree for large directories (if needed)
   - Virtualize comment list for files with many comments

### Verification

```bash
cd live && pnpm dev
# Mobile testing (Chrome DevTools device emulation):
# 1. iPhone viewport → sidebar is hamburger menu
# 2. Can navigate and view files on mobile
# 3. Comments work on mobile (bottom sheet or overlay)
# Desktop:
# 4. Cmd+K focuses search
# 5. Network tab → disconnect → "Connection lost" banner
# 6. Invalid API key → redirected to credentials
# 7. Build succeeds with no warnings:
pnpm build
```

---

## Manual E2E Validation

After all phases are complete, test against a real agent-fs instance:

```bash
# 1. Start agent-fs daemon
cd /path/to/agent-fs && bun run packages/cli/src/index.ts -- daemon start

# 2. Create some test content
bun run packages/cli/src/index.ts -- write test.md "# Hello World\n\nThis is a test file."
bun run packages/cli/src/index.ts -- write code/example.ts "export function hello(): string {\n  return 'world';\n}"
bun run packages/cli/src/index.ts -- mkdir docs
bun run packages/cli/src/index.ts -- write docs/readme.md "# Documentation\n\nSome docs here."

# 3. Add some comments
bun run packages/cli/src/index.ts -- comment-add --path test.md --body "Looks good!" --line-start 1 --line-end 1
bun run packages/cli/src/index.ts -- comment-add --path code/example.ts --body "Should this be async?" --line-start 1 --line-end 2 --quoted-content "export function hello(): string {"

# 4. Start the UI
cd live && pnpm dev

# 5. Manual test checklist:
# [ ] Enter API endpoint (http://localhost:<port>) + API key → connects
# [ ] File tree shows test.md, code/, docs/
# [ ] Click test.md → markdown rendered in split view
# [ ] Click code/example.ts → syntax-highlighted TypeScript
# [ ] Expand to detail view → /files/code/example.ts route
# [ ] Comment sidebar shows "Should this be async?" with line anchor
# [ ] Select text → add new comment → appears in sidebar
# [ ] Reply to existing comment → reply appears
# [ ] Resolve comment → visually resolved
# [ ] Search "hello" in full-text mode → finds example.ts
# [ ] Search "example" in filename mode → filters tree
# [ ] Theme toggle works (light/dark/system)
# [ ] Add second account → switch between accounts
# [ ] Version history on a file with edits → shows versions
# [ ] Mobile viewport → responsive layout
```

---

## Estimated Scope

| Phase | T-shirt Size | Notes |
|-------|-------------|-------|
| Phase 0 | S | 2 small backend changes |
| Phase 1 | M | Project setup + config, mostly boilerplate |
| Phase 2 | M | API client + auth page + credential management |
| Phase 3 | M | File tree is custom-built, lazy loading |
| Phase 4 | L | Multiple viewer types, Shiki integration |
| Phase 5 | M | 3 search modes, result display |
| Phase 6 | M | Routing + version history + diff viewer |
| Phase 7 | L | Most complex phase — text selection, anchoring, threading |
| Phase 8 | M | Mobile, error handling, polish |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Shiki bundle size | Lazy-load languages, only bundle common ones |
| Text selection → line mapping | Need precise line number calculation from DOM selection; may need custom selection handling |
| Binary file viewing | v1 scope: images only, everything else gets metadata fallback |
| Comment anchoring drift | Show `quotedContent` so users see original context even if lines shifted |
| Type drift (manual types) | Types are stable; can add a script to diff against core types later |
| Large directories | Lazy loading per folder; virtualization if needed |

## Review Errata

_Reviewed: 2026-03-17 by Claude_

### Changes Applied

- [x] **Critical: No binary content endpoint** — Replaced Phase 0 `CommentListEntry` export (irrelevant since types are manually copied) with a new raw content endpoint (`GET /orgs/:orgId/drives/:driveId/files/:path+/raw`). Updated Phase 4 ImageViewer to use blob URL pattern with this endpoint.
- [x] **Critical: `/auth/me` response shape wrong** — Research doc claimed `{ id, email, createdAt }` but actual response is `{ userId, email, defaultOrgId, defaultDriveId }`. Fixed Phase 2 auth context to use correct shape and derive `orgId` from `defaultOrgId`.
- [x] **Important: FTS/Search/Grep types not in `types.ts`** — Phase 2 type porting now references the correct source files (`ops/fts.ts`, `ops/search.ts`, `ops/grep.ts`) where these types are locally defined.
- [x] **Important: Semantic search unavailability** — Phase 5 now handles the case where no embedding provider is configured (empty results + hint field → disable toggle or show message).
- [x] **Important: `diff` lineNumber never populated** — Phase 6 DiffViewer now notes this and specifies client-side line number computation.
- [x] **Important: `comment-update` (edit) missing** — Added edit comment task and `useUpdateComment` hook to Phase 7.
- [x] **Minor: Duplicate task numbering in Phase 1** — Fixed sequential numbering (1-14).
- [x] **Minor: Missing `.gitignore` and `vercel.json` tasks** — Added as explicit tasks in Phase 1 (were only in file structure, not tasks list).

### Not Changed (for discussion)

- [ ] **Research doc `/auth/me` inaccuracy** — The source research doc (`2026-03-17-agent-fs-web-ui-codebase.md` line 44) still says `GET /auth/me` returns `{ id, email, createdAt }`. Should be corrected separately to avoid future confusion.
