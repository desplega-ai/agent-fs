---
date: 2026-04-27T00:00:00-04:00
researcher: taras
git_commit: 0814cc827e88244ab15f4dda5856d18eba8a9a39
branch: main
repository: agent-fs
topic: "Live UI improvements — codebase grounding for the brainstorm"
tags: [research, codebase, live, frontend, file-tree, breadcrumbs, shadcn, keyboard, uuid, viewers]
status: complete
autonomy: critical
last_updated: 2026-04-27
last_updated_by: taras
---

# Research: Live UI Improvements

**Date**: 2026-04-27
**Researcher**: taras
**Git Commit**: 0814cc827e88244ab15f4dda5856d18eba8a9a39
**Branch**: main

## Research Question

Ground the [Live UI Improvements brainstorm](../brainstorms/2026-04-27-live-ui-improvements.md) against the actual `live/` codebase before planning. Six concrete targets the brainstorm flagged for `/research`:

1. Smart UUID resolution — what registry could map UUID-shaped path segments to human labels?
2. shadcn primitives audit — which of `Resizable`, `Tooltip`, `DropdownMenu`, `Sheet`, `ContextMenu`, `Command` are already installed?
3. Existing keyboard infrastructure — how is `cmd+k` wired today; can it be extended?
4. Existing file-tree expansion state — how is it currently tracked; what makes it reset on file-click?
5. Existing breadcrumb + header components — concrete shape for the two-tier refactor.
6. Type-aware glyph mapping — what extension/pattern → glyph logic already exists?

## Summary

The `live/` app is a **react-router v7** SPA with a **shadcn `new-york` / lucide / Tailwind v4** foundation. UI plumbing is light: only ten shadcn primitives are installed (`badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`, `separator`, `tabs`); **`Resizable`, `Tooltip`, `Sheet`, `ContextMenu`, and `Command` (cmdk) are all absent.** The right-hand comments sidebar already has a manual resize handle in `FileBrowser.tsx`, but it's hand-rolled — there's no shared resizable primitive in the codebase yet.

Two state shapes will need to change for the brainstorm's UX to land. **(a) Tree expansion** is decentralized: every `FileTreeNode` owns its own `useState<boolean>(false)`, and the `App.tsx` route layout mounts a *separate* provider tree per route bucket (`/files` vs `/file/~/:orgId/:driveId/*`), so navigating to a file unmounts the entire `FileTree` and discards every `expanded` flag. **(b) The header** is monolithic: `Breadcrumbs.tsx` inlines the org switcher, drive switcher, and path segments into a single `<nav>` row, with the count badges (`(3)`, `(1)`) rendered next to the switcher labels — there is no separate `DrivePicker.tsx`. The two-tier chrome will require splitting `Breadcrumbs` into a top chrome row (org/drive switchers) and a pure-path row, and pushing the `FileDetail` page (which currently builds its own inline header instead of using `Shell`) onto the same shell.

For **smart UUID resolution**, the backend only has named registries for `orgs.name`, `drives.name`, and (partial) `users.email`. There is no `workspaces`/`agents`/`thoughts` table — the UUID-shaped segments *inside* a drive path (`thoughts/<uuid>/research/...`) are user-chosen folder names that agent-fs has no metadata for. The two prefix UUIDs in the URL (`:orgId`, `:driveId`) are already resolved by `Breadcrumbs.tsx` via the cached `["orgs"]` and `["drives", orgId]` React-Query maps; resolving in-drive UUIDs would need a *new* registry, not just plumbing. **Keyboard infra** is sparse — three handlers total (`cmd+k` to focus the sidebar search, `Esc` to deselect, `cmd+Enter` to submit a comment), no hotkey library, no `cmdk` palette, no `?` help overlay, and no arrow-key handling on tree rows. The existing `use-keyboard-shortcuts.ts` hook is the natural extension point. **Type-aware glyphs** today are color-tints on the same generic lucide `File` icon (`FileTreeNode.tsx:9-38`); no filename-pattern logic (`research-*.md`, etc.) exists anywhere in `live/`.

## Detailed Findings

### 1. File-tree expansion state — fully decentralized

- Tree root: `live/src/components/file-tree/FileTree.tsx`. Recursive child: `live/src/components/file-tree/FileTreeNode.tsx`.
- **Expansion is per-node `useState<boolean>(false)`** at `FileTreeNode.tsx:47`:
  ```tsx
  const [expanded, setExpanded] = useState(false)
  ```
  No store, no context, no Zustand, no localStorage layer for the tree.
