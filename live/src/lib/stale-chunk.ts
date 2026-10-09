// A tab opened before a deploy still runs the old entry bundle, which points at
// lazy chunks (TextViewer, SqlPage, mermaid, duckdb) that the new deploy no
// longer serves. One reload fetches the new index.html and its chunk names.

const RELOAD_KEY = "agent-fs:stale-chunk-reload-at"

// A chunk failure this soon after our own reload is not a stale tab: the chunk
// is really missing or the network is down. Show the error instead of looping.
export const RELOAD_GUARD_MS = 10_000

const CHUNK_ERROR_MESSAGES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
  "Unable to preload CSS", // Vite preload helper
]

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return CHUNK_ERROR_MESSAGES.some((m) => message.includes(m))
}

interface ReloadDeps {
  storage: () => Pick<Storage, "getItem" | "setItem">
  now: () => number
  reload: () => void
}

/**
 * Returns a function that reloads the page once to recover from a stale
 * chunk. It returns true when a reload is under way, false when the loop
 * guard refused it.
 */
export function createStaleChunkReloader({ storage, now, reload }: ReloadDeps): () => boolean {
  let pending = false
  return () => {
    if (pending) return true
    const at = now()
    try {
      const store = storage()
      const last = Number(store.getItem(RELOAD_KEY))
      if (last && at - last >= 0 && at - last < RELOAD_GUARD_MS) return false
      store.setItem(RELOAD_KEY, String(at))
    } catch {
      // Without storage there is no loop guard, so never reload.
      return false
    }
    pending = true
    reload()
    return true
  }
}

export const reloadForStaleChunk = createStaleChunkReloader({
  // Reading window.sessionStorage itself throws when storage is blocked.
  storage: () => window.sessionStorage,
  now: () => Date.now(),
  reload: () => window.location.reload(),
})

export function installStaleChunkReload() {
  // Vite dispatches this for every failed dynamic import and CSS preload in a
  // production build. The error still propagates, so a refused reload leaves
  // today's behaviour unchanged.
  window.addEventListener("vite:preloadError", () => {
    reloadForStaleChunk()
  })
}
