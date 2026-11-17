import { describe, expect, test } from "bun:test"
import { drivesNamed, fileLink } from "../drive-links"
import { routeTemplate } from "../route-template"

const context = { id: "d1", name: "reveri-context", orgId: "o1" }
const work = { id: "d2", name: "work", orgId: "o1" }
const otherWork = { id: "d3", name: "work", orgId: "o2" }
const all = [context, work, otherWork]

describe("drivesNamed", () => {
  test("matches the exact name across orgs", () => {
    expect(drivesNamed(all, "work")).toEqual([work, otherWork])
    expect(drivesNamed(all, "reveri-context")).toEqual([context])
    expect(drivesNamed(all, "Work")).toEqual([])
  })
})

describe("fileLink", () => {
  test("a drive with a unique name gets the short form", () => {
    expect(fileLink("https://x", "o1", "d1", "/product/a b.md", all)).toBe("https://x/d/reveri-context/product/a b.md")
  })

  test("a shared name or an unknown drive list keeps the ID form", () => {
    expect(fileLink("https://x", "o1", "d2", "a.md", all)).toBe("https://x/file/~/o1/d2/a.md")
    expect(fileLink("https://x", "o1", "d1", "a.md", [])).toBe("https://x/file/~/o1/d1/a.md")
  })

  test("encodes the drive name, and keeps the ID form for a name with a slash", () => {
    const spaced = { id: "d4", name: "team notes", orgId: "o1" }
    const slashed = { id: "d5", name: "notes/2026", orgId: "o1" }
    expect(fileLink("https://x", "o1", "d4", "a.md", [spaced, slashed])).toBe("https://x/d/team%20notes/a.md")
    expect(fileLink("https://x", "o1", "d5", "a.md", [spaced, slashed])).toBe("https://x/file/~/o1/d5/a.md")
  })
})

test("the name route is reported by its template, never the drive name", () => {
  expect(routeTemplate("/d/reveri-context/product/a.md")).toBe("/d/:driveName/*")
})
