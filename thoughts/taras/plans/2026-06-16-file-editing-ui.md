---
date: 2026-06-16
planner: Claude
topic: "File editing in live/ web UI"
status: draft
autonomy: critical
---

# File Editing in Web UI — Implementation Plan

## Overview

Enable users to edit text files directly in the browser with Monaco Editor, including a split-view option for markdown files (editable source + rendered preview side-by-side).

- **Motivation**: Users currently have a full read-only file viewing pipeline but must use the CLI or direct S3 access to edit files. Adding in-browser editing completes the core file management loop.
- **Related**: `thoughts/taras/research/2026-06-16-file-editing-ui-codebase.md`, `live/src/components/viewers/FileViewer.tsx`

## Current State Analysis

- `live/src/api/types.ts` — Only read/query result types defined (`CatResult`, `StatResult`, etc.). No `WriteResult` or `EditResult`.
- `live/src/api/client.ts` — Only read/query methods (`getSignedUrl`, `callOp` for reads). No `write()` or `edit()` methods.
- `live/src/components/viewers/TextViewer.tsx` — Monaco Editor with `readOnly: true` (line 204). No editing flow.
- `live/src/components/viewers/FileViewer.tsx` — ViewerHeader has Copy/Download/SourceToggle/Expand buttons. No Edit/Save/Cancel buttons.
- `live/src/hooks/` — `useFileContent` fetches read-only content; `useFileActions` only has copy/download/share. No save hook.
- `packages/core/src/ops/types.ts` — `WriteParams`/`WriteResult` and `EditParams`/`EditResult` already defined server-side.
- `packages/core/src/ops/write.ts` — Server-side `write` op exists, dispatched via `POST /orgs/:orgId/ops` with RBAC `editor` role.
- `live/src/components/sql/SqlEditor.tsx` — Only existing writable Monaco instance (for SQL queries, not file editing).

## Desired End State

A user can navigate to any text file, click "Edit" (or press a shortcut), edit the content in a writable Monaco editor, and Save (which writes back via the API). For markdown files, a split-view toggle shows the rendered preview alongside the editable source. Unsaved changes show a dirty indicator; navigating away triggers a confirmation prompt.

## What We're NOT Doing

- No binary file editing (images, PDFs, etc.)
- No rename/move/delete/copy in this pass (separate feature)
- No collaborative/real-time editing
- No offline editing
- No version history browser UI
- No revert/restore UI

## Implementation Approach

- Follow the existing architecture patterns: a new hook (`useFileSave`) parallels `useFileContent`; `TextViewer` grows an `editable` mode rather than creating a new component; `FileViewer` integrates edit state in the toolbar.
- Use `client.callOp<T>(orgId, "write", params, driveId)` for saves — no new API route needed.
- The existing Source/Preview toggle (`showRaw`) is retained; edit mode adds a dimension on top: in edit mode, the layout can be source-only or split-view.
- Sequencing: API client → hook → editable text viewer → FileViewer integration → split-view.

## Quick Verification Reference

- `cd live && pnpm run typecheck` — TypeScript type checking in the `live/` package
- Manual dev server check: `cd live && pnpm dev`

---

## Phase 1: API Foundation — Types + Client Method

### Overview

Add `WriteResult`/`WriteParams` types to the frontend and a `write()` method on `AgentFsClient`, so the frontend can call the server-side write op.

### Changes Required:

#### 1. Add types to `live/src/api/types.ts`
**File**: `live/src/api/types.ts`
**Changes**: Add `WriteParams` and `WriteResult` interfaces matching `packages/core/src/ops/types.ts`.

#### 2. Add `write()` method to `live/src/api/client.ts`
**File**: `live/src/api/client.ts`
**Changes**: Add `async write(orgId, driveId, params: WriteParams): Promise<WriteResult>` method that calls `this.callOp<WriteResult>(orgId, "write", params, driveId)`.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd live && pnpm run typecheck`
- [ ] Build succeeds: `cd live && pnpm build`
- [ ] Export check: `node -e "const { WriteParams, WriteResult } = require('./src/api/types')"` (or equivalent ESM import test)

#### Automated QA:
- [ ] Verify the `write` method signature matches the expected `callOp<T>` pattern

#### Manual Verification:
- [ ] N/A — type-only changes

**Implementation Note**: After this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: `useFileSave` Hook

### Overview

Create a React hook that wraps the write operation with loading/success/error state, dirty tracking, and optimistic concurrency via `expectedVersion`.

### Changes Required:

#### 1. Create `live/src/hooks/use-file-save.ts`
**File**: `live/src/hooks/use-file-save.ts` (new file)
**Changes**: Hook with signature `useFileSave(path: string): { save: (content: string) => Promise<WriteResult>, isSaving: boolean, error: Error | null, savedVersion: number | null }`. Accepts optional `expectedVersion` for optimistic concurrency. Uses `useAuth()` for client/orgId/driveId.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd live && pnpm run typecheck`

#### Automated QA:
- [ ] Hook can be imported and instantiated in a component without errors

#### Manual Verification:
- [ ] Verify hook handles errors gracefully (network failure, conflict)

