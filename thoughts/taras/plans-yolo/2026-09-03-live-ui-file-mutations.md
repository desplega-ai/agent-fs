---
date: 2026-09-03T15:30:00Z
topic: "live/ UI: new file, new folder, upload, rename, delete"
status: done
---

# live/ UI: new file, new folder, upload, rename, delete

Source research: `thoughts/taras/research/2026-09-03-ui-file-create-upload-rich-editor.md` (its "Decisions" section is binding).

## Goal

The hosted UI can create files and folders, upload files and folders from the browser, and rename or delete files. All of it uses the existing server routes: the JSON `write`, `mv` and `rm` ops, and `PUT .../files/<path>/raw` for binary upload. Every structural change invalidates the affected `["ls", orgId, driveId, parent]` listings. No changes under `packages/`.

## Decisions

- New file uses `write` with `expectedVersion: 0` so an existing path fails with a conflict instead of a silent overwrite. (given)
- Before that write the UI runs `stat` on the target and refuses when an object exists. Reason: files uploaded through `PUT /raw` keep their version rows under the `/path` form, so the JSON op alone would see version 0 and overwrite them. After a conflict the UI re-checks `stat`; if the object is absent (only delete-marker rows remain from an earlier `rm`), it writes unconditionally so a deleted path can be created again. (found in review)
- Nested paths such as `sub/dir/name.md` are accepted in the New file dialog. `.` and `..` segments are rejected. (given)
- New folder writes `<folder>/.keep` with empty content through the same create-only path. (given)
- Markdown files get a one-line `# <name>` template so the file is not zero bytes. Other files start empty. (assumed, from the research evaluation)
- After creating a file the UI navigates to `/file/~/:orgId/:driveId/<path>?edit=1`. `FileViewer` reads `edit=1`, enters the existing edit mode, and strips the param. (assumed: cheapest way to reuse the pencil flow without a new store)
- Upload transport is `XMLHttpRequest` so each file shows real progress. `putRaw` in `live/src/api/client.ts` mirrors the CLI: Bearer, `Content-Type: application/octet-stream`, `If-None-Match: *` for create-only, percent-encoded `X-Agent-FS-Message`. (given)
- `putRaw` encodes the whole path with `encodeURIComponent` (slashes become `%2F`), the same shape as the existing `getRawUrl`. Verified against a local daemon: `files/a/b.txt/raw` with literal slashes returns 404, `files/a%2Fb.txt/raw` works. (found during E2E)
- First attempt sends `If-None-Match: *`. On 409 the upload item shows "Already exists" with Replace and Skip. Replace retries unconditionally because the user confirmed the overwrite. (assumed: avoids a stat round-trip per conflict)
- Files over 50 MB are rejected client-side before any request. (given)
- At most 3 uploads run at a time. (given)
- Upload state lives in a small module-level store (same pattern as `stores/toast.ts`), each item carrying the org, drive and client it was dropped into, so navigating inside the app or switching drives does not lose or misroute in-flight uploads. The panel is mounted in `FileBrowserPage` so it stays visible on both folder and file views. (assumed, refined in review)
- The batch summary toast waits until no item is queued, uploading, or parked in a conflict. (found in review)
- `react-dropzone` handles drag-and-drop and folder traversal via `webkitGetAsEntry`. A second hidden `<input webkitdirectory>` covers "Upload folder" from the button. Paste-to-upload is disabled (`noPaste`) so a pasted image while typing a path in a dialog does not start an upload. (given, extended)
- Rename and Delete apply to files only. `mv` and `rm` are single-file ops, and recursive directory operations are out of scope for this one-shot. Directory rows show the items disabled. (assumed)
- Rename dialog edits the full drive-relative path, so it doubles as move. Because `mv` overwrites silently, the dialog runs `stat` on the destination first and refuses an existing path. Only a NOT_FOUND answer counts as free; other errors abort the rename. (assumed, hardened in review)
- Every mutation invalidates the `ls` chain from the drive root down to the immediate parent of each touched path, plus `["stat", ...]` for the path and the drive-root `["recent", ...]` strip. Only mounted queries refetch, so the chain is cheap. (given, extended)
- Dialogs are mounted only while open (both in `FolderView` and `FileTreeNode`), so every opening starts with fresh state and no reset effects are needed. (review)

## Todo

