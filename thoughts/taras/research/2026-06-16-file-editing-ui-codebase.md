---
date: 2026-06-16T14:00:00-04:00
researcher: Claude
git_commit: 8c15da7
branch: main
repository: agent-fs
topic: "File editing capabilities in the live/ web UI"
tags: [research, codebase, live, ui, file-editing]
status: complete
autonomy: critical
last_updated: 2026-06-16
last_updated_by: Claude
---

# Research: File Editing in the Web UI

**Date**: 2026-06-16
**Researcher**: Claude
**Git Commit**: `8c15da7`
**Branch**: `main`

## Research Question

What exists in the agent-fs codebase to support file editing from the web UI (`live/` SPA), and what specific pieces need to be built? The goal: allow users to edit text files directly in the browser with a split-view option (source + preview) for markdown.

## Summary

The codebase has a complete read-only file viewing pipeline but zero file editing capability in the UI. All the server-side infrastructure for writes already exists (`write` op, `PUT /raw` endpoint, `client.callOp` dispatch). The frontend needs three focused additions: (1) a `WriteResult` type + `useFileSave` hook, (2) an edit mode toggle in `TextViewer.tsx` (which already uses Monaco Editor), and (3) a split-view mode for markdown files showing editable source alongside rendered preview.

## Detailed Findings

### 1. Server-Side Write Infrastructure (exists)

The `write` op in `packages/core/src/ops/write.ts:20` accepts `WriteParams` (`{ path, content, message?, expectedVersion? }`) and writes to S3 with versioning, dedup, and search indexing. It's dispatched via `POST /orgs/:orgId/ops` with `op: "write"`. RBAC enforces `editor` role or better through `dispatchOp`. The `writeRaw` variant handles binary payloads up to 50 MB via `PUT /raw`.

### 2. API Client Dispatch (exists)

`live/src/api/client.ts:82` — `client.callOp<T>(orgId, "write", params, driveId)` can call any registered op. No `WriteResult` type exists in `live/src/api/types.ts` — only `CatResult`, `StatResult`, etc.

### 3. Read-Only Viewers (exist, need modification)

| Component | File | Role |
|-----------|------|------|
| `FileViewer` | `live/src/components/viewers/FileViewer.tsx:119` | Dispatcher — routes by extension to the correct viewer |
| `TextViewer` | `live/src/components/viewers/TextViewer.tsx:41` | Monaco Editor with `readOnly: true` (line 204) |
| `MarkdownViewer` | `live/src/components/viewers/MarkdownViewer.tsx` | `react-markdown` rendered HTML preview |
| `ViewerHeader` | `live/src/components/viewers/FileViewer.tsx:364` | Toolbar with Copy, Download, Source/Preview toggle, Expand |

### 4. Content Fetching (exists)

`live/src/hooks/use-file-content.ts:10` — Fetches via signed URL. Returns `{ content, totalLines, truncated }`. `useFileStat` (via `use-file-stat.ts`) provides `currentVersion` for optimistic concurrency.

### 5. Auth Context (exists)

`live/src/contexts/auth.tsx:164` — `useAuth()` provides `client`, `orgId`, `driveId` everywhere in the component tree.

### 6. The Only Existing Writable Monaco (reference pattern)

`live/src/components/sql/SqlEditor.tsx` — Uses Monaco without `readOnly`, demonstrates the writable Monaco pattern. Also has `cmd+enter` for query execution.

## Code References

| File | Line | Description |
|------|------|-------------|
| `packages/core/src/ops/write.ts` | 20 | Server-side `write` op implementation |
| `packages/core/src/ops/types.ts` | 17 | `WriteParams` type definition |
| `packages/core/src/ops/types.ts` | 111 | `WriteResult` type definition |
| `live/src/api/client.ts` | 82 | `callOp` dispatch method |
| `live/src/api/types.ts` | — | Missing `WriteResult` type |
| `live/src/components/viewers/FileViewer.tsx` | 119 | Main viewer dispatcher |
| `live/src/components/viewers/FileViewer.tsx` | 204 | `readOnly: true` in Monaco config |
| `live/src/components/viewers/FileViewer.tsx` | 364 | `ViewerHeader` toolbar |
| `live/src/components/viewers/FileViewer.tsx` | 86 | `isMarkdown()` check |
| `live/src/components/viewers/TextViewer.tsx` | 41 | Monaco text viewer (read-only) |
| `live/src/components/viewers/MarkdownViewer.tsx` | — | Markdown rendered preview |
| `live/src/components/sql/SqlEditor.tsx` | — | Writable Monaco reference pattern |
| `live/src/hooks/use-file-content.ts` | 10 | File content fetch hook |
| `live/src/hooks/use-file-actions.ts` | 11 | File action hook (copy, download) |
| `live/src/contexts/auth.tsx` | 164 | `useAuth()` context |
| `live/src/hooks/use-keyboard-shortcuts.ts` | 127 | Shortcut registry hook |

## Open Questions

- Editing should be available for all text files that `isTextFile()` returns true for.
- Split view should support both side-by-side (left=rich preview, right=source editor) and stacked (top=editor, bottom=preview) layouts, togglable.
- A visual "dirty" indicator should show when content differs from the last saved version.

## Appendix

- **Architecture notes**: The app follows a consistent pattern: viewer components receive `path` and render content; they don't own mutation state. Adding editing should follow the same pattern — a new `useFileSave` hook with loading/success/error state, and an "edit mode" toggled per-viewer.
- **Related research**: None found in `thoughts/` for UI editing.
