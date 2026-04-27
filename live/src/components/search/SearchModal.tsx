import { useEffect, useRef, useState } from "react"
import { Search, FileText, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogBackdrop,
  DialogPortal,
} from "@/components/ui/dialog"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Input } from "@/components/ui/input"
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

  const hybridResult = useHybridSearch(searchType === "hybrid" ? debouncedQuery : "")
  const ftsResult = useFtsSearch(searchType === "fulltext" ? debouncedQuery : "")
  const semanticResult = useSemanticSearch(searchType === "semantic" ? debouncedQuery : "")

  const { results, loading } = (() => {
    switch (searchType) {
      case "hybrid":
        return {
          results: (hybridResult.data?.results ?? []).map<ResultItem>((r) => ({
            path: r.path,
            snippet: r.snippet,
            score: r.score,
          })),
          loading: hybridResult.isFetching,
        }
      case "fulltext":
        return {
          results: (ftsResult.data?.matches ?? []).map<ResultItem>((m) => ({
            path: m.path,
            snippet: m.snippet,
          })),
          loading: ftsResult.isFetching,
        }
      case "semantic":
        return {
          results: (semanticResult.data?.results ?? []).map<ResultItem>((r) => ({
            path: r.path,
            snippet: r.snippet,
            score: r.score,
          })),
          loading: semanticResult.isFetching,
        }
    }
  })()

  const handleResultClick = (path: string) => {
    selectFile(path)
    onOpenChange(false)
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
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto">
            {!debouncedQuery ? (
              <EmptyHint />
            ) : loading && results.length === 0 ? (
              <ResultSkeleton />
            ) : results.length === 0 ? (
              <NoResults query={debouncedQuery} />
            ) : (
              <ul className="divide-y divide-border/60">
                {results.map((r) => (
                  <ResultRow key={r.path} result={r} onClick={() => handleResultClick(r.path)} />
                ))}
              </ul>
            )}
          </div>

          {/* Footer hint */}
          <div className="border-t border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>{" "}
            open ·{" "}
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
              esc
            </kbd>{" "}
            close
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

function ResultRow({ result, onClick }: { result: ResultItem; onClick: () => void }) {
  const filename = result.path.split("/").pop() ?? result.path
  const dirPath = result.path.slice(0, result.path.length - filename.length).replace(/\/$/, "")
  const glyph = glyphFor(result.path)
  const Icon = glyph?.Icon ?? FileText

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/80 focus-visible:outline-none"
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
