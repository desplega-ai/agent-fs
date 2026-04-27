import { useParams, useNavigate } from "react-router"
import { useState, useCallback, useRef, useEffect } from "react"
import { MessageSquare, X, GripVertical } from "lucide-react"
import { FileViewer } from "@/components/viewers/FileViewer"
import { VersionHistory } from "@/components/VersionHistory"
import { CommentSidebar } from "@/components/comments/CommentSidebar"
import { UserName } from "@/components/UserName"
import { useFileStat } from "@/hooks/use-file-stat"
import { useComments } from "@/hooks/use-comments"
import { useResizable } from "@/hooks/use-resizable"
import { cn } from "@/lib/utils"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

export function FileDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [commentsOpen, setCommentsOpen] = useState(false)
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  const { width: commentsWidth, onMouseDown } = useResizable(320, 200, 600)

  const filePath = params["*"] ?? ""
  const { data: stat } = useFileStat(filePath || null)
  const { data: commentsData } = useComments(filePath || null)
  const commentCount = commentsData?.comments.length ?? 0

  const handleCommentClick = useCallback((lineStart?: number, _lineEnd?: number, quotedContent?: string) => {
    scrollToCommentRef.current?.({ lineStart, quotedContent })
  }, [])

  if (!filePath) {
    navigate("/files", { replace: true })
    return null
  }

  const filename = filePath.split("/").pop() ?? filePath

  useEffect(() => {
    document.title = `${filename} — agent-fs`
    return () => { document.title = "agent-fs" }
  }, [filename])

  return (
    <div className="flex h-full flex-col">
      {/* Sub-header: filename + comments label — shared row (toolbar polish in Phase 4) */}
      <div className="flex border-b border-border">
        <div className="flex-1 min-w-0 px-4 py-2 flex items-center gap-3">
          <span className="text-sm font-medium truncate">{filename}</span>
          {stat && (
            <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              {formatBytes(stat.size)} &middot;{" "}
              <UserName userId={stat.author} className="text-xs text-muted-foreground" />
              {" "}&middot; {new Date(stat.modifiedAt).toLocaleDateString()}
            </span>
          )}
          <div className="flex-1" />
          {/* Comment toggle for smaller screens */}
          <button
            onClick={() => setCommentsOpen(!commentsOpen)}
            className={cn(
              "lg:hidden inline-flex items-center gap-1 rounded-md p-1.5 transition-colors shrink-0",
              commentsOpen
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
            title="Toggle comments"
          >
            <MessageSquare className="h-4 w-4" />
            {commentCount > 0 && (
              <span className="text-xs">{commentCount}</span>
            )}
          </button>
        </div>
        <div className="hidden lg:flex shrink-0 border-l border-border items-center justify-between px-4 py-2" style={{ width: commentsWidth }}>
          <span className="text-sm font-medium">
            Comments
            {commentCount > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">({commentCount})</span>
            )}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="relative flex flex-1 min-h-0">
        {/* Main viewer */}
        <div className="flex-1 flex flex-col min-w-0">
          <FileViewer path={filePath} showExpandButton={false} showHeader={false} className="flex-1 min-h-0" onScrollToCommentRef={scrollToCommentRef} />
          <VersionHistory path={filePath} />
        </div>

        {/* Resize handle — desktop only */}
        <div
          className="hidden lg:flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border hover:bg-primary/30 active:bg-primary/50 transition-colors group"
          onMouseDown={onMouseDown}
        >
          <div className="flex h-8 w-3 items-center justify-center rounded-sm border border-border bg-background opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity">
            <GripVertical className="size-2.5 text-muted-foreground" />
          </div>
        </div>

        {/* Comment sidebar — always visible on lg */}
        <div
          className="hidden lg:flex shrink-0 border-l border-border flex-col min-w-0 overflow-hidden"
          style={{ width: commentsWidth }}
        >
          <CommentSidebar path={filePath} showHeader={false} onCommentClick={handleCommentClick} />
        </div>

        {/* Mobile/tablet comment overlay */}
        {commentsOpen && (
          <>
            <div
              className="lg:hidden fixed inset-0 z-40 bg-black/50"
              onClick={() => setCommentsOpen(false)}
            />
            <div className="lg:hidden fixed inset-y-0 right-0 z-50 w-80 max-w-[85vw] bg-background border-l border-border flex flex-col shadow-xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <span className="text-sm font-medium">
                  Comments
                  {commentCount > 0 && (
                    <span className="ml-1.5 text-xs text-muted-foreground">({commentCount})</span>
                  )}
                </span>
                <button
                  onClick={() => setCommentsOpen(false)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <CommentSidebar path={filePath} showHeader={false} onCommentClick={handleCommentClick} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
