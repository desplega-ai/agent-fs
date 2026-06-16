import React, { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react"
import { Maximize2, MessageSquare, Code, Eye, Copy, Link, Check, Download, Database, Pencil, Columns2, LayoutGrid } from "lucide-react"
import { useNavigate } from "react-router"
import { isQueryablePath } from "@/lib/sql-engine/types"
import { useAuth } from "@/contexts/auth"
import { useKeyboardShortcuts, type ShortcutMap } from "@/hooks/use-keyboard-shortcuts"
import { useFileActions } from "@/hooks/use-file-actions"
import { useFileSave } from "@/hooks/use-file-save"
import { uiChromeStore } from "@/stores/ui-chrome"
import { sidePanelStore } from "@/stores/side-panel"
import { toast } from "@/stores/toast"
import { Kbd } from "@/components/ui/kbd"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"
import type { OutlineItem } from "@/lib/outline"
import { useFileContent } from "@/hooks/use-file-content"
import { useFileStat } from "@/hooks/use-file-stat"
import { useComments } from "@/hooks/use-comments"
import { TextViewer } from "./TextViewer"
import { MarkdownViewer } from "./MarkdownViewer"
import { ImageViewer } from "./ImageViewer"
import { VideoViewer } from "./VideoViewer"
import { PdfViewer } from "./PdfViewer"
import { FallbackViewer } from "./FallbackViewer"
import { TablePreviewViewer } from "./TablePreviewViewer"
import { DatabasePreviewViewer } from "./DatabasePreviewViewer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type MdEditView = "source" | "split" | "preview"
type SplitOrientation = "horizontal" | "vertical"

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"])

// Browser-playable video containers — routed to <video>. Others (mkv, avi…)
// fall through to the fallback viewer rather than rendering garbled bytes.
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v"])

// Known-binary extensions that must never be treated as text, even when the
// stored content-type is the generic `application/octet-stream`.
const BINARY_EXTS = new Set([
  ...VIDEO_EXTS,
  "mkv", "avi", "wmv", "flv",
  "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus",
  "zip", "gz", "tar", "tgz", "bz2", "xz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "wasm", "bin", "exe", "dll", "so", "dylib", "o", "a",
  // Office / binary documents — must never render as text (they're octet-stream
  // and would otherwise dump raw zip/OLE bytes into the text viewer).
  "doc", "docx", "ppt", "pptx", "xls", "odt", "ods", "odp",
])

// Tabular formats previewed as a data grid by default. Binary ones (parquet,
// xlsx) had no preview before; text ones (csv, tsv) get a Table/Source toggle.
// Multi-table formats (sqlite, duckdb) are intentionally excluded — there's no
// single obvious table to show — so they keep the Query-with-SQL entry point.
const TABULAR_BINARY_EXTS = new Set(["parquet", "xlsx"])
const TABULAR_TEXT_EXTS = new Set(["csv", "tsv", "ndjson", "jsonl"])
// Multi-table database files — previewed via the table-switching DB viewer.
const DATABASE_EXTS = new Set(["db", "sqlite", "sqlite3", "duckdb"])

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? ""
}

function isTabularBinary(path: string): boolean {
  return TABULAR_BINARY_EXTS.has(getExt(path))
}

function isTabularText(path: string): boolean {
  return TABULAR_TEXT_EXTS.has(getExt(path))
}

function isDatabaseFile(path: string): boolean {
  return DATABASE_EXTS.has(getExt(path))
}

function isImage(path: string): boolean {
  return IMAGE_EXTS.has(getExt(path))
}

function isVideo(path: string): boolean {
  return VIDEO_EXTS.has(getExt(path))
}

function isMarkdown(path: string): boolean {
  return ["md", "mdx", "txt"].includes(getExt(path))
}

function isPdf(path: string): boolean {
  return getExt(path) === "pdf"
}

const TEXT_EXTS = new Set([
  "txt", "ts", "tsx", "js", "jsx", "json", "jsonl", "ndjson", "md", "mdx", "css", "scss",
  "html", "xml", "yaml", "yml", "toml", "sh", "bash", "py", "rb", "rs",
  "go", "java", "c", "cpp", "h", "hpp", "sql", "graphql", "env", "cfg",
  "ini", "conf", "log", "csv", "tsv", "dockerfile", "makefile", "lock",
])

