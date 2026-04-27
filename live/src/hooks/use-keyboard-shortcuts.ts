import { useEffect, useRef } from "react"

/**
 * Canonical key string format:
 *   - lowercased
 *   - "cmd+" / "ctrl+" / "shift+" / "alt+" prefixes (in that order)
 *   - "cmd+k" matches both Meta+K (mac) and Ctrl+K (linux/windows)
 *   - "?" listens for shift+/ producing "?" (handled via e.key)
 *   - "esc" / "escape" both supported, normalized to "esc"
 *   - arrow keys: "arrowup" / "arrowdown" / "arrowleft" / "arrowright"
 */
export type ShortcutHandler = (e: KeyboardEvent) => void
export type ShortcutMap = Record<string, ShortcutHandler>

export interface ShortcutDescriptor {
  /** Canonical key string, e.g. "cmd+k", "?", "[", "enter", "esc". */
  key: string
  /** Human-readable label shown in the help overlay. */
  label: string
  /** Group label for the help overlay. */
  group: string
  /** Display key (defaults to a prettified version of `key`). */
  display?: string
}

/**
 * Static registry of shortcuts that the help overlay reads. The actual
 * handlers are wired per-component via `useKeyboardShortcuts(...)`.
 */
export const shortcutsRegistry: ShortcutDescriptor[] = [
  { key: "cmd+k", label: "Focus search", group: "Search", display: "⌘K" },
  { key: "/", label: "Focus search", group: "Search", display: "/" },
  { key: "esc", label: "Close / deselect", group: "Selection", display: "Esc" },
  { key: "enter", label: "Open focused row", group: "Navigation", display: "↵" },
  { key: "arrowup", label: "Move focus up", group: "Navigation", display: "↑" },
  { key: "arrowdown", label: "Move focus down", group: "Navigation", display: "↓" },
  { key: "arrowleft", label: "Collapse / parent", group: "Navigation", display: "←" },
  { key: "arrowright", label: "Expand / first child", group: "Navigation", display: "→" },
  { key: "[", label: "Toggle file tree sidebar", group: "Sidebars", display: "[" },
  { key: "]", label: "Toggle comments sidebar", group: "Sidebars", display: "]" },
  { key: "?", label: "Show keyboard shortcuts", group: "Help", display: "?" },
]

/** Return true if the event target is a text-input-like element. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target.isContentEditable) return true
  return false
}

/** Build a canonical key string from a KeyboardEvent. */
function canonicalKey(e: KeyboardEvent): string {
  const parts: string[] = []
  // cmd OR ctrl — collapse to a single "cmd" prefix so authors can write
  // a single binding that works on both mac and pc.
  if (e.metaKey || e.ctrlKey) parts.push("cmd")
  if (e.shiftKey) parts.push("shift")
  if (e.altKey) parts.push("alt")

  let key = e.key
  // Normalize a few special keys.
  if (key === "Escape") key = "esc"
  else if (key === " ") key = "space"
  else key = key.toLowerCase()

  parts.push(key)
  return parts.join("+")
}

/**
 * Build a list of canonical key strings to try, in order. We try the modifier
 * combo as observed AND a stripped version that drops "shift" when the event's
 * key character is a punctuation character that already implies shift (e.g.
 * `?` on US layouts is Shift+/). This way authors can register `'?'` directly
 * without worrying about modifiers.
 */
function candidateKeys(e: KeyboardEvent): string[] {
  const exact = canonicalKey(e)
  const candidates = [exact]

  // For shifted punctuation, also try without the shift prefix.
  if (e.shiftKey && e.key.length === 1 && /[^a-zA-Z0-9]/.test(e.key)) {
    const stripped = exact.replace(/(^|\+)shift\+/, "$1")
    if (stripped !== exact) candidates.push(stripped)
  }

  return candidates
}

/**
 * Registry-based keyboard shortcut hook. Attaches a single document-level
 * keydown listener that dispatches to handlers by canonical key string.
 *
 * Skips when the target is an input / textarea / contenteditable so the
 * shortcuts don't fire while typing.
 *
 * Usage:
 *   useKeyboardShortcuts({
 *     'cmd+k': () => focusSearch(),
 *     'esc':   () => clear(),
 *     '?':     () => setHelpOpen(true),
 *   })
 *
 * Pass `{ allowInEditable: ['esc'] }` (TODO if needed) to opt specific keys
 * into firing inside editable targets — not supported yet, but the API is
 * forward-compatible.
 */
export function useKeyboardShortcuts(map: ShortcutMap | (() => ShortcutMap)) {
  // Stable ref — re-resolve the map on each event so callers can pass inline
  // closures without re-attaching the document listener every render.
  const mapRef = useRef<ShortcutMap | (() => ShortcutMap)>(map)
  mapRef.current = map

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const resolved = typeof mapRef.current === "function" ? mapRef.current() : mapRef.current
      if (!resolved) return

      // Allow esc to fire even inside editable targets (so users can blur the
      // search input or close a help overlay while typing). Other shortcuts
      // are skipped while typing.
      const editable = isEditableTarget(e.target)
      const isEscape = e.key === "Escape"

      if (editable && !isEscape) {
        // Still allow cmd+k inside the search input (so users can re-focus or
        // toggle) — and only that combination, to stay conservative.
        const isCmdK =
          (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k"
        if (!isCmdK) return
      }

      for (const key of candidateKeys(e)) {
        const handlerForKey = resolved[key]
        if (handlerForKey) {
          handlerForKey(e)
          return
        }
      }
    }

    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])
}
