import { useParams, useNavigate } from "react-router"
import { useCallback, useRef, useEffect, useState } from "react"
import { Copy, Link as LinkIcon, Download, Check, Database } from "lucide-react"
import { FileViewer } from "@/components/viewers/FileViewer"
import { VersionHistory } from "@/components/VersionHistory"
import { UserName } from "@/components/UserName"
import { MainWithComments } from "@/components/layout/MainWithComments"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAuth } from "@/contexts/auth"
import { useFileStat } from "@/hooks/use-file-stat"
import { useFileActions } from "@/hooks/use-file-actions"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { isQueryablePath } from "@/lib/sql-engine/types"
import { uiChromeStore } from "@/stores/ui-chrome"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"
import type { OutlineItem } from "@/lib/outline"

export function FileDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { orgId, driveId } = useAuth()
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  const [outline, setOutline] = useState<OutlineItem[]>([])

  const filePath = params["*"] ?? ""
  const { data: stat } = useFileStat(filePath || null)
  const { copyPath, copyLink, download, copiedPath, copiedLink, canShare } = useFileActions(filePath)

  // Tab title reflects the open file (single-sourced via the shared hook).
  useDocumentTitle(filePath ? (filePath.split("/").pop() ?? filePath) : null)

  // Reset the outline when the file changes; MarkdownViewer repopulates it.
  useEffect(() => setOutline([]), [filePath])

  // Detail view is reading-first: auto-collapse the file tree on mount so the
  // user gets the full reading width. Collapse runs in a microtask so the Shell
  // registers its setLeftOpen handler first. (Kept above the early return so
  // hook order stays stable.)
  useEffect(() => {
    queueMicrotask(() => uiChromeStore.setLeft(false))
  }, [])

  const handleCommentClick = useCallback((lineStart?: number, _lineEnd?: number, quotedContent?: string) => {
    scrollToCommentRef.current?.({ lineStart, quotedContent })
  }, [])

  if (!filePath) {
    navigate("/files", { replace: true })
    return null
  }

  const filename = filePath.split("/").pop() ?? filePath

  return (
    <MainWithComments filePath={filePath} onCommentClick={handleCommentClick} showCommentsHeader outline={outline}>
      <div className="flex h-full flex-col min-w-0">
        {/* Sub-header: filename + meta + toolbar (fixed h-10 to align its
            bottom border with the comments rail header). */}
        <div className="flex h-10 items-center border-b border-border shrink-0">
          <div className="flex-1 min-w-0 px-4 flex items-center gap-3">
            <span className="text-sm font-medium truncate">{filename}</span>
            {stat && (
              <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                {formatBytes(stat.size)} &middot;{" "}
                <UserName userId={stat.author} className="text-xs text-muted-foreground" />
                {" "}&middot; {new Date(stat.modifiedAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 px-2 shrink-0">
            {isQueryablePath(filePath) && orgId && driveId && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() =>
                        navigate(`/sql/~/${orgId}/${driveId}?path=${encodeURIComponent(filePath)}`)
                      }
                      className="text-muted-foreground"
                      aria-label="Query with SQL"
                    >
                      <Database />
                    </Button>
                  }
                />
                <TooltipContent>Query with SQL</TooltipContent>
              </Tooltip>
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
                      {copiedLink ? <Check /> : <LinkIcon />}
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
            onOutlineChange={setOutline}
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
