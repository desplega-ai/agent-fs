---
date: 2026-09-03T14:50:47+0200
researcher: Claude
git_commit: 7e7360c20f8933cc7969aae5d140add3ac34150f
branch: main
repository: agent-fs
topic: "Manual file creation, browser upload, and a rich editor in the live/ web UI"
tags: [research, codebase, live-ui, upload, editor, monaco, markdown, raw-put]
status: complete
autonomy: critical
last_updated: 2026-09-03
last_updated_by: Claude
---

# Research: Manual file creation, browser upload, and a rich editor in the live/ web UI

**Date**: 2026-09-03 14:50 CEST
**Researcher**: Claude
**Git Commit**: 7e7360c20f8933cc7969aae5d140add3ac34150f
**Branch**: main

## Research Question

Taras asked: "I would like to have a way to create files manually in agent-fs ui + potentially an editor (rich one). Do some research on the easiest way we could achieve this, and the best solutions out there for it. Essentially would be nice to upload files to the ui directly, then be able to edit, etc."

Two parts: (1) what the codebase already offers for writing files from a browser, and (2) which external editor and upload solutions fit. Because the question explicitly asks for "easiest way" and "best solutions", this document ends with an evaluation and a recommendation. Sections 1 to 4 are purely descriptive.

## Summary

The live UI already edits files. `TextViewer` wraps Monaco and has a working save path: `FileViewer` → `useFileSave` → `client.write` → `POST /orgs/:orgId/ops` with `op: "write"`. Markdown files get a source / split / preview edit view backed by the same Monaco editor and `MarkdownViewer`. What is missing is purely the "create" side: there is no new-file dialog, no upload input, no drag-and-drop, and no rename or delete in the tree context menu. Directories are implicit key prefixes, so there is no `mkdir` op either.

The server already exposes everything a browser needs for creation and upload, with no server changes. The JSON `write` op accepts `expectedVersion: 0` as create-only. The binary route `PUT /orgs/:orgId/drives/:driveId/files/:path/raw` takes raw bytes up to 50 MB with a Bearer token, `If-None-Match: *` for create-only, and `X-Agent-FS-Message` for the version message. This is the exact wire format the CLI uses for `agent-fs write --file`. CORS defaults to `*`, and the hosted UI at live.agent-fs.dev already calls the daemon cross-origin, so uploads work from the browser today. Presigned upload URLs do not exist (only presigned GET), so files above 50 MB need new server work.

For the rich editor, the constraint that matters is that Markdown on disk is the shared contract with agents writing through CLI and MCP. That rules out block-JSON editors (BlockNote, Notion-style) and favors markdown-native ones. Verified against npm on 2026-09-03: MDXEditor 4.2.3 (Lexical + MDAST, frontmatter plugin, source-mode fallback), Milkdown Crepe 7.22.1 (ProseMirror + remark), and TipTap 3.31.2 with the new official `@tiptap/markdown` extension are the three credible options. All are MIT and declare React 19 support. The recommendation below is a two-phase approach: ship create + upload + rename/delete on the existing write paths first, then add MDXEditor as a fourth edit mode for `.md` files while keeping Monaco as the source fallback. Taras confirmed these choices in review; see "Decisions" near the end.

## Detailed Findings

### 1. The live/ UI today

**Stack and deploy.** Vite 8 + React 19 + Tailwind v4 + shadcn (`base-nova` style, `@base-ui/react`), react-router v7, react-query v5. Managed with pnpm, deployed to Vercel as a pure SPA (`live/vercel.json` rewrites everything to `index.html`, no API proxy). Hosted at live.agent-fs.dev (`README.md:170`). The API endpoint is per-credential, entered by the user on `/credentials`, stored in `localStorage` (`live/src/stores/credentials.ts:8-9`). There is no `VITE_API_URL`.

**Auth from the browser.** Bearer token on every request (`live/src/api/client.ts:53,136`). No cookies or sessions. The server accepts `Authorization: Bearer <api_key>` only (`packages/server/src/middleware/auth.ts:8-45`).

**Routes** (`live/src/App.tsx:172-197`):

| Route | Page |
|---|---|
| `/credentials` | Connect or register |
| `/file/~/:orgId/:driveId/*` | `FileBrowserPage`: folder listing (`FolderView`) when the path ends in `/`, else `FileViewer` |
| `/detail/~/:orgId/:driveId/*` | `FileDetailPage`: full-page file view with version history |
| `/sql/~/:orgId/:driveId` | SQL workbench |

