import { useEffect, useState, useSyncExternalStore } from "react"
import { COMMENT_SHEET_QUERY, layoutViewport, visualViewport, type Viewport } from "./comment-popover-layout"

// The placement itself is React-free, so it can be tested without React.
export * from "./comment-popover-layout"

function subscribeSheet(onChange: () => void) {
  const media = window.matchMedia(COMMENT_SHEET_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

/** Whether this screen gets the bottom-sheet comment form. */
export function useCommentSheet(): boolean {
  return useSyncExternalStore(subscribeSheet, () => window.matchMedia(COMMENT_SHEET_QUERY).matches)
}

/**
 * The viewport to place the comment UI in, kept current while `track`: the
 * visual viewport on sheet screens (the keyboard opening resizes and scrolls
 * it), the window on desktop.
 */
export function usePopoverViewport(sheet: boolean, track: boolean): Viewport {
  const read = () => (sheet ? visualViewport() : layoutViewport())
  const [vp, setVp] = useState<Viewport>(read)
  useEffect(() => {
    const update = () => setVp(read())
    update()
    const target = sheet ? window.visualViewport : window
    if (!track || !target) return
    target.addEventListener("resize", update)
    target.addEventListener("scroll", update)
    return () => {
      target.removeEventListener("resize", update)
      target.removeEventListener("scroll", update)
    }
  }, [sheet, track])
  return vp
}

/**
 * iOS scrolls the window to show a focused field, although the app scrolls
 * in its own container, and leaves it scrolled: the top bar ends up under the
 * browser toolbar. Put the window back when `active` (the sheet) ends.
 */
export function useRestoreWindowScroll(active: boolean) {
  useEffect(() => {
    if (!active) return
    const y = window.scrollY
    return () => {
      if (window.scrollY !== y) window.scrollTo(0, y)
    }
  }, [active])
}

/**
 * Call `onSelect` (debounced) when a touch selection changes: long-press and
 * handle drags fire no mouseup. Mouse selections keep using mouseup. Skipped
 * while `paused()` (the form is open, and tapping it may clear the selection).
 */
export function useTouchSelection(onSelect: () => void, paused: () => boolean) {
  useEffect(() => {
    let touch = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onPointerDown = (e: PointerEvent) => { touch = e.pointerType !== "mouse" }
    const onChange = () => {
      if (!touch) return
      clearTimeout(timer)
      timer = setTimeout(() => { if (!paused()) onSelect() }, 250)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("selectionchange", onChange)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("selectionchange", onChange)
    }
  }, [onSelect, paused])
}