**Implementation Note**: After this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Editable `TextViewer` + `FileViewer` Integration

### Overview

Make `TextViewer` optionally editable (writable Monaco) with Save/Cancel UI, and integrate edit mode into `FileViewer` via a toolbar button and keyboard shortcut.

### Changes Required:

#### 1. Modify `TextViewer` to support editable mode
**File**: `live/src/components/viewers/TextViewer.tsx`
**Changes**: Add `editable` prop (default `false`). When `editable` is true, set `readOnly: false` on Monaco, show Save/Cancel buttons in a header bar, disable editor during save (loading state), show error message on save failure (dismissable), wire up `useFileSave` hook, track dirty state, intercept `Cmd+S` for save, show a dirty indicator, and register `beforeunload` handler while dirty to prevent accidental navigation.

#### 2. Add edit mode to `FileViewer` + `ViewerHeader`
**File**: `live/src/components/viewers/FileViewer.tsx`
**Changes**: Add `isEditing` state, wire up Edit button in `ViewerHeader`, pass `editable` prop to `TextViewer`, confirm before discarding unsaved changes.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd live && pnpm run typecheck`

#### Automated QA:
- [ ] Edit button appears in ViewerHeader for text files
- [ ] Clicking Edit makes Monaco writable
- [ ] Saving calls the write op and shows success
- [ ] Canceling reverts content and exits edit mode
- [ ] Dirty indicator appears when content changes
- [ ] `Cmd+S` triggers save
- [ ] Navigating away while dirty shows confirmation

#### Manual Verification:
- [ ] Visual review of the edit toolbar layout
- [ ] Verify Monaco editor behavior (syntax highlighting, completion) in edit vs read-only mode

**Implementation Note**: After this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Split-View for Markdown Files

### Overview

Add a split-view layout for markdown files: editable Monaco source alongside a live-updating rendered preview. Support side-by-side and stacked orientations.

### Changes Required:

#### 1. Modify `FileViewer` split-view logic
**File**: `live/src/components/viewers/FileViewer.tsx`
**Changes**: When editing a markdown file, add a Source/Split/Preview toggle (replacing the current Source/Preview toggle). When in Split mode, render both `TextViewer` (editable) and `MarkdownViewer` (rendered preview, fed the current editor content). Support orientation toggle (side-by-side ↔ stacked) with a draggable resize handle for adjusting pane widths/heights.

#### 2. Ensure `MarkdownViewer` can receive dynamic content
**File**: `live/src/components/viewers/MarkdownViewer.tsx`
**Changes**: No structural changes needed — it already receives `content` as a prop. Verify rendering is stable when content changes rapidly (typing).

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd live && pnpm run typecheck`

#### Automated QA:
- [ ] Split-view toggle appears when editing a markdown file
- [ ] Side-by-side layout shows Monaco (left) + rendered preview (right)
- [ ] Stacked layout shows Monaco (top) + rendered preview (bottom)
- [ ] Preview updates live as user types in the editor
- [ ] Toggle works: source-only ↔ split ↔ preview-only
- [ ] Split-view is NOT offered for non-markdown text files

#### Manual Verification:
- [ ] Visual review of split-view layout at different viewport sizes
- [ ] Verify markdown rendering fidelity in preview pane

**Implementation Note**: After this phase, pause for manual confirmation. Create commit after verification passes.

---

## Review Errata

_Reviewed: 2026-06-16 by Claude_

### Applied
- [x] Missing YAML frontmatter — added
- [x] Phase 2 hook signature was vague — clarified exact return type shape (`{ save: (content: string) => Promise<WriteResult>, isSaving, error, savedVersion }`)
- [x] Phase 3 missing `beforeunload` navigation guard — added to Changes
- [x] Phase 3 missing error recovery UI (dismissable error message on save failure) — added
- [x] Phase 3 missing loading state during save (disable editor) — added
- [x] Phase 4 missing resize handle for split panes — added
- [x] Derail notes: shortcut conflict now has concrete recommendation (toolbar-only edit, `Escape` to exit, `Cmd+S` to save), plus note on avoiding a split-pane library dependency

- **Follow-up plans**: None yet
- **Derail notes**: The `e` keyboard shortcut is used for Source/Preview toggle. Recommend: toolbar-only Edit button (no keyboard shortcut to enter edit mode), `Cmd+S` to save (already conventional), and `Escape` to exit edit mode (discard not needed since Monaco handles it). The `EditParams`/`EditResult` types and `edit()` method could be added in a follow-up for find-and-replace editing. Split-view resize behavior could use a lightweight implementation (CSS `resize` property or a simple drag handle) rather than a full library dependency — existing codebase has no split-pane library.
- **References**:
  - Research: `thoughts/taras/research/2026-06-16-file-editing-ui-codebase.md`
  - Core types: `packages/core/src/ops/types.ts` (lines 17, 111 for WriteParams/WriteResult)
  - Server write: `packages/core/src/ops/write.ts`
  - SQL Editor (writable Monaco pattern): `live/src/components/sql/SqlEditor.tsx`
  - Keyboard shortcuts: `live/src/hooks/use-keyboard-shortcuts.ts`