- [x] `pnpm add react-dropzone` inside `live/`
- [x] `live/src/api/types.ts`: `MvResult`, `RmResult`
- [x] `live/src/api/client.ts`: `putRaw` (XHR, progress, abort, conflict detection), `mv`, `rm`, `isConflictError`
- [x] `live/src/lib/paths.ts`: `cleanPath`, `parentOf`, `basenameOf`, `joinPath`, `normalizeRelativePath`, `ancestorListings`
- [x] `live/src/lib/listing-cache.ts`: `invalidateForPath`
- [x] `live/src/hooks/use-file-mutations.ts`: create file, create folder, exists, rename, delete
- [x] `live/src/stores/upload.ts`: queue, concurrency 3, size cap, conflict state, replace or skip, drain summary toast
- [x] `live/src/components/file-mutations/NewEntryDialog.tsx` (file and folder kinds)
- [x] `live/src/components/file-mutations/RenameDialog.tsx`
- [x] `live/src/components/file-mutations/DeleteDialog.tsx`
- [x] `live/src/components/file-mutations/UploadPanel.tsx`
- [x] `live/src/components/folder-view/FolderView.tsx`: header actions, drop zone, hidden inputs, empty-state copy
- [x] `live/src/pages/FileBrowser.tsx`: mount the upload panel over both modes
- [x] `live/src/components/file-tree/FileTreeNode.tsx`: New file, New folder, Rename, Delete in the context menu
- [x] `live/src/components/viewers/FileViewer.tsx`: honor `?edit=1`
- [x] Verification (`pnpm build`) and browser E2E
- [x] Code review (Standards + Spec) and fixes

## Verification

- `cd live && pnpm build` passes.
- Browser E2E: Playwright script at `/tmp/pw/ui-e2e.mjs` (not committed; it borrows `playwright-core` from the qa-use checkout) against an isolated MinIO-backed daemon on port 4898 (`/tmp/agent-fs-ui-e2e-minio-setup.sh`) and `vite` on port 5199. Final run: 39 of 40 checks pass. The one failing check is the deliberate probe of the server path-form finding below. Covered: nested create opens edit mode, create conflict, new folder `.keep`, tree reveal, PUT headers (`octet-stream`, `If-None-Match: *`, Bearer, `%2F` path), picker upload, synthetic drop into a subfolder with overlay, folder upload via `webkitdirectory` keeping structure, conflict prompt surviving navigation to a file, Replace without `If-None-Match` creating v2, concurrency cap of 3 measured on the daemon log, 51 MB rejected without a request, create refused over an uploaded file, rename (prefill, move, source and destination listings, viewer follows), rename onto an existing file refused, rename disabled for folders, delete (listing, delete marker, navigate to parent, tree row gone), re-create after delete, create from the tree context menu.
- Not covered by automation: a real folder drag-and-drop (Playwright cannot build a `DataTransfer` whose items return `webkitGetAsEntry()` entries; the `webkitdirectory` input path exercises the same relative-path handling), and the visual progress bar under a slow network.

## Manual E2E

1. `bun run packages/cli/src/index.ts daemon start` (or an already running local daemon) and `cd live && pnpm dev`.
2. Connect the UI to the local daemon on `/credentials`.
3. Folder view: New file `notes/sub/hello.md`, confirm it opens in edit mode and `agent-fs cat notes/sub/hello.md` prints `# hello`.
4. Folder view: New folder `empty-dir`, confirm `agent-fs ls empty-dir` shows `.keep`.
5. Drag a file and a folder onto the folder view, confirm progress, then `agent-fs ls` shows them. Drop the same file again and confirm the Replace prompt, then `agent-fs log /<path>` shows two versions (note the leading slash, see findings).
6. Tree context menu: Rename `notes/sub/hello.md` to `notes/hello-renamed.md`, confirm `agent-fs ls notes`.
7. Tree context menu: Delete `notes/hello-renamed.md`, confirm `agent-fs ls notes` no longer lists it and `agent-fs log notes/hello-renamed.md` shows the delete entry.
8. Pick a file over 50 MB and confirm the UI rejects it without a request.

## Findings outside this change (server, not fixed here)

