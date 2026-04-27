---
date: 2026-04-27
topic: live-ui-improvements
status: complete
exploration_type: workflow-to-improve
participants: [taras, claude]
next_step: research
related: []
---

# Brainstorm: Live UI Improvements

## Context

Taras wants to improve the UI of the `live/` frontend (Vite + React app at `/Users/taras/Documents/code/agent-fs/live/`). The app is a "Drive-like" web viewer for the agent-fs file system, with file tree navigation, file detail views, comments, and breadcrumb-based context (org / drive / path).

### Initial concerns (raw, from Taras)

1. **Drive-like grid view** — Currently list view; want icons (Drive-like grid) as an option.
2. **Long file name truncation** — File tree truncates names hard (e.g. `16990304-76e4-40...`, `2026-03-20-chat-sdk-i...`). Always badly visible.
3. **General visual polish** — Use `frontend-design` skill to lift the design quality.
4. **File click resets tree expansion** — Clicking a file collapses/resets the tree; should preserve expansion state across navigation.
5. **Resizable + collapsible sidebars** — File tree (left) and comments (right) panels should be resizable and collapsible.
6. **Tooltips** — Add tooltips to icon-only buttons.
7. **Download button** — Add a download action for files.
8. **Header clarity** — The header/breadcrumb (`swarm (3) > default (1) > thoughts > 16990304-... > research > 2026-04-14-kubernetes-deployment.md`) is confusing about what is org vs drive vs path.

### Reference images

- Image #1: Sidebar showing severely truncated folder/file names in the file tree.
- Image #2: Top bar showing breadcrumb `swarm (3) > default (1) > thoughts > 16990304-76e4-4017-b991-f3e37b34cf73 > research > 2026-04-14-kubernetes-deployment.md` plus a second row with the filename and copy/link actions — unclear which segments are org/drive/path.

### Codebase grounding

- App structure: `live/src/{App.tsx, components/, pages/, contexts/, hooks/, lib/, stores/}`
- Pages: `Credentials.tsx`, `FileBrowser.tsx`, `FileDetail.tsx`
- Components of interest: `Breadcrumbs.tsx`, `DrivePicker.tsx`, `AccountSwitcher.tsx`, `file-tree/`, `comments/`, `layout/`, `viewers/`, `search/`, `VersionHistory.tsx`
- UI library: `components/ui/` (shadcn-style; `components.json` present)

## Exploration

### Q: Who is the primary user of `live` and what's their dominant task?
**Team collaboration w/ comments.** Multi-user, comments-first. People navigate, leave threaded comments, mention each other. Tree + comments are both first-class.

