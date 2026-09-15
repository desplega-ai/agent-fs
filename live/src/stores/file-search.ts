import { useSyncExternalStore } from "react"

/**
 * In-tree filter store. When the user types into the sidebar's "Files" tab,
 * the SearchBar populates this store with the glob-search results. The
 * FileTree reads it and:
 *   - hides any node whose path is neither matched nor an ancestor of a match
 *   - force-expands any folder that has a matching descendant, so the user
 *     sees the path leading to each match without manual expansion
 *
 * Four states:
 *   - idle: query is empty → no filter, render the full tree
 *   - loading: a drive-wide glob request is running
 *   - success: glob returned → filter applies; FileTree shows a "no matches"
 *     empty state when matchedPaths is empty
 *   - error: glob failed → show the error without stale results
 */

type Status = "idle" | "loading" | "success" | "error"

export interface FileSearchState {
  status: Status
  query: string
  driveId: string
  matchedPaths: readonly string[]
  error: string | null
}

const IDLE_STATE: FileSearchState = {
  status: "idle",
  query: "",
  driveId: "",
  matchedPaths: [],
  error: null,
}

let snapshot: FileSearchState = IDLE_STATE
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

export function setSearchLoading(query: string, driveId: string) {
  if (
    snapshot.status === "loading" &&
    snapshot.query === query &&
    snapshot.driveId === driveId
  ) {
    return
  }
  snapshot = { status: "loading", query, driveId, matchedPaths: [], error: null }
  emit()
}

export function setSearchResults(query: string, driveId: string, paths: readonly string[]) {
  const normalized = [...new Set(paths.map(normalize))]
  if (
    snapshot.status === "success" &&
    snapshot.query === query &&
    snapshot.driveId === driveId &&
    pathsEqual(normalized, snapshot.matchedPaths)
  ) {
    return
  }
  snapshot = { status: "success", query, driveId, matchedPaths: normalized, error: null }
  emit()
}

export function setSearchError(query: string, driveId: string, error: string) {
  if (
    snapshot.status === "error" &&
    snapshot.query === query &&
    snapshot.driveId === driveId &&
    snapshot.error === error
  ) {
    return
  }
  snapshot = { status: "error", query, driveId, matchedPaths: [], error }
  emit()
}

export function clearSearchFilter() {
  if (snapshot.status === "idle") return
  snapshot = IDLE_STATE
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

/** Filter is active only after a successful request. */
export function isFilterActive(): boolean {
  return snapshot.status === "success" && snapshot.query.length > 0
}

export function isPathMatched(nodePath: string): boolean {
  if (!isFilterActive()) return false
  return snapshot.matchedPaths.includes(normalize(nodePath))
}

export function isPathVisible(nodePath: string): boolean {
  if (snapshot.status === "idle") return true
  if (!isFilterActive()) return false
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

export const fileSearchStore = {
  getSnapshot,
}
