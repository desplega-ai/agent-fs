import { describe, expect, test } from "bun:test"
import { hasEnoughFiles, starNudgeKey } from "../star-nudge"
describe("star nudge", () => {
  test("requires a known lower bound of at least five files", () => {
    expect(hasEnoughFiles({ fileCountLowerBound: 0 })).toBe(false)
    expect(hasEnoughFiles({ fileCountLowerBound: 4 })).toBe(false)
    expect(hasEnoughFiles({ fileCountLowerBound: 5 })).toBe(true)
    expect(hasEnoughFiles({ fileCountLowerBound: 6 })).toBe(true)
  })
  test("waits for drive metadata and skips older servers without a summary", () => {
    expect(hasEnoughFiles(undefined)).toBe(false)
    expect(hasEnoughFiles({})).toBe(false)
  })
  test("dismissal keys separate users, drives and servers", () => {
    const key = starNudgeKey("server", "user", "org", "drive")
    expect(key).not.toBe(starNudgeKey("server", "other", "org", "drive"))
    expect(key).not.toBe(starNudgeKey("server", "user", "org", "other"))
    expect(key).not.toBe(starNudgeKey("server", "user", "other", "drive"))
    expect(key).not.toBe(starNudgeKey("other", "user", "org", "drive"))
  })
})
