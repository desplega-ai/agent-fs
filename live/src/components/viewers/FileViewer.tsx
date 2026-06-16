import { useState, useEffect, useRef, useCallback, type MutableRefObject } from "react"
import { Maximize2, MessageSquare, Code, Eye, Copy, Link, Check, Download, Database, Pencil, Columns2, LayoutGrid } from "lucide-react"
import { useNavigate } from "react-router"
import { isQueryablePath } from "@/lib/sql-engine/types"
import { useAuth } from "@/contexts/auth"
import { useKeyboardShortcuts, type ShortcutMap } from "@/hooks/use-keyboard-shortcuts"
import { useFileActions } from "@/hooks/use-file-actions"
import { uiChromeStore } from "@/stores/ui-chrome"
import { sidePanelStore } from "@/stores/side-panel"
import { Kbd } from "@/components/ui/kbd"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"
import type { OutlineItem } from "@/lib/outline"
import { useFileContent } from "@/hooks/use-file-content"
import { useFileStat } from "@/hooks/use-file-stat"
import { useComments } from "@/hooks/use-comments"
import { useFileSave } from "@/hooks/use-file-save"
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
  const { data: stat } = useFileStat(path)
  const { data: commentsData } = useComments(path)
  const isImg = isImage(path)
  const isVid = isVideo(path)
  const isMd = isMarkdown(path)
  const commentCount = commentsData?.comments.length ?? 0
  const [showRaw, setShowRaw] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const { save, isSaving, error: saveError } = useFileSave({ path })
  const [saveErrorDismissed, setSaveErrorDismissed] = useState(false)
  const [splitMode, setSplitMode] = useState<"source" | "split" | "preview">("source")
  const [splitOrientation, setSplitOrientation] = useState<"horizontal" | "vertical">("horizontal")
  const [splitPos, setSplitPos] = useState(50)
  const [isDragging, setIsDragging] = useState(false)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [editedContent, setEditedContent] = useState("")

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
  const showingMarkdownPreview = (isMd && !showRaw) || (isEditing && isMd && splitMode !== "source")
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

  const handleEdit = useCallback(() => {
    setIsEditing(true)
    setSaveErrorDismissed(false)
    setEditedContent(content?.content ?? "")
    setSplitMode("source")
  }, [content])

  const handleCancel = useCallback(() => {
    setIsEditing(false)
    setSaveErrorDismissed(false)
    setSplitMode("source")
    setEditedContent("")
  }, [])

  const handleSave = useCallback(async (saveContent: string) => {
    try {
      await save(saveContent)
      setIsEditing(false)
      setSaveErrorDismissed(false)
      setSplitMode("source")
      setEditedContent("")
    } catch {
      // error is captured by useFileSave
    }
  }, [save])

  // Split-view drag resize
  const handleDragStart = useCallback(() => setIsDragging(true), [])
  useEffect(() => {
    if (!isDragging) return
    const container = splitContainerRef.current
    if (!container) return

    const handleMove = (e: MouseEvent | TouchEvent) => {
      const rect = container.getBoundingClientRect()
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY
      const pos = splitOrientation === "horizontal"
        ? ((clientX - rect.left) / rect.width) * 100
        : ((clientY - rect.top) / rect.height) * 100
      setSplitPos(Math.max(20, Math.min(80, pos)))
    }

    const handleUp = () => setIsDragging(false)

    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
    window.addEventListener("touchmove", handleMove, { passive: true })
    window.addEventListener("touchend", handleUp)
    return () => {
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
      window.removeEventListener("touchmove", handleMove)
      window.removeEventListener("touchend", handleUp)
    }
  }, [isDragging, splitOrientation])

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
  // In edit mode, always show the TextViewer (source) since you're editing.
  // For markdown in edit mode, use the split mode to determine what to show.
  const viewingRaw = isEditing && isMd
    ? splitMode !== "preview"
    : (isMd ? showRaw : true)
  const showSplit = isEditing && isMd && splitMode === "split"
  const displayError = saveError && !saveErrorDismissed ? saveError.message : null

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
          isEditing={isEditing}
          onEdit={handleEdit}
          isMarkdown={isMd}
          splitMode={isEditing && isMd ? splitMode : undefined}
          splitOrientation={splitOrientation}
          onSplitModeChange={isEditing && isMd ? setSplitMode : undefined}
          onToggleOrientation={isEditing && isMd ? () => setSplitOrientation((o) => o === "horizontal" ? "vertical" : "horizontal") : undefined}
        />
      )}
      {showSplit ? (
        <div
          ref={splitContainerRef}
          className={cn(
            "flex-1 min-h-0 flex",
            splitOrientation === "vertical" && "flex-col",
            isDragging && "select-none",
          )}
        >
          <div style={{ [splitOrientation === "horizontal" ? "width" : "height"]: `${splitPos}%` }} className="min-h-0 min-w-0 overflow-hidden">
            <TextViewer
              content={content.content}
              path={path}
              truncated={content.truncated}
              comments={commentsData?.comments}
              editable
              isSaving={isSaving}
              saveError={displayError}
              onSave={handleSave}
              onCancel={handleCancel}
              onContentChange={setEditedContent}
            />
          </div>
          <div
            className={cn(
              "shrink-0 bg-border hover:bg-accent-foreground/20 transition-colors relative",
              splitOrientation === "horizontal" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
              isDragging && "bg-accent-foreground/30",
            )}
            onMouseDown={handleDragStart}
            onTouchStart={handleDragStart}
          >
            <div className={cn(
              "absolute inset-0 flex items-center justify-center",
              splitOrientation === "horizontal" ? "flex-col" : "flex-row",
            )}>
              <div className={cn(
                "rounded-full bg-muted-foreground/30",
                splitOrientation === "horizontal" ? "w-0.5 h-4" : "h-0.5 w-4",
              )} />
            </div>
          </div>
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <MarkdownViewer
              content={editedContent || content.content}
              path={path}
              comments={commentsData?.comments}
              onScrollToCommentRef={onScrollToCommentRef}
              onOutlineChange={onOutlineChange}
            />
          </div>
        </div>
      ) : viewingRaw ? (
        <TextViewer
          content={content.content}
          path={path}
          truncated={content.truncated}
          comments={commentsData?.comments}
          className="flex-1 min-h-0"
          onScrollToCommentRef={onScrollToCommentRef}
          editable={isEditing}
          isSaving={isSaving}
          saveError={displayError}
          onSave={handleSave}
          onCancel={handleCancel}
          onContentChange={isEditing && isMd ? setEditedContent : undefined}
        />
      ) : (
        <MarkdownViewer
          content={isEditing && isMd && editedContent ? editedContent : content.content}
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

function ViewerHeader({ path, actions, showExpand, onExpand, onQuery, commentCount = 0, showViewToggle, showRaw, onToggleRaw, isEditing, onEdit, isMarkdown, splitMode, splitOrientation, onSplitModeChange, onToggleOrientation }: {
  path: string
  actions: ReturnType<typeof useFileActions>
  showExpand: boolean
  onExpand: () => void
  onQuery?: () => void
  commentCount?: number
  showViewToggle?: boolean
  showRaw?: boolean
  onToggleRaw?: () => void
  isEditing?: boolean
  onEdit?: () => void
  isMarkdown?: boolean
  splitMode?: "source" | "split" | "preview"
  splitOrientation?: "horizontal" | "vertical"
  onSplitModeChange?: (mode: "source" | "split" | "preview") => void
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
        {onEdit && !isEditing && (
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
                  <Pencil />
                </Button>
              }
            />
            <TooltipContent>Edit file</TooltipContent>
          </Tooltip>
        )}
        {isEditing && isMarkdown && onSplitModeChange && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={splitMode === "source" ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={() => onSplitModeChange("source")}
                    className={splitMode !== "source" ? "text-muted-foreground" : ""}
                    aria-label="Source view"
                  >
                    <Code />
                  </Button>
                }
              />
              <TooltipContent>Source only</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={splitMode === "split" ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={() => onSplitModeChange("split")}
                    className={splitMode !== "split" ? "text-muted-foreground" : ""}
                    aria-label="Split view"
                  >
                    <Columns2 />
                  </Button>
                }
              />
              <TooltipContent>Split view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={splitMode === "preview" ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={() => onSplitModeChange("preview")}
                    className={splitMode !== "preview" ? "text-muted-foreground" : ""}
                    aria-label="Preview view"
                  >
                    <Eye />
                  </Button>
                }
              />
              <TooltipContent>Preview only</TooltipContent>
            </Tooltip>
            {splitMode === "split" && onToggleOrientation && (
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
                      <LayoutGrid />
                    </Button>
                  }
                />
                <TooltipContent>
                  {splitOrientation === "horizontal" ? "Stack vertically" : "Stack horizontally"}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
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
