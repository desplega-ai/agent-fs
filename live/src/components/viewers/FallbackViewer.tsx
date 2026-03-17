import { FileQuestion } from "lucide-react"
import { useFileStat } from "@/hooks/use-file-stat"
import { cn } from "@/lib/utils"

interface FallbackViewerProps {
  path: string
  className?: string
}

export function FallbackViewer({ path, className }: FallbackViewerProps) {
  const { data: stat } = useFileStat(path)

  return (
    <div className={cn("flex flex-col items-center justify-center gap-4 p-8 text-center", className)}>
      <FileQuestion className="h-12 w-12 text-muted-foreground/50" />
      <div>
        <p className="text-sm font-medium">Content preview not available</p>
        <p className="text-xs text-muted-foreground mt-1">{path}</p>
      </div>
      {stat && (
        <div className="text-xs text-muted-foreground space-y-1">
          <p>Size: {formatBytes(stat.size)}</p>
          {stat.contentType && <p>Type: {stat.contentType}</p>}
          <p>Author: {stat.author}</p>
          <p>Modified: {new Date(stat.modifiedAt).toLocaleDateString()}</p>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
