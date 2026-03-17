---
date: 2026-03-17T00:00:00-05:00
author: Taras & Claude
topic: "agent-fs Web UI — Human interface for browsing and commenting on files"
tags: [brainstorm, agent-fs, web-ui, frontend, files, comments]
status: complete
exploration_type: idea-to-develop
last_updated: 2026-03-17
last_updated_by: Claude
---

# agent-fs Web UI — Brainstorm

## Context

Taras wants to build a simple web UI for humans to interact with the agent-fs filesystem. The frontend talks directly to the agent-fs API — each user has their own API key. No backend-for-frontend needed.

**Core features:**
1. Credentials page (blocker) — set API endpoint + API key, stored in localStorage, multi-account support by default
2. File tree — browse files, search
3. Split view — click a file to preview alongside the tree
4. Detail view — full-screen file detail page
5. Comments — Google Docs-style inline comments on files

**Design constraints:**
- Clean, minimal, no branding
- Light and dark mode
- Super simple — thin client over the API

## Exploration

### Q: Who is the primary user of this UI?
End-users in an org — regular users browsing and commenting on files in a shared workspace, not just admin/developer oversight.

**Insights:** This means the UI should feel like a consumer-grade file browser (think Google Drive, Notion file views), not a developer tool or admin panel. UX polish matters. We should assume users may not be technical — clear affordances, no jargon.

### Q: What kinds of files will users typically be looking at?
Mostly text, but binary could appear too. Priority order for binary support: images > PDF > video > ppt/doc > other.

**Insights:** The viewer needs to be text-first (with syntax highlighting for code, markdown rendering) but extensible for binary types. A good strategy: start with a solid text/markdown viewer, add image rendering, then progressively add PDF/video viewers. Unknown types get a download fallback. Comments (GDoc style) make most sense on text-based files — for binary files, comments would likely be at the file level rather than inline.

### Q: Tech stack preference?
React — Vite + React SPA.

**Insights:** Good fit for this scope. Vite + React gives fast dev iteration, huge ecosystem for file tree components, syntax highlighting (Shiki/Prism), markdown rendering (react-markdown), and dark/light mode (CSS vars or something like next-themes adapted for Vite). Being a pure SPA with no backend simplifies deployment — can be hosted anywhere static (Vercel, S3+CloudFront, GitHub Pages).

### Q: Multi-account credentials screen UX?
Simple form + dropdown. Endpoint URL + API key. Optional name field — if not provided, generate a random slug as the label. Dropdown to switch between saved accounts.

**Insights:** This keeps it dead simple for first use (just paste endpoint + key, hit enter) while still supporting power users with multiple environments. Random slug generation avoids the friction of forcing a name but still gives each account an identity. The credential store in localStorage would be an array of `{ id, name, endpoint, apiKey }` objects. Should probably also have a "remove account" action.

### Q: File tree + split view layout?
A mix of IDE-style and file manager — NOT like VS Code. Should feel more like a personal drive (Google Drive, Dropbox). Tree/navigation on the left, content on the right, but the aesthetic should be warm and approachable, not developer-tool-like.

**Insights:** Key differences from IDE-style: (1) The tree should look more like a file manager sidebar — folders with clean icons, not monospace code-tree. (2) The right pane should feel like a document viewer, not a code editor. (3) Breadcrumb navigation at the top for context. (4) Clicking a folder navigates into it (like a file manager), expanding in-place is secondary. Think Notion's sidebar + Google Drive's main content area. The tree sidebar should be collapsible for mobile/small screens.

### Q: How do comments work in agent-fs?
Checked the API — comments are anchored to specific line ranges, not just file-level. Full model:
- **Anchoring:** file path (required) + optional `lineStart`/`lineEnd` + optional `quotedContent` + auto-captured `fileVersionId`
- **Threading:** Flat — root comments can have replies, but no nested replies
- **Resolution:** root comments can be resolved/reopened by anyone, tracks who resolved
- **Permissions:** author-only edit/delete, anyone can resolve
- **Soft delete:** nothing is truly removed

**Insights:** This maps perfectly to a Google Docs-style comment UX. For text files: user selects text → comment anchors to line range + quoted content. Comments appear as margin markers. For binary files: comments would be file-level (no lineStart/lineEnd). The flat threading model is actually ideal for a sidebar comment panel — each root comment is a "conversation" with replies below it. Resolution = checkmark to dismiss. The `quotedContent` field means we can show "this comment was about: ..." even if the file has changed since.

