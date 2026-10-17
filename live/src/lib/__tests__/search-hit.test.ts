import { describe, expect, test } from "bun:test"
import { searchHitDisplay } from "../search-hit"

describe("search hit display", () => {
  test("an image file gets the Image chip and a thumbnail", () => {
    expect(searchHitDisplay({ kind: "image" })).toEqual({ chip: "Image", thumbnail: true })
  })

  test("a PDF page image gets the page chip and no thumbnail", () => {
    expect(searchHitDisplay({ kind: "image", page: 3 })).toEqual({ chip: "PDF p.3", thumbnail: false })
  })

  test("a PDF text hit gets the page chip", () => {
    expect(searchHitDisplay({ kind: "text", page: 1 })).toEqual({ chip: "PDF p.1", thumbnail: false })
  })

  test("a text hit and a hit from an older server get no chip", () => {
    expect(searchHitDisplay({ kind: "text" })).toEqual({ chip: null, thumbnail: false })
    expect(searchHitDisplay({})).toEqual({ chip: null, thumbnail: false })
  })
})
