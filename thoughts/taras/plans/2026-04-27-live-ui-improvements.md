---
date: 2026-04-27
author: taras
topic: "Live UI improvements — header IA, sidebars, tree state, tooltips, keyboard, grid view, visual pass, responsive"
status: in-progress
autonomy: critical
last_updated: 2026-04-27
last_updated_by: claude (phase-7)
related:
  - thoughts/taras/brainstorms/2026-04-27-live-ui-improvements.md
  - thoughts/taras/research/2026-04-27-live-ui-improvements.md
---

# Plan: Live UI Improvements

## Overview

A multi-phase UX/visual overhaul of the `live/` SPA grounded in the [brainstorm](../brainstorms/2026-04-27-live-ui-improvements.md) (R1–R9) and the [research](../research/2026-04-27-live-ui-improvements.md). The work touches header IA (two-tier chrome), sidebar resize/collapse, durable tree expansion, middle-ellipsis + tooltips + UUID heuristic + type-aware glyphs in the file tree, tooltip audit + download, keyboard shortcuts, a new folder list/grid view, a visual pass via `frontend-design`, and a mobile drawer pattern. Implementation is **frontend-only** — no backend changes — and stays inside the `@base-ui/react` + shadcn `new-york` stack the repo has standardized on.

## Current State

### Frontend stack (verified)
- React 19 + react-router 7 + TanStack Query + Vite + Tailwind v4 + `next-themes`.
- Primitive lib: `@base-ui/react@^1.3.0` only (no Radix). `shadcn@^4.0.8` CLI is in deps for adding more primitives.
- Installed UI primitives (`live/src/components/ui/`): `badge`, `button`, `dropdown-menu`, `input`, `popover`, `spinner`, `textarea`, `tooltip` (8 files; **`tooltip` is already there, and `TooltipProvider` is mounted at App root** — `App.tsx:99,112`).
- Missing primitives we will need: **`Resizable`** (via `react-resizable-panels`), **`Sheet`** (custom base-ui Dialog wrapper), **`ContextMenu`** (via `@base-ui/react/menu` with `openOnContextMenu`), **`Dialog`** (for shortcut help overlay), **`Separator`**, **`ToggleGroup`** (for the list/grid view toggle).

### Layout / chrome
- `Shell.tsx` composes `[Sidebar][Header({breadcrumbs}) + main]`. Header is one 40px row.
- `Breadcrumbs.tsx` is monolithic — inlines org switcher, drive switcher (no separate `DrivePicker`), `(N)` count badges, and the in-drive path segments.
- `FileDetail.tsx` builds its **own inline header** at `:50-89` and does not use `Shell`.
- `Sidebar.tsx` is fixed `w-64` (256 px), no resize. Right-hand comments rail has a **hand-rolled** drag handle (`pages/FileBrowser.tsx:42-49`) and a **floating mobile toggle** inline in the same file (`:59-66`) — not a separate component.
- Provider tree is mounted **per-route**: `/files`, `/file/~/...`, `/detail/~/...`, and `/orgs/:orgId/files/*` each mount their own `<AuthProvider>`/`<BrowserProvider>`.

### State
- File-tree expansion is per-node `useState<boolean>(false)` (`FileTreeNode.tsx:47`); navigating to a file unmounts the entire tree (per-route provider trees) and resets every flag.
- Auth state (org/drive) is lifted to `auth.tsx` and persisted via `agent-fs-active-org` / `agent-fs-active-drive` localStorage keys.
- No store or localStorage for tree expansion or sidebar widths.

### Keyboard
- 3 handlers total: `cmd+k` focuses the always-mounted sidebar search input (no palette dialog), `Esc` deselects file, `cmd+Enter` submits a comment. No hotkey lib, no help overlay, no arrow-key tree nav.

### File-type rendering
- Tree icons are color-tints on the same generic lucide `File` glyph; no filename-pattern logic. Folder content is **not rendered** in the main area today — the page only renders the currently-selected file's viewer + comments rail. There is no list view and no grid view.

### Mobile
- Existing pattern uses Tailwind's **`lg:` (1024 px)** breakpoint, not the brainstorm's proposed 768 px. We will **standardize on `lg:`** since it's already in the codebase. The "MobileCommentToggle" referenced in research is inline JSX, not a separate component.

## Desired End State

A polished, Notion-clean, two-tier-chrome SPA where:
- Top chrome carries org + drive switchers; the breadcrumb below shows only the path inside the current drive.
- Both sidebars are resizable + collapsible, persisted per user, with re-open rails when collapsed.
- Tree expansion is durable across navigation and reloads.
- Long file names show middle-ellipsis; UUID-shaped folders are resolved when a `meta.json`/`.name` sibling exists; type-aware glyphs differentiate research / plan / brainstorm / markdown / image / pdf / generic.
- Every icon-only button has a tooltip; FileDetail toolbar has a download button; tree rows have a right-click menu (Open / Copy link / Download).
- Full pro-tool keyboard set with a discoverable `?` help overlay.
- A folder content view (list default, grid alternative) is available in `FileBrowser` when no file is selected, persisted as `liveui:browser:view`.
- Visual pass run via `frontend-design` skill aligns typography, spacing, color tokens, empty states.
- Below `lg:` (1024 px), both sidebars become slide-in `Sheet` drawers; resize handles hidden on touch.

### Verification
- `cd live && bun run build` succeeds (typecheck + Vite build are clean).
- All 9 requirements (R1–R9) from the brainstorm have shipped behavior validated manually.

## Key Design Decisions

These resolve the open questions in the research; locked before phasing.

