import { useEffect, useId, useState, type KeyboardEvent } from "react"
import { FileTree } from "@/components/file-tree/FileTree"
import { RecentFiles } from "@/components/file-tree/RecentFiles"
import { SearchBar } from "@/components/search/SearchBar"
import { Button } from "@/components/ui/button"
import { useBrowser } from "@/contexts/browser"
import { useFileSearch } from "@/stores/file-search"

type SidebarView = "tree" | "recent"

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const [view, setView] = useState<SidebarView>("tree")
  const { selectedFile, selectFile } = useBrowser()
  const search = useFileSearch()
  const tabsId = useId()
  const searchActive = search.query.length > 0
  const activeView: SidebarView = searchActive ? "tree" : view
  const treeTabId = `${tabsId}-tree-tab`
  const recentTabId = `${tabsId}-recent-tab`
  const treePanelId = `${tabsId}-tree-panel`
  const recentPanelId = `${tabsId}-recent-panel`

  // URL-driven file opens should always reveal the selected row in the tree.
  // A user may still switch back to Recent afterward without changing files.
  useEffect(() => {
    if (selectedFile && !selectedFile.endsWith("/")) setView("tree")
  }, [selectedFile])

  const selectTab = (next: SidebarView) => {
    if (next === "recent" && searchActive) return
    setView(next)
  }

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: SidebarView,
  ) => {
    let next: SidebarView | null = null
    if (event.key === "ArrowLeft" || event.key === "Home") next = "tree"
    if (event.key === "ArrowRight" || event.key === "End") {
      next = searchActive ? "tree" : "recent"
    }
    if (!next || next === current) return

    event.preventDefault()
    selectTab(next)
    const nextId = next === "tree" ? treeTabId : recentTabId
    requestAnimationFrame(() => document.getElementById(nextId)?.focus())
  }

  const handleOpenRecent = (path: string) => {
    setView("tree")
    selectFile(path)
  }

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <SearchBar />
      {children}
      <div className="shrink-0 border-b border-sidebar-border px-3 py-2">
        <div
          role="tablist"
          aria-label="File navigation"
          className="flex rounded-md border border-sidebar-border bg-sidebar-accent/30 p-0.5"
        >
          <Button
            id={treeTabId}
            type="button"
            role="tab"
            aria-selected={activeView === "tree"}
            aria-controls={treePanelId}
            tabIndex={activeView === "tree" ? 0 : -1}
            variant={activeView === "tree" ? "default" : "ghost"}
            size="xs"
            className={
              activeView === "tree"
                ? "flex-1 bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                : "flex-1 text-muted-foreground"
            }
            onClick={() => selectTab("tree")}
            onKeyDown={(event) => handleTabKeyDown(event, "tree")}
          >
            Tree
          </Button>
          <Button
            id={recentTabId}
            type="button"
            role="tab"
            aria-selected={activeView === "recent"}
            aria-controls={recentPanelId}
            tabIndex={activeView === "recent" ? 0 : -1}
            variant={activeView === "recent" ? "default" : "ghost"}
            size="xs"
            className={
              activeView === "recent"
                ? "flex-1 bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                : "flex-1 text-muted-foreground"
            }
            disabled={searchActive}
            title={searchActive ? "Clear search to view recent files" : undefined}
            onClick={() => selectTab("recent")}
            onKeyDown={(event) => handleTabKeyDown(event, "recent")}
          >
            Recent
          </Button>
        </div>
      </div>
      <div
        id={activeView === "tree" ? treePanelId : recentPanelId}
        role="tabpanel"
        aria-labelledby={activeView === "tree" ? treeTabId : recentTabId}
        className="flex-1 overflow-y-auto"
      >
        {activeView === "tree" ? (
          <FileTree />
        ) : (
          <RecentFiles onOpenFile={handleOpenRecent} />
        )}
      </div>
    </aside>
  )
}
