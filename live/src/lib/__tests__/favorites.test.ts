import { describe, expect, mock, test } from "bun:test"
import { favoriteKey, starToggleHandlers, supportsFavorites, withFavorite } from "../favorites"
import type { Favorite } from "@/api/types"

function fakeEvent(key?: string) {
  return { key: key ?? "", preventDefault: mock(() => {}), stopPropagation: mock(() => {}) }
}

describe("starToggleHandlers", () => {
  test("a click toggles once and never reaches the row underneath", () => {
    const toggle = mock(() => {})
    const e = fakeEvent()
    starToggleHandlers(toggle).onClick(e)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(e.stopPropagation).toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  test.each(["Enter", " "])("%p toggles and is stopped, so the keyboard cannot open the row", (key) => {
    const toggle = mock(() => {})
    const e = fakeEvent(key)
    starToggleHandlers(toggle).onKeyDown(e)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(e.stopPropagation).toHaveBeenCalled()
    // preventDefault stops the browser's own click for Enter/Space, so the
    // toggle above is the only one.
    expect(e.preventDefault).toHaveBeenCalled()
  })

  test("other keys pass through untouched (Tab, arrows)", () => {
    const toggle = mock(() => {})
    for (const key of ["Tab", "ArrowDown", "a"]) {
      const e = fakeEvent(key)
      starToggleHandlers(toggle).onKeyDown(e)
      expect(e.stopPropagation).not.toHaveBeenCalled()
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(toggle).not.toHaveBeenCalled()
  })

  test("a press on the star does not reach the row", () => {
    const handlers = starToggleHandlers(() => {})
    const down = fakeEvent()
    handlers.onPointerDown(down)
    handlers.onMouseDown(down)
    expect(down.stopPropagation).toHaveBeenCalledTimes(2)
  })
})

describe("favorites helpers", () => {
  test("supportsFavorites reads the /health features list", () => {
    expect(supportsFavorites({ ok: true, features: ["favorites"] } as any)).toBe(true)
    expect(supportsFavorites({ ok: true, features: ["share-links"] } as any)).toBe(false)
    expect(supportsFavorites({ ok: true } as any)).toBe(false)
    expect(supportsFavorites(undefined)).toBe(false)
  })

  test("favoriteKey makes server and UI paths compare equal", () => {
    expect(favoriteKey("/docs/a.md")).toBe("docs/a.md")
    expect(favoriteKey("docs/a.md")).toBe("docs/a.md")
    expect(favoriteKey("/docs/")).toBe("docs")
  })

  test("withFavorite adds in path order and removes by either path form", () => {
    const start: Favorite[] = [{ path: "/b.md", kind: "file", createdAt: "2026-10-10T00:00:00.000Z" }]
    const added = withFavorite(start, "a", "directory", true)
    expect(added.map((f) => `${f.kind}:${f.path}`)).toEqual(["directory:/a", "file:/b.md"])
    expect(withFavorite(added, "b.md", "file", false).map((f) => f.path)).toEqual(["/a"])
    // Re-adding does not duplicate.
    expect(withFavorite(added, "/a", "directory", true)).toHaveLength(2)
  })
})