**API client** (`live/src/api/client.ts`). One generic RPC: `callOp(orgId, op, params, driveId)` → `POST /orgs/:orgId/ops` (`client.ts:82-86`). Ops used by the UI: `ls`, `stat`, `log`, `diff`, `recent`, `glob`, `fts`, `search`, `vec-search`, `sql`, `signed-url`, `read`, comment ops, and exactly one mutating file op: `write` (`client.ts:125-127`). `getRawUrl` / `fetchRaw` exist for `GET .../raw` (`client.ts:129-140`). There is no `putRaw`, no `mv`, `rm`, `cp` call anywhere in `live/src`.

**Editing already exists.** `TextViewer` (`live/src/components/viewers/TextViewer.tsx:310`) renders `@monaco-editor/react`. With `editable` it shows a Save / Cancel toolbar (`TextViewer.tsx:257-294`), binds Cmd/Ctrl+S (`TextViewer.tsx:140-149`), and guards `beforeunload` when dirty (`TextViewer.tsx:81-88`). The trace:

1. Pencil button in `ViewerHeader` → `setIsEditing(true)` (`FileViewer.tsx:154-157,769-786`).
2. Markdown files render `MarkdownEditView` (`FileViewer.tsx:453-516`): Monaco source pane plus live `MarkdownViewer` preview, with `source` / `split` / `preview` modes and a draggable `SplitPane`. Other text files render `TextViewer` directly (`FileViewer.tsx:415-427`).
3. `handleSave` (`FileViewer.tsx:165-174`) calls `save(content, stat?.currentVersion)` from `useFileSave` (`live/src/hooks/use-file-save.ts:13-58`), which calls `client.write(orgId, driveId, { path, content, expectedVersion })`.
4. On success: toast `Saved (vN)`, `refetchStat()` on `["stat", orgId, driveId, path]`. Nothing invalidates `["ls", ...]` because no current write changes directory structure.

**No create or upload surface.** Verified by search of `live/src`: no `<input type="file">`, no `onDrop` / `dragover`, no `FormData`. `new Blob` appears only for CSV and SVG export. The `FilePlus` icon in `FolderView.tsx:105` is decorative. The tree context menu (`live/src/components/file-tree/FileTreeNode.tsx:214-233`) has Open, Copy link, Download, Open in new tab. No Rename, Delete, New file, New folder.

