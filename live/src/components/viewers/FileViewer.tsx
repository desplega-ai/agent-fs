import { Maximize2, Loader2, MessageSquare } from "lucide-react"
import { useNavigate } from "react-router"
import { useFileContent } from "@/hooks/use-file-content"
import { useFileStat } from "@/hooks/use-file-stat"
import { useComments } from "@/hooks/use-comments"
import { TextViewer } from "./TextViewer"
import { MarkdownViewer } from "./MarkdownViewer"
import { ImageViewer } from "./ImageViewer"
import { PdfViewer } from "./PdfViewer"
import { FallbackViewer } from "./FallbackViewer"
import { cn } from "@/lib/utils"

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"])

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? ""
}

function isImage(path: string): boolean {
  return IMAGE_EXTS.has(getExt(path))
}

function isMarkdown(path: string): boolean {
  return ["md", "mdx"].includes(getExt(path))
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
  // Binary formats that should never be treated as text
  if (["pdf", ...IMAGE_EXTS].includes(ext)) return false
  // Check extension first — S3 often returns application/octet-stream
  if (TEXT_EXTS.has(ext)) return true
  if (!contentType || contentType === "application/octet-stream") return true
  return contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("javascript") || contentType.includes("typescript")
}

interface FileViewerProps {
  path: string
  className?: string
  showExpandButton?: boolean
  showHeader?: boolean
}

export function FileViewer({ path, className, showExpandButton = true, showHeader = true }: FileViewerProps) {
  const navigate = useNavigate()
  const { data: stat } = useFileStat(path)
  const { data: commentsData } = useComments(path)
  const isImg = isImage(path)
  const isMd = isMarkdown(path)
  const commentCount = commentsData?.comments.length ?? 0

  // Only fetch content for text files
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
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {showHeader && <ViewerHeader path={path} showExpand={showExpandButton} onExpand={() => navigate(`/files/${path}`)} commentCount={commentCount} />}
      {isMd ? (
        <MarkdownViewer content={content.content} path={path} className="flex-1 min-h-0" />
      ) : (
        <TextViewer
          content={content.content}
          path={path}
          truncated={content.truncated}
          comments={commentsData?.comments}
          className="flex-1 min-h-0 py-2"
        />
      )}
    </div>
  )
}

function ViewerHeader({ path, showExpand, onExpand, commentCount = 0 }: { path: string; showExpand: boolean; onExpand: () => void; commentCount?: number }) {
  const filename = path.split("/").pop() ?? path

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <span className="text-sm font-medium truncate">{filename}</span>
      <div className="flex items-center gap-1">
        {commentCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MessageSquare className="h-3 w-3" />
            {commentCount}
          </span>
        )}
        {showExpand && (
          <button
            onClick={onExpand}
            className="inline-flex items-center gap-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            title="Open full page"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
