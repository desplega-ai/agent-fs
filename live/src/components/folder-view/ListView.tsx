import { Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import { MiddleEllipsis } from "@/lib/middle-ellipsis"
import { glyphFor } from "@/lib/file-glyphs"
import type { LsEntry } from "@/api/types"

interface ListViewProps {
  entries: LsEntry[]
  /** The folder path the entries live in (no trailing slash). */
  currentPath: string
  onEntryClick: (entry: LsEntry) => void
}

export function ListView({ entries, currentPath, onEntryClick }: ListViewProps) {
  return (
    <div className="flex flex-col">
      {entries.map((entry) => (
        <ListRow
          key={entry.name}
          entry={entry}
          currentPath={currentPath}
          onClick={() => onEntryClick(entry)}
        />
      ))}
    </div>
  )
}

function ListRow({
  entry,
  currentPath,
  onClick,
}: {
  entry: LsEntry
  currentPath: string
  onClick: () => void
}) {
  const isDir = entry.type === "directory"
  const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
  const glyph = !isDir ? glyphFor(fullPath) : null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm",
        "hover:bg-muted transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
      )}
    >
      {isDir ? (
        <Folder className="size-4 shrink-0 text-amber-500" />
      ) : glyph ? (
        <glyph.Icon className={cn("size-4 shrink-0", glyph.className)} />
      ) : null}
      <span className="min-w-0 flex-1 text-left">
        <MiddleEllipsis text={entry.name} />
      </span>
      <span className="hidden sm:inline-block w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {isDir ? "—" : formatBytes(entry.size)}
      </span>
      <span className="hidden md:inline-block w-32 shrink-0 text-right text-xs text-muted-foreground">
        {formatModified(entry.modifiedAt)}
      </span>
    </button>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatModified(iso: string | undefined): string {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return d.toLocaleDateString()
  } catch {
    return ""
  }
}