**Insights:**
- This reframes the priority of several concerns. Sidebar resizing/collapsing (#5) and tree expansion preservation (#4) become real UX needs, not nice-to-haves — collaborators navigate with intent across multiple files in a session.
- Comments sidebar should be first-class (default-visible) but collapsible, not hidden behind a toggle.
- Header clarity (#8) is critical: in team mode users need to know *whose* org/drive they're in, especially when switching between several. "swarm (3) > default (1)" is meaningless without a mental model of org-vs-drive.
- Drive-like grid view (#1) is more debatable in this framing — Drive uses icons because of mixed media (images, PDFs, slides). agent-fs is mostly markdown. Worth probing.
- Download (#7) and sharing affordances are real — sending a file to a teammate is part of the loop.

### Q: On the 'drive-like view (icons instead of list)' — what's the actual win?
**Faster scanning of folders, as an *alternative* (not a replacement).** Toggle, not switch.

**Insights:**
- Scope: grid view lives in the **main content area** (`FileBrowser` page when viewing a folder) — *not* the left sidebar tree. The sidebar stays a tree.
- Need a view-mode toggle (list/grid) on `FileBrowser`. Persist per-user (localStorage).
- Don't over-design grid tiles — folders get folder icons, .md files get a markdown glyph + filename. No need for thumbnails/previews (was option 2, rejected by implication).
- This means the sidebar truncation problem (#2) and the FileBrowser layout are *independent* — fixing the tree doesn't depend on the grid view decision.

### Q: Header IA — which mental model?
**Two-tier: chrome + breadcrumb.** Top chrome carries org + drive switchers (Notion-style). Breadcrumb below is *pure path* within the drive.

**Insights:**
- Top chrome layout: `[Org ▾] [Drive ▾]  ...  [user/account, theme, account-switcher on the right]`
- Breadcrumb shows only the path *inside the drive* — no `swarm > default > ...` mixed in.
- The `(3)` and `(1)` count badges can live next to the switcher labels (or in the dropdown), not in the breadcrumb.
- This kills the ambiguity in Image #2 and lets us cleanly answer "where am I?"
- Implies: `Breadcrumbs.tsx` is rewritten to receive only path segments; `Header.tsx` (or a new `TopBar.tsx`) hosts the org/drive switchers.

### Q: Long file names — truncation strategy?
**Middle-ellipsis + tooltip** (combination of options 1 & 3).

**Insights:**
- Tree node renders names with middle-ellipsis when over the rendered width: `16990304-…-cf73`, `2026-04-14-….md`. Date prefix and `.md` extension both stay visible — that's the high-signal real estate.
- Tooltip on hover shows the full untruncated name (also useful for screen readers / accessibility).
- Pairs naturally with #5 (resizable sidebar) — wider sidebar means less truncation; tooltip + middle-ellipsis cover the rest.
- Implementation note: needs a CSS-based middle-ellipsis (no CSS native primitive — typical pattern is splitting the string and using two flex spans with `min-width: 0` + `text-overflow: ellipsis` on the leading half).

### Q: Visual design direction?
**Notion-clean / minimal.** Lots of whitespace, neutral grays, single subtle accent, soft shadows, light-first (with dark). Reading-first.

**Insights:**
- Anchors `frontend-design` brief: avoid generic AI aesthetics, but stay in the calm/minimal lane — *not* heavily branded, *not* dense pro-tool.
- Existing shadcn/ui foundation is already aligned; the work is mostly tuning typography, spacing, color tokens, empty states, and the small touches that signal craft.
- Light + dark both supported (already have `ThemeToggle.tsx`); light is primary.
- Reading-first means: comfortable line-length and font sizes in `FileDetail`, generous padding around markdown content, nothing competing visually with the document.

### Q: Sidebar defaults?
**Persist last state per user** (localStorage). First-ever load: both open with sensible default widths; after that, restore whatever the user had.

**Insights:**
- Two storage keys (proposed): `liveui:tree { open, width }`, `liveui:comments { open, width }`.
- Default widths: ~280px tree, ~360px comments. Min/max bounds enforced.
- Resize handle on the inner edge of each sidebar. Double-click handle to toggle collapse.
- Collapse state should also expose a small re-open affordance (rail with icon) so users don't get stuck in a collapsed state without an obvious "open" button.
- Implies: a small `useResizableSidebar(key, defaults)` hook, or use shadcn's resizable primitive if `live` already pulls it in.

### Q: Download button placement?
**File-only, in the FileDetail toolbar** alongside existing copy/link buttons. Right-click on a tree row mirrors the action.

**Insights:**
- No folder-as-zip — out of scope for this pass; can revisit if it becomes a real ask.
- Toolbar order (proposed): `[filename] [📋 copy filename] [🔗 copy link] [⬇ download]`, with tooltips on each (closes #6).
- The right-click context menu on tree rows can carry: Open, Copy link, Download, Reveal-in-new-tab.
- Pure frontend change for files: hit the existing file-fetch endpoint with a Blob + `<a download>` trigger. No backend work.

### Q: Anything else to fold in before synthesis?
**Two extras: keyboard shortcuts + mobile/responsive.** (Search polish was *not* selected — out of scope for this pass.)

### Q: Keyboard shortcuts scope?
**Full set** (pro-tool keyboarding):
- `cmd+k` — quick-open / global search
- `esc` — close drawer/preview/dialog
- `↑ / ↓` — tree row navigation
- `← / →` — collapse / expand folder
- `[` / `]` — toggle left / right sidebar
- `/` — focus search
- `enter` — open selected file

**Insights:**
- Aligns with the "team collab" + power-user mental model. Without it, fast navigation will feel sluggish.
- Needs a global keyboard handler hook (probably `useHotkeys` from `react-hotkeys-hook` or roll our own). A keyboard help overlay (`?` or `cmd+/`) is worth adding so users can discover.
- Tree row focus state must be visually clear (Notion-clean still needs a strong focus ring).
- `cmd+k` quick-open requires reusing/extending the existing search infra (`components/search/`).

### Q: Mobile / responsive behavior?
**Drawer pattern below ~768px.** Both sidebars become slide-in drawers, content area takes full width, hamburger summons tree, comments icon summons comments, backdrop on overlay.

**Insights:**
- Matches expectation from Drive/GitHub mobile.
- Default state on mobile: both drawers closed; the file detail is the first thing you see.
- Comments unread/count badge stays visible on the comments icon even when drawer is closed — important for collab.
- Resize handles can be hidden on mobile (no manual resize on touch).
- Breakpoint and touch-target sizing — defer exact numbers to the plan stage.

## Synthesis

### Key Decisions

1. **Header IA: two-tier chrome + breadcrumb.** Top chrome carries org + drive switchers (Notion-style). Breadcrumb below is *pure path* within the drive. No more `swarm > default > thoughts > ...` mixing.
2. **File tree truncation: middle-ellipsis + tooltip.** Preserves date prefixes (`2026-04-14-…`) and extensions (`….md`) and UUID suffixes, full name on hover.
3. **Tree expansion preservation.** Clicking a file MUST NOT collapse/reset the tree. Expansion state is durable across navigation.
4. **Sidebars: resizable + collapsible, persisted per user.** localStorage-backed `{ open, width }` for tree (left) and comments (right). Sensible defaults on first load (~280 / ~360px). Min/max bounds. Collapse exposes a re-open rail.
5. **FileBrowser view modes: list + grid toggle, persisted per user.** Grid is an alternative for spatial scanning, not a replacement. No thumbnails — just folder/file glyphs.
6. **Tooltips everywhere on icon-only buttons.** Non-negotiable accessibility + clarity baseline.
7. **Download: file-only, in FileDetail toolbar + tree right-click.** No folder zip in this pass.
8. **Visual direction: Notion-clean / minimal.** Light-first with dark, neutral grays, single subtle accent, soft shadows, reading-first typography. Apply via `frontend-design` skill.
9. **Keyboard shortcuts: full pro-tool set.** cmd+k quick-open, arrow nav, sidebar toggles, esc-to-close.
10. **Mobile: drawer pattern below ~768px.** Both sidebars become slide-in drawers; content full-width.

### Core Requirements (lightweight PRD)

**R1. Top bar / header**
- Replace current breadcrumb-only header with two-tier chrome.
- Top row: org switcher (left) → drive switcher → spacer → search affordance / cmd+k hint → user/account/theme controls.
- Bottom row: pure-path breadcrumb (segments inside the current drive only). The current filename row stays; copy/link buttons stay.
- `(3)` and `(1)` count badges live next to switcher labels (or in dropdowns), never in the breadcrumb.

**R2. File tree (left sidebar)**
- Middle-ellipsis on long names; full name in `Tooltip` on hover.
- **Smart UUID resolution:** detect UUID-shaped path segments and resolve to human-readable labels via registry/lookup; fall back to middle-ellipsis when no match. Specifics in `/research`.
- Expansion state lives in a stable store (Zustand or a dedicated `useTreeExpansion` hook), keyed by node path; survives navigation, route changes, file selection, and reload (persist via localStorage).
- Resizable via inner-edge drag handle; collapsible to a thin rail with a re-open icon.
- Width + open/closed persisted as `liveui:tree { open, width }`.
- Type-aware glyphs (see R4) — keep the visual language consistent across tree + grid.
- Right-click context menu: Open, Copy link, Download, (future: rename/move).

**R3. Comments sidebar (right)**
- Same resize + collapse + persistence behaviour as the file tree (`liveui:comments { open, width }`).
- Default closed in some flows, open in others — but persistence wins after first interaction.
- ~~Unread/count badge visible on the collapsed-state icon.~~ *Dropped during review:* count infra doesn't exist yet — show the comments icon only when collapsed; revisit badge once count infra lands.

**R4. FileBrowser (folder content view)**
- View toggle: list (default) / grid. Persisted as `liveui:browser:view`.
- Grid: folder + **type-aware** file glyphs (research / plan / brainstorm / generic markdown / image / pdf / …) inferred from filename pattern + extension. No thumbnails. Name truncation matches tree rules.
- Same type-aware glyph set is reused in the tree (R2) for consistency.

**R5. FileDetail toolbar**
- Header row: filename + `[copy] [link] [download]` icon buttons, all with tooltips.
- Reader-friendly markdown layout: comfortable line-length, generous padding, soft typography.

**R6. Tooltips (#6)**
- Every icon-only control gets a tooltip via shadcn `Tooltip` primitive (or equivalent). Audit all current icon buttons.

**R7. Keyboard shortcuts**
- Implement the full set above. Add a discoverable `?` help overlay listing all shortcuts.

**R8. Responsive (≤768px)**
- Drawer pattern; both sidebars hidden by default; full-width content; hamburger + comments icons to summon; backdrop on overlay; resize handles hidden on touch.

**R9. Visual pass (#3)**
- Run via `frontend-design` skill with the Notion-clean brief: neutral grays, single accent, soft shadows, typography pass, light + dark, polished empty states.

### Constraints Identified

- **Tech baseline:** Vite + React + Bun, shadcn/ui (`components.json`), existing routes (`Credentials`, `FileBrowser`, `FileDetail`).
- **Stay in shadcn ecosystem** — use shadcn `Resizable`, `Tooltip`, `Sheet`, `DropdownMenu`, `Dialog` rather than introducing competing libs.
- **Don't reshape backend APIs** in this pass — UI-only redesign on top of current `agent-fs` endpoints.
- **Markdown is the dominant content type** — design for reading; viewers/* gracefully handle non-markdown but markdown is the golden path.
- **Persistence is localStorage** — no server-side preference store.
- **Shareable URLs must keep working** unchanged (deep-links to file detail by path are a known surface).

### Open Questions (resolved during review)

1. **UUID-to-name resolution → IN SCOPE, smart matching.** Taras: *"Could we do some smart UUID matching?"* Promote from open question to **target requirement**. Approach to investigate during `/research`: detect UUID-shaped path segments and resolve them via a registry/lookup (workspace IDs → workspace names, agent IDs → agent names, etc.) rather than relying on truncation alone. Falls back gracefully to middle-ellipsis when no resolution is found.
2. **Comment count source → infra not built yet.** Taras: *"We do not have that yet."* No unread/total count infra exists. **Resolution:** drop the unread/count badge from R3 for this pass — show the comments icon only when collapsed. Building count infra is a follow-up if/when it becomes a real ask.
3. **shadcn `Resizable` already pulled in? → check + stay consistent.** Taras: *"We should check and ensure it's consistent."* `/research` confirms whether `live` already uses shadcn's `Resizable`; reuse if so, add it via shadcn if not. Don't roll a custom hook — consistency with the rest of the shadcn primitives wins.
4. **Grid view glyphs → type-aware glyphs IN SCOPE.** Taras: *"We could do some support type ones."* Confirmed requirement under R4: differentiate by content type (research / plan / brainstorm / generic markdown / image / pdf / …) via filename pattern + extension. Not just a single `.md` glyph.
5. **Accent + typography pair → defer to `frontend-design`.** Taras: *"Use frontend design yes."* Let the skill propose concrete picks; review during the visual pass.
6. **Search rework → OUT OF SCOPE.** Taras: *"Out of scope."* No redesign of the Files/Search sidebar tabs in this pass. cmd+k as a *shortcut* into the existing search may still land (it already exists per #7 below) — keyboard wiring only, no UX overhaul.
7. **Keyboard handler library → check existing patterns first.** Taras: *"Check existing patterns if any, I know there's cmd k now."* cmd+k is already implemented in `live`. `/research` audits the existing keyboard infra; the plan extends it. Don't introduce a new library if the current pattern is workable.

### Out of Scope (for this pass)

- Folder-as-zip download.
- Public-link / share-permission UX.
- Multi-org switching at the user-account level (assumes existing `AccountSwitcher` is sufficient).
- Versioning UI redesign (we have `VersionHistory.tsx` but didn't probe it).
- **Search rework / Files-vs-Search sidebar tabs redesign** — confirmed out of scope during review. (cmd+k *shortcut* into existing search may still land — keyboard wiring only.)
- **Comment count / unread badge infrastructure** — the data layer doesn't exist yet (confirmed during review). Comments icon shows without count for now.
- Mobile editing/comment-creation experience — read-first on mobile.

### Suggested Next Step

Run `/desplega:research` against the `live/` codebase using this brainstorm as input. Concrete research targets (from the resolved Open Questions):

1. **Smart UUID resolution** — what registry / metadata could we tap to map UUID-shaped path segments to human labels? (workspace IDs → workspace names, etc.)
2. **shadcn primitives audit** — does `live` already pull in `Resizable`, `Tooltip`, `DropdownMenu`, `Sheet`, `ContextMenu`? Identify gaps.
3. **Existing keyboard infrastructure** — how is the current cmd+k wired? Can we extend it for the full shortcut set, or do we need a different pattern?
4. **Existing tree state shape** — how does `FileTree` currently track expansion? What change is needed to make state durable across file-clicks?
5. **Existing breadcrumb + header components** — `Breadcrumbs.tsx`, `Header.tsx`, `DrivePicker.tsx`, `AccountSwitcher.tsx` — concrete plan to refactor into the two-tier layout without breaking routing/state.
6. **Type-aware glyph mapping** — what extension/filename-pattern → glyph mapping makes sense (research/plan/brainstorm/markdown/image/pdf/...)?

After research, hand off to `/desplega:create-plan` for a phased implementation plan. Suggested phasing:

1. Header IA refactor (R1) — foundation for everything else.
2. Sidebar resize/collapse infra (R2/R3 layout part) + tree expansion persistence (R2 state part).
3. File tree polish: middle-ellipsis, tooltips, UUID resolution, type-aware glyphs, right-click menu.
4. Tooltips audit (R6) + download button wiring (R5).
5. Keyboard shortcuts extension (R7).
6. FileBrowser list/grid toggle (R4).
7. Visual pass via `frontend-design` skill (R9).
8. Responsive / drawer pattern (R8).