- Click flow (`FileTreeNode.tsx:61-67`): folders flip `expanded`; files call `selectFile(fullPath)` from `useBrowser()`.
- `selectFile` (`live/src/contexts/browser.tsx:30-37`) does both a state update **and** a route navigation: `navigate(\`/file/~/${orgId}/${driveId}/${path}\`)`.
- The route table in `App.tsx:101-110` defines `/files` and `/file/~/:orgId/:driveId/*` as **distinct `<Route>` elements** — each with its *own* `<AuthProvider>` + `<BrowserProvider>` + `<Shell>`. React-router unmounts one and mounts the other on navigation, so every `FileTreeNode` instance is destroyed and recreated; all `expanded` flags reset to `false`.
- `BrowserProvider` (`contexts/browser.tsx:22-24`) syncs `selectedFile` from `initialFile`, but expansion is not lifted there.
- localStorage in `live/` is currently used only by `stores/credentials.ts` (`agent-fs-credentials`, `agent-fs-active-credential`) and `contexts/auth.tsx` (`agent-fs-active-org`, `agent-fs-active-drive`). No `liveui:tree` or expanded-paths key exists.
- Tree node identity: `LsEntry` in `api/types.ts:4-10` carries only `name` (no `id`, no path). Full path is computed at render time: `const fullPath = path ? \`${path}/${entry.name}\` : entry.name` (`FileTreeNode.tsx:50`). React keys use `entry.name` (`FileTree.tsx:47`, `FileTreeNode.tsx:110`) — unique per parent, not globally. A path-keyed expansion store *would* survive refetch as long as paths are stable. Children are gated by `enabled: isDir && expanded && !!driveId` (`FileTreeNode.tsx:58`), so expansion drives child fetching.

### 2. Breadcrumbs / header / switchers — current shape

- **`live/src/components/Breadcrumbs.tsx`** — single `<nav>` row that combines:
  1. Org block (`:22-53`) — `DropdownMenu` if `orgs.length > 1`, else span. Trigger: `<Building2/>` + `orgName` + literal `({orgs.length})` at `:28/51`.
  2. Drive block (`:58-89`) — same pattern; `<HardDrive/>` + `driveName` + `({drives.length})` at `:64/87`.
  3. Path segments (`:92-112`) — `selectedFile.split("/").map(...)`, each rendered as a `Button onClick={navigateToFolder(segPath)}` except the last which is a `<span>`.
- **There is no `DrivePicker.tsx` file.** The drive switcher exists only as the inline block at `Breadcrumbs.tsx:58-89`.
- **`live/src/components/AccountSwitcher.tsx`** — switches between **stored credentials** (endpoint+apiKey pairs from `getCredentials()`/localStorage), not orgs. Lives in the **sidebar** (`live/src/components/layout/Sidebar.tsx:9`), not the header. Has "Add account" → `/credentials`.
- **`live/src/components/layout/Header.tsx`** — entire file is one 40px row:
  ```tsx
  <header className="flex h-10 items-center justify-between border-b border-border px-4">
    <div className="flex items-center gap-2 min-w-0 flex-1">{children}</div>
    <div className="flex items-center gap-2"><HealthIndicator /><ThemeToggle /></div>
  </header>
  ```
- **`live/src/components/layout/Shell.tsx:13-60`** composes `[Sidebar slide-in/static] + [flex-col: <Header>{breadcrumbs}</Header>, <main>{children}</main>]`. App passes `breadcrumbs={<Breadcrumbs />}` and `children={<FileBrowserPage />}` (`App.tsx:28-30, 45-47`).
- **Important divergence**: `pages/FileDetail.tsx` (used by `/detail/~/...`) **does not use `Shell`** — it builds its own header inline at `:50-89`, reusing `<Breadcrumbs/>`/`<HealthIndicator/>`/`<ThemeToggle/>` plus a 48px main row + sub-header row with the filename.
- **Routing** (`App.tsx:101-110`):
  ```
  /credentials                          → CredentialsPage
  /orgs/:orgId/files/*                  → OrgFileRedirect (resolves :driveId then redirects to /file/~/...)
  /file/~/:orgId/:driveId/*             → FileRoute (Shell + FileBrowserPage)
  /detail/~/:orgId/:driveId/*           → DetailRoute (FileDetailPage with its own inline header)
  /files                                → AuthenticatedShell
  *                                     → Navigate to /files
  ```
  Splat (`*`) is read as `params["*"]` for the in-drive path.
