import { Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import { glyphFor } from "@/lib/file-glyphs"
import type { LsEntry } from "@/api/types"
import { FavoriteToggle } from "@/components/FavoriteToggle"
import { useFavorites } from "@/hooks/use-favorites"

interface GridViewProps {
  entries: LsEntry[]
  /** The folder path the entries live in (no trailing slash). */
  currentPath: string
  onEntryClick: (entry: LsEntry) => void
}

export function GridView({ entries, currentPath, onEntryClick }: GridViewProps) {
  const favorites = useFavorites()
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      {entries.map((entry) => (
        <GridTile
          key={entry.name}
          entry={entry}
          currentPath={currentPath}
          onClick={() => onEntryClick(entry)}
          favorites={favorites}
        />
      ))}
    </div>
  )
}

function GridTile({
  entry,
  currentPath,
  onClick,
  favorites,
}: {
  entry: LsEntry
  currentPath: string
  onClick: () => void
  favorites: ReturnType<typeof useFavorites>
}) {
  const isDir = entry.type === "directory"
  const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
  const glyph = !isDir ? glyphFor(fullPath) : null
  const favorited = favorites.isFavorite(fullPath)

  // The star sits on top of the tile as a sibling of the tile button, so
  // starring never opens the entry.
  return (
    <div className="group/tile relative flex flex-col">
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
        <span
          className="w-full min-w-0 break-all text-center text-xs leading-tight line-clamp-2"
          title={entry.name}
        >
          {entry.name}
        </span>
      </button>
      {favorites.supported && (
        <FavoriteToggle
          favorited={favorited}
          onToggle={() => favorites.toggleFavorite(fullPath, isDir ? "directory" : "file")}
          name={entry.name}
          className={cn(
            "absolute right-1 top-1",
            !favorited && "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100",
          )}
        />
      )}
    </div>
  )
}