**Viewer dispatch** (`FileViewer.tsx:38-112`): extension sets pick `ImageViewer`, `VideoViewer`, `PdfViewer` (signed URL), `TablePreviewViewer` (csv/tsv/ndjson/parquet/xlsx via DuckDB-WASM or server `sql`), `DatabasePreviewViewer`, `FallbackViewer` for binaries, `TextViewer` for text, and `MarkdownViewer` for `md`, `mdx`, `txt`. `MarkdownViewer` uses react-markdown + remark-gfm + rehype-highlight, hand-parses YAML frontmatter (`MarkdownViewer.tsx:58-161`), and routes ```mermaid fences to `MermaidDiagram`. `shiki` is a dependency but is not imported anywhere.

**State and cache keys.** `AuthProvider` owns `client`, `orgId`, `driveId` (`live/src/contexts/auth.tsx:32-168`). Folder listings are cached per path under `["ls", orgId, driveId, path]` (`FileTree.tsx:30`, `FileTreeNode.tsx:82`, `FolderView.tsx:46`). `["stat", orgId, driveId, path]` in `use-file-stat.ts:11`. File content is not in react-query (`use-file-content.ts` uses local state over a signed-URL fetch). Tree expansion is a `useSyncExternalStore` singleton (`live/src/stores/tree-expansion.ts`).

**UI primitives available** (`live/src/components/ui/`): button, input, textarea, popover, tooltip, badge, spinner, dialog, resizable, sheet, toggle-group, kbd, dropdown-menu, context-menu, toaster. `CredentialDetailsDialog` is the existing dialog pattern to copy.

### 2. Server write paths

**JSON op route.** `POST /orgs/:orgId/ops` (`packages/server/src/routes/ops.ts:9`). `write` schema: `{ path, content: string, message?, expectedVersion? }` (`packages/core/src/ops/index.ts:48-56`). Content is a string, capped at 10 MB (`packages/core/src/ops/write.ts:15,65-71`). Other write ops on the same route: `edit`, `append`, `mv`, `cp`, `rm`, `revert`. All require the `editor` drive role (`packages/core/src/identity/rbac.ts:31-37`).

**Create-only semantics.** `assertExpectedVersion` computes `currentVersion = nextVersion - 1`, so a file with no versions is at version 0 (`packages/core/src/ops/versioning.ts:92-109`). Passing `expectedVersion: 0` therefore means "must not exist" and throws `EditConflictError` otherwise. The raw route maps `If-None-Match: *` to the same `expectedVersion: 0` (`packages/server/src/routes/files.ts:141-149`).

**Raw binary route.** `PUT /orgs/:orgId/drives/:driveId/files/:filePath{.+}/raw` (`files.ts:107`):

- Body: raw bytes via `c.req.arrayBuffer()` (`files.ts:189`). Rejects `application/json` bodies with 415 (`files.ts:114-124`).
- Headers: `Authorization: Bearer`, any non-JSON `Content-Type`, `If-Match: <version>` or `If-None-Match: *`, `X-Agent-FS-Message` plus `X-Agent-FS-Message-Encoding: percent` for non-Latin-1 messages (`files.ts:166-186`).
- Response: `WriteResult` JSON `{ version, path, size, contentHash, deduped }` plus `ETag`, `X-Agent-FS-Version` headers (`files.ts:209-220`).
- Limits: Hono `bodyLimit` 50 MB (`packages/server/src/app.ts:32`) and `MAX_RAW_FILE_SIZE` 50 MB (`write.ts:18`). Buffered, not streamed (`files.ts:106`).

**Core write pipeline** (`write.ts:55-128`): compute S3 key, enforce cap, SHA-256, optional version check plus dedup short-circuit, `detectMimeType(path)` by extension only (`packages/core/src/ops/mime.ts:56-59`; browser-supplied `Content-Type` is not stored), `putObject`, `createVersion` in one SQLite transaction (`versioning.ts:152-258`), then synchronous FTS indexing and embedding scheduling for indexable text (`packages/core/src/ops/search-index.ts:52-79`). Every successful write creates a new `file_versions` row.

**Directories are implicit.** No `mkdir` op exists in `opRegistry` (`ops/index.ts:47-323`). `ls` derives folders from `listObjects` common prefixes (`packages/core/src/ops/ls.ts:7-68`).

**Presigned URLs.** Only presigned GET exists: `signed-url` op (`packages/core/src/ops/signed-url.ts:27-84`) → `getPresignedUrl` on the adapter (`packages/core/src/storage/adapter.ts:114-119`) → `GetObjectCommand` in `packages/core/src/s3/client.ts:215-229`. The local adapter throws `UnsupportedOperation` (`local-adapter.ts:240-247`). There is no `PutObjectCommand` presign anywhere.

**CORS.** `config.server.cors.origins` defaults to `["*"]` (`packages/core/src/config.ts:112-114`), applied as Hono `cors()` before auth (`app.ts:23-29`). The hosted UI already relies on this for cross-origin `POST /ops` calls.

**Rate limit.** 1200 requests per minute per API key by default (`packages/server/src/middleware/rate-limit.ts`, `config.ts:115-117`).

**CLI wire format for binary upload** (`packages/cli/src/api-client.ts:91-161`, `packages/cli/src/commands/ops.ts:104-118`): `PUT .../raw` with `Content-Type: application/octet-stream`, Bearer, optional `If-Match`, `X-Agent-FS-Content-Hash`, percent-encoded `X-Agent-FS-Message`. A browser `fetch` with a `File` body reproduces this exactly. MCP exposes only the JSON ops (`packages/mcp/src/tools.ts:8-63`), so MCP clients cannot write binary today.

**Docs.** `docs/api-reference.md:94-111` documents both raw routes with curl examples. `docs/openapi.json` carries per-op schemas.

### 3. Prior thoughts on this topic

- `thoughts/taras/plans/2026-03-19-signed-urls-fe-and-mime-types.md` moved viewers to signed GET URLs and listed "binary upload" as out of scope because `write` only accepts a string. The raw PUT route landed later and closes that gap.
- `thoughts/taras/research/2026-08-21-sync-write-audit-raw-put.md` documents the synchronous cost of `PUT /raw` (FTS, hashing, WAL) and names presigned uploads as the future path for large binaries. Not implemented.
- `thoughts/taras/research/2026-06-25-files-sdk-storage-adapters.md` notes `files-sdk` offers `signedUploadUrl()` and that non-S3 adapters have no presign concept. Still an open decision.
- `thoughts/taras/research/2026-04-27-live-ui-improvements.md` said "no Monaco or rich editor for text viewing yet". That is stale: Monaco editing shipped since.
- `thoughts/taras/research/2026-03-15-document-comments.md`: comments are plain text and out of scope for rich text.
- `~/.agentic-learnings.json` has no entries about the UI, upload, or editors.

### 4. External options (verified against npm on 2026-09-03)

| Package | Version | React peer | License | Last publish |
|---|---|---|---|---|
| `@tiptap/react` / `@tiptap/markdown` | 3.31.2 | `^17 \|\| ^18 \|\| ^19` | MIT | 2026-09-03 |
| `@mdxeditor/editor` | 4.2.3 | `>= 18 \|\| >= 19` | MIT | 2026-08-27 |
| `@milkdown/kit` / `@milkdown/crepe` / `@milkdown/react` | 7.22.1 | `*` | MIT | 2026-08-12 |
| `@blocknote/shadcn` | 0.54.0 | `^18 \|\| ^19` | MPL-2.0 (XL packages GPL or commercial) | 2026-08-13 |
| `platejs` / `@platejs/markdown` | 53.3.9 / 53.3.3 | `>=18` | MIT | 2026-08-24 |
| `@lexical/markdown` | 0.50.0 | n/a | MIT | 2026-09-03 |
| `react-dropzone` | 20.1.1 | `>= 18` | MIT | 2026-08-20 |
| `@uppy/react` / `@uppy/aws-s3` | 6.0.0 | `^18 \|\| ^19` | MIT | 2026-08-26 |
| `@codemirror/lang-markdown` | 6.5.2 | n/a | MIT | 2026-08-04 |

**Rich Markdown editors, by markdown fidelity.**

- **MDXEditor** (Lexical + MDAST via remark). Purpose-built for editing `.md` and `.mdx` files. Plugins for GFM tables, frontmatter (dedicated `frontmatterPlugin`), code blocks (CodeMirror inside), images, links. `onError({ error, source })` fires when MDAST cannot parse the input, and `diffSourcePlugin` gives a source-mode escape hatch so users can fix unsupported content. `onChange(markdown, initialMarkdownNormalize)` flags the first normalization pass. `suppressHtmlProcessing` exists for raw HTML. Ships its own CSS, not shadcn. Sources: mdxeditor.dev docs (overview, error-handling, diff-source).
- **Milkdown Crepe** (ProseMirror with remark as the document model). Typora-like. `@milkdown/crepe` is the batteries-included editor: toolbar, slash menu, tables, CodeMirror code blocks, LaTeX, placeholder, several themes. `getMarkdown()` and `markdownUpdated` listener. React binding is `MilkdownProvider` + `useEditor`. Frontmatter is not a Crepe feature; it would need a remark-frontmatter plugin or strip-and-reattach around the editor. No shadcn integration. Sources: milkdown.dev docs (api/crepe, recipes/react).
- **TipTap 3 + `@tiptap/markdown`** (ProseMirror, HTML/JSON schema, markdown as a converter). The official markdown extension is weeks old and supersedes the community `tiptap-markdown` (0.9.0, about a year stale). Load with `setContent(md, { contentType: "markdown" })`, save with `editor.getMarkdown()`. Parses embedded HTML through extension `parseHTML` rules. GFM tables need the Table extensions and have an open serialization bug (ueberdosis/tiptap#5750). No frontmatter support. Best shadcn story via community registries: Aslam97/minimal-tiptap (installable with `npx shadcn add`), shadcn-labs/editorcn. Sources: tiptap.dev markdown docs, release notes.
- **Plate 53** (Slate, remark pipeline with `remark-gfm` and `remark-frontmatter` opt-in). Most shadcn-native UI, heaviest bundle, largest surface area.
- **BlockNote 0.54** (TipTap-based, block JSON schema). Markdown is import/export only, documented as a CommonMark+GFM subset with no frontmatter and a known table export bug (TypeCellOS/BlockNote#1377).
- **Lexical alone** (22 KB core). A framework, not an editor. MDXEditor is the packaged answer on top of it.
- **Novel**: a Next.js template around TipTap with AI autocomplete, not a library.

**Code editor.** Monaco 0.55 is already installed and working. CodeMirror 6 is roughly 50 to 300 KB gzip depending on languages, needs no worker setup, and is what Obsidian and HedgeDoc 2 use for markdown "live preview" over raw text. Switching is not needed for this feature.

**Upload libraries.** `react-dropzone` 20.1.1 is small, MIT, React 19 ready, and handles the drop zone, click-to-open, and multiple files. Folder drops require `DataTransferItem.webkitGetAsEntry()` traversal (implemented in all major browsers despite the prefix) or `webkitdirectory` on the input. The File System Access API remains Chromium-only. Uppy 6 adds a dashboard, progress, retry, and presigned or multipart S3 uploads; it is more than the daemon can use today because there is no presigned PUT. FilePond's React adapter has not been published in about two years.

**Direct-to-S3 patterns.** Presigned PUT is the simplest, presigned POST enforces size and type policies at the bucket, multipart is required above 5 GB and recommended above about 100 MB. Bucket CORS must allow `PUT` from the UI origin and expose `ETag` for multipart. MinIO supports the same API surface but has a history of CORS preflight bugs on presigned flows (minio/minio#10002, #11111, #15693), so test explicitly. Proxying through the API is the right default when writes must go through the same hash, version, and index pipeline as CLI and MCP writes, which is the agent-fs case.

**Prior art.** Nextcloud Text uses TipTap over plain Markdown files on disk. Obsidian uses CodeMirror 6 live preview over raw Markdown. github.dev is Monaco. Outline and Notion store their own JSON and only export Markdown, which is the model to avoid here. FileBrowser (filebrowser/filebrowser) was archived on 2026-09-01; Filestash remains active and delegates office docs to Collabora.

## Evaluation and recommendation

The question asks for the easiest path and the best solutions, so this section goes beyond documentation.

### Easiest path: creation and upload need zero server changes

**New file.** A dialog (reuse `dialog.tsx` + `input.tsx`, copy `CredentialDetailsDialog`) that takes a path relative to the current folder and calls `client.write({ path, content: template, expectedVersion: 0, message: "Created in UI" })`. `expectedVersion: 0` makes it create-only, so an existing file returns a conflict instead of a silent overwrite. Then invalidate `["ls", orgId, driveId, parentPath]`, navigate to the file route, and enter edit mode. For `.md` a one-line `# <name>` template avoids a zero-byte file.

