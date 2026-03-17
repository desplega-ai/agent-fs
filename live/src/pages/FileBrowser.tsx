import { useBrowser } from "@/contexts/browser"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { FileViewer } from "@/components/viewers/FileViewer"
import { Files } from "lucide-react"

export function FileBrowserPage() {
  const { selectedFile } = useBrowser()
  useKeyboardShortcuts()

  if (!selectedFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Files className="h-10 w-10 opacity-30" />
        <p className="text-sm">Select a file from the sidebar to view it.</p>
        <p className="text-xs">Use <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd> to search</p>
      </div>
    )
  }

  return <FileViewer path={selectedFile} className="h-full" />
}