- **Org/drive state has three layers** (`contexts/auth.tsx`):
  1. **URL params** — only at mount; passed once as `initialOrgId`/`initialDriveId` (`App.tsx:43, 60`).
  2. **AuthContext state** — `activeOrgId`/`activeDriveId` (`auth.tsx:35-40`). Switching does **not** push a new URL.
  3. **localStorage** — `agent-fs-active-org` / `agent-fs-active-drive` (`auth.tsx:36, 39, 89-90, 97-98`).
- Resolution order: `orgId = activeOrgId ?? user.defaultOrgId ?? null`; `driveId = activeDriveId ?? (isDefaultOrg ? user.defaultDriveId : null) ?? drives[0]?.id ?? ""` (`auth.tsx:72, 83`).
- `setOrgId` clears active drive and invalidates `drives`/`ls`/`comments` queries (`auth.tsx:86-94`).

### 3. shadcn primitives audit — large gap

- `live/components.json`: style `new-york`, base color `neutral`, css vars `true`, icon library `lucide`, aliases under `@/components`, `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks`.
- **Installed** under `live/src/components/ui/`:

  | Primitive | File |
  |---|---|
  | Badge | `badge.tsx` |
  | Button | `button.tsx` |
  | Card | `card.tsx` |
  | Dialog | `dialog.tsx` |
  | DropdownMenu | `dropdown-menu.tsx` |
  | Input | `input.tsx` |
  | Label | `label.tsx` |
  | Popover | `popover.tsx` |
  | Separator | `separator.tsx` |
  | Tabs | `tabs.tsx` |

