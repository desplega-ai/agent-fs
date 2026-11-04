import { useSyncExternalStore } from "react"

/** Shared so the user configuration dialog and every open viewer agree. */
const KEY = "liveui:auto-update-document"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "true"
  } catch {
    return false
  }
}

let value = read()

export function setAutoUpdateDocuments(next: boolean) {
  value = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // ignore quota / privacy errors
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAutoUpdateDocuments(): boolean {
  return useSyncExternalStore(subscribe, () => value)
}
