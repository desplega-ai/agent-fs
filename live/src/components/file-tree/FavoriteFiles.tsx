import { Folder, Star } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { FavoriteToggle } from "@/components/FavoriteToggle"
import { useFavorites } from "@/hooks/use-favorites"
import { glyphFor } from "@/lib/file-glyphs"
import { cleanPath } from "@/lib/paths"
import { cn } from "@/lib/utils"

interface FavoriteFilesProps {
  /** `path` is drive-relative; folders end with "/". */
  onOpen: (path: string) => void
}

/** The signed-in user's starred files and folders in the active drive. */
export function FavoriteFiles({ onOpen }: FavoriteFilesProps) {
  const { selectedFile } = useBrowser()
  const { favorites, isLoading, toggleFavorite } = useFavorites()

  if (isLoading) {
    return <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading favorites…</p>
  }

  if (favorites.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <Star className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
        <div className="space-y-1">
          <p className="text-sm font-medium">No favorites yet</p>
          <p className="text-xs text-muted-foreground">
            Star a file or folder to keep it here. Only you see your favorites.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ul className="py-1" aria-label="Favorites">
      {favorites.map((favorite) => {
        const path = cleanPath(favorite.path)
        const isDir = favorite.kind === "directory"
        const lastSlash = path.lastIndexOf("/")
        const name = lastSlash === -1 ? path : path.slice(lastSlash + 1)
        const parentPath = lastSlash === -1 ? "Drive root" : path.slice(0, lastSlash)
        const glyph = isDir ? null : glyphFor(path)
        const isSelected = selectedFile === (isDir ? `${path}/` : path)

        return (
          <li key={favorite.path} className="relative">
            <button
              type="button"
              title={path}
              aria-current={isSelected ? "page" : undefined}
              onClick={() => onOpen(isDir ? `${path}/` : path)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                isSelected && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              {isDir ? (
                <Folder className="size-4 shrink-0 text-amber-500" />
              ) : glyph ? (
                <glyph.Icon className={cn("size-4 shrink-0", glyph.className)} />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{parentPath}</span>
              </span>
            </button>
            <FavoriteToggle
              favorited
              onToggle={() => toggleFavorite(path, favorite.kind)}
              name={name}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            />
          </li>
        )
      })}
    </ul>
  )
}