- **Absent** (zero usage anywhere outside `components/ui/`): `Resizable`/`ResizablePanelGroup`, `Tooltip`, `Sheet`, `ContextMenu`, `Command` (cmdk), `ScrollArea`, `Toggle`/`ToggleGroup`.
- **Dependencies in `live/package.json`**: `@radix-ui/react-{dialog, dropdown-menu, label, popover, separator, slot, tabs}`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tailwindcss@^4.1.14`, `@tailwindcss/vite`, `tw-animate-css`, `next-themes`. **NOT installed**: `cmdk`, `vaul`, `react-resizable-panels`, `sonner`, `@radix-ui/react-tooltip`, `@radix-ui/react-context-menu`, `@radix-ui/react-scroll-area`, `@radix-ui/react-toggle`/`react-toggle-group`.
- Note: the already-existing right-comments-sidebar resize is a **hand-rolled** drag handle in `FileBrowser.tsx:42-49`, not a shared primitive — see Comments sidebar in section 6.

### 4. Keyboard infrastructure — sparse, three handlers total

| File:line | Trigger | Behavior |
|---|---|---|
| `live/src/components/search/SearchBar.tsx:27-36` | `metaKey/ctrlKey + k` | `e.preventDefault(); inputRef.current?.focus()` — focuses the **always-mounted** sidebar search input. |
| `live/src/hooks/use-keyboard-shortcuts.ts:7-16` | `Escape` | `selectFile(null)` — deselects the open file. |
| `live/src/components/comments/AddComment.tsx:69-73` | `cmd/ctrl + Enter` (textarea `onKeyDown`) | Submits the comment form. |

- **`cmd+k` is NOT a palette/dialog** — it just focuses an inline `<Input>` rendered unconditionally inside `Sidebar` (`Sidebar.tsx:11`). Once focused and `debouncedQuery` is non-empty, `<SearchResults>` renders inline below the input (`SearchBar.tsx:111-113`).
- The placeholder reads `"Search... ⌘K"` (`SearchBar.tsx:87`) and the empty-state hint at `pages/FileBrowser.tsx:29` shows `<kbd>⌘K</kbd>`.
- **Centralized hook exists** (`use-keyboard-shortcuts.ts`) and is wired into `FileBrowserPage` (`pages/FileBrowser.tsx:18`) — but currently does only `Escape`. It's the natural place to add `[`/`]` (sidebar toggles), `?` (help overlay), arrow-key tree nav, etc.
- **No hotkey library** installed (no `react-hotkeys-hook`, `tinykeys`, `cmdk`, `kbd`).
- **No help overlay** — greps for `'?'`, `keyboard.*help`, `shortcuts.*overlay` produce zero matches.
- **No arrow-key tree nav** — `FileTreeNode` rows are `<button>`s with only `onClick` (`FileTreeNode.tsx:71-72`). No `tabIndex`, no `onKeyDown`, no roving tab index, no DOM ref for focus.
- Search backing hooks: `useFtsSearch`, `useSemanticSearch`, `useGlobSearch`, `useHybridSearch` (`SearchBar.tsx:7-10`); each calls `client.callOp` with op `"fts"`, `"glob"`, etc. Tab `"files"` searches via `glob`; tab `"search"` searches over file content using the chosen `searchType`.

### 5. UUID resolution sources — only orgs/drives are named

- Backend schema (`packages/core/src/db/schema.ts`):
  - `users` (`:9`) — UUID `id`, **no `name` column**; human label is `email` (`:11`).
  - `orgs` (`:17`) — UUID `id`, `name` (`:19`), `isPersonal` (`:20`).
  - `drives` (`:44`) — UUID `id`, `name` (`:49`), `orgId` FK (`:46`).
  - `comments` (`:120`), `events` (`:147`) — UUID `id`, no `name`.
  - `file_versions` (`:102`), `content_chunks` (`:167`) — auto-increment integer, not UUID.
- **No `workspaces`, `agents`, `thoughts`, or `swarm` tables exist.** UUID segments inside a drive path (e.g. `thoughts/16990304-76e4-.../research/...`) are arbitrary user-chosen folder names that agent-fs has no metadata for.
- **Server endpoints** (`packages/server/src/routes/`):
  - `auth.ts:39` — `GET /auth/me` → `{ userId, email, defaultOrgId, defaultDriveId }`.
  - `orgs.ts:22` — `GET /orgs` → `{ id, name, role, isPersonal }[]`.
  - `orgs.ts:35` — `GET /orgs/:orgId` → `{ id, name, isPersonal }`.
  - `orgs.ts:42` — `GET /orgs/:orgId/drives` → `{ id, name, isDefault }[]`.
  - `orgs.ts:64` — `GET /orgs/:orgId/members` → `{ userId, email, role }[]`.
  - `orgs.ts:95` — `GET /orgs/:orgId/drives/:driveId/members` → `{ userId, email, role }[]`.
  - **No** general-purpose `id → name` resolver, no agents/workspaces endpoint.
- **Frontend client** (`live/src/api/client.ts`): `getMe()` (`:62`), `getOrgs()` (`:66`), `getDrives(orgId)` (`:70`), `getOrgMembers(orgId)` (`:74` — wired but **no call-sites found**), plus `callOp`/`getRawUrl`/`fetchRaw`/`getSignedUrl`.
- **React-Query keys already cached client-side** (`contexts/auth.tsx`): `["me", credential?.id]` (`:59`), `["orgs", credential?.id]` (`:66`), `["drives", orgId]` (`:76`).
- **Existing UUID → name resolutions in UI**:
  - `Breadcrumbs.tsx:27` — `{orgName || orgId?.slice(0, 8)}` (org).
  - `Breadcrumbs.tsx:63` — `{driveName || driveId.slice(0, 8)}` (drive).
  - Both via `auth.tsx:73` (`orgs.find(o => o.id === orgId)?.name`) and `auth.tsx:84` (`drives.find(d => d.id === driveId)?.name`).
- **In-drive path segments are NOT resolved anywhere** in `live/` — the truncated `16990304-...` segment in the brainstorm's Image #2 is rendered verbatim from `selectedFile.split("/")` (`Breadcrumbs.tsx:92-112`).
- S3 storage key convention: `<orgId>/drives/<driveId>/<path>` (`packages/core/src/ops/versioning.ts:10-13`). So `orgId`/`driveId` live *outside* the user-facing in-drive path; the only positionally-fixed UUIDs are the URL prefix (`:orgId`, `:driveId`).
- **Bottom line**: the backend has no source of truth that could resolve generic in-drive UUIDs to names. Smart UUID resolution would either need a *new* registry (e.g., a per-drive `entities` table populated by clients/skills that create those folders) or a heuristic frontend-only approach (e.g., look for a `meta.json` / `.name` sibling file inside the UUID-named folder).

### 6. File types, glyphs, and viewers

- **Icon library**: `lucide-react@^0.577.0` exclusively (no heroicons / phosphor). Imports across all viewers, tree, sidebar, breadcrumbs, search, FileBrowser, FileDetail.
- **Per-extension differentiation today** is **color-tinting** on the same generic lucide `File` icon (`FileTreeNode.tsx:9-38`):

  | Extension(s) | Icon class |
  |---|---|
  | `ts/tsx/js/jsx` | `text-blue-500` |
  | `md/mdx` | `text-emerald-500` |
  | `json/yaml/yml/toml` | `text-amber-500` |
  | `css/scss` | `text-purple-500` |
  | `png/jpg/jpeg/gif/svg/webp` | `text-pink-500` |
  | default | `text-muted-foreground` |

  Folders use lucide `Folder` / `FolderOpen` (amber-500) with `ChevronRight`/`ChevronDown` (`FileTreeNode.tsx:79-91`).
- **No filename-pattern logic** — greps for `research`, `brainstorm`, `plans/`, `thoughts/` produce zero matches anywhere in `live/src/`. The Desplega thoughts conventions live only in skills/docs, not in the live UI.
- **Viewers** (`live/src/components/viewers/`):
  - `FileViewer.tsx` — dispatcher. Decision order:
    1. `IMAGE_EXTS` (png/jpg/jpeg/gif/svg/webp/ico) → `ImageViewer`.
    2. `pdf` → `PdfViewer`.
    3. Loading → spinner.
    4. No content / not-text → `FallbackViewer` (lucide `FileQuestion` + size/mime/author/modifiedAt).
    5. Markdown (`md/mdx/txt`) → default rendered view (`MarkdownViewer`); raw toggle swaps to `TextViewer`. Toggle uses `Code`/`Eye` icons (`FileViewer.tsx:200-204`).
    6. Other text → `TextViewer` (Monaco; `extToLang` covers ~40 extensions at `TextViewer.tsx:13-27`).
- **Markdown rendering**: `react-markdown` + `remark-gfm` inside Tailwind `prose` (`MarkdownViewer.tsx:2-3, 155-156`). No filename-pattern awareness — purely takes `content`.
- **`pages/FileBrowser.tsx` does NOT render folder content as a list/grid.** It only renders the currently-selected file's viewer + comments sidebar:
  - If `!selectedFile` → empty-state card with lucide `Files` icon + `⌘K` hint (`FileBrowser.tsx:24-32`).
  - Else: flex row with `<FileViewer/>` (left, flex-1), an optional **manual resize handle** (`:42-49`), `<CommentSidebar/>` (right, `FileBrowser.tsx:51-57`). Mobile gets a floating toggle button (`:71-113`).
- **Folder content is rendered ONLY in the left sidebar tree** as a recursive vertical list (`FileTreeNode.tsx:69-127`). There is no grid view, no folder-table, no card layout anywhere in `live/`. Top-level listing fetched via `client.callOp("ls", {})` (`FileTree.tsx:11`); per-folder via `{ path: fullPath }` on expand (`FileTreeNode.tsx:55-59`).
- **Sort order in tree**: directories first, then alpha (`FileTree.tsx:39-42`).
- **`StatResult.contentType`** is defined in `api/types.ts:38` and threaded through `FileViewer.tsx:103` and `FallbackViewer.tsx:24`. `isTextFile(path, contentType)` falls through to `true` if `contentType` is missing or `application/octet-stream` (`FileViewer.tsx:43-49`).

## Code References

| File | Line | Description |
|------|------|-------------|
| `live/src/components/file-tree/FileTreeNode.tsx` | 47 | `useState<boolean>(false)` — entire expansion model. |
| `live/src/components/file-tree/FileTreeNode.tsx` | 9-38 | `fileIcon(name)` — extension-to-color map. |
| `live/src/components/file-tree/FileTreeNode.tsx` | 50 | `fullPath = path ? \`${path}/${entry.name}\` : entry.name`. |
| `live/src/components/file-tree/FileTreeNode.tsx` | 55-59 | TanStack Query `["ls", orgId, driveId, fullPath]`, gated by `expanded`. |
| `live/src/components/file-tree/FileTree.tsx` | 39-42 | Tree sort: directories first then alpha. |
| `live/src/contexts/browser.tsx` | 30-37 | `selectFile` → state + `navigate(/file/~/...)`. |
| `live/src/contexts/auth.tsx` | 35-40, 72, 83-90 | Active org/drive state + resolution + invalidations. |
| `live/src/App.tsx` | 101-110 | Route table; `/files` and `/file/~/...` mount separate provider trees. |
| `live/src/App.tsx` | 36-66 | `FileRoute` / `DetailRoute` thread URL splat into providers. |
| `live/src/components/Breadcrumbs.tsx` | 22-89 | Inline org+drive switchers with `(N)` count badges. |
| `live/src/components/Breadcrumbs.tsx` | 92-112 | Path-segment loop — UUID segments rendered verbatim. |
| `live/src/components/AccountSwitcher.tsx` | 14, 22-44 | Switches **stored credentials**, not orgs. |
| `live/src/components/layout/Header.tsx` | (full file) | Single 40px row; `{children}` slot + HealthIndicator + ThemeToggle. |
| `live/src/components/layout/Shell.tsx` | 13-60 | Shell composes Sidebar + Header + main. |
| `live/src/pages/FileDetail.tsx` | 50-89 | **Inline header** (does NOT use `Shell`). |
| `live/src/pages/FileBrowser.tsx` | 24-32 | Empty-state card with `⌘K` hint. |
| `live/src/pages/FileBrowser.tsx` | 42-49 | Hand-rolled comments-sidebar resize handle. |
| `live/src/components/search/SearchBar.tsx` | 27-36 | `cmd+k` listener — focuses inline input. |
| `live/src/components/search/SearchBar.tsx` | 80, 87, 111-113 | Inline input + placeholder + inline results. |
| `live/src/hooks/use-keyboard-shortcuts.ts` | 7-16 | `Escape` → `selectFile(null)`. Wired in `FileBrowser.tsx:18`. |
| `live/src/components/comments/AddComment.tsx` | 69-73 | `cmd/ctrl+Enter` submit. |
| `live/components.json` | (full) | shadcn config: `new-york`, `neutral`, `lucide`. |
| `live/src/components/ui/` | — | 10 installed shadcn primitives (badge/button/card/dialog/dropdown-menu/input/label/popover/separator/tabs). |
| `live/src/components/viewers/FileViewer.tsx` | 18-49, 73-147 | Dispatch logic + extension sets. |
| `live/src/components/viewers/TextViewer.tsx` | 13-27 | `extToLang` Monaco map (~40 extensions). |
| `packages/core/src/db/schema.ts` | 9, 17, 44, 120, 147 | `users`/`orgs`/`drives`/`comments`/`events` tables (only `orgs.name`, `drives.name` are human labels). |
| `packages/server/src/routes/orgs.ts` | 22, 35, 42, 64, 95 | Listing endpoints for orgs / drives / members. |
| `packages/core/src/ops/versioning.ts` | 10-13 | S3 key: `<orgId>/drives/<driveId>/<path>`. |
| `live/src/api/client.ts` | 62, 66, 70, 74 | `getMe` / `getOrgs` / `getDrives` / `getOrgMembers`. |
| `live/src/api/types.ts` | 4-10, 38 | `LsEntry` (name only, no id) + `StatResult.contentType`. |
| `live/src/stores/credentials.ts` | 8-9 | localStorage keys for credentials (only existing tree-adjacent persistence pattern). |

