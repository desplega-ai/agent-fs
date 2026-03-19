import { useState, useCallback, useRef } from "react"
import { MessageSquare, X, Files, GripVertical } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { useComments } from "@/hooks/use-comments"
import { FileViewer } from "@/components/viewers/FileViewer"
import { CommentSidebar } from "@/components/comments/CommentSidebar"
import { Button } from "@/components/ui/button"

export type ScrollToCommentCallback = (opts: { lineStart?: number; quotedContent?: string }) => void

function useResizable(defaultWidth: number, minWidth: number, maxWidth: number) {
  const [width, setWidth] = useState(defaultWidth)
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = startX - ev.clientX // inverted: drag left = wider
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta))
      setWidth(newWidth)
    }

    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }, [width, minWidth, maxWidth])

  return { width, onMouseDown }
}

export function FileBrowserPage() {
  const { selectedFile } = useBrowser()
  const [mobileCommentsOpen, setMobileCommentsOpen] = useState(false)
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  const { width: commentsWidth, onMouseDown } = useResizable(300, 200, 600)
  useKeyboardShortcuts()

  const handleCommentClick = useCallback((lineStart?: number, _lineEnd?: number, quotedContent?: string) => {
    scrollToCommentRef.current?.({ lineStart, quotedContent })
  }, [])

  if (!selectedFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Files className="size-10 opacity-30" />
        <p className="text-sm">Select a file from the sidebar to view it.</p>
        <p className="text-xs">Use <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd> to search</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* File viewer */}
      <div className="flex-1 min-w-0">
        <FileViewer path={selectedFile} className="h-full" onScrollToCommentRef={scrollToCommentRef} />
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

      {/* Comment sidebar — desktop */}
      <div
        className="hidden lg:flex flex-col shrink-0 min-w-0 overflow-hidden"
        style={{ width: commentsWidth }}
      >
        <CommentSidebar path={selectedFile} onCommentClick={handleCommentClick} />
      </div>

      {/* Mobile comment toggle */}
      <MobileCommentToggle
        path={selectedFile}
        open={mobileCommentsOpen}
        onToggle={() => setMobileCommentsOpen(!mobileCommentsOpen)}
        onClose={() => setMobileCommentsOpen(false)}
        onCommentClick={handleCommentClick}
      />
    </div>
  )
}

function MobileCommentToggle({ path, open, onToggle, onClose, onCommentClick }: {
  path: string
  open: boolean
  onToggle: () => void
  onClose: () => void
  onCommentClick: (lineStart?: number, lineEnd?: number) => void
}) {
  const { data: commentsData } = useComments(path)
  const commentCount = commentsData?.comments.length ?? 0

  return (
    <>
      <div className="lg:hidden fixed bottom-4 right-4 z-30">
        <Button size="icon" variant="outline" onClick={onToggle} className="rounded-full shadow-lg size-10">
          <MessageSquare className="size-4" />
          {commentCount > 0 && (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              {commentCount}
            </span>
          )}
        </Button>
      </div>

      {open && (
        <>
          <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={onClose} />
          <div className="lg:hidden fixed inset-y-0 right-0 z-50 w-80 max-w-[85vw] bg-background border-l border-border flex flex-col shadow-xl">
            <div className="flex h-10 items-center justify-between border-b border-border px-3">
              <span className="text-sm font-medium">
                Comments
                {commentCount > 0 && (
                  <span className="ml-1.5 text-xs text-muted-foreground">({commentCount})</span>
                )}
              </span>
              <Button variant="ghost" size="icon-xs" onClick={onClose}><X /></Button>
            </div>
            <CommentSidebar path={path} showHeader={false} onCommentClick={onCommentClick} />
          </div>
        </>
      )}
    </>
  )
}