### Q: Where should the UI live in the repo?
New top-level directory — something like `live/` — not inside `packages/`. Keeps it visually separate from the backend monorepo while still being in the same git repo.

**Insights:** This is a pragmatic middle ground. It's in the same repo (easy to share types, single PR for API+UI changes) but not a workspace package (avoids tangling the Bun monorepo config). The `live/` name is interesting — it implies this is the "live" human interface. Vite + React project would just live at `live/` with its own `package.json`, `tsconfig.json`, etc. Could share the OpenAPI types from the server package via a simple import or code generation.

### Q: What kind of search should the UI expose?
Filename search by default, with a 3-way toggle: (1) File name, (2) Full-text search (FTS), (3) Semantic search.

**Insights:** This is a clean UX pattern — a single search bar with mode toggle (segmented control or pill selector). Filename search is local/fast (filter the tree). FTS and semantic search hit the API (`fts` and `search` ops respectively). Results for FTS/semantic would show as a list of file matches with highlighted snippets, replacing the tree temporarily. Clicking a result navigates to that file. The toggle avoids the confusion of mixing search types — user explicitly picks the mode.

### Q: How does navigation between split view and detail view work?
Split view is the default. Click a file → opens in the right pane (split). An expand/maximize button in the split pane goes to a full-screen detail page.

**Insights:** This means two "views" of a file: (1) split preview — lighter, maybe truncated for very large files, (2) full detail — dedicated route, shows everything including comment sidebar, metadata, version history(?). The detail page should be a proper route (`/files/{path}`) so it's shareable/bookmarkable. The split view is ephemeral — part of the browser layout state, not a route.

### Q: Should the UI support write operations (upload, edit, delete)?
Read-only + comments for v1. Browse, search, view, and comment — no file mutation.

**Insights:** This drastically simplifies the v1 scope. No upload flows, no delete confirmations, no edit conflicts, no optimistic updates. The API surface is just: `ls`, `tree`, `cat` (read content), `stat` (metadata), `fts`, `search`, `glob`, `grep`, and the comment ops. The UI is a "viewer with collaboration" — not a file manager. This is actually a smart scope constraint: agents write files, humans review and comment.

### Q: Light/dark mode behavior?
Follow OS preference by default (`prefers-color-scheme`), with a manual light/dark/system toggle.

**Insights:** Standard approach. CSS custom properties for theming, a `useTheme` hook that reads localStorage override or falls back to OS. Toggle stored in localStorage so it persists. Three states: light, dark, system. The toggle could be a small icon in the header/toolbar.

### Q: Comments in split view vs detail view?
Both, but collapsed in split view. Comment indicators (dots/markers on lines) visible in split, full comment panel only opens in detail view or via explicit toggle.

**Insights:** This is the right balance. In split view, subtle markers (colored dots in the gutter, or highlight on commented lines) give visual awareness that comments exist. Hovering a marker could show a tooltip with the comment. Clicking a marker could expand a small popover or navigate to detail view. In detail view, a full comment sidebar (right edge) with threaded conversations, reply input, resolve button.

### Q: Does the UI need org/drive awareness?
API key scopes to the org. If there are multiple drives, show a drive picker. But the org is implicit from the key.

**Insights:** This simplifies the auth flow — no org selection step. After entering credentials, the UI can call the API to discover available drives (probably a `ls` or equivalent at root level). If only one drive, auto-select it. If multiple, show a simple drive switcher in the sidebar header. The drive concept maps to a "workspace" or "volume" in the UI.

### Q: CSS framework / component library?
Tailwind CSS + Radix (headless components). Maximum control over aesthetics, no opinionated design system.

**Insights:** Tailwind + Radix is the sweet spot for "clean, no branding" — we get accessible primitives (dialogs, popovers, dropdowns, tooltips) without any visual opinions. Tailwind handles the design tokens (colors, spacing, typography) via CSS custom properties, which also makes dark mode trivial. For the file tree specifically, we'd build our own since file trees from component libraries rarely match the drive-like aesthetic we want.

## Synthesis

### Key Decisions