## Architecture Documentation

- **Routing**: `react-router` v7. URL is the source of truth only at *mount* (`initialOrgId`/`initialDriveId` passed once to `AuthProvider`/`BrowserProvider`); after that, switching org/drive updates context state without pushing a new URL. localStorage backs persistence across reloads.
- **Provider tree per route bucket**: `App.tsx` currently mounts `<AuthProvider>` + `<BrowserProvider>` + `<Shell>` separately under `/files` and under `/file/~/:orgId/:driveId/*`. This is what makes the file-tree expansion state evaporate on file-click — the entire tree subtree unmounts. Lifting providers above the `<Routes>` element is one structural option for keeping tree state alive.
- **Data layer**: TanStack React-Query (`@tanstack/react-query` per package.json). Query keys observed: `["me", credId]`, `["orgs", credId]`, `["drives", orgId]`, `["ls", orgId, driveId, path]`, `["comments", ...]`. Switching org calls `queryClient.invalidateQueries({ queryKey: ["ls"] })` (`auth.tsx:92`) and a similar invalidation for `comments`/`drives`.
- **shadcn shell**: `new-york` style + `neutral` base color + CSS variables + `lucide` icon library; aliases `@/components`, `@/lib/utils`, etc. Tailwind v4 (`tailwindcss@^4.1.14`) with `@tailwindcss/vite` and `tw-animate-css`. Dark mode via `next-themes` + `ThemeToggle.tsx`.
- **Monolithic vs split chrome**: `Shell.tsx` is the standard shell, but `FileDetail.tsx` builds its own inline header. Any header refactor will need to either (a) push `FileDetail` onto `Shell`, or (b) extract a shared top-bar/sub-header pair both consumers reuse.
- **No grid view today**: the entire `FileBrowser` page is a single-file viewer + comments rail. A grid view is net-new UI, not a layout swap.

