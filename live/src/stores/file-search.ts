/**
 * Files-tab search store. When the user types into the sidebar's "Files" tab,
 * the SearchBar populates this store with the drive-wide glob results. The
 * FileTree renders them as a flat result list above the tree, which stays
 * rendered and unfiltered, so a search costs one request and a failed search
 * never hides the drive.
 *
 * Four states:
 *   - idle: query is empty or too short → no search panel
 *   - loading: a drive-wide glob request is running
 *   - success: glob returned → FileTree lists matchedPaths, or a "no matches"
 *     state when it is empty
 *   - error: glob failed → FileTree shows the error inline, with Retry and a
 *     local filter over the folders the tree has already loaded
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

export const fileSearchStore = {
  subscribe,
  getSnapshot,
}
