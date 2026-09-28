import { useEffect, useMemo, useRef, useState } from "react"
import { Search, FileText, Info, Loader2, TriangleAlert } from "lucide-react"
import {
  Dialog,
  DialogBackdrop,
  DialogPortal,
} from "@/components/ui/dialog"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { useFtsSearch } from "@/hooks/use-fts-search"
import { useSemanticSearch } from "@/hooks/use-semantic-search"
import { useHybridSearch } from "@/hooks/use-hybrid-search"
import { glyphFor } from "@/lib/file-glyphs"
import { cn } from "@/lib/utils"
import type { SearchType } from "./SearchModeToggle"

interface ResultItem {
  path: string
  snippet?: string
  score?: number
}

interface SearchModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialQuery?: string
}

const SEARCH_TYPES: { value: SearchType; label: string; description: string }[] = [
  { value: "hybrid", label: "Hybrid", description: "Semantic + keyword" },
  { value: "fulltext", label: "Full-text", description: "FTS5 keyword matching" },
  { value: "semantic", label: "Semantic", description: "Vector embeddings" },
]

/**
 * Spawn-on-demand modal for full-text / semantic / hybrid search. Self-contained:
 * its own input, type selector, and results pane. Closing the modal clears
 * its state — the parent SearchBar resets to the Files tab.
 */