function isTextFile(path: string, contentType?: string): boolean {
  const ext = getExt(path)
  if (ext === "pdf" || IMAGE_EXTS.has(ext) || BINARY_EXTS.has(ext)) return false
  if (TEXT_EXTS.has(ext)) return true
  if (!contentType || contentType === "application/octet-stream") return true
  return contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("javascript") || contentType.includes("typescript")
}

interface FileViewerProps {
  path: string
  className?: string
  showExpandButton?: boolean
  showHeader?: boolean
  onScrollToCommentRef?: MutableRefObject<ScrollToCommentCallback | null>
  /** Reports the document outline (headings) of a rendered markdown preview. */
  onOutlineChange?: (items: OutlineItem[]) => void
}

export function FileViewer({ path, className, showExpandButton = true, showHeader = true, onScrollToCommentRef, onOutlineChange }: FileViewerProps) {
  const navigate = useNavigate()
  const { orgId, driveId } = useAuth()
  const { data: stat, refetch: refetchStat } = useFileStat(path)
  const { data: commentsData } = useComments(path)
  const isImg = isImage(path)
  const isVid = isVideo(path)
  const isMd = isMarkdown(path)
  const commentCount = commentsData?.comments.length ?? 0
  const [showRaw, setShowRaw] = useState(false)

  // Editing state
  const [isEditing, setIsEditing] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const { save, isSaving, error: saveError, clearError } = useFileSave(path)

  // Markdown split-view state (only in edit mode)
  const [mdEditView, setMdEditView] = useState<MdEditView>("source")
  const [splitOrientation, setSplitOrientation] = useState<SplitOrientation>("horizontal")
  const [liveEditContent, setLiveEditContent] = useState<string>("")

  // Reset editing state on path change — warn if dirty
  useEffect(() => {
    if (isDirty) {
      setIsDirty(false)
    }
    setIsEditing(false)
    setMdEditView("source")
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleEnterEdit = useCallback(() => {
    setIsEditing(true)
    setMdEditView("source")
  }, [])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setIsDirty(false)
    setMdEditView("source")
  }, [])

  const handleSave = useCallback(async (content: string) => {
    try {
      const result = await save(content, stat?.currentVersion)
      toast.success(`Saved (v${result.version})`)
      setIsDirty(false)
      refetchStat()
    } catch {
      // error is already in the hook state
    }
  }, [save, stat?.currentVersion, refetchStat])

  const isTabBin = isTabularBinary(path)
  const isTabTxt = isTabularText(path)
  const isDb = isDatabaseFile(path)

  // Files rendered by querying their data (parquet, xlsx, sqlite/duckdb, and
  // csv/tsv/ndjson in grid mode) need no raw-bytes fetch — the grid data comes
  // from the SQL engine. The raw fetch (presigned URL) is only used for text
  // and the optional "Source" toggle of tabular-text files.
  const { data: content, isLoading } = useFileContent(
    isImg || isVid || isPdf(path) || isTabBin || isDb || (isTabTxt && !showRaw)
      ? null
      : path
  )

  // Outline only exists for a rendered markdown preview. When the viewer shows
  // anything else (source view, image, etc.) clear it so the rail's Outline
  // tab disappears. `MarkdownViewer` reports the real outline when mounted.
  const showingMarkdownPreview = isMd && !showRaw
  useEffect(() => {
    if (!showingMarkdownPreview) onOutlineChange?.([])
  }, [showingMarkdownPreview, path, onOutlineChange])

  // File-scoped shortcuts: only live while a file is open, so they're naturally
  // context-scoped (can't collide with list/folder views). Same actions as the
  // header buttons. The `e` source/preview toggle only exists for markdown
  // (JSON's Format/Raw toggle is handled in TextViewer).
  const fileActions = useFileActions(path)
  const fileShortcuts: ShortcutMap = {
    n: (e) => {
      e.preventDefault()
      uiChromeStore.openComments()
      sidePanelStore.requestAddComment()
    },
    y: (e) => {
      e.preventDefault()
      void fileActions.copyPath()
    },
    "shift+y": (e) => {
      e.preventDefault()
      void fileActions.copyLink()
    },
    d: (e) => {
      e.preventDefault()
      fileActions.download()
    },
  }
  if (isMd || isTabTxt) {
    fileShortcuts.e = (e) => {
      e.preventDefault()
      setShowRaw((v) => !v)
    }
  }
  if (showExpandButton) {
    fileShortcuts.f = (e) => {
      e.preventDefault()
      navigate(`/detail/~/${orgId}/${driveId}/${path}`)
    }
  }

  // Tabular/data files (csv, tsv, parquet, xlsx, json, ndjson, sqlite, duckdb)
  // get a direct entry point into the SQL workbench, pre-bound to this file.
  const onQuery =
    isQueryablePath(path) && orgId && driveId
      ? () => navigate(`/sql/~/${orgId}/${driveId}?path=${encodeURIComponent(path)}`)
      : undefined
  if (onQuery) {
    fileShortcuts.q = (e) => {
      e.preventDefault()
      onQuery()
    }
  }
  useKeyboardShortcuts(fileShortcuts)

  if (isImg) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <ImageViewer path={path} className="flex-1" />
      </div>
    )
  }

  // Binary tabular files (parquet, xlsx): render a data-grid preview by
  // querying the file through the SQL engine. No text content to fetch.
  if (isTabBin) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <TablePreviewViewer path={path} size={stat?.size} className="flex-1 min-h-0" />
      </div>
    )
  }

  // Database files (sqlite, duckdb): list tables and preview the selected one.
  if (isDb) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <DatabasePreviewViewer path={path} size={stat?.size} className="flex-1 min-h-0" />
      </div>
    )
  }

  // Tabular text files (csv, tsv, ndjson): data-grid preview by default (data
  // from the SQL engine, so it works even when the raw-bytes fetch can't), with
  // a Source toggle to the raw text.
  if (isTabTxt) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && (
          <ViewerHeader
            path={path}
            actions={fileActions}
            showExpand={showExpandButton}
            onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)}
            onQuery={onQuery}
            showViewToggle
            showRaw={showRaw}
            onToggleRaw={() => setShowRaw(!showRaw)}
          />
        )}
        {showRaw ? (
          isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : content ? (
            <TextViewer
              content={content.content}
              path={path}
              truncated={content.truncated}
              comments={commentsData?.comments}
              className="flex-1 min-h-0"
              onScrollToCommentRef={onScrollToCommentRef}
            />
          ) : (
            <FallbackViewer path={path} className="flex-1" />
          )
        ) : (
          <TablePreviewViewer path={path} size={stat?.size} className="flex-1 min-h-0" />
        )}
      </div>
    )
  }

  if (isVid) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <VideoViewer path={path} className="flex-1" />
      </div>
    )
  }

  if (isPdf(path)) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <PdfViewer path={path} className="flex-1" />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <Spinner />
      </div>
    )
  }

  if (!content) {
    // Binary/unpreviewable files (parquet, xlsx, sqlite, …) still get a header
    // so their actions — including Query with SQL for tabular data — are reachable.
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <FallbackViewer path={path} className="flex-1" />
      </div>
    )
  }

  const textable = isTextFile(path, stat?.contentType)

  if (!textable) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} onQuery={onQuery} />}
        <FallbackViewer path={path} className="flex-1" />
      </div>
    )
  }

  // For markdown-like files: show raw/preview toggle in header.
  const viewingRaw = isMd ? showRaw : true

  // Determine what to show for markdown in edit mode
  const editingMarkdown = isEditing && isMd

  return (
    <div className={cn("flex flex-col h-full min-w-0", className)}>
      {showHeader && (
        <ViewerHeader
          path={path}
          actions={fileActions}
          showExpand={showExpandButton}
          onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)}
          onQuery={onQuery}
          commentCount={commentCount}
          showViewToggle={isMd && !isEditing}
          showRaw={showRaw}
          onToggleRaw={() => setShowRaw(!showRaw)}
          isEditable={textable}
          isEditing={isEditing}
          onEdit={handleEnterEdit}
          mdEditView={editingMarkdown ? mdEditView : undefined}
          onMdEditViewChange={editingMarkdown ? setMdEditView : undefined}
          splitOrientation={editingMarkdown && mdEditView === "split" ? splitOrientation : undefined}
          onToggleOrientation={editingMarkdown && mdEditView === "split" ? () => setSplitOrientation(o => o === "horizontal" ? "vertical" : "horizontal") : undefined}
        />
      )}
      {isEditing ? (
        editingMarkdown ? (
          <MarkdownEditView
            content={content.content}
            path={path}
            view={mdEditView}
            orientation={splitOrientation}
            onSave={handleSave}
            isSaving={isSaving}
            saveError={saveError}
            onClearError={clearError}
            onCancel={handleCancelEdit}
            onDirtyChange={setIsDirty}
            liveEditContent={liveEditContent}
            onContentChange={setLiveEditContent}
            onOutlineChange={onOutlineChange}
          />
        ) : (
          <TextViewer
            content={content.content}
            path={path}
            truncated={content.truncated}
            className="flex-1 min-h-0"
            editable
            onSave={handleSave}
            isSaving={isSaving}
            saveError={saveError}
            onClearError={clearError}
            onCancel={handleCancelEdit}
            onDirtyChange={setIsDirty}
          />
        )
      ) : viewingRaw ? (
        <TextViewer
          content={content.content}
          path={path}
          truncated={content.truncated}
          comments={commentsData?.comments}
          className="flex-1 min-h-0"
          onScrollToCommentRef={onScrollToCommentRef}
        />
      ) : (
        <MarkdownViewer
          content={content.content}
          path={path}
          comments={commentsData?.comments}
          className="flex-1 min-h-0"
          onScrollToCommentRef={onScrollToCommentRef}
          onOutlineChange={onOutlineChange}
        />
      )}
    </div>
  )
}