## Historical Context (from thoughts/)

- `thoughts/taras/brainstorms/2026-04-27-live-ui-improvements.md` — the brainstorm this research grounds. Captures the 10 key decisions, lightweight PRD (R1–R9), constraints, resolved open questions, and the suggested phasing.
- No prior research documents on `live/` UI exist in `thoughts/taras/research/` as of `0814cc8`.

## Related Research

- `thoughts/taras/brainstorms/2026-04-27-live-ui-improvements.md` — source brainstorm.

## Open Questions

1. **In-drive UUID resolution — do we want a backend registry or a heuristic?**
   The brainstorm proposes a "smart UUID resolver". The research confirms agent-fs has no backend table for in-drive UUIDs (only `orgs.name`/`drives.name` are resolvable, and those already are). Two paths the plan will need to pick between:
   - **(a) Add a registry** — a new per-drive `entities` table populated by clients/skills that create those folders, surfaced via a new `GET /orgs/:orgId/drives/:driveId/entities` endpoint. Clean, but expands scope into backend.
   - **(b) Heuristic-only** — look for a metadata sibling (e.g., `<uuid>/.name` or `<uuid>/meta.json` with a `name` field) when expanding a UUID-shaped folder; fall back to middle-ellipsis. Pure frontend, lower fidelity.
   The brainstorm's "smart matching" framing leaves this open; the plan should pick before phase 3 (file-tree polish).