export function SearchModal({ open, onOpenChange, initialQuery = "" }: SearchModalProps) {
  const { selectFile } = useBrowser()
  const { driveName } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery)
  const [searchType, setSearchType] = useState<SearchType>("hybrid")

  // Reset state every time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery)
      setDebouncedQuery(initialQuery)
      // Focus input on next paint to win the race against base-ui autofocus.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open, initialQuery])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200)
    return () => clearTimeout(t)
  }, [query])

  const searchQuery = debouncedQuery.trim() ? debouncedQuery : ""
  const hybridResult = useHybridSearch(searchType === "hybrid" ? searchQuery : "")
  const ftsResult = useFtsSearch(searchType === "fulltext" ? searchQuery : "")
  const semanticResult = useSemanticSearch(searchType === "semantic" ? searchQuery : "")

  const activeSearch = (() => {
    switch (searchType) {
      case "hybrid":
        return {
          results: (hybridResult.data?.results ?? []).map<ResultItem>((r) => ({
            path: r.path,
            snippet: r.snippet,
            score: r.score,
          })),
          fetching: hybridResult.isFetching,
          error: hybridResult.error,
          success: hybridResult.isSuccess,
          hint: hybridResult.data?.hint,
          retry: hybridResult.refetch,
        }
      case "fulltext":
        return {
          results: (ftsResult.data?.matches ?? []).map<ResultItem>((m) => ({
            path: m.path,
            snippet: m.snippet,
          })),
          fetching: ftsResult.isFetching,
          error: ftsResult.error,
          success: ftsResult.isSuccess,
          hint: ftsResult.data?.hint
            ? "Full-text matches exact terms. Try Hybrid for semantic matching."
            : undefined,
          retry: ftsResult.refetch,
        }
      case "semantic":
        return {
          results: (semanticResult.data?.results ?? []).map<ResultItem>((r) => ({
            path: r.path,
            snippet: r.snippet,
            score: r.score,
          })),
          fetching: semanticResult.isFetching,
          error: semanticResult.error,
          success: semanticResult.isSuccess,
          hint: semanticResult.data?.hint,
          retry: semanticResult.refetch,
        }
    }
  })()
  const hasQuery = query.trim().length > 0
  const waitingForDebounce = query !== debouncedQuery
  const results = waitingForDebounce ? [] : activeSearch.results
  const loading = hasQuery && (waitingForDebounce || activeSearch.fetching)
  const error = waitingForDebounce ? null : activeSearch.error
  const success = !waitingForDebounce && activeSearch.success
  const hint = success ? activeSearch.hint : undefined

  const handleResultClick = (path: string) => {
    selectFile(path)
    onOpenChange(false)
  }

  // Keyboard navigation state. selectedIndex moves with ↑/↓; Enter opens.
  const [selectedIndex, setSelectedIndex] = useState(0)
  const resultsListRef = useRef<HTMLUListElement>(null)
  const resultsKey = useMemo(() => results.map((r) => r.path).join("\0"), [results])

  // Reset highlight whenever the result set changes (typing, switching mode).
  useEffect(() => {
    setSelectedIndex(0)
  }, [resultsKey])

  // Keep the selected row in view while the user navigates.
  useEffect(() => {
    if (!resultsListRef.current) return
    const item = resultsListRef.current.querySelectorAll<HTMLLIElement>(
      "[data-result-row]",
    )[selectedIndex]
    item?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex, resultsKey])

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(results.length - 1, i + 1))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === "Enter") {
      const target = results[selectedIndex]
      if (target) {
        e.preventDefault()
        handleResultClick(target.path)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className="fixed top-[15%] left-[50%] z-50 flex max-h-[70vh] w-full max-w-2xl translate-x-[-50%] flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search across file content using full-text, semantic, or hybrid matching.
          </DialogPrimitive.Description>

          {/* Header: search input + type selector */}
          <div className="flex flex-col gap-2 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Search file content..."
                className="h-10 pl-10 text-sm"
              />
              {loading && (
                <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            <div className="flex items-center gap-1">
              {SEARCH_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setSearchType(t.value)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs transition-colors",
                    searchType === t.value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                  title={t.description}
                >
                  {t.label}
                </button>
              ))}
              <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                Across {driveName ?? "current drive"}
              </span>
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto">
            {hint && <SearchHint hint={hint} />}
            {!hasQuery ? (
              <EmptyHint />
            ) : loading ? (
              <ResultSkeleton />
            ) : error ? (
              <SearchError error={error} onRetry={() => void activeSearch.retry()} />
            ) : success && results.length === 0 ? (
              <NoResults query={query} />
            ) : success ? (
              <ul ref={resultsListRef} className="divide-y divide-border/60">
                {results.map((r, i) => (
                  <ResultRow
                    key={r.path}
                    result={r}
                    selected={i === selectedIndex}
                    onClick={() => handleResultClick(r.path)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  />
                ))}
              </ul>
            ) : (
              <ResultSkeleton />
            )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center gap-3 border-t border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
                ↑
              </kbd>
              <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
                ↓
              </kbd>
              navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
                ↵
              </kbd>
              open
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
                esc
              </kbd>
              close
            </span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

function ResultRow({
  result,
  selected,
  onClick,
  onMouseEnter,
}: {
  result: ResultItem
  selected: boolean
  onClick: () => void
  onMouseEnter?: () => void
}) {
  const filename = result.path.split("/").pop() ?? result.path
  const dirPath = result.path.slice(0, result.path.length - filename.length).replace(/\/$/, "")
  const glyph = glyphFor(result.path)
  const Icon = glyph?.Icon ?? FileText

  return (
    <li data-result-row aria-selected={selected}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors focus-visible:outline-none",
          selected ? "bg-muted/80" : "hover:bg-muted/60",
        )}
      >
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            glyph?.className ?? "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{filename}</span>
            {result.score !== undefined && (
              <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {(result.score * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {dirPath && (
            <div className="truncate text-[11px] text-muted-foreground">{dirPath}</div>
          )}
          {result.snippet && (
            <p
              className="mt-1 line-clamp-2 text-xs text-muted-foreground/90 [&_mark]:rounded [&_mark]:bg-amber-200/60 [&_mark]:px-0.5 [&_mark]:text-foreground dark:[&_mark]:bg-amber-400/30"
              dangerouslySetInnerHTML={{ __html: result.snippet }}
            />
          )}
        </div>
      </button>
    </li>
  )
}

function EmptyHint() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <Search className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Search across file content</p>
        <p className="text-xs text-muted-foreground">Type a query above to begin.</p>
      </div>
    </div>
  )
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <Search className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
      <div className="space-y-0.5">
        <p className="text-sm font-medium">No results</p>
        <p className="text-xs text-muted-foreground break-all">
          Nothing matches "{query}".
        </p>
      </div>
    </div>
  )
}

function SearchHint({ hint }: { hint: string }) {
  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p>{hint}</p>
    </div>
  )
}

function SearchError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : "The search request failed."

  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <TriangleAlert className="size-8 text-destructive/70" strokeWidth={1.5} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-destructive">Search failed</p>
        <p className="max-w-md text-xs text-muted-foreground break-words">{message}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function ResultSkeleton() {
  return (
    <ul className="divide-y divide-border/60">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 px-3 py-2.5">
          <div className="mt-0.5 size-4 shrink-0 rounded bg-muted animate-pulse" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
            <div className="h-2.5 w-1/2 rounded bg-muted/60 animate-pulse" />
          </div>
        </li>
      ))}
    </ul>
  )
}