- **Path form mismatch between the raw route and the JSON ops route.** `PUT .../files/<path>/raw` runs `normalizePath` and stores version rows under `/drop.txt`; the JSON `write`, `mv`, `rm`, `stat`, `log` ops store and look up the path verbatim (`drop.txt`). After an upload from the UI, `stat drop.txt` reports `author: "unknown"` and `log drop.txt` is empty, while `log /drop.txt` shows the version. The UI's version history and author for uploaded files are therefore empty until the server normalizes both routes the same way (`packages/server/src/routes/files.ts:139` vs `packages/core/src/ops/versioning.ts:166-176`). The same divergence already exists between CLI calls with and without a leading slash (`docs/api-reference.md` uses `/hello.md`, `skills/agent-fs/SKILL.md` uses `docs/readme.txt`). The UI's `stat` pre-check keeps New file from overwriting such uploads, but the underlying split needs a server fix.
- **Nested paths with literal slashes 404 on the raw route.** `PUT .../files/a/b.txt/raw` returns Hono's 404; only `files/a%2Fb.txt/raw` works. The CLI's `putRaw` uses `encodeURI`, which keeps slashes literal, so `agent-fs write sub/file.bin --file ...` may hit the same 404. Not verified for the CLI in this session.
- **Text preview on local-storage daemons.** `useFileContent` fetches the `signed-url` result without an Authorization header. On the local adapter that URL is an authenticated app link and returns 401, so text files show "Content preview not available" and the pencil never appears. Pre-existing; the E2E above therefore ran against MinIO.

## Review notes

Two-axis review (Standards and Spec, both Opus sub-agents) on the staged diff.

Fixed:
- Upload store held one global scope; queued items now carry their own org, drive and client (Standards, Important).
- `exists()` swallowed every error as "path is free"; now only NOT_FOUND counts (Standards, Important).
- New file blocked forever after deleting the same path (delete-marker rows make `expectedVersion: 0` fail); handled by the stat re-check and unconditional retry (Spec, Important).
- New file silently overwrote a file uploaded through the raw route; handled by the stat pre-check (Spec, Important).
- Upload panel lived only in `FolderView`; moved to `FileBrowserPage` so progress and Replace/Skip stay reachable on a file view (Spec, Important).
- Batch summary toast fired while conflicts were still parked (both axes, Minor).
- Dead parameters (`ifMatch`, `expectedVersion` on `mv`/`rm`, `ready`), the duplicated `useMemo` scope helper, hand-rolled slash stripping in `FolderView`, the exported-but-internal `invalidateListings`, the permanently mounted dialog whose title flipped during the close animation, and the progress bar without `role="progressbar"` (Standards, Minor).

Accepted as is:
- Directories cannot be renamed or deleted (single-file `mv`/`rm`; documented above).
- `# <name>` template for new Markdown files (from the research evaluation).
- "Upload folder" button in addition to drag-and-drop (the research listed `webkitdirectory` as the input-side option).
- Paths are not URL-encoded in the edit redirect, matching the existing `selectFile` behavior for names with `#` or `?`.

## Addendum (2026-09-03, follow-up in the same session)

Taras asked for two icon dropdowns instead of four text buttons, tooltips, the same actions outside the folder view, and a look at org switching.

- `live/src/components/file-mutations/FolderActions.tsx`: two icon buttons with tooltips. Plus opens New file / New folder; Upload opens Files / Folder. It owns the hidden pickers and the New dialog and takes a target folder. Used in the `FolderView` header (drop zone stays in `FolderView`) and in the sidebar tab row (`live/src/components/layout/Sidebar.tsx`), where it targets the open folder, or the open file's parent, else the drive root. The folder pane is now a labelled `region` ("Folder <path>") so tests and screen readers can address it.
- **Org switch bug (root cause and fix).** `BrowserRouter` applies navigations inside `React.startTransition`, so a switcher click commits the context update first while the old file route is still mounted. `RouteParamsSync` had `orgId`/`driveId` in its effect deps, so that commit re-ran the URL sync and the stale URL params reverted the switch. The second click worked only because `/files` mounts no `RouteParamsSync`. Fix in `live/src/App.tsx`: the sync effects read the current context through a ref and run only when the URL params change. Companion changes: `OrgSwitcher` navigates to `/orgs/<id>/files/` so the redirect lands on the new org's drive root; `DriveSwitcher` and `DrivePicker` navigate to the picked drive's root so the URL matches the context (the picker used to change context without touching the URL).
- Verification: `pnpm build` passes. E2E extended to 46 checks (dropdown items, tooltip, sidebar New from a file view, one-click org switch landing on `/file/~/<orgB>/<driveB>/`); 45 pass, the one failure remains the server path-form probe.
- Pre-existing and untouched: the design hook flags two side-tab accent borders in `live/src/index.css` (lines 156 and 165). Not part of this change.