2. **Should `FileDetail` move onto `Shell`, or should both pages share an extracted top-bar?**
   Since `FileDetail` builds its own inline header, the two-tier chrome refactor (R1) needs a structural decision. Pushing `FileDetail` onto `Shell` is cleaner but might affect routing/hydration; extracting shared `<TopBar>` + `<PathBreadcrumb>` components both pages compose is lower-risk.

3. **Provider hoisting for tree state durability.**
   Tree expansion can be made durable either by (a) hoisting `<AuthProvider>`/`<BrowserProvider>` above `<Routes>` in `App.tsx` so they persist across `/files` ↔ `/file/~/...` transitions, or (b) putting expansion in localStorage and rebuilding from there on every mount. (a) is the cleaner refactor; (b) is the smallest diff. The plan should pick.

4. **`@base-ui/react` vs `@radix-ui/*` — pick one.**
   `package.json` lists `@radix-ui/*` packages, but the keyboard-infra agent reported `@base-ui/react` is used by `dropdown-menu.tsx:2`. There may be both. Confirm and standardize before adding more shadcn primitives, so the new ones (`Resizable`, `Tooltip`, `Sheet`, `ContextMenu`, `Command`) come in on the same underlying lib as the rest.

5. **Comments sidebar resize — keep hand-rolled or replace with `Resizable`?**
   `FileBrowser.tsx:42-49` already has a manual drag handle. R3 wants resize+collapse+persistence. The plan should decide whether to replace it with shadcn's `Resizable` for consistency with the new left-sidebar resize, or keep both ad-hoc. Recommend the former for consistency — but it's a small refactor that needs explicit decision.

6. **Where do shortcuts live — extend `use-keyboard-shortcuts.ts`, or introduce `react-hotkeys-hook`?**
   The existing hook handles only `Escape` and is wired into `FileBrowserPage` only. The brainstorm's full shortcut set spans tree-row arrow nav (focus-managed), `[`/`]` sidebar toggles (component-aware), and global `?`/`cmd+k`. The plan should decide between extending the hook (no new dep) or pulling in `react-hotkeys-hook` for the global+scoped patterns.

## Review Errata

_Reviewed: 2026-04-27 by claude_

### Critical

