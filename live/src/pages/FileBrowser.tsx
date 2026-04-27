import { useCallback, useRef } from "react"
import { Files } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { FileViewer } from "@/components/viewers/FileViewer"
import { MainWithComments } from "@/components/layout/MainWithComments"

export type ScrollToCommentCallback = (opts: { lineStart?: number; quotedContent?: string }) => void

export function FileBrowserPage() {
  const { selectedFile } = useBrowser()
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  // Keyboard shortcuts are now registered globally in Shell — no per-page hook needed.

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
    <MainWithComments filePath={selectedFile} onCommentClick={handleCommentClick}>
      <FileViewer
        path={selectedFile}
        className="h-full"
        onScrollToCommentRef={scrollToCommentRef}
      />
    </MainWithComments>
  )
}