**New folder.** Because directories are implicit, two mechanisms cover it (decided below). The new-file dialog accepts nested paths like `sub/dir/name.md`, GitHub-style, so a folder appears as soon as its first file is written. A separate "New folder" action writes `<folder>/.keep` through the same `write` op so empty folders persist and show up in `ls`. Agents see the `.keep` placeholder in listings; that trade-off is accepted.

**Upload.** Add `putRaw(orgId, driveId, path, file, { ifNoneMatch, message })` to `live/src/api/client.ts`, mirroring the CLI's `putRaw`. A browser `fetch` with `method: "PUT"`, `body: file`, `Content-Type: application/octet-stream` (the server ignores it for storage and detects MIME by extension), and the Bearer header is the whole transport. Use `react-dropzone` on `FolderView` and the tree for drag-and-drop plus a hidden `<input type="file" multiple>`, and traverse `webkitGetAsEntry()` for dropped folders so relative paths land under the current folder. Send `If-None-Match: *` first; on a conflict, prompt "Replace existing file?" and retry with `If-Match: <version>`. Limit concurrency to 3 or 4 uploads to stay under the 1200 requests per minute rate limit on bulk drops. Progress bars need `XMLHttpRequest` because `fetch` has no upload progress; per-file spinners are enough for a first cut. Files above 50 MB fail with the server's body limit, so show that limit in the UI.

