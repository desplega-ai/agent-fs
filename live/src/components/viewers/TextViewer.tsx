import { useRef, useState, useEffect, useCallback, useMemo, type MutableRefObject } from "react"
import Editor, { useMonaco, type OnMount } from "@monaco-editor/react"
import { MessageSquare, Braces } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { cn } from "@/lib/utils"
import { useTheme } from "@/hooks/use-theme"
import { AddComment } from "@/components/comments/AddComment"
import { EditToolbar } from "./EditToolbar"
import { Spinner } from "@/components/ui/spinner"
import { useCommentAnchors } from "@/hooks/use-comment-anchors"
import { captureQuote, sourceTextSpace, type AnchorResolution } from "@/lib/comment-anchor"
import { commentAnchors, useHoveredComment } from "@/stores/comment-anchors"
import { toast } from "@/stores/toast"
import type { CommentListEntry } from "@/api/types"
import type { editor } from "monaco-editor"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

function extToLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", md: "markdown",
    yml: "yaml", yaml: "yaml", toml: "ini", sh: "shell",
    css: "css", scss: "scss", html: "html", json: "json", sql: "sql",
    xml: "xml", graphql: "graphql", dockerfile: "dockerfile",
    rb: "ruby", java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    swift: "swift", kt: "kotlin", php: "php", r: "r",
    env: "ini", cfg: "ini", ini: "ini", conf: "ini",
    txt: "plaintext", log: "plaintext", csv: "plaintext",
  }
  return map[ext] || "plaintext"
}

interface TextViewerProps {
  content: string
  path: string
  truncated?: boolean
  highlightLines?: number[]
  comments?: CommentListEntry[]
  className?: string
  onScrollToCommentRef?: MutableRefObject<ScrollToCommentCallback | null>
  editable?: boolean
  onSave?: (content: string) => Promise<boolean>
  isSaving?: boolean
  saveError?: Error | null
  onClearError?: () => void
  onCancel?: () => void
  onDirtyChange?: (dirty: boolean) => void
  /** Live content callback for split-view markdown preview */
  onContentChange?: (content: string) => void
}

