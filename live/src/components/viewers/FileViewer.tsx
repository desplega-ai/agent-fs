import { useState, type MutableRefObject } from "react"
import { Maximize2, MessageSquare, Code, Eye } from "lucide-react"
import { useNavigate } from "react-router"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"
import { useFileContent } from "@/hooks/use-file-content"
import { useFileStat } from "@/hooks/use-file-stat"
import { useComments } from "@/hooks/use-comments"
import { TextViewer } from "./TextViewer"
import { MarkdownViewer } from "./MarkdownViewer"
import { ImageViewer } from "./ImageViewer"
import { PdfViewer } from "./PdfViewer"
import { FallbackViewer } from "./FallbackViewer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"])

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? ""
}

function isImage(path: string): boolean {
  return IMAGE_EXTS.has(getExt(path))
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
  if (["pdf", ...IMAGE_EXTS].includes(ext)) return false
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
}

export function FileViewer({ path, className, showExpandButton = true, showHeader = true, onScrollToCommentRef }: FileViewerProps) {
  const navigate = useNavigate()
  const { data: stat } = useFileStat(path)
  const { data: commentsData } = useComments(path)
  const isImg = isImage(path)
  const isMd = isMarkdown(path)
  const commentCount = commentsData?.comments.length ?? 0
  const [showRaw, setShowRaw] = useState(false)

  const { data: content, isLoading } = useFileContent(
    isImg || isPdf(path) ? null : path
  )

  if (isImg) {
    return (
      <div className={cn("flex flex-col h-full", className)}>
        {showHeader && <ViewerHeader path={path} showExpand={showExpandButton} onExpand={() => navigate(`/files/${path}`)} />}
        <ImageViewer path={path} className="flex-1" />
      </div>
    )
  }

  if (isPdf(path)) {
    return (
      <div className={cn("flex flex-col h-full", className)}>
        {showHeader && <ViewerHeader path={path} showExpand={showExpandButton} onExpand={() => navigate(`/files/${path}`)} />}
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
      <div className={cn("flex flex-col h-full", className)}>
        {showHeader && <ViewerHeader path={path} showExpand={showExpandButton} onExpand={() => navigate(`/files/${path}`)} />}
        <FallbackViewer path={path} className="flex-1" />
      </div>
    )
  }

  // For markdown-like files: show raw/preview toggle in header
  const viewingRaw = isMd ? showRaw : true

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {showHeader && (
        <ViewerHeader
          path={path}
          showExpand={showExpandButton}
          onExpand={() => navigate(`/files/${path}`)}
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
        />
      )}
    </div>
  )
}

function ViewerHeader({ path, showExpand, onExpand, commentCount = 0, isMd, showRaw, onToggleRaw }: {
  path: string
  showExpand: boolean
  onExpand: () => void
  commentCount?: number
  isMd?: boolean
  showRaw?: boolean
  onToggleRaw?: () => void
}) {
  const filename = path.split("/").pop() ?? path

  return (
    <div className="flex h-10 items-center justify-between border-b border-border px-4 shrink-0">
      <span className="text-sm font-medium truncate">{filename}</span>
      <div className="flex items-center gap-1">
        {commentCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground mr-1">
            <MessageSquare className="size-3" />
            {commentCount}
          </span>
        )}
        {isMd && onToggleRaw && (
          <Button variant="ghost" size="icon-xs" onClick={onToggleRaw} title={showRaw ? "Preview" : "Source"} className="text-muted-foreground">
            {showRaw ? <Eye /> : <Code />}
          </Button>
        )}
        {showExpand && (
          <Button variant="ghost" size="icon-xs" onClick={onExpand} title="Open full page" className="text-muted-foreground">
            <Maximize2 />
          </Button>
        )}
      </div>
    </div>
  )
}
