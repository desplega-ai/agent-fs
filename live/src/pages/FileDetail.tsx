import { useParams, useNavigate } from "react-router"
import { useCallback, useRef, useEffect, useState } from "react"
import { Copy, Link as LinkIcon, Download, Check } from "lucide-react"
import { FileViewer } from "@/components/viewers/FileViewer"
import { VersionHistory } from "@/components/VersionHistory"
import { UserName } from "@/components/UserName"
import { MainWithComments } from "@/components/layout/MainWithComments"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useFileStat } from "@/hooks/use-file-stat"
import { useAuth } from "@/contexts/auth"
import { downloadFile } from "@/lib/download"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

export function FileDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  const { client, orgId, driveId } = useAuth()
  const [copiedName, setCopiedName] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

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

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(filename)
      setCopiedName(true)
      setTimeout(() => setCopiedName(false), 1500)
    } catch {
      // ignore
    }
  }

  const handleCopyLink = async () => {
    if (!orgId || !driveId) return
    const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath
    const url = `${window.location.origin}/file/~/${orgId}/${driveId}/${cleanPath}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1500)
    } catch {
      // ignore
    }
  }

  const canDownload = !!orgId && !!driveId
  const handleDownload = () => {
    if (!canDownload) return
    void downloadFile(client, orgId!, driveId!, filePath, filename, { newWindow: true })
  }

  return (
    <MainWithComments filePath={filePath} onCommentClick={handleCommentClick} showCommentsHeader>
      <div className="flex h-full flex-col min-w-0">
        {/* Sub-header: filename + meta + toolbar */}
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
          <div className="flex items-center gap-1 px-2 shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleCopyName}
                    className="text-muted-foreground"
                    aria-label="Copy filename"
                  >
                    {copiedName ? <Check /> : <Copy />}
                  </Button>
                }
              />
              <TooltipContent>Copy filename</TooltipContent>
            </Tooltip>
            {orgId && driveId && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={handleCopyLink}
                      className="text-muted-foreground"
                      aria-label="Copy link"
                    >
                      {copiedLink ? <Check /> : <LinkIcon />}
                    </Button>
                  }
                />
                <TooltipContent>Copy link</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleDownload}
                    disabled={!canDownload}
                    className="text-muted-foreground"
                    aria-label="Download"
                  >
                    <Download />
                  </Button>
                }
              />
              <TooltipContent>Download</TooltipContent>
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
