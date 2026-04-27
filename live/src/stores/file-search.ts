import { useSyncExternalStore } from "react"

/**
 * In-tree filter store. When the user types into the sidebar's "Files" tab,
 * the SearchBar populates this store with the glob-search results. The
 * FileTree reads it and:
 *   - hides any node whose path is neither matched nor an ancestor of a match
 *   - force-expands any folder that has a matching descendant, so the user
 *     sees the path leading to each match without manual expansion
 *
 * `setSearchFilter("", [])` clears the filter (back to normal tree view).
 */

interface FileSearchState {
  query: string
  matchedPaths: readonly string[]
}

let snapshot: FileSearchState = { query: "", matchedPaths: [] }
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function setSearchFilter(query: string, paths: readonly string[]) {
  if (query === snapshot.query && pathsEqual(paths, snapshot.matchedPaths)) return
  snapshot = { query, matchedPaths: paths }
  emit()
}

export function clearSearchFilter() {
  setSearchFilter("", [])
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function getSnapshot(): FileSearchState {
  return snapshot
}

export function useFileSearch(): FileSearchState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function isFilterActive(): boolean {
  return snapshot.query.length > 0
}

export function isPathVisible(nodePath: string): boolean {
  if (!isFilterActive()) return true
  for (const m of snapshot.matchedPaths) {
    if (m === nodePath) return true
    if (m.startsWith(nodePath + "/")) return true
  }
  return false
}

export function hasMatchingDescendant(nodePath: string): boolean {
  if (!isFilterActive()) return false
  for (const m of snapshot.matchedPaths) {
    if (m === nodePath) continue
    if (m.startsWith(nodePath + "/")) return true
  }
  return false
}
