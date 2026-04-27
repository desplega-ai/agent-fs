import { useCallback, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { FileTreeNode } from "./FileTreeNode"
import { treeExpansionStore, useFocusedPath } from "@/stores/tree-expansion"
import type { LsResult } from "@/api/types"

export function FileTree() {
  const { client, orgId, driveId } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const focusedPath = useFocusedPath()

  const { data, isLoading, error } = useQuery({
    queryKey: ["ls", orgId, driveId, ""],
    queryFn: () => client.callOp<LsResult>(orgId!, "ls", {}, driveId),
    enabled: !!orgId && !!driveId,
  })

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
          const prev = paths[Math.max(0, safeIdx - 1)]
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
    [collectVisible, focusByPath, focusedPath],
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
        Failed to load files: {(error as Error).message}
      </p>
    )
  }

  if (!data || data.entries.length === 0) {
    return (
      <p className="p-3 text-sm text-muted-foreground">No files yet</p>
    )
  }

  const sorted = [...data.entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
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
  )
}
