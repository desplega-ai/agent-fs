import { useSyncExternalStore } from "react"

/**
 * In-tree filter store. When the user types into the sidebar's "Files" tab,
 * the SearchBar populates this store with the glob-search results. The
 * FileTree reads it and:
 *   - hides any node whose path is neither matched nor an ancestor of a match
 *   - force-expands any folder that has a matching descendant, so the user
 *     sees the path leading to each match without manual expansion
 *
 * Three states:
 *   - idle: query is empty → no filter, render the full tree
 *   - loading: query set but glob hasn't returned yet → don't filter, render
 *     the full tree (avoids a blank tree while typing)
 *   - loaded: glob returned → filter applies; FileTree shows a "no matches"
 *     empty state when matchedPaths is empty
 */

type Status = "idle" | "loading" | "loaded"

interface FileSearchState {
  status: Status
  query: string
  matchedPaths: readonly string[]
}

let snapshot: FileSearchState = { status: "idle", query: "", matchedPaths: [] }
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

function normalize(p: string): string {
  return p.replace(/^\/+|\/+$/g, "")
}

export function setSearchLoading(query: string) {
  if (snapshot.status === "loading" && snapshot.query === query) return
  snapshot = { status: "loading", query, matchedPaths: [] }
  emit()
}

export function setSearchResults(query: string, paths: readonly string[]) {
  const normalized = paths.map(normalize)
  if (
    snapshot.status === "loaded" &&
    snapshot.query === query &&
    pathsEqual(normalized, snapshot.matchedPaths)
  ) {
    return
  }
  snapshot = { status: "loaded", query, matchedPaths: normalized }
  emit()
}

export function clearSearchFilter() {
  if (snapshot.status === "idle") return
  snapshot = { status: "idle", query: "", matchedPaths: [] }
  emit()
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

/** Filter is "active" only when results have arrived. While loading we show
 * the full tree so the user isn't staring at a blank pane. */
export function isFilterActive(): boolean {
  return snapshot.status === "loaded" && snapshot.query.length > 0
}

export function isPathVisible(nodePath: string): boolean {
  if (!isFilterActive()) return true
  const target = normalize(nodePath)
  for (const m of snapshot.matchedPaths) {
    if (m === target) return true
    if (m.startsWith(target + "/")) return true
  }
  return false
}

export function hasMatchingDescendant(nodePath: string): boolean {
  if (!isFilterActive()) return false
  const target = normalize(nodePath)
  for (const m of snapshot.matchedPaths) {
    if (m === target) continue
    if (m.startsWith(target + "/")) return true
  }
  return false
}