/** Markdown split/source/preview editor layout */
function MarkdownEditView({
  content, path, view, orientation, onSave, isSaving, saveError, onClearError, onCancel,
  onDirtyChange, liveEditContent, onContentChange, onOutlineChange,
}: {
  content: string
  path: string
  view: MdEditView
  orientation: SplitOrientation
  onSave: (content: string) => Promise<void>
  isSaving: boolean
  saveError: Error | null
  onClearError: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  liveEditContent: string
  onContentChange: (content: string) => void
  onOutlineChange?: (items: OutlineItem[]) => void
}) {
  // Initialize live content with original
  useEffect(() => {
    onContentChange(content)
  }, [content]) // eslint-disable-line react-hooks/exhaustive-deps

  const editorElement = (
    <TextViewer
      content={content}
      path={path}
      className="flex-1 min-h-0"
      editable
      onSave={onSave}
      isSaving={isSaving}
      saveError={saveError}
      onClearError={onClearError}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
      onContentChange={onContentChange}
    />
  )

  const previewElement = (
    <MarkdownViewer
      content={liveEditContent || content}
      path={path}
      className="flex-1 min-h-0 overflow-auto"
      onOutlineChange={onOutlineChange}
    />
  )

  if (view === "split") {
    return (
      <SplitPane orientation={orientation}>
        {editorElement}
        {previewElement}
      </SplitPane>
    )
  }

  if (view === "preview") {
    return previewElement
  }

  // source-only
  return editorElement
}