| # | Decision | Rationale |
|---|---|---|
| D1 | **UUID resolution = heuristic only.** Look for sibling `meta.json` (`{ name }`) or a `.name` text file inside a UUID-shaped folder; fall back to middle-ellipsis. Pure frontend. | Confirmed by user. Honors the brainstorm's "no backend reshaping" constraint and avoids triggering the agent-fs core/MCP/CLI release checklist. |
| D2 | **`FileDetail` moves onto `Shell`.** Drop its inline 50–89 header; reuse the new two-tier chrome. | Removes duplicated header logic; one source of truth for top bar / path breadcrumb. |
| D3 | **Hoist `<AuthProvider>` + `<BrowserProvider>` above `<Routes>`.** All four route handlers (`/files`, `/file/~/...`, `/detail/~/...`, `/orgs/:orgId/files/*`) read from one provider tree. URL params become `useEffect`-synced into the provider rather than constructor args. | Cleanest fix for tree-expansion-resets-on-nav. Avoids relying on localStorage for in-session continuity. |
| D4 | **Adopt `react-resizable-panels` + a thin shadcn-style wrapper** under `live/src/components/ui/resizable.tsx`. | Industry standard; matches the brainstorm's "stay in shadcn ecosystem" intent. Mixed-lib risk is contained to one file (the wrapper) and mirrors what shadcn's CLI would generate. |
| D5 | **Replace the hand-rolled comments resize handle** in `FileBrowser.tsx` with the shared `Resizable`. | Consistency with the new left-sidebar resize. |
| D6 | **Extend `use-keyboard-shortcuts.ts` — no new hotkey library.** | The current set is small enough; we'll move the existing inline `cmd+k` listener (`SearchBar.tsx:27-36`) into the shared hook for symmetry. |
| D7 | **Mobile breakpoint = `lg:` (1024 px)**, matching existing code. | Brainstorm's 768 px was a guess; the codebase already gates the comments rail at `lg:`. |
| D8 | **`base-ui` consistently.** Custom wrappers for `Sheet` (base-ui Dialog) and `ContextMenu` (base-ui Menu with `openOnContextMenu`). | The errata in research confirms base-ui is the project's primitive lib; do not introduce Radix-based shadcn components. |
| D9 | **localStorage keys** (locked):<br>`liveui:tree { open, width }`<br>`liveui:comments { open, width }`<br>`liveui:tree:expanded` (string[] of node paths)<br>`liveui:browser:view` (`"list" \| "grid"`)<br>`liveui:uuid-cache` (Record<path, name>) | Single namespace `liveui:*` keeps debugging easy and avoids collisions with the existing `agent-fs-*` keys. |
| D10 | **No new dependency for fuzzy/UUID detection.** Inline regex `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` for UUID detection. | Tiny, exact; a lib would be overkill. |

## What We're NOT Doing

