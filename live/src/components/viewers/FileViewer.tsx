import { useState, useEffect, type MutableRefObject } from "react"
import { Maximize2, MessageSquare, Code, Eye, Copy, Link, Check, Download } from "lucide-react"
import { useNavigate } from "react-router"
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
import { TextViewer } from "./TextViewer"
import { MarkdownViewer } from "./MarkdownViewer"
import { ImageViewer } from "./ImageViewer"
import { VideoViewer } from "./VideoViewer"
import { PdfViewer } from "./PdfViewer"
import { FallbackViewer } from "./FallbackViewer"
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
])

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? ""
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
  "txt", "ts", "tsx", "js", "jsx", "json", "md", "mdx", "css", "scss",
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

  const { data: content, isLoading } = useFileContent(
    isImg || isVid || isPdf(path) ? null : path
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
  if (isMd) {
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
  useKeyboardShortcuts(fileShortcuts)

  if (isImg) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} />}
        <ImageViewer path={path} className="flex-1" />
      </div>
    )
  }

  if (isVid) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} />}
        <VideoViewer path={path} className="flex-1" />
      </div>
    )
  }

  if (isPdf(path)) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} />}
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
    return <FallbackViewer path={path} className={className} />
  }

  const textable = isTextFile(path, stat?.contentType)

  if (!textable) {
    return (
      <div className={cn("flex flex-col h-full min-w-0", className)}>
        {showHeader && <ViewerHeader path={path} actions={fileActions} showExpand={showExpandButton} onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)} />}
        <FallbackViewer path={path} className="flex-1" />
      </div>
    )
  }

  // For markdown-like files: show raw/preview toggle in header
  const viewingRaw = isMd ? showRaw : true

  return (
    <div className={cn("flex flex-col h-full min-w-0", className)}>
      {showHeader && (
        <ViewerHeader
          path={path}
          actions={fileActions}
          showExpand={showExpandButton}
          onExpand={() => navigate(`/detail/~/${orgId}/${driveId}/${path}`)}
          commentCount={commentCount}
          isMd={isMd}
          showRaw={showRaw}
          onToggleRaw={() => setShowRaw(!showRaw)}
        />
      )}
      {viewingRaw ? (
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

function ViewerHeader({ path, actions, showExpand, onExpand, commentCount = 0, isMd, showRaw, onToggleRaw }: {
  path: string
  actions: ReturnType<typeof useFileActions>
  showExpand: boolean
  onExpand: () => void
  commentCount?: number
  isMd?: boolean
  showRaw?: boolean
  onToggleRaw?: () => void
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
        {isMd && onToggleRaw && (
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