**Rename, move, delete.** `mv` and `rm` already exist server-side with the editor role and the UI does not call them. Adding Rename and Delete to the existing context menu (`FileTreeNode.tsx:214-233`) is cheap, and `rm` is a soft delete with a delete-marker version, so `revert` still works. This is adjacent to the ask, not part of it, but "create files manually" implies being able to clean them up.

**Cache invalidation.** Every create, upload, rename, and delete must invalidate `["ls", orgId, driveId, <parent>]` for both source and destination parents. Nothing does this today because no existing write touches structure.

### Rich editor: keep Monaco, add one markdown-native WYSIWYG for `.md`

The existing source / split / preview mode is already a good markdown editing experience and costs nothing. A WYSIWYG mode is an upgrade, not a blocker. If it is added:

1. **First pick: MDXEditor 4.2.3.** It is the only option designed around `.md` files as the source of truth with frontmatter as a first-class plugin, and it has a documented failure mode (`onError` plus source mode) for markdown it cannot parse. That matters because agents write arbitrary Markdown and an editor that throws on unknown syntax would block editing those files. Cost: its CSS needs theming to match the shadcn dark and light themes, and Lexical plus CodeMirror add a few hundred KB gzip to the `.md` edit route (lazy-load it).
2. **Runner-up: Milkdown Crepe 7.22.1** if a Typora feel is preferred. Remark is the document model, so round-trips are clean, but frontmatter needs custom handling and there is no shadcn kit.
3. **If shadcn-native look wins: TipTap 3.31 + `@tiptap/markdown` via minimal-tiptap.** Best ecosystem and styling fit, but the markdown extension is brand new, tables have an open serialization bug, and frontmatter must be stripped before load and re-attached on save.
4. **Avoid BlockNote and Plate for this use case.** BlockNote's block JSON is lossy for frontmatter and raw HTML. Plate is the heaviest option and its strengths (collaborative rich docs) are not the requirement.

