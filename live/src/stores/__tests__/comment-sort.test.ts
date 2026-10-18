import { afterAll, expect, test } from "bun:test"

// The store reads localStorage once, when it loads. Install a fake one that
// holds a sort the menu does not offer, then load the store.
const KEY = "liveui:comments:sort"
const storage = new Map<string, string>([[KEY, JSON.stringify("status")]])
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  },
})
const { getCommentSort, setCommentSort } = await import("../comment-sort")

afterAll(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

test("an unknown stored sort falls back to Newest", () => {
  expect(getCommentSort()).toBe("newest")
})

test("a chosen sort is stored", () => {
  setCommentSort("line")
  expect(getCommentSort()).toBe("line")
  expect(storage.get(KEY)).toBe(JSON.stringify("line"))
})
