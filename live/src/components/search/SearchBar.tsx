import { useState, useRef, useEffect, useCallback } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SearchModeToggle, type SearchTab, type SearchType } from "./SearchModeToggle"
import { SearchResults } from "./SearchResults"
import { useFtsSearch } from "@/hooks/use-fts-search"
import { useSemanticSearch } from "@/hooks/use-semantic-search"
import { useGlobSearch } from "@/hooks/use-glob-search"
import { useHybridSearch } from "@/hooks/use-hybrid-search"
import { useSearchInput } from "@/contexts/search-input"
import { setSearchFilter, clearSearchFilter } from "@/stores/file-search"

export function SearchBar() {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [tab, setTab] = useState<SearchTab>("files")
  const [searchType, setSearchType] = useState<SearchType>("hybrid")
  const [isSearching, setIsSearching] = useState(false)
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

  // Determine which query to pass to each hook
  const isSearch = tab === "search"
  const globResult = useGlobSearch(tab === "files" ? debouncedQuery : "")
  const hybridResult = useHybridSearch(isSearch && searchType === "hybrid" ? debouncedQuery : "")
  const ftsResult = useFtsSearch(isSearch && searchType === "fulltext" ? debouncedQuery : "")
  const semanticResult = useSemanticSearch(isSearch && searchType === "semantic" ? debouncedQuery : "")

  // Files tab: populate the in-tree filter so the existing FileTree filters
  // in place rather than showing a separate flat results pane.
  useEffect(() => {
    if (tab !== "files") {
      clearSearchFilter()
      return
    }
    const matches = (globResult.data?.matches ?? []).map((m) => m.path)
    setSearchFilter(debouncedQuery, matches)
  }, [tab, debouncedQuery, globResult.data])

  // Always clear the filter on unmount so the tree returns to normal.
  useEffect(() => {
    return () => clearSearchFilter()
  }, [])

  const results = (() => {
    if (tab === "files") {
      return (globResult.data?.matches ?? []).map((m) => ({ path: m.path }))
    }
    switch (searchType) {
      case "hybrid":
        return (hybridResult.data?.results ?? []).map((r) => ({ path: r.path, snippet: r.snippet, score: r.score }))
      case "fulltext":
        return (ftsResult.data?.matches ?? []).map((m) => ({ path: m.path, snippet: m.snippet }))
      case "semantic":
        return (semanticResult.data?.results ?? []).map((r) => ({ path: r.path, snippet: r.snippet, score: r.score }))
    }
  })()

  const loading = (() => {
    if (tab === "files") return globResult.isLoading
    switch (searchType) {
      case "hybrid": return hybridResult.isLoading
      case "fulltext": return ftsResult.isLoading
      case "semantic": return semanticResult.isLoading
    }
  })()

  const handleClear = useCallback(() => {
    setQuery("")
    setDebouncedQuery("")
    setIsSearching(false)
  }, [])

  return (
    <>
      <div className="flex min-h-[72px] flex-col justify-center gap-2 border-b border-sidebar-border px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIsSearching(true)
            }}
            onFocus={() => query && setIsSearching(true)}
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
        {isSearching && (
          <SearchModeToggle
            tab={tab}
            searchType={searchType}
            onTabChange={setTab}
            onSearchTypeChange={setSearchType}
          />
        )}
      </div>

      {/* Only the full-text Search tab uses the separate results pane.
          The Files tab filters the live tree in place via the file-search
          store, so the user keeps folder context. */}
      {isSearching && debouncedQuery && tab === "search" && (
        <SearchResults results={results} isLoading={loading} onClear={handleClear} />
      )}
    </>
  )
}
