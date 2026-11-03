import { describe, expect, test } from "bun:test"
import { hasEnoughFiles, starNudgeKey } from "../star-nudge"
import type { LsEntry } from "../../api/types"

const file = (name: string): LsEntry => ({ name, type: "file", size: 1 })
const dir = (name: string): LsEntry => ({ name, type: "directory", size: 0 })

describe("star nudge", () => {
  test("counts existing files in nested folders and stops at five", async () => {
    const calls: string[] = []
    const entries: Record<string, LsEntry[]> = {
      "/": [file("a"), dir("nested")],
      "/nested/": [file("b"), file("c"), file("d"), file("e"), dir("ignored")],
    }
    expect(await hasEnoughFiles(async (path) => { calls.push(path); return { entries: entries[path] } })).toBe(true)
    expect(calls).toEqual(["/", "/nested/"])
  })
  test("does not count folders as files", async () => {
    expect(await hasEnoughFiles(async (path) => ({ entries: path === "/" ? [file("a"), dir("nested")] : [file("b")] }))).toBe(false)
  })
  test("dismissal keys separate users, drives and servers", () => {
    const key = starNudgeKey("server", "user", "org", "drive")
    expect(key).not.toBe(starNudgeKey("server", "other", "org", "drive"))
    expect(key).not.toBe(starNudgeKey("server", "user", "org", "other"))
    expect(key).not.toBe(starNudgeKey("other", "user", "org", "drive"))
  })
})
