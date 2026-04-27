import { useParams, useNavigate } from "react-router"
import { useCallback, useRef, useEffect } from "react"
import { FileViewer } from "@/components/viewers/FileViewer"
import { VersionHistory } from "@/components/VersionHistory"
import { UserName } from "@/components/UserName"
import { MainWithComments } from "@/components/layout/MainWithComments"
import { useFileStat } from "@/hooks/use-file-stat"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

export function FileDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)

  const filePath = params["*"] ?? ""
  const { data: stat } = useFileStat(filePath || null)

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
    <MainWithComments filePath={filePath} onCommentClick={handleCommentClick} showCommentsHeader>
      <div className="flex h-full flex-col min-w-0">
        {/* Sub-header: filename + meta (toolbar polish in Phase 4) */}
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
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 min-h-0 flex-col">
          <FileViewer
            path={filePath}
            showExpandButton={false}
            showHeader={false}
            className="flex-1 min-h-0"
            onScrollToCommentRef={scrollToCommentRef}
          />
          <VersionHistory path={filePath} />
        </div>
      </div>
    </MainWithComments>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
