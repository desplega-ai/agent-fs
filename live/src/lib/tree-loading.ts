import type { LsResult } from "@/api/types"
import type { TreeRow } from "./tree-rows"

const MAX_LISTINGS = 4

/** Include expanded ancestors when their children occupy the viewport. */
export function demandedDirectories(rows: readonly TreeRow[], first: number, last: number, focused: string | null): string[] {
  const paths = new Set<string>()
  const add = (path: string) => {
    for (let end = path.indexOf("/"); end >= 0; end = path.indexOf("/", end + 1)) {
      paths.add(path.slice(0, end))
    }
    paths.add(path)
  }
  if (focused) add(focused)
  for (const row of rows.slice(first, last + 1)) add(row.path)
  return [...paths]
}

/** Bound sidebar listing requests, including refetches after invalidation. */
export function createTreeListingLoader(
  fetch: (path: string, signal: AbortSignal) => Promise<LsResult>,
  priority: (path: string) => number,
) {
  let active = 0
  const waiting: { path: string; start: () => void }[] = []
  const drain = () => {
    waiting.sort((a, b) => priority(a.path) - priority(b.path))
    while (active < MAX_LISTINGS && waiting.length) waiting.shift()!.start()
  }
  return (path: string, signal: AbortSignal): Promise<LsResult> => new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(job)
      if (index >= 0) waiting.splice(index, 1)
      reject(signal.reason)
    }
    const job = { path, start: () => {
      signal.removeEventListener("abort", abort)
      active++
      void fetch(path, signal).then(resolve, reject).finally(() => {
        active--
        drain()
      })
    } }
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    waiting.push(job)
    drain()
  })
}
