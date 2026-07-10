import { useSyncExternalStore } from "react"

const STORAGE_KEY = "liveui:recent-files:v1"
const MAX_RECENT_FILES = 25
const EMPTY_FILES: readonly string[] = []

type Listener = () => void
type RecentFilesSnapshot = Record<string, readonly string[]>

function normalizeFilePath(path: string): string | null {
  const normalized = path.replace(/^\/+/, "")
  if (!normalized || normalized.endsWith("/")) return null
  return normalized
}

function sanitizePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return EMPTY_FILES

  const seen = new Set<string>()
  const paths: string[] = []

  for (const candidate of value) {
    if (typeof candidate !== "string") continue
    const path = normalizeFilePath(candidate)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
    if (paths.length === MAX_RECENT_FILES) break
  }

  return paths
}

function readSnapshot(): RecentFilesSnapshot {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed).map(([scope, paths]) => [scope, sanitizePaths(paths)]),
    )
  } catch {
    return {}
  }
}

let snapshot = readSnapshot()
const listeners = new Set<Listener>()

function emit() {
  listeners.forEach((listener) => listener())
}

function persist() {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Ignore quota and privacy-mode errors. Recents are an enhancement only.
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function recentFilesScope(
  credentialId: string,
  orgId: string,
  driveId: string,
): string {
  return JSON.stringify([credentialId, orgId, driveId])
}

export function recordRecentFile(scope: string, rawPath: string) {
  const path = normalizeFilePath(rawPath)
  if (!scope || !path) return

  const current = snapshot[scope] ?? EMPTY_FILES
  if (current[0] === path) return

  snapshot = {
    ...snapshot,
    [scope]: [path, ...current.filter((candidate) => candidate !== path)].slice(
      0,
      MAX_RECENT_FILES,
    ),
  }
  persist()
  emit()
}

export function useRecentFiles(scope: string | null): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => (scope ? (snapshot[scope] ?? EMPTY_FILES) : EMPTY_FILES),
    () => EMPTY_FILES,
  )
}
