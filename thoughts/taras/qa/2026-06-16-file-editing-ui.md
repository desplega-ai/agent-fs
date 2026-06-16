---
date: 2026-06-16
author: Claude
topic: "File editing in live/ web UI"
tags: [qa, file-editor, markdown, split-view]
status: in-progress
source_plan: thoughts/taras/plans/2026-06-16-file-editing-ui.md
environment: local
last_updated: 2026-06-16
last_updated_by: Claude
---

# File Editing UI — QA Report

## Context

Validating the in-browser file editing feature: editable Monaco text viewer, save/cancel flow, dirty tracking, and split-view markdown editing.

## Scope

### In Scope
- Edit button presence for text files
- Monaco becoming writable in edit mode
- Save/Cancel flow with dirty confirmation
- `Cmd+S` save shortcut
- `beforeunload` guard when dirty
- Dirty indicator
- Split-view (source/split/preview) for markdown files
- Orientation toggle and resize handle for split view
- Live preview updates

### Out of Scope
- Binary files (images, PDFs) — edit button should not appear
- Rename/move/delete/copy
- Collaborative editing
- Version history UI

## Test Cases

### TC-1: Edit button appears for text files
**Steps:**
1. Open any text file (.ts, .md, .py, etc.) in the browser
2. Look at the viewer header toolbar

**Expected Result:** A pencil (Edit) icon button is visible in the header toolbar
**Actual Result:**
**Status:**

### TC-2: Clicking Edit makes Monaco writable
**Steps:**
1. Open a text file
2. Click the Edit button
3. Try typing in the editor

**Expected Result:** Monaco editor becomes writable — cursor appears, text can be typed/deleted
**Actual Result:**
**Status:**

### TC-3: Save/Cancel bar appears in edit mode
**Steps:**
1. Click Edit on a text file
2. Observe the toolbar between the file header and the editor

**Expected Result:** A bar with Cancel and Save buttons appears, plus a "⌘S" hint on the Save button
**Actual Result:**
**Status:**

### TC-4: Dirty indicator shows unsaved changes
**Steps:**
1. Enter edit mode
2. Make a change to the content
3. Observe the edit toolbar

**Expected Result:** A small "Unsaved" badge with an amber dot appears in the toolbar
**Actual Result:**
**Status:**

### TC-5: Cmd+S triggers save
**Steps:**
1. Enter edit mode on a text file
2. Make a change
3. Press Cmd+S (or Ctrl+S on Linux/Windows)

**Expected Result:** The save flow triggers — the file is saved via the API
**Actual Result:**
**Status:**

### TC-6: Cancel reverts content and exits edit mode
**Steps:**
1. Enter edit mode and make changes
2. Click Cancel
3. Confirm "Discard unsaved changes?" if prompted

**Expected Result:** Content reverts to original, edit mode exits, Monaco returns to read-only
**Actual Result:**
**Status:**

### TC-7: Navigating away while dirty shows confirmation
**Steps:**
1. Enter edit mode and make changes
2. Try to close the tab or navigate away

**Expected Result:** Browser shows a "Leave site? Changes you made may not be saved." confirmation dialog
**Actual Result:**
**Status:**

### TC-8: Edit button hidden during edit mode
**Steps:**
1. Enter edit mode on a text file
2. Look at the header toolbar

**Expected Result:** The Edit button is hidden while in edit mode (Save/Cancel replaces it)
**Actual Result:**
**Status:**

### TC-9: Split-view toggle appears for markdown files in edit mode
**Steps:**
1. Open a .md file
2. Click Edit
3. Observe the header toolbar

**Expected Result:** Three toggle buttons appear: Source (Code icon), Split (Columns icon), Preview (Eye icon)
**Actual Result:**
**Status:**

### TC-10: Split-view not offered for non-markdown text files
**Steps:**
1. Open a .ts file
2. Click Edit

**Expected Result:** Only the standard Save/Cancel bar appears — no Source/Split/Preview toggle
**Actual Result:**
**Status:**

### TC-11: Side-by-side split view works
**Steps:**
1. Open a .md file and enter edit mode
2. Click the Split button (columns icon)
3. Edit the markdown content

**Expected Result:** Monaco (left) and rendered preview (right) appear side by side. Preview updates live as you type.
**Actual Result:**
**Status:**

### TC-12: Orientation toggle changes layout
**Steps:**
1. Open a .md file → Edit → Split view
2. Click the Layout Grid button (orientation toggle)

**Expected Result:** Layout switches from side-by-side (horizontal) to stacked (top/bottom). Toggle again to go back.
**Actual Result:**
**Status:**

### TC-13: Resize handle works in split view
**Steps:**
1. Open a .md file → Edit → Split view
2. Drag the resize divider between the two panes

**Expected Result:** The divider moves, resizing the panes proportionally (min ~20%, max ~80%)
**Actual Result:**
**Status:**

### TC-14: Preview-only mode works in edit
**Steps:**
1. Open a .md file → Edit → Split view
2. Click the Preview (Eye) button

**Expected Result:** Only the rendered preview is shown (editor hidden). Content reflects latest edits.
**Actual Result:**
**Status:**

### TC-15: Edit button does NOT appear for binary files
**Steps:**
1. Open a PDF, image, or video file

**Expected Result:** No Edit button in the header toolbar
**Actual Result:**
**Status:**

## Edge Cases & Exploratory Testing
- [To be filled]

## Evidence
[To be filled]

## Issues Found
[To be filled]

## Verdict
**Status**: IN PROGRESS
**Summary**: QA in progress — test cases pending manual execution
