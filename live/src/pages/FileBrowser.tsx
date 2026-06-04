import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useBrowser } from "@/contexts/browser"
import { FileViewer } from "@/components/viewers/FileViewer"
import { MainWithComments } from "@/components/layout/MainWithComments"
import { FolderView } from "@/components/folder-view/FolderView"
import { useDocumentTitle } from "@/hooks/use-document-title"
import type { OutlineItem } from "@/lib/outline"

export type ScrollToCommentCallback = (opts: { lineStart?: number; quotedContent?: string }) => void

export function FileBrowserPage() {
  const { selectedFile } = useBrowser()
  const scrollToCommentRef = useRef<ScrollToCommentCallback | null>(null)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  // Keyboard shortcuts are now registered globally in Shell — no per-page hook needed.

  // Clear the outline immediately when the file changes; the new file's
  // MarkdownViewer reports its own outline once rendered.
  useEffect(() => setOutline([]), [selectedFile])

  // Reflect the current file/folder in the browser tab title.
  useDocumentTitle(useMemo(() => {
    if (!selectedFile) return "Files"
    const name = selectedFile.replace(/\/+$/, "").split("/").filter(Boolean).pop()
    return name || "Files"
  }, [selectedFile]))

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
    <MainWithComments filePath={selectedFile} onCommentClick={handleCommentClick} outline={outline}>
      <FileViewer
        path={selectedFile!}
        className="h-full"
        onScrollToCommentRef={scrollToCommentRef}
        onOutlineChange={setOutline}
      />
    </MainWithComments>
  )
}
