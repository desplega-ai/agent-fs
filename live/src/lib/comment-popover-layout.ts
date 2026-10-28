import type { CSSProperties } from "react"

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
/** Widest sheet, so a tablet's form is not a full-width strip. */
const SHEET_MAX_WIDTH = 448

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

/** The window, as a viewport. */
export function layoutViewport(): Viewport {
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
    const width = Math.min(vp.width, SHEET_MAX_WIDTH)
    return {
      top: vp.offsetTop + vp.height,
      left: vp.offsetLeft + (vp.width - width) / 2,
      width,
      maxHeight: vp.height * 0.8,
      transform: "translateY(-100%)",
    }
  }
  return { top: clampFormTop(rect, formHeight, vp), left: clampLeft(rect.left - 40, COMMENT_FORM_WIDTH, vp) }
}
