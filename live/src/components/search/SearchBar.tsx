import { useState, useRef, useEffect, useCallback } from "react"
import { Search, X, PanelLeftClose } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SearchModeToggle, type SearchTab } from "./SearchModeToggle"
import { SearchModal } from "./SearchModal"
import { useGlobSearch } from "@/hooks/use-glob-search"
import { useSearchInput } from "@/contexts/search-input"
import { uiChromeStore } from "@/stores/ui-chrome"
import {
  setSearchLoading,
  setSearchResults,
  clearSearchFilter,
} from "@/stores/file-search"

export function SearchBar() {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [tab, setTab] = useState<SearchTab>("files")
  const [isSearching, setIsSearching] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalQuery, setModalQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const { register } = useSearchInput()

  // Register the input ref so the global keyboard shortcut hook can focus it
  // via cmd+k / `/`. The cmd+k listener itself lives in the central registry.
  useEffect(() => {
    register(inputRef.current)
    return () => register(null)
  }, [register])

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  // Glob search drives the in-tree filter for the Files tab.
  const globResult = useGlobSearch(tab === "files" ? debouncedQuery : "")

  // Files tab: populate the in-tree filter so the existing FileTree filters
  // in place rather than showing a separate flat results pane. While the
  // glob query is in-flight we mark the filter as `loading` (no filtering)
  // so the user keeps seeing the tree instead of a flash of blank.
  useEffect(() => {
    if (tab !== "files" || !debouncedQuery) {
      clearSearchFilter()
      return
    }
    if (globResult.isFetching && !globResult.data) {
      setSearchLoading(debouncedQuery)
      return
    }
    const matches = (globResult.data?.matches ?? []).map((m) => m.path)
    setSearchResults(debouncedQuery, matches)
  }, [tab, debouncedQuery, globResult.data, globResult.isFetching])

  // Always clear the filter on unmount so the tree returns to normal.
  useEffect(() => {
    return () => clearSearchFilter()
  }, [])

  const handleClear = useCallback(() => {
    setQuery("")
    setDebouncedQuery("")
    setIsSearching(false)
    setTab("files")
    clearSearchFilter()
    inputRef.current?.blur()
  }, [])

  const openSearchModal = useCallback((seed: string) => {
    setModalQuery(seed)
    setModalOpen(true)
  }, [])

  /**
   * Switching to the "Search" tab opens a self-contained modal — full-text
   * / semantic / hybrid search is a different mental mode than browsing the
   * tree, so we surface it as an overlay. On modal close we reset back to
   * the Files tab.
   */
  const handleTabChange = useCallback((next: SearchTab) => {
    if (next === "search") {
      openSearchModal(query)
      // Don't actually switch tab state — keep "files" so when the modal
      // closes we're already where we should be.
    } else {
      setTab(next)
    }
  }, [query, openSearchModal])

  const handleModalOpenChange = useCallback((open: boolean) => {
    setModalOpen(open)
    if (!open) {
      // Per Taras: on close, reset query and go back to normal.
      setQuery("")
      setDebouncedQuery("")
      setIsSearching(false)
      setTab("files")
      clearSearchFilter()
    }
  }, [])

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        // Blur the input. Stop propagation so the global esc handler (which
        // clears the selected file) doesn't also fire.
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.blur()
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // While typing in Files-mode search, ↓/↑ jump focus into the filtered
        // tree so the user can step through matches without grabbing the
        // mouse. The tree's own handler then takes over.
        if (tab !== "files") return
        const sidebar = e.currentTarget.closest("aside") ?? document
        const buttons = sidebar.querySelectorAll<HTMLButtonElement>("[data-tree-path]")
        if (buttons.length === 0) return
        e.preventDefault()
        const target = e.key === "ArrowDown" ? buttons[0] : buttons[buttons.length - 1]
        target?.focus()
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) {
          // ⌘↵ → full-text/semantic Search modal seeded with the query.
          openSearchModal(query)
        } else {
          // ↵ → Files tab (filter tree in place). Already the default; this
          // makes the keyboard contract explicit.
          setTab("files")
        }
      }
    },
    [openSearchModal, query, tab],
  )

  return (
    <>
      <div className="flex min-h-[72px] flex-col justify-center gap-2 border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setIsSearching(true)
              }}
              onFocus={() => setIsSearching(true)}
              onBlur={() => {
                if (!query) setIsSearching(false)
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Search... ⌘K"
              className="pl-8 pr-8"
            />
            {query && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={handleClear}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                      aria-label="Clear search"
                    >
                      <X />
                    </Button>
                  }
                />
                <TooltipContent>Clear search</TooltipContent>
              </Tooltip>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => uiChromeStore.setLeft(false)}
                  className="text-muted-foreground"
                  aria-label="Collapse sidebar"
                >
                  <PanelLeftClose />
                </Button>
              }
            />
            <TooltipContent side="bottom">
              Collapse sidebar{" "}
              <kbd className="ml-1 px-1 text-[10px]">[</kbd>
            </TooltipContent>
          </Tooltip>
        </div>
        {isSearching && (
          <SearchModeToggle
            tab={tab}
            onTabChange={handleTabChange}
            onClose={handleClear}
          />
        )}
      </div>

      <SearchModal
        open={modalOpen}
        onOpenChange={handleModalOpenChange}
        initialQuery={modalQuery}
      />
    </>
  )
}
