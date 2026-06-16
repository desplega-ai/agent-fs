import { useRef, useState, useEffect, useCallback, useMemo, type MutableRefObject } from "react"
import Editor, { useMonaco } from "@monaco-editor/react"
import { MessageSquare, Braces, X, Check, AlertCircle, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { cn } from "@/lib/utils"
import { useTheme } from "@/hooks/use-theme"
import { AddComment } from "@/components/comments/AddComment"
import { Spinner } from "@/components/ui/spinner"
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
  // Edit mode
  editable?: boolean
  isSaving?: boolean
  saveError?: string | null
  onSave?: (content: string) => void
  onCancel?: () => void
}

export function TextViewer({ content, path, truncated, comments, className, onScrollToCommentRef, editable = false, isSaving = false, saveError = null, onSave, onCancel }: TextViewerProps) {
  const { resolvedTheme } = useTheme()
  const monaco = useMonaco()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [selection, setSelection] = useState<{ text: string; lineStart: number; lineEnd: number; rect: DOMRect } | null>(null)
  const [showCommentForm, setShowCommentForm] = useState(false)

  const lang = extToLang(path)
  const isJson = lang === "json"
  const [jsonFormatted, setJsonFormatted] = useState(false)
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "vs"

  const displayContent = useMemo(() => {
    if (!isJson || !jsonFormatted) return content
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }, [content, isJson, jsonFormatted])

  // Edit mode state
  const [editedContent, setEditedContent] = useState(content)
  const isDirty = editable && editedContent !== content

  // Sync editedContent when entering edit mode or content changes externally
  useEffect(() => {
    if (editable) setEditedContent(content)
  }, [editable])

  // Sync editedContent when content prop changes while not editing
  useEffect(() => {
    if (!editable) setEditedContent(content)
  }, [content, editable])

  // beforeunload guard while dirty
  useEffect(() => {
    if (!editable || !isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [editable, isDirty])

  // `e` toggles JSON Format / Raw — the source-view counterpart of the
  // markdown source/preview toggle (a file is either markdown or JSON, never
  // both, so the contexts never overlap).
  useKeyboardShortcuts(isJson ? { e: (e) => { e.preventDefault(); setJsonFormatted((v) => !v) } } : {})

  // Apply comment line decorations
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !comments?.length) return

    const decorations: editor.IModelDeltaDecoration[] = []
    comments.forEach((c) => {
      if (c.lineStart) {
        const endLine = c.lineEnd ?? c.lineStart
        decorations.push({
          range: { startLineNumber: c.lineStart, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: "comment-line-highlight",
            glyphMarginClassName: "comment-glyph-margin",
          },
        })
      }
    })

    const ids = ed.createDecorationsCollection(decorations)
    return () => ids.clear()
  }, [comments, monaco])

  // Line comment via gutter click
  const [lineComment, setLineComment] = useState<{ line: number; rect: DOMRect } | null>(null)

  // Ref for save action (so Cmd+S always calls the latest handler)
  const saveActionRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    saveActionRef.current = editable && onSave ? () => onSave(editedContent) : null
  }, [editable, onSave, editedContent])

  const handleEditorMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor

    // Register Cmd+S for save in edit mode
    editor.addAction({
      id: "agent-fs.save-file",
      label: "Save file",
      keybindings: [monaco?.KeyMod.CtrlCmd !== undefined ? monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS : 2048 | 49],
      run: () => {
        const handler = saveActionRef.current
        if (handler) handler()
      },
    })

    // Expose scroll-to-comment for comment click navigation
    if (onScrollToCommentRef) {
      onScrollToCommentRef.current = ({ lineStart }) => {
        if (!lineStart) return
        editor.revealLineInCenter(lineStart)
        const deco = editor.createDecorationsCollection([{
          range: { startLineNumber: lineStart, startColumn: 1, endLineNumber: lineStart, endColumn: 1 },
          options: { isWholeLine: true, className: "flash-line-highlight" },
        }])
        setTimeout(() => deco.clear(), 1500)
      }
    }

    // Gutter click → line comment
    editor.onMouseDown((e) => {
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

    // Listen for selection changes to enable commenting
    editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection()
      if (!sel || sel.isEmpty()) {
        setSelection(null)
        return
      }

      const text = editor.getModel()?.getValueInRange(sel) ?? ""
      if (!text.trim()) {
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
        rect,
      })
    })
  }, [])

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

  return (
    <div className={cn("relative flex flex-col", className)}>
      {/* Edit mode toolbar */}
      {editable && (
        <div className="flex items-center justify-between border-b border-border bg-accent/30 px-3 py-1.5 shrink-0">
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Circle className="size-2 fill-amber-500 text-amber-500" />
                Unsaved
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {saveError && (
              <span className="flex items-center gap-1 text-xs text-destructive max-w-[200px] truncate">
                <AlertCircle className="size-3 shrink-0" />
                {saveError}
              </span>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                if (isDirty && !window.confirm("Discard unsaved changes?")) return
                onCancel?.()
              }}
              disabled={isSaving}
              className="text-muted-foreground gap-1"
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="default"
              size="xs"
              onClick={() => onSave?.(editedContent)}
              disabled={!isDirty || isSaving}
              className="gap-1"
            >
              {isSaving ? (
                <Spinner className="size-3" />
              ) : (
                <Check className="size-3" />
              )}
              Save
              <Kbd className="ml-0.5">⌘S</Kbd>
            </Button>
          </div>
        </div>
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
          value={editable ? editedContent : displayContent}
          onChange={editable ? (v) => setEditedContent(v ?? "") : undefined}
          theme={monacoTheme}
          onMount={handleEditorMount}
          loading={<div className="flex items-center justify-center h-full"><Spinner />}</div>}
          options={{
            readOnly: !editable,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineHeight: 20,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontLigatures: true,
            glyphMargin: !editable,
            folding: true,
            lineNumbers: "on",
            renderLineHighlight: editable ? "all" : "none",
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: !editable,
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
            padding: { top: 8 },
            domReadOnly: !editable,
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
