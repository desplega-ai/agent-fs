import { useState, useRef, useEffect, useCallback } from "react"
import { Search, X } from "lucide-react"
import { SearchModeToggle, type SearchMode } from "./SearchModeToggle"
import { SearchResults } from "./SearchResults"
import { useFtsSearch } from "@/hooks/use-fts-search"
import { useSemanticSearch } from "@/hooks/use-semantic-search"
import { useGlobSearch } from "@/hooks/use-glob-search"

export function SearchBar() {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [mode, setMode] = useState<SearchMode>("files")
  const [isSearching, setIsSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])

  const globResult = useGlobSearch(mode === "files" ? debouncedQuery : "")
  const ftsResult = useFtsSearch(mode === "fulltext" ? debouncedQuery : "")
  const semanticResult = useSemanticSearch(mode === "semantic" ? debouncedQuery : "")

  const semanticDisabled = semanticResult.data?.results.length === 0 && !!semanticResult.data?.hint

  const results = (() => {
    switch (mode) {
      case "files":
        return (globResult.data?.matches ?? []).map((m) => ({ path: m.path }))
      case "fulltext":
        return (ftsResult.data?.matches ?? []).map((m) => ({ path: m.path, snippet: m.snippet }))
      case "semantic":
        return (semanticResult.data?.results ?? []).map((r) => ({ path: r.path, snippet: r.snippet, score: r.score }))
    }
  })()

  const loading = mode === "files" ? globResult.isLoading : mode === "fulltext" ? ftsResult.isLoading : semanticResult.isLoading

  const handleClear = useCallback(() => {
    setQuery("")
    setDebouncedQuery("")
    setIsSearching(false)
  }, [])

  return (
    <>
      <div className="border-b border-sidebar-border px-3 py-2 space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIsSearching(true)
            }}
            onFocus={() => query && setIsSearching(true)}
            placeholder="Search... ⌘K"
            className="w-full rounded-md border border-input bg-background pl-8 pr-8 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {query && (
            <button
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {isSearching && (
          <SearchModeToggle mode={mode} onChange={setMode} semanticDisabled={semanticDisabled} />
        )}
      </div>

      {isSearching && debouncedQuery && (
        <SearchResults results={results} isLoading={loading} onClear={handleClear} />
      )}
    </>
  )
}