/** Lightweight split-pane layout with a draggable resize handle. */
function SplitPane({ children, orientation }: { children: [React.ReactNode, React.ReactNode]; orientation: SplitOrientation }) {
  const [ratio, setRatio] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = orientation === "horizontal" ? "col-resize" : "row-resize"
    document.body.style.userSelect = "none"

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      let pct: number
      if (orientation === "horizontal") {
        pct = ((ev.clientX - rect.left) / rect.width) * 100
      } else {
        pct = ((ev.clientY - rect.top) / rect.height) * 100
      }
      setRatio(Math.min(80, Math.max(20, pct)))
    }

    const onMouseUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }, [orientation])

  const isH = orientation === "horizontal"

  return (
    <div
      ref={containerRef}
      className={cn("flex flex-1 min-h-0", isH ? "flex-row" : "flex-col")}
    >
      <div style={{ [isH ? "width" : "height"]: `${ratio}%` }} className="min-w-0 min-h-0 flex flex-col overflow-hidden">
        {children[0]}
      </div>
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          "shrink-0 bg-border hover:bg-primary/30 transition-colors",
          isH ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        )}
      />
      <div style={{ [isH ? "width" : "height"]: `${100 - ratio}%` }} className="min-w-0 min-h-0 flex flex-col overflow-hidden">
        {children[1]}
      </div>
    </div>
  )
}