export function TextViewer({
  content, path, truncated, comments, className, onScrollToCommentRef,
  editable = false, onSave, isSaving = false, saveError, onClearError, onCancel,
  onDirtyChange, onContentChange,
}: TextViewerProps) {
  const { resolvedTheme } = useTheme()
  const monaco = useMonaco()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  // State (not just the ref) so decorations re-apply once the editor mounts,
  // even when the comments were already loaded (e.g. served from cache).
  const [mountedEditor, setMountedEditor] = useState<editor.IStandaloneCodeEditor | null>(null)
  const [selection, setSelection] = useState<{ text: string; lineStart: number; lineEnd: number; start: number; end: number; rect: DOMRect } | null>(null)
  const [showCommentForm, setShowCommentForm] = useState(false)

  const lang = extToLang(path)
  const isJson = lang === "json"
  const [jsonFormatted, setJsonFormatted] = useState(false)
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "vs"

  // Editing state
  const [editContent, setEditContent] = useState(content)
  const isDirty = editable && editContent !== content

  // Reset edit content when original content changes (e.g. after save)
  useEffect(() => {
    setEditContent(content)
  }, [content])

  // Report dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // beforeunload guard while dirty
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [isDirty])

  const displayContent = useMemo(() => {
    if (editable) return editContent
    if (!isJson || !jsonFormatted) return content
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }, [content, isJson, jsonFormatted, editable, editContent])

  // `e` toggles JSON Format / Raw — disabled in edit mode
  useKeyboardShortcuts(isJson && !editable ? { e: (e) => { e.preventDefault(); setJsonFormatted((v) => !v) } } : {})

  // Resolve comment anchors against the text shown (read-only mode only).
  const anchorSpace = useMemo(() => (editable ? null : sourceTextSpace(displayContent)), [editable, displayContent])
  const anchors = useCommentAnchors(path, comments, anchorSpace, displayContent === content)
  const anchorsRef = useRef(anchors)
  useEffect(() => { anchorsRef.current = anchors }, [anchors])
  const hovered = useHoveredComment()

  // Decorate each comment's resolved range: the matched text for quote
  // anchors, whole lines for line anchors. The hovered comment is emphasized.
  useEffect(() => {
    const ed = mountedEditor
    const model = ed?.getModel()
    if (!ed || !model || !anchors.size) return

    const decorations: editor.IModelDeltaDecoration[] = []
    anchors.forEach((r, id) => {
      if (r.start == null || r.end == null) return
      const start = model.getPositionAt(r.start)
      const end = model.getPositionAt(r.end)
      const active = hovered?.id === id
      const moved = r.status === "moved"
      if (r.method === "lines") {
        decorations.push({
          range: { startLineNumber: start.lineNumber, startColumn: 1, endLineNumber: end.lineNumber, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: cn("comment-line-highlight", moved && "comment-anchor-moved", active && "comment-line-active"),
            glyphMarginClassName: "comment-glyph-margin",
          },
        })
      } else {
        decorations.push({
          range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
          options: {
            inlineClassName: cn("comment-range-highlight", moved && "comment-anchor-moved", active && "comment-range-active"),
          },
        })
        decorations.push({
          range: { startLineNumber: start.lineNumber, startColumn: 1, endLineNumber: start.lineNumber, endColumn: 1 },
          options: { glyphMarginClassName: "comment-glyph-margin" },
        })
      }
    })

    const ids = ed.createDecorationsCollection(decorations)
    return () => ids.clear()
  }, [mountedEditor, anchors, hovered, monaco])

  // Line comment via gutter click
  const [lineComment, setLineComment] = useState<{ line: number; rect: DOMRect } | null>(null)

  // Stable ref so Cmd+S always calls the latest save function
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])
  const editContentRef = useRef(editContent)
  useEffect(() => { editContentRef.current = editContent }, [editContent])

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    setMountedEditor(editor)

    // Cmd/Ctrl+S to save in edit mode
    editor.addAction({
      id: "agent-fs.save-file",
      label: "Save file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        if (onSaveRef.current) {
          onSaveRef.current(editContentRef.current)
        }
      },
    })

    // Expose scroll-to-comment for comment click navigation
    if (onScrollToCommentRef) {
      onScrollToCommentRef.current = ({ lineStart, commentId }) => {
        const resolved = commentId ? anchorsRef.current.get(commentId) : undefined
        const model = editor.getModel()
        let startLine = lineStart
        let endLine = lineStart
        if (resolved && model) {
          if (resolved.start == null || resolved.end == null) {
            toast("The text this comment pointed to is no longer in the file")
            return
          }
          startLine = model.getPositionAt(resolved.start).lineNumber
          endLine = model.getPositionAt(resolved.end).lineNumber
        }
        if (!startLine || !endLine) return
        editor.revealLinesInCenter(startLine, endLine)
        const deco = editor.createDecorationsCollection([{
          range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
          options: { isWholeLine: true, className: "flash-line-highlight" },
        }])
        setTimeout(() => deco.clear(), 1500)
      }
    }

    // Hovering a highlighted range pulses its sidebar card.
    editor.onMouseMove((e) => {
      const model = editor.getModel()
      const pos = e.target.position
      if (!model || !pos) return commentAnchors.setHovered(null, "doc")
      const offset = model.getOffsetAt(pos)
      commentAnchors.setHovered(anchorAt(anchorsRef.current, offset), "doc")
    })
    editor.onMouseLeave(() => commentAnchors.setHovered(null, "doc"))

    // Gutter click → line comment (disabled in edit mode)
    editor.onMouseDown((e) => {
      if (editable) return
      if (e.target.type === 2 /* GLYPH_MARGIN */ || e.target.type === 3 /* LINE_NUMBERS */) {
        const line = e.target.position?.lineNumber
        if (!line) return
        const coords = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 })
        const domNode = editor.getDomNode()
        if (!coords || !domNode) return
        const domRect = domNode.getBoundingClientRect()
        setLineComment({
          line,
          rect: new DOMRect(domRect.left + 60, domRect.top + coords.top + coords.height, 0, 0),
        })
        setSelection(null)
      }
    })

    // Listen for selection changes to enable commenting (disabled in edit mode)
    editor.onDidChangeCursorSelection(() => {
      if (editable) return
      const sel = editor.getSelection()
      if (!sel || sel.isEmpty()) {
        setSelection(null)
        return
      }

      const model = editor.getModel()
      const text = model?.getValueInRange(sel) ?? ""
      if (!model || !text.trim()) {
        setSelection(null)
        return
      }

      // Get the DOM position for the floating button
      const endPos = sel.getEndPosition()
      const coords = editor.getScrolledVisiblePosition(endPos)
      const domNode = editor.getDomNode()
      if (!coords || !domNode) return

      const domRect = domNode.getBoundingClientRect()
      const rect = new DOMRect(
        domRect.left + coords.left,
        domRect.top + coords.top + coords.height,
        0,
        0
      )

      setSelection({
        text,
        lineStart: sel.startLineNumber,
        lineEnd: sel.endLineNumber,
        start: model.getOffsetAt(sel.getStartPosition()),
        end: model.getOffsetAt(sel.getEndPosition()),
        rect,
      })
    })
  }, [editable])

  // Esc closes an open comment UI. Capture phase + stopImmediatePropagation so
  // Esc is consumed here and does not reach other document-level handlers.
  useEffect(() => {
    if (!showCommentForm && !selection && !lineComment) return
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopImmediatePropagation()
      setShowCommentForm(false)
      setSelection(null)
      setLineComment(null)
    }
    document.addEventListener("keydown", onKeyDownCapture, true)
    return () => document.removeEventListener("keydown", onKeyDownCapture, true)
  }, [showCommentForm, selection, lineComment])

  const handleEditorChange = useCallback((value: string | undefined) => {
    const v = value ?? ""
    setEditContent(v)
    onContentChange?.(v)
  }, [onContentChange])

  const handleSave = useCallback(() => {
    onSave?.(editContent)
  }, [onSave, editContent])

  const handleCancel = useCallback(() => {
    if (isDirty) {
      if (!window.confirm("Discard unsaved changes?")) return
    }
    setEditContent(content)
    onCancel?.()
  }, [isDirty, content, onCancel])

  return (
    <div className={cn("relative flex flex-col", className)}>
      {editable && (
        <EditToolbar
          isDirty={isDirty}
          isSaving={isSaving}
          saveError={saveError}
          onClearError={onClearError}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}
      {isJson && !editable && (
        <div className="flex items-center justify-end border-b border-border px-2 py-1 shrink-0">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setJsonFormatted(!jsonFormatted)}
            className="text-muted-foreground gap-1"
          >
            <Braces className="size-3" />
            {jsonFormatted ? "Raw" : "Format"}
            <Kbd className="ml-1">E</Kbd>
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <Editor
          language={lang}
          value={displayContent}
          onChange={editable ? handleEditorChange : undefined}
          theme={monacoTheme}
          onMount={handleEditorMount}
          loading={<div className="flex items-center justify-center h-full"><Spinner /></div>}
          options={{
            readOnly: !editable || isSaving,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineHeight: 20,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontLigatures: true,
            glyphMargin: !editable,
            folding: true,
            lineNumbers: "on",
            renderLineHighlight: editable ? "line" : "none",
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: !editable,
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
            padding: { top: 8 },
            domReadOnly: !editable || isSaving,
            wordWrap: "on",
            automaticLayout: true,
          }}
        />
      </div>

      {truncated && (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          File truncated.
        </div>
      )}

      {/* Floating comment button on text selection */}
      {selection && !showCommentForm && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowCommentForm(true)}
          className="fixed z-50 flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg transition-transform hover:scale-105 active:scale-95"
          style={{
            top: selection.rect.top + 4,
            left: selection.rect.left,
          }}
        >
          <MessageSquare className="size-3" />
          Comment
        </button>
      )}

      {/* Inline comment form */}
      {showCommentForm && selection && (
        <div
          className="fixed z-50 w-80 rounded-lg border border-border bg-popover p-3 shadow-lg"
          style={{
            top: selection.rect.top + 8,
            left: Math.max(8, selection.rect.left - 40),
          }}
        >
          <AddComment
            path={path}
            lineStart={selection.lineStart}
            lineEnd={selection.lineEnd}
            quotedContent={selection.text.slice(0, 200)}
            quote={captureQuote(displayContent, selection.start, selection.end)}
            autoFocus
            onDone={() => {
              setShowCommentForm(false)
              setSelection(null)
            }}
          />
          <button
            onClick={() => {
              setShowCommentForm(false)
              setSelection(null)
            }}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Line comment form (from gutter click) */}
      {lineComment && (
        <div
          data-comment-ui
          className="fixed z-50 w-80 rounded-lg border border-border bg-popover p-3 shadow-lg"
          style={{
            top: lineComment.rect.top + 4,
            left: lineComment.rect.left,
          }}
        >
          <p className="text-[11px] text-muted-foreground mb-2 font-medium">
            Comment on line {lineComment.line}
          </p>
          <AddComment
            path={path}
            lineStart={lineComment.line}
            lineEnd={lineComment.line}
            quote={lineQuote(displayContent, lineComment.line)}
            autoFocus
            onDone={() => setLineComment(null)}
            placeholder={`Comment on line ${lineComment.line}...`}
          />
          <button
            onClick={() => setLineComment(null)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/** The smallest resolved comment range containing `offset`. */
function anchorAt(anchors: Map<string, AnchorResolution>, offset: number): string | null {
  let best: string | null = null
  let bestLen = Infinity
  anchors.forEach((r, id) => {
    if (r.start == null || r.end == null || offset < r.start || offset > r.end) return
    if (r.end - r.start < bestLen) { best = id; bestLen = r.end - r.start }
  })
  return best
}

/** Quote anchor for a whole-line (gutter) comment, so it follows the line. */
function lineQuote(text: string, line: number) {
  const offsets = sourceTextSpace(text).lineRangeToOffsets?.(line, line)
  return offsets ? captureQuote(text, offsets[0], offsets[1]) : undefined
}
