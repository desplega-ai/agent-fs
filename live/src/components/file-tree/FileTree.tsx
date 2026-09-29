import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { FolderOpen } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { FileTreeNode } from "./FileTreeNode"
import { FileTreeContextMenu, type TreeMenuTarget } from "./FileTreeContextMenu"
import { FileSearchPanel } from "./FileSearchPanel"
import { treeExpansionStore, useExpandedPaths, useFocusedPath } from "@/stores/tree-expansion"
import { useSearchInput } from "@/contexts/search-input"
import { describeRequestError } from "@/lib/request-errors"
import { fetchReveal } from "@/lib/reveal"
import { flattenTree, type TreeRow } from "@/lib/tree-rows"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, createTooltipHandle } from "@/components/ui/tooltip"
import type { LsResult } from "@/api/types"

const REVEAL_TIMEOUT_MS = 15_000
/** `py-1 text-sm` row; `py-1 text-xs` "Empty folder" line. Measured after mount. */
const ENTRY_ROW_HEIGHT = 28
const EMPTY_ROW_HEIGHT = 24

function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

// Module-level so useQueries keeps the combined result stable between renders.
const combineListings = (results: { data?: LsResult; isPending: boolean }[]) => ({
  data: results.map((result) => result.data),
  settled: results.every((result) => !result.isPending),
})

export function FileTree() {
  const { client, orgId, driveId } = useAuth()
  const { selectedFile } = useBrowser()
  const queryClient = useQueryClient()
  const expandedPaths = useExpandedPaths()
  // Path the selection effect wants scrolled into view once its row exists.
  const [revealPath, setRevealPath] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ["ls", orgId, driveId, ""],
    queryFn: () => client.callOp<LsResult>(orgId!, "ls", {}, driveId),
    enabled: !!orgId && !!driveId,
  })
  const treeReady = !!data

  // Which expanded folders are reachable depends on listings already loaded, so
  // pick the queries from the cache. useQueries subscribes to them; each listing
  // that resolves re-renders the tree and may surface deeper expanded folders,
  // exactly like the per-row queries this replaces.
  const expandedDirs = data
    ? flattenTree(data, expandedPaths, (path) =>
        queryClient.getQueryData<LsResult>(["ls", orgId, driveId, path]),
      ).expandedDirs
    : []
  const { data: listings, settled: listingsSettled } = useQueries({
    queries: expandedDirs.map((path) => ({
      queryKey: ["ls", orgId, driveId, path],
      queryFn: () => client.callOp<LsResult>(orgId!, "ls", { path }, driveId),
      enabled: !!orgId && !!driveId,
    })),
    combine: combineListings,
  })
  const expandedKey = expandedDirs.join("\n")
  const rows = useMemo(() => {
    if (!data) return []
    const dirs = expandedKey ? expandedKey.split("\n") : []
    const byPath = new Map(dirs.map((path, index) => [path, listings[index]]))
    return flattenTree(data, expandedPaths, (path) => byPath.get(path)).rows
  }, [data, expandedPaths, expandedKey, listings])

  useEffect(() => {
    const path = selectedFile?.replace(/^\/+/, "")
    if (!path || path.endsWith("/") || !treeReady) return

    const ancestors = ancestorPaths(path)
    let cancelled = false

    // Fallback for servers without `reveal`. Each level's ls only starts once
    // its parent listing loads, so a file d levels deep costs d serial round trips.
    const revealPerAncestor = () => {
      treeExpansionStore.expandMany(ancestors)

      // The file may have been created by another client after an ls result was
      // cached. Refresh only the listings needed to reveal this path; invalidating
      // every expanded tree node would turn one selection into an unbounded fanout.
      for (const listingPath of ["", ...ancestors]) {
        void queryClient.invalidateQueries({
          queryKey: ["ls", orgId, driveId, listingPath],
          exact: true,
        })
      }
    }

    // One round trip: seed every ancestor's ls cache entry before expanding,
    // so each level renders from cache the moment it is expanded.
    const abort = new AbortController()
    void fetchReveal(client, orgId!, driveId, path, abort.signal).then((result) => {
      if (cancelled) return
      if (!result) {
        revealPerAncestor()
        return
      }
      for (const listing of result.listings) {
        queryClient.setQueryData<LsResult>(
          ["ls", orgId, driveId, listing.path.replace(/^\/+/, "")],
          { entries: listing.entries },
        )
      }
      treeExpansionStore.expandMany(ancestors)
    })

    // Off-screen rows are not in the DOM, so the virtual list scrolls to the
    // row's index as soon as it appears in `rows`, then clears this.
    setRevealPath(path)
    const timeoutId = window.setTimeout(
      () => setRevealPath((current) => (current === path ? null : current)),
      REVEAL_TIMEOUT_MS,
    )

    return () => {
      cancelled = true
      abort.abort()
      window.clearTimeout(timeoutId)
    }
  }, [client, driveId, orgId, queryClient, selectedFile, treeReady])

  const handleRevealed = useCallback((path: string) => {
    setRevealPath((current) => (current === path ? null : current))
  }, [])

  if (isLoading) {
    return (
      <div className="space-y-1 p-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 rounded-sm bg-sidebar-accent/50 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <p className="p-3 text-sm text-destructive">
        Failed to load files. {describeRequestError(error)}
      </p>
    )
  }

  if (!data || data.entries.length === 0) {
    return (
      <>
        <FileSearchPanel />
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
          <FolderOpen className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
          <div className="space-y-1">
            <p className="text-sm font-medium">No files yet</p>
            <p className="text-xs text-muted-foreground">
              Files in this drive will appear here.
            </p>
          </div>
        </div>
      </>
    )
  }

  return (
    <VirtualTree
      rows={rows}
      listingsSettled={listingsSettled}
      revealPath={revealPath}
      onRevealed={handleRevealed}
    />
  )
}

