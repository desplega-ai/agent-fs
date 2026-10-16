import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { FileTree } from "@/components/file-tree/FileTree"
import { RecentFiles } from "@/components/file-tree/RecentFiles"
import { FavoriteFiles } from "@/components/file-tree/FavoriteFiles"
import { FolderActions } from "@/components/file-mutations/FolderActions"
import { SearchBar } from "@/components/search/SearchBar"
import { Button } from "@/components/ui/button"
import { useBrowser } from "@/contexts/browser"
import { cleanPath, parentOf } from "@/lib/paths"
import { useFileSearch } from "@/hooks/use-file-search"
import { useFavorites } from "@/hooks/use-favorites"

type SidebarView = "tree" | "recent" | "favorites"

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const [view, setView] = useState<SidebarView>("tree")
  const { selectedFile, selectFile } = useBrowser()
  const search = useFileSearch()
  const { supported: favoritesSupported } = useFavorites()
  const tabsId = useId()
  const searchActive = search.query.length > 0
  const activeView: SidebarView =
    searchActive || (view === "favorites" && !favoritesSupported) ? "tree" : view
  const tabId = (v: SidebarView) => `${tabsId}-${v}-tab`
  const panelId = (v: SidebarView) => `${tabsId}-${v}-panel`
  const views: SidebarView[] = favoritesSupported ? ["tree", "recent", "favorites"] : ["tree", "recent"]

  // URL-driven file opens should always reveal the selected row in the tree.
  // A user may still switch back to Recent afterward without changing files.
  useEffect(() => {
    if (selectedFile && !selectedFile.endsWith("/")) setView("tree")
  }, [selectedFile])

  // Search results render at the top of the panel. When the query changes,
  // scroll there so matches are not hidden above a tree scrolled far down.
  // Only query changes trigger this, so the user's own scrolling is kept.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (search.query) panelRef.current?.scrollTo({ top: 0 })
  }, [search.query])

  // New / Upload in the sidebar act on the folder the user is looking at:
  // the open folder, or the open file's parent, else the drive root.
  const contextFolder = useMemo(() => {
    if (!selectedFile) return ""
    if (selectedFile.endsWith("/")) return cleanPath(selectedFile)
    return parentOf(selectedFile)
  }, [selectedFile])

  const selectTab = (next: SidebarView) => {
    if (next !== "tree" && searchActive) return
    setView(next)
  }

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: SidebarView,
  ) => {
    // Search pins the Tree tab; the others are disabled until it clears.
    const enabled = searchActive ? ["tree" as const] : views
    const index = enabled.indexOf(current)
    let next: SidebarView | null = null
    if (event.key === "Home") next = enabled[0]
    if (event.key === "End") next = enabled[enabled.length - 1]
    if (event.key === "ArrowLeft") next = enabled[Math.max(0, index - 1)]
    if (event.key === "ArrowRight") next = enabled[Math.min(enabled.length - 1, index + 1)]
    if (!next || next === current) return

    event.preventDefault()
    selectTab(next)
    const nextId = tabId(next)
    requestAnimationFrame(() => document.getElementById(nextId)?.focus())
  }

  const handleOpenRecent = (path: string) => {
    setView("tree")
    selectFile(path)
  }

  // Same as Recent: show the opened file or folder in the tree.
  const handleOpenFavorite = handleOpenRecent

  const tabLabels: Record<SidebarView, string> = { tree: "Tree", recent: "Recent", favorites: "Favorites" }

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <SearchBar />
      {children}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-sidebar-border px-3 py-2">
        <div
          role="tablist"
          aria-label="File navigation"
          className="flex flex-1 rounded-md border border-sidebar-border bg-sidebar-accent/30 p-0.5"
        >
          {views.map((v) => (
            <Button
              key={v}
              id={tabId(v)}
              type="button"
              role="tab"
              aria-selected={activeView === v}
              aria-controls={panelId(v)}
              tabIndex={activeView === v ? 0 : -1}
              variant={activeView === v ? "default" : "ghost"}
              size="xs"
              className={
                activeView === v
                  ? "flex-1 bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                  : "flex-1 text-muted-foreground"
              }
              disabled={v !== "tree" && searchActive}
              title={v !== "tree" && searchActive ? `Clear search to view ${tabLabels[v].toLowerCase()}` : undefined}
              onClick={() => selectTab(v)}
              onKeyDown={(event) => handleTabKeyDown(event, v)}
            >
              {tabLabels[v]}
            </Button>
          ))}
        </div>
        <FolderActions folder={contextFolder} size="icon-xs" />
      </div>
      <div
        ref={panelRef}
        id={panelId(activeView)}
        role="tabpanel"
        aria-labelledby={tabId(activeView)}
        className="flex-1 overflow-y-auto"
      >
        {activeView === "tree" ? (
          <FileTree />
        ) : activeView === "recent" ? (
          <RecentFiles onOpenFile={handleOpenRecent} />
        ) : (
          <FavoriteFiles onOpen={handleOpenFavorite} />
        )}
      </div>
    </aside>
  )
}
