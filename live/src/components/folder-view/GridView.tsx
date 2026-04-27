import { Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import { MiddleEllipsis } from "@/lib/middle-ellipsis"
import { glyphFor } from "@/lib/file-glyphs"
import type { LsEntry } from "@/api/types"

interface GridViewProps {
  entries: LsEntry[]
  /** The folder path the entries live in (no trailing slash). */
  currentPath: string
  onEntryClick: (entry: LsEntry) => void
}

export function GridView({ entries, currentPath, onEntryClick }: GridViewProps) {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      {entries.map((entry) => (
        <GridTile
          key={entry.name}
          entry={entry}
          currentPath={currentPath}
          onClick={() => onEntryClick(entry)}
        />
      ))}
    </div>
  )
}

function GridTile({
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
        "group flex flex-col items-center gap-2 rounded-lg border border-transparent px-3 py-4",
        "hover:border-border hover:bg-muted/50 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
      )}
    >
      {isDir ? (
        <Folder className="size-10 shrink-0 text-amber-500" />
      ) : glyph ? (
        <glyph.Icon className={cn("size-10 shrink-0", glyph.className)} />
      ) : null}
      <span className="w-full min-w-0 text-center text-xs leading-tight">
        <span
          className="block break-words line-clamp-2"
          title={entry.name}
        >
          <MiddleEllipsis text={entry.name} />
        </span>
      </span>
    </button>
  )
}