Two rules apply to any WYSIWYG here. Keep Monaco source mode one click away as the escape hatch, exactly as MDXEditor's diff-source plugin does. And guard against normalization noise: every save creates a version, so compare the serialized markdown with the original and skip the write when they are byte-equal, and warn the user the first time the editor reformats an agent-written file (MDXEditor's `initialMarkdownNormalize` flag exposes this directly).

### Large uploads later, only if needed

Anything above 50 MB requires server work: a `signed-upload-url` op that presigns `PutObjectCommand`, a `finalize` op that hashes, creates the version row, and indexes, bucket CORS for the UI origin, and a fallback to `PUT /raw` on the local adapter. Uppy's `@uppy/aws-s3` would then be the client. This is the path the 2026-08-21 audit already anticipated. It is a separate feature and should not gate phase 1.

### Suggested phasing

| Phase | Scope | Server changes | New deps |
|---|---|---|---|
| 1 | New file dialog (nested paths allowed), "New folder" via `.keep`, upload via raw PUT with drag-and-drop and a 50 MB cap, rename and delete in context menu, `ls` invalidation | none | `react-dropzone` |
| 2 | MDXEditor as an opt-in `rich` mode in `MarkdownEditView` behind the existing pencil button, lazy-loaded, themed to shadcn, with normalization guard | none | `@mdxeditor/editor` |
| 3 | Presigned upload for files above 50 MB | presign PUT + finalize op + CORS | `@uppy/*` optional |

Per the project's release checklist, phase 1 touches no core ops, CLI, or MCP, so the skill and E2E updates are not required. A version bump through `./scripts/release.sh` is still needed if the UI ships with the daemon release train.

## Code References

| File | Line | Description |
|------|------|-------------|
| `live/src/api/client.ts` | 82-86 | `callOp` → `POST /orgs/:orgId/ops` |
| `live/src/api/client.ts` | 125-127 | `write()`, the only mutating file call in the UI |
| `live/src/api/client.ts` | 129-140 | `getRawUrl` / `fetchRaw` for `GET .../raw` |
| `live/src/hooks/use-file-save.ts` | 13-58 | Save hook with abort and error state |
| `live/src/components/viewers/FileViewer.tsx` | 154-174 | Enter edit, `handleSave`, `refetchStat` |
| `live/src/components/viewers/FileViewer.tsx` | 397-430 | Edit-mode dispatch: `MarkdownEditView` vs `TextViewer` |
| `live/src/components/viewers/FileViewer.tsx` | 453-516 | `MarkdownEditView` source / split / preview |
| `live/src/components/viewers/TextViewer.tsx` | 310-318 | Monaco `Editor`, `readOnly = !editable \|\| isSaving` |
| `live/src/components/viewers/MarkdownViewer.tsx` | 58-161 | Hand-parsed YAML frontmatter |
| `live/src/components/file-tree/FileTreeNode.tsx` | 214-233 | Context menu items (no rename or delete) |
| `live/src/components/folder-view/FolderView.tsx` | 46, 105 | `["ls", ...]` query, decorative `FilePlus` empty state |
| `live/src/contexts/auth.tsx` | 92-94, 107-108 | Existing `["ls"]` invalidation on org or drive switch |
| `live/src/stores/credentials.ts` | 8-9 | localStorage keys for endpoint and API key |
| `packages/server/src/routes/files.ts` | 107-220 | `PUT .../raw` handler, headers, response |
| `packages/server/src/routes/files.ts` | 141-149 | `If-None-Match: *` → `expectedVersion: 0` |
| `packages/server/src/routes/ops.ts` | 9 | `POST /orgs/:orgId/ops` dispatch |
| `packages/server/src/app.ts` | 23-32 | CORS (`*` default) and 50 MB body limit |
| `packages/server/src/middleware/auth.ts` | 8-45 | Bearer-only auth |
| `packages/core/src/ops/index.ts` | 48-56 | `write` op schema |
| `packages/core/src/ops/write.ts` | 15, 18, 55-128 | Size caps and `writeInternal` pipeline |
| `packages/core/src/ops/versioning.ts` | 92-109 | `assertExpectedVersion` (version 0 = does not exist) |
| `packages/core/src/ops/mime.ts` | 56-59 | Extension-only MIME detection |
| `packages/core/src/ops/signed-url.ts` | 27-84 | Presigned GET only |
| `packages/core/src/s3/client.ts` | 215-229 | `GetObjectCommand` presign, no PUT presign |
| `packages/cli/src/api-client.ts` | 91-161 | CLI `putRaw` wire format to replicate in the browser |
| `docs/api-reference.md` | 94-111 | Raw route documentation |