- [x] **`Detailed Findings § 3` shadcn-primitives audit is wrong.** Verified directly via `ls live/src/components/ui/` and reading the imports. Corrections below — body text remains as the agent wrote it for traceability of what was *believed*; treat this errata as the authoritative state.
  - **Underlying primitive library is `@base-ui/react@^1.3.0`**, not Radix UI. `live/package.json` contains a single UI-primitive dep: `"@base-ui/react": "^1.3.0"`. There are **no `@radix-ui/*` packages installed** despite what the agent reported. (This also resolves Open Question #4 — it's base-ui consistently.)
  - **Actual installed primitives under `live/src/components/ui/`** (8 files, not 10):
    `badge.tsx`, `button.tsx`, `dropdown-menu.tsx`, `input.tsx`, `popover.tsx`, `spinner.tsx`, `textarea.tsx`, **`tooltip.tsx`**.
  - **Falsely reported as installed (NOT actually present)**: `card.tsx`, `dialog.tsx`, `label.tsx`, `separator.tsx`, `tabs.tsx`.
  - **Missed by the agent (ARE installed)**: `tooltip.tsx`, `spinner.tsx`, `textarea.tsx`.
  - **Implication for the plan**: `Tooltip` is **already available** (R6 doesn't need a new install — just an audit + adoption). Still missing: `Resizable`, `Sheet`, `ContextMenu`, `Command` (cmdk), `ScrollArea`, `Toggle`/`ToggleGroup`. Also missing entirely (and used by some shadcn flows): `Dialog`, `Separator`, `Tabs` — adding the resize/sheet/context-menu/command primitives may transitively need these. Note that base-ui has its own equivalents; the plan should pick base-ui-native primitives (or shadcn `new-york`-style wrappers built on base-ui) rather than mixing in Radix-based shadcn components.

### Important

- [x] **Mobile / responsive state is under-investigated** (R8 in the brainstorm).
  Already-present mobile bits surfaced during the review:
  - `pages/FileBrowser.tsx:35-66` uses Tailwind's **`lg:` breakpoint (1024px)**, not the brainstorm's proposed `~768px`. The desktop resize handle and comments sidebar are gated by `hidden lg:flex`.
  - A `<MobileCommentToggle>` component exists (`FileBrowser.tsx:59-66`) — a floating toggle button for the comments drawer below `lg:`.
  - `Shell.tsx` references "slide-in/static" sidebar behaviour; the sidebar already collapses below `lg:`.
  This contradicts the open question that frames mobile as net-new — there's already a partial pattern. The plan should pick a single breakpoint (768 vs 1024) and decide whether to extend the existing `MobileCommentToggle`-style approach or replace it wholesale with `Sheet`-based drawers.

- [x] **`OrgFileRedirect` route handler not woven into the routing narrative.** It's a third route bucket (`/orgs/:orgId/files/*` → resolves `:driveId` then `<Navigate>` to `/file/~/...`) at `App.tsx:69-93` that mounts its **own** `<AuthProvider>`. Relevant to Open Question #3 (provider hoisting) — provider hoisting will need to handle this redirect path too.

- [x] **`@base-ui/react` adoption is the de-facto standard** — verified by reading every `components/ui/*.tsx` file. All 8 primitives import from `@base-ui/react/*`. The "package.json lists `@radix-ui/*`" claim in the body of § 3 is wrong (likely a hallucinated package list from the audit agent). Treat the entire shadcn-on-base-ui ecosystem as the standard going forward; do not introduce `@radix-ui/*` deps.

### Resolved (auto-fixed inline below)

- [x] Open Question #4 (`@base-ui` vs `@radix-ui`) is now answered: it's base-ui across the board. Keep the question entry as-is for trace, but the answer is captured here.
- [x] No typos / formatting issues found.

### Not Errata, But Worth Flagging for the Plan

- The `MobileCommentToggle` component file path was not pinpointed during research — `pages/FileBrowser.tsx:59-66` references it but the component file itself wasn't read. Worth a quick `Read` during planning to confirm its props before deciding whether to extend or replace.
- `live/src/components/comments/` was not deeply investigated. R3 (comments-sidebar resize+collapse+persistence) will need a parallel pass on the comments components when planning is in flight.
- `MarkdownViewer` rendering details (R5 reading-first typography) — `react-markdown` + `remark-gfm` inside `prose` is enough for the brainstorm's needs, but the plan may want to audit whether code-block / table / link styling needs custom plugins.
