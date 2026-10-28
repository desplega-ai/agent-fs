import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react"

/**
 * Where the floating Comment button and the comment form go, for any viewer
 * that comments on a selection. On desktop both follow the selection. On a
 * touch or narrow screen the form is a bottom sheet pinned to the visual
 * viewport, so the on-screen keyboard and the browser scrolling to the focused
 * field cannot push it off screen, and the button sits further below the
 * selection, clear of the selection handles and the native selection menu.
 */

export const VIEWPORT_MARGIN = 8
export const COMMENT_FORM_WIDTH = 320
export const COMMENT_BTN_WIDTH = 108
export const COMMENT_BTN_HEIGHT = 32
/** Below a touch selection: room for the selection handles. */
const TOUCH_BTN_GAP = 28

/** The visible area, in the coordinates of fixed-position elements. */
export interface Viewport {
  width: number
  height: number
  offsetTop: number
  offsetLeft: number
}

export interface AnchorRect {
  left: number
  top: number
  width: number
  bottom: number
}

/** Touch or narrow screens get the bottom sheet. */
export const COMMENT_SHEET_QUERY = "(pointer: coarse), (max-width: 640px)"

function layoutViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 }
}

/** The visual viewport (what is on screen above the keyboard), else the window. */
export function visualViewport(): Viewport {
  const v = window.visualViewport
  return v ? { width: v.width, height: v.height, offsetTop: v.offsetTop, offsetLeft: v.offsetLeft } : layoutViewport()
}

/** Clamp an x-coordinate so a box of the given width stays in the viewport. */
export function clampLeft(left: number, width: number, vp: Viewport): number {
  const min = vp.offsetLeft + VIEWPORT_MARGIN
  const max = vp.offsetLeft + vp.width - width - VIEWPORT_MARGIN
  return Math.max(min, Math.min(left, Math.max(min, max)))
}

/** Pick a y-coordinate for the form: below the anchor, else flipped above. */
export function clampFormTop(rect: AnchorRect, formHeight: number, vp: Viewport): number {
  const lo = vp.offsetTop + VIEWPORT_MARGIN
  const hi = vp.offsetTop + vp.height - VIEWPORT_MARGIN
  const below = rect.bottom + 10
  if (below + formHeight <= hi) return below
  const above = rect.top - formHeight - 10
  if (above >= lo) return above
  return Math.max(lo, hi - formHeight)
}

/** The Comment button: under the selection, centred, inside the viewport. */
export function commentButtonPosition(rect: AnchorRect, vp: Viewport, touch: boolean): { top: number; left: number } {
  return {
    top: Math.min(rect.bottom + (touch ? TOUCH_BTN_GAP : 6), vp.offsetTop + vp.height - COMMENT_BTN_HEIGHT - VIEWPORT_MARGIN),
    left: clampLeft(rect.left + rect.width / 2 - COMMENT_BTN_WIDTH / 2, COMMENT_BTN_WIDTH, vp),
  }
}

/**
 * The form's style: next to the anchor on desktop; as a sheet, full width with
 * its bottom on the bottom of the visual viewport (above the keyboard).
 */
export function commentFormStyle(rect: AnchorRect, formHeight: number, vp: Viewport, sheet: boolean): CSSProperties {
  if (sheet) {
    return {
      top: vp.offsetTop + vp.height,
      left: vp.offsetLeft,
      width: vp.width,
      maxHeight: vp.height * 0.8,
      transform: "translateY(-100%)",
    }
  }
  return { top: clampFormTop(rect, formHeight, vp), left: clampLeft(rect.left - 40, COMMENT_FORM_WIDTH, vp) }
}

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
 * The viewport to place the comment UI in: the visual viewport, kept current
 * while `track` (the keyboard opening resizes and scrolls it), on sheet
 * screens; the window on desktop.
 */
export function usePopoverViewport(sheet: boolean, track: boolean): Viewport {
  const [vp, setVp] = useState<Viewport>(() => (sheet ? visualViewport() : layoutViewport()))
  useEffect(() => {
    setVp(sheet ? visualViewport() : layoutViewport())
    const v = window.visualViewport
    if (!sheet || !track || !v) return
    const update = () => setVp(visualViewport())
    v.addEventListener("resize", update)
    v.addEventListener("scroll", update)
    return () => {
      v.removeEventListener("resize", update)
      v.removeEventListener("scroll", update)
    }
  }, [sheet, track])
  return vp
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