- No backend / API / schema changes.
- No folder-as-zip download.
- No share-permission UX redesign.
- No multi-org switcher in `AccountSwitcher` (out of scope; that switches credentials).
- No `VersionHistory` redesign.
- No comment count / unread badge infrastructure (data layer doesn't exist).
- No Search / Files-tab redesign (out of scope; cmd+k wiring stays).
- No mobile editing / comment-creation UX.

---

## Implementation Approach

8 sequential phases, each independently verifiable. Each phase ends with a commit (per workflow preference). Phases 4–8 can be partially reordered if reviews surface concerns; phases 1–3 are foundational.

```
1. Header IA refactor (R1)
2. Sidebar resize/collapse + tree expansion durability (R2/R3 layout + state)
3. File-tree polish: ellipsis, tooltips, UUID heuristic, glyphs, context menu (R2 polish)
4. Tooltip audit + Download button (R6 + R5 toolbar)
5. Keyboard shortcuts (R7)
6. FileBrowser folder view: list + grid toggle (R4)
7. Visual pass via frontend-design (R9)
8. Responsive / mobile drawers (R8)
```

---

## Phase 1: Header IA Refactor (R1)

### Overview

Split the monolithic `Breadcrumbs.tsx` into a top-chrome row (org + drive switchers, account, theme) and a pure-path breadcrumb row. Push `FileDetail` onto `Shell`. Hoist auth/browser providers above `<Routes>`.

### Changes

1. **Hoist providers** (`live/src/App.tsx`):
   - Move `<AuthProvider>` + `<BrowserProvider>` above `<Routes>`.
   - Replace `initialOrgId`/`initialDriveId`/`initialFile` constructor args with a new `<RouteParamsSync />` component mounted **inside** every route element that calls `useAuth().setOrgId(params.orgId)` and `useBrowser().setSelectedFile(params['*'])` from a `useEffect`.
   - `OrgFileRedirect` no longer mounts its own `<AuthProvider>`; it uses the hoisted one.
2. **Create `live/src/components/layout/TopBar.tsx`**:
   - Layout: `[OrgSwitcher][DriveSwitcher][spacer][SearchHint cmd+k][HealthIndicator][ThemeToggle][AccountSwitcher (account chip)]`.
   - Renders unconditionally inside `Shell`. Replaces the inline trio in `Header.tsx`.
   - Move `AccountSwitcher` from `Sidebar.tsx:9` into `TopBar` (right side).
3. **Extract `live/src/components/layout/OrgSwitcher.tsx` + `DriveSwitcher.tsx`** from `Breadcrumbs.tsx:22-89`. Each is a `DropdownMenu` with `(N)` count badge. Use `<Building2/>` and `<HardDrive/>` icons unchanged.
4. **Rewrite `live/src/components/Breadcrumbs.tsx`** to render only the in-drive path segments (current `:92-112` block). Rename file to `PathBreadcrumb.tsx` and update its single import in `Shell`.
5. **Update `Shell.tsx`**:
   - New shape: `[Sidebar][flex-col: <TopBar/>, <PathBreadcrumb/>, <main>{children}</main>]`.
   - Drop the `breadcrumbs` slot prop; `Shell` owns chrome composition now.
6. **Migrate `FileDetail` onto `Shell`**:
   - Delete the inline header at `pages/FileDetail.tsx:50-89`.
   - Wrap the page body in `<Shell>{...}</Shell>` (in `App.tsx`'s `DetailRoute`).
   - The filename + copy/link toolbar that was in the second header row becomes a sub-header inside the page body (preserved verbatim for now; toolbar polish happens in Phase 4).

### Files

- `live/src/App.tsx` — hoist providers, add `RouteParamsSync`, wrap `DetailRoute` in `Shell`.
- `live/src/contexts/auth.tsx` — accept external param updates via setters; remove URL-only-at-mount behavior.
- `live/src/contexts/browser.tsx` — same: setters callable post-mount.
- `live/src/components/layout/Shell.tsx` — new chrome composition.
- `live/src/components/layout/Header.tsx` — delete (its content migrates to `TopBar`).
- `live/src/components/layout/TopBar.tsx` — new.
- `live/src/components/layout/OrgSwitcher.tsx` — new.
- `live/src/components/layout/DriveSwitcher.tsx` — new.
- `live/src/components/PathBreadcrumb.tsx` — renamed from `Breadcrumbs.tsx`.
- `live/src/components/layout/Sidebar.tsx` — remove `<AccountSwitcher/>`.
- `live/src/pages/FileDetail.tsx` — delete inline header.

### Success Criteria

#### Automated Verification:
- [x] Typecheck passes: `cd live && bun run build`
- [x] No stale `Breadcrumbs.tsx` import remains: `grep -r "from.*Breadcrumbs" live/src/ | wc -l` → `0`
- [x] No `<Header>` component reference outside its own (deleted) file: `grep -r "from.*layout/Header" live/src/`
- [x] Vite dev server starts: `cd live && pnpm dev` boots without runtime error.

#### Manual Verification:
- [ ] Loading `/files` shows top row with `[OrgSwitcher][DriveSwitcher] ... [Health][Theme][Account]` and a separate path-breadcrumb row below.
- [ ] Switching orgs in `OrgSwitcher` updates the drive switcher and clears the path; switching drives updates the breadcrumb.
- [ ] Loading `/detail/~/.../foo.md` renders the same `Shell` chrome as `/file/~/...` (no duplicated 50-line inline header).
- [ ] Loading `/orgs/:orgId/files/foo.md` redirects through the hoisted `AuthProvider` without flicker.
- [ ] Clicking a file in the tree no longer reloads chrome (URL changes, providers stay mounted).

### QA Spec (optional)

| Step | Expected |
|---|---|
| Visit `/files` cold | Top chrome shows org + drive switcher + account; path breadcrumb empty. |
| Switch org via dropdown | Drive switcher repopulates; path empty; URL unchanged (state-only). |
| Visit `/detail/~/<org>/<drive>/some.md` | Same Shell chrome; filename appears as page sub-header. |
| Click a tree file | Chrome stable; URL changes; tree's previous expansion preserved (verifies hoist). |

**Implementation Note**: pause here before Phase 2 — chrome refactor is the riskiest structural change; Taras should manually exercise routing before we add resize.

---

## Phase 2: Sidebar Resize / Collapse + Tree Expansion Durability (R2 layout + state, R3)

### Overview

Add `react-resizable-panels`-backed resize/collapse for both sidebars; persist width + open state in localStorage. Lift file-tree expansion into a durable hook keyed by node path; persist to localStorage. Replace the hand-rolled comments resize handle.

### Changes

1. **Install dependency**: `cd live && pnpm add react-resizable-panels`.
2. **Add `live/src/components/ui/resizable.tsx`**: thin wrapper exporting `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` styled with our Tailwind tokens (mirroring the shadcn `new-york` template; written by hand — do not run `shadcn add` because it would target Radix).
3. **Add `live/src/hooks/use-resizable-sidebar.ts`** — `(key: string, defaults: { open, width, min, max }) => { open, width, setOpen, setWidth, toggle }`. Reads/writes `liveui:tree` and `liveui:comments`. Width is clamped to `[min, max]`.
4. **Refactor `Shell.tsx`** to use `<ResizablePanelGroup direction="horizontal">`:
   ```
   <ResizablePanelGroup>
     <ResizablePanel id="left" minSize=15 defaultSize=20 collapsible>
       <Sidebar/>
     </ResizablePanel>
     <ResizableHandle/>
     <ResizablePanel id="main">
       <TopBar/> <PathBreadcrumb/> <main>{children}</main>
     </ResizablePanel>
   </ResizablePanelGroup>
   ```
   Width persistence is wired via the `onResize` and `onCollapse` callbacks reading the same localStorage key.
5. **Comments rail**: Move the rail out of `pages/FileBrowser.tsx` into a new `<MainWithComments>` layout component used by both `FileBrowserPage` and `FileDetailPage`. Wrap it in another `ResizablePanelGroup` so the right rail is collapsible/resizable. Delete the manual resize handle JSX (`FileBrowser.tsx:42-49`).
6. **Collapsed-rail UI**: When a sidebar is collapsed, render a 32 px-wide "rail" containing a re-open icon button (`PanelLeftOpen` / `PanelRightOpen` from lucide). Tooltip: "Open sidebar `[`" / "Open comments `]`".
7. **Tree expansion durability**:
   - Add `live/src/stores/tree-expansion.ts` — a tiny hand-rolled store (no Zustand needed): `Set<string>` of expanded paths, with `localStorage` sync to `liveui:tree:expanded`. Exposes `useExpanded(path)` and `useToggleExpanded()` via `useSyncExternalStore`.
   - Update `FileTreeNode.tsx`: replace `useState<boolean>(false)` with `useExpanded(fullPath)`; replace `setExpanded(!expanded)` with `useToggleExpanded()`.
   - Because providers are now hoisted (Phase 1), expansion already survives navigation in-session; localStorage adds reload survival.
8. **Reset stale entries** when org/drive changes: in `auth.tsx:setOrgId`/`setDriveId`, call the store's `clear()` method (paths are not stable across drives).

### Files

- `live/package.json` — `react-resizable-panels`.
- `live/src/components/ui/resizable.tsx` — new.
- `live/src/hooks/use-resizable-sidebar.ts` — new.
- `live/src/components/layout/Shell.tsx` — wrap in `ResizablePanelGroup`.
- `live/src/components/layout/Sidebar.tsx` — accept `width` from parent (no longer hardcoded `w-64`).
- `live/src/components/layout/MainWithComments.tsx` — new shared layout.
- `live/src/pages/FileBrowser.tsx` — use `MainWithComments`; delete manual handle.
- `live/src/pages/FileDetail.tsx` — use `MainWithComments`.
- `live/src/stores/tree-expansion.ts` — new.
- `live/src/components/file-tree/FileTreeNode.tsx` — swap state source.
- `live/src/contexts/auth.tsx` — clear expansion store on org/drive change.

### Success Criteria

#### Automated Verification:
- [x] Typecheck: `cd live && bun run build`
- [x] `react-resizable-panels` is the only new dep: `cd live && cat package.json | grep -A1 dependencies`
- [x] No `useState.*expanded` left in tree files: `grep -r "useState.*expanded" live/src/components/file-tree/`
- [x] No manual resize math left: `grep -nE "onMouseDown.*clientX|isResizing" live/src/pages/FileBrowser.tsx` returns nothing.

#### Manual Verification:
- [ ] Drag the left sidebar handle — width updates smoothly; releases at clamp bounds.
- [ ] Reload — left sidebar restores to last width.
- [ ] Double-click handle to collapse; confirmed rail appears on the left with a re-open icon and a tooltip.
- [ ] Same flow for the right (comments) rail.
- [ ] Expand `thoughts/` and `thoughts/taras/`, click any file — both folders remain expanded.
- [ ] Reload — same expansion preserved.
- [ ] Switch org — expansion clears (paths are scoped to the prior drive).

### QA Spec (optional)

| Step | Expected |
|---|---|
| Drag tree handle to 320 px | Width persists across reload (localStorage `liveui:tree`). |
| Collapse comments rail, click re-open | Rail returns to last width. |
| Expand 3 nested folders, click a deep file | All 3 still expanded; selected file appears in viewer; URL changed. |
| Refresh | Same 3 folders expanded; selected file open. |
| Switch from drive A to drive B | Expansion cleared; tree is collapsed at root. |

**Implementation Note**: pause here before Phase 3 — verify resize/collapse and tree-state durability across reload + nav, since these are the highest-impact UX wins.

---

## Phase 3: File-Tree Polish (R2 — middle-ellipsis, tooltips, UUID heuristic, type-aware glyphs, context menu)

### Overview

Make the tree readable and discoverable. Middle-ellipsis preserves date prefixes / extensions / UUID suffixes; tooltips show full names; a UUID heuristic resolves recognized folders; type-aware glyphs differentiate research / plan / brainstorm / markdown / image / pdf / generic; a right-click context menu adds Open / Copy link / Download / Reveal-in-new-tab.

### Changes

1. **Add `live/src/lib/middle-ellipsis.tsx`** — a `<MiddleEllipsis text={...} />` component:
   - DOM: two flex spans inside `min-w-0`. Leading span has `flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`. Trailing span has `flex-shrink: 0` and renders the last 8 chars (or last `.ext` if present).
   - Pure CSS; no JS measurement.
2. **Wrap tree row labels in `<Tooltip>`**: tooltip content is the full untruncated `entry.name`. Use the existing `tooltip.tsx`. Wrap label only, not the whole row, to keep arrow-key targeting intact (Phase 5).
3. **Add `live/src/lib/uuid-resolver.ts`**:
   - `isUuidLike(s: string): boolean` — regex from D10.
   - `resolveUuidName(orgId, driveId, parentPath, uuid): Promise<string | null>` — TanStack Query hook variant `useUuidName(...)`:
     - Try `client.callOp("read", { path: \`${parentPath}/${uuid}/meta.json\` })`. If JSON parses and has `name`, use it.
     - Else try `read` on `${parentPath}/${uuid}/.name`. Trim, first line.
     - Else `null`.
   - Cache resolved names in `liveui:uuid-cache` (write-through; React-Query handles in-flight dedup).
4. **Update `FileTreeNode.tsx`**:
   - When `isUuidLike(entry.name) && isDir`, call `useUuidName(...)`; render the resolved name + a faint UUID hint suffix (`Workspace · 16990304`) when resolved. Fall back to `<MiddleEllipsis text={entry.name}/>`.
   - Replace `<MiddleEllipsis>` for non-UUID entries too.
5. **Type-aware glyphs**: replace `fileIcon(name)` (`FileTreeNode.tsx:9-38`) with a new `live/src/lib/file-glyphs.ts` exporting `glyphFor(name): { Icon, className }`. Mapping:

   | Pattern | Glyph (lucide) | Tailwind class |
   |---|---|---|
   | `**/research/*.md` or `research-*.md` | `Microscope` | `text-violet-500` |
   | `**/plans/*.md` or `*-plan.md` | `ListChecks` | `text-emerald-500` |
   | `**/brainstorms/*.md` or `*-brainstorm.md` | `Lightbulb` | `text-amber-500` |
   | `*.md` / `*.mdx` (default) | `FileText` | `text-emerald-500` |
   | `*.{ts,tsx,js,jsx}` | `FileCode` | `text-blue-500` |
   | `*.{json,yaml,yml,toml}` | `Braces` | `text-amber-500` |
   | `*.{css,scss}` | `Palette` | `text-purple-500` |
   | `*.{png,jpg,jpeg,gif,svg,webp}` | `Image` | `text-pink-500` |
   | `*.pdf` | `FileText` | `text-rose-500` |
   | default | `File` | `text-muted-foreground` |

   Folder glyphs unchanged (`Folder` / `FolderOpen`, amber-500).
6. **Right-click context menu**:
   - New `live/src/components/ui/context-menu.tsx` — wrapper around `@base-ui/react/menu` using `openOnContextMenu` (per base-ui docs). Re-export `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuSeparator`.
   - Wrap each tree row in `<ContextMenuTrigger>` with items: **Open**, **Copy link** (`/file/~/<orgId>/<driveId>/<path>` from `window.location.origin`), **Download** (Phase 4 wires the action; in this phase the item is present and disabled-with-tooltip until Phase 4 lands), **Open in new tab**.

### Files

- `live/src/lib/middle-ellipsis.tsx` — new.
- `live/src/lib/uuid-resolver.ts` — new (regex + hook).
- `live/src/lib/file-glyphs.ts` — new.
- `live/src/components/ui/context-menu.tsx` — new.
- `live/src/components/file-tree/FileTreeNode.tsx` — adopt all of the above; delete inline `fileIcon`.

### Success Criteria

#### Automated Verification:
- [x] Typecheck: `cd live && bun run build`
- [x] No inline `fileIcon` in `FileTreeNode.tsx`: `grep -n "fileIcon" live/src/components/file-tree/FileTreeNode.tsx` returns nothing.
- [x] UUID regex compiles + matches a sample: `bun -e 'console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test("16990304-76e4-4017-b991-f3e37b34cf73"))'` → `true`.

#### Manual Verification:
- [ ] In `thoughts/taras/research/`, `2026-04-14-kubernetes-deployment.md` shows `2026-04-14-kuber…ment.md` (date + extension visible) at narrow widths.
- [ ] Hover tree row → tooltip shows the full name.
- [ ] A UUID-named folder containing a `meta.json` with `{"name": "..."}` displays the resolved name (with faint UUID hint).
- [ ] A UUID-named folder without metadata still shows the truncated UUID (`16990304-…-cf73`).
- [ ] A research markdown file shows the `Microscope` glyph; a plan shows `ListChecks`; a brainstorm shows `Lightbulb`; a `.tsx` shows `FileCode`.
- [ ] Right-click on a tree row opens a menu with Open, Copy link, (disabled) Download, Open in new tab.
- [ ] "Copy link" copies a deep-link URL to clipboard.

### QA Spec (optional)

| Step | Expected |
|---|---|
| Open `live` and resize tree to 200 px | Long names show middle-ellipsis with date+ext intact. |
| Place `meta.json` `{"name": "Web Project"}` in a UUID folder, expand parent | Tree shows `Web Project · 16990304`. |
| Right-click `2026-04-27-foo.md` → Copy link | Clipboard contains `<origin>/file/~/<org>/<drive>/path/2026-04-27-foo.md`. |

**Implementation Note**: pause here. Phases 1–3 are the foundation; everything after is layered on top.

---

## Phase 4: Tooltip Audit + Download Button (R6 + R5 toolbar)

### Overview

Audit every icon-only button across `live/src/` and wrap with `<Tooltip>`; add a Download button to the FileDetail toolbar; wire the tree context-menu Download item from Phase 3.

### Changes

1. **Audit pass**: grep for `<Button.*size="icon` and `<button.*aria-label` across `live/src/`. Build a checklist:
   - `ThemeToggle.tsx` — sun/moon button.
   - `HealthIndicator.tsx` — status dot.
   - `MarkdownViewer`/`FileViewer` — raw/rendered toggle (`Code`/`Eye`).
   - `MarkdownViewer.tsx` — copy-link / copy-content if present.
   - `CommentSidebar.tsx:33-41` — `MessageSquarePlus` "Add comment".
   - `FileBrowser.tsx:71-113` — mobile comment toggle.
   - Top chrome (Phase 1) — collapse rail buttons, search hint.
   - Anything else surfaced by the grep.

   Each gets `<Tooltip><TooltipTrigger asChild>...</TooltipTrigger><TooltipContent>...</TooltipContent></Tooltip>`. Use `asChild` so we don't add wrapping `<button>`s.
2. **Download helper** — `live/src/lib/download.ts`:
   ```
   export async function downloadFile(client, path, filename) {
     const url = await client.getSignedUrl(path)  // existing API
     const a = document.createElement('a')
     a.href = url; a.download = filename ?? path.split('/').pop()
     document.body.appendChild(a); a.click(); a.remove()
   }
   ```
   If `getSignedUrl` is unavailable for the current backend, fall back to `client.fetchRaw(path)` + `URL.createObjectURL(blob)` + `<a>` click.
3. **FileDetail toolbar** (the page sub-header preserved from Phase 1): add `[copy filename] [copy link] [download]` icon buttons (existing copy/link stay; download is new). Each wrapped in tooltips.
4. **Wire tree context-menu Download item** (Phase 3 left it disabled): call `downloadFile(client, path)` from `lib/download.ts`.

### Files

- `live/src/lib/download.ts` — new.
- `live/src/pages/FileDetail.tsx` — toolbar download button.
- `live/src/components/file-tree/FileTreeNode.tsx` — enable Download menu item.
- Any icon-button-bearing files surfaced by the audit.

### Success Criteria

#### Automated Verification:
- [x] Typecheck: `cd live && bun run build`
- [x] Every icon button has a tooltip ancestor: run a custom check via `grep -rE 'size="icon"' live/src/components/ live/src/pages/ | wc -l` and visually confirm each is wrapped (manual since grep can't enforce ancestry).
- [x] `lib/download.ts` exports `downloadFile`: `grep -n "export.*downloadFile" live/src/lib/download.ts`

#### Manual Verification:
- [ ] Hover any icon button (theme, health, comments add, viewer toggle) → tooltip shows.
- [ ] Click Download in FileDetail toolbar → browser downloads the file with its real name + correct extension.
- [ ] Right-click tree row → Download → same behavior.
- [ ] Download a binary (e.g. PDF) → file is intact, opens correctly.

### QA Spec (optional)

| Step | Expected |
|---|---|
| Hover every icon-only button | All show tooltip. |
| Download `foo.md` from FileDetail | Browser saves `foo.md` with full content. |
| Right-click `image.png` → Download | Saves `image.png` (binary intact). |

**Implementation Note**: pause for review of the audit checklist before merging — it's easy to miss buttons.

---

## Phase 5: Keyboard Shortcuts (R7)

### Overview

Extend `use-keyboard-shortcuts.ts` to cover the full pro-tool set; add a `?` help overlay; add tree row focus + arrow nav; relocate `cmd+k` into the shared hook.

### Changes

1. **Extend `live/src/hooks/use-keyboard-shortcuts.ts`** to a registry:
   ```
   useKeyboardShortcuts({
     'cmd+k': () => searchInputRef.current?.focus(),
     'esc':   () => selectFile(null),
     '[':     () => toggleLeftSidebar(),
     ']':     () => toggleRightSidebar(),
     '?':     () => setHelpOpen(true),
     '/':     () => searchInputRef.current?.focus(),
     'enter': () => openFocusedTreeRow(),
     // tree-scoped (only when tree row has focus)
     'arrowdown'/'arrowup' / 'arrowleft' / 'arrowright': handled in tree
   })
   ```
   Listener attached at `document` level with a single `keydown` handler that dispatches by canonical key string.
2. **Move `cmd+k` listener** out of `SearchBar.tsx:27-36` into the central hook; expose the search input ref via a tiny `live/src/contexts/search-input.tsx` context (provides `register(ref)` / `focus()`).
3. **Tree row focus + arrow nav** in `FileTree.tsx` + `FileTreeNode.tsx`:
   - Track `focusedPath: string | null` in the tree-expansion store (or a sibling store).
   - Each row is `<button>` already; add `tabIndex={focusedPath === fullPath ? 0 : -1}` (roving tabindex pattern).
   - Arrow keys: `↓`/`↑` move focus to next/prev visible row; `→` expands a folder (or moves into first child); `←` collapses (or moves to parent); `Enter` opens the focused file.
   - Visual focus ring: `focus-visible:ring-2 ring-primary` on each row.
4. **Help overlay** — `live/src/components/HelpOverlay.tsx`:
   - Add a `Dialog` primitive (custom `live/src/components/ui/dialog.tsx` wrapping `@base-ui/react/dialog`).
   - Static list of shortcut groups: Navigation / Selection / Sidebars / Search / Help.
   - Triggered by `?` and via a help icon in `TopBar`.
5. **Update placeholder copy** in `SearchBar.tsx:87` and the empty-state hint at `pages/FileBrowser.tsx:29` to keep showing `⌘K`.

### Files

- `live/src/hooks/use-keyboard-shortcuts.ts` — extend.
- `live/src/contexts/search-input.tsx` — new.
- `live/src/components/search/SearchBar.tsx` — register ref; remove inline listener.
- `live/src/components/ui/dialog.tsx` — new (base-ui dialog wrapper).
- `live/src/components/HelpOverlay.tsx` — new.
- `live/src/components/layout/TopBar.tsx` — add help icon.
- `live/src/components/file-tree/FileTree.tsx` + `FileTreeNode.tsx` — roving tabindex + arrow nav.
- `live/src/stores/tree-expansion.ts` — extend with `focusedPath`.

### Success Criteria

#### Automated Verification:
- [x] Typecheck: `cd live && bun run build`
- [x] `cmd+k` listener no longer in SearchBar: `grep -nE "metaKey|ctrlKey" live/src/components/search/SearchBar.tsx` returns nothing relevant.
- [x] All shortcut keys registered: `grep -nE "'\\?'|'\\['|']'|'enter'|'/'|'esc'|'arrowdown'" live/src/hooks/use-keyboard-shortcuts.ts | wc -l` → ≥ 7.

#### Manual Verification:
- [ ] `cmd+k` focuses the sidebar search input.
- [ ] `?` opens the help overlay; `esc` closes it.
- [ ] `[` / `]` collapse/expand the left and right sidebars.
- [ ] Click a tree row, then `↑/↓` move focus up/down through visible rows; focus ring is visible.
- [ ] `→` on a collapsed folder expands it; `←` on an expanded folder collapses; `←` on a leaf moves focus to the parent folder.
- [ ] `Enter` on a file opens it.
- [ ] Shortcuts don't fire while typing in inputs/textareas.

### QA Spec (optional)

| Step | Expected |
|---|---|
| Focus tree, press ↓ ten times | Focus moves through visible rows (skips collapsed children). |
| With folder focused, press → | Folder expands; focus stays on the folder. |
| Press → again | Focus moves to the first child. |
| Press ? | Help overlay shows the full shortcut table. |

**Implementation Note**: large surface; pause for review before Phase 6.

---

## Phase 6: FileBrowser Folder View — list + grid toggle (R4)

### Overview

Today the main area shows only a selected file (or an empty card). Add a **folder content view** that renders when no file is selected, with a **list / grid toggle** persisted as `liveui:browser:view`. Reuse the type-aware glyphs from Phase 3.

### Changes

1. **New `live/src/components/folder-view/`**:
   - `FolderView.tsx` — top-level component: receives `path`, fetches `client.callOp("ls", { path })`, renders `<ListView/>` or `<GridView/>` based on the persisted view mode.
   - `ListView.tsx` — vertical table-ish layout: glyph + middle-ellipsis name + size + modifiedAt.
   - `GridView.tsx` — CSS grid `grid-cols-[repeat(auto-fill,minmax(160px,1fr))]`, each tile = glyph (large) + middle-ellipsis name (2 lines max, line-clamp).
   - `ViewModeToggle.tsx` — `ToggleGroup` (new primitive — see step 4) with `List` / `Grid` icons, persisted via a small hook.
2. **Empty state in `FileBrowserPage`**: replace the current `selectedFile == null` empty card with `<FolderView path={folderPath}/>`. `folderPath` is the URL splat (or empty string for drive root).
3. **Selecting an entry**:
   - Folder click → `navigate(\`/file/~/${orgId}/${driveId}/${currentPath}/${entry.name}/\`)` (path is the new folder; `selectFile(null)`).
   - File click → `selectFile(...)` (existing behavior).
4. **Add `live/src/components/ui/toggle-group.tsx`** wrapping `@base-ui/react/toggle-group`. Two-button group for `List` / `Grid`.
5. **Persist view mode** via a tiny `useLocalStorage('liveui:browser:view', 'list')` hook (or extend `use-resizable-sidebar` patterns). Read at `FolderView` mount.

### Files

- `live/src/components/folder-view/FolderView.tsx` — new.
- `live/src/components/folder-view/ListView.tsx` — new.
- `live/src/components/folder-view/GridView.tsx` — new.
- `live/src/components/folder-view/ViewModeToggle.tsx` — new.
- `live/src/components/ui/toggle-group.tsx` — new.
- `live/src/hooks/use-local-storage.ts` — new (small generic hook).
- `live/src/pages/FileBrowser.tsx` — wire folder view into the empty state.

### Success Criteria

#### Automated Verification:
- [x] Typecheck: `cd live && bun run build`
- [x] Both views render: `grep -l "FolderView\|ListView\|GridView" live/src/` returns the new files.
- [x] Persistence reads the right key: `grep -n "liveui:browser:view" live/src/`

#### Manual Verification:
- [ ] Navigate to a drive root with no file selected → folder content visible (list by default).
- [ ] Click view-mode toggle → switches to grid; reload → still grid.
- [ ] Click a folder in list → URL updates; folder content of the child shown.
- [ ] Click a file in grid → file viewer opens (URL changes).
- [ ] Type-aware glyphs match the tree (research / plan / brainstorm / markdown / image / pdf).

### QA Spec (optional)

| Step | Expected |
|---|---|
| Visit `/file/~/<org>/<drive>/` (root, no file) | Grid (or list) of top-level folders + files. |
| Toggle to grid | Tiles with large glyphs; persisted to `liveui:browser:view`. |
| Click `thoughts/` folder tile | URL updates to `/file/~/.../thoughts/`; content shown. |
| Click `2026-04-27-foo.md` in grid | Viewer opens; comments rail follows. |

**Implementation Note**: pause for review — this is net-new UI; Taras may want to tune the grid density / tile size before locking it in.

---

## Phase 7: Visual Pass via `frontend-design` (R9)

### Overview

Run `/frontend-design` skill against the Notion-clean brief: neutral grays, single subtle accent, soft shadows, reading-first typography, polished empty states, light + dark.

### Changes

1. **Invoke `/frontend-design`** with the brief stored as a context note: "Notion-clean / minimal; neutral grays, single subtle accent, soft shadows, light-first w/ dark, reading-first markdown, polished empty states. Stack: Tailwind v4, base-ui, lucide. App at `live/`. Components: `Shell`, `TopBar`, `PathBreadcrumb`, `Sidebar`, `FileTree`, `MainWithComments`, `FileViewer`, `MarkdownViewer`, `FolderView`, `HelpOverlay`."
2. **Token pass**: review `live/src/index.css` (or wherever Tailwind theme tokens live) — accent color, ring, muted, popover, sidebar tokens. Update `--color-*` CSS vars rather than ad-hoc Tailwind utilities.
3. **Typography**: confirm `@fontsource/space-grotesk` (UI) + `@fontsource/jetbrains-mono` (code) loaders fire; pick a reading-comfortable line-height + max-width on `MarkdownViewer` (`prose` config).
4. **Empty states**: redesign the empty `FileBrowser` empty-card (now `FolderView` empty drive), tree empty state, comments empty state.
5. **Spacing pass**: padding around markdown content (R5 reading-first), sidebar item heights, tree row density, top chrome alignment.
6. **Light + dark check**: cycle `next-themes` in every screen; ensure ring contrast and focus states pass WCAG AA in both.

### Files

- `live/src/index.css` (or `live/src/styles/*`) — token updates.
- Various component className changes; no new files expected.

### Success Criteria

#### Automated Verification:
- [x] Typecheck: `cd live && bun run build`
- [x] Pages render: `cd live && pnpm dev` boots; visit each route once.

#### Manual Verification:
- [ ] Light theme feels Notion-clean: neutral grays, subtle accent, calm.
- [ ] Dark theme feels balanced (not muddy, not glaring).
- [ ] Markdown content has comfortable line-length + padding.
- [ ] Empty states look intentional (FolderView empty drive, comments empty).
- [ ] All focus rings remain visible after the pass.

### QA Spec (optional)

| Step | Expected |
|---|---|
| Switch theme repeatedly | No flash; tokens update consistently. |
| Open a long markdown file | Reading is comfortable at 720–800 px content width. |
| Hit `?` to open help | Overlay matches the new visual language. |

**Implementation Note**: pause for visual review with Taras; visual taste is subjective and best confirmed in the browser.

---

## Phase 8: Responsive / Mobile Drawers (R8)

### Overview

Below `lg:` (1024 px), both sidebars become slide-in `Sheet` drawers; main content takes full width; resize handles hidden on touch.

### Changes

1. **Add `live/src/components/ui/sheet.tsx`** — wrapper around `@base-ui/react/dialog` configured for slide-in: side-positioned with translate animations. Mirrors shadcn `Sheet` API: `Sheet`, `SheetTrigger`, `SheetContent`, `SheetHeader`, `SheetTitle`.
2. **Update `Shell.tsx`**:
   - Below `lg:` switch from `ResizablePanelGroup` to a single column: `<Header (with hamburger + comments-icon)>`, `<main>{children}</main>`.
   - Hamburger triggers `<Sheet side="left">` containing `<Sidebar/>` content (account + search + tree).
   - Comments icon triggers `<Sheet side="right">` containing the comments rail.
3. **Replace inline `MobileCommentToggle` JSX** in `pages/FileBrowser.tsx:71-113` with the new sheet trigger; ensure the toggle lives in the header on mobile, not floating.
4. **Hide resize handles on touch**: `<ResizableHandle className="hidden lg:flex">`.
5. **Backdrop + esc-to-close**: built-in via base-ui Dialog.
6. **Touch targets**: ≥ 44×44 px for hamburger, comments icon, drawer items.

### Files

- `live/src/components/ui/sheet.tsx` — new.
- `live/src/components/layout/Shell.tsx` — branch on viewport width.
- `live/src/components/layout/MobileHeader.tsx` — new (mobile-only header with triggers).
- `live/src/pages/FileBrowser.tsx` — remove inline toggle JSX.
- `live/src/components/layout/MainWithComments.tsx` — gate the right rail at `lg:`.

### Success Criteria

#### Automated Verification:
- [ ] Typecheck: `cd live && bun run build`
- [ ] No `MobileCommentToggle` inline JSX left in FileBrowser: `grep -n "MobileCommentToggle\|fixed bottom" live/src/pages/FileBrowser.tsx`
- [ ] Viewport-switched class present: `grep -n "hidden lg:" live/src/components/`

#### Manual Verification:
- [ ] Resize browser to 800 px → both sidebars hidden; hamburger + comments icons in header.
- [ ] Tap hamburger → tree drawer slides in from left with backdrop; tap backdrop closes.
- [ ] Tap comments → comments drawer slides in from right.
- [ ] Drawer items are easy to tap on touch (≥ 44 px tall).
- [ ] At ≥ 1024 px, sidebars + resize handles are restored.

### QA Spec (optional)

| Step | Expected |
|---|---|
| Devtools toggle to iPhone 12 | Two icons in header; main fills width. |
| Tap hamburger | Tree slides in; backdrop dims; tap outside closes. |
| Rotate to landscape (still < `lg:`) | Layout re-flows; drawers remain. |
| Resize to ≥ 1024 px | Drawers vanish; permanent sidebars + handles return. |

**Implementation Note**: final phase; pause for full E2E manual sweep across mobile + desktop.

---

## Manual E2E

After all phases land, run a **complete UX sweep** in `live`:

```sh
cd live && pnpm dev
```

Visit (replace placeholders with real IDs):

```
/files                                      → cold load, empty path
/file/~/<orgId>/<driveId>/                  → folder view (list)
/file/~/<orgId>/<driveId>/thoughts/         → folder view (toggle to grid)
/file/~/<orgId>/<driveId>/<uuid>/research/  → tree shows resolved name
/file/~/<orgId>/<driveId>/path/to/foo.md    → file viewer + comments rail
/detail/~/<orgId>/<driveId>/path/to/foo.md  → same chrome (FileDetail on Shell)
/orgs/<orgId>/files/path/to/foo.md          → redirects through hoisted providers cleanly
/credentials                                → unaffected
```

Manual checklist:

- [ ] Drag tree to 320 px → reload → still 320 px.
- [ ] Drag comments to 420 px → reload → still 420 px.
- [ ] Collapse left, collapse right → reload → both still collapsed; rails show.
- [ ] Expand `thoughts/` → click any file → tree still expanded.
- [ ] Reload → expansion preserved.
- [ ] Switch org → expansion clears.
- [ ] Hover every icon button → tooltip.
- [ ] Right-click tree row → context menu opens with all 4 items.
- [ ] Download icon in toolbar → file downloads with real name.
- [ ] Press `cmd+k` → search input focused; type a query; results render.
- [ ] Press `?` → help overlay; `esc` closes.
- [ ] Press `[` / `]` → sidebars toggle.
- [ ] Arrow-key tree nav: `↓`/`↑`/`←`/`→`/`Enter` all work as specced.
- [ ] Toggle list ↔ grid in folder view → persists across reload.
- [ ] Resize browser to 800 px → both sidebars become drawers; hamburger + comments icon in header.
- [ ] Light + dark theme: every screen looks intentional in both.

## Dependencies (locked)

- **New runtime deps**: `react-resizable-panels` (Phase 2). Nothing else.
- **No new dev deps.**

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Hoisting providers above `<Routes>` (Phase 1) breaks the `OrgFileRedirect` flow | `RouteParamsSync` runs `useEffect`-driven setters per route; the redirect path simply uses the same hoisted provider and reads `useAuth().driveId` post-resolve. Test cold-load `/orgs/:orgId/files/foo.md`. |
| `react-resizable-panels` mixes with `@base-ui/react` styling | Wrapper is a single file (`ui/resizable.tsx`); we never expose the underlying lib's components directly. |
| UUID heuristic spam (every UUID-named folder fires two `read` calls on expand) | `useUuidName` is a TanStack Query hook with `staleTime: Infinity`; results are also cached in `liveui:uuid-cache`. Misses (`null`) are cached too. |
| Tree expansion store grows unbounded | Bound the `Set` to last 1000 paths; LRU-evict on insert. Clear on org/drive change. |
| `frontend-design` pass changes shipped UX in Phase 7 | Visual-only changes; structural behavior already verified by Phase 1–6. Pause for Taras review per autonomy=critical. |
| Mobile drawer + drag handles double-trigger on hybrid devices | Hide handles via `hidden lg:flex` (CSS-only); base-ui Dialog handles backdrop + escape. |

## Release Checklist Note

This work is **frontend-only** (`live/`). It does **not** touch core / CLI / MCP / server code, so the agent-fs release checklist (skill update, plugin version bump, package version bump, E2E coverage) does **not** apply. The `live/` package is private (`"private": true`) and not published; deployment of `live/` is out of scope for this plan.
