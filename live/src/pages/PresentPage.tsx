import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowLeft } from "lucide-react"
import { HtmlViewer } from "@/components/viewers/HtmlViewer"
import { MarkdownViewer } from "@/components/viewers/MarkdownViewer"
import { MainWithComments } from "@/components/layout/MainWithComments"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/contexts/auth"
import { useComments } from "@/hooks/use-comments"
import { useFileContent } from "@/hooks/use-file-content"
import { useHealth } from "@/hooks/use-health"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { isHtmlPath } from "@/lib/html-view"
import { canPresent, exitFullscreen } from "@/lib/present"
import { sidePanelStore } from "@/stores/side-panel"
import { uiChromeStore } from "@/stores/ui-chrome"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"
import type { OutlineItem } from "@/lib/outline"

export function PresentPage() {
  const params = useParams()
  const { orgId, driveId } = useAuth()
  const { data: health, isLoading: healthLoading } = useHealth()

  const filePath = params["*"] ?? ""
  const presentable = !healthLoading && canPresent(filePath, health)
  const isHtml = presentable && isHtmlPath(filePath)
  // Per segment, so a `#` or `?` in a name stays part of the path.
  const fileUrl = `/file/~/${params.orgId}/${params.driveId}/${filePath.split("/").map(encodeURIComponent).join("/")}`
  useDocumentTitle(filePath.split("/").pop() || null)
  // Present took the browser full screen; leaving the page gives it back.
  useEffect(() => exitFullscreen, [])

  // The page's source: what Markdown renders, and what anchors HTML comments.
  const { data: content, isLoading: contentLoading } = useFileContent(presentable ? filePath : null)
  const { data: commentsData } = useComments(presentable ? filePath : null)
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  useEffect(() => setOutline([]), [filePath])
  const handleCommentClick = useCallback((lineStart?: number, _lineEnd?: number, quotedContent?: string, commentId?: string) => {
    scrollToCommentRef.current?.({ lineStart, quotedContent, commentId })
  }, [])

  // The comments rail shortcuts `Shell` binds elsewhere.
  useKeyboardShortcuts({
    "]": (e) => {
      e.preventDefault()
      uiChromeStore.toggleRight()
    },
    c: (e) => {
      e.preventDefault()
      uiChromeStore.setRight(true)
      sidePanelStore.setTab("comments")
    },
    o: (e) => {
      e.preventDefault()
      uiChromeStore.setRight(true)
      sidePanelStore.setTab("outline")
    },
    n: (e) => {
      e.preventDefault()
      uiChromeStore.openComments()
    },
  })

  const backLink = (
    <Link
      to={fileUrl}
      className="fixed bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground opacity-60 shadow-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
    >
      <ArrowLeft className="size-3" />
      Back to file
    </Link>
  )

  if (healthLoading || (presentable && contentLoading)) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!presentable || !content) {
    return (
      <div className="flex h-dvh items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {presentable ? "Failed to load the file." : "Only HTML and Markdown files can be presented."}
        {backLink}
      </div>
    )
  }

  return (
    <div className="h-dvh">
      <MainWithComments filePath={filePath} onCommentClick={handleCommentClick} showCommentsHeader outline={outline}>
        {isHtml ? (
          // Per drive too, as in FileViewer: the drive-root confirm must not carry over.
          <HtmlViewer
            key={`${orgId}/${driveId}/${filePath}`}
            path={filePath}
            className="h-full w-full"
            comments={commentsData?.comments}
            content={content.content}
            onScrollToCommentRef={scrollToCommentRef}
          />
        ) : (
          <MarkdownViewer
            content={content.content}
            path={filePath}
            comments={commentsData?.comments}
            className="h-full"
            onScrollToCommentRef={scrollToCommentRef}
            onOutlineChange={setOutline}
          />
        )}
      </MainWithComments>
      {backLink}
    </div>
  )
}
