import { describe, expect, test } from "bun:test"
import { clampFormTop, clampLeft, commentButtonPosition, commentFormStyle, COMMENT_BTN_HEIGHT, VIEWPORT_MARGIN, type Viewport } from "../comment-popover"

const desktop: Viewport = { width: 1280, height: 800, offsetTop: 0, offsetLeft: 0 }
// iOS with the keyboard up: the window scrolled 363 px, 336 px visible.
const keyboard: Viewport = { width: 390, height: 336, offsetTop: 363, offsetLeft: 0 }
const rect = (top: number, left = 100, width = 200, height = 20) => ({ top, left, width, bottom: top + height })

describe("comment popover placement", () => {
  test("clampLeft keeps a box inside the viewport, offset included", () => {
    expect(clampLeft(-50, 100, desktop)).toBe(VIEWPORT_MARGIN)
    expect(clampLeft(1250, 100, desktop)).toBe(1280 - 100 - VIEWPORT_MARGIN)
    expect(clampLeft(500, 100, { ...desktop, offsetLeft: 600 })).toBe(600 + VIEWPORT_MARGIN)
  })

  test("the form goes below the anchor, flips above near the bottom, else clamps", () => {
    expect(clampFormTop(rect(100), 220, desktop)).toBe(130)
    expect(clampFormTop(rect(700), 220, desktop)).toBe(700 - 220 - 10)
    expect(clampFormTop(rect(100, 0, 0, 650), 220, desktop)).toBe(800 - 220 - VIEWPORT_MARGIN)
    // In the visual viewport, not the layout one.
    expect(clampFormTop(rect(400), 220, keyboard)).toBe(430)
    expect(clampFormTop(rect(500), 220, keyboard)).toBe(363 + 336 - VIEWPORT_MARGIN - 220)
  })

  test("the button sits under the selection; further under a touch one, for the handles", () => {
    expect(commentButtonPosition(rect(100), desktop, false)).toEqual({ top: 126, left: 100 + 100 - 54 })
    expect(commentButtonPosition(rect(100), desktop, true).top).toBe(148)
    // Never below the visible area (above the keyboard).
    expect(commentButtonPosition(rect(680), keyboard, true).top).toBe(363 + 336 - COMMENT_BTN_HEIGHT - VIEWPORT_MARGIN)
  })

  test("as a sheet the form spans the visual viewport and ends at its bottom, wherever the selection is", () => {
    for (const anchor of [rect(-300), rect(400), rect(2000)]) {
      expect(commentFormStyle(anchor, 220, keyboard, true)).toEqual({
        top: 363 + 336, left: 0, width: 390, maxHeight: 336 * 0.8, transform: "translateY(-100%)",
      })
    }
  })

  test("a touch selection near the top gets the button above it, where the native menu is not", () => {
    // 50 px from the top: the menu goes below, the button fits above.
    expect(commentButtonPosition(rect(50), desktop, true).top).toBe(50 - 8 - COMMENT_BTN_HEIGHT)
    // Too close to the top for either: it stays below.
    expect(commentButtonPosition(rect(20), desktop, true).top).toBe(20 + 20 + 28)
    // A mouse selection, or one lower down, is unchanged.
    expect(commentButtonPosition(rect(50), desktop, false).top).toBe(50 + 20 + 6)
    expect(commentButtonPosition(rect(100), desktop, true).top).toBe(148)
    // Measured from the top of the visible area.
    expect(commentButtonPosition(rect(363 + 50), keyboard, true).top).toBe(363 + 50 - 8 - COMMENT_BTN_HEIGHT)
  })

  test("on a wide touch screen the sheet is capped and centred", () => {
    const ipad: Viewport = { width: 1024, height: 700, offsetTop: 0, offsetLeft: 0 }
    expect(commentFormStyle(rect(100), 220, ipad, true)).toMatchObject({ width: 448, left: (1024 - 448) / 2, top: 700 })
  })

  test("on desktop the form follows the anchor as before", () => {
    expect(commentFormStyle(rect(100), 220, desktop, false)).toEqual({ top: 130, left: 60 })
  })
})
