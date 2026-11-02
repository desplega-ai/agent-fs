/** Most toasts on screen at once, so a burst of actions can't fill it. */
export const MAX_TOASTS = 4

/**
 * Append `item` and cap the stack at `max`. The oldest non-sticky toast goes
 * first, so a sticky one (the star nudge) stays until the user dismisses it.
 */
export function pushToast<T extends { sticky?: boolean }>(items: readonly T[], item: T, max = MAX_TOASTS): T[] {
  let next = [...items, item]
  while (next.length > max) {
    const evict = Math.max(0, next.findIndex((i) => !i.sticky))
    next = next.filter((_, i) => i !== evict)
  }
  return next
}
