import { useCallback, useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { FileTreeNode } from "./FileTreeNode"
import { FileSearchPanel } from "./FileSearchPanel"
import { treeExpansionStore, useFocusedPath } from "@/stores/tree-expansion"
import { useSearchInput } from "@/contexts/search-input"
import { describeRequestError } from "@/lib/request-errors"
import { isUnknownOperationError } from "@/api/errors"
import type { LsResult, RevealResult } from "@/api/types"

const REVEAL_TIMEOUT_MS = 15_000

// Set once a server answers "Unknown operation: reveal" (a deploy older than
// this UI), so later opens go straight to the per-ancestor path.
let revealUnsupported = false

function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

export function FileTree() {
  const { client, orgId, driveId } = useAuth()
  const { selectedFile } = useBrowser()
  const queryClient = useQueryClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const focusedPath = useFocusedPath()
  const { focus: focusSearchInput } = useSearchInput()

  const { data, isLoading, error } = useQuery({
    queryKey: ["ls", orgId, driveId, ""],
    queryFn: () => client.callOp<LsResult>(orgId!, "ls", {}, driveId),
    enabled: !!orgId && !!driveId,
  })
  const treeReady = !!data

  useEffect(() => {
    const path = selectedFile?.replace(/^\/+/, "")
    if (!path || path.endsWith("/") || !treeReady) return

    const ancestors = ancestorPaths(path)
    let cancelled = false

    // Fallback for servers without `reveal`. Each level's ls only starts once
    // its parent row mounts, so a file d levels deep costs d serial round trips.
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

    if (revealUnsupported) {
      revealPerAncestor()
    } else {
      // One round trip: seed every ancestor's ls cache entry before expanding,
      // so each level renders from cache the moment it mounts.
      client
        .callOp<RevealResult>(orgId!, "reveal", { path }, driveId)
        .then((result) => {
          if (cancelled) return
          for (const listing of result.listings) {
            queryClient.setQueryData<LsResult>(
              ["ls", orgId, driveId, listing.path.replace(/^\/+/, "")],
              { entries: listing.entries },
            )
          }
          treeExpansionStore.expandMany(ancestors)
        })
        .catch((error: unknown) => {
          if (isUnknownOperationError(error, "reveal")) revealUnsupported = true
          if (!cancelled) revealPerAncestor()
        })
    }

    const container = containerRef.current
    if (!container) {
      return () => {
        cancelled = true
      }
    }

    const revealSelectedRow = () => {
      const row = Array.from(
        container.querySelectorAll<HTMLButtonElement>("[data-tree-path]"),
      ).find((candidate) => candidate.dataset.treePath === path)

      if (!row) return false

      // Update the roving tab stop without moving DOM focus away from the
      // viewer, editor, or search input that the user is currently using.
      treeExpansionStore.setFocusedPath(path)
      row.scrollIntoView({ block: "center", inline: "nearest" })
      return true
    }

    if (revealSelectedRow()) {
      return () => {
        cancelled = true
      }
    }

    // Child directories load lazily. Watch this tree until the selected row
    // materializes, then disconnect immediately.
    const observer = new MutationObserver(() => {
      if (!revealSelectedRow()) return
      observer.disconnect()
      window.clearTimeout(timeoutId)
    })
    observer.observe(container, { childList: true, subtree: true })

    const timeoutId = window.setTimeout(() => observer.disconnect(), REVEAL_TIMEOUT_MS)

    return () => {
      cancelled = true
      observer.disconnect()
      window.clearTimeout(timeoutId)
    }
  }, [client, driveId, orgId, queryClient, selectedFile, treeReady])

  /** Collect all visible row paths in DOM order. */
  const collectVisible = useCallback((): {
    paths: string[]
    nodes: HTMLButtonElement[]
  } => {
    if (!containerRef.current) return { paths: [], nodes: [] }
    const buttons = Array.from(
      containerRef.current.querySelectorAll<HTMLButtonElement>("[data-tree-path]"),
    )
    return {
      paths: buttons.map((b) => b.dataset.treePath ?? ""),
      nodes: buttons,
    }
  }, [])

  const focusByPath = useCallback(
    (path: string) => {
      const { nodes } = collectVisible()
      const target = nodes.find((n) => n.dataset.treePath === path)
      if (target) {
        treeExpansionStore.setFocusedPath(path)
        target.focus()
      }
    },
    [collectVisible],
  )

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

      const { paths, nodes } = collectVisible()
      if (paths.length === 0) return

      const current = focusedPath ?? paths[0]!
      const idx = paths.indexOf(current)
      const safeIdx = idx === -1 ? 0 : idx
      const currentNode = nodes[safeIdx]
      const isDir = currentNode?.dataset.treeIsDir === "true"
      const expanded = currentNode?.dataset.treeExpanded === "true"
      const fullPath = paths[safeIdx]!

      switch (key) {
        case "ArrowDown": {
          e.preventDefault()
          const next = paths[Math.min(paths.length - 1, safeIdx + 1)]
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
          const prev = paths[safeIdx - 1]
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
            const nextPath = paths[safeIdx + 1]
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
          if (paths.includes(parent)) {
            focusByPath(parent)
          }
          return
        }
      }
    },
    [collectVisible, focusByPath, focusedPath, focusSearchInput],
  )

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

  const sorted = [...data.entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      <FileSearchPanel />
      <div
        ref={containerRef}
        className="py-1"
        role="tree"
        onKeyDown={handleKeyDown}
      >
        {sorted.map((entry, idx) => (
          <FileTreeNode
            key={entry.name}
            entry={entry}
            path=""
            depth={0}
            isDefaultFocus={idx === 0}
          />
        ))}
      </div>
    </>
  )
}
