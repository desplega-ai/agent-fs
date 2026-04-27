import { useSyncExternalStore } from "react"

const STORAGE_KEY = "liveui:tree:expanded"
const MAX_PATHS = 1000

type Listener = () => void

class TreeExpansionStore {
  private paths: Set<string>
  private order: string[] // LRU order — most recent at end
  private listeners = new Set<Listener>()

  constructor() {
    this.paths = new Set()
    this.order = []
    this.hydrate()
  }

  private hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const trimmed = parsed.filter((p): p is string => typeof p === "string").slice(-MAX_PATHS)
      this.paths = new Set(trimmed)
      this.order = trimmed
    } catch {
      // ignore corrupt storage
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.order))
    } catch {
      // ignore quota / privacy errors
    }
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }

  isExpanded(path: string): boolean {
    return this.paths.has(path)
  }

  toggle(path: string) {
    if (this.paths.has(path)) {
      this.paths.delete(path)
      this.order = this.order.filter((p) => p !== path)
    } else {
      this.paths.add(path)
      this.order.push(path)
      // LRU bound
      while (this.order.length > MAX_PATHS) {
        const evict = this.order.shift()!
        this.paths.delete(evict)
      }
    }
    this.persist()
    this.emit()
  }

  clear() {
    if (this.paths.size === 0) return
    this.paths.clear()
    this.order = []
    this.persist()
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const store = new TreeExpansionStore()

export function useExpanded(path: string): boolean {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.isExpanded(path),
    () => false
  )
}

export function useToggleExpanded(): (path: string) => void {
  return (path: string) => store.toggle(path)
}

/** Imperative access for non-React callers (e.g. auth context). */
export const treeExpansionStore = {
  clear: () => store.clear(),
  isExpanded: (path: string) => store.isExpanded(path),
  toggle: (path: string) => store.toggle(path),
}
