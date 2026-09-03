---
date: 2026-09-03T17:00:00Z
topic: "live/ UI: opt-in rich markdown editing mode (MDXEditor)"
status: done
---

# live/ UI: opt-in rich markdown editing mode (MDXEditor)

Source research: `thoughts/taras/research/2026-09-03-ui-file-create-upload-rich-editor.md` (its "Decisions" section is binding). Phase 1 (create, upload, rename, delete) is already on `main`.

## Goal

Markdown files in the hosted UI get a fourth edit mode, "rich", next to source / split / preview. The pencil button stays the single entry point into editing. Rich mode renders `@mdxeditor/editor`, lazy-loaded so viewers that never use it pay nothing. The chosen mode is remembered per user in localStorage, and Monaco source stays the default. Saves go through the existing `handleSave` and `useFileSave` path, skip the write when nothing changed, and warn once when MDXEditor reformats an agent-written file. MDXEditor's colors follow the app's dark and light themes. No changes under `packages/`.

## Decisions

- Rich editor is MDXEditor 4.2.3 (`@mdxeditor/editor`), installed with `pnpm add` inside `live/`. (given)
- Rich mode is a fourth `MdEditView` value inside `MarkdownEditView`, reached through the existing pencil button. Monaco source stays the default. (given)
- Rich mode is offered for `.md` only. `.mdx` needs MDXEditor's JSX plugin and `.txt` is not markdown; both keep the three Monaco layouts. (assumed, from the research decision "for `.md` files")
- The remembered choice lives under the localStorage key `liveui:md-edit-view` via the existing `useLocalStorage` hook and holds `"source"` or `"rich"`. Picking split or preview counts as `"source"`: those are layouts of the Monaco editor, and the decision only asks to remember the rich opt-in. The preference is only written while editing a `.md` file, so switching layouts on a `.txt` does not clear it. (assumed, guard from review)
- `RichMarkdownEditor` is a separate file loaded with `React.lazy` and wrapped in `Suspense`. MDXEditor's `style.css` is imported inside that file so it ships with the lazy chunk. (given)
- Plugins: headings, lists, quote, thematic break, links + link dialog, images, tables, code blocks (CodeMirror with a catch-all descriptor so fences in unknown languages such as `mermaid` open in CodeMirror instead of failing the import), frontmatter, markdown shortcuts, diff-source, toolbar. (given, catch-all assumed)
- `toMarkdownOptions` is `{ bullet: "-", rule: "-" }`. mdast defaults are `*` bullets and `***` rules, which would rewrite every agent-written list on the first rich-mode save. Table columns are still padded by MDXEditor's GFM table serializer; that cannot be configured from the outside. (found during E2E)
- MDXEditor trims the markdown it imports and exports. The wrapper re-appends the trailing newline when the original had one so a no-op save stays byte-equal. Leading blank lines or extra trailing newlines are dropped silently by MDXEditor (no change event), so the wrapper checks for them once at mount and warns. (found in source, second part from review)
- The in-editor diff view compares against the file as last written: the diff base is state, updated after each successful save, and MDXEditor re-reads plugin params on every render. (review)
- Parse failure on the initial import: `onError` shows an error toast and the parent switches the layout back to Monaco source. Parse failures after the editor loaded (for example broken markdown typed in MDXEditor's own source mode) only toast, and MDXEditor's diff-source plugin shows its built-in error with the source toggle so the user's edits are not lost. "Loaded" is set by any change event, not only the normalization event, because a file that round-trips byte-identically never emits the normalization event. Both paths are deferred with `setTimeout` because MDXEditor reports the error while building its editor state inside a React render. (given, split assumed, loaded rule from review)
- Save: Cmd/Ctrl+S inside the rich editor and the Save button call the same `onSave` as Monaco. The wrapper skips the write with a "No changes to save" toast when the file is not dirty or when the serialized markdown equals the original. `FileViewer.handleSave` now resolves to a boolean so the wrapper can reset its baseline only after a successful write. (given)
- Dirty means "differs from what the editor held after its normalization pass", not "differs from disk". A reformatted file therefore does not open as Unsaved; the one-time warning toast covers the reformat. (assumed)
- Reformat warning: when `onChange` reports `initialMarkdownNormalize === true` and the text differs from disk, one default-variant toast per opened file. (given)
- Switching layouts in the header while dirty asks "Discard unsaved changes?" first and clears the live preview text. Every layout mounts its own editor instance, so edits never carried over; this was silent before and rich mode makes the switch more likely. (assumed, preview reset from review)
- Theming: MDXEditor's Radix-scale variables are remapped to the app's oklch tokens in `live/src/index.css` under `.mdxeditor.mdx-rich-editor` and `.mdxeditor-popup-container.mdx-rich-editor`. Two classes are needed because MDXEditor's own root rule has the same single-class specificity and its stylesheet loads later. The app tokens already flip under `.dark`, so one block covers both themes. (given, specificity found during E2E)
- CodeMirror inside MDXEditor ships only a light theme. `cm6-theme-basic-dark` (0.2.0, MIT, same family as the bundled light theme) is passed as a CodeMirror extension when the app theme is dark. One extra dependency; without it code blocks and the in-editor source mode stay white on the dark theme. (assumed)
- The Save/Cancel bar was extracted from `TextViewer` into `EditToolbar.tsx` and shared by both editors instead of duplicating it. (assumed)
- After a successful save `FileViewer` updates the cached file text (`useFileContent.setContent`, guarded by path) so Cancel and the preview show the saved content without a reload. Taras reported the stale preview during this session; it applied to Monaco saves too. (asked)

## Todo

- [x] `pnpm add @mdxeditor/editor` (and `cm6-theme-basic-dark`) inside `live/`
- [x] `live/src/components/viewers/EditToolbar.tsx`: shared Save/Cancel bar; `TextViewer` uses it
- [x] `live/src/components/viewers/RichMarkdownEditor.tsx`: MDXEditor wrapper with plugins, toolbar, Cmd+S, no-op save skip, reformat warning, `onError` → toast + fallback
- [x] `live/src/components/viewers/FileViewer.tsx`: `rich` mode, localStorage-remembered default, header toggle button, `React.lazy` + `Suspense`, dirty guard on layout switch, `handleSave` returns success and refreshes cached content
- [x] `live/src/hooks/use-file-content.ts`: `setContent`
- [x] `live/src/index.css`: `.mdx-rich-editor` variables and layout rules
- [x] Verification and manual E2E (below)
- [x] Code review (Standards + Spec) and fixes

## Verification

- `cd live && pnpm build` passes (`tsc -b` + `vite build`). Lazy chunk: `RichMarkdownEditor-*.js` 816.88 kB minified, 261.55 kB gzip; `RichMarkdownEditor-*.css` 46.23 kB, 8.11 kB gzip. The main `index-*.js` chunk stays at 350 kB gzip and contains no Lexical code.

## Manual E2E (done 2026-09-03 against a throwaway MinIO daemon)

Setup: `/tmp/agent-fs-ui-e2e-minio-setup.sh` (MinIO in Docker + isolated `AGENT_FS_HOME` on port 4898), `pnpm exec vite --port 5199` in `live/`, fixtures written with the CLI: `rich-e2e/notes.md` (frontmatter, task list, table, ```mermaid fence, bare fence), `rich-e2e/broken2.md` (unclosed `<Unclosed>` tag), `rich-e2e/clean.md` (round-trips byte-identically), `rich-e2e/plain.txt`. Browser script: `/tmp/rich-e2e/run.mjs` (Playwright via qa-use's playwright-core), 39 checks:

1. Pencil opens Monaco source; the rich toggle is offered for `.md` and not for `.txt`.
2. Rich mode mounts the lazy chunk; frontmatter is reachable through the toolbar dialog (title, tags, status) and closing it changes nothing; both fences open in CodeMirror; the table and task-list checkboxes render.
3. Dark and light (theme set through localStorage + reload): editor background, body text and code-block background follow the theme (screenshots `/tmp/rich-e2e/{dark,light}.png`).
4. Typing marks Unsaved; Cmd+S saves ("Saved (vN)"); Unsaved clears; a second Cmd+S shows "No changes to save" and the Save button is disabled.
5. Cancel shows the saved edit in the preview without a reload.
6. Switching to source while dirty asks to confirm; dismiss keeps the rich editor, accept switches to Monaco; preference persists across reloads in both directions.
7. `broken2.md`: toast "Rich editor cannot parse this file", Monaco shown.
8. `clean.md`: no reformat toast. Breaking the markdown in MDXEditor's own source view and toggling back: toast, editor stays mounted with MDXEditor's "fix the errors in source mode" hint, the source edits survive, nothing written.
9. CLI after the run: `agent-fs cat` shows the edit with frontmatter (lines 1-5) and both fences intact; the only other change is MDXEditor's table column padding (the reformat toast fired). `agent-fs log rich-e2e/notes.md` shows one new version per real save and none for the no-op or the failed re-import.

Observed, not caused by this change:

- The CLI writes version rows under `/rich-e2e/notes.md` while the UI's JSON `write` uses `rich-e2e/notes.md`; `agent-fs log` shows two separate histories for the same object, and the write op's dedup check compares against the latest version of its own path form, so a UI save whose content equals an older UI version is treated as a no-op even after the CLI changed the object. Pre-existing path normalization quirk in core (also noted in the 2026-09-03 file-mutations plan).
- `@monaco-editor/react` logs an unhandled "operation is manually canceled" rejection when the Monaco editor unmounts before its loader finishes (pencil → rich within a second). Pre-existing.
- MDXEditor's frontmatter dialog (reachable through the toolbar this change adds) is a flat key/value form; a YAML array such as `tags: [research, e2e]` displays as `research,e2e` and would be saved as a string if the dialog's own Save is used. Viewing and closing the dialog changes nothing.
- The Monaco theme in `TextViewer` and the CodeMirror theme here are read from `useTheme()` at render time; a theme toggle while an editor is open updates CSS colors immediately but the CodeMirror/Monaco palette only on the next mount. Pre-existing behavior for Monaco.

## Review notes

Code review ran on the uncommitted diff (Standards: Sonnet, Spec: Opus). Fixed: `loadedRef` only set on the normalization event (Spec, Important); diff base frozen at mount (Standards + Spec); stale `liveEditContent` after a discard (Standards + Spec); preference written for non-`.md` files (Spec, Minor); whitespace-only reformat without a warning (Spec, Minor); `TextViewer.onSave` typed `Promise<unknown>` (Standards); `setContent` not guarded by path (Standards, Minor). The E2E gained the clean-file and late-parse-error cases the Spec review asked for.

Left as is: repeated parse attempts each toast (one per user action, acceptable); the deferred `setTimeout` in `handleError` is not cleared on unmount (idempotent targets).
