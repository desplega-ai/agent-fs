import { History } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { glyphFor } from "@/lib/file-glyphs"
import { cn } from "@/lib/utils"

interface RecentFilesProps {
  onOpenFile: (path: string) => void
}

export function RecentFiles({ onOpenFile }: RecentFilesProps) {
  const { recentFiles, selectedFile } = useBrowser()

  if (recentFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <History className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
        <div className="space-y-1">
          <p className="text-sm font-medium">No recent files</p>
          <p className="text-xs text-muted-foreground">
            Files you open will appear here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ul className="py-1" aria-label="Recently viewed files">
      {recentFiles.map((path) => {
        const lastSlash = path.lastIndexOf("/")
        const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1)
        const parentPath = lastSlash === -1 ? "Drive root" : path.slice(0, lastSlash)
        const glyph = glyphFor(path)
        const isSelected = selectedFile === path

        return (
          <li key={path}>
            <button
              type="button"
              title={path}
              aria-current={isSelected ? "page" : undefined}
              onClick={() => onOpenFile(path)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                isSelected &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              <glyph.Icon className={cn("size-4 shrink-0", glyph.className)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{filename}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {parentPath}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
