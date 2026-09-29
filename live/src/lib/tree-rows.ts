import type { LsEntry, LsResult } from "@/api/types"

/** One rendered line of the sidebar tree, in display order. */
export type TreeRow =
  | {
      kind: "entry"
      /** Drive-relative path without a leading slash; also the row's key. */
      path: string
      parentPath: string
      entry: LsEntry
      depth: number
      isDir: boolean
      expanded: boolean
    }
  | { kind: "empty"; path: string; depth: number }

export interface FlatTree {
  rows: TreeRow[]
  /** Expanded directories whose listing the tree needs, loaded or not. */
  expandedDirs: string[]
}

// Sorting is the only per-listing work; cache it per result object so a scroll
// or focus change does not re-sort every expanded folder.
const sortedCache = new WeakMap<LsResult, LsEntry[]>()

function sortedEntries(listing: LsResult): LsEntry[] {
  let sorted = sortedCache.get(listing)
  if (!sorted) {
    sorted = [...listing.entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    sortedCache.set(listing, sorted)
  }
  return sorted
}

/**
 * Flatten the root listing plus every loaded, expanded folder into the rows
 * the tree renders. An expanded folder whose listing is not loaded yet shows
 * no children (as before) but is still reported in `expandedDirs`, so the
 * caller can fetch it.
 */
export function flattenTree(
  root: LsResult,
  expanded: ReadonlySet<string>,
  getListing: (path: string) => LsResult | undefined,
): FlatTree {
  const rows: TreeRow[] = []
  const expandedDirs: string[] = []

  const visit = (parentPath: string, listing: LsResult, depth: number) => {
    for (const entry of sortedEntries(listing)) {
      const path = parentPath ? `${parentPath}/${entry.name}` : entry.name
      const isDir = entry.type === "directory"
      const isExpanded = isDir && expanded.has(path)
      rows.push({ kind: "entry", path, parentPath, entry, depth, isDir, expanded: isExpanded })
      if (!isExpanded) continue

      expandedDirs.push(path)
      const children = getListing(path)
      if (!children) continue
      if (children.entries.length === 0) {
        rows.push({ kind: "empty", path: `${path}/`, depth: depth + 1 })
      } else {
        visit(path, children, depth + 1)
      }
    }
  }

  visit("", root, 0)
  return { rows, expandedDirs }
}