- **Product positioning:** Read-only file viewer with collaboration (comments). Agents write, humans review and comment.
- **Target user:** End-users in an org, not admins. Consumer-grade UX, not developer tool.
- **Tech stack:** Vite + React + TypeScript, Tailwind CSS + Radix primitives. **pnpm** as package manager (Vercel-compatible).
- **Repo location:** `live/` directory at the repo root (not a monorepo workspace package). Uses pnpm (not bun) since it will be deployed on Vercel.
- **Deployment:** Vercel. Static SPA build.
- **Auth model:** API key scopes to org. No org picker needed. Drive picker if multiple drives exist — confirmed: `GET /orgs/{orgId}/drives` returns `{ drives: [{ id, name, isDefault }] }`.
- **Credentials:** localStorage-based, multi-account. Simple form (endpoint + key + optional name, auto-generated slug fallback). Dropdown to switch.
- **Layout:** Drive-style (not IDE-style). Sidebar with folder tree + search, main pane for file content. Breadcrumb navigation. Collapsible sidebar. **Mobile responsive.**
- **Navigation:** Click file → split view (sidebar + content). Expand button → full-screen detail page (routable: `/files/{path}`).
- **Search:** Single search bar with 3-way toggle: filename (local filter), full-text (API `fts`), semantic (API `search`).
- **Comments:** GDoc-style anchored to line ranges + quoted content for **markdown and code files** (first-class inline experience). For other file types, file-level (top-level) comments only. Split view shows comment markers (collapsed). Detail view has full comment sidebar with threading and resolution.
- **File viewing:** Text-first (syntax highlighting, markdown rendering). Binary: images rendered, PDF/video later. Unknown types: download fallback.
- **Theme:** Follow OS `prefers-color-scheme`, manual light/dark/system toggle persisted in localStorage.
- **Write operations:** None in v1. Strictly read + comment.
- **API client:** Generate typed client from the OpenAPI spec (`docs/openapi.json`).
- **Data fetching:** TanStack Query (React Query) for caching, polling, and request deduplication. Polling for comment updates (no WebSocket needed for v1).
- **API coverage:** Confirmed the existing API ops are sufficient for v1. Read-only ops needed: `ls`, `tree`, `cat`, `stat`, `tail`, `fts`, `search`, `glob`, `grep`, `log`, `diff`, `recent`. Comment ops: `comment-add`, `comment-list`, `comment-get`, `comment-update`, `comment-delete`, `comment-resolve`. Management: `GET /orgs/{orgId}/drives`, `GET /auth/me`.

### Open Questions (Remaining)

- **File size limits:** How does the UI handle very large files? Truncation, pagination, or lazy loading? (The `cat` op supports `offset`/`limit` — could paginate. TBD on the UX.)

### Constraints Identified

- No backend — pure static SPA, all API calls from the browser (CORS must be enabled on the agent-fs API).
- API key stored in localStorage — acceptable for this use case but worth noting the security posture (anyone with browser access can extract the key).
- Comment anchoring depends on `lineStart`/`lineEnd` — requires line-number-aware rendering in the viewer.
- The `fileVersionId` on comments means we need to handle stale comments gracefully when file content changes.

### Core Requirements (Lightweight PRD)

1. **Credentials gate:** Full-screen auth page blocks all access until valid credentials are provided. Multi-account CRUD in localStorage. Account switcher accessible from any page.
2. **File browser:** Left sidebar with folder tree (lazy-loaded per directory). Drive-like aesthetic — folder icons, clean typography, no monospace. Breadcrumb path bar at top.
3. **Search:** Search bar in sidebar header. 3-way toggle (filename / FTS / semantic). Filename filters tree in-place. FTS/semantic show result list with snippets.
4. **Split view:** Clicking a file opens content in the right pane. Text files: syntax-highlighted with line numbers. Markdown: rendered. Images: displayed. Other: metadata + download link. Comment markers visible on commented lines.
5. **Detail view:** Full-screen route (`/files/{path}`). Same file viewer but with comment sidebar. Sidebar shows threaded comments, reply input, resolve/reopen. Text selection → new comment flow.
6. **Comments:** Add comment (with optional text selection for line anchoring + quoted content). Reply to comment. Resolve/reopen. Delete own comments. Visual indicators on commented lines.
7. **Theme:** Light/dark/system toggle. CSS custom properties. Persisted preference.
8. **No branding:** Clean, neutral design. No logos, no product name in the UI beyond maybe a subtle wordmark.
9. **Mobile responsive:** Layout adapts for mobile — sidebar collapses, content fills screen. Touch-friendly interactions.

## Next Steps

- Parked. Ready for `/create-plan` when Taras wants to proceed with implementation.