function ViewerHeader({ path, actions, showExpand, onExpand, onQuery, commentCount = 0, showViewToggle, showRaw, onToggleRaw, isEditable, isEditing, onEdit, mdEditView, onMdEditViewChange, splitOrientation, onToggleOrientation }: {
  path: string
  actions: ReturnType<typeof useFileActions>
  showExpand: boolean
  onExpand: () => void
  onQuery?: () => void
  commentCount?: number
  showViewToggle?: boolean
  showRaw?: boolean
  onToggleRaw?: () => void
  isEditable?: boolean
  isEditing?: boolean
  onEdit?: () => void
  mdEditView?: MdEditView
  onMdEditViewChange?: (view: MdEditView) => void
  splitOrientation?: SplitOrientation
  onToggleOrientation?: () => void
}) {
  const { copyPath, copyLink, download, copiedPath, copiedLink, canShare } = actions
  const filename = path.split("/").pop() ?? path

  return (
    <div className="flex h-10 items-center justify-between border-b border-border px-4 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate">{filename}</span>
        {commentCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <MessageSquare className="size-3" />
            {commentCount}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Markdown split-view toggle (only in edit mode) */}
        {mdEditView && onMdEditViewChange && (
          <>
            <div className="flex items-center rounded-md border border-border bg-muted/40 p-0.5 gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={mdEditView === "source" ? "secondary" : "ghost"}
                      size="icon-xs"
                      onClick={() => onMdEditViewChange("source")}
                      aria-label="Source only"
                    >
                      <Code className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>Source</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={mdEditView === "split" ? "secondary" : "ghost"}
                      size="icon-xs"
                      onClick={() => onMdEditViewChange("split")}
                      aria-label="Split view"
                    >
                      <Columns2 className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>Split</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={mdEditView === "preview" ? "secondary" : "ghost"}
                      size="icon-xs"
                      onClick={() => onMdEditViewChange("preview")}
                      aria-label="Preview only"
                    >
                      <Eye className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>Preview</TooltipContent>
              </Tooltip>
            </div>
            {splitOrientation && onToggleOrientation && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={onToggleOrientation}
                      className="text-muted-foreground"
                      aria-label="Toggle orientation"
                    >
                      <LayoutGrid className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>{splitOrientation === "horizontal" ? "Stack vertically" : "Side by side"}</TooltipContent>
              </Tooltip>
            )}
            <div className="w-px h-4 bg-border mx-0.5" />
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={copyPath}
                className="text-muted-foreground"
                aria-label="Copy path"
              >
                {copiedPath ? <Check /> : <Copy />}
              </Button>
            }
          />
          <TooltipContent>Copy path <Kbd className="ml-1">Y</Kbd></TooltipContent>
        </Tooltip>
        {canShare && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={copyLink}
                  className="text-muted-foreground"
                  aria-label="Copy link"
                >
                  {copiedLink ? <Check /> : <Link />}
                </Button>
              }
            />
            <TooltipContent>Copy link <Kbd className="ml-1">⇧Y</Kbd></TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={download}
                disabled={!canShare}
                className="text-muted-foreground"
                aria-label="Download"
              >
                <Download />
              </Button>
            }
          />
          <TooltipContent>Download <Kbd className="ml-1">D</Kbd></TooltipContent>
        </Tooltip>
        {showViewToggle && onToggleRaw && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onToggleRaw}
                  className="text-muted-foreground"
                  aria-label={showRaw ? "Preview" : "Source"}
                >
                  {showRaw ? <Eye /> : <Code />}
                </Button>
              }
            />
            <TooltipContent>{showRaw ? "Preview" : "Source"} <Kbd className="ml-1">E</Kbd></TooltipContent>
          </Tooltip>
        )}
        {onQuery && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onQuery}
                  className="text-muted-foreground"
                  aria-label="Query with SQL"
                >
                  <Database />
                </Button>
              }
            />
            <TooltipContent>Query with SQL <Kbd className="ml-1">Q</Kbd></TooltipContent>
          </Tooltip>
        )}
        {isEditable && !isEditing && onEdit && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onEdit}
                  className="text-muted-foreground"
                  aria-label="Edit file"
                >
                  <Pencil className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
        )}
        {showExpand && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onExpand}
                  className="text-muted-foreground"
                  aria-label="Open full page"
                >
                  <Maximize2 />
                </Button>
              }
            />
            <TooltipContent>Open full page <Kbd className="ml-1">F</Kbd></TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
