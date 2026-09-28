import { useCallback, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, SearchX, TriangleAlert } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { useSearchInput } from "@/contexts/search-input"
import { useFileSearch } from "@/hooks/use-file-search"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { glyphFor } from "@/lib/file-glyphs"
import { MiddleEllipsis } from "@/lib/middle-ellipsis"
import { filterLoadedListings } from "@/lib/local-file-filter"
import type { LsResult } from "@/api/types"

/** Rendering thousands of rows for a broad query helps nobody; ask to refine. */
const MAX_RESULTS = 200

/**
 * Files-tab search, rendered above the tree. Results are a flat list: clicking
 * one opens the file, and FileTree's reveal effect expands only its ancestors.
 * The tree itself always stays rendered, so a failed search (e.g. a 429) never
 * looks like an empty drive.
 */
export function FileSearchPanel() {
  const { orgId, driveId, driveName } = useAuth()
  const queryClient = useQueryClient()
  const filter = useFileSearch()
  const { openContentSearch } = useSearchInput()

  if (filter.status === "idle" || !filter.query) return null

  const drive = driveName ?? "this drive"
  const matchesDrive = !filter.driveId || filter.driveId === driveId

  if (filter.status === "loading" || !matchesDrive) {
    return (
      <div
        className="flex items-center gap-2 border-b border-sidebar-border bg-sidebar-accent/30 px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 truncate">Searching file names in {drive}…</span>
      </div>
    )
  }

  if (filter.status === "error") {
    const retry = () => {
      void queryClient.refetchQueries({
        queryKey: ["glob", orgId, driveId, filter.query],
        exact: true,
      })
    }
    // Degrade to the folders the tree has already listed: no extra request,
    // and it still finds anything the user has browsed.
    const listings = queryClient
      .getQueriesData<LsResult>({ queryKey: ["ls", orgId, driveId] })
      .map(([key, data]) => [String(key[3] ?? ""), data] as const)
    const localMatches = filterLoadedListings(listings, filter.query)

    return (
      <div className="border-b border-sidebar-border">
        <div className="flex items-start gap-2 bg-destructive/5 px-3 py-2" role="alert">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive/80" />
          <div className="min-w-0 flex-1 space-y-0.5 text-xs">
            <p className="font-medium text-destructive">File search failed</p>
            <p className="text-muted-foreground break-words">
              {filter.error ?? "The file search request failed."}
            </p>
          </div>
          <Button type="button" variant="outline" size="xs" onClick={retry}>
            Retry
          </Button>
        </div>
        <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
          {localMatches.length === 0
            ? `No file in the folders opened so far is named like "${filter.query}".`
            : `Showing ${countLabel(localMatches.length)} from folders opened so far.`}
        </p>
        {localMatches.length > 0 && <SearchResultList paths={localMatches} />}
      </div>
    )
  }

  const matches = filter.matchedPaths

  if (matches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 border-b border-sidebar-border px-4 py-6 text-center">
        <SearchX className="size-6 text-muted-foreground/60" strokeWidth={1.5} />
        <div className="space-y-1">
          <p className="text-sm font-medium">No file names match</p>
          <p className="text-xs text-muted-foreground break-all">
            Nothing in {drive} is named like "{filter.query}".
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openContentSearch(filter.query)}
        >
          Search file contents instead
        </Button>
      </div>
    )
  }

  return (
    <div className="border-b border-sidebar-border">
      <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
        {countLabel(matches.length)} named like "{filter.query}".
        {matches.length > MAX_RESULTS && ` Showing the first ${MAX_RESULTS}; type more to narrow it.`}
      </p>
      <SearchResultList paths={matches} />
    </div>
  )
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`
}

function SearchResultList({ paths }: { paths: readonly string[] }) {
  const { selectedFile, selectFile } = useBrowser()
  const { focus: focusSearchInput } = useSearchInput()
  const listRef = useRef<HTMLUListElement>(null)
  const selectedPath = selectedFile?.replace(/^\/+|\/+$/g, "") ?? null

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      const buttons = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>("[data-search-result]") ?? [],
      )
      const index = buttons.findIndex((b) => b === document.activeElement)
      if (index === -1) return
      e.preventDefault()
      if (e.key === "ArrowUp") {
        if (index === 0) focusSearchInput()
        else buttons[index - 1]?.focus()
        return
      }
      const next = buttons[index + 1]
      if (next) {
        next.focus()
        return
      }
      // Past the last result, continue into the tree below.
      const aside = listRef.current?.closest("aside") ?? document
      aside.querySelector<HTMLButtonElement>("[data-tree-path]")?.focus()
    },
    [focusSearchInput],
  )

  return (
    <ul
      ref={listRef}
      aria-label="File search results"
      className="max-h-[40vh] overflow-y-auto pb-1"
      onKeyDown={handleKeyDown}
    >
      {paths.slice(0, MAX_RESULTS).map((path) => {
        const slash = path.lastIndexOf("/")
        const name = slash === -1 ? path : path.slice(slash + 1)
        const folder = slash === -1 ? "" : path.slice(0, slash)
        const glyph = glyphFor(path)
        const isSelected = selectedPath === path
        return (
          <li key={path}>
            <button
              type="button"
              data-search-result={path}
              title={path}
              onClick={() => selectFile(path)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-sm px-3 py-1 text-left text-sm hover:bg-sidebar-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                isSelected && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
              )}
            >
              {glyph ? (
                <glyph.Icon className={cn("h-4 w-4 shrink-0", glyph.className)} />
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <MiddleEllipsis text={name} />
                {folder && (
                  <MiddleEllipsis
                    text={folder}
                    className="text-[11px] font-normal text-muted-foreground"
                  />
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
