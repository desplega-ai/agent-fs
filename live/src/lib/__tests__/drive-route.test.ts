import { describe, expect, test } from "bun:test"
import { drivePathFor, encodeDrivePath, isAddressableName, namesFor, pairsNamed, type DriveLists } from "../drive-route"

const orgs = [
  { id: "o1", name: "acme" },
  { id: "o2", name: "acme" },
  { id: "o3", name: "solo" },
]
const drives: Record<string, { id: string; name: string }[]> = {
  o1: [{ id: "d1", name: "docs" }, { id: "d2", name: "work" }],
  o2: [{ id: "d3", name: "work" }],
  o3: [{ id: "d4", name: "team notes" }, { id: "d5", name: "dup" }, { id: "d6", name: "dup" }, { id: "d7", name: "a%2Fb" }],
}
const lists: DriveLists = (id) => drives[id]

describe("drivePathFor", () => {
  const ids = { orgId: "o1", driveId: "d1" }
  test("names replace the ID segments; the path is encoded per segment", () => {
    expect(drivePathFor("file", ids, { org: "acme", drive: "team notes" }, "a/b#1?.md")).toBe("/file/acme/team%20notes/a/b%231%3F.md")
    expect(drivePathFor("file", ids, null, "/dir/")).toBe("/file/~/o1/d1/dir/")
    expect(drivePathFor("file", ids, null)).toBe("/file/~/o1/d1/")
  })

  test("views without a path end at the drive", () => {
    expect(drivePathFor("sql", ids, { org: "acme", drive: "docs" }, "ignored.csv")).toBe("/sql/acme/docs")
    expect(drivePathFor("members", ids, null)).toBe("/members/~/o1/d1")
  })

  test("encodeDrivePath keeps the folder slash", () => {
    expect(encodeDrivePath("/a b/")).toBe("a%20b/")
  })
})

test("names the router cannot round-trip stay out of addresses", () => {
  for (const bad of ["", ".", "..", "~", "a/b", "a%2Fb", "100%"]) expect(isAddressableName(bad)).toBe(false)
  for (const ok of ["reveri-context", "team notes", "~home", "a.b"]) expect(isAddressableName(ok)).toBe(true)
})

describe("pairsNamed", () => {
  test("finds every pair across orgs that share a name", () => {
    expect(pairsNamed(orgs, lists, "acme", "work")).toEqual([{ orgId: "o1", driveId: "d2" }, { orgId: "o2", driveId: "d3" }])
    expect(pairsNamed(orgs, lists, "acme", "docs")).toEqual([{ orgId: "o1", driveId: "d1" }])
    expect(pairsNamed(orgs, lists, "nope", "docs")).toEqual([])
  })

  test("is unknown while a needed list is", () => {
    expect(pairsNamed(orgs, (id) => (id === "o2" ? undefined : drives[id]), "acme", "docs")).toBeNull()
  })
})

describe("namesFor", () => {
  test("a pair no other reachable drive shares gets names", () => {
    expect(namesFor(orgs, lists, { orgId: "o1", driveId: "d1" })).toEqual({ org: "acme", drive: "docs" })
    expect(namesFor(orgs, lists, { orgId: "o3", driveId: "d4" })).toEqual({ org: "solo", drive: "team notes" })
  })

  test("clashes, unknown lists and unaddressable names keep IDs", () => {
    expect(namesFor(orgs, lists, { orgId: "o1", driveId: "d2" })).toBeNull() // "work" in both acme orgs
    expect(namesFor(orgs, lists, { orgId: "o3", driveId: "d5" })).toBeNull() // two "dup" in one org
    expect(namesFor(orgs, lists, { orgId: "o3", driveId: "d7" })).toBeNull()
    expect(namesFor(orgs, (id) => (id === "o2" ? undefined : drives[id]), { orgId: "o1", driveId: "d1" })).toBeNull()
    expect(namesFor(orgs, lists, { orgId: "o9", driveId: "d1" })).toBeNull()
  })
})
