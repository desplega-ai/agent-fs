import { describe, expect, test } from "bun:test"
import { headingFromHash } from "../outline"

describe("headingFromHash", () => {
  const ids = ["setup", "setup-1", "what-it-costs"]

  test("names a heading the document has", () => {
    expect(headingFromHash("#setup-1", ids)).toBe("setup-1")
    expect(headingFromHash("what-it-costs", ids)).toBe("what-it-costs")
  })

  test("decodes an encoded fragment", () => {
    expect(headingFromHash("#what%2Dit%2Dcosts", ids)).toBe("what-it-costs")
  })

  test("ignores anything that is not a heading", () => {
    expect(headingFromHash("", ids)).toBeNull()
    expect(headingFromHash("#missing", ids)).toBeNull()
    expect(headingFromHash("#key=afs_secret", ids)).toBeNull()
    expect(headingFromHash("#%E0%A4%A", ids)).toBeNull()
  })
})
