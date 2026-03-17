import { useParams, useNavigate } from "react-router"
import { useState, useEffect } from "react"
import { ArrowLeft, MessageSquare, X } from "lucide-react"
import { ThemeToggle } from "@/components/layout/ThemeToggle"
import { HealthIndicator } from "@/components/layout/HealthIndicator"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { FileViewer } from "@/components/viewers/FileViewer"
import { VersionHistory } from "@/components/VersionHistory"
import { CommentSidebar } from "@/components/comments/CommentSidebar"
import { useFileStat } from "@/hooks/use-file-stat"
import { useComments } from "@/hooks/use-comments"
import { useBrowser } from "@/contexts/browser"
import { cn } from "@/lib/utils"

export function FileDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { selectFile } = useBrowser()
  const [commentsOpen, setCommentsOpen] = useState(false)

  const filePath = params["*"] ?? ""
  const { data: stat } = useFileStat(filePath || null)
  const { data: commentsData } = useComments(filePath || null)
  const commentCount = commentsData?.comments.length ?? 0

  useEffect(() => {
    if (filePath) selectFile(filePath)
  }, [filePath, selectFile])

  if (!filePath) {
    navigate("/files", { replace: true })
    return null
  }

  const filename = filePath.split("/").pop() ?? filePath

  return (
    <div className="flex h-screen flex-col">
      {/* Top header */}
      <header className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate("/files")}
            className="inline-flex items-center gap-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <Breadcrumbs />
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {stat && (
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {formatBytes(stat.size)} &middot; {stat.author} &middot;{" "}
              {new Date(stat.modifiedAt).toLocaleDateString()}
            </span>
          )}
          {/* Comment toggle for smaller screens */}
          <button
            onClick={() => setCommentsOpen(!commentsOpen)}
            className={cn(
              "lg:hidden inline-flex items-center gap-1 rounded-md p-1.5 transition-colors",
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
          <HealthIndicator />
          <ThemeToggle />
        </div>
      </header>

      {/* Sub-header: filename + comments label — shared row */}
      <div className="flex border-b border-border">
        <div className="flex-1 min-w-0 px-4 py-2">
          <span className="text-sm font-medium truncate">{filename}</span>
        </div>
        <div className="hidden lg:flex w-80 shrink-0 border-l border-border items-center justify-between px-4 py-2">
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
          <FileViewer path={filePath} showExpandButton={false} showHeader={false} className="flex-1 min-h-0" />
          <VersionHistory path={filePath} />
        </div>

        {/* Comment sidebar — always visible on lg, overlay on smaller */}
        <div className="hidden lg:flex w-80 shrink-0 border-l border-border flex-col">
          <CommentSidebar path={filePath} showHeader={false} />
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
              <CommentSidebar path={filePath} showHeader={false} />
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
