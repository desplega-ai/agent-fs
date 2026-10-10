import type { Favorite } from "@/api/types"
import type { HealthResponse } from "./upload-limit"
import { cleanPath } from "./paths"

export const FAVORITES_FEATURE = "favorites"

/** Servers that store per-user favorites say so in `/health`. Older servers hide the stars. */
export function supportsFavorites(health?: HealthResponse): boolean {
  return health?.features?.includes(FAVORITES_FEATURE) === true
}

/** One cache entry per drive. The server scopes the list to the signed-in user. */
export function favoritesQueryKey(endpoint: string, orgId: string | null, driveId: string | null) {
  return ["favorites", endpoint, orgId, driveId] as const
}

/** UI form of a path (no leading or trailing slash), so tree, folder and file paths compare equal. */
export function favoriteKey(path: string): string {
  return cleanPath(path)
}

/** The list with `path` starred or unstarred, for an optimistic update. */
export function withFavorite(
  favorites: readonly Favorite[],
  path: string,
  kind: Favorite["kind"],
  on: boolean,
): Favorite[] {
  const key = favoriteKey(path)
  const rest = favorites.filter((f) => favoriteKey(f.path) !== key)
  if (!on) return rest
  return [...rest, { path: `/${key}`, kind, createdAt: new Date().toISOString() }].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
}

/**
 * Event handlers for a star that sits on or next to something clickable (a
 * tree row, a folder tile, a list item). The star must never open what it
 * stars, by mouse or by keyboard, so it stops the event from reaching any
 * ancestor and from triggering a default action.
 */
export function starToggleHandlers(toggle: () => void) {
  return {
    onClick: (e: { preventDefault(): void; stopPropagation(): void }) => {
      e.preventDefault()
      e.stopPropagation()
      toggle()
    },
    onKeyDown: (e: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      // Enter and Space would otherwise also reach a row's own key handling.
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        e.stopPropagation()
        toggle()
      }
    },
    // A press that starts on the star must not start a drag, focus the row, or
    // count as a click on the row underneath.
    onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onMouseDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
  }
}