/** Nearest ancestor that scrolls vertically (the sidebar's tab panel). */
function findScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === "auto" || overflowY === "scroll") return parent
    parent = parent.parentElement
  }
  return null
}

interface VirtualTreeProps {
  rows: TreeRow[]
  /** False while an expanded folder's listing is still loading. */
  listingsSettled: boolean
  revealPath: string | null
  onRevealed: (path: string) => void
}

/**
 * Renders only the rows near the viewport. Kept apart from FileTree so a
 * scroll re-renders this list, not the listing queries and flattening above.
 */
function VirtualTree({ rows, listingsSettled, revealPath, onRevealed }: VirtualTreeProps) {
  const { selectedFile } = useBrowser()
  const focusedPath = useFocusedPath()
  const { focus: focusSearchInput } = useSearchInput()
  const headerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [tooltip] = useState(() => createTooltipHandle())
  const [menuTarget, setMenuTarget] = useState<TreeMenuTarget | null>(null)
  // Row to move DOM focus to once it is rendered (keyboard navigation).
  const pendingFocusRef = useRef<string | null>(null)
  const selectedPath = selectedFile?.replace(/^\/+|\/+$/g, "") ?? null

  const { indexByPath, entryPaths, firstEntryIndex, lastEntryIndex } = useMemo(() => {
    const indexByPath = new Map<string, number>()
    const entryPaths: string[] = []
    rows.forEach((row, index) => {
      if (row.kind !== "entry") return
      indexByPath.set(row.path, index)
      entryPaths.push(row.path)
    })
    return {
      indexByPath,
      entryPaths,
      firstEntryIndex: indexByPath.get(entryPaths[0] ?? "") ?? -1,
      lastEntryIndex: indexByPath.get(entryPaths[entryPaths.length - 1] ?? "") ?? -1,
    }
  }, [rows])

  // Roving tabindex: the focused row, or the first row when focus has not
  // entered the tree yet (or its row was collapsed away).
  const tabStopPath =
    focusedPath !== null && indexByPath.has(focusedPath) ? focusedPath : (entryPaths[0] ?? null)
  const tabStopIndex = tabStopPath === null ? -1 : (indexByPath.get(tabStopPath) ?? -1)

  // Always keep the tab stop mounted so the tree stays tabbable and a focused
  // row keeps DOM focus when scrolled away, and keep the first and last rows
  // mounted for callers that focus `[data-tree-path]` from outside the tree.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range))
      for (const index of [tabStopIndex, firstEntryIndex, lastEntryIndex]) {
        if (index >= 0 && index < range.count) indexes.add(index)
      }
      return [...indexes].sort((a, b) => a - b)
    },
    [tabStopIndex, firstEntryIndex, lastEntryIndex],
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) =>
      rows[index]?.kind === "empty" ? EMPTY_ROW_HEIGHT : ENTRY_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.path ?? index,
    overscan: 12,
    scrollMargin,
    rangeExtractor,
  })

  // The search panel sits above the tree in the same scroll container; track
  // how far down the tree starts so the virtualizer maps offsets correctly.
  useLayoutEffect(() => {
    const tree = treeRef.current
    const header = headerRef.current
    if (!tree || !header) return
    const scroller = findScrollParent(tree)
    setScrollElement(scroller)
    if (!scroller) return

    const measure = () => {
      const offset =
        tree.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      setScrollMargin(Math.round(offset))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  // Reveal the selected file without moving DOM focus away from the viewer,
  // editor, or search input the user is working in. Rows are absolutely
  // positioned, so the browser's scroll anchoring cannot keep the row in view
  // while other expanded folders load above it: follow its index until every
  // listing has settled.
  useEffect(() => {
    if (!revealPath) return
    const index = indexByPath.get(revealPath)
    if (index === undefined || !scrollElement) return
    treeExpansionStore.setFocusedPath(revealPath)
    virtualizer.scrollToIndex(index, { align: "center" })
    if (listingsSettled) onRevealed(revealPath)
  }, [revealPath, indexByPath, listingsSettled, scrollElement, virtualizer, onRevealed])

  // Keyboard navigation: move DOM focus once the target row is rendered. The
  // range extractor keeps the focused row mounted, so this lands on the render
  // right after `setFocusedPath`.
  useLayoutEffect(() => {
    const path = pendingFocusRef.current
    if (!path || !treeRef.current) return
    const row = Array.from(
      treeRef.current.querySelectorAll<HTMLButtonElement>("[data-tree-path]"),
    ).find((candidate) => candidate.dataset.treePath === path)
    if (!row) return
    pendingFocusRef.current = null
    row.focus()
  })

  const focusByPath = useCallback((path: string) => {
    pendingFocusRef.current = path
    treeExpansionStore.setFocusedPath(path)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Only act on arrow keys; Enter is handled natively by the focused
      // button (which fires click → handleClick on the row).
      const key = e.key
      if (
        key !== "ArrowUp" &&
        key !== "ArrowDown" &&
        key !== "ArrowLeft" &&
        key !== "ArrowRight"
      ) {
        return
      }

      // Ignore if focus is in an input inside the tree (defensive).
      const tag =
        e.target instanceof HTMLElement ? e.target.tagName : ""
      if (tag === "INPUT" || tag === "TEXTAREA") return

      if (entryPaths.length === 0) return

      const current = focusedPath ?? entryPaths[0]!
      const idx = entryPaths.indexOf(current)
      const safeIdx = idx === -1 ? 0 : idx
      const fullPath = entryPaths[safeIdx]!
      const row = rows[indexByPath.get(fullPath) ?? -1]
      const isDir = row?.kind === "entry" && row.isDir
      const expanded = row?.kind === "entry" && row.expanded

      switch (key) {
        case "ArrowDown": {
          e.preventDefault()
          const next = entryPaths[Math.min(entryPaths.length - 1, safeIdx + 1)]
          if (next) focusByPath(next)
          return
        }
        case "ArrowUp": {
          e.preventDefault()
          if (safeIdx === 0) {
            // At the top of the tree — return focus to the search input so
            // ↑ can escape back out of the results.
            focusSearchInput()
            return
          }
          const prev = entryPaths[safeIdx - 1]
          if (prev) focusByPath(prev)
          return
        }
        case "ArrowRight": {
          e.preventDefault()
          if (isDir && !expanded) {
            treeExpansionStore.expand(fullPath)
            return
          }
          if (isDir && expanded) {
            // Move to first child if any visible.
            const nextPath = entryPaths[safeIdx + 1]
            if (nextPath && nextPath.startsWith(`${fullPath}/`)) {
              focusByPath(nextPath)
            }
          }
          return
        }
        case "ArrowLeft": {
          e.preventDefault()
          if (isDir && expanded) {
            treeExpansionStore.collapse(fullPath)
            return
          }
          // Move focus to parent: drop the last segment.
          const lastSlash = fullPath.lastIndexOf("/")
          if (lastSlash <= 0) return
          const parent = fullPath.slice(0, lastSlash)
          if (indexByPath.has(parent)) {
            focusByPath(parent)
          }
          return
        }
      }
    },
    [entryPaths, focusByPath, focusedPath, focusSearchInput, indexByPath, rows],
  )

  // One context menu for the whole tree: note which row it opened on. Right
  // clicks between rows (e.g. "Empty folder") open nothing, as before.
  const pickMenuTarget = (
    e: React.SyntheticEvent<HTMLDivElement> & { preventBaseUIHandler: () => void },
  ) => {
    const element =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>("[data-tree-path]")
        : null
    const row = rows[indexByPath.get(element?.dataset.treePath ?? "") ?? -1]
    if (row?.kind !== "entry") {
      e.preventBaseUIHandler()
      return
    }
    setMenuTarget({
      path: row.path,
      parentPath: row.parentPath,
      name: row.entry.name,
      isDir: row.isDir,
    })
  }

  return (
    <>
      <div ref={headerRef}>
        <FileSearchPanel />
      </div>
      <div className="py-1">
        <ContextMenu>
          <ContextMenuTrigger
            ref={treeRef}
            role="tree"
            onKeyDown={handleKeyDown}
            onContextMenu={pickMenuTarget}
            onTouchStart={pickMenuTarget}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
                >
                  {row.kind === "entry" ? (
                    <FileTreeNode
                      entry={row.entry}
                      parentPath={row.parentPath}
                      fullPath={row.path}
                      depth={row.depth}
                      isDir={row.isDir}
                      expanded={row.expanded}
                      isSelected={selectedPath === row.path}
                      tabIndex={row.path === tabStopPath ? 0 : -1}
                      tooltip={tooltip}
                    />
                  ) : (
                    <p
                      className="px-2 py-1 text-xs text-muted-foreground italic"
                      style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
                    >
                      Empty folder
                    </p>
                  )}
                </div>
              )
            })}
          </ContextMenuTrigger>
          <FileTreeContextMenu target={menuTarget} />
        </ContextMenu>
        <Tooltip handle={tooltip}>
          {({ payload }) => (
            <TooltipContent side="right" align="center">
              {String(payload ?? "")}
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </>
  )
}
