import { useSyncExternalStore } from "react"
import { DEFAULT_COMMENT_SORT, isCommentSort, type CommentSort } from "@/lib/comment-sort"

/**
 * The comment sidebar's sort, kept in localStorage. One value for every mounted
 * sidebar (the desktop rail and the mobile sheet).
 */
const STORAGE_KEY = "liveui:comments:sort"

type Listener = () => void

function readSort(): CommentSort {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_COMMENT_SORT
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    // Unknown values fall back to the default.
    return isCommentSort(parsed) ? parsed : DEFAULT_COMMENT_SORT
  } catch {
    return DEFAULT_COMMENT_SORT
  }
}

let sort = readSort()
const listeners = new Set<Listener>()

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCommentSort(): CommentSort {
  return sort
}

export function setCommentSort(next: CommentSort) {
  if (next === sort) return
  sort = next
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore quota / privacy errors
  }
  listeners.forEach((listener) => listener())
}

export function useCommentSort(): CommentSort {
  return useSyncExternalStore(subscribe, getCommentSort, getCommentSort)
}