## Decisions (Taras, 2026-09-03)

Resolved in review so a yolo plan can be written in a new session from this document.

- **Rich editor: MDXEditor.** Target `@mdxeditor/editor` 4.2.3 for `.md` files. Monaco stays for every other text type and as the source escape hatch.
- **New folder: both approaches.** The new-file dialog accepts nested paths like `sub/dir/name.md`, and a separate "New folder" action writes `<folder>/.keep` so empty folders persist and show in `ls`. Agents will see the `.keep` placeholder; that is accepted.
- **WYSIWYG is opt-in.** The existing pencil edit button stays the single entry point into edit mode. The rich editor is a fourth mode next to source / split / preview inside `MarkdownEditView`, remembered per user in localStorage. Monaco source remains the default.
- **Upload size: 50 MB cap via raw PUT.** No server changes for the first release. The UI shows the cap and rejects larger files up front. Presigned upload stays a later phase.

## Open Questions

Items that are tasks for the plan rather than decisions:

- MDXEditor ships its own CSS variables rather than Tailwind classes. The plan needs a theming step to match the shadcn dark and light themes.
- Bundle sizes for MDXEditor were not measured in this session. Measure with a Vite build and keep the `.md` rich-edit route lazy-loaded.

## Appendix

- **Architecture notes**: The UI is stateless and talks to any daemon cross-origin with a Bearer key, so every create and upload path must work with the default `cors.origins: ["*"]` and no cookies. All writes converge on `writeInternal`, which is why proxying uploads through the daemon (rather than presigned PUT) keeps versions, hashes, and search consistent with CLI and MCP writes.
- **Historical context (from thoughts/)**: the 2026-03-19 signed-URL plan deferred binary upload; the raw PUT route later removed that blocker. The 2026-08-21 audit is the reference for the synchronous cost of large raw writes and for the presigned-upload follow-up.
- **Related research**:
  - `thoughts/taras/research/2026-08-21-sync-write-audit-raw-put.md`: raw PUT performance and presigned upload as a future path.
  - `thoughts/taras/research/2026-04-27-live-ui-improvements.md`: UI primitives and keyboard infrastructure (partially stale on editing).
  - `thoughts/taras/research/2026-06-25-files-sdk-storage-adapters.md`: `signedUploadUrl` in files-sdk and non-S3 adapter limits.
  - `thoughts/taras/plans/2026-03-19-signed-urls-fe-and-mime-types.md`: signed GET migration for viewers.
- **External sources**: tiptap.dev markdown docs and release notes; mdxeditor.dev docs (overview, error-handling, diff-source); milkdown.dev docs (api/crepe, recipes/react); npm registry metadata queried 2026-09-03; ueberdosis/tiptap#5750; TypeCellOS/BlockNote#1377; minio/minio#10002, #11111, #15693; MDN `DataTransferItem.webkitGetAsEntry`; filebrowser/filebrowser archive notice (2026-09-01).
