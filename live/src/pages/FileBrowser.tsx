import { useCallback, useMemo, useRef } from "react"
import { useBrowser } from "@/contexts/browser"
import { FileViewer } from "@/components/viewers/FileViewer"
import { MainWithComments } from "@/components/layout/MainWithComments"
import { FolderView } from "@/components/folder-view/FolderView"

export type ScrollToCommentCallback = (opts: { lineStart?: number; quotedContent?: string }) => void

export function FileBrowserPage() {
  const { selectedFile } = useBrowser()
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  // Keyboard shortcuts are now registered globally in Shell — no per-page hook needed.

  const handleCommentClick = useCallback((lineStart?: number, _lineEnd?: number, quotedContent?: string) => {
    scrollToCommentRef.current?.({ lineStart, quotedContent })
  }, [])

  // A trailing slash on the URL splat indicates folder mode. When the splat is
  // empty/null (e.g. /files cold-load or /file/~/<org>/<drive>/), render the
  // FolderView at the drive root.
  const folderPath = useMemo<string | null>(() => {
    if (!selectedFile) return ""
    if (selectedFile.endsWith("/")) return selectedFile.replace(/\/+$/, "")
    return null
  }, [selectedFile])

  if (folderPath !== null) {
    // Folder mode — comments rail is hidden by MainWithComments when filePath
    // is null, so we just render the FolderView full-width.
    return (
      <MainWithComments filePath={null} onCommentClick={handleCommentClick}>
        <FolderView path={folderPath} />
      </MainWithComments>
    )
  }

  return (
    <MainWithComments filePath={selectedFile} onCommentClick={handleCommentClick}>
      <FileViewer
        path={selectedFile!}
        className="h-full"
        onScrollToCommentRef={scrollToCommentRef}
      />
    </MainWithComments>
  )
}
